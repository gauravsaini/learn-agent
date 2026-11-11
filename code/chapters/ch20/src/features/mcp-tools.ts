// MCP tool domain and runtime: validates local allowlist, publishes remote tools dynamically, and revokes registrations atomically on disconnect.
import { z } from "zod";

import type { ToolCall } from "../core/messages.js";
import type {
  StoredToolDefinition,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const REMOTE_NAME_PATTERN = /[^a-z0-9_]+/g;
const REPEATED_UNDERSCORE_PATTERN = /_+/g;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export class McpContractError extends Error {
  // Local configuration, remote declarations, or JSON payloads violate MCP integration contracts.
  override readonly name: string = "McpContractError";
}

export class McpTransportError extends Error {
  // stdio connection, initialization, or request transport failure; excludes business errors returned actively by remote tools.
  override readonly name: string = "McpTransportError";
}

export class McpTimeoutError extends McpTransportError {
  // Mark timeouts separately so the runtime can return stable error codes and revoke failed connections.
  override readonly name: string = "McpTimeoutError";
}

export interface McpSchemaValidator {
  // Compile remote JSON Schema into synchronous predicates before publishing tools to avoid recompiling during calls.
  compile(
    exposedName: string,
    inputSchema: Readonly<Record<string, unknown>>,
  ): (value: unknown) => boolean;
}

export interface McpToolPolicyOptions {
  // remoteName must match the original name in tools/list exactly; local configuration alone determines effect.
  readonly remoteName: string;
  readonly effect: "read" | "write" | "execute" | "external";
}

// Local policy is the single source of truth for remote tool effects; remote servers implement capabilities and do not decide permissions.
export class McpToolPolicy {
  readonly remoteName: string;
  readonly effect: McpToolPolicyOptions["effect"];

  constructor(options: McpToolPolicyOptions) {
    // Frozen policy objects can be safely reused across multiple server specs; remote overrides of effects are not allowed.
    if (typeof options.remoteName !== "string" || options.remoteName.trim().length === 0) {
      throw new McpContractError("MCP tool policy remoteName must not be empty");
    }
    if (options.remoteName !== options.remoteName.trim()) {
      throw new McpContractError("MCP tool policy remoteName must not have surrounding whitespace");
    }
    if (!isEffect(options.effect)) {
      throw new McpContractError("MCP tool policy effect is invalid");
    }
    this.remoteName = options.remoteName;
    this.effect = options.effect;
    Object.freeze(this);
  }
}

export interface McpServerSpecOptions {
  // The alias enters the tool name visible to the model; command/args/cwd are passed only to the stdio adapter to spawn child processes.
  readonly alias: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly toolPolicies: readonly McpToolPolicy[];
  readonly startupTimeoutSeconds: number;
  readonly toolTimeoutSeconds: number;
  readonly cwd?: string;
}

// A local allowlist: only remote tools with an explicitly declared alias and policy can enter the registry.
export class McpServerSpec {
  readonly alias: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly toolPolicies: readonly McpToolPolicy[];
  readonly startupTimeoutSeconds: number;
  readonly toolTimeoutSeconds: number;
  readonly cwd: string | undefined;

  constructor(options: McpServerSpecOptions) {
    // Construction validates aliases, launch arguments, policy uniqueness, and timeouts; connection consumes only trusted snapshots.
    if (typeof options.alias !== "string" || !ALIAS_PATTERN.test(options.alias)) {
      throw new McpContractError("MCP server alias must match ^[a-z][a-z0-9_]{0,31}$");
    }
    if (typeof options.command !== "string" || options.command.trim().length === 0) {
      throw new McpContractError("MCP server command must not be empty");
    }
    if (
      !Array.isArray(options.args) ||
      !options.args.every((argument) => typeof argument === "string")
    ) {
      throw new McpContractError("MCP server args must contain strings");
    }
    if (
      !Array.isArray(options.toolPolicies) ||
      !options.toolPolicies.every((policy) => policy instanceof McpToolPolicy)
    ) {
      throw new McpContractError("MCP toolPolicies must contain McpToolPolicy values");
    }
    const policyNames = options.toolPolicies.map((policy) => policy.remoteName);
    if (new Set(policyNames).size !== policyNames.length) {
      throw new McpContractError("MCP tool policies must not contain duplicate remote names");
    }
    for (const [name, value] of [
      ["startupTimeoutSeconds", options.startupTimeoutSeconds],
      ["toolTimeoutSeconds", options.toolTimeoutSeconds],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new McpContractError(`${name} must be a finite positive number`);
      }
    }
    if (
      options.cwd !== undefined &&
      (typeof options.cwd !== "string" || options.cwd.length === 0)
    ) {
      throw new McpContractError("MCP server cwd must be a non-empty string or undefined");
    }
    this.alias = options.alias;
    this.command = options.command;
    this.args = Object.freeze([...options.args]);
    this.toolPolicies = Object.freeze([...options.toolPolicies]);
    this.startupTimeoutSeconds = options.startupTimeoutSeconds;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.cwd = options.cwd;
    Object.freeze(this);
  }
}

export interface McpPublishedToolOptions {
  // This is the boundary object of remote tools/list, without local effect or exposed name attached yet.
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

// Declarations returned by remote tools/list; clones and freezes before publishing to prevent external objects from being modified later.
export class McpPublishedTool {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>>;

  constructor(options: McpPublishedToolOptions) {
    // Deep clone and freeze schema to prevent MCP SDK or test doubles mutating definitions after publication.
    if (typeof options.name !== "string" || options.name.trim().length === 0) {
      throw new McpContractError("Published MCP tool name must not be empty");
    }
    if (options.name !== options.name.trim()) {
      throw new McpContractError("Published MCP tool name must not have surrounding whitespace");
    }
    if (options.description !== undefined && typeof options.description !== "string") {
      throw new McpContractError("Published MCP tool description must be a string or undefined");
    }
    if (!isRecord(options.inputSchema)) {
      throw new McpContractError("Published MCP tool input schema must be an object");
    }
    this.name = options.name;
    this.description = options.description;
    this.inputSchema = freezeJsonObject(cloneJson(options.inputSchema));
    Object.freeze(this);
  }
}

export interface McpCallResultOptions {
  // content preserves protocol blocks, structuredContent defaults to null, and isError indicates remote business failure.
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly structuredContent: Readonly<Record<string, unknown>> | null;
  readonly isError: boolean;
}

export class McpCallResult {
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly structuredContent: Readonly<Record<string, unknown>> | null;
  readonly isError: boolean;

  constructor(options: McpCallResultOptions) {
    // Remote results complete shape validation and deep freezing before entering the Agent tool boundary.
    if (!Array.isArray(options.content) || !options.content.every((block) => isRecord(block))) {
      throw new McpContractError("MCP call content must contain objects");
    }
    if (options.structuredContent !== null && !isRecord(options.structuredContent)) {
      throw new McpContractError("MCP structured content must be an object or null");
    }
    if (typeof options.isError !== "boolean") {
      throw new McpContractError("MCP call isError must be boolean");
    }
    this.content = Object.freeze(
      options.content.map((block) => freezeJsonObject(cloneJson(block))),
    );
    this.structuredContent =
      options.structuredContent === null
        ? null
        : freezeJsonObject(cloneJson(options.structuredContent));
    this.isError = options.isError;
    Object.freeze(this);
  }
}

export interface McpConnection {
  // The connection abstraction exposes only tools/list, tools/call, final state notification, and close, without leaking specific SDK clients.
  listTools(options?: { readonly signal?: AbortSignal }): Promise<readonly McpPublishedTool[]>;
  callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    options: { readonly timeoutSeconds: number; readonly signal?: AbortSignal },
  ): Promise<McpCallResult>;
  waitForFailure(): Promise<void>;
  close(): Promise<void>;
}

export interface McpConnectionFactory {
  // The factory returns connections only after initialize succeeds; adapters handle cleaning up failed connections.
  open(spec: McpServerSpec, signal?: AbortSignal): Promise<McpConnection>;
}

interface ConnectionState {
  // spec, connection, and their registered definitions must transition as a single alias-level state unit.
  readonly spec: McpServerSpec;
  readonly connection: McpConnection;
  readonly definitions: readonly StoredToolDefinition[];
}

class PublishFailure extends Error {
  // Carry only stable code/message exposed to the model, excluding remote schema or process details.
  readonly code: string;
  readonly publicMessage: string;

  constructor(code: string, publicMessage: string) {
    // Internal exceptions and tool errors share the same public message, preventing accidental leaks during boundary conversion.
    super(publicMessage);
    this.name = "PublishFailure";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

// Connection state changes are serialized: connect, disconnect, and close do not overwrite each other during concurrent calls.
class AsyncMutex {
  // Promise tail chain serializes state operations; network shutdown executes outside locks to prevent long I/O from blocking critical sections.
  #tail: Promise<void> = Promise.resolve();

  async run<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
    // Each call waits for the previous gate and finally releases its own gate so failure does not block subsequent operations.
    const previous = this.#tail;
    const gate = createReleaseGate();
    this.#tail = gate.promise;
    await previous;
    try {
      return await operation();
    } finally {
      gate.release();
    }
  }
}

function createReleaseGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  // Save Promise resolve as an explicit release for mutex tail chains to advance in finally.
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (release === undefined) throw new Error("MCP mutex release was not initialized");
  return { promise, release };
}

const aliasInputSchema = z.strictObject({
  alias: z.string().min(1).max(32).regex(ALIAS_PATTERN),
});

// MCP runtime publishes remote capabilities as policy-constrained local tools and centrally manages connection lifecycles.
export class McpRuntime {
  // servers is the startup allowlist; connections holds only active connections that finished "discovery + registration".
  readonly #servers: ReadonlyMap<string, McpServerSpec>;
  readonly #connectionFactory: McpConnectionFactory;
  readonly #schemaValidator: McpSchemaValidator;
  readonly #connections = new Map<string, ConnectionState>();
  // Objects revoked from registry whose connection.close() has not yet succeeded; fallback retry when Runner closes in reverse order.
  readonly #pendingCloses: McpConnection[] = [];
  readonly #lock = new AsyncMutex();
  readonly #leadToolDefinitions: readonly [
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
  ];
  #registry: ToolRegistry | undefined;
  #closeRequested = false;
  #closed = false;

  constructor(options: {
    readonly servers: readonly McpServerSpec[];
    readonly connectionFactory: McpConnectionFactory;
    readonly schemaValidator: McpSchemaValidator;
  }) {
    // Establish only static server/spec and management tools at construction; dynamic remote tools must await install + connect.
    if (!Array.isArray(options.servers) || options.servers.length === 0) {
      throw new McpContractError("MCP runtime requires at least one server spec");
    }
    if (!options.servers.every((server) => server instanceof McpServerSpec)) {
      throw new McpContractError("MCP runtime servers must contain McpServerSpec values");
    }
    const aliases = options.servers.map((server) => server.alias);
    if (new Set(aliases).size !== aliases.length) {
      throw new McpContractError("MCP runtime server aliases must be unique");
    }
    if (typeof options.connectionFactory?.open !== "function") {
      throw new TypeError("connectionFactory must implement McpConnectionFactory");
    }
    if (typeof options.schemaValidator?.compile !== "function") {
      throw new TypeError("schemaValidator must implement McpSchemaValidator");
    }
    this.#servers = new Map(options.servers.map((server) => [server.alias, server]));
    this.#connectionFactory = options.connectionFactory;
    this.#schemaValidator = options.schemaValidator;
    const connect = async (input: z.infer<typeof aliasInputSchema>): Promise<ToolResult> =>
      await this.#connect(input.alias);
    const disconnect = async (input: z.infer<typeof aliasInputSchema>): Promise<ToolResult> =>
      await this.#disconnect(input.alias);
    this.#leadToolDefinitions = Object.freeze([
      {
        name: "connect_mcp",
        description: "Connect one locally allowlisted MCP server alias.",
        inputSchema: aliasInputSchema,
        effect: "external",
        source: "mcp:management",
        handler: connect,
      },
      {
        name: "disconnect_mcp",
        description: "Disconnect one MCP server alias and withdraw its tools.",
        inputSchema: aliasInputSchema,
        effect: "external",
        source: "mcp:management",
        handler: disconnect,
      },
    ]);
  }

  get connectedAliases(): readonly string[] {
    // Returns a snapshot of current active connections; callers cannot modify the internal Map.
    return Object.freeze([...this.#connections.keys()]);
  }

  get serverAliases(): readonly string[] {
    // Returns all aliases permitted to connect locally; this does not mean these servers are connected.
    return Object.freeze([...this.#servers.keys()]);
  }

  get isClosed(): boolean {
    // True only after all connections close successfully; closeRequested blocks new connections earlier.
    return this.#closed;
  }

  get leadToolDefinitions(): readonly [
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
  ] {
    // Only Lead handles connect/disconnect; remote tools dynamically join the same registry after connecting successfully.
    return this.#leadToolDefinitions;
  }

  install(registry: ToolRegistry): void {
    // The runtime binds one-to-one with a mutable registry. Repeated installation breaks object identity revocation semantics of definitions.
    if (this.#registry !== undefined) {
      throw new McpContractError("MCP runtime is already installed");
    }
    if (this.#closeRequested || this.#closed) {
      throw new McpContractError("MCP runtime cannot be installed after close");
    }
    // Install connection management tools only in the Lead registry; publish remote tools dynamically after connect succeeds.
    registry.registerMany(this.#leadToolDefinitions);
    this.#registry = registry;
  }

  async close(): Promise<void> {
    // Shutdown revokes all model-visible tools inside lock first, then reclaims stdio resources in reverse connection order;
    // Connections that fail to close remain in pendingCloses, allowing upper layers to call close again to retry.
    const connections = await this.#lock.run(async () => {
      if (this.#closed) return [] as McpConnection[];
      this.#closeRequested = true;
      const states = [...this.#connections.values()].reverse();
      const definitions = states.flatMap((state) => [...state.definitions]);
      if (definitions.length > 0) this.#requireRegistry().unregisterMany(definitions);
      this.#connections.clear();
      const result = states.map((state) => state.connection);
      result.push(...this.#pendingCloses.splice(0));
      return result;
    });
    // Revokes definitions first, then closes connection outside lock to avoid long I/O blocking subsequent state operations.
    const failures: unknown[] = [];
    for (const connection of connections) {
      try {
        await connection.close();
      } catch (error) {
        failures.push(error);
        this.#rememberPendingClose(connection);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "MCP runtime close failed");
    this.#closed = true;
  }

  async #connect(alias: string): Promise<ToolResult> {
    // Alias-level connection is a transactional publication: open, tools/list, policy/schema validation, and batch registration
    // Writes to #connections only after total success; any failure attempts to close temporary connections.
    return await this.#lock.run(async () => {
      if (this.#closeRequested || this.#closed) {
        return toolError("mcp_runtime_closed", "MCP runtime is closing or closed");
      }
      const spec = this.#servers.get(alias);
      if (spec === undefined) {
        return toolError("unknown_mcp_server", `Unknown MCP server alias: ${alias}`);
      }
      if (this.#connections.has(alias)) {
        return toolError(
          "mcp_already_connected",
          `MCP server alias is already connected: ${alias}`,
        );
      }

      // Transactional publishing: records connection state only after discovery and registration succeed; any failure closes the connection.
      let connection: McpConnection;
      try {
        connection = await this.#connectionFactory.open(spec);
      } catch (error) {
        return this.#connectionError(alias, error, "connect");
      }
      let published: readonly McpPublishedTool[];
      try {
        published = await connection.listTools();
      } catch (error) {
        await this.#closeFailedConnection(connection);
        return this.#connectionError(alias, error, "tool discovery");
      }

      let definitions: readonly StoredToolDefinition[];
      try {
        const candidates = this.#publishDefinitions(spec, published);
        definitions = this.#requireRegistry().registerMany(candidates);
      } catch (error) {
        const cleanupOk = await this.#closeFailedConnection(connection);
        if (!cleanupOk) {
          return toolError(
            "mcp_cleanup_failed",
            `MCP connection validation failed and cleanup is pending: ${alias}`,
          );
        }
        if (error instanceof PublishFailure) {
          return toolError(error.code, error.publicMessage);
        }
        return toolError(
          "mcp_name_collision",
          `MCP exposed tool name collides with the local registry: ${alias}`,
        );
      }
      const state = { spec, connection, definitions };
      this.#connections.set(alias, state);
      // Connection state and definitions are visible simultaneously; subsequent transport failures are revoked uniformly by Watchdog.
      void this.#watchConnection(alias, state);
      return toolSuccess(
        jsonText({
          server_alias: alias,
          status: "connected",
          tools: definitions.map((definition) => definition.name),
        }),
      );
    });
  }

  async #disconnect(alias: string): Promise<ToolResult> {
    // Disconnect removes state and definitions inside the lock, then closes transport outside the lock. This ensures the model loses capability immediately.
    const state = await this.#lock.run(async () => {
      if (this.#closeRequested || this.#closed) return undefined;
      if (!this.#servers.has(alias)) return null;
      const current = this.#connections.get(alias);
      if (current === undefined) return false;
      this.#connections.delete(alias);
      this.#requireRegistry().unregisterMany(current.definitions);
      return current;
    });
    if (state === undefined)
      return toolError("mcp_runtime_closed", "MCP runtime is closing or closed");
    if (state === null)
      return toolError("unknown_mcp_server", `Unknown MCP server alias: ${alias}`);
    if (state === false) {
      return toolError("mcp_not_connected", `MCP server alias is not connected: ${alias}`);
    }
    // Revokes definitions before closing connection; even if close fails, model cannot see disconnected remote tools.
    try {
      await state.connection.close();
    } catch {
      this.#rememberPendingClose(state.connection);
      return toolError(
        "mcp_disconnect_failed",
        `MCP tools were withdrawn but connection cleanup is pending: ${alias}`,
      );
    }
    return toolSuccess(
      jsonText({
        server_alias: alias,
        status: "disconnected",
        tools: state.definitions.map((definition) => definition.name),
      }),
    );
  }

  #publishDefinitions(
    spec: McpServerSpec,
    published: readonly McpPublishedTool[],
  ): readonly ToolDefinition<Record<string, unknown>>[] {
    // Match remote declarations against local policies with exact sets, then generate local definitions with alias, effect, schema, and source.
    // Published set must match policy exactly; undeclared and redundant tools are rejected from publishing.
    if (!Array.isArray(published) || !published.every((tool) => tool instanceof McpPublishedTool)) {
      throw new PublishFailure(
        "mcp_invalid_tool_list",
        `MCP server returned an invalid tool list: ${spec.alias}`,
      );
    }
    const policies = new Map(spec.toolPolicies.map((policy) => [policy.remoteName, policy]));
    const publishedNames = published.map((tool) => tool.name);
    if (new Set(publishedNames).size !== publishedNames.length) {
      throw new PublishFailure(
        "mcp_name_collision",
        `MCP server published duplicate tool names: ${spec.alias}`,
      );
    }
    if (
      publishedNames.length !== policies.size ||
      publishedNames.some((name) => !policies.has(name))
    ) {
      throw new PublishFailure(
        "mcp_policy_mismatch",
        `MCP published tools do not exactly match local policy: ${spec.alias}`,
      );
    }
    const exposedNames = new Set<string>();
    const definitions: ToolDefinition<Record<string, unknown>>[] = [];
    for (const tool of published) {
      const exposedName = exposedToolName(spec.alias, tool.name);
      if (exposedNames.has(exposedName)) {
        throw new PublishFailure(
          "mcp_name_collision",
          `MCP tool names collide after normalization: ${spec.alias}`,
        );
      }
      exposedNames.add(exposedName);
      const policy = policies.get(tool.name);
      if (policy === undefined) throw new Error("MCP policy lookup lost a published tool");
      let validator: (value: unknown) => boolean;
      try {
        validator = this.#schemaValidator.compile(exposedName, tool.inputSchema);
      } catch {
        throw new PublishFailure(
          "mcp_invalid_schema",
          `MCP tool input schema is invalid: ${exposedName}`,
        );
      }
      const inputSchema = z.custom<Record<string, unknown>>((value) => validator(value), {
        message: "Arguments failed MCP JSON Schema validation",
      });
      const definition: ToolDefinition<Record<string, unknown>> = {
        name: exposedName,
        description: validatedDescription(spec.alias, tool),
        inputSchema,
        inputSchemaJson: tool.inputSchema,
        effect: policy.effect,
        source: `mcp:${spec.alias}:${tool.name}`,
        handler: async (_input, _context) =>
          await this.#invokeRemote(spec.alias, tool.name, _input),
      };
      definitions.push(definition);
    }
    return definitions;
  }

  async #watchConnection(alias: string, state: ConnectionState): Promise<void> {
    // Connection-level Watchdog: Revokes dynamic tools of the alias after transport termination to prevent invalid tools from remaining exposed.
    await state.connection.waitForFailure();
    await this.#dropFailedConnection(alias, state);
  }

  async #invokeRemote(
    alias: string,
    remoteName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<ToolResult> {
    // Read current alias state first on each call; timeout or transport errors revoke the entire connection, while remote isError only affects this result.
    const state = await this.#lock.run(() => this.#connections.get(alias));
    if (state === undefined) {
      return remoteError(
        alias,
        remoteName,
        "mcp_not_connected",
        "MCP server is no longer connected",
      );
    }
    // Treat timeouts or transport failures as connection loss; business isError returns fixed redacted results without leaking server details.
    let result: McpCallResult;
    try {
      result = await state.connection.callTool(remoteName, argumentsValue, {
        timeoutSeconds: state.spec.toolTimeoutSeconds,
      });
    } catch (error) {
      if (error instanceof McpTimeoutError) {
        await this.#dropFailedConnection(alias, state);
        return remoteError(alias, remoteName, "mcp_timeout", "MCP tool call exceeded its timeout");
      }
      if (error instanceof McpTransportError) {
        await this.#dropFailedConnection(alias, state);
        return remoteError(
          alias,
          remoteName,
          "mcp_connection_lost",
          "MCP connection was lost during the tool call",
        );
      }
      throw error;
    }
    if (result.isError) {
      return remoteError(alias, remoteName, "mcp_remote_error", "MCP server reported a tool error");
    }
    return toolSuccess(
      jsonText({
        content: result.content,
        server_alias: alias,
        status: "ok",
        structured_content: result.structuredContent,
        tool: remoteName,
      }),
    );
  }

  async #dropFailedConnection(alias: string, state: ConnectionState): Promise<void> {
    // Checks object identity first to prevent old connection state from accidentally deleting new definitions after reconnect.
    const current = await this.#lock.run(async () => {
      const existing = this.#connections.get(alias);
      if (existing !== state) return undefined;
      this.#requireRegistry().unregisterMany(state.definitions);
      this.#connections.delete(alias);
      return state;
    });
    if (current === undefined) return;
    try {
      await current.connection.close();
    } catch {
      this.#rememberPendingClose(current.connection);
    }
  }

  async #closeFailedConnection(connection: McpConnection): Promise<boolean> {
    // Cleanup helper when the connection is not yet published; failed objects enter pendingCloses and are reclaimed again by unified close.
    try {
      await connection.close();
      return true;
    } catch {
      this.#rememberPendingClose(connection);
      return false;
    }
  }

  #rememberPendingClose(connection: McpConnection): void {
    // Deduplicate by object identity to prevent adding the same connection to the close queue multiple times.
    if (!this.#pendingCloses.some((existing) => existing === connection)) {
      this.#pendingCloses.push(connection);
    }
  }

  #requireRegistry(): ToolRegistry {
    // All dynamic registrations/revocations require install first; missing registries are composition root contract errors.
    if (this.#registry === undefined) {
      throw new McpContractError("MCP runtime is not installed in a registry");
    }
    return this.#registry;
  }

  #connectionError(alias: string, error: unknown, operation: string): ToolResult {
    // Convert only known MCP boundary errors; rethrow unknown exceptions to avoid masking programming errors.
    if (error instanceof McpTimeoutError) {
      return toolError("mcp_connect_timeout", `MCP server ${operation} timed out: ${alias}`);
    }
    if (error instanceof McpTransportError || error instanceof McpContractError) {
      return toolError("mcp_connection_failed", `MCP server ${operation} failed: ${alias}`);
    }
    throw error;
  }
}

function exposedToolName(alias: string, remoteName: string): string {
  // Local names normalize to mcp__alias__normalized to isolate same-named remote tools from different servers.
  const normalized = remoteName
    .trim()
    .toLowerCase()
    .replace(REMOTE_NAME_PATTERN, "_")
    .replace(REPEATED_UNDERSCORE_PATTERN, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) {
    throw new PublishFailure(
      "mcp_invalid_tool_name",
      `MCP tool name cannot be normalized: ${alias}`,
    );
  }
  const exposed = `mcp__${alias}__${normalized}`;
  if (exposed.length > MAX_TOOL_NAME_LENGTH) {
    throw new PublishFailure(
      "mcp_invalid_tool_name",
      `MCP exposed tool name exceeds ${MAX_TOOL_NAME_LENGTH} characters: ${alias}`,
    );
  }
  return exposed;
}

function validatedDescription(alias: string, tool: McpPublishedTool): string {
  // Empty descriptions use local controlled text; non-empty descriptions are retained as-is after length limiting.
  if (tool.description === undefined || tool.description.trim().length === 0) {
    return `MCP tool ${tool.name} published by server alias ${alias}.`;
  }
  if (tool.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new PublishFailure(
      "mcp_invalid_tool_description",
      `MCP tool description exceeds ${MAX_DESCRIPTION_LENGTH} characters: ${alias}`,
    );
  }
  return tool.description;
}

function remoteError(alias: string, remoteName: string, code: string, message: string): ToolResult {
  // Remote errors retain only controllable fields like code/message/alias; server private content does not enter model context.
  return {
    content: jsonText({
      error: { code, message },
      server_alias: alias,
      status: "error",
      tool: remoteName,
    }),
    isError: true,
    errorCode: code,
  };
}

function jsonText(value: unknown): string {
  // MCP tools uniformly return JSON text to keep alias, status, and error code structured.
  return JSON.stringify(value);
}

function isEffect(value: unknown): value is McpToolPolicyOptions["effect"] {
  // The effect set stays consistent with the core permission system; remote tools cannot add arbitrary permission classes.
  return value === "read" || value === "write" || value === "execute" || value === "external";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // MCP JSON object boundary excludes null and arrays.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  // JSON round-trip copies objects and rejects functions, circular references, and undefined root values.
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not JSON serializable");
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new McpContractError("MCP value must be JSON serializable", { cause: error });
  }
}

function freezeJsonObject<T extends Record<string, unknown>>(value: T): Readonly<T> {
  // Recursively freezes protocol objects to prevent modification by external references after publishing or calling.
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) freezeJsonObject(nested);
    if (Array.isArray(nested)) freezeJsonArray(nested);
  }
  return Object.freeze(value);
}

function freezeJsonArray(value: unknown[]): readonly unknown[] {
  // Arrays and their nested objects or subarrays use the same deep freeze rule.
  for (const nested of value) {
    if (isRecord(nested)) freezeJsonObject(nested);
    if (Array.isArray(nested)) freezeJsonArray(nested);
  }
  return Object.freeze(value);
}

export function isMcpToolDefinition(definition: unknown): definition is ToolDefinition<unknown> {
  // Tests and the composition layer only need to identify the minimum callable shape of the tool definition.
  return (
    typeof definition === "object" &&
    definition !== null &&
    typeof Reflect.get(definition, "name") === "string" &&
    typeof Reflect.get(definition, "handler") === "function"
  );
}

export function isMcpManagementCall(call: ToolCall): boolean {
  // Management calls distinguish connection lifecycle commands from dynamic remote tool calls.
  return call.name === "connect_mcp" || call.name === "disconnect_mcp";
}
