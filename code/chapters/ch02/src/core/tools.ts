/**
 * Tool Registry module: binds tool name, description, Zod schema, effect class, and handler into a single closure.
 * The Agent Loop invokes tools through prepare → invoke. It does not switch on tool names in the loop.
 * prepare encapsulates all model input errors (unknown tool, bad JSON, invalid arguments) into ToolResult,
 * Invalid arguments fail before execution. snapshot returns an immutable copy so tool definitions do not change mid-turn.
 * openAITools exports stably in registration order to match KV Cache prefix stability constraints.
 */
import { z } from "zod";

import type { ToolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// The Tool Registry binds schemas, model descriptions, and executors to avoid drift across three definitions.
export type EffectClass = "read" | "write" | "execute" | "external";

export interface ToolContext {
  // identity and idempotency key are reserved for future policy layers; P02 executor only uses workspace.
  readonly workspace: string;
  // Caller principal identity, providing stable input for subsequent permission policies.
  readonly identity: string;
  // Optional deduplication key to preserve correlation for retries with side effects.
  readonly idempotencyKey?: string;
}

export interface ToolResult {
  // Successful output or error body readable by the model.
  readonly content: string;
  // Whether the result is an error, determining constraints on errorCode.
  readonly isError: boolean;
  // Machine-readable stable code that must exist on error.
  readonly errorCode?: string;
}

export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

// Error results are still backfilled as tool messages, allowing the model to adapt autonomously based on stable error codes.
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

export interface ToolDefinition<Input> {
  // The stable tool name provided to the model and registry.
  readonly name: string;
  // Usage instructions for the model.
  readonly description: string;
  // Validate the Zod schema of model JSON parameters before execution.
  readonly inputSchema: z.ZodType<Input>;
  // Effect classifications used by permission policies.
  readonly effect: EffectClass;
  // Actual executor for validated inputs, returning uniform results synchronously or asynchronously.
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// Internal definition erasing generic inputs after registration, uniformly invoked by invoke.
export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  // prepare does not throw model input errors; it saves errors that can be safely backfilled.
  readonly call: ToolCall;
  // Registered tool corresponding to success or identified parameter errors.
  readonly definition?: StoredToolDefinition;
  // Argument object that passed schema validation; execution is allowed only when present.
  readonly arguments?: unknown;
  // Results backfilled directly when model input fails.
  readonly error?: ToolResult;
}

export class ToolRegistry {
  // Store unique tool definitions by name.
  readonly #definitions: Map<string, StoredToolDefinition>;
  // false indicates an unwriteable snapshot used for each model request turn.
  readonly #mutable: boolean;

  // Copy definition mappings to prevent external Maps from further modifying the current registry.
  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  // Returns a frozen name list for diagnostics without exposing the internal Map.
  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  // Validate metadata and register tools, wrapping generic handlers into unified runtime entry points.
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

    const stored: StoredToolDefinition = {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      effect: definition.effect,
      invoke: async (input, context) =>
        // Re-parsing guarantees that internal calls bypassing prepare cannot circumvent the schema.
        definition.handler(definition.inputSchema.parse(input), context),
    };
    this.#definitions.set(definition.name, stored);
  }

  // Creates non-writable copy, matching model-visible tool set with the set actually executed in this turn.
  snapshot(): ToolRegistry {
    // Model requests use immutable snapshots, ensuring this turn's toolset does not change mid-call.
    return new ToolRegistry(this.#definitions, false);
  }

  // Stably generates OpenAI JSON Schema from registration definition to avoid parallel maintenance with handler.
  openAITools(): readonly OpenAIToolSchema[] {
    // Generate JSON Schema on every export, keeping model descriptions and actual validators from the same source.
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

  // Find tool, parse JSON, and validate schema; convert errors into backfillable results instead of throwing.
  prepare(call: ToolCall): PreparedToolCall {
    // Argument errors are also packaged as results so the Agent Loop can backfill corresponding tool messages.
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
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
    return { call, definition, arguments: parsed.data };
  }

  // Execute prepared calls and normalize handler exceptions or invalid return values to ToolResults.
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
      // Executor exceptions must not break message pairing protocols; degrade uniformly to backfillable error results.
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

// Narrow the return value of extension handlers at runtime to block invalid objects from entering message history.
function isToolResult(value: unknown): value is ToolResult {
  // Executors are extension boundaries; verify return shapes at runtime before writing to conversation history.
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
