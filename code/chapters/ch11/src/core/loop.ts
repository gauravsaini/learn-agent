import { resolve } from "node:path";

import { HookContractError, HookRegistry } from "./hooks.js";
import type { HookResult } from "./hooks.js";
import {
  isChatMessage,
  systemMessage,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "./messages.js";
import type { ChatMessage, ToolCall } from "./messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "./model.js";
import { PermissionDecision, PermissionPolicy, PermissionRequest } from "./permissions.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { copyToolResult, toolError } from "./tools.js";

// AgentRunner is the Agent Loop: inserts hooks/handlers before and after model, permissions, and tools, ensuring every tool call has a backfilled result.
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

export interface RunResult {
  readonly finalText: string;
  readonly history: readonly ChatMessage[];
  readonly turns: number;
}

export interface AgentRunnerOptions {
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly systemPrompt: string;
  // The dynamic prompt Provider can replace fixed systemPrompt; re-call render() before each model request.
  readonly systemPromptProvider?: SystemPromptProvider;
  readonly workspace: string;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly hooks?: HookRegistry;
  readonly toolRoundObserver?: ToolRoundObserver;
  // Request processors affect only the next model request; tool result processors must finish before backfilling.
  readonly historyProcessor?: RequestHistoryProcessor;
  readonly toolResultProcessor?: ToolResultProcessor;
  readonly turnLifecycle?: TurnLifecycle;
  readonly modelRequestExecutor?: ModelRequestExecutor;
}

export interface RequestHistoryProcessor {
  // Handler output must still satisfy message pairing to ensure compaction does not break model protocols.
  prepare(history: readonly ChatMessage[]): Promise<readonly ChatMessage[]>;
}

// The dynamic prompt Provider keeps a zero-argument contract with AgentRunner; the composition root binds internal data sources at build time.
export interface SystemPromptProvider {
  // Temporarily read dynamic system prompt each model call without writing rendered results to conversation history.
  render(): string;
}

export interface ModelRequestExecutor {
  // Executor must call beginTurn explicitly when taking over model calls to align recovery state with Agent turns.
  beginTurn(): void;
  complete(request: ModelRequest): Promise<ModelReply>;
}

// TurnLifecycle is the boundary for cross-request capabilities such as memory: beginTurn executes before the first turn,
// beforeModel attaches context only to the next model request; complete wraps up before returning the final result.
export interface TurnLifecycle {
  beginTurn(query: string): Promise<void>;
  beforeModel(): readonly ChatMessage[];
  complete(history: readonly ChatMessage[]): Promise<void>;
}

export type ToolResultProcessor = (
  results: readonly ToolResult[],
) => Promise<readonly ToolResult[]> | readonly ToolResult[];

export interface ToolRoundObserver {
  // Observers can provide guidance before model requests and update internal state after tool turns complete.
  beforeModel(): readonly ChatMessage[];
  recordToolRound(toolNames: readonly string[]): void;
}

interface ToolExecution {
  readonly result: ToolResult;
  readonly additionalContext: readonly ChatMessage[];
  readonly preventContinuation: boolean;
}

export class AgentRunner {
  readonly #model: ModelClient;
  readonly #tools: ToolRegistry;
  readonly #systemPrompt: string;
  readonly #systemPromptProvider: SystemPromptProvider | undefined;
  readonly #workspace: string;
  readonly #maxTurns: number;
  readonly #identity: string;
  readonly #permissionPolicy: PermissionPolicy | undefined;
  readonly #hooks: HookRegistry;
  readonly #toolRoundObserver: ToolRoundObserver | undefined;
  readonly #historyProcessor: RequestHistoryProcessor | undefined;
  readonly #toolResultProcessor: ToolResultProcessor | undefined;
  readonly #turnLifecycle: TurnLifecycle | undefined;
  // P11 executor takes over model requests; calls ModelClient directly via legacy path when omitted.
  readonly #modelRequestExecutor: ModelRequestExecutor | undefined;
  readonly #history: ChatMessage[] = [];

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
    if (
      options.systemPromptProvider !== undefined &&
      typeof options.systemPromptProvider.render !== "function"
    ) {
      // provider contracts validate during construction to avoid discovering missing render() during model calls.
      throw new TypeError("systemPromptProvider must implement render()");
    }
    if (
      options.modelRequestExecutor !== undefined &&
      (typeof options.modelRequestExecutor.beginTurn !== "function" ||
        typeof options.modelRequestExecutor.complete !== "function")
    ) {
      // Validate executor contracts at construction as well, avoiding discovering missing methods during model call phases.
      throw new TypeError("modelRequestExecutor must implement beginTurn() and complete()");
    }

    this.#model = options.model;
    this.#tools = options.tools;
    this.#systemPrompt = options.systemPrompt;
    this.#systemPromptProvider = options.systemPromptProvider;
    this.#workspace = resolve(options.workspace);
    this.#maxTurns = maxTurns;
    this.#identity = identity;
    this.#permissionPolicy =
      options.permissionPolicy === undefined && options.hooks !== undefined
        ? new PermissionPolicy()
        : options.permissionPolicy;
    this.#hooks = options.hooks === undefined ? new HookRegistry() : options.hooks;
    this.#toolRoundObserver = options.toolRoundObserver;
    this.#historyProcessor = options.historyProcessor;
    this.#toolResultProcessor = options.toolResultProcessor;
    this.#turnLifecycle = options.turnLifecycle;
    this.#modelRequestExecutor = options.modelRequestExecutor;
  }

  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  async run(prompt: string): Promise<RunResult> {
    const submitted = userMessage(prompt);
    const promptHook = await this.#hooks.runUserPrompt(submitted);
    this.#history.push(submitted, ...promptHook.additionalContext);
    if (this.#turnLifecycle !== undefined) {
      // Lifecycles execute before the first model request; selection failures fall back gracefully and must not block the main Agent.
      await this.#turnLifecycle.beginTurn(prompt);
    }
    // Executors align turn boundaries with memory lifecycles; call ModelClient directly when not injected in P01-P10.
    this.#modelRequestExecutor?.beginTurn();
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: this.#identity,
    });

    let stopHookActive = false;
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      validateToolPairing(this.#history);
      const preparedHistory: unknown =
        this.#historyProcessor === undefined
          ? this.#history
          : await this.#historyProcessor.prepare(Object.freeze([...this.#history]));
      if (
        !Array.isArray(preparedHistory) ||
        !preparedHistory.every((message: unknown) => isChatMessage(message))
      ) {
        throw new AgentRunError("Request history processor returned invalid messages");
      }
      // requestHistory determines only what the model sees this turn; canonical history remains append-only in full.
      const requestHistory = Object.freeze([...preparedHistory]);
      validateToolPairing(requestHistory);
      // Lifecycle injections only enter the current model request and are not written to canonical history.
      const turnGuidance =
        this.#turnLifecycle === undefined ? [] : this.#turnLifecycle.beforeModel();
      if (
        !Array.isArray(turnGuidance) ||
        !turnGuidance.every((message: unknown) => isChatMessage(message))
      ) {
        throw new AgentRunError("Turn lifecycle returned invalid model guidance");
      }
      const observerGuidance =
        this.#toolRoundObserver === undefined ? [] : this.#toolRoundObserver.beforeModel();
      // Observer guidance is request-level content and affects only current model input; TODO reminders are not written to persistent history.
      // The system prompt renders before each turn assembly request, making tool list and selected memory changes take effect next turn.
      const systemPrompt = this.#renderSystemPrompt();
      const requestMessages = Object.freeze([
        systemMessage(systemPrompt),
        ...requestHistory,
        ...turnGuidance,
        ...observerGuidance,
      ]);
      validateToolPairing(requestMessages);
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: requestMessages,
        tools: tools.openAITools(),
      });
      // The model boundary sends only current turn requests; this class continues to maintain canonical history.
      // When an executor exists, internal retries, compaction, and fallbacks conclude inside complete() without re-entering the outer loop.
      const reply = await (this.#modelRequestExecutor === undefined
        ? this.#model.complete(request)
        : this.#modelRequestExecutor.complete(request));

      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      // content_filter is the provider terminal state stating "reply filtered"; do not treat as final text or retry.
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

      const assistant = reply.message;
      this.#history.push(assistant);
      if (assistant.toolCalls.length === 0) {
        if (assistant.content === null) {
          throw new AgentRunError("Model stopped without final text or tool calls");
        }
        const stopHook = await this.#hooks.runStop(this.#history, stopHookActive);
        if (stopHook.forceContinue !== undefined) {
          this.#history.push(...stopHook.additionalContext, stopHook.forceContinue);
          stopHookActive = true;
          continue;
        }
        return await this.#complete(assistant.content, turn);
      }

      // Each call in an assistant message must backfill once, including errors and denials.
      const results: ToolResult[] = [];
      const deferredContext: ChatMessage[] = [];
      let stoppedResultIndex: number | undefined;
      for (const call of assistant.toolCalls) {
        let result: ToolResult;
        if (stoppedResultIndex !== undefined) {
          result = toolError(
            "hook_stopped_continuation",
            "Skipped after PostToolUse requested a stop",
          );
        } else {
          const execution = await this.#executeTool(call, context, tools);
          result = execution.result;
          deferredContext.push(...execution.additionalContext);
          if (execution.preventContinuation) {
            stoppedResultIndex = results.length;
          }
        }
        results.push(result);
      }
      const processedResults = await this.#processToolResults(results, assistant.toolCalls);
      // Every tool call must backfill a tool message; otherwise subsequent model requests break protocol pairing.
      for (const [index, call] of assistant.toolCalls.entries()) {
        const result = processedResults[index];
        if (result === undefined) {
          throw new AgentRunError("Tool execution did not produce a paired result");
        }
        this.#history.push(toolMessage(result.content, call.id));
      }
      if (this.#toolRoundObserver !== undefined) {
        this.#toolRoundObserver.recordToolRound(assistant.toolCalls.map((call) => call.name));
      }
      this.#history.push(...deferredContext);
      if (stoppedResultIndex !== undefined) {
        const stoppedResult = processedResults[stoppedResultIndex];
        if (stoppedResult === undefined) {
          throw new AgentRunError("PostToolUse stop did not preserve its result");
        }
        return await this.#complete(stoppedResult.content, turn);
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }

  async #processToolResults(
    results: readonly ToolResult[],
    calls: readonly ToolCall[],
  ): Promise<readonly ToolResult[]> {
    if (this.#toolResultProcessor === undefined) {
      // Deep-copy results even when no processor exists, preventing mutable internal tool objects from polluting canonical history.
      return Object.freeze(results.map((result) => copyToolResult(result)));
    }
    try {
      // Handlers receive a read-only snapshot; returned batches must match tool call counts, or backfill the entire batch as errors.
      const input = Object.freeze(results.map((result) => copyToolResult(result)));
      const processed: unknown = await this.#toolResultProcessor(input);
      if (!Array.isArray(processed) || processed.length !== calls.length) {
        throw new Error("tool result processor returned an invalid batch");
      }
      return Object.freeze(processed.map((result) => copyToolResult(result)));
    } catch {
      // Handlers return controlled errors in full batch on failure, still mapping one-to-one to original tool call counts.
      return Object.freeze(
        calls.map(() => toolError("tool_result_processing_error", "Tool result processing failed")),
      );
    }
  }

  // Render the system prompt before each model request; use the build-time fixed string when provider is missing.
  #renderSystemPrompt(): string {
    // Provider output is model boundary input; empty values fail immediately rather than falling back to stale cache.
    const rendered =
      this.#systemPromptProvider === undefined
        ? this.#systemPrompt
        : this.#systemPromptProvider.render();
    if (typeof rendered !== "string" || rendered.trim().length === 0) {
      throw new AgentRunError("System prompt provider returned an empty prompt");
    }
    return rendered;
  }

  async #executeTool(
    call: ToolCall,
    context: ToolContext,
    tools: ToolRegistry,
  ): Promise<ToolExecution> {
    let prepared: PreparedToolCall;
    try {
      prepared = tools.prepare(call);
    } catch {
      return execution(toolError("tool_preparation_error", "Tool preparation failed"));
    }
    if (prepared.error !== undefined) {
      return execution(prepared.error);
    }

    let preHook: HookResult;
    try {
      preHook = await this.#hooks.runPreTool(prepared);
    } catch (error) {
      return execution(
        error instanceof HookContractError
          ? toolError("hook_contract_error", "PreToolUse hook returned an invalid update")
          : toolError("hook_execution_error", "PreToolUse hook failed"),
      );
    }
    const effective = preHook.updatedInput === undefined ? prepared : preHook.updatedInput;
    // Pre Hook can block or recommend permissions; unified permission policy still arbitrates actual denials.
    if (preHook.blockingError !== undefined) {
      return execution(preHook.blockingError, preHook.additionalContext);
    }

    if (this.#permissionPolicy !== undefined) {
      // Hooks submit only structured recommendations; system deny retains highest priority in policy merging.
      try {
        const decision = await this.#permissionPolicy.decide(
          new PermissionRequest({
            prepared: effective,
            context,
            recommendations: hookRecommendations(preHook),
          }),
        );
        if (!decision.isAllowed) {
          return execution(decision.toToolResult(), preHook.additionalContext);
        }
      } catch {
        return execution(
          toolError("permission_evaluation_error", "Permission evaluation failed"),
          preHook.additionalContext,
        );
      }
    }

    let result = await tools.invoke(effective, context);
    let postHook: HookResult;
    try {
      postHook = await this.#hooks.runPostTool(effective, result);
    } catch {
      return execution(
        toolError("hook_execution_error", "PostToolUse hook failed"),
        preHook.additionalContext,
      );
    }
    if (postHook.updatedOutput !== undefined) {
      result = postHook.updatedOutput;
    }
    return execution(
      result,
      [...preHook.additionalContext, ...postHook.additionalContext],
      postHook.preventContinuation,
    );
  }

  async #complete(finalText: string, turns: number): Promise<RunResult> {
    validateToolPairing(this.#history);
    if (this.#turnLifecycle !== undefined) {
      // complete uses full canonical history so the extractor sees the raw session before request-level compaction.
      await this.#turnLifecycle.complete(Object.freeze([...this.#history]));
    }
    return Object.freeze({
      finalText,
      history: Object.freeze([...this.#history]),
      turns,
    });
  }
}

function execution(
  result: ToolResult,
  additionalContext: readonly ChatMessage[] = [],
  preventContinuation = false,
): ToolExecution {
  return Object.freeze({
    result,
    additionalContext: Object.freeze([...additionalContext]),
    preventContinuation,
  });
}

function hookRecommendations(hook: HookResult): readonly PermissionDecision[] {
  if (hook.permissionBehavior === "passthrough") {
    return [];
  }
  return [
    new PermissionDecision(
      hook.permissionBehavior,
      `PreToolUse hook requested ${hook.permissionBehavior}`,
      "pre-tool-hook",
    ),
  ];
}
