// SQLite task store: independently persists P17 DAG, leases, and claim tokens; each transaction completes atomically under process queue, file lock, and BEGIN IMMEDIATE.
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { lock as acquireFileLock } from "proper-lockfile";

import {
  canonicalTaskId,
  normalizeOwner,
  Task,
  TaskBlockedError,
  TaskError,
  TaskGraphError,
  TaskNotFoundError,
  TaskStateError,
  TaskStatus,
  TaskStorageError,
} from "../features/tasks.js";
import type { CreateTaskInput, TaskCompletion } from "../features/tasks.js";
import type { LeasedTaskStore, TaskClaim } from "../features/work-stealing.js";
import { TaskClaimError, TaskLeaseExpiredError } from "../features/work-stealing.js";

const require = createRequire(import.meta.url);

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
const DATABASE_FILE = "tasks.sqlite3";
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();
let sqlPromise: Promise<SqlJsStatic> | undefined;

// SQLite task repository is independent of earlier JSON graphs; each operation maintains dependencies, lease, and claim token within locks and transactions.
export interface SqliteClock {
  // Each transaction reads the current time only once, ensuring lease release, claim, and completion share the same time baseline.
  now(): Date;
}

export interface SqliteTaskStoreOptions {
  // Task ID, claim token, and clock are injectable to cover collision, expiration, and ordering tests stably.
  readonly idGenerator?: () => string;
  readonly claimTokenGenerator?: () => string;
  readonly clock?: SqliteClock;
  // Lease duration solidifies into an absolute deadline only during claim and does not change retroactively with runtime configuration.
  readonly leaseDurationMs?: number;
}

interface SqlitePaths {
  // Workspace root after realpath, used to reject database or lock path escapes.
  readonly workspace: string;
  // `.agent_tutorial` state root, also serving as the lock target for proper-lockfile.
  readonly root: string;
  // Single database file exported from sql.js.
  readonly database: string;
  // Inter-process write transaction lock; must not be a symlink.
  readonly lock: string;
}

interface TaskGraph {
  // Immutable task snapshot reconstructed from the database for the current transaction.
  readonly tasks: ReadonlyMap<string, Task>;
  // Stable creation order corresponding to SQLite sequence; claimNext and listings depend on this order.
  readonly order: readonly string[];
}

export class SqliteTaskStore implements LeasedTaskStore {
  // Claims use half-open leases: expired leases can be released, but completion must match the current claim token.
  // Constructor only saves paths and injected boundaries; create and validate database directory only on first operation.
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #claimTokenGenerator: () => string;
  readonly #clock: SqliteClock;
  readonly #leaseDurationMs: number;

  constructor(workspace: string, options: SqliteTaskStoreOptions = {}) {
    // Construction validates injected boundaries without creating directories or opening databases, preventing state files on configuration failures.
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }
    if (
      options.claimTokenGenerator !== undefined &&
      typeof options.claimTokenGenerator !== "function"
    ) {
      throw new TypeError("claimTokenGenerator must be a function");
    }
    if (options.clock !== undefined && typeof options.clock.now !== "function") {
      throw new TypeError("clock must implement now()");
    }
    const leaseDurationMs =
      options.leaseDurationMs === undefined ? 60_000 : options.leaseDurationMs;
    if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new RangeError("leaseDurationMs must be positive");
    }
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator === undefined ? randomUUID : options.idGenerator;
    this.#claimTokenGenerator =
      options.claimTokenGenerator === undefined ? randomUUID : options.claimTokenGenerator;
    this.#clock = options.clock === undefined ? { now: () => new Date() } : options.clock;
    this.#leaseDurationMs = leaseDurationMs;
  }

  get databasePath(): string {
    // This getter provides only predictable display paths; it performs realpath and security validation before actual access.
    return resolve(this.#workspaceInput, ".agent_tutorial", DATABASE_FILE);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    // Dependency existence, task insertion, and dependency order writes reside in the same transaction; any failure leaves no partial graph.
    const id = this.#nextId();
    const dependencies = normalizeDependencies(
      input.blockedBy === undefined ? [] : input.blockedBy,
    );
    if (dependencies.includes(id)) {
      throw new TaskGraphError(`Task ${id} cannot depend on itself`);
    }
    const task = new Task({
      id,
      subject: input.subject,
      description: input.description === undefined ? "" : input.description,
      status: TaskStatus.PENDING,
      owner: null,
      blockedBy: dependencies,
    });
    return await this.#transaction(true, (database) => {
      if (
        queryRows(database, "SELECT 1 AS present FROM tasks WHERE id = ?", [task.id]).length > 0
      ) {
        throw new TaskGraphError(`Task id already exists: ${task.id}`);
      }
      const missing = dependencies.filter(
        (dependency) =>
          queryRows(database, "SELECT 1 AS present FROM tasks WHERE id = ?", [dependency])
            .length === 0,
      );
      if (missing.length > 0) {
        throw new TaskGraphError(`Task dependency does not exist: ${missing.join(", ")}`);
      }
      database.run(
        "INSERT INTO tasks(id, subject, description, status, owner, claim_token, lease_expires_at_utc) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL)",
        [task.id, task.subject, task.description],
      );
      dependencies.forEach((dependency, position) => {
        database.run(
          "INSERT INTO task_dependencies(task_id, dependency_id, position) VALUES (?, ?, ?)",
          [task.id, dependency, position],
        );
      });
      return task;
    });
  }

  async getTask(taskId: string): Promise<Task> {
    // Release expired leases before reading so callers see current claimable state instead of stale in_progress.
    const id = normalizeLookupId(taskId);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      return getExisting(loadGraph(database), id);
    });
  }

  async listTasks(): Promise<readonly Task[]> {
    // Return order is fixed by the database sequence, independent of UUIDs or concurrent read order.
    return await this.#transaction(true, (database) => {
      releaseExpired(database, this.#now());
      const graph = loadGraph(database);
      return Object.freeze(
        graph.order.map((id) => {
          const task = graph.tasks.get(id);
          if (task === undefined) throw new TaskStorageError(`Task graph is missing: ${id}`);
          return task;
        }),
      );
    });
  }

  async claimTask(taskId: string, owner: string): Promise<TaskClaim> {
    // Manual claims and automatic claims share #claim, keeping dependency checks, tokens, and lease semantics consistent.
    const id = normalizeLookupId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      const graph = loadGraph(database);
      const task = getExisting(graph, id);
      return this.#claim(database, graph, task, normalizedOwner, now);
    });
  }

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    // Auto-claim selects the first ready task by stable creation order; returns undefined to enter idle polling when no candidates exist.
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
      // Releases expired leases first, then loads full DAG to find the first pending task with no unfinished dependencies in creation order.
      const now = this.#now();
      releaseExpired(database, now);
      const graph = loadGraph(database);
      for (const id of graph.order) {
        const task = graph.tasks.get(id);
        if (task === undefined || task.status !== TaskStatus.PENDING) continue;
        if (
          task.blockedBy.some(
            (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
          )
        ) {
          continue;
        }
        return this.#claim(database, graph, task, normalizedOwner, now);
      }
      return undefined;
    });
  }

  async completeTask(taskId: string, owner: string, claimToken: string): Promise<TaskCompletion> {
    // owner and token must both match the current lease; old tokens cannot complete re-claimed tasks even for the same owner.
    const id = normalizeLookupId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    const normalizedToken = canonicalClaimToken(claimToken);
    let expired = false;
    const outcome = await this.#transaction(true, (database) => {
      const now = this.#now();
      const current = queryRows(
        database,
        "SELECT status, owner, claim_token, lease_expires_at_utc FROM tasks WHERE id = ?",
        [id],
      )[0];
      if (current === undefined) throw new TaskNotFoundError(`Task does not exist: ${id}`);
      const lease = parseOptionalDate(current.lease_expires_at_utc);
      if (current.status === TaskStatus.IN_PROGRESS && lease !== null && now >= lease) {
        releaseExpired(database, now);
        expired = true;
        return undefined;
      }
      releaseExpired(database, now);
      const graph = loadGraph(database);
      const task = getExisting(graph, id);
      if (task.status !== TaskStatus.IN_PROGRESS) {
        throw new TaskStateError(`Task ${id} is ${task.status}; expected in_progress`);
      }
      if (task.owner !== normalizedOwner || current.claim_token !== normalizedToken) {
        throw new TaskClaimError(`Task ${id} owner or claim token does not match the active claim`);
      }
      const changed = database.run(
        "UPDATE tasks SET status = 'completed', claim_token = NULL, lease_expires_at_utc = NULL WHERE id = ? AND status = 'in_progress' AND owner = ? AND claim_token = ?",
        [id, normalizedOwner, normalizedToken],
      );
      if (changed.getRowsModified() !== 1) {
        throw new TaskClaimError(`Task ${id} owner or claim token does not match the active claim`);
      }
      const completed = new Task({ ...task, status: TaskStatus.COMPLETED });
      const unblocked = graph.order
        .map((candidateId) => graph.tasks.get(candidateId))
        .filter((candidate): candidate is Task => candidate !== undefined)
        .filter(
          (candidate) =>
            candidate.status === TaskStatus.PENDING &&
            candidate.blockedBy.includes(id) &&
            candidate.blockedBy.every(
              (dependency) =>
                dependency === id || graph.tasks.get(dependency)?.status === TaskStatus.COMPLETED,
            ),
        );
      return Object.freeze({ task: completed, unblocked: Object.freeze(unblocked) });
    });
    if (expired) throw new TaskLeaseExpiredError(`Task ${id} claim lease expired`);
    if (outcome === undefined) throw new TaskStorageError("Task completion produced no result");
    return outcome;
  }

  #claim(database: Database, graph: TaskGraph, task: Task, owner: string, now: Date): TaskClaim {
    // Call this method only inside BEGIN IMMEDIATE, grouping dependency check, token registration, and conditional update into one atomic claim step.
    if (task.status !== TaskStatus.PENDING) {
      throw new TaskStateError(`Task ${task.id} is ${task.status}; expected pending`);
    }
    const blockedBy = task.blockedBy.filter(
      (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
    );
    if (blockedBy.length > 0) throw new TaskBlockedError(task.id, blockedBy);
    const token = this.#nextClaimToken();
    const expiresAt = new Date(now.getTime() + this.#leaseDurationMs);
    // The historical token table guarantees tokens cannot be reused across their lifecycle; conflicts roll back the claim transaction.
    try {
      database.run("INSERT INTO task_claim_tokens(token, task_id) VALUES (?, ?)", [token, task.id]);
    } catch (error) {
      throw new TaskStorageError("Generated claim token already exists", { cause: error });
    }
    // Conditional UPDATE is the final exclusion point: even if concurrent scans see the same pending task, only one transaction can change it to in_progress.
    const changed = database.run(
      "UPDATE tasks SET status = 'in_progress', owner = ?, claim_token = ?, lease_expires_at_utc = ? WHERE id = ? AND status = 'pending' AND owner IS NULL",
      [owner, token, encodeDate(expiresAt), task.id],
    );
    if (changed.getRowsModified() !== 1) {
      throw new TaskStateError(`Task ${task.id} could not be atomically claimed`);
    }
    return Object.freeze({
      task: new Task({ ...task, status: TaskStatus.IN_PROGRESS, owner }),
      claimToken: token,
      leaseExpiresAtUtc: expiresAt,
    });
  }

  async #transaction<T>(create: boolean, operation: (database: Database) => T): Promise<T> {
    // All public operations converge here, uniformly executing path validation, three-layer mutexes, transaction commits, and atomic database flushes to disk.
    const paths = await this.#preparePaths(create);
    if (paths === undefined) {
      throw new TaskStorageError("SQLite Task storage root is unavailable");
    }
    // Three layers of mutual exclusion: in-process tail-chain, file lock, and BEGIN IMMEDIATE, which together prevent duplicate claims across processes.
    return await withProcessMutex(paths.database, async () => {
      let release: (() => Promise<void>) | undefined;
      let raceRetries = 0;
      try {
        while (release === undefined) {
          try {
            release = await acquireFileLock(paths.root, {
              lockfilePath: paths.lock,
              realpath: true,
              stale: LOCK_STALE_MS,
              update: LOCK_UPDATE_MS,
              retries: 0,
            });
          } catch (error) {
            if (isWindowsLockRace(error) && raceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
              raceRetries += 1;
              await delay(LOCK_RETRY_MS);
              continue;
            }
            if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ELOCKED")) {
              await delay(LOCK_RETRY_MS);
              continue;
            }
            throw error;
          }
        }
        await this.#validatePaths(paths);
        const database = await openDatabase(paths);
        try {
          // BEGIN IMMEDIATE acquires a reserved lock at write transaction start so "scan + conditional update" executes as an atomic step.
          database.run("BEGIN IMMEDIATE");
          try {
            const result = operation(database);
            database.run("COMMIT");
            // sql.js is an in-memory database; after commits, export and atomically replace on disk via temporary files.
            await persistDatabase(paths.database, database.export());
            return result;
          } catch (error) {
            try {
              database.run("ROLLBACK");
            } catch {
              // When the transaction has already failed, the original error has more diagnostic value.
            }
            if (error instanceof TaskError) throw error;
            throw new TaskStorageError("SQLite Task transaction failed", { cause: error });
          }
        } finally {
          database.close();
        }
      } catch (error) {
        if (error instanceof TaskError) throw error;
        throw new TaskStorageError("SQLite Task operation failed", { cause: error });
      } finally {
        if (release !== undefined) await release();
      }
    });
  }

  async #preparePaths(create: boolean): Promise<SqlitePaths | undefined> {
    // Read operations do not create storage directories; return undefined when missing, letting upper layers fail explicitly rather than creating databases out of nowhere.
    let workspace: string;
    try {
      workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("workspace is not a directory");
      const root = join(workspace, ".agent_tutorial");
      if (create) {
        await mkdir(root, { recursive: true });
      } else {
        try {
          await lstat(root);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) return undefined;
          throw error;
        }
      }
      const paths = Object.freeze({
        workspace,
        root,
        database: join(root, DATABASE_FILE),
        lock: join(root, `${DATABASE_FILE}.lock`),
      });
      await this.#validatePaths(paths);
      return paths;
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskStorageError("SQLite Task storage root is invalid", { cause: error });
    }
  }

  async #validatePaths(paths: SqlitePaths): Promise<void> {
    // Revalidate the real path before each locked operation to prevent directories from being replaced with symlinks during execution.
    // Workspaces, databases, and lock files are all restricted within the workspace after realpath; reject symlink paths directly.
    const rootInfo = await lstat(paths.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    const resolvedRoot = await realpath(paths.root);
    if (!pathIsInside(paths.workspace, resolvedRoot)) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    if (await pathExists(paths.database)) await validateDatabaseFile(paths);
    // Run lstat only once: if the lock file is released between checking existence and reading metadata, two syscalls report false errors.
    const lockInfo = await lstatIfExists(paths.lock);
    if (lockInfo?.isSymbolicLink()) {
      throw new TaskStorageError("SQLite Task lock path must not be a symbolic link");
    }
  }

  #nextId(): string {
    // Generator results must still pass domain UUID normalization; test doubles cannot bypass production constraints.
    try {
      return canonicalTaskId(this.#idGenerator());
    } catch (error) {
      throw new TaskGraphError("Generated task id must be a canonical UUID", { cause: error });
    }
  }

  #nextClaimToken(): string {
    // claim token and task ID use the same canonical UUID format, but keep separation of concerns through independent generators.
    try {
      return canonicalClaimToken(this.#claimTokenGenerator());
    } catch (error) {
      if (error instanceof TaskStorageError) throw error;
      throw new TaskStorageError("Claim token generator returned an invalid UUID", {
        cause: error,
      });
    }
  }

  #now(): Date {
    // Returns a copy to prevent mutable Date from leaking from the clock boundary into transaction state.
    const value = this.#clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TaskStorageError("Work stealing clock returned an invalid time");
    }
    return new Date(value.getTime());
  }
}

async function openDatabase(paths: SqlitePaths): Promise<Database> {
  // sql.js creates tables and validates schemas on each open, independent of external SQLite processes or legacy file formats.
  await validateDatabaseTargetBeforeOpen(paths);
  const SQL = await getSql();
  const database = await readDatabase(paths.database, SQL);
  try {
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE IF NOT EXISTS task_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO task_metadata(key, value) VALUES ('schema_version', '1');
      CREATE TABLE IF NOT EXISTS tasks(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed')),
        owner TEXT,
        claim_token TEXT UNIQUE,
        lease_expires_at_utc TEXT,
        CHECK(
          (status = 'pending' AND owner IS NULL AND claim_token IS NULL AND lease_expires_at_utc IS NULL)
          OR (status = 'in_progress' AND owner IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
          OR (status = 'completed' AND owner IS NOT NULL AND claim_token IS NULL AND lease_expires_at_utc IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS task_dependencies(
        task_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        PRIMARY KEY(task_id, dependency_id),
        UNIQUE(task_id, position),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(dependency_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS task_claim_tokens(
        token TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
    `);
    const version = queryRows(
      database,
      "SELECT value FROM task_metadata WHERE key = 'schema_version'",
    )[0]?.value;
    if (version !== "1") throw new TaskStorageError("Unsupported SQLite Task schema version");
    return database;
  } catch (error) {
    database.close();
    if (error instanceof TaskError) throw error;
    throw new TaskStorageError("SQLite Task database could not be opened", { cause: error });
  }
}

async function readDatabase(path: string, SQL: SqlJsStatic): Promise<Database> {
  // Missing file indicates the first transaction, creating an empty in-memory store. Other read errors must fail explicitly.
  try {
    const bytes = await readFile(path);
    return new SQL.Database(bytes);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return new SQL.Database();
    throw new TaskStorageError("SQLite Task database could not be read", { cause: error });
  }
}

async function getSql(): Promise<SqlJsStatic> {
  // WASM initialization runs only once per process; all store instances share the same loading Promise.
  if (sqlPromise === undefined) {
    sqlPromise = initSqlJs({
      locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
    });
  }
  return await sqlPromise;
}

async function persistDatabase(path: string, content: Uint8Array): Promise<void> {
  // Atomically renames temporary file after writing to prevent leaving half-written databases on process interruption.
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

async function validateDatabaseTargetBeforeOpen(paths: SqlitePaths): Promise<void> {
  // Pre-open checks prevent sql.js from following symlinks to read databases outside the workspace.
  const information = await lstatIfExists(paths.database);
  if (information === undefined) return;
  if (information.isSymbolicLink()) {
    throw new TaskStorageError("SQLite Task database escapes workspace or is not a regular file");
  }
  await validateDatabaseFile(paths);
}

async function validateDatabaseFile(paths: SqlitePaths): Promise<void> {
  // The database must be a regular file inside the workspace with no hard links and an unchanged real path.
  const resolved = await realpath(paths.database);
  const information = await stat(paths.database);
  if (
    !pathIsInside(paths.workspace, resolved) ||
    resolved !== paths.database ||
    !information.isFile() ||
    information.nlink !== 1
  ) {
    throw new TaskStorageError("SQLite Task database escapes workspace or is not a regular file");
  }
}

function loadGraph(database: Database): TaskGraph {
  // Reconstruct the task graph from both tables on every operation, preventing inter-process caches from reading submitted claims.
  const rows = queryRows(
    database,
    "SELECT id, subject, description, status, owner FROM tasks ORDER BY sequence ASC",
  );
  const dependencies = new Map<string, string[]>();
  for (const row of rows) dependencies.set(requiredString(row.id, "task id"), []);
  for (const row of queryRows(
    database,
    "SELECT task_id, dependency_id FROM task_dependencies ORDER BY task_id ASC, position ASC",
  )) {
    const taskId = requiredString(row.task_id, "dependency task id");
    const dependencyId = requiredString(row.dependency_id, "dependency id");
    const values = dependencies.get(taskId);
    if (values === undefined)
      throw new TaskGraphError(`Dependency references unknown task: ${taskId}`);
    values.push(dependencyId);
  }
  const tasks = new Map<string, Task>();
  const order: string[] = [];
  for (const row of rows) {
    const id = requiredString(row.id, "task id");
    const blockedBy = dependencies.get(id);
    if (blockedBy === undefined) {
      throw new TaskGraphError(`Task dependencies are missing: ${id}`);
    }
    try {
      const task = new Task({
        id,
        subject: requiredString(row.subject, "task subject"),
        description: requiredString(row.description, "task description"),
        status: row.status as TaskStatus,
        owner: row.owner === null ? null : requiredString(row.owner, "task owner"),
        blockedBy: Object.freeze([...blockedBy]),
      });
      tasks.set(task.id, task);
      order.push(task.id);
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskStorageError(`Persisted SQLite task is invalid: ${id}`, { cause: error });
    }
  }
  validateGraph(tasks);
  return Object.freeze({ tasks, order: Object.freeze(order) });
}

function validateGraph(tasks: ReadonlyMap<string, Task>): void {
  // Validate missing dependencies and cycles depth-first; if the persisted graph is corrupt, the entire transaction fails.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TaskGraphError(`Task graph contains a cycle at ${id}`);
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (task === undefined) throw new TaskGraphError(`Task graph references missing task ${id}`);
    visiting.add(id);
    for (const dependency of task.blockedBy) {
      if (!tasks.has(dependency))
        throw new TaskGraphError(`Task dependency does not exist: ${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
}

function getExisting(graph: TaskGraph, id: string): Task {
  // Domain layer uniformly maps non-existence to TaskNotFoundError, avoiding undefined handling in upper layers.
  const task = graph.tasks.get(id);
  if (task === undefined) throw new TaskNotFoundError(`Task does not exist: ${id}`);
  return task;
}

function releaseExpired(database: Database, now: Date): void {
  // lease is a half-open interval: when now reaches or exceeds deadline, atomically revert task to pending so other workers can re-claim.
  database.run(
    "UPDATE tasks SET status = 'pending', owner = NULL, claim_token = NULL, lease_expires_at_utc = NULL WHERE status = 'in_progress' AND lease_expires_at_utc IS NOT NULL AND lease_expires_at_utc <= ?",
    [encodeDate(now)],
  );
}

function queryRows(
  database: Database,
  sql: string,
  params: readonly SqlParam[] = [],
): Record<string, unknown>[] {
  // sql.js returns column names and value matrices; convert to untrusted objects here, where callers validate fields individually.
  const result = database.exec(sql, [...params]);
  const first = result[0];
  if (first === undefined) return [];
  return first.values.map((values) =>
    Object.fromEntries(first.columns.map((column, index) => [column, values[index]])),
  );
}

type SqlParam = string | number | null;

function normalizeDependencies(values: readonly string[]): readonly string[] {
  // Preserves caller order for tutorial display, but rejects duplicate dependencies and non-canonical UUIDs.
  if (!Array.isArray(values)) throw new TaskGraphError("Task dependencies must be an array");
  const normalized = values.map((value) => canonicalTaskId(value));
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("Task dependencies must be unique");
  }
  return Object.freeze(normalized);
}

function normalizeLookupId(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskNotFoundError("Task id must be a canonical UUID");
  }
}

function canonicalClaimToken(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskClaimError("Claim token must be a canonical UUID");
  }
}

function encodeDate(value: Date): string {
  return value.toISOString();
}

function parseOptionalDate(value: unknown): Date | null {
  // NULL indicates no active lease; non-empty values must be parseable timestamps.
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TaskStorageError("Persisted lease expiry is invalid");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TaskStorageError("Persisted lease expiry is invalid");
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  // Do not perform loose string conversions on database row fields. Mismatched types indicate storage corruption.
  if (typeof value !== "string") throw new TaskStorageError(`Persisted ${label} is invalid`);
  return value;
}

async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // Concurrent SQLite operations in the same process serialize by database path to avoid repeatedly entering file lock contention.
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

function pathIsInside(parent: string, child: string): boolean {
  // Uses relative paths to determine containment, avoiding misidentifying neighboring directories as subdirectories from simple string prefixes.
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
  // A single syscall gets both existence and metadata; the caller does not need an extra lstat.
  // Treats only ENOENT as non-existent; permission or I/O errors re-throw.
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstatIfExists(path)) !== undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function isWindowsLockRace(error: unknown): boolean {
  // On Windows, the lock file can disappear between check and open; retry only this transient race.
  // proper-lockfile can briefly encounter these errors during Windows lock file deletion/renaming; retry after a short wait.
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

async function delay(milliseconds: number): Promise<void> {
  // File lock contention uses fixed short waits to prevent synchronous busy loops from saturating the event loop.
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
