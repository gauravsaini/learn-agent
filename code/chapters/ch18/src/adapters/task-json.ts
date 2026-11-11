// JsonTaskStore persists P12 task DAG to workspace .agent_tutorial/.tasks and serializes state transitions with file locks.
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { lock as acquireFileLock } from "proper-lockfile";

import {
  canonicalTaskId,
  normalizeOwner,
  Task,
  TaskBlockedError,
  TaskError,
  TaskGraphError,
  TaskNotFoundError,
  TaskOwnershipError,
  TaskStateError,
  TaskStatus,
  TaskStorageError,
} from "../features/tasks.js";
import type { CreateTaskInput, TaskCompletion, TaskStore } from "../features/tasks.js";

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

// JSON adapter serializes read-modify-writes via in-process queue and cross-process lock, publishing graph snapshots by atomic replacement.
interface JsonTaskPaths {
  readonly workspace: string;
  readonly root: string;
  readonly tasks: string;
  readonly lock: string;
}

export interface JsonTaskStoreOptions {
  readonly idGenerator?: () => string;
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}

export class JsonTaskStore implements TaskStore {
  // Reload, validate, and persist the complete task graph within the same lock on each state transition.
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;

  constructor(workspace: string, options: JsonTaskStoreOptions = {}) {
    // Constructor validates only external boundaries; idGenerator and atomicReplace are test-injectable determinism and failure injection points.
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }
    if (options.atomicReplace !== undefined && typeof options.atomicReplace !== "function") {
      throw new TypeError("atomicReplace must be a function");
    }
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#atomicReplace = options.atomicReplace ?? atomicReplace;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    // createTask reloads the graph within the lock, verifies acyclicity and unique IDs, then atomically writes tasks.
    const paths = await this.#preparePaths(true);
    if (paths === undefined) {
      throw new TaskStorageError("Task storage root could not be created");
    }
    return await this.#withLock(paths, async () => {
      // Reconstructs the entire graph within the lock, deciding whether to write in order: "no collision -> dependency exists -> no self-dependency -> entire graph acyclic".
      const graph = await this.#loadGraph(paths);
      const id = this.#generatedId();
      if (graph.has(id)) {
        throw new TaskGraphError(`task id already exists: ${id}`);
      }
      const task = new Task({
        id,
        subject: input.subject,
        description: input.description === undefined ? "" : input.description,
        status: TaskStatus.PENDING,
        owner: null,
        blockedBy: input.blockedBy === undefined ? [] : input.blockedBy,
      });
      const candidate = new Map(graph);
      candidate.set(task.id, task);
      validateGraph(candidate);
      await this.#writeTask(paths, task);
      return task;
    });
  }

  async getTask(taskId: string): Promise<Task> {
    const id = canonicalTaskId(taskId);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new TaskNotFoundError(`Task not found: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      // Re-reads the entire graph and recalculates blocking within the lock: Even if a task outside the lock just became ready, only the latest graph is visible in the critical section.
      const task = (await this.#loadGraph(paths)).get(id);
      if (task === undefined) {
        throw new TaskNotFoundError(`Task not found: ${id}`);
      }
      return task;
    });
  }

  async listTasks(): Promise<readonly Task[]> {
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      return Object.freeze([]);
    }
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [...(await this.#loadGraph(paths)).values()].sort((left, right) =>
          compareText(left.id, right.id),
        ),
      ),
    );
  }

  async claimTask(taskId: string, owner: string): Promise<Task> {
    const id = canonicalTaskId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new TaskNotFoundError(`Task not found: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const graph = await this.#loadGraph(paths);
      const task = graph.get(id);
      if (task === undefined) {
        throw new TaskNotFoundError(`Task not found: ${id}`);
      }
      if (task.status !== TaskStatus.PENDING) {
        throw new TaskStateError(`Task ${id} must be pending to claim`);
      }
      const blockedBy = task.blockedBy.filter((dependency) => {
        const dependencyTask = graph.get(dependency);
        return dependencyTask === undefined || dependencyTask.status !== TaskStatus.COMPLETED;
      });
      if (blockedBy.length > 0) {
        throw new TaskBlockedError(id, blockedBy);
      }
      const claimed = new Task({ ...task, status: TaskStatus.IN_PROGRESS, owner: normalizedOwner });
      await this.#writeTask(paths, claimed);
      return claimed;
    });
  }

  async completeTask(taskId: string, owner: string): Promise<TaskCompletion> {
    const id = canonicalTaskId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new TaskNotFoundError(`Task not found: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const graph = await this.#loadGraph(paths);
      const task = graph.get(id);
      if (task === undefined) {
        throw new TaskNotFoundError(`Task not found: ${id}`);
      }
      if (task.status !== TaskStatus.IN_PROGRESS) {
        throw new TaskStateError(`Task ${id} must be in_progress to complete`);
      }
      if (task.owner !== normalizedOwner) {
        throw new TaskOwnershipError(`Task ${id} is owned by ${task.owner}`);
      }
      const completed = new Task({ ...task, status: TaskStatus.COMPLETED });
      const candidate = new Map(graph);
      candidate.set(id, completed);
      // Report only pending Tasks whose direct dependencies finished and all dependencies are completed; do not rewrite downstream files.
      const unblocked = [...candidate.values()]
        .filter(
          (dependent) =>
            dependent.status === TaskStatus.PENDING &&
            dependent.blockedBy.includes(id) &&
            dependent.blockedBy.every(
              (dependency) => candidate.get(dependency)?.status === TaskStatus.COMPLETED,
            ),
        )
        .sort((left, right) => compareText(left.id, right.id));
      await this.#writeTask(paths, completed);
      return Object.freeze({ task: completed, unblocked: Object.freeze(unblocked) });
    });
  }

  async #preparePaths(create: boolean): Promise<JsonTaskPaths | undefined> {
    // Re-resolve realpath of workspace and verify .agent_tutorial/.tasks has not escaped on every operation.
    let workspace: string;
    try {
      workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("workspace is not a directory");
      }
      const root = join(workspace, ".agent_tutorial");
      const tasks = join(root, ".tasks");
      if (create) {
        await mkdir(root, { recursive: true });
        await this.#validateRoot(workspace, root);
        await mkdir(tasks, { recursive: true });
      } else {
        if (!(await pathExists(root))) {
          return undefined;
        }
        await this.#validateRoot(workspace, root);
        if (!(await pathExists(tasks))) {
          return undefined;
        }
      }
      const paths = Object.freeze({
        workspace,
        root,
        tasks,
        lock: join(workspace, ".agent_tutorial", ".tasks.lock"),
      });
      await this.#validatePaths(paths);
      return paths;
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      throw new TaskStorageError("Task storage root is invalid", { cause: error });
    }
  }

  async #validatePaths(paths: JsonTaskPaths): Promise<void> {
    // Revalidate physical paths of root/tasks/lock before each operation to prevent symlink escapes.
    await this.#validateRoot(paths.workspace, paths.root);
    let resolvedRoot: string;
    let resolvedTasks: string;
    try {
      resolvedRoot = await realpath(paths.root);
      resolvedTasks = await realpath(paths.tasks);
    } catch (error) {
      throw new TaskStorageError("Task storage root could not be resolved", { cause: error });
    }
    if (
      !pathIsInside(paths.workspace, resolvedRoot) ||
      !pathIsInside(resolvedRoot, resolvedTasks)
    ) {
      throw new TaskStorageError("Task storage root escapes workspace");
    }
    const rootInformation = await stat(resolvedRoot);
    const taskInformation = await stat(resolvedTasks);
    if (!rootInformation.isDirectory() || !taskInformation.isDirectory()) {
      throw new TaskStorageError("Task storage root is not a directory");
    }
    if (await pathExists(paths.lock)) {
      const lockInformation = await lstat(paths.lock);
      if (lockInformation.isSymbolicLink()) {
        throw new TaskStorageError("Task lock path must not be a symbolic link");
      }
    }
  }

  async #validateRoot(workspace: string, root: string): Promise<void> {
    // root must be a real directory within workspace; re-check after creation and before each read.
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch (error) {
      throw new TaskStorageError("Task storage root could not be resolved", { cause: error });
    }
    if (!pathIsInside(workspace, resolvedRoot)) {
      throw new TaskStorageError("Task storage root escapes workspace");
    }
    if (!(await stat(resolvedRoot)).isDirectory()) {
      throw new TaskStorageError("Task storage root is not a directory");
    }
  }

  async #withLock<T>(paths: JsonTaskPaths, operation: () => Promise<T>): Promise<T> {
    // In-process queue and cross-process file lock ensure read-modify-write on the same graph is a single critical section.
    return await withProcessMutex(paths.tasks, async () => {
      let release: (() => Promise<void>) | undefined;
      let windowsRaceRetries = 0;
      try {
        while (release === undefined) {
          try {
            release = await acquireFileLock(paths.tasks, {
              lockfilePath: paths.lock,
              realpath: true,
              stale: LOCK_STALE_MS,
              update: LOCK_UPDATE_MS,
              retries: 0,
            });
          } catch (error) {
            if (isWindowsLockRace(error) && windowsRaceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
              windowsRaceRetries += 1;
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
        return await operation();
      } catch (error) {
        if (error instanceof TaskError) {
          throw error;
        }
        throw new TaskStorageError("Task storage operation failed", { cause: error });
      } finally {
        if (release !== undefined) {
          await release();
        }
      }
    });
  }

  async #loadGraph(paths: JsonTaskPaths): Promise<Map<string, Task>> {
    // Reconstruction must load and validate the entire graph; any corrupted file causes the entire store to fail explicitly.
    let entries: readonly Dirent[];
    try {
      entries = (await readdir(paths.tasks, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".json"))
        .sort((left, right) => compareText(left.name, right.name));
    } catch (error) {
      throw new TaskStorageError("Task files could not be listed", { cause: error });
    }
    const graph = new Map<string, Task>();
    for (const entry of entries) {
      const path = join(paths.tasks, entry.name);
      let task: Task;
      try {
        const information = await lstat(path);
        if (!information.isFile() || information.isSymbolicLink()) {
          throw new Error("Task file is not a regular file");
        }
        const payload = JSON.parse(UTF8_DECODER.decode(await readFile(path))) as unknown;
        task = parseStoredTask(payload);
      } catch (error) {
        if (error instanceof TaskStorageError) {
          throw new TaskStorageError(`Task file is invalid: ${entry.name}`, { cause: error });
        }
        if (error instanceof TaskError) {
          throw error;
        }
        throw new TaskStorageError(`Task file is invalid: ${entry.name}`, { cause: error });
      }
      if (entry.name !== `${task.id}.json`) {
        throw new TaskStorageError(`Task filename does not match payload id: ${entry.name}`);
      }
      if (graph.has(task.id)) {
        throw new TaskStorageError(`Duplicate task id: ${task.id}`);
      }
      graph.set(task.id, task);
    }
    validateGraph(graph);
    return graph;
  }

  async #writeTask(paths: JsonTaskPaths, task: Task): Promise<void> {
    // Save operations always use atomic replacement; old file remains unchanged on failure.
    try {
      await this.#atomicReplace(join(paths.tasks, `${task.id}.json`), serializeTask(task));
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      throw new TaskStorageError(`Task file persist failed: ${task.id}`, { cause: error });
    }
  }

  #generatedId(): string {
    let value: string;
    try {
      value = this.#idGenerator();
    } catch (error) {
      throw new TaskGraphError("task id generator failed", { cause: error });
    }
    try {
      return canonicalTaskId(value);
    } catch (error) {
      throw new TaskGraphError("generated task id must be a canonical UUID", { cause: error });
    }
  }
}

function parseStoredTask(value: unknown): Task {
  // The on-disk schema must match exactly six fields; extra or missing fields cause recovery of the entire graph to fail.
  if (!hasExactKeys(value, ["id", "subject", "description", "status", "owner", "blocked_by"])) {
    throw new TaskStorageError("Task file has an invalid schema");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.description !== "string"
  ) {
    throw new TaskStorageError("Task file has invalid string fields");
  }
  if (
    (value.owner !== null && typeof value.owner !== "string") ||
    !Array.isArray(value.blocked_by) ||
    !value.blocked_by.every((dependency): dependency is string => typeof dependency === "string")
  ) {
    throw new TaskStorageError("Task file has invalid owner or dependency fields");
  }
  try {
    return new Task({
      id: value.id,
      subject: value.subject,
      description: value.description,
      status: value.status as TaskStatus,
      owner: value.owner,
      blockedBy: value.blocked_by,
    });
  } catch (error) {
    if (error instanceof TaskStorageError) {
      throw error;
    }
    throw new TaskStorageError("Task file has invalid fields", { cause: error });
  }
}

function serializeTask(task: Task): Buffer {
  // Fix field order and trailing newline so task files remain diffable and auditable, avoiding random disk write drift.
  const payload = {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function validateGraph(graph: ReadonlyMap<string, Task>): void {
  // Validates dependency references and cycles before writing, ensuring subsequent claim/complete operations process only valid DAGs.
  for (const task of graph.values()) {
    for (const dependency of task.blockedBy) {
      if (dependency === task.id) {
        throw new TaskGraphError(`Task ${task.id} must not depend on itself`);
      }
      if (!graph.has(dependency)) {
        throw new TaskGraphError(`Task ${task.id} dependency does not exist: ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new TaskGraphError(`Task graph contains a cycle at ${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    const task = graph.get(id);
    if (task === undefined) {
      throw new TaskGraphError(`Task graph references missing task ${id}`);
    }
    for (const dependency of task.blockedBy) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of graph.values()) {
    visit(task.id);
  }
}

async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // Sync temporary files in the same directory before publishing via rename; final paths never expose partially written content.
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
    if (handle !== undefined) {
      await handle.close();
    }
    await rm(temporary, { force: true });
  }
}

async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // Concurrent operations in the same process also queue; file locks guarantee cross-process safety.
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
    if (PROCESS_LOCK_TAILS.get(key) === tail) {
      PROCESS_LOCK_TAILS.delete(key);
    }
  }
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function pathIsInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
