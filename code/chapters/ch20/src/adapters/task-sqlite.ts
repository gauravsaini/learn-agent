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
import {
  canonicalGitObjectId,
  WorktreeAction,
  WorktreeBinding,
  WorktreeEvent,
  WorktreeStateError,
  WorktreeStatus,
} from "../features/worktrees.js";
import type { WorktreeStore } from "../features/worktrees.js";

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
const DATABASE_FILE = "tasks.sqlite3";
// Serialize operations by database path in the same process; cross-process coordination uses proper-lockfile file locks.
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();
let sqlPromise: Promise<SqlJsStatic> | undefined;

// SqliteTaskStore depends on an injectable clock to test time boundaries such as lease expiration.
export interface SqliteClock {
  now(): Date;
}

// Options allow tests to replace id, claim token, clock, and lease duration; production environments use random UUIDs and default 60-second leases.
export interface SqliteTaskStoreOptions {
  readonly idGenerator?: () => string;
  readonly claimTokenGenerator?: () => string;
  readonly clock?: SqliteClock;
  readonly leaseDurationMs?: number;
}

// All paths are restricted within the real workspace to prevent symlink or relative path escapes.
interface SqlitePaths {
  readonly workspace: string;
  readonly root: string;
  readonly database: string;
  readonly lock: string;
}

// Each transaction reconstructs the task graph from SQLite to ensure dependency order and constraints use the same snapshot.
interface TaskGraph {
  readonly tasks: ReadonlyMap<string, Task>;
  readonly order: readonly string[];
}

// SQLite retains task leases, worktree bindings, and immutable event audit records in the same atomic store.
export class SqliteTaskStore implements LeasedTaskStore, WorktreeStore {
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #claimTokenGenerator: () => string;
  readonly #clock: SqliteClock;
  readonly #leaseDurationMs: number;

  constructor(workspace: string, options: SqliteTaskStoreOptions = {}) {
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

  // SQLite data file is fixed under workspace/.agent_tutorial; lock file resides in the same directory as database.
  get databasePath(): string {
    return resolve(this.#workspaceInput, ".agent_tutorial", DATABASE_FILE);
  }

  // Writes dependency edges when creating tasks; duplicate IDs or missing dependencies fail directly within transaction.
  async createTask(input: CreateTaskInput): Promise<Task> {
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

  // Release expired leases before reading to ensure callers see valid task state.
  async getTask(taskId: string): Promise<Task> {
    const id = normalizeLookupId(taskId);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      return getExisting(loadGraph(database), id);
    });
  }

  // Return a frozen task list in creation order, matching the scan order of work stealing.
  async listTasks(): Promise<readonly Task[]> {
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

  async reserveWorktree(binding: WorktreeBinding): Promise<WorktreeBinding> {
    // binding write and reserve audit events stay in the same BEGIN IMMEDIATE transaction;
    // If event writing fails, rollback binding state together to prevent an intermediate state of "reserved without audit".
    if (!(binding instanceof WorktreeBinding)) {
      throw new TypeError("binding must be a WorktreeBinding");
    }
    if (binding.status !== WorktreeStatus.RESERVED) {
      throw new WorktreeStateError("New worktree binding must be reserved");
    }
    return await this.#transaction(true, (database) => {
      const task = getExisting(loadGraph(database), binding.taskId);
      if (task.status !== TaskStatus.PENDING) {
        throw new WorktreeStateError(
          `Task ${task.id} is ${task.status}; reserving a worktree requires pending`,
        );
      }
      try {
        database.run(
          "INSERT INTO worktree_bindings(task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, status, review_reason, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, NULL, 'reserved', NULL, ?, ?)",
          [
            binding.taskId,
            binding.name,
            binding.branch,
            binding.relativePath,
            binding.integrationRef,
            binding.baselineCommit,
            encodeDate(binding.createdAtUtc),
            encodeDate(binding.updatedAtUtc),
          ],
        );
      } catch (error) {
        throw new WorktreeStateError("Worktree task, name, branch, or path is already reserved", {
          cause: error,
        });
      }
      appendWorktreeEvent(database, WorktreeAction.RESERVE, binding);
      return binding;
    });
  }

  // Transition from reserved to active indicates worktree creation finished; subsequent automatic claims can then use this binding.
  async activateWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.RESERVED],
      target: WorktreeStatus.ACTIVE,
      action: WorktreeAction.CREATE,
      branchTip: options.branchTip,
      reason: null,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.PENDING,
    });
  }

  // Retains worktree after task completion for further integration or subsequent audit.
  async keepWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.ACTIVE],
      target: WorktreeStatus.KEPT,
      action: WorktreeAction.KEEP,
      branchTip: options.branchTip,
      reason: null,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.COMPLETED,
    });
  }

  // Retain review_reason when results require manual review, and permit transitions only from active.
  async markWorktreeNeedsReview(
    taskId: string,
    options: {
      readonly branchTip: string | null;
      readonly reason: string;
      readonly occurredAtUtc: Date;
    },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.ACTIVE],
      target: WorktreeStatus.NEEDS_REVIEW,
      action: WorktreeAction.NEEDS_REVIEW,
      branchTip: options.branchTip,
      reason: options.reason,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.COMPLETED,
    });
  }

  // Reserved worktrees or worktrees that need review can eventually be removed; bindings remain in the database as audit records.
  async markWorktreeRemoved(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.ACTIVE, WorktreeStatus.KEPT, WorktreeStatus.NEEDS_REVIEW],
      target: WorktreeStatus.REMOVED,
      action: WorktreeAction.REMOVE,
      branchTip: options.branchTip,
      reason: null,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.COMPLETED,
    });
  }

  // Reading binding uses the same normalized id as the task to avoid casing/format discrepancies bypassing constraints.
  async getWorktreeBinding(taskId: string): Promise<WorktreeBinding> {
    const id = normalizeLookupId(taskId);
    return await this.#transaction(true, (database) => loadWorktreeBinding(database, id));
  }

  // Event table is append-only, returning the full audit chain in ascending sequence order.
  async listWorktreeEvents(): Promise<readonly WorktreeEvent[]> {
    return await this.#transaction(true, (database) =>
      Object.freeze(
        queryRows(
          database,
          "SELECT sequence, action, status, task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, reason, created_at_utc FROM worktree_events ORDER BY sequence ASC",
        ).map((row) => worktreeEventFromRow(row)),
      ),
    );
  }

  // Manual claims and automatic claims share #claim to ensure consistent lease and token generation rules.
  async claimTask(taskId: string, owner: string): Promise<TaskClaim> {
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

  // Take the first ready task in task creation order. Skip tasks with incomplete dependencies.
  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
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

  async claimNextBound(owner: string): Promise<TaskClaim | undefined> {
    // Select ready tasks only from active worktree_bindings,
    // Ensure automatic claims and manual claims obey the same Worktree isolation prerequisite.
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      const graph = loadGraph(database);
      const active = new Set(
        queryRows(database, "SELECT task_id FROM worktree_bindings WHERE status = 'active'").map(
          (row) => requiredString(row.task_id, "worktree task id"),
        ),
      );
      for (const id of graph.order) {
        const task = graph.tasks.get(id);
        if (task === undefined || !active.has(id) || task.status !== TaskStatus.PENDING) continue;
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

  async lookupClaim(claimToken: string): Promise<TaskClaim | undefined> {
    // Queries task_claim_tokens first to check if token was ever generated; then queries tasks to check if it still holds in_progress lease.
    // A known token whose lease has disappeared is a contract error; must fail explicitly, cannot silently return undefined.
    const normalizedToken = canonicalClaimToken(claimToken);
    return await this.#transaction(true, (database) => {
      const known = queryRows(database, "SELECT task_id FROM task_claim_tokens WHERE token = ?", [
        normalizedToken,
      ])[0];
      if (known === undefined) return undefined;
      const now = this.#now();
      releaseExpired(database, now);
      const row = queryRows(
        database,
        "SELECT id, lease_expires_at_utc FROM tasks WHERE claim_token = ? AND status = 'in_progress'",
        [normalizedToken],
      )[0];
      if (row === undefined) {
        throw new TaskClaimError("claim token is known but no longer active");
      }
      const graph = loadGraph(database);
      const task = getExisting(graph, requiredString(row.id, "task id"));
      const lease = parseOptionalDate(row.lease_expires_at_utc);
      if (lease === null)
        throw new TaskStorageError("Active SQLite task claim has no lease expiry");
      return Object.freeze({ task, claimToken: normalizedToken, leaseExpiresAtUtc: lease });
    });
  }

  // Completion must match both owner and claim token, and unlock dependent completed TODO tasks after update.
  async completeTask(taskId: string, owner: string, claimToken: string): Promise<TaskCompletion> {
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

  // Generating the token and updating task state occur in the current transaction; checking UPDATE affected rows ensures only one owner succeeds.
  #claim(database: Database, graph: TaskGraph, task: Task, owner: string, now: Date): TaskClaim {
    if (task.status !== TaskStatus.PENDING) {
      throw new TaskStateError(`Task ${task.id} is ${task.status}; expected pending`);
    }
    const blockedBy = task.blockedBy.filter(
      (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
    );
    if (blockedBy.length > 0) throw new TaskBlockedError(task.id, blockedBy);
    const token = this.#nextClaimToken();
    const expiresAt = new Date(now.getTime() + this.#leaseDurationMs);
    try {
      database.run("INSERT INTO task_claim_tokens(token, task_id) VALUES (?, ?)", [token, task.id]);
    } catch (error) {
      throw new TaskStorageError("Generated claim token already exists", { cause: error });
    }
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

  // All worktree state migrations share this transaction path, uniformly validating task state, current state, and target constraints.
  async #transitionWorktree(
    taskId: string,
    options: {
      readonly expected: readonly WorktreeStatus[];
      readonly target: WorktreeStatus;
      readonly action: WorktreeAction;
      readonly branchTip: string | null;
      readonly reason: string | null;
      readonly occurredAtUtc: Date;
      readonly requiredTaskStatus: TaskStatus;
    },
  ): Promise<WorktreeBinding> {
    // binding writes and event inserts complete within the same SQLite transaction,
    // Rolls back entirely on any failure, ensuring audit facts always match current state.
    const normalized = normalizeLookupId(taskId);
    const occurredAt = validDate(options.occurredAtUtc);
    const branchTip = options.branchTip === null ? null : canonicalGitObjectId(options.branchTip);
    return await this.#transaction(true, (database) => {
      const graph = loadGraph(database);
      const task = getExisting(graph, normalized);
      if (task.status !== options.requiredTaskStatus) {
        throw new WorktreeStateError(
          `Task ${task.id} is ${task.status}; expected ${options.requiredTaskStatus}`,
        );
      }
      const current = loadWorktreeBinding(database, normalized);
      if (!options.expected.includes(current.status)) {
        throw new WorktreeStateError(
          `Worktree binding ${current.taskId} is ${current.status}; transition is not allowed`,
        );
      }
      const updated = new WorktreeBinding({
        taskId: current.taskId,
        name: current.name,
        branch: current.branch,
        relativePath: current.relativePath,
        integrationRef: current.integrationRef,
        baselineCommit: current.baselineCommit,
        branchTip: branchTip === null ? current.branchTip : branchTip,
        status: options.target,
        reviewReason: options.reason,
        createdAtUtc: current.createdAtUtc,
        updatedAtUtc: occurredAt,
      });
      const changed = database.run(
        "UPDATE worktree_bindings SET branch_tip = ?, status = ?, review_reason = ?, updated_at_utc = ? WHERE task_id = ? AND status = ?",
        [
          updated.branchTip,
          updated.status,
          updated.reviewReason,
          encodeDate(updated.updatedAtUtc),
          updated.taskId,
          current.status,
        ],
      );
      if (changed.getRowsModified() !== 1) {
        throw new WorktreeStateError("Worktree binding could not be atomically transitioned");
      }
      appendWorktreeEvent(database, options.action, updated);
      return updated;
    });
  }

  // Transaction acquires cross-process file lock first, then opens SQLite transaction with BEGIN IMMEDIATE to prevent concurrent writes from overwriting each other.
  async #transaction<T>(create: boolean, operation: (database: Database) => T): Promise<T> {
    const paths = await this.#preparePaths(create);
    if (paths === undefined) {
      throw new TaskStorageError("SQLite Task storage root is unavailable");
    }
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
          database.run("BEGIN IMMEDIATE");
          try {
            const result = operation(database);
            database.run("COMMIT");
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

  // Resolve real workspace and ensure .agent_tutorial directory exists; return undefined if read-only path is missing.
  async #preparePaths(create: boolean): Promise<SqlitePaths | undefined> {
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

  // Validate that paths are not replaced by symlinks before opening databases and lock files, preventing reads and writes outside the workspace.
  async #validatePaths(paths: SqlitePaths): Promise<void> {
    const rootInfo = await lstat(paths.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    const resolvedRoot = await realpath(paths.root);
    if (!pathIsInside(paths.workspace, resolvedRoot)) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    if (await pathExists(paths.database)) await validateDatabaseFile(paths);
    const lockInfo = await lstatIfExists(paths.lock);
    if (lockInfo?.isSymbolicLink()) {
      throw new TaskStorageError("SQLite Task lock path must not be a symbolic link");
    }
  }

  // Normalize all externally generated ids through canonicalTaskId, allowing the storage layer to accept canonical UUIDs only.
  #nextId(): string {
    try {
      return canonicalTaskId(this.#idGenerator());
    } catch (error) {
      throw new TaskGraphError("Generated task id must be a canonical UUID", { cause: error });
    }
  }

  // claim token also enforces canonical UUIDs to ensure stable lookupClaim keys.
  #nextClaimToken(): string {
    try {
      return canonicalClaimToken(this.#claimTokenGenerator());
    } catch (error) {
      if (error instanceof TaskStorageError) throw error;
      throw new TaskStorageError("Claim token generator returned an invalid UUID", {
        cause: error,
      });
    }
  }

  // Each transaction gets the current time from the injected clock to prevent tests from depending on real Date.now().
  #now(): Date {
    const value = this.#clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TaskStorageError("Work stealing clock returned an invalid time");
    }
    return new Date(value.getTime());
  }
}

async function openDatabase(paths: SqlitePaths): Promise<Database> {
  await validateDatabaseTargetBeforeOpen(paths);
  const SQL = await getSql();
  const database = await readDatabase(paths.database, SQL);
  try {
    database.run("PRAGMA foreign_keys = ON");
    // tasks CHECK solidifies lease state combinations; worktree_bindings guarantees uniqueness of name/branch/path;
    // worktree_events rejects UPDATE/DELETE using triggers to form an immutable audit chain.
    // The same database file saves tasks, claims, worktree bindings, and append-only audit events;
    // Constraints at the SQLite layer reject invalid state combinations and event rewrites directly.
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
      CREATE TABLE IF NOT EXISTS worktree_bindings(
        task_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL UNIQUE,
        integration_ref TEXT NOT NULL,
        baseline_commit TEXT NOT NULL,
        branch_tip TEXT,
        status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'kept', 'needs_review', 'removed')),
        review_reason TEXT,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        CHECK(
          (status = 'needs_review' AND review_reason IS NOT NULL)
          OR (status != 'needs_review' AND review_reason IS NULL)
        ),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS worktree_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL CHECK(action IN ('reserve', 'create', 'keep', 'needs_review', 'remove')),
        status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'kept', 'needs_review', 'removed')),
        task_id TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        integration_ref TEXT NOT NULL,
        baseline_commit TEXT NOT NULL,
        branch_tip TEXT,
        reason TEXT,
        created_at_utc TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TRIGGER IF NOT EXISTS worktree_events_reject_update
      BEFORE UPDATE ON worktree_events
      BEGIN
        SELECT RAISE(ABORT, 'worktree_events is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS worktree_events_reject_delete
      BEFORE DELETE ON worktree_events
      BEGIN
        SELECT RAISE(ABORT, 'worktree_events is append-only');
      END;
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

// Create an empty store if the file does not exist, otherwise read existing bytes. Upper layers wrap parse failures as TaskStorageError.
async function readDatabase(path: string, SQL: SqlJsStatic): Promise<Database> {
  try {
    const bytes = await readFile(path);
    return new SQL.Database(bytes);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return new SQL.Database();
    throw new TaskStorageError("SQLite Task database could not be read", { cause: error });
  }
}

// Lazily load sql.js WASM, initializing once only.
async function getSql(): Promise<SqlJsStatic> {
  if (sqlPromise === undefined) {
    sqlPromise = initSqlJs({
      locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
    });
  }
  return await sqlPromise;
}

// Writes temporary file first then renames, avoiding half-written databases on process interruption.
async function persistDatabase(path: string, content: Uint8Array): Promise<void> {
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

// Permit normal file databases only before opening; reject symlinks or directory targets.
async function validateDatabaseTargetBeforeOpen(paths: SqlitePaths): Promise<void> {
  const information = await lstatIfExists(paths.database);
  if (information === undefined) return;
  if (information.isSymbolicLink()) {
    throw new TaskStorageError("SQLite Task database escapes workspace or is not a regular file");
  }
  await validateDatabaseFile(paths);
}

// The database must reside in the workspace with nlink equal to 1 to prevent hard links from modification elsewhere.
async function validateDatabaseFile(paths: SqlitePaths): Promise<void> {
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

// Rebuilds full task graph from tasks and task_dependencies, and validates circular dependencies.
function loadGraph(database: Database): TaskGraph {
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

// Read the worktree binding by task_id. Throw an explicit state error if it does not exist.
function loadWorktreeBinding(database: Database, taskId: string): WorktreeBinding {
  const row = queryRows(
    database,
    "SELECT task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, status, review_reason, created_at_utc, updated_at_utc FROM worktree_bindings WHERE task_id = ?",
    [taskId],
  )[0];
  if (row === undefined) {
    throw new WorktreeStateError(`Task does not have a worktree binding: ${taskId}`);
  }
  try {
    return new WorktreeBinding({
      taskId: requiredString(row.task_id, "worktree task id"),
      name: requiredString(row.name, "worktree name"),
      branch: requiredString(row.branch, "worktree branch"),
      relativePath: requiredString(row.relative_path, "worktree path"),
      integrationRef: requiredString(row.integration_ref, "worktree integration ref"),
      baselineCommit: requiredString(row.baseline_commit, "worktree baseline commit"),
      branchTip: nullableString(row.branch_tip, "worktree branch tip"),
      status: requiredString(row.status, "worktree status") as WorktreeStatus,
      reviewReason: nullableString(row.review_reason, "worktree review reason"),
      createdAtUtc: parseRequiredDate(row.created_at_utc, "worktree creation time"),
      updatedAtUtc: parseRequiredDate(row.updated_at_utc, "worktree update time"),
    });
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskStorageError(`Persisted SQLite worktree binding is invalid: ${taskId}`, {
      cause: error,
    });
  }
}

// Parse audit event rows into WorktreeEvents; any field corruption fails the transaction.
function worktreeEventFromRow(row: Record<string, unknown>): WorktreeEvent {
  try {
    return new WorktreeEvent({
      sequence: requiredNumber(row.sequence, "worktree event sequence"),
      action: requiredString(row.action, "worktree event action") as WorktreeAction,
      status: requiredString(row.status, "worktree event status") as WorktreeStatus,
      taskId: requiredString(row.task_id, "worktree event task id"),
      name: requiredString(row.name, "worktree event name"),
      branch: requiredString(row.branch, "worktree event branch"),
      relativePath: requiredString(row.relative_path, "worktree event path"),
      integrationRef: requiredString(row.integration_ref, "worktree event integration ref"),
      baselineCommit: requiredString(row.baseline_commit, "worktree event baseline commit"),
      branchTip: nullableString(row.branch_tip, "worktree event branch tip"),
      reason: nullableString(row.reason, "worktree event reason"),
      createdAtUtc: parseRequiredDate(row.created_at_utc, "worktree event creation time"),
    });
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskStorageError("Persisted SQLite worktree event is invalid", { cause: error });
  }
}

// Read last_insert_rowid as an immutable sequence after inserting the event, and return the event for caller use.
function appendWorktreeEvent(
  database: Database,
  action: WorktreeAction,
  binding: WorktreeBinding,
): WorktreeEvent {
  const result = database.run(
    "INSERT INTO worktree_events(action, status, task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, reason, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      action,
      binding.status,
      binding.taskId,
      binding.name,
      binding.branch,
      binding.relativePath,
      binding.integrationRef,
      binding.baselineCommit,
      binding.branchTip,
      binding.reviewReason,
      encodeDate(binding.updatedAtUtc),
    ],
  );
  const sequence = queryRows(database, "SELECT last_insert_rowid() AS sequence")[0]?.sequence;
  const normalizedSequence = requiredNumber(sequence, "worktree event sequence");
  if (result.getRowsModified() !== 1 || normalizedSequence <= 0) {
    throw new TaskStorageError("SQLite worktree event did not receive a sequence");
  }
  return new WorktreeEvent({
    sequence: normalizedSequence,
    action,
    status: binding.status,
    taskId: binding.taskId,
    name: binding.name,
    branch: binding.branch,
    relativePath: binding.relativePath,
    integrationRef: binding.integrationRef,
    baselineCommit: binding.baselineCommit,
    branchTip: binding.branchTip,
    reason: binding.reviewReason,
    createdAtUtc: binding.updatedAtUtc,
  });
}

// Detect cycles and missing dependencies depth-first to ensure the graph can execute safely.
function validateGraph(tasks: ReadonlyMap<string, Task>): void {
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
  const task = graph.tasks.get(id);
  if (task === undefined) throw new TaskNotFoundError(`Task does not exist: ${id}`);
  return task;
}

// Return expired leases to pending before read/claim instead of waiting for callers to renew.
function releaseExpired(database: Database, now: Date): void {
  database.run(
    "UPDATE tasks SET status = 'pending', owner = NULL, claim_token = NULL, lease_expires_at_utc = NULL WHERE status = 'in_progress' AND lease_expires_at_utc IS NOT NULL AND lease_expires_at_utc <= ?",
    [encodeDate(now)],
  );
}

// Convert sql.js exec results into object arrays of column names to values; return [] for empty results.
function queryRows(
  database: Database,
  sql: string,
  params: readonly SqlParam[] = [],
): Record<string, unknown>[] {
  const result = database.exec(sql, [...params]);
  const first = result[0];
  if (first === undefined) return [];
  return first.values.map((values) =>
    Object.fromEntries(first.columns.map((column, index) => [column, values[index]])),
  );
}

type SqlParam = string | number | null;

// Dependencies must be canonical UUIDs and unique; duplicates or formatting errors fail before writing.
function normalizeDependencies(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw new TaskGraphError("Task dependencies must be an array");
  const normalized = values.map((value) => canonicalTaskId(value));
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("Task dependencies must be unique");
  }
  return Object.freeze(normalized);
}

// Query IDs use canonical formats to prevent caller input from directly entering SQL parameters.
function normalizeLookupId(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskNotFoundError("Task id must be a canonical UUID");
  }
}

// claim token and task id use the same UUID specification for idempotent replay.
function canonicalClaimToken(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskClaimError("Claim token must be a canonical UUID");
  }
}

// Persist time as ISO-8601 UTC text so leases can be compared lexicographically.
function encodeDate(value: Date): string {
  return value.toISOString();
}

// Nullable time field deserialization; non-null invalid times are treated directly as storage corruption.
function parseOptionalDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TaskStorageError("Persisted lease expiry is invalid");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TaskStorageError("Persisted lease expiry is invalid");
  return parsed;
}

// Required time fields cannot be missing; missing values indicate storage corruption.
function parseRequiredDate(value: unknown, label: string): Date {
  const parsed = parseOptionalDate(value);
  if (parsed === null) throw new TaskStorageError(`Persisted ${label} is invalid`);
  return parsed;
}

// Worktree transition times come from outside; validate here before persistence.
function validDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new WorktreeStateError("Worktree transition time must be a valid Date");
  }
  return new Date(value.getTime());
}

// Validate persisted row fields uniformly by type, returning strongly typed values or throwing storage corruption errors.
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TaskStorageError(`Persisted ${label} is invalid`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TaskStorageError(`Persisted ${label} is invalid`);
  }
  return value;
}

// In-process Promise chain serializes the same database to prevent concurrent operations in the same process from bypassing file lock ordering.
async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
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

// Use path.relative to check whether the target is inside parent, which is more reliable than string prefixes.
function pathIsInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

// A single lstat gets both existence and metadata: returns undefined if the path does not exist, and throws other IO errors.
// Callers avoid two syscalls of "probe existence then fetch metadata" -- releasing lock files between them triggers false errors.
async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

// Convert ENOENT to false; continue throwing other IO errors.
async function pathExists(path: string): Promise<boolean> {
  return (await lstatIfExists(path)) !== undefined;
}

// Reads code from any Error-like object for Windows file lock race condition checks.
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

// On Windows, renaming or deleting lock files can briefly return EBUSY/ENOTEMPTY/EPERM; these errors are retriable.
function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

// Short wait before retrying on file lock contention.
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
