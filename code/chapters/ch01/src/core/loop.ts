import { resolve } from "node:path";

import { systemMessage, toolMessage, userMessage, validateToolPairing } from "./messages.js";
import type { ChatMessage } from "./messages.js";
import type { ModelClient, ModelRequest } from "./model.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// State machine of the Agent Loop: model reply, tool backfill, and repeated inference until final text.
//
// AgentRunner is the core of the Agent:
//   1. Receive user prompt
//   2. Call the model in a loop until the model stops requesting tools
//   3. Append assistant message and tool results to history in each turn
//   4. Return final text, complete history, and actual turns
// This chapter does not implement Planner, Memory, or Orchestrator; they are capabilities layered on top of this loop.
// Base domain error during an Agent run; callers can handle it separately from configuration or SDK errors.
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

// Throw when the turn budget is exhausted before receiving the final answer, to avoid infinite model/tool loops.
export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

// Thrown when model output cannot be safely treated as a final answer due to length truncation.
export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

export interface ToolAuthorizer {
  // Evaluate the validated call before the handler; returned reasons enter rejected tool results.
  // Chapter 1 CLI injects TerminalAuthorizer, requiring users to approve shell commands one by one.
  authorize(prepared: PreparedToolCall, context: ToolContext): Promise<ToolAuthorizationDecision>;
}

// An explicit decision of the authorization boundary. The rejection reason must be backfilled to the model to adjust subsequent actions.
export interface ToolAuthorizationDecision {
  // Whether to allow actually invoking the handler rather than only allowing the model to request calls.
  readonly allowed: boolean;
  // Explanatory text for human or policy denial; empty reasons count as invalid authorization responses.
  readonly reason: string;
}

// Auditable result of a single Agent run; history isolated from internal state validates message pairing.
export interface RunResult {
  // Final text, auditable history, and actual turns used constitute the complete result of a run.
  // history is a frozen copy; callers cannot modify AgentRunner internal state.
  readonly finalText: string;
  readonly history: readonly ChatMessage[];
  readonly turns: number;
}

// Construct dependencies and boundaries required by AgentRunner; composition root must inject external SDK and process implementations.
export interface AgentRunnerOptions {
  // The core loop depends only on abstract models and tools; bootstrap injects concrete SDKs and processes.
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly systemPrompt: string;
  readonly workspace: string;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly authorizer?: ToolAuthorizer;
}

// Single-session Agent state machine; advances to final text through "model reply -> tool backfill -> re-request".
export class AgentRunner {
  // Normalized model boundary; loops do not depend on specific vendor SDKs.
  readonly #model: ModelClient;
  // Mutable source registry; each turn generates an immutable tool snapshot from it.
  readonly #tools: ToolRegistry;
  // Stable system constraints prepended before each model request without writing to mutable history.
  readonly #systemPrompt: string;
  // Normalized workspace root directory; all tool calls share this boundary.
  readonly #workspace: string;
  // Maximum number of model requests allowed for a single run, not the number of tool calls.
  readonly #maxTurns: number;
  // Caller subject identity injected into tool context.
  readonly #identity: string;
  // Optional human or policy authorization boundary; library callers assume trust decisions when missing.
  readonly #authorizer: ToolAuthorizer | undefined;
  // Accumulated user, model, and tool events for the current instance; system prompt is always prepended per request.
  readonly #history: ChatMessage[] = [];

  // Validates long-term configuration and fixes dependencies; construction failures should precede any model requests or side effects.
  constructor(options: AgentRunnerOptions) {
    // Validate long-term invariants at instance creation to prevent invalid configuration from appearing mid-run.
    // Default 20-turn limit prevents infinite model loops; identity defaults to "user".
    const maxTurns = options.maxTurns === undefined ? 20 : options.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error("maxTurns must be a positive integer");
    }
    const identity = options.identity === undefined ? "user" : options.identity;
    if (identity.trim().length === 0) {
      throw new Error("identity must not be empty");
    }
    if (options.systemPrompt.trim().length === 0) {
      throw new Error("systemPrompt must not be empty");
    }

    this.#model = options.model;
    this.#tools = options.tools;
    this.#systemPrompt = options.systemPrompt;
    this.#workspace = resolve(options.workspace);
    this.#maxTurns = maxTurns;
    this.#identity = identity;
    this.#authorizer = options.authorizer;
  }

  // Returns a frozen history copy for audit reading without allowing external rewriting of instance state.
  get history(): readonly ChatMessage[] {
    // Returns a frozen copy; callers cannot modify internal message history.
    // Tests can use this to verify message pairing; production code usually reads only finalText.
    return Object.freeze([...this.#history]);
  }

  // Execute a user request until the model gives final text, triggers an unrecoverable error, or exhausts the turn budget.
  async run(prompt: string): Promise<RunResult> {
    // History saves only user, model, and tool events; system prompts prepend separately before each request.
    // system prompt does not enter history because it is identical each turn without needing duplicate persistence.
    this.#history.push(userMessage(prompt));
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    // One turn corresponds to one model request; tool results must backfill before entering the next request.
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      validateToolPairing(this.#history);
      // Freezes tool view for this turn, ensuring definitions seen by the model match the set used by actual prepare/invoke.
      // Create a snapshot each turn; overhead is minimal and prevents inconsistencies from concurrent modifications.
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: Object.freeze([systemMessage(this.#systemPrompt), ...this.#history]),
        tools: tools.openAITools(),
      });
      const reply = await this.#model.complete(request);

      // Chapter 1 does not do continuation or compaction; incomplete replies must not be mistaken for final answers.
      // length indicates output truncated by token limits; content_filter indicates filtered content.
      // Neither is a normal termination; subsequent chapters add recovery strategies.
      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

      // The assistant message must enter history first so each subsequent tool result pairs with its call ID.
      // Pushes assistant first and backfills tool messages later, ensuring validator sees complete pairs.
      const assistant = reply.message;
      this.#history.push(assistant);
      if (assistant.toolCalls.length === 0) {
        if (assistant.content === null) {
          throw new AgentRunError("Model stopped without final text or tool calls");
        }
        validateToolPairing(this.#history);
        return Object.freeze({
          finalText: assistant.content,
          history: Object.freeze([...this.#history]),
          turns: turn,
        });
      }

      // Each call in an assistant message must backfill once, including errors and denials.
      // Tool results are not only one-to-one, but their order can differ (either A then B or B then A).
      for (const call of assistant.toolCalls) {
        // prepare uniformly handles unknown tools, JSON, and schema errors, safely backfilling errors to the model.
        // prepare itself executes no side effects; only invoke calls the actual handler.
        const prepared = tools.prepare(call);
        let result: ToolResult;
        if (prepared.error !== undefined) {
          result = prepared.error;
        } else if (this.#authorizer !== undefined) {
          // When a manual authorization boundary exists, request permission first; rejection also generates a tool result for the model to change plans.
          try {
            const decision = await this.#authorizer.authorize(prepared, context);
            if (decision.reason.trim().length === 0) {
              throw new Error("authorization decision reason must not be empty");
            }
            result = decision.allowed
              ? await tools.invoke(prepared, context)
              : toolError("permission_denied", decision.reason);
          } catch {
            // Reject rather than allow when the authorization boundary fails to avoid expanding permissions on approval infrastructure exceptions.
            // fail-closed: any authorization anomaly denies by default instead of risking execution.
            result = toolError("permission_denied", "Tool approval failed closed");
          }
        } else {
          // Execute directly when no authorizer is configured; tests and library callers usually take this path.
          result = await tools.invoke(prepared, context);
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
    }

    // Throws a typed error when reaching the maximum turns without final text. Callers can decide how to recover.
    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }
}
