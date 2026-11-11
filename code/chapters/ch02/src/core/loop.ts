/**
 * Agent core loop module. AgentRunner executes the full run from a single user prompt to the final answer.
 * Each turn execution: snapshot tool set → construct ModelRequest → call model → parse assistant reply →
 * prepare/authorize/invoke tool calls one by one → backfill tool messages → next turn or finish.
 * Key constraints:
 * - Every tool_call in each assistant message must backfill one tool message;
 * - The authorizer rejects by default on error to prevent boundary failure;
 * - history returns a copy. Callers cannot modify the model request history.
 */
import { resolve } from "node:path";

import { systemMessage, toolMessage, userMessage, validateToolPairing } from "./messages.js";
import type { ChatMessage } from "./messages.js";
import type { ModelClient, ModelRequest } from "./model.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// The core loop maintains message pairing: write back a result for every tool call after model calls.
export class AgentRunError extends Error {
  // Stable base error name, used by callers to identify Agent run failures.
  override readonly name: string = "AgentRunError";
}

// Thrown when model requests exceed maxTurns, stopping infinite loops.
export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

// Thrown when the model cannot serve as a final answer due to length truncation.
export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

// The authorizer runs before tool execution. Received calls have already passed name and parameter schema validation.
export interface ToolAuthorizer {
  authorize(prepared: PreparedToolCall, context: ToolContext): Promise<ToolAuthorizationDecision>;
}

export interface ToolAuthorizationDecision {
  // Whether to allow actual execution of calls that already passed schema validation.
  readonly allowed: boolean;
  // Authorization reason backfilled to the model; empty reasons are treated as invalid decisions.
  readonly reason: string;
}

export interface RunResult {
  // Final answer text provided when the model stops.
  readonly finalText: string;
  // Complete message history snapshot isolated from internal state.
  readonly history: readonly ChatMessage[];
  // Number of model requests actually initiated during this run.
  readonly turns: number;
}

// AgentRunner options isolate pure core from external capabilities like model, tools, and workspace.
export interface AgentRunnerOptions {
  // Normalized model request unique provider-agnostic boundary.
  readonly model: ModelClient;
  // Runtime tool source; each turn takes an immutable snapshot.
  readonly tools: ToolRegistry;
  // System constraints prepended each turn without writing to persistent history.
  readonly systemPrompt: string;
  // Workspace root directory used by tool contexts.
  readonly workspace: string;
  // Optional model request limit.
  readonly maxTurns?: number;
  // Caller subject identity injected into tool context.
  readonly identity?: string;
  // Optional authorization boundary; executes according to library caller trust decisions when omitted.
  readonly authorizer?: ToolAuthorizer;
}

// Single-session state machine; strictly maintains pairing between model tool calls and result messages.
export class AgentRunner {
  // Normalized model client.
  readonly #model: ModelClient;
  // Source Tool Registry, used to construct a snapshot in each turn.
  readonly #tools: ToolRegistry;
  // Stable system prompt.
  readonly #systemPrompt: string;
  // Normalized workspace root.
  readonly #workspace: string;
  // Maximum number of model requests.
  readonly #maxTurns: number;
  // Current invocation subject.
  readonly #identity: string;
  // Optional authorizer.
  readonly #authorizer: ToolAuthorizer | undefined;
  // User, model, and tool events accumulated by this instance.
  readonly #history: ChatMessage[] = [];

  // Validates long-term configuration and fixes dependencies; any failure occurs before model requests and side effects.
  constructor(options: AgentRunnerOptions) {
    // Turns and identity belong to the runtime contract. Failing during construction prevents incomplete history midway.
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

  // Returns a frozen copy so external code cannot modify the history used by subsequent requests.
  get history(): readonly ChatMessage[] {
    // Returns a copy; callers cannot tamper with the conversation history of subsequent model requests.
    return Object.freeze([...this.#history]);
  }

  // Execute user requests until receiving final text, unrecoverable errors, or exhausting turn budgets.
  async run(prompt: string): Promise<RunResult> {
    // Rebuild system prompt each turn; persistent history records only real conversations and tool events.
    this.#history.push(userMessage(prompt));
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      // Check that previous turn tool calls are fully paired before initiating model requests.
      validateToolPairing(this.#history);
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: Object.freeze([systemMessage(this.#systemPrompt), ...this.#history]),
        tools: tools.openAITools(),
      });
      const reply = await this.#model.complete(request);

      // Do not mistake incomplete or filtered responses for final answers.
      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

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
      for (const call of assistant.toolCalls) {
        const prepared = tools.prepare(call);
        let result: ToolResult;
        if (prepared.error !== undefined) {
          result = prepared.error;
        } else if (this.#authorizer !== undefined) {
          // Deny on authorization failure by default to prevent executing side-effect tools when the authorization boundary fails.
          try {
            const decision = await this.#authorizer.authorize(prepared, context);
            if (decision.reason.trim().length === 0) {
              throw new Error("authorization decision reason must not be empty");
            }
            result = decision.allowed
              ? await tools.invoke(prepared, context)
              : toolError("permission_denied", decision.reason);
          } catch {
            result = toolError("permission_denied", "Tool approval failed closed");
          }
        } else {
          result = await tools.invoke(prepared, context);
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }
}
