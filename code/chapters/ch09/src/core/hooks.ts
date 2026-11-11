// Hook lifecycle: registers callbacks by event, merges results serially, and enforces structured side effects.
import type { ChatMessage } from "./messages.js";
import { isChatMessage, systemMessage, userMessage } from "./messages.js";
import type { PermissionBehavior } from "./permissions.js";
import { isPermissionBehavior } from "./permissions.js";
import type { PreparedToolCall, ToolResult } from "./tools.js";
import { copyToolResult, freezePreparedToolCall, isToolResult } from "./tools.js";

// Supported lifecycle event collection. The registry and runtime validation share it to avoid event name drift.
export const HOOK_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const);
// Hooks are restricted extension points: event context and return values validate strictly against event type.
export type HookEvent = (typeof HOOK_EVENTS)[number];

export class HookContractError extends Error {
  // Stable error name, indicating that Hook inputs, outputs, or event fields violate the restricted extension contract.
  override readonly name: string = "HookContractError";
}

// Narrow unknown event values. Code must pass this boundary before constructing HookContext and registering callbacks.
function isHookEvent(value: unknown): value is HookEvent {
  return HOOK_EVENTS.some((event) => event === value);
}

// Verify the Hook receives calls validated by tool name and schema, rejecting incomplete prepare results.
function isValidPrepared(prepared: unknown): prepared is PreparedToolCall {
  if (typeof prepared !== "object" || prepared === null) {
    return false;
  }
  const value = prepared as PreparedToolCall;
  const call = value.call;
  const definition = value.definition;
  return (
    typeof call === "object" &&
    call !== null &&
    typeof call.id === "string" &&
    call.id.length > 0 &&
    typeof call.name === "string" &&
    call.name.length > 0 &&
    typeof call.arguments === "string" &&
    value.error === undefined &&
    typeof definition === "object" &&
    definition !== null &&
    typeof definition.name === "string" &&
    typeof definition.inputSchema?.safeParse === "function" &&
    typeof definition.invoke === "function" &&
    value.arguments !== undefined
  );
}

export interface HookContextOptions {
  // Determines which field lifecycle events are permitted.
  readonly event: HookEvent;
  // User message specific to UserPromptSubmit.
  readonly message?: ChatMessage;
  // Prepared call exclusive to PreToolUse/PostToolUse.
  readonly prepared?: PreparedToolCall;
  // Tool result exclusive to PostToolUse.
  readonly result?: ToolResult;
  // Current session history snapshot exclusive to Stop.
  readonly history?: readonly ChatMessage[];
  // Whether Stop has already requested continuation, used to prevent Hook self-perpetuation.
  readonly stopHookActive?: boolean;
}

// Frozen lifecycle data seen by a Hook callback; distinct events strictly isolate field ownership.
export class HookContext {
  // Each event carries only data it owns to prevent hooks from misusing states of other lifecycle stages.
  readonly event: HookEvent;
  readonly message: ChatMessage | undefined;
  readonly prepared: PreparedToolCall | undefined;
  readonly result: ToolResult | undefined;
  readonly history: readonly ChatMessage[];
  readonly stopHookActive: boolean;

  // Validate event field combinations, copy history, and freeze context to prevent callbacks from modifying agent internal state.
  constructor(options: HookContextOptions) {
    if (!isHookEvent(options.event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    const history = options.history === undefined ? [] : options.history;
    const stopHookActive = options.stopHookActive === undefined ? false : options.stopHookActive;
    if (!Array.isArray(history) || !history.every((message: unknown) => isChatMessage(message))) {
      throw new HookContractError(`${options.event} history must contain ChatMessage values`);
    }
    if (typeof stopHookActive !== "boolean") {
      throw new HookContractError("stopHookActive must be boolean");
    }

    this.event = options.event;
    this.message = options.message;
    this.prepared = options.prepared;
    this.result = options.result;
    this.history = Object.freeze([...history]);
    this.stopHookActive = stopHookActive;
    this.#validateEventFields();
    Object.freeze(this);
  }

  // Validate field ownership by event to prevent hooks, such as Stop Hook, from reading or forging tool execution state.
  #validateEventFields(): void {
    if (this.event === "UserPromptSubmit") {
      if (!isChatMessage(this.message) || this.message.role !== "user") {
        throw new HookContractError("UserPromptSubmit requires a user message");
      }
      if (
        this.prepared !== undefined ||
        this.result !== undefined ||
        this.history.length > 0 ||
        this.stopHookActive
      ) {
        throw new HookContractError("UserPromptSubmit received fields owned by another event");
      }
      return;
    }
    if (this.event === "PreToolUse") {
      if (!isValidPrepared(this.prepared)) {
        throw new HookContractError("PreToolUse requires a valid prepared tool call");
      }
      if (
        this.message !== undefined ||
        this.result !== undefined ||
        this.history.length > 0 ||
        this.stopHookActive
      ) {
        throw new HookContractError("PreToolUse received fields owned by another event");
      }
      return;
    }
    if (this.event === "PostToolUse") {
      if (!isValidPrepared(this.prepared)) {
        throw new HookContractError("PostToolUse requires a valid prepared tool call");
      }
      if (!isToolResult(this.result)) {
        throw new HookContractError("PostToolUse requires a tool result");
      }
      if (this.message !== undefined || this.history.length > 0 || this.stopHookActive) {
        throw new HookContractError("PostToolUse received fields owned by another event");
      }
      return;
    }
    if (this.message !== undefined || this.prepared !== undefined || this.result !== undefined) {
      throw new HookContractError("Stop received fields owned by another event");
    }
  }
}

export interface HookResultOptions {
  // Candidate action proposed by PreToolUse for permission merging.
  readonly permissionBehavior?: PermissionBehavior;
  // Sole permitted argument update for PreToolUse; must retain original call identity and definition.
  readonly updatedInput?: PreparedToolCall;
  // Sole permitted result update for PostToolUse.
  readonly updatedOutput?: ToolResult;
  // Read-only system context appendable by any event, prepended before the next turn model request.
  readonly additionalContext?: readonly ChatMessage[];
  // Error result that PreToolUse can use to block execution and backfill directly.
  readonly blockingError?: ToolResult;
  // PostToolUse requests stopping remaining calls in the same turn and subsequent continuation.
  readonly preventContinuation?: boolean;
  // User message requesting an additional model turn from Stop; allowed to take effect only once.
  readonly forceContinue?: ChatMessage;
}

// Structured impact of Hooks; callbacks cannot rewrite the Loop directly and must return declarative results constrained by events.
export class HookResult {
  // Validate types and freeze copies inside constructor to prevent callback reference leakage.
  // Hook side effects are modeled as structured results and cannot directly modify internal Agent state.
  readonly permissionBehavior: PermissionBehavior;
  readonly updatedInput: PreparedToolCall | undefined;
  readonly updatedOutput: ToolResult | undefined;
  readonly additionalContext: readonly ChatMessage[];
  readonly blockingError: ToolResult | undefined;
  readonly preventContinuation: boolean;
  readonly forceContinue: ChatMessage | undefined;

  // Validates result shape, deep copies mutable references, and freezes to prevent callback return values from being rewritten after merging.
  constructor(options: HookResultOptions = {}) {
    const permissionBehavior = options.permissionBehavior ?? "passthrough";
    const additionalContext = options.additionalContext ?? [];
    const preventContinuation = options.preventContinuation ?? false;
    if (!isPermissionBehavior(permissionBehavior)) {
      throw new HookContractError("permissionBehavior must be a PermissionBehavior");
    }
    if (options.updatedInput !== undefined && !isValidPrepared(options.updatedInput)) {
      throw new HookContractError("updatedInput must be a valid prepared tool call");
    }
    if (options.updatedOutput !== undefined && !isToolResult(options.updatedOutput)) {
      throw new HookContractError("updatedOutput must be a ToolResult");
    }
    if (
      options.blockingError !== undefined &&
      (!isToolResult(options.blockingError) || !options.blockingError.isError)
    ) {
      throw new HookContractError("blockingError must be an error ToolResult");
    }
    if (
      !Array.isArray(additionalContext) ||
      !additionalContext.every(
        (message: unknown) => isChatMessage(message) && message.role === "system",
      )
    ) {
      throw new HookContractError("additionalContext must contain system ChatMessage values");
    }
    if (typeof preventContinuation !== "boolean") {
      throw new HookContractError("preventContinuation must be boolean");
    }
    if (
      options.forceContinue !== undefined &&
      (!isChatMessage(options.forceContinue) || options.forceContinue.role !== "user")
    ) {
      throw new HookContractError("forceContinue must be a user message");
    }

    this.permissionBehavior = permissionBehavior;
    this.updatedInput = options.updatedInput;
    this.updatedOutput =
      options.updatedOutput === undefined ? undefined : copyToolResult(options.updatedOutput);
    this.additionalContext = Object.freeze(
      additionalContext.map((message) => systemMessage(message.content)),
    );
    this.blockingError =
      options.blockingError === undefined ? undefined : copyToolResult(options.blockingError);
    this.preventContinuation = preventContinuation;
    this.forceContinue =
      options.forceContinue === undefined ? undefined : userMessage(options.forceContinue.content);
    Object.freeze(this);
  }

  // Check that the current result uses only fields allowed by the target event to avoid cross-lifecycle privilege escalation.
  validateFor(event: HookEvent): void {
    if (!isHookEvent(event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    const invalid: string[] = [];
    if (event !== "PreToolUse") {
      if (this.permissionBehavior !== "passthrough") {
        invalid.push("permissionBehavior");
      }
      if (this.updatedInput !== undefined) {
        invalid.push("updatedInput");
      }
      if (this.blockingError !== undefined) {
        invalid.push("blockingError");
      }
    }
    if (event !== "PostToolUse") {
      if (this.updatedOutput !== undefined) {
        invalid.push("updatedOutput");
      }
      if (this.preventContinuation) {
        invalid.push("preventContinuation");
      }
    }
    if (event !== "Stop" && this.forceContinue !== undefined) {
      invalid.push("forceContinue");
    }
    if (invalid.length > 0) {
      throw new HookContractError(
        `${event} HookResult does not allow fields: ${invalid.join(", ")}`,
      );
    }
  }
}

// Synchronous or asynchronous Hook callback; must return an object constrained by the HookResult contract.
export type HookCallback = (context: HookContext) => HookResult | Promise<HookResult>;

// Maintain an ordered callback queue by event. Run, normalize, and merge callback results sequentially.
export class HookRegistry {
  // Each event has an independent callback queue; registration order is execution order.
  // Callbacks merge in registration order; subsequent callbacks read context normalized by preceding callbacks.
  readonly #callbacks: Map<HookEvent, HookCallback[]> = new Map(
    HOOK_EVENTS.map((event) => [event, []]),
  );

  // Register callbacks at the end of the event queue; registration order is execution order for the event.
  register(event: HookEvent, callback: HookCallback): void {
    if (!isHookEvent(event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    if (typeof callback !== "function") {
      throw new HookContractError("hook callback must be callable");
    }
    const callbacks = this.#callbacks.get(event);
    if (callbacks === undefined) {
      throw new HookContractError(`hook registry is missing event: ${event}`);
    }
    callbacks.push(callback);
  }

  // Executes all callbacks for this event serially, passes normalized context, and merges into a single final result.
  async run(context: HookContext): Promise<HookResult> {
    // Executes callbacks serially and merges results; blockingError or forceContinue short-circuits.
    if (!(context instanceof HookContext)) {
      throw new HookContractError("context must be a HookContext");
    }
    let combined = new HookResult();
    let current = context;
    const callbacks = this.#callbacks.get(context.event);
    if (callbacks === undefined) {
      throw new HookContractError(`hook registry is missing event: ${context.event}`);
    }
    for (const callback of callbacks) {
      const outcome: unknown = await callback(current);
      if (!(outcome instanceof HookResult)) {
        throw new HookContractError(`${context.event} hook callback must return HookResult`);
      }
      outcome.validateFor(context.event);
      const normalizedInput = normalizeUpdatedInput(current, outcome);
      const normalizedOutcome =
        normalizedInput === undefined
          ? outcome
          : new HookResult({
              permissionBehavior: outcome.permissionBehavior,
              updatedInput: normalizedInput,
              additionalContext: outcome.additionalContext,
              ...(outcome.blockingError === undefined
                ? {}
                : { blockingError: outcome.blockingError }),
            });
      const effective =
        context.event === "Stop" &&
        context.stopHookActive &&
        normalizedOutcome.forceContinue !== undefined
          ? new HookResult({ additionalContext: normalizedOutcome.additionalContext })
          : normalizedOutcome;
      combined = mergeResults(combined, effective);

      if (effective.updatedInput !== undefined) {
        current = new HookContext({ event: "PreToolUse", prepared: effective.updatedInput });
      }
      if (effective.updatedOutput !== undefined && current.prepared !== undefined) {
        current = new HookContext({
          event: "PostToolUse",
          prepared: current.prepared,
          result: effective.updatedOutput,
        });
      }
      if (effective.blockingError !== undefined || effective.forceContinue !== undefined) {
        break;
      }
    }
    return combined;
  }

  // Builds UserPromptSubmit context with user message and runs corresponding queue.
  async runUserPrompt(message: ChatMessage): Promise<HookResult> {
    return this.run(new HookContext({ event: "UserPromptSubmit", message }));
  }

  // Constructs PreToolUse context with validated call.
  async runPreTool(prepared: PreparedToolCall): Promise<HookResult> {
    return this.run(new HookContext({ event: "PreToolUse", prepared }));
  }

  // Builds PostToolUse context with call and result.
  async runPostTool(prepared: PreparedToolCall, result: ToolResult): Promise<HookResult> {
    return this.run(new HookContext({ event: "PostToolUse", prepared, result }));
  }

  // Builds Stop context with history and continuation state; Stop can safely request continuation only once.
  async runStop(history: readonly ChatMessage[], stopHookActive: boolean): Promise<HookResult> {
    return this.run(new HookContext({ event: "Stop", history, stopHookActive }));
  }
}

// Re-parses argument updates provided by Hook, keeps original call ID and tool definition, and returns a frozen copy detached from Hook references.
function normalizeUpdatedInput(
  // Re-parses updatedInput and freezes a copy to prevent "approving A but executing B".
  context: HookContext,
  result: HookResult,
): PreparedToolCall | undefined {
  const updated = result.updatedInput;
  if (updated === undefined) {
    return undefined;
  }
  const original = context.prepared;
  if (original === undefined || original.definition === undefined) {
    throw new HookContractError("updatedInput requires an existing prepared tool call");
  }
  if (updated.call.id !== original.call.id) {
    throw new HookContractError("updatedInput must preserve the OpenAI tool call id");
  }
  if (updated.call.name !== original.call.name) {
    throw new HookContractError("updatedInput must preserve the tool name");
  }
  if (updated.definition !== original.definition) {
    throw new HookContractError("updatedInput must preserve the registered definition");
  }
  const parsed = original.definition.inputSchema.safeParse(updated.arguments);
  if (!parsed.success) {
    throw new HookContractError("updatedInput arguments must match the registered input schema");
  }
  // Approval and execution read only this frozen copy detached from original Hook references, preventing approving A and executing B.
  return freezePreparedToolCall(updated.call, original.definition, parsed.data);
}

// Merge serial callback effects: latter updates take precedence, context accumulates, strictest permission wins, block/continue short-circuits keep first item.
function mergeResults(current: HookResult, incoming: HookResult): HookResult {
  // Merge strategy: updatedInput/Output gives precedence to the latter, additionalContext concatenates,
  // OR preventContinuation, take the strictest permissionBehavior,
  // blockingError/forceContinue short-circuits and preserves the first occurrence.
  return new HookResult({
    permissionBehavior: strongerPermission(current.permissionBehavior, incoming.permissionBehavior),
    ...(incoming.updatedInput === undefined
      ? current.updatedInput === undefined
        ? {}
        : { updatedInput: current.updatedInput }
      : { updatedInput: incoming.updatedInput }),
    ...(incoming.updatedOutput === undefined
      ? current.updatedOutput === undefined
        ? {}
        : { updatedOutput: current.updatedOutput }
      : { updatedOutput: incoming.updatedOutput }),
    additionalContext: [...current.additionalContext, ...incoming.additionalContext],
    ...(incoming.blockingError === undefined
      ? current.blockingError === undefined
        ? {}
        : { blockingError: current.blockingError }
      : { blockingError: incoming.blockingError }),
    preventContinuation: current.preventContinuation || incoming.preventContinuation,
    ...(incoming.forceContinue === undefined
      ? current.forceContinue === undefined
        ? {}
        : { forceContinue: current.forceContinue }
      : { forceContinue: incoming.forceContinue }),
  });
}

// Merge permission recommendations by conservative priority: deny > ask > allow > passthrough.
function strongerPermission(
  // deny > ask > allow > passthrough
  current: PermissionBehavior,
  incoming: PermissionBehavior,
): PermissionBehavior {
  const priority: Readonly<Record<PermissionBehavior, number>> = {
    passthrough: 0,
    allow: 1,
    ask: 2,
    deny: 3,
  };
  return priority[incoming] > priority[current] ? incoming : current;
}
