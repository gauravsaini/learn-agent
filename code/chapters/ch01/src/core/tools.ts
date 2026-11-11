import { z } from "zod";

import type { ToolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// The Tool Registry binds schemas, executors, and model descriptions to prevent parallel definitions from drifting.
//
// The Tool Registry (ToolRegistry) is the Agent's "hands"—all capabilities the model can call are registered here.
// It undertakes three responsibilities:
//   1. Save schema, description, and execution function for each tool
//   2. Convert tool definitions into OpenAIToolSchema that the model can understand
//   3. Handle argument parsing, validation, and execution uniformly in prepare/invoke phases
// This chapter only has one shell tool, but the registry design prepares for adding multiple tools in later chapters.
// Tool side-effect classifications; subsequent permission policies decide whether extra approval is needed based on this.
export type EffectClass = "read" | "write" | "execute" | "external";

// Controlled execution context injected by AgentRunner for each tool call; tools must not infer these boundaries themselves.
export interface ToolContext {
  // Controlled runtime information shared across calls; tools must not guess working directory or identity.
  // workspace is the safe root directory for command execution; identity identifies the current user.
  // AgentRunner creates these two fields during each run() and passes them to all tools.
  readonly workspace: string;
  readonly identity: string;
  // Optional deduplication key providing stable correlation for future retries with side effects without altering current tool semantics.
  readonly idempotencyKey?: string;
}

// Results backfilled uniformly to chat history after tool execution; errors also return as messages for the model to continue reasoning.
export interface ToolResult {
  // Backfill all successes and failures as tool messages with the same result shape, ensuring conversations can continue.
  // isError=false indicates success; isError=true must carry errorCode for model classification.
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

// Creates successful result without error code, keeping result shape consistent with failure paths.
export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

// Creates failure result with stable machine code; model reads text, and flow categorizes by errorCode.
export function toolError(errorCode: string, message: string): ToolResult {
  // Keep both machine-readable code and model-readable text; empty code breaks error classification.
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}

// Generic tool declaration before registration, binding input schema, metadata, and executor as a single source of truth.
export interface ToolDefinition<Input> {
  // Pre-registration definition: schema, metadata, and business handler must come from the same declaration.
  // The input schema is defined with Zod, and is parsed and validated during the prepare() phase.
  // effect marks the side-effect class; Chapter 3 uses permission policies to make approvals based on it.
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// Erased generic representation after registration; prepare validates inputs and the loop calls invoke uniformly.
export interface StoredToolDefinition {
  // Post-registration definitions erase generic inputs and retain a verified, unified invocation entry point.
  // Wrap handler into invoke at registration; afterward prepare handles validation and invoke handles execution.
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

// Two-state result of prepare: success carries validated arguments; failure carries a directly backfillable ToolResult.
export interface PreparedToolCall {
  // Discriminated result of prepare: contains definition/arguments on success; contains backfillable error on failure.
  // Return PreparedToolCall on both success and failure, ensuring AgentRunner always gets backfillable ToolResults.
  readonly call: ToolCall;
  readonly definition?: StoredToolDefinition;
  readonly arguments?: unknown;
  readonly error?: ToolResult;
}

// Single registry for tool definitions, model schemas, and executors, connecting declaration and invocation boundaries.
export class ToolRegistry {
  // Store registered tools by stable name. Make it private to prevent bypassing invariant checks of register.
  readonly #definitions: Map<string, StoredToolDefinition>;
  // Snapshot registry is false, preventing model-visible tool sets from changing during this turn's request.
  readonly #mutable: boolean;

  // Copy incoming mappings to construct independent views; mutable=false is used only for frozen snapshots of each call turn.
  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  // Returns a frozen copy of names for diagnostics or UI enumeration without exposing the internal Map.
  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  // Validate and register tools while wrapping generic handlers into unified entry points safely callable at runtime.
  register<Input>(definition: ToolDefinition<Input>): void {
    // The registration stage rejects duplicate names and illegal metadata to avoid inconsistency between model schema and executor.
    // Tool names must comply with OpenAI restrictions on function names (letters, numbers, underscores).
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
        definition.handler(definition.inputSchema.parse(input), context),
    };
    this.#definitions.set(definition.name, stored);
  }

  // Creates non-writable registry copy, matching tool set seen by model with the set actually executed in this turn.
  snapshot(): ToolRegistry {
    // Use immutable snapshots each request to keep model-visible toolsets consistent with actual dispatch toolsets.
    // If the registry is modified during this turn request, the snapshot guarantees what the model sees matches what actually executes.
    return new ToolRegistry(this.#definitions, false);
  }

  // Generates OpenAI tool schema from the same registration definition to avoid parallel maintenance of model descriptions and executors.
  openAITools(): readonly OpenAIToolSchema[] {
    // Generate JSON Schema from the same storage definition, avoiding maintaining an extra model tool list.
    // z.toJSONSchema converts a Zod schema into an OpenAI-compatible JSON Schema.
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

  // Find tool, parse JSON, and validate against schema; convert all failures into backfillable results rather than throwing to the loop.
  prepare(call: ToolCall): PreparedToolCall {
    // Parses and validates parameters first; returns backfillable structure on failure to maintain message pairing.
    // Unknown tools, invalid JSON, non-object arguments, or schema mismatches generate error results.
    // Error results are also backfilled via tool messages, allowing the model to adjust next steps.
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
    // Tool execution exceptions are converted into controlled results, and must not interrupt backfilling remaining calls of this turn.
    // Any exception thrown by handler is caught and converted to tool_execution_error,
    // Guarantees that failure in one tool does not break the entire message chain.
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

// Narrow unknown return values of extension handlers at runtime to prevent invalid objects from entering message history.
function isToolResult(value: unknown): value is ToolResult {
  // handler is an extension boundary; runtime re-validates its return value before safely writing to message history.
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
