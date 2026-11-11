import { resolve } from "node:path";

import { systemMessage, toolMessage, userMessage, validateToolPairing } from "./messages.js";
import type { ChatMessage } from "./messages.js";
import type { ModelClient, ModelRequest } from "./model.js";
import type { PermissionPolicy } from "./permissions.js";
import { PermissionRequest } from "./permissions.js";
import type { ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// Agent Loop hands prepared calls to the permission policy; only allow enters the tool executor.
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

// Thrown when reaching the maximum turn limit. Callers must not treat intermediate history as final delivery.
export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

// Model output was truncated by token limits; complete reply cannot be obtained.
export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

export interface RunResult {
  // Final deliverable text provided when the model stops.
  readonly finalText: string;
  // Complete message history isolated from internal state.
  readonly history: readonly ChatMessage[];
  // Number of times the model was actually requested during this run.
  readonly turns: number;
}

export interface AgentRunnerOptions {
  // Vendor-agnostic model boundary.
  readonly model: ModelClient;
  // Tool Registry that generates snapshots for each request.
  readonly tools: ToolRegistry;
  // System prompt temporarily prepended each turn without writing to history.
  readonly systemPrompt: string;
  // Workspace root accessible to tool calls.
  readonly workspace: string;
  // Optional model request limit.
  readonly maxTurns?: number;
  // Subject identity injected into tool context.
  readonly identity?: string;
  // Pre-execution permission policy for P03; retains direct call behavior of earlier chapters when omitted.
  readonly permissionPolicy?: PermissionPolicy;
}

// Single-session state machine; invoke tool handlers only when PermissionPolicy produces allow.
export class AgentRunner {
  // Normalized model client.
  readonly #model: ModelClient;
  // Source registry used to generate the immutable view for this turn.
  readonly #tools: ToolRegistry;
  // Stable system prompt.
  readonly #systemPrompt: string;
  // Normalized workspace root.
  readonly #workspace: string;
  // Maximum number of model requests.
  readonly #maxTurns: number;
  // Current invocation subject.
  readonly #identity: string;
  // Optional permission policy responsible for approvals, audits, and write boundaries.
  readonly #permissionPolicy: PermissionPolicy | undefined;
  // Accumulated user, model, and tool messages, excluding system messages rebuilt in each turn.
  readonly #history: ChatMessage[] = [];

  // Validates long-term configuration and fixes dependencies; failures happen before model requests and side effects.
  constructor(options: AgentRunnerOptions) {
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
    this.#permissionPolicy = options.permissionPolicy;
  }

  // Returns a frozen history copy; callers cannot tamper with subsequent model requests.
  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  // Execute user requests until receiving final text, encountering unrecoverable responses, or exhausting turns.
  async run(prompt: string): Promise<RunResult> {
    // history is the accumulated session of a single Runner; rebuild system messages and tool snapshots each turn.
    this.#history.push(userMessage(prompt));
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      validateToolPairing(this.#history);
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: Object.freeze([systemMessage(this.#systemPrompt), ...this.#history]),
        tools: tools.openAITools(),
      });
      const reply = await this.#model.complete(request);

      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

      const assistant = reply.message;
      this.#history.push(assistant);
      if (assistant.toolCalls.length === 0) {
        // When no tool calls exist, non-empty text serves as the deliverable final reply.
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
        } else if (this.#permissionPolicy !== undefined) {
          // Permission decisions must occur before the handler; evaluation exceptions must also backfill paired errors.
          try {
            const decision = await this.#permissionPolicy.decide(
              new PermissionRequest({ prepared, context }),
            );
            result = decision.isAllowed
              ? await tools.invoke(prepared, context)
              : decision.toToolResult();
          } catch {
            result = toolError("permission_evaluation_error", "Permission evaluation failed");
          }
        } else {
          // The first two chapters have no permission capability; preserve their direct-invocation teaching behavior.
          result = await tools.invoke(prepared, context);
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }
}
