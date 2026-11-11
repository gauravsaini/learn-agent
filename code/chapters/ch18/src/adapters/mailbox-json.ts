// FileMailboxStore adapter: applies mailbox domain protocol to workspace/.agent_tutorial/mailboxes, providing file locks and atomic state transitions.
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  lstat,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { lock as acquireLock } from "proper-lockfile";

import {
  canonicalAgentName,
  canonicalMailboxMessageId,
  createMailboxMessage,
  createProtocolMailboxMessage,
  equalMailboxItems,
  mailboxItemFromJson,
  mailboxItemToJson,
  type MailboxMessageKind,
  type MailboxItem,
  MailboxState,
  MailboxStorageError,
  randomMailboxMessageId,
  type MailboxMessage,
  type MailboxStore,
  type ProtocolMailboxMessage,
  type ProtocolMessageKind,
} from "../features/mailbox.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
// Serialize once per workspace in the same process to prevent multiple store instances from racing in-memory state outside file locks.
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

interface MailboxPaths {
  readonly workspace: string;
  readonly stateRoot: string;
  readonly root: string;
  readonly lock: string;
}

type MailboxDirectories = Readonly<Record<MailboxState, string>>;

export interface FileMailboxStoreOptions {
  readonly idGenerator?: () => string;
  readonly clock?: () => Date;
}

// File store implementations manage transitions across ready/processing/done/quarantine states. Callers depend only on the MailboxStore protocol.
export class FileMailboxStore implements MailboxStore {
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(workspace: string, options: FileMailboxStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator ?? randomMailboxMessageId;
    this.#clock = options.clock ?? (() => new Date());
  }

  async send(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): Promise<MailboxMessage> {
    return await this.#withLock(
      true,
      async (paths) => {
        // Sending validates the message first, then writes to the recipient's ready directory, returning the message only after write succeeds.
        const message = this.#newMessage(sender, recipient, content, kind);
        const directories = await this.#ensureMailbox(paths, message.recipient);
        if ((await this.#pathsForId(paths, message.id)).length > 0) {
          throw new MailboxStorageError(`Mailbox message id already exists: ${message.id}`);
        }
        await atomicWrite(
          join(directories[MailboxState.Ready], `${message.id}.json`),
          Buffer.from(`${JSON.stringify(mailboxItemToJson(message), null, 2)}\n`, "utf8"),
        );
        return message;
      },
      async () => {
        throw new MailboxStorageError("Mailbox root is unavailable");
      },
    );
  }

  async sendProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: { readonly requestId: string; readonly approved: boolean | null },
  ): Promise<ProtocolMailboxMessage> {
    return await this.#withLock(
      true,
      async (paths) => {
        // Protocol messages reuse the ready directory, but add request_id/approved to payload; validation failures do not persist to disk.
        const message = this.#newProtocolMessage(sender, recipient, content, kind, options);
        const directories = await this.#ensureMailbox(paths, message.recipient);
        if ((await this.#pathsForId(paths, message.id)).length > 0) {
          throw new MailboxStorageError(`Mailbox message id already exists: ${message.id}`);
        }
        await atomicWrite(
          join(directories[MailboxState.Ready], `${message.id}.json`),
          Buffer.from(`${JSON.stringify(mailboxItemToJson(message), null, 2)}\n`, "utf8"),
        );
        return message;
      },
      async () => {
        throw new MailboxStorageError("Mailbox root is unavailable");
      },
    );
  }

  async claim(recipient: string): Promise<MailboxItem | undefined> {
    let normalized: string;
    try {
      normalized = canonicalAgentName(recipient);
    } catch (error) {
      throw new MailboxStorageError("Mailbox recipient must be a safe lowercase slug", {
        cause: error,
      });
    }
    return await this.#withLock(
      false,
      async (paths) => {
        const directories = await this.#existingMailbox(paths, normalized);
        if (directories === undefined) return undefined;
        const candidates = await this.#validEntries(
          paths,
          directories,
          MailboxState.Ready,
          normalized,
        );
        // Select the next item by (created_at_utc, id), then use rename to atomically migrate it from ready to processing.
        const selected = candidates.sort(compareMessages)[0];
        if (selected === undefined) return undefined;
        await move(
          selected.path,
          join(directories[MailboxState.Processing], `${selected.message.id}.json`),
        );
        return selected.message;
      },
      async () => undefined,
    );
  }

  async ack(message: MailboxItem): Promise<boolean> {
    return await this.#transition(message, MailboxState.Done);
  }
  async release(message: MailboxItem): Promise<boolean> {
    return await this.#transition(message, MailboxState.Ready);
  }
  async quarantine(message: MailboxItem): Promise<boolean> {
    return await this.#transition(message, MailboxState.Quarantine);
  }

  async recoverProcessing(recipient: string): Promise<number> {
    let normalized: string;
    try {
      normalized = canonicalAgentName(recipient);
    } catch (error) {
      throw new MailboxStorageError("Mailbox recipient must be a safe lowercase slug", {
        cause: error,
      });
    }
    return await this.#withLock(
      false,
      async (paths) => {
        const directories = await this.#existingMailbox(paths, normalized);
        if (directories === undefined) return 0;
        const candidates = await this.#validEntries(
          paths,
          directories,
          MailboxState.Processing,
          normalized,
        );
        // processing is a half-open lease: recover to ready if consumer crashes, allowing subsequent claims to continue processing.
        for (const candidate of candidates.sort(compareMessages)) {
          await move(
            candidate.path,
            join(directories[MailboxState.Ready], `${candidate.message.id}.json`),
          );
        }
        return candidates.length;
      },
      async () => 0,
    );
  }

  async #transition(message: MailboxItem, destination: MailboxState): Promise<boolean> {
    assertMailboxItem(message);
    return await this.#withLock(
      false,
      async (paths) => {
        const directories = await this.#existingMailbox(paths, message.recipient);
        if (directories === undefined) return false;
        const filename = `${message.id}.json`;
        const processing = join(directories[MailboxState.Processing], filename);
        if (!(await pathExists(processing))) {
          // A second runtime might recover old messages and complete ack; idempotent confirmation of identical content is permitted.
          if (destination !== MailboxState.Done) return false;
          const completed = join(directories[MailboxState.Done], filename);
          if (!(await pathExists(completed))) return false;
          const stored = await this.#loadMessage(completed, message.recipient);
          if (!equalMailboxItems(stored, message)) {
            throw new MailboxStorageError(
              `Mailbox message does not match completed message: ${message.id}`,
            );
          }
          await this.#assertUniqueId(paths, message.id, completed);
          return true;
        }
        const stored = await this.#loadMessage(processing, message.recipient);
        if (!equalMailboxItems(stored, message)) {
          throw new MailboxStorageError(
            `Processing message does not match claimed message: ${message.id}`,
          );
        }
        // ack/release/quarantine all use the current processing file as baseline; reject overwriting if the target already exists.
        await this.#assertUniqueId(paths, message.id, processing);
        await move(processing, join(directories[destination], filename));
        return true;
      },
      async () => false,
    );
  }

  #newMessage(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): MailboxMessage {
    // Message IDs and times come from injectable generators, but still pass through unified domain validation.
    const { id, createdAtUtc } = this.#newEnvelopeFields();
    try {
      return createMailboxMessage({ id, sender, recipient, content, kind, createdAtUtc });
    } catch (error) {
      throw new MailboxStorageError("Mailbox message fields failed validation", { cause: error });
    }
  }

  #newProtocolMessage(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: { readonly requestId: string; readonly approved: boolean | null },
  ): ProtocolMailboxMessage {
    // The protocol envelope validates matching between request_id and approved; requests and responses cannot disguise as each other.
    const { id, createdAtUtc } = this.#newEnvelopeFields();
    try {
      return createProtocolMailboxMessage({
        ...options,
        id,
        sender,
        recipient,
        content,
        kind,
        createdAtUtc,
      });
    } catch (error) {
      throw new MailboxStorageError("Protocol mailbox fields failed validation", { cause: error });
    }
  }

  #newEnvelopeFields(): { readonly id: string; readonly createdAtUtc: Date } {
    // Convert generator or clock exceptions into storage errors to prevent invalid UUIDs or times from entering persistence.
    let id: string;
    let createdAtUtc: Date;
    try {
      id = canonicalMailboxMessageId(this.#idGenerator());
    } catch (error) {
      throw new MailboxStorageError("Mailbox id generator returned an invalid UUID", {
        cause: error,
      });
    }
    try {
      createdAtUtc = this.#clock();
      if (!(createdAtUtc instanceof Date) || !Number.isFinite(createdAtUtc.valueOf())) {
        throw new Error("invalid clock value");
      }
    } catch (error) {
      throw new MailboxStorageError("Mailbox clock must return a valid UTC Date", { cause: error });
    }
    return Object.freeze({ id, createdAtUtc });
  }

  async #preparePaths(create: boolean): Promise<MailboxPaths | undefined> {
    // The state path is fixed under workspace/.agent_tutorial/mailboxes; both creation and reading validate it cannot escape workspace.
    try {
      const workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("workspace is not a directory");
      const stateRoot = join(workspace, ".agent_tutorial");
      const root = join(stateRoot, "mailboxes");
      if (create) {
        await mkdir(stateRoot, { recursive: true });
        await validateDirectory(workspace, stateRoot, "Mailbox state root");
        await mkdir(root, { recursive: true });
        await validateDirectory(workspace, root, "Mailbox root");
      } else {
        if (!(await pathExists(stateRoot))) return undefined;
        await validateDirectory(workspace, stateRoot, "Mailbox state root");
        if (!(await pathExists(root))) return undefined;
        await validateDirectory(workspace, root, "Mailbox root");
      }
      const lock = join(stateRoot, ".mailboxes.lock");
      try {
        if ((await lstat(lock)).isSymbolicLink()) {
          throw new MailboxStorageError("Mailbox lock path must not be a symbolic link");
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      return Object.freeze({ workspace, stateRoot, root, lock });
    } catch (error) {
      if (error instanceof MailboxStorageError) throw error;
      throw new MailboxStorageError("Mailbox root is invalid", { cause: error });
    }
  }

  async #withLock<T>(
    create: boolean,
    operation: (paths: MailboxPaths) => Promise<T>,
    whenMissing: () => Promise<T>,
  ): Promise<T> {
    const paths = await this.#preparePaths(create);
    if (paths === undefined) return await whenMissing();
    // Dual serialization with in-process mutex and proper-lockfile directory lock ensures state transitions are atomic read-modify-write operations.
    return await withProcessMutex(paths.workspace, async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireLock(paths.root, {
          lockfilePath: paths.lock,
          realpath: true,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
          retries: { retries: 100, minTimeout: 10, maxTimeout: 10 },
        });
        await validateDirectory(paths.workspace, paths.root, "Mailbox root");
        return await operation(paths);
      } catch (error) {
        if (error instanceof MailboxStorageError) throw error;
        throw new MailboxStorageError("Mailbox state operation failed", { cause: error });
      } finally {
        if (release !== undefined) await release();
      }
    });
  }

  async #ensureMailbox(paths: MailboxPaths, recipient: string): Promise<MailboxDirectories> {
    // Each recipient owns four state directories; the sender creates missing ones at once.
    const root = join(paths.root, recipient);
    await mkdir(root, { recursive: true });
    await validateDirectory(paths.workspace, root, `Mailbox ${recipient}`);
    const directories = {} as Record<MailboxState, string>;
    for (const state of Object.values(MailboxState)) {
      const directory = join(root, state);
      await mkdir(directory, { recursive: true });
      await validateDirectory(paths.workspace, directory, `Mailbox ${recipient} ${state}`);
      directories[state] = directory;
    }
    return Object.freeze(directories);
  }

  async #existingMailbox(
    paths: MailboxPaths,
    recipient: string,
  ): Promise<MailboxDirectories | undefined> {
    // Reading an existing mailbox requires all four state directories intact; missing directories cannot silently count as an empty inbox.
    const root = join(paths.root, recipient);
    if (!(await pathExists(root))) return undefined;
    await validateDirectory(paths.workspace, root, `Mailbox ${recipient}`);
    const directories = {} as Record<MailboxState, string>;
    for (const state of Object.values(MailboxState)) {
      const directory = join(root, state);
      if (!(await pathExists(directory))) {
        throw new MailboxStorageError(`Mailbox ${recipient} is missing ${state}`);
      }
      await validateDirectory(paths.workspace, directory, `Mailbox ${recipient} ${state}`);
      directories[state] = directory;
    }
    return Object.freeze(directories);
  }

  async #validEntries(
    paths: MailboxPaths,
    directories: MailboxDirectories,
    state: MailboxState,
    recipient: string,
  ): Promise<Array<{ readonly message: MailboxItem; readonly path: string }>> {
    const directory = directories[state];
    if (directory === undefined)
      throw new MailboxStorageError("Mailbox state directory is missing");
    // Strictly validates files one by one; bad messages move to quarantine first without blocking valid messages in the same directory.
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates: Array<{ readonly message: MailboxItem; readonly path: string }> = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const source = join(directory, entry.name);
      try {
        if (entry.isDirectory() || entry.isSymbolicLink() || !entry.isFile()) {
          throw new MailboxStorageError(`Mailbox message is not a regular file: ${entry.name}`);
        }
        const message = await this.#loadMessage(source, recipient);
        candidates.push({ message, path: source });
      } catch (error) {
        await this.#moveInvalid(source, directories);
        if (!(error instanceof MailboxStorageError)) {
          throw new MailboxStorageError("Mailbox message is invalid", { cause: error });
        }
      }
    }
    for (const candidate of candidates) {
      await this.#assertUniqueId(paths, candidate.message.id, candidate.path);
    }
    return candidates;
  }

  async #loadMessage(path: string, recipient: string): Promise<MailboxItem> {
    // File name, payload, and recipient must match. Treat any mismatch as a storage error.
    const name = path.split(/[\\/]/u).at(-1) ?? "";
    if (!name.endsWith(".json"))
      throw new MailboxStorageError(`Mailbox message extension is invalid: ${name}`);
    let expectedId: string;
    try {
      expectedId = canonicalMailboxMessageId(name.slice(0, -".json".length));
    } catch (error) {
      throw new MailboxStorageError(`Mailbox message filename is invalid: ${name}`, {
        cause: error,
      });
    }
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new MailboxStorageError(`Mailbox message is not a regular file: ${name}`);
      }
      const raw = UTF8_DECODER.decode(await readFile(path));
      const message = mailboxItemFromJson(JSON.parse(raw));
      if (message.id !== expectedId || message.recipient !== recipient) {
        throw new MailboxStorageError(`Mailbox message path does not match payload: ${name}`);
      }
      return message;
    } catch (error) {
      if (error instanceof MailboxStorageError) throw error;
      throw new MailboxStorageError(`Mailbox message payload is invalid: ${name}`, {
        cause: error,
      });
    }
  }

  async #moveInvalid(source: string, directories: MailboxDirectories): Promise<void> {
    const quarantine = directories[MailboxState.Quarantine];
    if (quarantine === undefined)
      throw new MailboxStorageError("Mailbox quarantine directory is missing");
    const name = source.split(/[\\/]/u).at(-1) ?? "invalid";
    let destination = join(quarantine, name);
    // When quarantine already has a file with the same name, append a non-conflicting suffix to retain both pieces of evidence.
    for (let index = 1; await pathExists(destination); index += 1) {
      const suffix = name.endsWith(".json") ? ".json" : "";
      const stem = suffix.length === 0 ? name : name.slice(0, -suffix.length);
      destination = join(quarantine, `${stem}.quarantine-${index}${suffix}`);
    }
    await move(source, destination);
  }

  async #pathsForId(paths: MailboxPaths, id: string): Promise<readonly string[]> {
    // Scan all mailboxes and state directories across Agents to guarantee identical UUIDs remain unique across the entire workspace.
    const result: string[] = [];
    for (const entry of await readdir(paths.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new MailboxStorageError(`Mailbox directory is invalid: ${entry.name}`);
      }
      let recipient: string;
      try {
        recipient = canonicalAgentName(entry.name);
      } catch (error) {
        throw new MailboxStorageError(`Mailbox directory name is invalid: ${entry.name}`, {
          cause: error,
        });
      }
      const directories = await this.#existingMailbox(paths, recipient);
      if (directories === undefined) continue;
      for (const state of Object.values(MailboxState)) {
        const directory = directories[state];
        if (directory === undefined) continue;
        const candidate = join(directory, `${id}.json`);
        if (await pathExists(candidate)) result.push(candidate);
      }
    }
    return result;
  }

  async #assertUniqueId(paths: MailboxPaths, id: string, source: string): Promise<void> {
    // Fail explicitly when the same ID exists in other state directories; cannot overwrite older messages.
    const collisions = (await this.#pathsForId(paths, id)).filter((path) => path !== source);
    if (collisions.length > 0) {
      throw new MailboxStorageError(`Mailbox message id exists in multiple states: ${id}`);
    }
  }
}

function compareMessages(
  left: { readonly message: MailboxItem },
  right: { readonly message: MailboxItem },
): number {
  // FIFO order is determined by creation time, stably breaking ties with UUID text when times match.
  return (
    left.message.createdAtUtc.valueOf() - right.message.createdAtUtc.valueOf() ||
    left.message.id.localeCompare(right.message.id)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function validateDirectory(workspace: string, path: string, label: string): Promise<void> {
  // The state directory must be a real directory inside the workspace to prevent symlinks or relative paths from writing state outside.
  const resolved = await realpath(path);
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || !isWithin(workspace, resolved)) {
    throw new MailboxStorageError(`${label} escapes workspace or is not a directory`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !value.includes(":"));
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  // Writes temporary file first, syncs, then renames; readers see only complete old file or complete new file.
  const temporary = join(
    path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1),
    `.${path.split(/[\\/]/u).at(-1) ?? "mailbox"}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.write(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    throw new MailboxStorageError("Could not persist mailbox message", { cause: error });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function move(source: string, destination: string): Promise<void> {
  // Explicitly reject existing targets before rename to prevent two state directories holding the same message simultaneously.
  if (await pathExists(destination)) {
    throw new MailboxStorageError(
      `Mailbox destination already exists: ${destination.split(/[\\/]/u).at(-1)}`,
    );
  }
  try {
    await rename(source, destination);
  } catch (error) {
    throw new MailboxStorageError("Could not move mailbox message", { cause: error });
  }
}

function assertMailboxItem(value: MailboxItem): void {
  // Normal and protocol messages share a migration entry point, revalidating by type first to prevent fake objects from bypassing domain constraints.
  try {
    if ("requestId" in value) createProtocolMailboxMessage(value);
    else createMailboxMessage(value);
  } catch (error) {
    throw new TypeError("message must be a MailboxItem", { cause: error });
  }
}

async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // Use a Promise queue to serialize operations on the same workspace within the process, preventing concurrent operations from overwriting memory state.
  const previous = PROCESS_LOCK_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  PROCESS_LOCK_TAILS.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (PROCESS_LOCK_TAILS.get(key) === tail) PROCESS_LOCK_TAILS.delete(key);
  }
}

function isNodeError(value: unknown, code: string): boolean {
  // Check common ENOENT only by Node error codes; propagate other exceptions upward.
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
