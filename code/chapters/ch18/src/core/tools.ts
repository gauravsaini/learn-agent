import { z } from "zod";

import type { ToolCall } from "./messages.js";
import { toolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect is the minimal source of truth for permission policies and tool list visibility, without guessing from tool names.
export type EffectClass = "read" | "write" | "execute" | "external";
// concurrency is the explicit contract for Dispatcher to decide if a tool can run in the background; defaults to inline.
export type ConcurrencyClass = "inline" | "background_eligible";

// ToolContext is the immutable execution boundary for each tool call; in P18 the provider inserts it before the handler
// taskId/claimToken/worktreeName, resolving workspace into the Worktree path for the current claim.
export interface ToolContext {
  // Actual execution directory: main workspace when unbound to a claim; Managed Worktree after binding.
  readonly workspace: string;
  // Executor identity, used for claim owner validation; fixed by Runner, immutable by handlers.
  readonly identity: string;
  // Idempotent keys and explicit claim tokens: automatic claims/Subagents use the same token to restore claims across replies.
  readonly idempotencyKey?: string;
  readonly taskId?: string;
  readonly claimToken?: string;
  readonly worktreeName?: string;
  // Short-lived claim association within the same assistant reply; WorktreeRuntime uses it to look up claim tokens.
  readonly executionScope?: object;
}

export interface ToolResult {
  // content feeds back to the model; failures must also carry a stable errorCode.
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

// Return immutable ToolResults on both success and failure; errors must carry stable error codes.
export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

export function toolError(errorCode: string, message: string): ToolResult {
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
  // Failed results must provide stable errorCodes to facilitate classified handling by model, Hook, and storage layers.
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}

// Deep-copies any tool result entering canonical history to prevent mutable objects inside handlers from polluting the session.
export function copyToolResult(result: ToolResult): ToolResult {
  if (!isToolResult(result)) {
    throw new Error("tool result must satisfy the ToolResult contract");
  }
  if (!result.isError) {
    return toolSuccess(result.content);
  }
  const errorCode = result.errorCode;
  if (errorCode === undefined) {
    throw new Error("error tool result requires an errorCode");
  }
  return Object.freeze({ content: result.content, isError: true, errorCode });
}

export interface ToolDefinition<Input> {
  // handler receives context parsed by provider without determining working directory or identity on its own.
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass;
  readonly concurrency?: ConcurrencyClass;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// StoredToolDefinition hides generic Input, placing schema validation uniformly at the invoke boundary.
export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  readonly concurrency: ConcurrencyClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  // Contains definition/arguments on success, and directly backfillable errors on failure.
  readonly call: ToolCall;
  readonly definition?: StoredToolDefinition;
  readonly arguments?: unknown;
  readonly error?: ToolResult;
}

export function freezePreparedToolCall(
  call: ToolCall,
  definition: StoredToolDefinition,
  argumentsValue: unknown,
): PreparedToolCall {
  // Rebuild frozen snapshot after hook rewrites so approval and execution always read identical arguments.
  return Object.freeze({
    call: toolCall(call.id, call.name, call.arguments),
    definition,
    arguments: freezeInput(structuredClone(argumentsValue)),
  });
}

// The Tool Registry stores frozen definitions, and establishes invocation boundaries by context and schema before dispatch.
export class ToolRegistry {
  readonly #definitions: Map<string, StoredToolDefinition>;
  readonly #mutable: boolean;

  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    // Copy Map to isolate caller modifications; snapshot forbids registration through mutable=false.
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  get names(): readonly string[] {
    // Return and freeze the name snapshot in registration order.
    return Object.freeze([...this.#definitions.keys()]);
  }

  register<Input>(definition: ToolDefinition<Input>): void {
    // Freeze definitions immediately at registration; runtime prepare() only parses, validates, and deep-copies inputs.
    if (!this.#mutable) {
      throw new Error("tool registry snapshot is immutable");
    }
    if (!/^[A-Za-z0-9_]+$/.test(definition.name)) {
      throw new Error(`invalid tool name: ${definition.name}`);
    }
    if (definition.description.trim().length === 0) {
      throw new Error("tool description must not be empty");
    }
    if (this.#definitions.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }

    const stored: StoredToolDefinition = Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      effect: definition.effect,
      concurrency: definition.concurrency === undefined ? "inline" : definition.concurrency,
      invoke: async (input: unknown, context: ToolContext) =>
        definition.handler(definition.inputSchema.parse(input), context),
    });
    this.#definitions.set(definition.name, stored);
  }

  snapshot(): ToolRegistry {
    // snapshot provides read-only tool views to boundaries like subagents, disallowing further tool registrations.
    return new ToolRegistry(this.#definitions, false);
  }

  subset(names: readonly string[]): ToolRegistry {
    // subset exposes only explicitly declared tools; teammate runtimes use it to restrict model callable capabilities.
    const definitions = new Map<string, StoredToolDefinition>();
    for (const name of names) {
      const definition = this.#definitions.get(name);
      if (definition === undefined) throw new Error(`tool does not exist: ${name}`);
      definitions.set(name, definition);
    }
    return new ToolRegistry(definitions);
  }

  openAITools(): readonly OpenAIToolSchema[] {
    // Model-side schema and runtime handler share the same source to avoid parallel definition drift.
    return Object.freeze(
      [...this.#definitions.values()].map((definition) => ({
        type: "function" as const,
        function: {
          name: definition.name,
          description: definition.description,
          parameters: z.toJSONSchema(definition.inputSchema) as Readonly<Record<string, unknown>>,
        },
      })),
    );
  }

  prepare(call: ToolCall): PreparedToolCall {
    // Arguments are untrusted input: parse JSON first, validate against schema, and freeze a complete call snapshot.
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
      // Convert tool faults into backfillable messages, allowing the loop to continue and let the model decide the next step.
      return { call, error: toolError("unknown_tool", `Unknown tool: ${call.name}`) };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments);
    } catch {
      return {
        call,
        definition,
        error: toolError("invalid_json", "Tool arguments must be valid JSON"),
      };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        call,
        definition,
        error: toolError("invalid_arguments", "Tool arguments must be a JSON object"),
      };
    }

    const parsed = definition.inputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        call,
        definition,
        error: toolError("invalid_arguments", "Tool arguments failed schema validation"),
      };
    }
    // Pre Hook can only rewrite explicitly via updatedInput; it cannot mutate trusted prepared results in place.
    return freezePreparedToolCall(call, definition, parsed.data);
  }

  async invoke(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    // Provider resolution occurs before AgentRunner calls invoke.
    if (prepared.error !== undefined) {
      return prepared.error;
    }
    if (prepared.definition === undefined || prepared.arguments === undefined) {
      throw new Error("prepared tool call is incomplete");
    }
    try {
      // handler exceptions normalize to tool_execution_error, preventing internal error text from entering model context directly.
      const result: unknown = await prepared.definition.invoke(prepared.arguments, context);
      if (!isToolResult(result)) {
        return toolError("invalid_tool_result", "Tool handler returned an invalid result");
      }
      return result;
    } catch {
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

function freezeInput<Input>(value: Input, seen: WeakSet<object> = new WeakSet()): Input {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    freezeInput(nested, seen);
  }
  return Object.freeze(value);
}

// handler return values also belong to untrusted boundaries, preventing malformed objects polluting session history.
export function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const content = Reflect.get(value, "content");
  const isError = Reflect.get(value, "isError");
  const errorCode = Reflect.get(value, "errorCode");
  if (typeof content !== "string" || typeof isError !== "boolean") {
    return false;
  }
  if (isError) {
    return typeof errorCode === "string" && errorCode.trim().length > 0;
  }
  return errorCode === undefined;
}
