import { resolve } from "node:path";

import { isRuntimeEvent, runtimeEventMessage } from "./events.js";
import type { RuntimeEvent } from "./events.js";
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
import { copyToolResult, isToolResult, toolError } from "./tools.js";

// AgentRunner is the Agent Loop: coordinates model, tools, permissions, hooks, background events, and resource shutdown, and ensures every tool call has protocol backfill.
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
  readonly systemPromptProvider?: SystemPromptProvider;
  readonly workspace: string;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly hooks?: HookRegistry;
  readonly toolRoundObserver?: ToolRoundObserver;
  readonly historyProcessor?: RequestHistoryProcessor;
  readonly toolResultProcessor?: ToolResultProcessor;
  readonly turnLifecycle?: TurnLifecycle;
  readonly modelRequestExecutor?: ModelRequestExecutor;
  // Optional dispatcher takes over tool execution; scenarios like background tasks return placeholder results first, submitting terminal states asynchronously later.
  readonly toolDispatcher?: ToolDispatcher;
  // Optional event pump injects background terminal states into Agent Loop asynchronously; events arrive before each turn model request.
  readonly eventPump?: RuntimeEventPump;
  // Optional external resources close uniformly in reverse order; AgentRunner converges their lifecycles on close().
  readonly resources?: readonly AsyncResource[];
}

// Handler output must still satisfy message pairing to ensure compaction does not break model protocols.
export interface RequestHistoryProcessor {
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

// Tool dispatchers retain return value contracts of original synchronous execution paths; background jobs return placeholder results first, then supply final states via event pumps.
export interface ToolDispatcher {
  // Receive calls that passed schema validation. Implementations must return a unified ToolResult and cannot backfill history directly.
  dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult>;
}

// Event pump is a one-way channel from external runtime to Agent Loop: drain fetches ready events, waitForEvents waits for pending work, and acknowledgeEvents marks events consumed.
export interface RuntimeEventPump {
  // Indicates external runtimes may still produce events, helping tool-free turns decide whether to block and wait.
  readonly hasPendingWork: boolean;
  // Drains the current batch of events non-blockingly.
  drainEvents(limit?: number): readonly RuntimeEvent[];
  // Wait for the next batch of events when pending work exists.
  waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]>;
  // Confirm this batch of events was received by the Loop; implementations can persist the consumption position accordingly.
  acknowledgeEvents(events: readonly RuntimeEvent[]): void;
  // Optional recovery barrier ensuring construction-phase recovery events publish before the first drain.
  ready?(): Promise<void>;
}

// AsyncResource is a shutdown boundary manageable by Runner; injected by composition root so core avoids direct dependency on concrete background implementations.
export interface AsyncResource {
  // Releases asynchronous resources; Runner calls them in reverse order of injection.
  close(): Promise<void>;
}

// Observers can provide guidance before model requests and update internal state after tool turns complete.
export interface ToolRoundObserver {
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
  readonly #modelRequestExecutor: ModelRequestExecutor | undefined;
  // ToolDispatcher can take over actual calls; when not injected, it still uses the synchronous path of ToolRegistry.invoke.
  readonly #toolDispatcher: ToolDispatcher | undefined;
  // EventPump optionally receives background terminal states; when omitted, maintains synchronous Agent Loop of P01-P12.
  readonly #eventPump: RuntimeEventPump | undefined;
  // Save external resources as frozen arrays and execute in reverse order on close, ensuring dependents release before dependencies.
  readonly #resources: readonly AsyncResource[];
  readonly #history: ChatMessage[] = [];
  // Event ID deduplication table: a background event can be injected into canonical history only once as a user message.
  readonly #seenEventIds = new Set<string>();
  // Running and closed states form the Runner lifecycle: concurrent run, duplicate close, and execution after close all fail explicitly.
  #running = false;
  #closed = false;
  #closing = false;

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
      throw new TypeError("systemPromptProvider must implement render()");
    }
    if (
      options.modelRequestExecutor !== undefined &&
      (typeof options.modelRequestExecutor.beginTurn !== "function" ||
        typeof options.modelRequestExecutor.complete !== "function")
    ) {
      throw new TypeError("modelRequestExecutor must implement beginTurn() and complete()");
    }
    // Optional extension contracts validate at construction, avoiding missing methods during model or tool phases.
    if (
      options.toolDispatcher !== undefined &&
      typeof options.toolDispatcher.dispatch !== "function"
    ) {
      throw new TypeError("toolDispatcher must implement dispatch()");
    }
    // Injects only after full event pump contract validation; Loop retains original synchronous behavior when un-injected.
    if (
      options.eventPump !== undefined &&
      (typeof options.eventPump.drainEvents !== "function" ||
        typeof options.eventPump.waitForEvents !== "function" ||
        typeof options.eventPump.acknowledgeEvents !== "function" ||
        (options.eventPump.ready !== undefined && typeof options.eventPump.ready !== "function"))
    ) {
      throw new TypeError("eventPump must implement the RuntimeEventPump contract");
    }
    // Resource array accepts only objects implementing close(); defaults to empty and produces no side effects on close.
    const resources = options.resources === undefined ? [] : options.resources;
    if (
      !Array.isArray(resources) ||
      !resources.every((resource) => typeof resource.close === "function")
    ) {
      throw new TypeError("resources must contain AsyncResource values");
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
    this.#toolDispatcher = options.toolDispatcher;
    this.#eventPump = options.eventPump;
    this.#resources = Object.freeze([...resources]);
  }

  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  async run(prompt: string): Promise<RunResult> {
    // State checks complete before entering a turn to prevent concurrent runs or closing Runners from starting model or tool side effects.
    this.#ensureOpen();
    if (this.#closed) {
      throw new AgentRunError("AgentRunner is closed");
    }
    if (this.#running) {
      throw new AgentRunError("AgentRunner is already running");
    }
    // Reset running flag in finally to ensure Runner remains reusable after exceptional exits.
    this.#running = true;
    try {
      return await this.#runUserTurn(prompt);
    } finally {
      this.#running = false;
    }
  }

  async #runUserTurn(prompt: string): Promise<RunResult> {
    // canonical history is always appended in full; request-level compaction or lifecycle injections only affect each model snapshot.
    this.#ensureOpen();
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
      // Receive completed background events before each model request to prevent events from being visible only in the first turn.
      await this.#acceptNextRuntimeEvent(false);
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
      const requestHistory = Object.freeze([...preparedHistory]);
      // requestHistory determines only what the model sees this turn; canonical history remains append-only in full.
      validateToolPairing(requestHistory);
      // beforeModel injection enters only the current model request; it does not write to canonical history.
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
      const reply = await (this.#modelRequestExecutor === undefined
        ? this.#model.complete(request)
        : this.#modelRequestExecutor.complete(request));
      // When an executor exists, internal retries, compaction, and fallbacks conclude inside complete() without re-entering the outer loop.

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
        const stopHook = await this.#hooks.runStop(this.#history, stopHookActive);
        if (stopHook.forceContinue !== undefined) {
          this.#history.push(...stopHook.additionalContext, stopHook.forceContinue);
          stopHookActive = true;
          continue;
        }
        // No tool calls remain in the current turn; wait for background events with potential results, continuing to the next turn on arrival.
        const injectedCount = await this.#acceptNextRuntimeEvent(true);
        if (injectedCount > 0) {
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
      for (const [index, call] of assistant.toolCalls.entries()) {
        const result = processedResults[index];
        if (result === undefined) {
          throw new AgentRunError("Tool execution did not produce a paired result");
        }
        // Every tool call must backfill a tool message; otherwise subsequent model requests break protocol pairing.
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
    // Deep-copy results even when no processor exists, preventing mutable internal tool objects from polluting canonical history.
    if (this.#toolResultProcessor === undefined) {
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
    // Tool execution boundaries produce ToolResults uniformly; Hook, permission, and handler exceptions never expose raw stacks.
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

    let result: ToolResult;
    try {
      // Dispatcher can optionally take over tool execution, but must return the same ToolResult contract; errors convert uniformly to controlled errors.
      result =
        this.#toolDispatcher === undefined
          ? await tools.invoke(effective, context)
          : await this.#toolDispatcher.dispatch(effective, context);
      if (!isToolResult(result)) {
        throw new TypeError("tool dispatcher returned an invalid result");
      }
    } catch {
      return execution(
        toolError("tool_dispatch_error", "Tool dispatch failed"),
        preHook.additionalContext,
      );
    }
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
    // complete uses full canonical history so the extractor sees the raw session before request-level compaction.
    if (this.#turnLifecycle !== undefined) {
      await this.#turnLifecycle.complete(Object.freeze([...this.#history]));
    }
    return Object.freeze({
      finalText,
      history: Object.freeze([...this.#history]),
      turns,
    });
  }

  // Repeated closing is idempotent; concurrent calls are rejected during closing to prevent disorder in resource release.
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#closing) {
      throw new AgentRunError("AgentRunner close is already in progress");
    }
    this.#closing = true;
    const failures: unknown[] = [];
    try {
      // Resources are released in reverse injection order, collecting individual failures to ensure one resource exception does not abort remaining cleanup.
      for (const resource of [...this.#resources].reverse()) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.#closing = false;
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "AgentRunner close failed");
    }
    this.#closed = true;
  }

  // Drains all ready events at once; duplicate ids are acknowledged and skipped to avoid writing the same background result to history multiple times.
  // Inject new events as multiple user messages by batch position. Return the injected count so tool-less turns can decide whether to continue.
  async #acceptNextRuntimeEvent(waitForPendingWork: boolean): Promise<number> {
    if (this.#eventPump === undefined) {
      return 0;
    }
    if (this.#eventPump.ready !== undefined) {
      await this.#eventPump.ready();
    }
    let events = this.#eventPump.drainEvents();
    if (events.length === 0 && waitForPendingWork && this.#eventPump.hasPendingWork) {
      events = await this.#eventPump.waitForEvents();
    }
    if (events.length === 0) {
      return 0;
    }
    // Fail explicitly if any event in the batch is invalid; acknowledge applies only to dequeued events and cannot revoke across batches.
    if (!events.every((event) => isRuntimeEvent(event))) {
      throw new AgentRunError("Runtime event pump returned invalid events");
    }
    // Filters duplicate IDs first before computing batch positions, so the model sees multiple consecutive and ordered completion facts at once.
    const injected: RuntimeEvent[] = [];
    for (const event of events) {
      if (this.#seenEventIds.has(event.eventId)) {
        continue;
      }
      this.#seenEventIds.add(event.eventId);
      injected.push(event);
    }
    this.#eventPump.acknowledgeEvents(events);
    for (const [index, event] of injected.entries()) {
      this.#history.push(runtimeEventMessage(event, { index, total: injected.length }));
    }
    return injected.length;
  }

  // Closed or closing Runners cannot continue executing turns; state errors throw explicitly instead of silently degrading.
  #ensureOpen(): void {
    if (this.#closed || this.#closing) {
      throw new AgentRunError("AgentRunner is closed");
    }
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
