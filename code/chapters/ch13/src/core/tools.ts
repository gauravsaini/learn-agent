import { z } from "zod";

import type { ToolCall } from "./messages.js";
import { toolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect is the minimal source of truth for permission policies and tool list visibility, without guessing from tool names.
export type EffectClass = "read" | "write" | "execute" | "external";
// concurrency is the explicit contract for Dispatcher to decide if a tool can run in the background; defaults to inline.
export type ConcurrencyClass = "inline" | "background_eligible";

export interface ToolContext {
  // Root boundary for all file and command side effects.
  readonly workspace: string;
  // Current invocation subject, used for task owner and audit attribution.
  readonly identity: string;
  // Optional idempotency key for async or external execution boundaries to eliminate duplicate submissions.
  readonly idempotencyKey?: string;
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

// Return immutable ToolResults on both success and failure; errors must carry stable error codes.
export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

// Failed results must provide stable errorCodes to facilitate classified handling by model, Hook, and storage layers.
export function toolError(errorCode: string, message: string): ToolResult {
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
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
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass;
  // Declare whether tools can execute only synchronously or Dispatcher can convert them to background jobs.
  readonly concurrency?: ConcurrencyClass;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// StoredToolDefinition hides generic Input, placing schema validation uniformly at the invoke boundary.
export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  // Normalize default values to inline at registration; runtime no longer infers concurrency semantics.
  readonly concurrency: ConcurrencyClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
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
  return Object.freeze({
    call: toolCall(call.id, call.name, call.arguments),
    definition,
    arguments: freezeInput(structuredClone(argumentsValue)),
  });
}

export class ToolRegistry {
  readonly #definitions: Map<string, StoredToolDefinition>;
  readonly #mutable: boolean;

  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  // Freeze definitions immediately at registration; runtime prepare() only parses, validates, and deep-copies inputs.
  register<Input>(definition: ToolDefinition<Input>): void {
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
      // Undeclared tools execute synchronously to prevent silent diffusion of background capabilities.
      concurrency: definition.concurrency === undefined ? "inline" : definition.concurrency,
      invoke: async (input: unknown, context: ToolContext) =>
        definition.handler(definition.inputSchema.parse(input), context),
    });
    this.#definitions.set(definition.name, stored);
  }

  // snapshot provides read-only tool views to boundaries like subagents, disallowing further tool registrations.
  snapshot(): ToolRegistry {
    return new ToolRegistry(this.#definitions, false);
  }

  // Model-side schema and runtime handler share the same source to avoid parallel definition drift.
  openAITools(): readonly OpenAIToolSchema[] {
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

  // Arguments are untrusted input: parse JSON first, validate against schema, and freeze a complete call snapshot.
  prepare(call: ToolCall): PreparedToolCall {
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
      return { call, error: toolError("unknown_tool", `Unknown tool: ${call.name}`) };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments);
    } catch {
      // Convert tool faults into backfillable messages, allowing the loop to continue and let the model decide the next step.
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

  // handler exceptions normalize to tool_execution_error, preventing internal error text from entering model context directly.
  async invoke(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    if (prepared.error !== undefined) {
      return prepared.error;
    }
    if (prepared.definition === undefined || prepared.arguments === undefined) {
      throw new Error("prepared tool call is incomplete");
    }
    try {
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
