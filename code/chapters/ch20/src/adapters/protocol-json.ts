// JsonProtocolStore adapter: persists protocol requests to single-file state.json, using in-process mutex and file locks to guarantee atomic read-modify-writes.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { lock as acquireLock } from "proper-lockfile";

import {
  ProtocolExpiredError,
  ProtocolError,
  ProtocolMismatchError,
  ProtocolNotFoundError,
  ProtocolRequestKind,
  ProtocolRequestStatus,
  ProtocolStateError,
  ProtocolStorageError,
  type ProtocolRequest,
  type ProtocolResolution,
  type ProtocolStore,
} from "../features/protocol.js";
import {
  canonicalAgentName,
  canonicalMailboxMessageId,
  type ProtocolMailboxMessage,
  ProtocolMessageKind,
} from "../features/mailbox.js";

const STATE_VERSION = 1;
// In-process Promise tail queue serializes multiple calls entering #withLock concurrently for the same workspace, forming a double lock with proper-lockfile.
const tails = new Map<string, Promise<void>>();

export interface JsonProtocolStoreOptions {
  // Tests can inject a deterministic UUID; production defaults to randomUUID, and the result still requires normalization validation.
  readonly idGenerator?: () => string;
  // Creation, expiration, and resolution times all originate from the same clock boundary.
  readonly clock?: () => Date;
  // Valid window for pending requests; expired requests remain in snapshots but cannot be consumed.
  readonly requestTtlMs?: number;
  // Tests can replace atomic write; the production implementation guarantees visibility of either the old or new file.
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}
// The path is fixed at workspace/.agent_tutorial/protocol/, and lock file .protocol.lock resides under stateRoot.
interface Paths {
  // Workspace root after realpath, used as mutex key and baseline for path escape checks.
  readonly workspace: string;
  // Protocol state directory `.agent_tutorial/protocol`.
  readonly root: string;
  // Single JSON snapshot path containing all request history and terminal states.
  readonly state: string;
  // Cross-process lock path used by proper-lockfile.
  readonly lock: string;
}
// StoredState is an untrusted shell for disk JSON; concrete requests are subsequently parsed strictly item by item.
interface StoredState {
  // If the version does not match, the entire snapshot refuses to load to avoid silently misreading old schemas.
  readonly version: number;
  // Keeps unknown, must pass parseRequest before entering domain layer.
  readonly requests: readonly unknown[];
}

// RequestData uniformly receives two untrusted input paths: new requests and disk deserialization.
interface RequestData {
  readonly id: unknown;
  readonly kind: unknown;
  readonly sender: unknown;
  readonly target: unknown;
  readonly status?: unknown;
  readonly content: unknown;
  readonly createdAtUtc: unknown;
  readonly expiresAtUtc: unknown;
  readonly resolution?: unknown;
}

// JsonProtocolStore saves all protocol requests as a single state.json snapshot.
// Two layers of locks guarantee atomicity:
//   1. In-process mutex (Promise tail queue) serializes multi-instance concurrency within the same process.
//   2. proper-lockfile directory lock serializes cross-process/cross-Runtime access.
export class JsonProtocolStore implements ProtocolStore {
  // Preserves caller path, performing realpath and confirming real directory only on first operation.
  readonly #workspaceInput: string;
  // Called only when creating requests inside the lock; generated value must be a canonical UUID.
  readonly #idGenerator: () => string;
  // Copy Date after each read to prevent injectors from modifying the original object.
  readonly #clock: () => Date;
  // All requests share the expiration policy determined at construction.
  readonly #ttlMs: number;
  // All snapshot writes pass through the same replaceable atomic boundary.
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;
  // Validate non-empty workspace and positive integer ttlMs at build time; tests can inject idGenerator, clock, and atomicReplace.
  constructor(workspace: string, options: JsonProtocolStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0)
      throw new TypeError("workspace must be a non-empty string");
    this.#workspaceInput = workspace;
    // Defaults to randomUUID; tests can inject deterministic UUIDs.
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
    this.#ttlMs = options.requestTtlMs ?? 300_000;
    this.#atomicReplace = options.atomicReplace ?? atomicReplace;
    // TTL is a positive integer; #requireCurrent rejects operations after expiration.
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs <= 0)
      throw new TypeError("requestTtlMs must be positive");
  }
  async createRequest(input: {
    readonly kind: ProtocolRequestKind;
    readonly sender: string;
    readonly target: string;
    readonly content: string;
  }): Promise<ProtocolRequest> {
    // Validation, append, and persistence occur in the same lock to avoid concurrent requests overwriting each other.
    return await this.#withLock(true, async (paths) => {
      // Re-reads the snapshot within the lock to avoid appending requests based on stale in-memory state.
      const state = await this.#load(paths);
      let id: string;
      try {
        id = canonicalMailboxMessageId(this.#idGenerator());
      } catch (error) {
        throw new ProtocolStorageError("Protocol id generator returned an invalid UUID", {
          cause: error,
        });
      }
      if (state.some((item) => item.id === id))
        throw new ProtocolStorageError(`Protocol request id already exists: ${id}`);
      const now = this.#now();
      const last = state.at(-1);
      // State arrays append in creation order; fail explicitly on clock regression to prevent the "latest plan" from being reordered incorrectly.
      if (last !== undefined && now.valueOf() < last.createdAtUtc.valueOf())
        throw new ProtocolStorageError("Protocol clock moved backwards");
      let request: ProtocolRequest;
      try {
        request = makeRequest({
          id,
          ...input,
          createdAtUtc: now,
          expiresAtUtc: new Date(now.valueOf() + this.#ttlMs),
        });
      } catch (error) {
        if (error instanceof ProtocolStorageError) throw error;
        throw new ProtocolStorageError("Protocol request fields failed validation", {
          cause: error,
        });
      }
      await this.#persist(paths, [...state, request]);
      return request;
    });
  }
  async getPendingRequest(id: string): Promise<ProtocolRequest> {
    // Read-only queries also pass through the same locking and parsing to avoid reading intermediate snapshots from concurrent writes.
    return await this.#withLock(
      false,
      async (paths) => {
        const request = find(await this.#load(paths), id);
        this.#requireCurrent(request);
        return request;
      },
      async () => find([], id),
    );
  }
  async getRequest(id: string): Promise<ProtocolRequest> {
    // Any state query returns current durable snapshot; find gives a definitive error if state does not exist.
    return await this.#withLock(
      false,
      async (paths) => find(await this.#load(paths), id),
      async () => find([], id),
    );
  }
  async listRequests(): Promise<readonly ProtocolRequest[]> {
    // List is used only for diagnostics or testing and does not cache state outside lock, guaranteeing every return is the latest snapshot.
    return await this.#withLock(
      false,
      async (paths) => await this.#load(paths),
      async () => [],
    );
  }
  async latestPlanRequest(sender: string): Promise<ProtocolRequest | undefined> {
    // Array order within the lock determines the "latest plan", not UUID text or request ID sorting.
    return await this.#withLock(
      false,
      async (paths) => {
        let name: string;
        try {
          name = canonicalAgentName(sender);
        } catch {
          throw new ProtocolMismatchError("Plan sender must be a canonical Agent name");
        }
        const requests = (await this.#load(paths)).filter(
          (item) => item.kind === ProtocolRequestKind.PlanApproval && item.sender === name,
        );
        return requests.at(-1);
      },
      async () => undefined,
    );
  }
  async validateRequest(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    // Read-only validation for request direction: verify typed message matches persisted request completely without transitioning state.
    return await this.#withLock(
      false,
      async (paths) => {
        const request = find(await this.#load(paths), message.requestId);
        this.#validateMessage(request, message, false);
        return request;
      },
      async () => find([], message.requestId),
    );
  }
  async validateResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    // Read-only validation for response direction: the Lead drain phase only validates, deferring real consumption to the ack phase.
    return await this.#withLock(
      false,
      async (paths) => {
        const request = find(await this.#load(paths), message.requestId);
        this.#validateMessage(request, message, true);
        return request;
      },
      async () => find([], message.requestId),
    );
  }
  async consumeResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    // This is the only storage operation that atomically transitions pending to approved/rejected.
    return await this.#withLock(
      false,
      async (paths) => {
        const state = await this.#load(paths);
        const request = find(state, message.requestId);
        // Return idempotently when resolved with the same response; explicitly reject when another message retries the same request.
        if (request.status !== ProtocolRequestStatus.Pending) {
          if (sameResponse(request, message)) return request;
          throw new ProtocolStateError(`Protocol request is already resolved: ${request.id}`);
        }
        const now = this.#now();
        this.#validateMessage(request, message, true, now);
        const approved = requireResponseDecision(message);
        const resolution: ProtocolResolution = Object.freeze({
          messageId: message.id,
          approved,
          content: message.content,
          resolvedAtUtc: now,
        });
        const updated = makeRequest({
          ...request,
          status: approved ? ProtocolRequestStatus.Approved : ProtocolRequestStatus.Rejected,
          resolution,
        });
        await this.#persist(
          paths,
          state.map((item) => (item.id === request.id ? updated : item)),
        );
        return updated;
      },
      async () => find([], message.requestId),
    );
  }
  // Acquires in-process mutex first, then acquires proper-lockfile directory lock, ensuring operations inside lock are atomic read-modify-write across instances.
  async #withLock<T>(
    create: boolean,
    operation: (paths: Paths) => Promise<T>,
    missing: () => Promise<T> = async () => {
      throw new ProtocolStorageError("Protocol state root is unavailable");
    },
  ): Promise<T> {
    // When create=false and directory does not exist, execute missing to prevent read-only queries creating runtime files.
    const paths = await this.#paths(create);
    if (paths === undefined) return await missing();
    return await mutex(paths.workspace, async () => {
      let release: (() => Promise<void>) | undefined;
      let outcome: { readonly value: T } | undefined;
      let operationFailed = false;
      let operationError: unknown;
      let releaseError: unknown;
      try {
        release = await acquireLock(paths.root, {
          lockfilePath: paths.lock,
          stale: 30_000,
          update: 10_000,
          retries: { retries: 100, minTimeout: 10, maxTimeout: 10 },
        });
        outcome = { value: await operation(paths) };
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        if (release !== undefined) {
          try {
            await release();
          } catch (error) {
            releaseError = error;
          }
        }
      }
      if (operationFailed) {
        if (operationError instanceof ProtocolError) throw operationError;
        throw new ProtocolStorageError("Protocol lock operation failed", { cause: operationError });
      }
      if (releaseError !== undefined) {
        throw new ProtocolStorageError("Protocol lock could not be released", {
          cause: releaseError,
        });
      }
      if (outcome === undefined)
        throw new ProtocolStorageError("Protocol lock operation did not complete");
      return outcome.value;
    });
  }
  async #paths(create: boolean): Promise<Paths | undefined> {
    // Resolve real workspace, creating or validating .agent_tutorial/protocol state directory; return undefined when missing in non-create mode.
    let workspace: string;
    try {
      workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new ProtocolStorageError("workspace is not a directory", { cause: error });
    }
    const stateRoot = join(workspace, ".agent_tutorial");
    const root = join(stateRoot, "protocol");
    if (create) {
      try {
        await ensureDirectory(stateRoot, workspace, "runtime state root");
        await ensureDirectory(root, workspace, "Protocol state root");
      } catch (error) {
        if (error instanceof ProtocolStorageError) throw error;
        throw new ProtocolStorageError("Protocol state root could not be created", {
          cause: error,
        });
      }
    } else {
      try {
        await lstat(root);
        await ensureDirectory(root, workspace, "Protocol state root");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
    }
    const lock = join(stateRoot, ".protocol.lock");
    try {
      if ((await lstat(lock)).isSymbolicLink()) {
        throw new ProtocolStorageError("Protocol lock path must not be a symbolic link");
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return Object.freeze({
      workspace,
      root,
      state: join(root, "state.json"),
      lock,
    });
  }
  async #load(paths: Paths): Promise<readonly ProtocolRequest[]> {
    // Read state.json and validate version, fields, id uniqueness, and creation order; treat missing file as empty state.
    try {
      const stateInfo = await lstat(paths.state);
      if (!stateInfo.isFile())
        throw new ProtocolStorageError("Protocol state file is not a regular file");
      const raw = await readFile(paths.state, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!isStoredState(value)) throw new Error("invalid state");
      const requests = value.requests.map(parseRequest);
      const ids = new Set<string>();
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        if (request === undefined) throw new Error("invalid request");
        if (ids.has(request.id)) throw new Error("duplicate request id");
        ids.add(request.id);
        const previous = index === 0 ? undefined : requests[index - 1];
        if (
          previous !== undefined &&
          request.createdAtUtc.valueOf() < previous.createdAtUtc.valueOf()
        ) {
          throw new Error("requests are not in creation order");
        }
      }
      return requests;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      if (error instanceof ProtocolStorageError) throw error;
      throw new ProtocolStorageError("Protocol state is invalid", { cause: error });
    }
  }
  async #persist(paths: Paths, requests: readonly ProtocolRequest[]): Promise<void> {
    // Persist snapshots uniformly via atomicReplace; old state.json remains unchanged if write fails.
    const content = Buffer.from(
      `${JSON.stringify({ version: STATE_VERSION, requests: requests.map(serializeRequest) }, null, 2)}\n`,
      "utf8",
    );
    try {
      await this.#atomicReplace(paths.state, content);
    } catch (error) {
      throw new ProtocolStorageError("Could not persist protocol state", { cause: error });
    }
  }
  #now(): Date {
    // Clock injection can return deterministic times. Convert invalid Dates into storage errors before entering the state machine.
    try {
      const now = this.#clock();
      if (!(now instanceof Date) || !Number.isFinite(now.valueOf()))
        throw new Error("invalid clock value");
      return new Date(now.valueOf());
    } catch (error) {
      throw new ProtocolStorageError("Protocol clock must return a valid Date", { cause: error });
    }
  }
  #requireCurrent(request: ProtocolRequest, now = this.#now()): void {
    // Only pending and unexpired items participate in state transitions; resolved or expired map to state and expiration errors.
    if (request.status !== ProtocolRequestStatus.Pending)
      throw new ProtocolStateError(`Protocol request is already resolved: ${request.id}`);
    if (now.valueOf() >= request.expiresAtUtc.valueOf())
      throw new ProtocolExpiredError(`Protocol request has expired: ${request.id}`);
  }
  #validateMessage(
    request: ProtocolRequest,
    message: ProtocolMailboxMessage,
    response: boolean,
    now = this.#now(),
  ): void {
    // Validate exact correspondence of kind, sender, recipient, and content between message and request to prevent misdelivery or forged responses.
    const expected = response
      ? request.kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownResponse
        : ProtocolMessageKind.PlanApprovalResponse
      : request.kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownRequest
        : ProtocolMessageKind.PlanApprovalRequest;
    if (
      message.kind !== expected ||
      message.sender !== (response ? request.target : request.sender) ||
      message.recipient !== (response ? request.sender : request.target)
    )
      throw new ProtocolMismatchError("Protocol message does not match request");
    if (response && message.approved === null)
      throw new ProtocolMismatchError("Protocol response is missing its decision");
    if (!response && message.content !== request.content)
      throw new ProtocolMismatchError("Protocol request content does not match registered request");
    if (response && request.status !== ProtocolRequestStatus.Pending) {
      if (sameResponse(request, message)) return;
      throw new ProtocolStateError(`Protocol request is already resolved: ${request.id}`);
    }
    this.#requireCurrent(request, now);
  }
}

function makeRequest(input: RequestData): ProtocolRequest {
  // Construct immutable ProtocolRequest and validate required fields, sender!=target, valid time range, and status-resolution consistency.
  if (!(input.createdAtUtc instanceof Date) || !Number.isFinite(input.createdAtUtc.valueOf()))
    throw new ProtocolStorageError("Protocol request fields failed validation");
  if (!(input.expiresAtUtc instanceof Date) || !Number.isFinite(input.expiresAtUtc.valueOf()))
    throw new ProtocolStorageError("Protocol request fields failed validation");
  const sender = canonicalAgentName(requireString(input.sender, "sender"));
  const target = canonicalAgentName(requireString(input.target, "target"));
  const content = requireString(input.content, "content");
  const kind = requireEnum(input.kind, Object.values(ProtocolRequestKind));
  const status =
    input.status === undefined
      ? ProtocolRequestStatus.Pending
      : requireEnum(input.status, Object.values(ProtocolRequestStatus));
  const resolution =
    input.resolution === undefined || input.resolution === null
      ? null
      : normalizeResolution(input.resolution);
  if (
    sender === target ||
    content.trim().length === 0 ||
    input.expiresAtUtc.valueOf() <= input.createdAtUtc.valueOf()
  )
    throw new ProtocolStorageError("Protocol request fields failed validation");
  if (status === ProtocolRequestStatus.Pending && resolution !== null)
    throw new ProtocolStorageError("Pending protocol request cannot have a resolution");
  if (status !== ProtocolRequestStatus.Pending) {
    if (resolution === null)
      throw new ProtocolStorageError("Resolved protocol request requires a resolution");
    const expected = resolution.approved
      ? ProtocolRequestStatus.Approved
      : ProtocolRequestStatus.Rejected;
    if (
      status !== expected ||
      resolution.resolvedAtUtc.valueOf() < input.createdAtUtc.valueOf() ||
      resolution.resolvedAtUtc.valueOf() >= input.expiresAtUtc.valueOf()
    )
      throw new ProtocolStorageError("Protocol request resolution is invalid");
  }
  return Object.freeze({
    id: canonicalMailboxMessageId(requireString(input.id, "id")),
    kind,
    sender,
    target,
    status,
    content,
    createdAtUtc: new Date(input.createdAtUtc.valueOf()),
    expiresAtUtc: new Date(input.expiresAtUtc.valueOf()),
    resolution,
  });
}
function serializeRequest(request: ProtocolRequest): Record<string, unknown> {
  // Persistent fields use snake_case; conversions with in-memory camelCase occur at serialization boundaries only.
  return {
    id: request.id,
    kind: request.kind,
    sender: request.sender,
    target: request.target,
    status: request.status,
    content: request.content,
    created_at_utc: request.createdAtUtc.toISOString(),
    expires_at_utc: request.expiresAtUtc.toISOString(),
    resolution:
      request.resolution === null
        ? null
        : {
            message_id: request.resolution.messageId,
            approved: request.resolution.approved,
            content: request.resolution.content,
            resolved_at_utc: request.resolution.resolvedAtUtc.toISOString(),
          },
  };
}
function parseRequest(value: unknown): ProtocolRequest {
  // Reject unknown or missing fields during deserialization; disk input must not bypass domain validation.
  if (!isRecord(value)) throw new Error("invalid request");
  const expected = [
    "content",
    "created_at_utc",
    "expires_at_utc",
    "id",
    "kind",
    "resolution",
    "sender",
    "status",
    "target",
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid request fields");
  }
  const resolution = value.resolution;
  return makeRequest({
    id: value.id,
    kind: value.kind,
    sender: value.sender,
    target: value.target,
    status: value.status,
    content: value.content,
    createdAtUtc: parseDate(value.created_at_utc),
    expiresAtUtc: parseDate(value.expires_at_utc),
    resolution: resolution === null ? null : parseResolution(resolution),
  });
}
function find(requests: readonly ProtocolRequest[], id: string): ProtocolRequest {
  // Find the request by canonical UUID. Throw ProtocolNotFoundError if it does not exist.
  let normalized: string;
  try {
    normalized = canonicalMailboxMessageId(id);
  } catch {
    throw new ProtocolNotFoundError("Protocol request id must be a canonical UUID");
  }
  const request = requests.find((item) => item.id === normalized);
  if (request === undefined)
    throw new ProtocolNotFoundError(`Protocol request does not exist: ${normalized}`);
  return request;
}
function sameResponse(request: ProtocolRequest, message: ProtocolMailboxMessage): boolean {
  // message id, decision, and content must all match to count as an idempotent replay of the same response.
  // Compare full response contents to determine if this is an idempotent retry of the same request and consumed response.
  const r = request.resolution;
  return (
    r !== null &&
    message.kind ===
      (request.kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownResponse
        : ProtocolMessageKind.PlanApprovalResponse) &&
    message.sender === request.target &&
    message.recipient === request.sender &&
    r.messageId === message.id &&
    r.approved === message.approved &&
    r.content === message.content
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  // JSON object guard excludes null and arrays for reuse in subsequent exact field checks.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value: unknown, label: string): string {
  // Persisted text must be non-empty strings; caller field names are used only for stable error localization.
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ProtocolStorageError(`Protocol ${label} must not be empty`);
  return value;
}
function requireEnum<T extends string>(value: unknown, values: readonly T[]): T {
  // On-disk enums must belong to the current closed set, and unknown future values must not silently downgrade.
  if (typeof value !== "string" || !values.includes(value as T))
    throw new ProtocolStorageError("Protocol request fields failed validation");
  return value as T;
}
function parseDate(value: unknown): Date {
  // Accepts only UTC times that parse and normalize to the same ISO string.
  if (typeof value !== "string" || !value.endsWith("Z")) throw new Error("invalid date");
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value)
    throw new Error("invalid date");
  return date;
}
function parseResolution(value: unknown): ProtocolResolution {
  // resolution allows only four persistent fields; extra fields are considered schema drift.
  if (!isRecord(value)) throw new Error("invalid resolution");
  const expected = ["approved", "content", "message_id", "resolved_at_utc"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid resolution fields");
  }
  return normalizeResolution({
    messageId: canonicalMailboxMessageId(requireString(value.message_id, "resolution message_id")),
    approved: requireBoolean(value.approved),
    content: requireString(value.content, "resolution content"),
    resolvedAtUtc: parseDate(value.resolved_at_utc),
  });
}
function normalizeResolution(value: unknown): ProtocolResolution {
  // In-memory creation path also copies and freezes resolution to prevent subsequent changes to external objects.
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    typeof value.approved !== "boolean" ||
    typeof value.content !== "string" ||
    !(value.resolvedAtUtc instanceof Date)
  ) {
    throw new Error("invalid resolution");
  }
  if (!Number.isFinite(value.resolvedAtUtc.valueOf()) || value.content.trim().length === 0)
    throw new Error("invalid resolution");
  return Object.freeze({
    messageId: canonicalMailboxMessageId(value.messageId),
    approved: value.approved,
    content: value.content,
    resolvedAtUtc: new Date(value.resolvedAtUtc.valueOf()),
  });
}
function requireBoolean(value: unknown): boolean {
  // Approval conclusions must explicitly be boolean; cannot loosely convert strings or numbers.
  if (typeof value !== "boolean") throw new Error("invalid boolean");
  return value;
}
function requireResponseDecision(message: ProtocolMailboxMessage): boolean {
  // Reject state transitions when responses lack a decision; do not guess approval outcomes from body text.
  if (message.approved === null)
    throw new ProtocolMismatchError("Protocol response is missing its decision");
  return message.approved;
}
function isStoredState(value: unknown): value is StoredState {
  // The outermost layer only allows version and requests fields; extra fields cannot be ignored.
  if (!isRecord(value) || value.version !== STATE_VERSION || !Array.isArray(value.requests)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "requests" && keys[1] === "version";
}
function errorCode(error: unknown): string | undefined {
  // Safely extract Node system error code; return undefined when not an Error or code is missing.
  if (!(error instanceof Error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
async function ensureDirectory(path: string, workspace: string, label: string): Promise<void> {
  // Creates and validates directory is not a symlink and does not escape workspace, preventing path traversal from writing state externally.
  try {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ProtocolStorageError(`${label} is not a directory`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(path);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ProtocolStorageError(`${label} is not a directory`);
    }
    const resolved = await realpath(path);
    if (
      resolved !== path ||
      !resolved.startsWith(`${workspace}${process.platform === "win32" ? "\\" : "/"}`)
    )
      throw new ProtocolStorageError(`${label} escapes workspace`);
  } catch (error) {
    if (error instanceof ProtocolStorageError) throw error;
    throw new ProtocolStorageError(`${label} could not be resolved`, { cause: error });
  }
}
async function mutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // Use a Promise tail queue to serialize concurrent operations on the same key; multiple store instances in the process share this queue.
  const previous = tails.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // Writes sibling temporary file first, fsyncs, and renames; readers see only complete old file or complete new file.
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.write(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
