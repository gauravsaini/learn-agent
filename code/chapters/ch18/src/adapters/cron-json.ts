// JSON Cron adapter: persists durable schedules and outbox to workspace .agent_tutorial/cron, using in-process mutex and file locks to guarantee atomic transitions.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { lock as acquireLock } from "proper-lockfile";

import {
  canonicalCronId,
  createCronEvent,
  CronError,
  CronJobNotFoundError,
  CronStorageError,
  type CronEvent,
  type CronJob,
  type CronStore,
  nextCronOccurrence,
  validateCronExpression,
  validateCronTimezone,
} from "../features/cron.js";

// The version number determines the schema compatibility boundary of state.json; lock parameters control reclamation and retry policies during multi-process contention.
const STATE_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_LOCK_RETRIES = 100;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
// Serialize once more per workspace in the same process to prevent multiple store instances from repeatedly contesting directory locks.
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

export interface JsonCronStoreOptions {
  // Plan and event ids can be injected separately; tests can stably cover collision and idempotency scenarios.
  readonly idGenerator?: () => string;
  readonly eventIdGenerator?: () => string;
  // Total capacity shared by durable and session outbox.
  readonly outboxCapacity?: number;
  // Atomic replacement injection point used to simulate disk write failures.
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}
interface CronPaths {
  // Workspace root directory after realpath.
  readonly workspace: string;
  // .agent_tutorial runtime state root.
  readonly stateRoot: string;
  // Cron state directory.
  readonly root: string;
  // Single-file snapshot of durable jobs and outbox.
  readonly state: string;
  // Cross-process lock path used for snapshot read-modify-write.
  readonly lock: string;
  // Dedicated directory used by the durable scheduler leader lease.
  readonly leader: string;
}
// state.json saves durable jobs/outbox only; session-only state always stays in memory.
interface CronState {
  // Snapshot schema version.
  readonly version: number;
  // Contains only durable schedules.
  readonly jobs: readonly CronJob[];
  // Contains only durable unacknowledged events.
  readonly outbox: readonly CronEvent[];
}

// JSON store uniformly manages durable disk snapshots and current process session-only state.
export class JsonCronStore implements CronStore {
  // External workspace input; re-resolve real paths before each I/O operation.
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #eventIdGenerator: () => string;
  // Maximum total unacknowledged events retained in a single tick.
  readonly #outboxCapacity: number;
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;
  // Keep jobs and pending events with durable=False in this instance only; do not write to state.json.
  readonly #sessionJobs = new Map<string, CronJob>();
  readonly #sessionOutbox = new Map<string, CronEvent>();
  // Leader release function held by current instance; undefined indicates non-leader.
  #leaderRelease: (() => Promise<void>) | undefined;

  // Validate injection boundaries and capacity; constructor does not create state directories.
  constructor(workspace: string, options: JsonCronStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0)
      throw new TypeError("workspace must be a non-empty string");
    const capacity = options.outboxCapacity ?? 50;
    if (!Number.isInteger(capacity) || capacity <= 0)
      throw new TypeError("outboxCapacity must be a positive integer");
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#eventIdGenerator = options.eventIdGenerator ?? randomUUID;
    this.#outboxCapacity = capacity;
    this.#atomicReplace = options.atomicReplace ?? atomicReplace;
  }

  // Validates and creates schedule; durable writes snapshot atomically, session-only enters in-memory Map only.
  async scheduleCron(input: {
    cron: string;
    prompt: string;
    timezone: string;
    recurring: boolean;
    durable: boolean;
    identity: string;
    nowUtc: Date;
  }): Promise<CronJob> {
    if (typeof input.recurring !== "boolean" || typeof input.durable !== "boolean") {
      throw new CronStorageError("Cron recurring and durable values must be boolean");
    }
    // Validates expression, timezone, prompt, and identity before creating job, preventing invalid input from generating persistable definitions.
    const id = this.#nextId(this.#idGenerator, "Cron job");
    const cron = validateCronExpression(input.cron);
    const timezone = validateCronTimezone(input.timezone);
    const job: CronJob = Object.freeze({
      id,
      cron,
      prompt: requireText(input.prompt, "Cron prompt"),
      timezone,
      recurring: input.recurring,
      durable: input.durable,
      identity: requireText(input.identity, "Cron identity"),
      nextRunAtUtc: nextCronOccurrence(input.cron, input.timezone, input.nowUtc),
      lastSlotAtUtc: null,
    });
    const paths = await this.#preparePaths(input.durable);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      if (this.#sessionJobs.has(job.id) || state.jobs.some((existing) => existing.id === job.id))
        throw new CronStorageError(`Cron job id already exists: ${job.id}`);
      // Write durable jobs to atomic snapshots; place session-only jobs only in memory Maps.
      if (job.durable) await this.#persist(paths, { ...state, jobs: [...state.jobs, job] });
      else this.#sessionJobs.set(job.id, job);
      return job;
    });
  }

  // Merge disk and in-memory states to read a single schedule.
  async getJob(jobId: string): Promise<CronJob> {
    // Merge durable snapshots with session-only records during queries; callers do not need to know which lifecycle produced the job.
    const id = this.#lookupJobId(jobId);
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      const job = [...state.jobs, ...this.#sessionJobs.values()].find(
        (candidate) => candidate.id === id,
      );
      if (job === undefined) throw new CronJobNotFoundError(`Cron job does not exist: ${id}`);
      return job;
    });
  }
  // Returns an ordered immutable snapshot after merging durable and session-only.
  async listJobs(): Promise<readonly CronJob[]> {
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [...(await this.#loadState(paths)).jobs, ...this.#sessionJobs.values()].sort(
          (left, right) => left.id.localeCompare(right.id),
        ),
      ),
    );
  }

  // Generate expiration events, advance recurring slots, and delete one-shot schedules within the same critical section.
  async tick(nowUtc: Date, includeDurable = true): Promise<readonly CronEvent[]> {
    if (typeof includeDurable !== "boolean")
      throw new TypeError("includeDurable must be a boolean");
    if (!(nowUtc instanceof Date) || !Number.isFinite(nowUtc.valueOf())) {
      throw new CronStorageError("Cron clock value must be a valid UTC Date");
    }
    // tick migrates both durable and session-only within the lock: sort by expiration first, then apply outbox capacity limits.
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      const durableJobs = new Map(state.jobs.map((job) => [job.id, job]));
      const durableOutbox = new Map(state.outbox.map((event) => [event.eventId, event]));
      const sessionJobs = new Map(this.#sessionJobs);
      const sessionOutbox = new Map(this.#sessionOutbox);
      const knownEventIds = new Set([...durableOutbox.keys(), ...sessionOutbox.keys()]);
      if (knownEventIds.size !== durableOutbox.size + sessionOutbox.size) {
        throw new CronStorageError("Cron outbox contains duplicate event IDs");
      }
      const jobs = new Map<string, CronJob>([
        ...(includeDurable ? durableJobs : []),
        ...sessionJobs,
      ]);
      // durable and session events share the same capacity to prevent session-only events consuming process memory indefinitely.
      const capacityUsed = (includeDurable ? durableOutbox.size : 0) + sessionOutbox.size;
      let available = this.#outboxCapacity - capacityUsed;
      const created: CronEvent[] = [];
      for (const job of [...jobs.values()]
        .filter((candidate) => candidate.nextRunAtUtc.getTime() <= nowUtc.getTime())
        .sort(
          (left, right) =>
            left.nextRunAtUtc.getTime() - right.nextRunAtUtc.getTime() ||
            left.id.localeCompare(right.id),
        )) {
        if (available <= 0) break;
        const eventId = this.#nextId(this.#eventIdGenerator, "Cron event");
        if (knownEventIds.has(eventId)) {
          throw new CronStorageError(`Cron event id already exists: ${eventId}`);
        }
        const event = createCronEvent({
          eventId,
          jobId: job.id,
          identity: job.identity,
          prompt: job.prompt,
          timezone: job.timezone,
          durable: job.durable,
          slotAtUtc: new Date(job.nextRunAtUtc),
        });
        if (job.durable) durableOutbox.set(eventId, event);
        else sessionOutbox.set(eventId, event);
        knownEventIds.add(eventId);
        if (job.recurring) {
          const updated = Object.freeze({
            ...job,
            lastSlotAtUtc: new Date(job.nextRunAtUtc),
            nextRunAtUtc: nextCronOccurrence(job.cron, job.timezone, nowUtc),
          });
          if (job.durable) durableJobs.set(job.id, updated);
          else sessionJobs.set(job.id, updated);
        } else if (job.durable) durableJobs.delete(job.id);
        else sessionJobs.delete(job.id);
        created.push(event);
        available -= 1;
      }
      // Write state.json only when durable events occur; session-only state does not persist to disk.
      if (created.some((event) => event.durable))
        await this.#persist(paths, {
          version: STATE_VERSION,
          jobs: [...durableJobs.values()],
          outbox: [...durableOutbox.values()],
        });
      this.#sessionJobs.clear();
      for (const [id, job] of sessionJobs) this.#sessionJobs.set(id, job);
      this.#sessionOutbox.clear();
      for (const [id, event] of sessionOutbox) this.#sessionOutbox.set(id, event);
      return Object.freeze(created);
    });
  }

  // Returns an unacknowledged outbox snapshot sorted by slot and event ID.
  async pendingEvents(includeDurable = true): Promise<readonly CronEvent[]> {
    if (typeof includeDurable !== "boolean")
      throw new TypeError("includeDurable must be a boolean");
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [
          ...(includeDurable ? (await this.#loadState(paths)).outbox : []),
          ...this.#sessionOutbox.values(),
        ].sort(
          (left, right) =>
            left.slotAtUtc.getTime() - right.slotAtUtc.getTime() ||
            left.eventId.localeCompare(right.eventId),
        ),
      ),
    );
  }
  // Deletes events from outbox of corresponding lifecycle; returns false when missing so runtime can detect lost acknowledgments.
  async ackEvent(eventId: string): Promise<boolean> {
    const id = this.#lookupEventId(eventId);
    const paths = await this.#preparePaths(false);
    return await this.#withLock(paths, async () => {
      const state = await this.#loadState(paths);
      // ack deletes the session outbox first; durable events must atomically commit the snapshot after deletion.
      if (this.#sessionOutbox.delete(id)) return true;
      if (!state.outbox.some((event) => event.eventId === id)) return false;
      await this.#persist(paths, {
        ...state,
        outbox: state.outbox.filter((event) => event.eventId !== id),
      });
      return true;
    });
  }
  // Non-blocking acquisition of durable scheduler leader lease; repeated acquisition by the same instance also returns false.
  async tryAcquireLeader(): Promise<boolean> {
    if (this.#leaderRelease !== undefined) return false;
    const paths = await this.#preparePaths(true);
    let release: (() => Promise<void>) | undefined;
    try {
      // leader lock attempts once non-blocking; failure indicates another scheduler already manages durable jobs.
      release = await acquireLock(paths.leader, {
        realpath: true,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: 0,
      });
    } catch (error) {
      if (hasCode(error, "ELOCKED") || hasCode(error, "EEXIST")) return false;
      throw new CronStorageError("Cron leader lock could not be acquired", { cause: error });
    }
    this.#leaderRelease = release;
    return true;
  }
  // Idempotently release the leader lease and wrap underlying release failures as storage errors.
  async releaseLeader(): Promise<void> {
    if (this.#leaderRelease === undefined) return;
    const release = this.#leaderRelease;
    this.#leaderRelease = undefined;
    try {
      await release();
    } catch (error) {
      throw new CronStorageError("Cron leader lock could not be released", { cause: error });
    }
  }

  // Construct and validate all state paths; allow missing directories when create=false.
  async #preparePaths(create: boolean): Promise<CronPaths> {
    // The state path is fixed under workspace/.agent_tutorial and is validated not to escape workspace before creation or reading.
    try {
      const workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("workspace is not a directory");
      const stateRoot = join(workspace, ".agent_tutorial");
      const root = join(stateRoot, "cron");
      const leader = join(root, "leader");
      if (create) {
        await mkdir(stateRoot, { recursive: true });
        await validateDirectory(workspace, stateRoot, "Cron state root");
        await mkdir(root, { recursive: true });
        await validateDirectory(workspace, root, "Cron state root");
        await mkdir(leader, { recursive: true });
        await validateDirectory(workspace, leader, "Cron leader root");
      } else if (await exists(stateRoot)) {
        await validateDirectory(workspace, stateRoot, "Cron state root");
      }
      const paths = Object.freeze({
        workspace,
        stateRoot,
        root,
        state: join(root, "state.json"),
        lock: join(stateRoot, ".cron.lock"),
        leader,
      });
      if (!(await exists(root))) return paths;
      await validateDirectory(workspace, root, "Cron state root");
      if ((await exists(paths.lock)) && (await lstat(paths.lock)).isSymbolicLink()) {
        throw new CronStorageError("Cron state lock path must not be a symbolic link");
      }
      return paths;
    } catch (error) {
      if (error instanceof CronError) throw error;
      throw new CronStorageError("Cron state root is invalid", { cause: error });
    }
  }
  // Wrap a complete snapshot operation with an in-process queue and an inter-process directory lock.
  async #withLock<T>(paths: CronPaths, operation: () => Promise<T>): Promise<T> {
    // Dual serialization with in-process mutex and proper-lockfile directory lock ensures only one snapshot read-modify-write at any time.
    return await withMutex(paths.workspace, async () => {
      if (!(await exists(paths.root))) return await operation();
      let release: (() => Promise<void>) | undefined;
      try {
        for (
          let attempts = 0;
          attempts <= MAX_LOCK_RETRIES && release === undefined;
          attempts += 1
        ) {
          try {
            release = await acquireLock(paths.root, {
              lockfilePath: paths.lock,
              realpath: true,
              stale: LOCK_STALE_MS,
              update: LOCK_UPDATE_MS,
              retries: 0,
            });
          } catch (error) {
            if (
              (hasCode(error, "ELOCKED") || hasCode(error, "EEXIST")) &&
              attempts < MAX_LOCK_RETRIES
            ) {
              await delay(LOCK_RETRY_MS);
              continue;
            }
            throw error;
          }
        }
        if (release === undefined) {
          throw new CronStorageError("Cron state lock could not be acquired");
        }
        await validateDirectory(paths.workspace, paths.root, "Cron state root");
        return await operation();
      } catch (error) {
        if (error instanceof CronError) throw error;
        throw new CronStorageError("Cron state operation failed", { cause: error });
      } finally {
        if (release !== undefined) await release();
      }
    });
  }
  // Strictly reads durable snapshots; missing files equal empty state for the current version.
  async #loadState(paths: CronPaths): Promise<CronState> {
    if (!(await exists(paths.state))) return { version: STATE_VERSION, jobs: [], outbox: [] };
    try {
      // state.json is externally corruptible input; parse with strict schemas after reading, and fail explicitly on corrupt state.
      const details = await lstat(paths.state);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new CronStorageError("Cron state must be a regular file");
      }
      const value: unknown = JSON.parse(UTF8_DECODER.decode(await readFile(paths.state)));
      return parseState(value);
    } catch (error) {
      if (error instanceof CronError) throw error;
      throw new CronStorageError("Cron state is invalid", { cause: error });
    }
  }
  // Serialize full durable state and replace atomically to avoid partial writes.
  async #persist(paths: CronPaths, state: CronState): Promise<void> {
    try {
      // Writes always use atomic replacement; submitted new snapshot and old bytes are mutually exclusive.
      await this.#atomicReplace(
        paths.state,
        Buffer.from(`${JSON.stringify(serializeState(state), null, 2)}\n`, "utf8"),
      );
    } catch (error) {
      if (error instanceof CronError) throw error;
      throw new CronStorageError("Cron state could not be persisted", { cause: error });
    }
  }
  #nextId(generator: () => string, label: string): string {
    // An injected generator provides the UUID, but the store still validates canonical format to avoid writing dirty IDs into state.
    try {
      return canonicalCronId(generator());
    } catch (error) {
      throw new CronStorageError(`${label} id generator returned an invalid UUID`, {
        cause: error,
      });
    }
  }
  // Format errors in query IDs consistently surface as job not found to avoid leaking storage implementation details.
  #lookupJobId(value: string): string {
    try {
      return canonicalCronId(value);
    } catch (_error) {
      throw new CronJobNotFoundError("Cron job id must be a canonical UUID");
    }
  }
  // The event ID for ack must be a canonical UUID; invalid formats violate the storage contract.
  #lookupEventId(value: string): string {
    try {
      return canonicalCronId(value);
    } catch (error) {
      throw new CronStorageError("Cron event id must be a canonical UUID", { cause: error });
    }
  }
}

function parseState(value: unknown): CronState {
  // Validates version, field set, types, UTC time, and immutable record constraints item by item when recovering from JSON.
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CronStorageError("Cron state is invalid");
  const record = value as Record<string, unknown>;
  requireExactKeys(record, ["version", "jobs", "outbox"], "Cron state");
  if (
    record.version !== STATE_VERSION ||
    !Array.isArray(record.jobs) ||
    !Array.isArray(record.outbox)
  )
    throw new CronStorageError("Cron state has an unsupported schema");
  let jobs: CronJob[];
  let outbox: CronEvent[];
  try {
    jobs = record.jobs.map(parseJob);
    outbox = record.outbox.map(parseEvent);
  } catch (error) {
    if (error instanceof CronStorageError) throw error;
    throw new CronStorageError("Cron state contains invalid records", { cause: error });
  }
  if (
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    new Set(outbox.map((event) => event.eventId)).size !== outbox.length ||
    jobs.some((job) => !job.durable) ||
    outbox.some((event) => !event.durable)
  )
    throw new CronStorageError("Cron state contains invalid duplicate or non-durable records");
  return { version: STATE_VERSION, jobs, outbox };
}
// Recovers a single schedule from durable snapshot and revalidates expression, timezone, and slot monotonicity.
function parseJob(value: unknown): CronJob {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CronStorageError("Cron job is invalid");
  const record = value as Record<string, unknown>;
  requireExactKeys(
    record,
    [
      "id",
      "cron",
      "prompt",
      "timezone",
      "recurring",
      "durable",
      "identity",
      "next_run_at_utc",
      "last_slot_at_utc",
    ],
    "Cron job",
  );
  if (
    typeof record.id !== "string" ||
    typeof record.cron !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.timezone !== "string" ||
    typeof record.recurring !== "boolean" ||
    typeof record.durable !== "boolean" ||
    typeof record.identity !== "string" ||
    typeof record.next_run_at_utc !== "string" ||
    (record.last_slot_at_utc !== null && typeof record.last_slot_at_utc !== "string")
  )
    throw new CronStorageError("Cron job is invalid");
  const next = new Date(record.next_run_at_utc);
  const last = record.last_slot_at_utc === null ? null : new Date(record.last_slot_at_utc);
  validateCronExpression(record.cron);
  validateCronTimezone(record.timezone);
  if (
    !isUtcTimestamp(record.next_run_at_utc) ||
    (record.last_slot_at_utc !== null && !isUtcTimestamp(record.last_slot_at_utc)) ||
    Number.isNaN(next.valueOf()) ||
    (last !== null && Number.isNaN(last.valueOf())) ||
    (last !== null && next.valueOf() <= last.valueOf())
  )
    throw new CronStorageError("Cron job has invalid UTC timestamp");
  return Object.freeze({
    id: canonicalCronId(record.id),
    cron: validateCronExpression(record.cron),
    prompt: requireText(record.prompt, "Cron prompt"),
    timezone: validateCronTimezone(record.timezone),
    recurring: record.recurring,
    durable: record.durable,
    identity: requireText(record.identity, "Cron identity"),
    nextRunAtUtc: next,
    lastSlotAtUtc: last,
  });
}
// Recovers events from durable outbox and reconstructs RuntimeEvent methods and context fields.
function parseEvent(value: unknown): CronEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CronStorageError("Cron event is invalid");
  const record = value as Record<string, unknown>;
  requireExactKeys(
    record,
    ["event_id", "job_id", "identity", "prompt", "timezone", "durable", "slot_at_utc"],
    "Cron event",
  );
  if (
    typeof record.event_id !== "string" ||
    typeof record.job_id !== "string" ||
    typeof record.identity !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.timezone !== "string" ||
    typeof record.durable !== "boolean" ||
    typeof record.slot_at_utc !== "string"
  )
    throw new CronStorageError("Cron event is invalid");
  const slot = new Date(record.slot_at_utc);
  validateCronTimezone(record.timezone);
  if (!isUtcTimestamp(record.slot_at_utc) || Number.isNaN(slot.valueOf()))
    throw new CronStorageError("Cron event has invalid UTC timestamp");
  return createCronEvent({
    eventId: canonicalCronId(record.event_id),
    jobId: canonicalCronId(record.job_id),
    identity: requireText(record.identity, "Cron event identity"),
    prompt: requireText(record.prompt, "Cron event prompt"),
    timezone: validateCronTimezone(record.timezone),
    durable: record.durable,
    slotAtUtc: slot,
  });
}
function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  // The strict field set is part of the snapshot version; unknown fields make migration decisions guesswork, so fail directly.
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new CronStorageError(`${label} contains unsupported fields`);
  }
}
// Persisted times must explicitly include Z, rejecting strings that rely on environment timezone interpretations.
function isUtcTimestamp(value: string): boolean {
  return /Z$/u.test(value);
}
// Generates auditable state.json payload with stable field names and UTC ISO strings.
function serializeState(state: CronState): Record<string, unknown> {
  return {
    version: STATE_VERSION,
    jobs: state.jobs.map((job) => ({
      id: job.id,
      cron: job.cron,
      prompt: job.prompt,
      timezone: job.timezone,
      recurring: job.recurring,
      durable: job.durable,
      identity: job.identity,
      next_run_at_utc: job.nextRunAtUtc.toISOString(),
      last_slot_at_utc: job.lastSlotAtUtc?.toISOString() ?? null,
    })),
    outbox: state.outbox.map((event) => ({
      event_id: event.eventId,
      job_id: event.jobId,
      identity: event.identity,
      prompt: event.prompt,
      timezone: event.timezone,
      durable: event.durable,
      slot_at_utc: event.slotAtUtc.toISOString(),
    })),
  };
}
// Uniformly validate and trim required text fields in plans.
function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new CronStorageError(`${label} must not be empty`);
  return value.trim();
}
// Safely read Node/proper-lockfile error codes.
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
async function validateDirectory(workspace: string, path: string, label: string): Promise<void> {
  // The state directory must be a real directory inside the workspace to prevent symlinks or relative paths from writing state outside.
  const resolved = await realpath(path);
  const relativePath = relative(workspace, resolved);
  if (
    (relativePath !== "" && (relativePath.startsWith("..") || isAbsolute(relativePath))) ||
    !(await stat(resolved)).isDirectory()
  )
    throw new CronStorageError(`${label} escapes workspace or is not a directory`);
}
async function withMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // Use a Promise queue to serialize operations on the same workspace within the process, preventing concurrent operations from overwriting memory state.
  const previous = PROCESS_LOCK_TAILS.get(key);
  const result = previous === undefined ? operation() : previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  PROCESS_LOCK_TAILS.set(key, tail);
  try {
    return await result;
  } finally {
    if (PROCESS_LOCK_TAILS.get(key) === tail) PROCESS_LOCK_TAILS.delete(key);
  }
}
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // Writes temporary file first, syncs, then renames; readers see only complete old snapshot or complete new snapshot.
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}
