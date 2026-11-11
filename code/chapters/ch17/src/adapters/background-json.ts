// JSON background task adapter: persists running/terminal states to a safe directory inside workspace, guaranteeing consistent state transitions via file locks and atomic replacement.
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

import type { ToolResult } from "../core/tools.js";
import { isToolResult, toolError, toolSuccess } from "../core/tools.js";
import {
  BackgroundError,
  BackgroundJob,
  BackgroundJobNotFoundError,
  BackgroundJobStatus,
  BackgroundStorageError,
  canonicalBackgroundId,
  type BackgroundJobStore,
  type BackgroundJobStatus as BackgroundJobStatusValue,
} from "../features/background.js";

// File locks not renewed for more than 30 seconds are stale. Renew every 10 seconds and retry every 10ms to balance low latency and disconnection recovery.
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
// On Windows, proper-lockfile temp directory contention appears as EBUSY/ENOTEMPTY/EPERM; provide limited retries here.
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
// Strict UTF-8 decoder fails explicitly on corrupted bytes during parsing instead of replacing them with invisible mojibake.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
// In-process lock queue: Operations on the same key are serialized via chained Promises to prevent in-process concurrency from bypassing cross-process file locks.
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

export interface JsonBackgroundJobStoreOptions {
  // Tests can inject an atomic replacement function to simulate disk write failures; defaults to temp file in same directory + rename.
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}

// The adapter writes running/final states of background jobs into JSON in the workspace; core depends only on the BackgroundJobStore interface.
interface BackgroundPaths {
  // Workspace root directory after realpath, used to verify all state paths do not escape.
  readonly workspace: string;
  // Runtime state root directory, located at workspace/.agent_tutorial.
  readonly stateRoot: string;
  // Background job JSON file directory.
  readonly root: string;
  // Inter-process file lock path.
  readonly lock: string;
}

export class JsonBackgroundJobStore implements BackgroundJobStore {
  // Workspace path from external input; re-resolve the real path on each operation.
  readonly #workspaceInput: string;
  // Atomic replacement write function; default implementation ensures readers never see partially written files.
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;

  // Validate external workspace and optional injection points; constructor does not access the file system.
  constructor(workspace: string, options: JsonBackgroundJobStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.atomicReplace !== undefined && typeof options.atomicReplace !== "function") {
      throw new TypeError("atomicReplace must be a function");
    }
    this.#workspaceInput = workspace;
    this.#atomicReplace =
      options.atomicReplace === undefined ? atomicReplace : options.atomicReplace;
  }

  // Create a unique running record inside the lock; allow Supervisor to start actual work only after successful persistence to disk.
  async createRunning(input: {
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
  }): Promise<BackgroundJob> {
    // Persists running first before allowing Supervisor to start worker; failures before start leave no recoverable jobs.
    const job = new BackgroundJob({
      id: input.jobId,
      sourceToolCallId: input.sourceToolCallId,
      toolName: input.toolName,
      status: BackgroundJobStatus.RUNNING,
      result: null,
    });
    const paths = await this.#preparePaths(true);
    if (paths === undefined) {
      throw new BackgroundStorageError("Background job root could not be created");
    }
    return await this.#withLock(paths, async () => {
      const jobs = await this.#loadJobs(paths);
      if (jobs.has(job.id)) {
        throw new BackgroundStorageError(`Background job id already exists: ${job.id}`);
      }
      await this.#persistJob(paths, job);
      return job;
    });
  }

  // Execute conditional writes of running -> final state for specified jobs; return undefined on race failure.
  async finishRunning(
    jobId: string,
    status: Exclude<BackgroundJobStatusValue, "running">,
    result: ToolResult,
  ): Promise<BackgroundJob | undefined> {
    // Conditional transition: return the terminal job only if disk state is still running; subsequent competitors return undefined.
    const id = normalizeLookupId(jobId);
    if (!isBackgroundJobStatus(status) || !isToolResult(result)) {
      throw new BackgroundStorageError("invalid terminal background job update");
    }
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const job = (await this.#loadJobs(paths)).get(id);
      if (job === undefined) {
        throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
      }
      if (job.status !== BackgroundJobStatus.RUNNING) {
        return undefined;
      }
      const terminal = new BackgroundJob({ ...job, status, result });
      await this.#persistJob(paths, terminal);
      return terminal;
    });
  }

  // Batch interrupt leftover running jobs on recovery, and return ordered snapshots of migrations that actually occurred.
  async interruptRunning(): Promise<readonly BackgroundJob[]> {
    // Process restart migrates leftover running jobs uniformly to interrupted, and emits an interruption event only once.
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      return [];
    }
    return await this.#withLock(paths, async () => {
      const interrupted: BackgroundJob[] = [];
      for (const job of [...(await this.#loadJobs(paths)).values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        if (job.status !== BackgroundJobStatus.RUNNING) {
          continue;
        }
        const terminal = new BackgroundJob({
          ...job,
          status: BackgroundJobStatus.INTERRUPTED,
          result: toolError(
            "background_interrupted",
            "Background job was interrupted by a previous process exit",
          ),
        });
        await this.#persistJob(paths, terminal);
        interrupted.push(terminal);
      }
      return Object.freeze(interrupted);
    });
  }

  // Read a single job under shared lock protection; format errors and non-existence map uniformly to not found.
  async getJob(jobId: string): Promise<BackgroundJob> {
    const id = normalizeLookupId(jobId);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const job = (await this.#loadJobs(paths)).get(id);
      if (job === undefined) {
        throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
      }
      return job;
    });
  }

  // Returns an immutable job snapshot sorted by canonical UUID; treats as an empty set when the storage directory is not yet created.
  async listJobs(): Promise<readonly BackgroundJob[]> {
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      return [];
    }
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [...(await this.#loadJobs(paths)).values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      ),
    );
  }

  // Parse and validate the state directory; missing directory when create=false indicates no jobs yet, not storage failure.
  async #preparePaths(create: boolean): Promise<BackgroundPaths | undefined> {
    // Resolve real paths and verify state directories remain inside workspace on every operation, rejecting symlink/junction escapes.
    try {
      const workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("workspace is not a directory");
      }
      const stateRoot = join(workspace, ".agent_tutorial");
      const root = join(stateRoot, "background");
      if (create) {
        await mkdir(stateRoot, { recursive: true });
        await validateDirectory(workspace, stateRoot, "runtime state root");
        await mkdir(root, { recursive: true });
      } else {
        if (!(await pathExists(stateRoot))) {
          return undefined;
        }
        await validateDirectory(workspace, stateRoot, "runtime state root");
        if (!(await pathExists(root))) {
          return undefined;
        }
      }
      const paths = Object.freeze({
        workspace,
        stateRoot,
        root,
        lock: join(stateRoot, ".background.lock"),
      });
      await validateDirectory(workspace, root, "Background job root");
      if ((await pathExists(paths.lock)) && (await lstat(paths.lock)).isSymbolicLink()) {
        throw new BackgroundStorageError("Background job lock path must not be a symbolic link");
      }
      return paths;
    } catch (error) {
      if (error instanceof BackgroundError) {
        throw error;
      }
      throw new BackgroundStorageError("Background job root is invalid", { cause: error });
    }
  }

  // Wrap a read-modify-write operation in in-process mutexes and cross-process file locks, wrapping infrastructure exceptions uniformly.
  async #withLock<T>(paths: BackgroundPaths, operation: () => Promise<T>): Promise<T> {
    // In-process queue and cross-process file lock make reading, condition evaluation, and writing into the same critical section.
    return await withProcessMutex(paths.root, async () => {
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
        await validateDirectory(paths.workspace, paths.root, "Background job root");
        return await operation();
      } catch (error) {
        if (error instanceof BackgroundError) {
          throw error;
        }
        throw new BackgroundStorageError("Background job storage operation failed", {
          cause: error,
        });
      } finally {
        if (release !== undefined) {
          await release();
        }
      }
    });
  }

  // Load and validate the complete directory snapshot; refuse partial trusted results when any file is corrupted.
  async #loadJobs(paths: BackgroundPaths): Promise<Map<string, BackgroundJob>> {
    // Validate file name, payload id, UTF-8, JSON schema, and state invariants on load; any corrupted file fails the whole batch.
    let entries: readonly Dirent[];
    try {
      entries = (await readdir(paths.root, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".json"))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      throw new BackgroundStorageError("Background job directory could not be listed", {
        cause: error,
      });
    }
    const jobs = new Map<string, BackgroundJob>();
    for (const entry of entries) {
      const path = join(paths.root, entry.name);
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new BackgroundStorageError(`Background job file is not regular: ${entry.name}`);
      }
      let job: BackgroundJob;
      try {
        const expectedId = canonicalBackgroundId(entry.name.slice(0, -5));
        job = parseStoredJob(JSON.parse(UTF8_DECODER.decode(await readFile(path))) as unknown);
        if (job.id !== expectedId) {
          throw new BackgroundStorageError(
            `Background job filename does not match payload id: ${entry.name}`,
          );
        }
      } catch (error) {
        if (error instanceof BackgroundError) {
          throw error;
        }
        throw new BackgroundStorageError(`Background job file is invalid: ${entry.name}`, {
          cause: error,
        });
      }
      if (jobs.has(job.id)) {
        throw new BackgroundStorageError(`Duplicate persisted background job id: ${job.id}`);
      }
      jobs.set(job.id, job);
    }
    return jobs;
  }

  // Atomically replaces single job file with stable JSON structure, preserving old file until new content is fully written.
  async #persistJob(paths: BackgroundPaths, job: BackgroundJob): Promise<void> {
    // Persists JSON with stable field ordering via atomic replacement; old file remains unchanged on failure.
    const payload = {
      id: job.id,
      result:
        job.result === null
          ? null
          : {
              content: job.result.content,
              error_code: job.result.errorCode ?? null,
              is_error: job.result.isError,
            },
      source_tool_call_id: job.sourceToolCallId,
      status: job.status,
      tool_name: job.toolName,
    };
    try {
      await this.#atomicReplace(
        join(paths.root, `${job.id}.json`),
        Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"),
      );
    } catch (error) {
      if (error instanceof BackgroundError) {
        throw error;
      }
      throw new BackgroundStorageError(`Could not persist background job ${job.id}`, {
        cause: error,
      });
    }
  }
}

function parseStoredJob(value: unknown): BackgroundJob {
  // On-disk results undergo strict schema validation before normalization into ToolResult; the presentation layer strips the Error prefix.
  if (!hasExactKeys(value, ["id", "source_tool_call_id", "tool_name", "status", "result"])) {
    throw new BackgroundStorageError("Background job file has an invalid schema");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.source_tool_call_id !== "string" ||
    typeof value.tool_name !== "string" ||
    !isBackgroundJobStatus(value.status)
  ) {
    throw new BackgroundStorageError("Background job file has invalid fields");
  }
  let result: ToolResult | null = null;
  if (value.result !== null) {
    if (
      !hasExactKeys(value.result, ["content", "error_code", "is_error"]) ||
      typeof value.result.content !== "string" ||
      typeof value.result.is_error !== "boolean" ||
      (value.result.error_code !== null && typeof value.result.error_code !== "string")
    ) {
      throw new BackgroundStorageError("Background job file has invalid result");
    }
    if (value.result.is_error && typeof value.result.error_code !== "string") {
      throw new BackgroundStorageError("Background job error result requires error_code");
    }
    if (!value.result.is_error && value.result.error_code !== null) {
      throw new BackgroundStorageError("Successful background job result cannot have error_code");
    }
    if (value.result.is_error) {
      const errorCode = value.result.error_code;
      if (typeof errorCode !== "string") {
        throw new BackgroundStorageError("Background job error result requires error_code");
      }
      result = toolError(errorCode, value.result.content.replace(/^Error \[[^\]]+\]: /u, ""));
    } else {
      result = toolSuccess(value.result.content);
    }
  }
  return new BackgroundJob({
    id: value.id,
    sourceToolCallId: value.source_tool_call_id,
    toolName: value.tool_name,
    status: value.status,
    result,
  });
}

// Canonicalization failure of query IDs consistently converts to not found to avoid exposing format errors as storage errors.
function normalizeLookupId(value: string): string {
  try {
    return canonicalBackgroundId(value);
  } catch (_error) {
    throw new BackgroundJobNotFoundError("Background job id must be a canonical UUID");
  }
}

// On-disk JSON must contain exactly the expected fields; treat extra or missing fields as corruption.
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

// Execute realpath on directories before validating workspace ownership to prevent symlinks or junctions from bypassing path boundaries.
async function validateDirectory(workspace: string, path: string, label: string): Promise<void> {
  const resolved = await realpath(path);
  if (!pathIsInside(workspace, resolved) || !(await stat(resolved)).isDirectory()) {
    throw new BackgroundStorageError(`${label} escapes workspace or is not a directory`);
  }
}

// Interpret only ENOENT as non-existent; forward permission and I/O errors to higher-level storage boundaries.
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

// Returns true only if the relative path is empty or inside parent; rejects absolute paths and ../ escapes.
function pathIsInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

// Calls to the same state directory share a Promise tail queue, avoiding concurrent file lock contention in this process.
async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // In-process locks serialize concurrent calls to the same store; cross-process concurrency is guaranteed by proper-lockfile file locks.
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

// Achieves single-file atomic replacement using sibling temporary file, fsync, and rename, always cleaning up the temporary file.
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // Fsync temporary files in the same directory before rename, so final paths never expose partially written content.
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

// Safely read the code field on Node error objects to identify retryable filesystem errors.
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

// Set of race errors when cleaning up or renaming Windows lock files.
function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

// Brief wait between lock contention and retries.
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// Persisted states must be one of six state literals; unknown strings cannot enter domain objects.
function isBackgroundJobStatus(value: unknown): value is BackgroundJobStatusValue {
  return Object.values(BackgroundJobStatus).some((status) => status === value);
}
