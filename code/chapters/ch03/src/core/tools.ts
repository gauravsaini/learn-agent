import { z } from "zod";

import type { ToolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect is a semantic tag for permission policies to judge side effects, not an execution method.
export type EffectClass = "read" | "write" | "execute" | "external";

export interface ToolContext {
  // Workspace root that all file and command tools must use.
  readonly workspace: string;
  // Invocation subject used for permission policies and audit.
  readonly identity: string;
  // Optional deduplication association reserved for effect retries.
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
  // Successful results carry no error codes; isToolResult verifies success branches via absence of errorCode.
  return Object.freeze({ content, isError: false });
}

export function toolError(errorCode: string, message: string): ToolResult {
  // Error results must have stable error codes so the model and tests can determine failure categories without parsing text.
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
  // Validate the schema of model JSON parameters before execution.
  readonly inputSchema: z.ZodType<Input>;
  // Effect classifications used by permission policies.
  readonly effect: EffectClass;
  // Actual executor for validated inputs.
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  // invoke is the validated execution entry wrapped at registration; handler itself is not directly exposed to the loop.
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  // Raw model call with complete fields.
  readonly call: ToolCall;
  // Registered tool corresponding to success or parameter errors.
  readonly definition?: StoredToolDefinition;
  // Argument object that passed schema validation.
  readonly arguments?: unknown;
  // Results backfilled directly when model input fails.
  readonly error?: ToolResult;
}

export class ToolRegistry {
  // Store unique tool definitions by name.
  readonly #definitions: Map<string, StoredToolDefinition>;
  // false indicates an immutable registry snapshot during model requests.
  readonly #mutable: boolean;

  // Copy definition mappings to prevent external Maps from further modifying the current view.
  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  get names(): readonly string[] {
    // Expose only a frozen key name snapshot; callers cannot modify the internal registry through it.
    return Object.freeze([...this.#definitions.keys()]);
  }

  // Validate metadata and register tools, wrapping generic handlers into runtime entry points.
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
      // Re-parsing ensures that unvalidated input is not passed to handler even if callers bypass prepare.
      invoke: async (input, context) =>
        definition.handler(definition.inputSchema.parse(input), context),
    };
    this.#definitions.set(definition.name, stored);
  }

  // Copy into a non-writable snapshot so model-visible tools match the actual execution set of this turn.
  snapshot(): ToolRegistry {
    // Use immutable snapshots each turn to prevent registry tampering between model request and execution.
    return new ToolRegistry(this.#definitions, false);
  }

  // Generates model tool schema from registration definition to avoid parallel maintenance with handler.
  openAITools(): readonly OpenAIToolSchema[] {
    // Only serialize model-visible fields; keep handler, effect, and internal Maps outside model visibility.
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

  // Find tool, parse JSON, and validate schema; convert all model input errors into backfill results.
  prepare(call: ToolCall): PreparedToolCall {
    // Parsing and schema validation precede permission policies; policies always face trusted tool definitions and arguments.
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

  // Invoke prepared tools and normalize handler exceptions or invalid return values into ToolResult.
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
      // Convert tool faults into backfillable messages, allowing the loop to continue and let the model decide the next step.
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

function isToolResult(value: unknown): value is ToolResult {
  // handler return values also belong to untrusted boundaries, preventing malformed objects polluting session history.
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
