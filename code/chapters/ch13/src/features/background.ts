// Background task runtime: persistent Jobs serve as the state source; Supervisor manages capacity, cancellation, timeouts, and event publishing; Dispatcher only routes explicitly background-eligible tools.
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { isRuntimeEvent, type EventInbox } from "../core/events.js";
import type { RuntimeEvent } from "../core/events.js";
import type {
  PreparedToolCall,
  ToolContext,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../core/tools.js";
import { isToolResult, toolError, toolSuccess } from "../core/tools.js";
import type { BackgroundShellInput } from "./builtin-tools.js";

// Allowlist of keywords for long-running commands; when run_in_background is not explicitly specified, Dispatcher uses this to decide whether to run in background.
const BACKGROUND_MARKERS = Object.freeze([
  "cargo build",
  "compile",
  "deploy",
  "docker build",
  "npm install",
  "pip install",
  "pytest",
]);

// Canonical UUID for background jobs/events; acts as disk file name and event idempotency id, rejecting non-canonical inputs.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// Six background job states: running is the only active state, and the rest are terminal states; Supervisor and store jointly guarantee state transitions.
export const BackgroundJobStatus = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
} as const);
export type BackgroundJobStatus = (typeof BackgroundJobStatus)[keyof typeof BackgroundJobStatus];

// Common base class for background domain errors; errorCode is a stable error code returnable by the tool layer.
export class BackgroundError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackgroundError";
    this.errorCode = errorCode;
  }
}

// Background concurrency capacity is full; reject new jobs.
export class BackgroundCapacityError extends BackgroundError {
  constructor(message: string) {
    super("background_capacity", message);
    this.name = "BackgroundCapacityError";
  }
}

// Supervisor is closed; rejects new jobs.
export class BackgroundClosedError extends BackgroundError {
  constructor(message: string) {
    super("background_closed", message);
    this.name = "BackgroundClosedError";
  }
}

// Cannot find a persisted background job by canonical ID.
export class BackgroundJobNotFoundError extends BackgroundError {
  constructor(message: string) {
    super("background_job_not_found", message);
    this.name = "BackgroundJobNotFoundError";
  }
}

// Current job state does not allow target operations, such as cancelling finished jobs.
export class BackgroundJobStateError extends BackgroundError {
  constructor(message: string) {
    super("background_job_state", message);
    this.name = "BackgroundJobStateError";
  }
}

// Background persistence layer failed on write, read, path validation, or schema validation.
export class BackgroundStorageError extends BackgroundError {
  constructor(message: string, options?: ErrorOptions) {
    super("background_storage_error", message, options);
    this.name = "BackgroundStorageError";
  }
}

// Timeout when waiting for running workers to terminate while closing Supervisor.
export class BackgroundCloseTimeoutError extends BackgroundError {
  constructor(message: string) {
    super("background_close_timeout", message);
    this.name = "BackgroundCloseTimeoutError";
  }
}

export interface BackgroundJobOptions {
  // Canonical UUID, uniquely identifying a job and serving as the on-disk file name.
  readonly id: string;
  // Tool call id that triggered this job, used by terminal events to return to the original calling context.
  readonly sourceToolCallId: string;
  // Name of the tool triggering the job, visible to the model.
  readonly toolName: string;
  // Current state; constructor validates invariants for running and final states.
  readonly status: BackgroundJobStatus;
  // running must be null; terminal states must be non-empty ToolResults.
  readonly result: ToolResult | null;
}

// Domain objects validate state invariants during construction: running has no result, and final states must have a matching ToolResult.
export class BackgroundJob {
  // Canonical UUID; external inputs cannot affect file system paths.
  readonly id: string;
  // Backfill original tool calls so event injection can correlate with the turn that triggered it.
  readonly sourceToolCallId: string;
  // Source tool name.
  readonly toolName: string;
  // Current persistent state.
  readonly status: BackgroundJobStatus;
  // Terminal result, or null for the running state.
  readonly result: ToolResult | null;

  // Centrally validate combinations of identity, status, and result at construction; objects remain immutable after construction.
  constructor(options: BackgroundJobOptions) {
    this.id = canonicalBackgroundId(options.id);
    if (
      typeof options.sourceToolCallId !== "string" ||
      options.sourceToolCallId.trim().length === 0
    ) {
      throw new BackgroundStorageError("background source tool call id must not be empty");
    }
    if (typeof options.toolName !== "string" || options.toolName.trim().length === 0) {
      throw new BackgroundStorageError("background tool name must not be empty");
    }
    if (!isBackgroundJobStatus(options.status)) {
      throw new BackgroundStorageError("background job status is invalid");
    }
    if (options.status === BackgroundJobStatus.RUNNING) {
      if (options.result !== null) {
        throw new BackgroundStorageError("running background job cannot have a result");
      }
    } else {
      if (!isToolResult(options.result)) {
        throw new BackgroundStorageError("terminal background job requires a result");
      }
      if (options.status === BackgroundJobStatus.COMPLETED && options.result.isError) {
        throw new BackgroundStorageError("completed background job requires a successful result");
      }
      if (options.status !== BackgroundJobStatus.COMPLETED && !options.result.isError) {
        throw new BackgroundStorageError("non-completed background job requires an error result");
      }
    }
    this.sourceToolCallId = options.sourceToolCallId;
    this.toolName = options.toolName;
    this.status = options.status;
    this.result = options.result;
    Object.freeze(this);
  }
}

// Persistence boundary: Supervisor depends on these five operations only; files, databases, or other implementations can replace them.
export interface BackgroundJobStore {
  // Persists running record first; Supervisor starts worker only after successful return.
  createRunning(input: {
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
  }): Promise<BackgroundJob>;
  // Atomically transitions only running to terminal state; later writers return undefined to avoid duplicate publishing of terminal state.
  finishRunning(
    jobId: string,
    status: Exclude<BackgroundJobStatus, "running">,
    result: ToolResult,
  ): Promise<BackgroundJob | undefined>;
  // Process startup recovery marks all leftover running jobs as interrupted, and returns jobs migrated this time.
  interruptRunning(): Promise<readonly BackgroundJob[]>;
  // Read a single persisted job; throw a stable domain error when it does not exist.
  getJob(jobId: string): Promise<BackgroundJob>;
  // Read full job snapshot for tool query and recovery use.
  listJobs(): Promise<readonly BackgroundJob[]>;
}

// Background workload function; signal propagates cancellation or timeout to the actual execution.
export type BackgroundOperation = (signal: AbortSignal) => Promise<ToolResult>;

// Replaceable execution boundary; tests can inject controlled executors, and production uses AsyncJobExecutor.
export interface JobExecutor {
  execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult>;
}

// Default executor: Executes background operation directly and passes through AbortSignal.
export class AsyncJobExecutor implements JobExecutor {
  async execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult> {
    return await operation(signal);
  }
}

// Background job terminal event; implements RuntimeEvent and injects into Agent Loop via EventInbox.
export class BackgroundJobEvent implements RuntimeEvent {
  // Unique event ID; Loop uses it for deduplication to prevent the same result from entering history multiple times.
  readonly eventId: string;
  // ID corresponding to persistent jobs.
  readonly jobId: string;
  // Tool call id that triggered the job.
  readonly sourceToolCallId: string;
  // Name of the tool triggering the job.
  readonly toolName: string;
  // Terminal state; background events do not publish running.
  readonly status: Exclude<BackgroundJobStatus, "running">;
  // Terminal result.
  readonly result: ToolResult;

  // Validate identity and terminal result at construction; events are immutable after construction.
  constructor(options: {
    readonly eventId: string;
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
    readonly status: Exclude<BackgroundJobStatus, "running">;
    readonly result: ToolResult;
  }) {
    this.eventId = canonicalBackgroundId(options.eventId);
    this.jobId = canonicalBackgroundId(options.jobId);
    if (options.sourceToolCallId.trim().length === 0 || options.toolName.trim().length === 0) {
      throw new Error("background event identifiers must not be empty");
    }
    if (!isToolResult(options.result)) {
      throw new Error("BackgroundJobEvent requires a terminal ToolResult");
    }
    this.sourceToolCallId = options.sourceToolCallId;
    this.toolName = options.toolName;
    this.status = options.status;
    this.result = options.result;
    Object.freeze(this);
  }

  // Serialize events into pure JSON data visible to the model, keeping field names consistent with persisted payloads.
  toPayload(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      event_id: this.eventId,
      job_id: this.jobId,
      kind: "background_job",
      result: {
        content: this.result.content,
        error_code: this.result.errorCode ?? null,
        is_error: this.result.isError,
      },
      source_tool_call_id: this.sourceToolCallId,
      status: this.status,
      tool_name: this.toolName,
    });
  }
}

// Control handle used internally by Supervisor to manage a single running job.
interface JobControl {
  // Worker settling Promise tracked by Supervisor.
  readonly task: Promise<void>;
  // Active cancellation signal that races alongside execution and timeout.
  readonly cancel: () => void;
}

// Internal cancellation signal; distinguishes active cancellation from job failures and is not exposed externally.
class CancellationSignalError extends Error {}

// Supervisor is the sole owner of background coroutines: controls capacity, timeout, cancellation, and shutdown, and publishes terminal states as typed events.
export class JobSupervisor {
  // Single source of truth for persistent jobs; all queries read it, workers only execute.
  readonly #store: BackgroundJobStore;
  // Terminal state events enter the unidirectional queue of the Agent Loop.
  readonly #inbox: EventInbox;
  // Injectable boundary for executing background operations.
  readonly #executor: JobExecutor;
  // Maximum concurrency limit.
  readonly #capacity: number;
  // Execution timeout for a single job.
  readonly #timeoutMs: number;
  // Upper bound when waiting for all workers to terminate during shutdown.
  readonly #closeTimeoutMs: number;
  // Job ID generator; tests can inject deterministic UUIDs.
  readonly #idGenerator: () => string;
  // Event ID generator; tests can inject a deterministic UUID.
  readonly #eventIdGenerator: () => string;
  // Map from running job ID to control handle; delete after final state or failure.
  readonly #jobControls = new Map<string, JobControl>();
  // All tracked worker Promises; wait for all to settle on close.
  readonly #managedTasks = new Set<Promise<unknown>>();
  // Recovery promise started at construction; subsequent submissions, queries, and shutdowns must wait for it to finish first.
  readonly #ready: Promise<void>;
  // Shutdown flag; rejects new jobs when true.
  #closed = false;

  // Inject dependencies and validate capacity and timeouts; start recovering legacy running jobs immediately at construction.
  constructor(options: {
    readonly store: BackgroundJobStore;
    readonly inbox: EventInbox;
    readonly executor?: JobExecutor;
    readonly capacity?: number;
    readonly timeoutMs?: number;
    readonly closeTimeoutMs?: number;
    readonly idGenerator?: () => string;
    readonly eventIdGenerator?: () => string;
  }) {
    if (
      options.capacity !== undefined &&
      (!Number.isInteger(options.capacity) || options.capacity <= 0)
    ) {
      throw new Error("capacity must be a positive integer");
    }
    const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    const closeTimeoutMs = options.closeTimeoutMs === undefined ? 10_000 : options.closeTimeoutMs;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isFinite(closeTimeoutMs) ||
      closeTimeoutMs <= 0
    ) {
      throw new Error("timeouts must be positive finite numbers");
    }
    this.#store = options.store;
    this.#inbox = options.inbox;
    this.#executor = options.executor === undefined ? new AsyncJobExecutor() : options.executor;
    this.#capacity = options.capacity === undefined ? 4 : options.capacity;
    this.#timeoutMs = timeoutMs;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#idGenerator = options.idGenerator === undefined ? randomUUID : options.idGenerator;
    this.#eventIdGenerator =
      options.eventIdGenerator === undefined ? randomUUID : options.eventIdGenerator;
    this.#ready = this.#recover();
  }

  // Count of workers currently tracked.
  get activeCount(): number {
    return this.#managedTasks.size;
  }

  // Expose the event queue to the Loop or tests while retaining exclusive Supervisor control over the event publication path.
  get eventInbox(): EventInbox {
    return this.#inbox;
  }

  // Whether unfinished background jobs exist; the Loop uses this to decide whether to wait for events.
  get hasPendingWork(): boolean {
    return this.#jobControls.size > 0;
  }

  // Wait for construction-time recovery to complete; only then can persisted state be used for queries and commits.
  async ready(): Promise<void> {
    await this.#ready;
  }

  // Drain currently ready events; limit is optional and defaults to the full batch.
  drainEvents(limit?: number): readonly RuntimeEvent[] {
    return this.#inbox.drain(limit);
  }

  // Blocks waiting for at least one ready event, then drains according to limit.
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    return await this.#inbox.wait(limit);
  }

  // Confirm events are consumed by the Loop; the current implementation validates the contract, preserving boundaries for persistence acks.
  acknowledgeEvents(events: readonly RuntimeEvent[]): void {
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
  }

  // Submit background job: first check capacity and shutdown state, then persist running to disk, and finally start the worker.
  async submit(input: {
    readonly sourceToolCallId: string;
    readonly toolName: string;
    readonly operation: BackgroundOperation;
  }): Promise<string> {
    // Submission order is fixed: capacity check -> persist running to disk -> register worker. Reject starts no side effects.
    await this.#ready;
    if (this.#closed) {
      throw new BackgroundClosedError("JobSupervisor is closed");
    }
    if (this.#jobControls.size >= this.#capacity) {
      throw new BackgroundCapacityError(`Background job capacity ${this.#capacity} is full`);
    }
    const jobId = nextId(this.#idGenerator, "background job");
    await this.#store.createRunning({
      jobId,
      sourceToolCallId: input.sourceToolCallId,
      toolName: input.toolName,
    });
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new CancellationSignalError("background job cancelled"));
    });
    const task = this.#track(this.#runJob(jobId, input.operation, cancelled));
    this.#jobControls.set(jobId, { task, cancel });
    return jobId;
  }

  // Cancel running jobs and wait for workers to converge; report explicit state errors for non-running jobs.
  async cancel(jobId: string): Promise<void> {
    await this.#ready;
    const normalized = canonicalBackgroundId(jobId);
    const control = this.#jobControls.get(normalized);
    if (control === undefined) {
      const job = await this.#store.getJob(normalized);
      throw new BackgroundJobStateError(
        `Background job ${job.id} is ${job.status}; expected running`,
      );
    }
    control.cancel();
    await control.task;
  }

  // Queries only read persisted state without starting workers; the store converts unknown IDs into stable domain errors.
  async getJob(jobId: string): Promise<BackgroundJob> {
    // Queries only read current persisted state without starting workers; the store converts unknown IDs into stable domain errors.
    await this.#ready;
    return await this.#store.getJob(canonicalBackgroundId(jobId));
  }

  // Wait for all current background jobs to settle, serving as a sync point for tests or resource shutdown.
  async waitIdle(): Promise<void> {
    await this.#ready;
    while (this.#jobControls.size > 0) {
      await Promise.all([...this.#jobControls.values()].map((control) => control.task));
    }
  }

  // Shutdown flow stops new submissions first and cancels running jobs, then waits for workers to terminate within the timeout.
  async close(): Promise<void> {
    // Shutdown stops new submissions first, cancels running jobs, and waits for them to terminate.
    await this.#ready;
    if (this.#closed && this.#managedTasks.size === 0) {
      return;
    }
    this.#closed = true;
    for (const control of this.#jobControls.values()) {
      control.cancel();
    }
    const settled = Promise.allSettled([...this.#managedTasks]);
    await withTimeout(
      settled,
      this.#closeTimeoutMs,
      new BackgroundCloseTimeoutError("Managed tasks did not stop before close timeout"),
    );
  }

  // Recovery migrates all running jobs left from previous processes to interrupted, publishing events for each migration.
  async #recover(): Promise<void> {
    const interrupted = await this.#store.interruptRunning();
    for (const job of interrupted) {
      await this.#publishEvent(job);
    }
  }

  // Add worker Promises to managed sets; cancellation signals do not leak as unhandled rejections.
  #track(operation: Promise<void>): Promise<void> {
    const tracked = operation.then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof CancellationSignalError)) {
          throw error;
        }
      },
    );
    this.#managedTasks.add(tracked);
    void tracked.then(
      () => this.#managedTasks.delete(tracked),
      () => this.#managedTasks.delete(tracked),
    );
    return tracked;
  }

  // Run a single background job: race execution, cancellation, and timeout, then transition to the corresponding final state by result.
  async #runJob(
    jobId: string,
    operation: BackgroundOperation,
    cancelled: Promise<never>,
  ): Promise<void> {
    const controller = new AbortController();
    const execution = this.#executor.execute(operation, controller.signal);
    // Executor may have cleanup logic after cancellation; always wait for completion to avoid lingering workers on close.
    const timeoutHandle = timeout(this.#timeoutMs);
    try {
      const result = await Promise.race([execution, cancelled, timeoutHandle.promise]);
      if (!isToolResult(result)) {
        await this.#finish(
          jobId,
          BackgroundJobStatus.FAILED,
          toolError("background_contract_error", "Background executor returned an invalid result"),
        );
      } else {
        await this.#finish(
          jobId,
          result.isError ? BackgroundJobStatus.FAILED : BackgroundJobStatus.COMPLETED,
          result,
        );
      }
    } catch (error) {
      if (error instanceof CancellationSignalError) {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.CANCELLED,
          toolError("background_cancelled", "Background job was cancelled"),
        );
      } else if (error instanceof TimeoutMarker) {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.TIMED_OUT,
          toolError("background_timeout", "Background job timed out"),
        );
      } else {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.FAILED,
          toolError("background_execution_error", "Background job execution failed"),
        );
      }
    } finally {
      timeoutHandle.cancel();
      this.#jobControls.delete(jobId);
    }
  }

  // Atomically migrate running to final states; publish events only on winning writes returned by the store.
  async #finish(
    jobId: string,
    status: Exclude<BackgroundJobStatus, "running">,
    result: ToolResult,
  ): Promise<void> {
    const job = await this.#store.finishRunning(jobId, status, result);
    if (job !== undefined) {
      await this.#publishEvent(job);
    }
  }

  // Validate terminal state, construct background events, and publish to inbox; event publish failure causes this turn to fail resolution.
  async #publishEvent(job: BackgroundJob): Promise<void> {
    if (job.result === null || job.status === BackgroundJobStatus.RUNNING) {
      throw new BackgroundStorageError("terminal background job is missing its result");
    }
    const event = new BackgroundJobEvent({
      eventId: nextId(this.#eventIdGenerator, "runtime event"),
      jobId: job.id,
      sourceToolCallId: job.sourceToolCallId,
      toolName: job.toolName,
      status: job.status,
      result: job.result,
    });
    this.#inbox.publish(event);
  }
}

// Tool dispatch boundary: submit only calls explicitly marked as background_eligible to Supervisor.
export class BackgroundDispatcher {
  // Original Tool Registry; non-background calls still execute directly through it.
  readonly #tools: ToolRegistry;
  // Submission and event source for background jobs.
  readonly #supervisor: JobSupervisor;

  // Bind Tool Registry and Supervisor; Dispatcher holds no extra state.
  constructor(tools: ToolRegistry, supervisor: JobSupervisor) {
    this.#tools = tools;
    this.#supervisor = supervisor;
  }

  // Submit only when background_eligible and background conditions are met; preserve original synchronous semantics for other calls.
  async dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    const definition = prepared.definition;
    const argumentsValue = prepared.arguments;
    if (definition === undefined || argumentsValue === undefined || prepared.error !== undefined) {
      throw new Error("BackgroundDispatcher received an invalid prepared call");
    }
    if (definition.concurrency !== "background_eligible") {
      return await this.#tools.invoke(prepared, context);
    }
    if (!isBackgroundShellInput(argumentsValue)) {
      return toolError(
        "background_contract_error",
        "Background-eligible tool used an unsupported input model",
      );
    }
    if (!shouldRunInBackground(argumentsValue)) {
      return await this.#tools.invoke(prepared, context);
    }
    try {
      const jobId = await this.#supervisor.submit({
        sourceToolCallId: prepared.call.id,
        toolName: definition.name,
        operation: async () => await this.#tools.invoke(prepared, context),
      });
      // The placeholder result is a normal ToolResult that closes the current tool turn; EventInbox injects the real result later.
      return toolSuccess(
        JSON.stringify({
          job_id: jobId,
          status: BackgroundJobStatus.RUNNING,
          tool_name: definition.name,
        }),
      );
    } catch (error) {
      if (error instanceof BackgroundError) {
        return toolError(error.errorCode, error.message);
      }
      throw error;
    }
  }
}

const backgroundJobIdSchema = z.string().regex(CANONICAL_UUID, "job_id must be a canonical UUID");
const backgroundJobIdInputSchema = z.object({ job_id: backgroundJobIdSchema }).strict();

// Background tools share style with task tools: strict schema, domain errors convert to stable ToolResults, and payloads use disk field names.
export function registerBackgroundJobTools(
  registry: ToolRegistry,
  supervisor: JobSupervisor,
): void {
  // The background exposes only query and cancel tools; shell Dispatcher automatically handles creation and execution.
  registry.register(queryBackgroundJobDefinition(supervisor));
  registry.register(cancelBackgroundJobDefinition(supervisor));
}

// Query tool definition: read persisted state and terminal results without side effects.
function queryBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "query_background_job",
    description: "Read the persisted status and result of one background job.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "read",
    handler: async (input) => {
      try {
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

// Cancel tool definition: cancel a running job and return its persistent state after cancellation.
function cancelBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "cancel_background_job",
    description: "Cancel a running background job and persist its cancelled status.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "write",
    handler: async (input) => {
      try {
        await supervisor.cancel(input.job_id);
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

function backgroundJobToolError(error: unknown) {
  // Known background domain errors retain stable error codes; throw unknown exceptions upward to avoid swallowing bugs.
  if (error instanceof BackgroundError) {
    return toolError(error.errorCode, error.message);
  }
  throw error;
}

function backgroundJobPayload(job: BackgroundJob): Readonly<Record<string, unknown>> {
  // Model-visible fields match the event payload; result unifies into three fields: content, error_code, and is_error.
  return Object.freeze({
    job_id: job.id,
    status: job.status,
    tool_name: job.toolName,
    source_tool_call_id: job.sourceToolCallId,
    result:
      job.result === null
        ? null
        : {
            content: job.result.content,
            error_code: job.result.errorCode ?? null,
            is_error: job.result.isError,
          },
  });
}

// Determine whether shell calls run in the background: explicit booleans take priority, fallback to keyword heuristics when omitted.
export function shouldRunInBackground(input: BackgroundShellInput): boolean {
  // Explicit booleans take precedence; use deterministic keyword heuristics only when omitted, without predicting arbitrary command durations.
  if (input.run_in_background !== undefined && input.run_in_background !== null) {
    return input.run_in_background;
  }
  const command = input.command.toLowerCase();
  return BACKGROUND_MARKERS.some((marker) => command.includes(marker));
}

export function canonicalBackgroundId(value: string): string {
  // The UUID is the source of the file name; external strings cannot enter the file system as paths.
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new BackgroundStorageError("background id must be a canonical UUID");
  }
  return value;
}

// State values must be literals in BackgroundJobStatus; treat unknown strings as invalid input.
function isBackgroundJobStatus(value: unknown): value is BackgroundJobStatus {
  return Object.values(BackgroundJobStatus).includes(value as BackgroundJobStatus);
}

// shell input validation only checks fields needed for background; earlier boundaries reject extra fields via tool schema.
function isBackgroundShellInput(value: unknown): value is BackgroundShellInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const command = Reflect.get(value, "command");
  const background = Reflect.get(value, "run_in_background");
  return (
    typeof command === "string" &&
    (background === undefined || background === null || typeof background === "boolean")
  );
}

// Call the injected generator and strictly validate return values, ensuring any id is safe for file systems and event deduplication.
function nextId(generator: () => string, label: string): string {
  try {
    return canonicalBackgroundId(generator());
  } catch (error) {
    throw new BackgroundStorageError(`${label} id generator returned an invalid UUID`, {
      cause: error,
    });
  }
}

// Internal timeout flag, used to distinguish timeouts from other denial reasons.
class TimeoutMarker extends Error {}

// Cancellable timeout handle; calling cancel cleans up timers after the promise resolves.
interface TimeoutHandle {
  // A racing Promise that never resolves and only rejects at the deadline.
  readonly promise: Promise<never>;
  // Cleans up timer when job finishes first, preventing invalid callbacks from retaining the event loop.
  cancel(): void;
}

// Creates a timeout promise that rejects only once, racing against background execution or cancellation promises.
function timeout(milliseconds: number): TimeoutHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutMarker()), milliseconds);
  });
  return Object.freeze({
    promise,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  });
}

// Wraps any promise with a timeout; rejects with the given error on timeout and clears the timer in finally.
async function withTimeout<T>(promise: Promise<T>, milliseconds: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(error), milliseconds);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
