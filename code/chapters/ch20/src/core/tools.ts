import { z } from "zod";

import type { ToolCall } from "./messages.js";
import { toolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect is the minimal source of truth for permission policies and tool list visibility, without guessing from tool names.
export type EffectClass = "read" | "write" | "execute" | "external";
// concurrency is the explicit contract for Dispatcher to decide if a tool can run in the background; defaults to inline.
export type ConcurrencyClass = "inline" | "background_eligible";

export interface ToolContext {
  readonly workspace: string;
  readonly identity: string;
  readonly idempotencyKey?: string;
  readonly taskId?: string;
  readonly claimToken?: string;
  readonly worktreeName?: string;
  readonly executionScope?: object;
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
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly inputSchemaJson?: Readonly<Record<string, unknown>>;
  readonly effect: EffectClass;
  readonly concurrency?: ConcurrencyClass;
  // source identifies builtin or mcp:... origins for permission policies and audits to evaluate tool boundaries.
  readonly source?: string;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// StoredToolDefinition hides generic Input, placing schema validation uniformly at the invoke boundary.
export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly inputSchemaJson?: Readonly<Record<string, unknown>>;
  readonly effect: EffectClass;
  readonly concurrency: ConcurrencyClass;
  readonly source: string;
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

// The Tool Registry stores frozen definitions, and establishes invocation boundaries by context and schema before dispatch;
// P19 supports dynamic tool lifecycles for MCP connections via batch registration/revocation and immutable snapshots.
export class ToolRegistry {
  readonly #definitions: Map<string, StoredToolDefinition>;
  readonly #sourceDefinitions: WeakMap<object, StoredToolDefinition>;
  readonly #mutable: boolean;
  // The version number increments only after a successful complete change; snapshot and live registry versions match, but do not share Maps.
  #version: number;

  constructor(
    definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(),
    mutable = true,
    version = 0,
  ) {
    this.#definitions = new Map(definitions);
    this.#sourceDefinitions = new WeakMap();
    this.#mutable = mutable;
    this.#version = version;
  }

  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  get version(): number {
    return this.#version;
  }

  // Single tool registration delegates to the batch entrypoint, maintaining consistent validation, freezing, and version increment behavior.
  register<Input>(definition: ToolDefinition<Input>): StoredToolDefinition {
    const registered = this.registerMany([definition]);
    const stored = registered[0];
    if (stored === undefined) {
      throw new Error("tool registry failed to register a definition");
    }
    return stored;
  }

  registerMany<Input>(
    definitions: readonly ToolDefinition<Input>[],
  ): readonly StoredToolDefinition[] {
    if (!this.#mutable) {
      throw new Error("tool registry snapshot is immutable");
    }
    if (definitions.length === 0) {
      return Object.freeze([]);
    }

    // Batch registration validates as a whole first; fail on any name conflict to avoid leaving half-connected MCP tool sets.
    const names = definitions.map((definition) => definition.name);
    if (new Set(names).size !== names.length) {
      throw new Error("tool registry batch contains duplicate names");
    }
    for (const definition of definitions) {
      validateDefinition(definition);
      if (this.#definitions.has(definition.name)) {
        throw new Error(`tool already registered: ${definition.name}`);
      }
    }

    const storedDefinitions = definitions.map((definition) => this.#storeDefinition(definition));
    for (const stored of storedDefinitions) {
      this.#definitions.set(stored.name, stored);
    }
    this.#version += 1;
    return Object.freeze(storedDefinitions);
  }

  unregisterMany(definitions: readonly StoredToolDefinition[]): void;
  unregisterMany<Input>(definitions: readonly ToolDefinition<Input>[]): void;
  unregisterMany(definitions: readonly unknown[]): void {
    if (!this.#mutable) {
      throw new Error("tool registry snapshot is immutable");
    }
    if (definitions.length === 0) {
      return;
    }

    // Match current registered items by object identity on revocation to prevent stale connections from deleting reconnected tools of the same name.
    const storedDefinitions = definitions.map((definition) => this.#storedDefinition(definition));
    const names = storedDefinitions.map((definition) => definition.name);
    if (new Set(names).size !== names.length) {
      throw new Error("tool registry unregister batch contains duplicate names");
    }
    for (const stored of storedDefinitions) {
      const current = this.#definitions.get(stored.name);
      if (current === undefined) {
        throw new Error(`tool is not registered: ${stored.name}`);
      }
      if (current !== stored) {
        throw new Error(`tool definition does not match registry: ${stored.name}`);
      }
    }
    for (const stored of storedDefinitions) {
      this.#definitions.delete(stored.name);
    }
    this.#version += 1;
  }

  // Uniformly generate frozen StoredToolDefinition; source defaults to builtin, while MCP tools explicitly mark origin.
  #storeDefinition<Input>(definition: ToolDefinition<Input>): StoredToolDefinition {
    const source = definition.source === undefined ? "builtin" : definition.source;
    const stored: StoredToolDefinition = Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...(definition.inputSchemaJson === undefined
        ? {}
        : { inputSchemaJson: definition.inputSchemaJson }),
      effect: definition.effect,
      concurrency: definition.concurrency === undefined ? "inline" : definition.concurrency,
      source,
      invoke: async (input: unknown, context: ToolContext) =>
        definition.handler(definition.inputSchema.parse(input), context),
    });
    this.#sourceDefinitions.set(definition, stored);
    return stored;
  }

  // The revocation credential can be StoredToolDefinition or an original ToolDefinition published by this registry.
  #storedDefinition(value: unknown): StoredToolDefinition {
    if (isStoredToolDefinition(value)) {
      return value;
    }
    if (typeof value !== "object" || value === null) {
      throw new TypeError("tool registry definitions must be tool definitions");
    }
    const stored = this.#sourceDefinitions.get(value);
    if (stored === undefined) {
      throw new Error("tool definition was not registered by this registry");
    }
    return stored;
  }

  snapshot(): ToolRegistry {
    // Returns an immutable snapshot so executing turns are not affected by subsequent MCP connect or disconnect operations.
    return new ToolRegistry(this.#definitions, false, this.#version);
  }

  subset(names: readonly string[]): ToolRegistry {
    // subset exposes only explicitly declared tools; teammate runtimes use it to restrict model callable capabilities.
    const definitions = new Map<string, StoredToolDefinition>();
    for (const name of names) {
      const definition = this.#definitions.get(name);
      if (definition === undefined) throw new Error(`tool does not exist: ${name}`);
      definitions.set(name, definition);
    }
    return new ToolRegistry(definitions, true, this.#version);
  }

  openAITools(): readonly OpenAIToolSchema[] {
    // Model-side schema and runtime handler share the same source to avoid parallel definition drift.
    return Object.freeze(
      [...this.#definitions.values()].map((definition) => ({
        type: "function" as const,
        function: {
          name: definition.name,
          description: definition.description,
          parameters:
            definition.inputSchemaJson ??
            (z.toJSONSchema(definition.inputSchema) as Readonly<Record<string, unknown>>),
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

// Validate tool names, descriptions, and sources at registration boundaries, avoiding illegal names or blank descriptions in model schemas.
function validateDefinition<Input>(definition: ToolDefinition<Input>): void {
  if (!/^[A-Za-z0-9_]+$/.test(definition.name)) {
    throw new Error(`invalid tool name: ${definition.name}`);
  }
  if (definition.description.trim().length === 0) {
    throw new Error("tool description must not be empty");
  }
  if (definition.source !== undefined && definition.source.trim().length === 0) {
    throw new Error("tool source must not be empty");
  }
}

function isStoredToolDefinition(value: unknown): value is StoredToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "invoke") === "function" &&
    typeof Reflect.get(value, "source") === "string"
  );
}

// Deep freeze tool arguments to prevent handlers or subsequent hooks from modifying shared objects.
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
