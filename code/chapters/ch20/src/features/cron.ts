// Cron runtime: takes persistent five-field schedule as input, schedules via CronStore, publishes events via EventInbox, and manages polling worker via Supervisor.
import { randomUUID } from "node:crypto";

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

import { isRuntimeEvent, type EventInbox, type RuntimeEvent } from "../core/events.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import type { JobSupervisor } from "./background.js";

// Base class for Cron domain errors; errorCode is a machine-readable category stably returned at tool boundaries.
export class CronError extends Error {
  // Do not expose underlying exception types; callers rely only on stable error codes.
  readonly errorCode: string;
  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CronError";
    this.errorCode = errorCode;
  }
}
// Five-field expression, timezone, or time input does not satisfy the scheduling contract.
export class CronExpressionError extends CronError {
  constructor(message: string) {
    super("cron_expression_error", message);
  }
}
// Snapshot corruption, persistence failures, or lock exceptions map uniformly to predictable CronStorageErrors.
export class CronStorageError extends CronError {
  constructor(message: string, options?: ErrorOptions) {
    super("cron_storage_error", message, options);
  }
}
// Fail explicitly when queries or confirmations reference non-existent jobs or events; do not masquerade as empty results.
export class CronJobNotFoundError extends CronError {
  constructor(message: string) {
    super("cron_job_not_found", message);
  }
}
// Calling schedule/start/tick after runtime close fails immediately to prevent continued scheduling outside the close boundary.
export class CronClosedError extends CronError {
  constructor(message: string) {
    super("cron_closed", message);
  }
}

export interface CronJob {
  // The plan persists next trigger slot and last slot to prevent repeated execution on restart or duplicate ticks.
  readonly id: string;
  // Normalized five-field Cron expression.
  readonly cron: string;
  // User intent used when an expiration event starts an independent Agent turn.
  readonly prompt: string;
  // IANA timezone name; slot calculation uses the local calendar of this timezone.
  readonly timezone: string;
  // false indicates deleting the schedule after triggering once.
  readonly recurring: boolean;
  // true indicates schedules and outbox persist across process restarts.
  readonly durable: boolean;
  // The entity creating the schedule; event turns inherit this identity instead of the current CLI user.
  readonly identity: string;
  // UTC instant when event generation is next permitted.
  readonly nextRunAtUtc: Date;
  // Slot of the previously generated event, used for audit and deduplication.
  readonly lastSlotAtUtc: Date | null;
}

export interface CronEvent extends RuntimeEvent {
  // Discriminator field allows shared EventInbox to distinguish between Cron and background job terminal states.
  readonly kind: "cron";
  readonly eventId: string;
  readonly jobId: string;
  // Event carries original plan identity, and Loop uses it to construct an isolated ToolContext.
  readonly identity: string;
  readonly prompt: string;
  readonly timezone: string;
  readonly durable: boolean;
  // Actual triggered UTC slot, not scheduler scan time.
  readonly slotAtUtc: Date;
}

// Storage contracts isolate "how to persist" from "when to schedule": runtime depends only on atomic ticks, outboxes, and leader leases.
export interface CronStore {
  // Create a schedule and calculate the first slot strictly after nowUtc.
  scheduleCron(input: {
    cron: string;
    prompt: string;
    timezone: string;
    recurring: boolean;
    durable: boolean;
    identity: string;
    nowUtc: Date;
  }): Promise<CronJob>;
  // Merge durable and session-only states to read a single schedule.
  getJob(id: string): Promise<CronJob>;
  // Returns an ordered schedule snapshot of two lifecycles.
  listJobs(): Promise<readonly CronJob[]>;
  // Atomically generate all expired events and advance or delete corresponding schedules.
  tick(nowUtc: Date, includeDurable?: boolean): Promise<readonly CronEvent[]>;
  // Read unacknowledged outbox; events can be repeatedly observed by the scheduler before ack.
  pendingEvents(includeDurable?: boolean): Promise<readonly CronEvent[]>;
  // Deletes consumed events from session or durable outbox.
  ackEvent(eventId: string): Promise<boolean>;
  // Non-blocking acquisition of durable scheduler leader; failed instances can still schedule local session jobs.
  tryAcquireLeader(): Promise<boolean>;
  // Releases the leader lease held by the current instance.
  releaseLeader(): Promise<void>;
}

// Injectable clock ensures tests and scheduling share the same UTC source of truth.
export interface CronClock {
  now(): Date;
}
// Cancellable sleep boundary; used to wake polling workers immediately when closing runtime.
export interface CronSleeper {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
// Visible tool inputs for schedule_cron; identity and current time must come only from trusted runtime context.
export interface ScheduleCronInput {
  readonly cron: string;
  readonly prompt: string;
  readonly timezone: string;
  readonly recurring: boolean;
  readonly durable: boolean;
}

// Tool inputs permit business fields only; id, identity, and nextRunAtUtc are generated by runtime or obtained from context.
const scheduleCronSchema = z
  .object({
    cron: z.string(),
    prompt: z.string(),
    timezone: z.string(),
    recurring: z.boolean(),
    durable: z.boolean(),
  })
  .strict();

export class CronRuntime {
  // CronRuntime manages workers via shared Supervisor and uses a leader lease to prevent duplicate scheduling across instances.
  readonly #store: CronStore;
  readonly #inbox: EventInbox;
  readonly #supervisor: JobSupervisor;
  readonly #clock: CronClock;
  readonly #sleeper: CronSleeper;
  readonly #pollMilliseconds: number;
  // Tool definitions fixed at construction ensure schema and handler in dynamic prompts share the same source.
  readonly #toolDefinition: ToolDefinition<ScheduleCronInput>;
  // Published event ids not yet acked, preventing polling from pushing the same outbox record repeatedly into the Inbox.
  readonly #queued = new Set<string>();
  // Only leader instances can advance durable schedules.
  #leader = false;
  // Rejects schedule/start/tick after shutdown.
  #closed = false;
  // scheduler is a single managed worker under supervisor; failures are stashed and thrown on the next public operation.
  #worker: Promise<void> | undefined;
  // Save scheduler cancellation controllers independently so close stops polling before awaiting workers.
  #schedulerAbort: AbortController | undefined;
  // Worker exceptions are not lost silently; subsequent public operations or close will re-throw them.
  #schedulerFailure: unknown | undefined;
  // Optional callback to notify AgentRunner.runEvents when pending events exist.
  #wakeup: (() => Promise<void>) | undefined;
  // Serializes manual ticks and scheduler ticks to prevent adjacent scans from advancing state concurrently.
  #tickTail: Promise<void> = Promise.resolve();

  // Bind shared store, Inbox, Supervisor, and injectable time boundaries; the constructor itself does not start workers.
  constructor(options: {
    store: CronStore;
    inbox: EventInbox;
    supervisor: JobSupervisor;
    clock: CronClock;
    sleeper?: CronSleeper;
    pollMilliseconds?: number;
  }) {
    const pollMilliseconds = options.pollMilliseconds ?? 1_000;
    if (!Number.isFinite(pollMilliseconds) || pollMilliseconds <= 0) {
      throw new TypeError("pollMilliseconds must be positive");
    }
    this.#store = options.store;
    this.#inbox = options.inbox;
    this.#supervisor = options.supervisor;
    this.#clock = options.clock;
    this.#sleeper = options.sleeper ?? {
      sleep: async (milliseconds, signal) =>
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    };
    this.#pollMilliseconds = pollMilliseconds;
    this.#toolDefinition = {
      name: "schedule_cron",
      description: "Schedule a recurring or one-shot prompt with a five-field Cron expression.",
      inputSchema: scheduleCronSchema,
      effect: "write",
      handler: async (input, context) => await this.#schedule(input, context),
    };
  }

  // Expose fixed schedule_cron definitions for the composition root to register.
  get toolDefinition(): ToolDefinition<ScheduleCronInput> {
    return this.#toolDefinition;
  }
  // Expose shared Inbox only for composition consistency validation.
  get eventInbox(): EventInbox {
    return this.#inbox;
  }
  // Expose shared Supervisor only for composition consistency validation and resource ownership verification.
  get supervisor(): JobSupervisor {
    return this.#supervisor;
  }
  // Pending state of the event pump follows unclosed managed tasks in Supervisor.
  get hasPendingWork(): boolean {
    return this.#supervisor.hasPendingWork;
  }
  // Waits for Supervisor to complete persistence recovery before consuming events for the first time.
  async ready(): Promise<void> {
    await this.#supervisor.ready();
  }
  // Non-blocking delegation of FIFO drain for shared Inbox.
  drainEvents(limit?: number): readonly RuntimeEvent[] {
    return this.#inbox.drain(limit);
  }
  // Blocks waiting for at least one event in the shared Inbox.
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    return await this.#inbox.wait(limit);
  }
  // Only CronEvent needs persistent outbox deletion; respective runtimes handle semantics for other shared events.
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
    for (const event of events) {
      if (isCronEvent(event)) {
        try {
          const acknowledged = await this.#store.ackEvent(event.eventId);
          if (!acknowledged) {
            throw new CronStorageError(`Cron event is no longer pending: ${event.eventId}`);
          }
          this.#queued.delete(event.eventId);
        } catch (error) {
          this.#queued.delete(event.eventId);
          throw error;
        }
      }
    }
  }
  // Bind idle wakeup callback; the callback requests running event turns only and does not bypass the Runner run lock.
  bindWakeup(wakeup: () => Promise<void>): void {
    this.#wakeup = wakeup;
  }
  // Register scheduler as a managed task of supervisor on startup and forward cancellation signals synchronously.
  start(): void {
    if (this.#closed) throw new CronClosedError("CronRuntime is closed");
    this.#throwSchedulerFailure();
    if (this.#worker !== undefined) return;
    const schedulerAbort = new AbortController();
    const worker = this.#supervisor.startManaged(async (supervisorSignal) => {
      supervisorSignal.addEventListener("abort", () => schedulerAbort.abort(), { once: true });
      await this.#runScheduler(schedulerAbort.signal);
    }, "cron-scheduler");
    this.#worker = worker;
    this.#schedulerAbort = schedulerAbort;
    void worker.then(
      () => {
        if (this.#worker === worker) {
          this.#worker = undefined;
          this.#schedulerAbort = undefined;
        }
      },
      (error: unknown) => {
        this.#schedulerFailure = error;
        if (this.#worker === worker) {
          this.#worker = undefined;
          this.#schedulerAbort = undefined;
        }
      },
    );
  }
  // Execute one leader election, expiration migration, event publication, and optional Runner wakeup.
  async tick(): Promise<void> {
    // tickTail serializes all ticks to ensure reading, scheduling, and publishing events do not interleave concurrently.
    if (this.#closed) throw new CronClosedError("CronRuntime is closed");
    this.#throwSchedulerFailure();
    const previous = this.#tickTail;
    let release!: () => void;
    this.#tickTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#closed) throw new CronClosedError("CronRuntime is closed");
      await this.#ensureLeader();
      await this.#store.tick(this.#clock.now(), this.#leader);
      await this.#publishPending();
      if (
        this.#wakeup !== undefined &&
        (await this.#store.pendingEvents(this.#leader)).length > 0
      ) {
        await this.#wakeup();
      }
    } finally {
      release();
    }
  }
  // Shutdown sequence stops scheduler, waits for tick, releases leader, and aggregates all cleanup failures.
  async close(): Promise<void> {
    if (this.#closed && this.#worker === undefined && !this.#leader) {
      this.#throwSchedulerFailure();
      return;
    }
    this.#closed = true;
    const failures: unknown[] = [];
    const worker = this.#worker;
    this.#worker = undefined;
    const schedulerAbort = this.#schedulerAbort;
    this.#schedulerAbort = undefined;
    schedulerAbort?.abort();
    if (worker !== undefined) {
      try {
        await worker;
      } catch (error) {
        failures.push(error);
      }
    }
    await this.#tickTail;
    if (this.#leader) {
      try {
        await this.#store.releaseLeader();
        this.#leader = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.#schedulerFailure !== undefined && !failures.includes(this.#schedulerFailure)) {
      failures.push(this.#schedulerFailure);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "CronRuntime close failed");
  }
  async #runScheduler(signal: AbortSignal): Promise<void> {
    // The background loop only handles "tick + wait" without directly executing cron prompts; business actions must return to the Agent Loop.
    try {
      while (!this.#closed && !signal.aborted) {
        await this.tick();
        await this.#sleeper.sleep(this.#pollMilliseconds, signal);
      }
    } finally {
      if (this.#leader) {
        await this.#store.releaseLeader();
        this.#leader = false;
      }
    }
  }
  async #ensureLeader(): Promise<void> {
    // leader lease uses non-blocking attempts; if locking fails, generate events only for this session's session-only jobs.
    if (!this.#leader) this.#leader = await this.#store.tryAcquireLeader();
  }
  // Bring detached scheduler failures back to controlled call boundaries.
  #throwSchedulerFailure(): void {
    if (this.#schedulerFailure !== undefined) throw this.#schedulerFailure;
  }
  async #publishPending(): Promise<void> {
    // Published pending events are deduplicated in memory to avoid duplicate delivery from repeated polling before ack.
    for (const event of await this.#store.pendingEvents(this.#leader)) {
      if (this.#queued.has(event.eventId)) continue;
      this.#inbox.publish(event);
      this.#queued.add(event.eventId);
    }
  }
  async #schedule(input: ScheduleCronInput, context: ToolContext): Promise<ToolResult> {
    // Tool boundaries convert modeled CronErrors into returnable tool results; unexpected exceptions propagate upward.
    if (this.#closed) {
      return toolError("cron_closed", "CronRuntime is closed");
    }
    try {
      const job = await this.#store.scheduleCron({
        ...input,
        identity: context.identity,
        nowUtc: this.#clock.now(),
      });
      return toolSuccess(JSON.stringify(serializeCronJob(job)));
    } catch (error) {
      if (error instanceof CronError) return toolError(error.errorCode, error.message);
      throw error;
    }
  }
}

function serializeCronJob(job: CronJob): Record<string, unknown> {
  // Tool return values use stable snake_case fields to prevent Date instances from serializing in environment-dependent ways.
  return {
    id: job.id,
    cron: job.cron,
    prompt: job.prompt,
    timezone: job.timezone,
    recurring: job.recurring,
    durable: job.durable,
    identity: job.identity,
    next_run_at_utc: job.nextRunAtUtc.toISOString(),
    last_slot_at_utc: job.lastSlotAtUtc?.toISOString() ?? null,
  };
}

// Minimal discriminant check in shared event queue; full fields validate at creation and persistence recovery boundaries.
export function isCronEvent(value: RuntimeEvent): value is CronEvent {
  return typeof value === "object" && value !== null && Reflect.get(value, "kind") === "cron";
}
// Construct immutable CronEvent and map identity/eventId to the Loop context identity and idempotency key.
export function createCronEvent(
  options: Omit<CronEvent, "kind" | "toPayload" | "contextIdentity" | "idempotencyKey">,
): CronEvent {
  return Object.freeze({
    ...options,
    kind: "cron" as const,
    contextIdentity: options.identity,
    idempotencyKey: options.eventId,
    toPayload: () =>
      Object.freeze({
        event_id: options.eventId,
        job_id: options.jobId,
        kind: "cron",
        identity: options.identity,
        prompt: options.prompt,
        timezone: options.timezone,
        durable: options.durable,
        slot_at_utc: options.slotAtUtc.toISOString(),
      }),
  });
}
// Canonical UUID used for state keys and outbox idempotency tokens, rejecting inputs that could form path fragments.
export function canonicalCronId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  )
    throw new CronStorageError("Cron id must be a canonical UUID");
  return value;
}
export function validateCronExpression(value: string): string {
  // Explicitly checks five fields, steps, and reverse ranges first before passing to cron-parser, preventing bad expressions from persisting.
  if (typeof value !== "string" || !value.trim())
    throw new CronExpressionError("Cron expression must not be empty");
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.split(" ").length !== 5)
    throw new CronExpressionError("Cron expression must contain exactly five fields");
  for (const item of normalized.split(" ").flatMap((field) => field.split(","))) {
    const range = item.split("/", 1)[0]?.split("-");
    if (
      range?.length === 2 &&
      /^\d+$/u.test(range[0] ?? "") &&
      /^\d+$/u.test(range[1] ?? "") &&
      Number(range[0]) > Number(range[1])
    )
      throw new CronExpressionError("Invalid descending Cron range");
  }
  try {
    CronExpressionParser.parse(normalized, {
      currentDate: new Date("2000-01-01T00:00:00Z"),
      tz: "UTC",
    });
  } catch (_error) {
    throw new CronExpressionError(`Invalid Cron expression: ${value}`);
  }
  return normalized;
}
export function nextCronOccurrence(expression: string, timezone: string, afterUtc: Date): Date {
  // cron-parser handles local calendar calculations; candidate UTC instants pass DST gap/fold policies before return.
  const normalized = validateCronExpression(expression);
  const normalizedTimezone = validateCronTimezone(timezone);
  if (!(afterUtc instanceof Date) || !Number.isFinite(afterUtc.valueOf()))
    throw new CronExpressionError("Cron clock value must be a valid UTC Date");
  try {
    const iterator = CronExpressionParser.parse(normalized, {
      currentDate: afterUtc,
      tz: normalizedTimezone,
    });
    return adjustDstOccurrence(normalized, normalizedTimezone, afterUtc, iterator.next().toDate());
  } catch (error) {
    if (error instanceof CronExpressionError) throw error;
    throw new CronExpressionError(`Invalid Cron timezone or expression: ${timezone}`);
  }
}

// Uses Intl to validate and normalize IANA timezone names; rejects implicit default timezones from local environment.
export function validateCronTimezone(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new CronExpressionError("Cron timezone must not be empty");
  const normalized = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch (_error) {
    throw new CronExpressionError(`Unknown Cron timezone: ${value}`);
  }
  return normalized;
}

// The following helpers project UTC instant to local fields in business timezone and apply DST corrections with standard DOM/DOW OR semantics.
interface LocalCronParts {
  // Local calendar fields after projecting a UTC instant into the business time zone.
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

interface CronFieldSet {
  // Discrete set after parsing the five-field expression, used to re-evaluate candidates during DST correction.
  readonly minutes: CronField;
  readonly hours: CronField;
  readonly days: CronField;
  readonly months: CronField;
  readonly weekdays: CronField;
}

interface CronField {
  // Set of numerical values allowed for the current field.
  readonly values: ReadonlySet<number>;
  // Records whether fields are wildcards to implement standard DOM/DOW OR semantics.
  readonly wildcard: boolean;
}

function adjustDstOccurrence(
  expression: string,
  timezone: string,
  afterUtc: Date,
  candidate: Date,
): Date {
  // Candidate times from cron-parser for gap/fold are not unique: gap advances to the first valid instant,
  // fold lets the same local clock face retain two different UTC instants.
  let fields: CronFieldSet;
  try {
    fields = parseCronFieldSets(expression);
  } catch {
    return candidate;
  }
  const candidateParts = localCronParts(candidate, timezone);
  if (!matchesCronFields(candidateParts, fields)) {
    let cursor = candidate;
    let currentOffset = timezoneOffsetMinutes(cursor, candidateParts);
    for (let index = 0; index < 360; index += 1) {
      const previous = new Date(cursor.valueOf() - 60_000);
      const previousParts = localCronParts(previous, timezone);
      const previousOffset = timezoneOffsetMinutes(previous, previousParts);
      if (currentOffset > previousOffset) return cursor;
      cursor = previous;
      currentOffset = previousOffset;
    }
  }
  if (afterUtc.getSeconds() === 0 && afterUtc.getMilliseconds() === 0) {
    const afterParts = localCronParts(afterUtc, timezone);
    if (matchesCronFields(afterParts, fields)) {
      const initialOffset = timezoneOffsetMinutes(afterUtc, afterParts);
      for (let index = 1; index <= 360; index += 1) {
        const repeated = new Date(afterUtc.valueOf() + index * 60_000);
        const repeatedParts = localCronParts(repeated, timezone);
        const repeatedOffset = timezoneOffsetMinutes(repeated, repeatedParts);
        if (
          repeatedOffset < initialOffset &&
          repeatedParts.year === afterParts.year &&
          repeatedParts.month === afterParts.month &&
          repeatedParts.day === afterParts.day &&
          repeatedParts.hour === afterParts.hour &&
          repeatedParts.minute === afterParts.minute &&
          matchesCronFields(repeatedParts, fields)
        )
          return repeated;
      }
    }
  }
  return candidate;
}

// Expand validated five-field expressions into local match sets.
function parseCronFieldSets(expression: string): CronFieldSet {
  const fields = expression.split(" ");
  return {
    minutes: parseCronField(fields[0] ?? "", 0, 59),
    hours: parseCronField(fields[1] ?? "", 0, 23),
    days: parseCronField(fields[2] ?? "", 1, 31),
    months: parseCronField(fields[3] ?? "", 1, 12),
    weekdays: parseCronField(fields[4] ?? "", 0, 7),
  };
}

// Expand comma, range, and step syntax; normalize Sunday 7 to 0 simultaneously.
function parseCronField(value: string, minimum: number, maximum: number): CronField {
  const result = new Set<number>();
  const wildcard = value.split(",").every((item) => item.split("/")[0] === "*");
  for (const item of value.split(",")) {
    const [base, stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) throw new Error("invalid step");
    let start = minimum;
    let end = maximum;
    if (base !== "*") {
      const bounds = base?.split("-") ?? [];
      if (bounds.length === 1 && /^\d+$/u.test(bounds[0] ?? "")) {
        start = Number(bounds[0]);
        end = start;
      } else if (
        bounds.length === 2 &&
        /^\d+$/u.test(bounds[0] ?? "") &&
        /^\d+$/u.test(bounds[1] ?? "")
      ) {
        start = Number(bounds[0]);
        end = Number(bounds[1]);
      } else {
        throw new Error("invalid field");
      }
    }
    if (start < minimum || end > maximum || start > end) throw new Error("field out of range");
    for (let current = start; current <= end; current += step) result.add(current);
  }
  if (minimum === 0 && maximum === 7 && result.has(7)) result.add(0);
  return { values: result, wildcard };
}

// Converts UTC instant to stable numeric fields for the specified time zone via Intl.
function localCronParts(value: Date, timezone: string): LocalCronParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(value);
  const numeric = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const weekdayNumber = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday ?? ""];
  if (weekdayNumber === undefined) throw new Error("invalid weekday");
  return {
    year: numeric("year"),
    month: numeric("month"),
    day: numeric("day"),
    hour: numeric("hour"),
    minute: numeric("minute"),
    weekday: weekdayNumber,
  };
}

// Calculate timezone offset from instantaneous UTC and local clock face to identify DST shifts.
function timezoneOffsetMinutes(value: Date, parts: LocalCronParts): number {
  return (
    (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - value.valueOf()) /
    60_000
  );
}

// Process day-of-month and day-of-week by Cron standards: use OR when both are restricted.
function matchesCronFields(parts: LocalCronParts, fields: CronFieldSet): boolean {
  const dayMatches = fields.days.values.has(parts.day);
  const weekdayMatches = fields.weekdays.values.has(parts.weekday);
  const dayOfMonthAndWeekdayMatch =
    fields.days.wildcard && fields.weekdays.wildcard
      ? true
      : fields.days.wildcard
        ? weekdayMatches
        : fields.weekdays.wildcard
          ? dayMatches
          : dayMatches || weekdayMatches;
  return (
    fields.minutes.values.has(parts.minute) &&
    fields.hours.values.has(parts.hour) &&
    fields.months.values.has(parts.month) &&
    dayOfMonthAndWeekdayMatch
  );
}

// Production default UUID generator; tests can inject deterministic values at the store boundary.
export function randomCronId(): string {
  return randomUUID();
}
