// Teammate runtime: manages persistent teammates with independent AgentRunners and identities, collaborating with Lead via mailbox/EventInbox.
import type { EventInbox, RuntimeEvent } from "../core/events.js";
import { isRuntimeEvent } from "../core/events.js";
import { AgentRunner } from "../core/loop.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import type { JobSupervisor } from "./background.js";
import type { CronRuntime } from "./cron.js";
import {
  canonicalAgentName,
  MailboxMessageKind,
  MailboxStorageError,
  sendMessageInputSchema,
  spawnTeammateInputSchema,
  type MailboxMessage,
  type MailboxStore,
  type SendMessageInput,
  type SpawnTeammateInput,
} from "./mailbox.js";

export const LEAD_NAME = "lead";

export const TeammateStatus = Object.freeze({
  // The state machine only describes the teammate lifecycle within the current process; it stops receiving new messages after failed or shutdown.
  Running: "running",
  Idle: "idle",
  Failed: "failed",
  Shutdown: "shutdown",
});
export type TeammateStatus = (typeof TeammateStatus)[keyof typeof TeammateStatus];

export class TeammateError extends Error {
  // Teammate runtime errors uniformly carry stable errorCode; tool boundaries return structured failures accordingly.
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeammateError";
    this.errorCode = errorCode;
  }
}
export class TeammateExistsError extends TeammateError {
  // Teammates with the same name can register only once; duplicate spawns must be distinguishable and cannot overwrite silently.
  constructor(message: string) {
    super("teammate_exists", message);
    this.name = "TeammateExistsError";
  }
}
export class TeammateNotFoundError extends TeammateError {
  // Fail explicitly when sending messages to an unregistered teammate, preventing writes to nonexistent inboxes.
  constructor(message: string) {
    super("teammate_not_found", message);
    this.name = "TeammateNotFoundError";
  }
}
export class TeammateStateError extends TeammateError {
  // Fails immediately when configuration or lifecycle state is invalid, rather than waiting for background workers to expose problems.
  constructor(message: string) {
    super("teammate_state", message);
    this.name = "TeammateStateError";
  }
}
export class TeammateClosedError extends TeammateError {
  // Runtime rejects spawn/send/start after shutdown to prevent writing to mailbox after resources are released.
  constructor(message: string) {
    super("teammate_closed", message);
    this.name = "TeammateClosedError";
  }
}

export interface Teammate {
  // Canonical Agent slug, serving as both mailbox recipient and ToolContext.identity.
  readonly name: string;
  // Responsibility description fixed at creation, used to build independent Runner prompts.
  readonly role: string;
  // In-process worker state snapshot.
  readonly status: TeammateStatus;
}

// The factory creates an AgentRunner with independent history for each teammate, exposing only the controlled send_message tool.
export type TeammateRunnerFactory = (
  name: string,
  role: string,
  sendToolDefinition: ToolDefinition<SendMessageInput>,
) => AgentRunner;

// Worker keeps an observable snapshot and background handle for the teammate; task/abort/currentMessage exist only during a single worker loop.
interface Worker {
  // Externally observable immutable teammate snapshot; replace as a whole on state change.
  teammate: Teammate;
  // AgentRunner and canonical history dedicated to this teammate.
  readonly runner: AgentRunner;
  // Managed task under supervisor; undefined indicates no in-flight loop currently, allowing safe restart.
  task: Promise<void> | undefined;
  // Current processing lease; must release back to ready on close or cancel, cannot silently discard.
  currentMessage: MailboxMessage | undefined;
  // Cancellation controller for the current worker loop.
  abort: AbortController | undefined;
  // Sets to true only after both runner and message leases clean up successfully, supporting close retries.
  closeComplete: boolean;
  // Stash release failures to report uniformly at the close boundary.
  cleanupFailure: unknown | undefined;
}

export class TeammateRuntime {
  // Each teammate has an independent AgentRunner and identity; shared resources are limited to mailbox, event Inbox, and scheduler.
  readonly #store: MailboxStore;
  readonly #inbox: EventInbox;
  readonly #supervisor: JobSupervisor;
  readonly #cronRuntime: CronRuntime;
  readonly #leadName: string;
  // Registry of teammates created in the current process; does not automatically reconstruct AgentRunners from disk.
  readonly #workers = new Map<string, Worker>();
  // Lead message ids published to the shared Inbox that are not yet drained.
  readonly #queuedMessageIds = new Set<string>();
  readonly #spawnToolDefinition: ToolDefinition<SpawnTeammateInput>;
  readonly #sendToolDefinition: ToolDefinition<SendMessageInput>;
  // Factories must be configured exactly once before start, preventing different teammates from using drifted assembly rules.
  #runnerFactory: TeammateRunnerFactory | undefined;
  // Callback that requests Runner.runEvents when new messages arrive in Lead mailbox.
  #wakeup: (() => Promise<void>) | undefined;
  // Serializes spawn/send read-modify-write operations on the worker registry.
  #registryTail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  // Validate sharing relationships of mailbox, Cron, Supervisor, and Inbox; constructor does not start workers.
  constructor(options: {
    readonly store: MailboxStore;
    readonly inbox: EventInbox;
    readonly supervisor: JobSupervisor;
    readonly cronRuntime: CronRuntime;
    readonly leadName?: string;
  }) {
    if (
      options.store === undefined ||
      typeof options.store.send !== "function" ||
      typeof options.store.claim !== "function" ||
      typeof options.store.ack !== "function"
    ) {
      throw new TypeError("store must implement MailboxStore");
    }
    if (options.cronRuntime.supervisor !== options.supervisor) {
      throw new Error("cronRuntime must share the JobSupervisor");
    }
    if (options.cronRuntime.eventInbox !== options.inbox) {
      throw new Error("cronRuntime must share the EventInbox");
    }
    this.#store = options.store;
    this.#inbox = options.inbox;
    this.#supervisor = options.supervisor;
    this.#cronRuntime = options.cronRuntime;
    this.#leadName = canonicalAgentName(options.leadName ?? LEAD_NAME);
    this.#spawnToolDefinition = {
      name: "spawn_teammate",
      description: "Start a persistent teammate with an isolated history and focused role.",
      inputSchema: spawnTeammateInputSchema,
      effect: "external",
      handler: async (input, context) => await this.#spawnTool(input, context),
    };
    this.#sendToolDefinition = {
      name: "send_message",
      description: "Send a persistent message to the lead or an existing teammate.",
      inputSchema: sendMessageInputSchema,
      effect: "external",
      handler: async (input, context) => await this.#sendTool(input, context),
    };
  }

  // Expose shared Supervisor for the composition root to verify resource ownership.
  get supervisor(): JobSupervisor {
    return this.#supervisor;
  }
  // Expose shared Inbox for the composition root to verify event path uniqueness.
  get eventInbox(): EventInbox {
    return this.#inbox;
  }
  // Expose wrapped CronRuntime; event pump methods compose mailbox ack on top of it.
  get cronRuntime(): CronRuntime {
    return this.#cronRuntime;
  }
  // Expose MailboxStore for composition consistency testing and controlled queries.
  get mailboxStore(): MailboxStore {
    return this.#store;
  }
  // The pending state follows managed task states of shared Cron/Supervisor.
  get hasPendingWork(): boolean {
    return this.#cronRuntime.hasPendingWork;
  }
  // Primary Agent registers a stable order snapshot of spawn and send tools.
  get toolDefinitions(): readonly (
    | ToolDefinition<SpawnTeammateInput>
    | ToolDefinition<SendMessageInput>
  )[] {
    return Object.freeze([this.#spawnToolDefinition, this.#sendToolDefinition]);
  }
  get spawnToolDefinition(): ToolDefinition<SpawnTeammateInput> {
    return this.#spawnToolDefinition;
  }
  get sendToolDefinition(): ToolDefinition<SendMessageInput> {
    return this.#sendToolDefinition;
  }

  // Inject the Runner factory once before start to prevent replacing isolation and permission rules during execution.
  configureRunnerFactory(factory: TeammateRunnerFactory): void {
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    if (this.#runnerFactory !== undefined || this.#started) {
      throw new TeammateStateError("Teammate runner factory must be configured once before start");
    }
    this.#runnerFactory = factory;
  }

  // Bind Lead message wakeup callback; AgentRunner handles actual concurrency mutual exclusion.
  bindWakeup(wakeup: () => Promise<void>): void {
    if (typeof wakeup !== "function") throw new TypeError("wakeup must be a function");
    this.#wakeup = wakeup;
  }

  // Recover half-open Lead messages and publish pending events; repeated starts are idempotent.
  async start(): Promise<void> {
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (this.#runnerFactory === undefined) {
      throw new TeammateStateError("Teammate runner factory is not configured");
    }
    if (this.#started) return;
    // Recover stale processing messages before starting Lead, then publish to EventInbox to prevent crash messages from lingering in leases.
    await this.#store.recoverProcessing(this.#leadName);
    await this.#publishLeadMessages();
    this.#started = true;
  }

  // Acts as recovery barrier for RuntimeEventPump, ensuring mailbox is consumable.
  async ready(): Promise<void> {
    await this.start();
  }

  // Returns the current immutable state snapshot of the specified teammate.
  state(name: string): Teammate {
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.teammate;
  }

  // Atomically register a teammate, recover its mailbox, send the first task, and start the managed worker.
  async spawn(input: SpawnTeammateInput & { readonly sender: string }): Promise<Teammate> {
    // Start workers only after registering and restoring mailbox to prevent teammates from losing initial messages before inboxes are ready.
    this.#ensureAvailable();
    const name = canonicalAgentName(input.name);
    const sender = canonicalAgentName(input.sender);
    const role = requireText(input.role, "Teammate role");
    const prompt = requireText(input.prompt, "Teammate prompt");
    if (name === this.#leadName)
      throw new Error(`Teammate name ${this.#leadName} is reserved for the lead`);
    return await this.#withRegistry(async () => {
      this.#ensureAvailable();
      if (this.#workers.has(name))
        throw new TeammateExistsError(`Teammate already exists: ${name}`);
      const factory = this.#runnerFactory;
      if (factory === undefined)
        throw new TeammateStateError("Teammate runner factory is not configured");
      const runner = factory(name, role, this.#sendToolDefinition);
      if (!(runner instanceof AgentRunner)) {
        throw new TypeError("Teammate runner factory must return AgentRunner");
      }
      const worker: Worker = {
        teammate: snapshot(name, role, TeammateStatus.Running),
        runner,
        task: undefined,
        currentMessage: undefined,
        abort: undefined,
        closeComplete: false,
        cleanupFailure: undefined,
      };
      this.#workers.set(name, worker);
      try {
        // Recovers processing messages left by teammates first before sending first task, ensuring old messages do not race with new messages and get lost.
        await this.#store.recoverProcessing(name);
        await this.#store.send(sender, name, prompt, MailboxMessageKind.Task);
        this.#startWorker(worker);
        return worker.teammate;
      } catch (error) {
        this.#workers.delete(name);
        await runner.close();
        throw error;
      }
    });
  }

  // Persistently send messages to Lead or ready teammates, waking Idle workers when necessary.
  async send(input: SendMessageInput & { readonly sender: string }): Promise<MailboxMessage> {
    this.#ensureAvailable();
    const sender = canonicalAgentName(input.sender);
    const to = canonicalAgentName(input.to);
    const content = requireText(input.content, "Mailbox message content");
    if (sender === to) throw new Error("Mailbox sender and recipient must differ");
    const message = await this.#withRegistry(async () => {
      this.#ensureAvailable();
      const worker = to === this.#leadName ? undefined : this.#workers.get(to);
      if (to !== this.#leadName && worker === undefined) {
        throw new TeammateNotFoundError(`Unknown teammate: ${to}`);
      }
      if (
        worker !== undefined &&
        (worker.teammate.status === TeammateStatus.Failed ||
          worker.teammate.status === TeammateStatus.Shutdown)
      ) {
        throw new TeammateStateError(
          `Teammate ${to} cannot receive messages while ${worker.teammate.status}`,
        );
      }
      const sent = await this.#store.send(sender, to, content, MailboxMessageKind.Message);
      if (worker !== undefined && worker.teammate.status === TeammateStatus.Idle) {
        // idle only indicates the worker finished this cycle; on new messages, reuse the existing Runner and re-fetch mailbox.
        this.#setStatus(worker, TeammateStatus.Running);
        this.#startWorker(worker);
      }
      return sent;
    });
    if (to === this.#leadName) await this.#notifyLead();
    return message;
  }

  // Drains events from shared event pump and synchronously clears the "enqueued" record in mailbox.
  drainEvents(limit?: number): readonly RuntimeEvent[] {
    const events = this.#cronRuntime.drainEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  // Blocks waiting for shared events, and synchronously clears "enqueued" registrations in the mailbox.
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    const events = await this.#cronRuntime.waitForEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  // Combine Cron and mailbox confirmation protocols; mailbox ack failure republishes the same event.
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
    // Acknowledges Cron events first, then acks mailbox individually; republishes on mailbox ack failure, waiting for Runner to backfill ack by event_id.
    await this.#cronRuntime.acknowledgeEvents(events);
    for (const event of events) {
      if (!isMailboxMessage(event)) continue;
      try {
        if (!(await this.#store.ack(event))) {
          throw new MailboxStorageError(`Mailbox message is not processing: ${event.id}`);
        }
      } catch (error) {
        // Republish the same event on confirmation failure; Runner deduplicates by event_id to prevent losing messages written to history.
        if (!this.#queuedMessageIds.has(event.id)) {
          this.#inbox.publish(event);
          this.#queuedMessageIds.add(event.id);
        }
        throw error;
      }
      this.#queuedMessageIds.delete(event.id);
    }
  }

  async close(): Promise<void> {
    // Shutdown proceeds in order of worker termination and resource release, ensuring unacknowledged messages are not dropped silently.
    if (this.#closed && [...this.#workers.values()].every((worker) => worker.closeComplete)) return;
    this.#closed = true;
    for (const worker of this.#workers.values()) worker.abort?.abort();
    const tasks = [...this.#workers.values()]
      .map((worker) => worker.task)
      .filter((task): task is Promise<void> => task !== undefined);
    const failures: unknown[] = [];
    for (const outcome of await Promise.allSettled(tasks)) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }
    for (const worker of this.#workers.values()) {
      if (worker.closeComplete) continue;
      let workerClosed = true;
      if (worker.cleanupFailure !== undefined) {
        workerClosed = false;
        failures.push(worker.cleanupFailure);
        worker.cleanupFailure = undefined;
      } else if (worker.currentMessage !== undefined) {
        try {
          await this.#store.release(worker.currentMessage);
          worker.currentMessage = undefined;
        } catch (error) {
          workerClosed = false;
          failures.push(error);
        }
      }
      try {
        await worker.runner.close();
      } catch (error) {
        workerClosed = false;
        failures.push(error);
      }
      worker.task = undefined;
      worker.abort = undefined;
      this.#setStatus(worker, TeammateStatus.Shutdown);
      worker.closeComplete = workerClosed;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "TeammateRuntime close failed");
  }

  async #spawnTool(input: SpawnTeammateInput, context: ToolContext): Promise<ToolResult> {
    try {
      const teammate = await this.spawn({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(teammate));
    } catch (error) {
      // Tool boundaries return observable errors only, without exposing internal stacks to the Agent.
      return toolError(errorCode(error, "teammate_spawn_error"), errorMessage(error));
    }
  }
  async #sendTool(input: SendMessageInput, context: ToolContext): Promise<ToolResult> {
    try {
      const message = await this.send({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(message.toPayload()));
    } catch (error) {
      // ToolContext.identity injects sender; tool input cannot forge message sources.
      return toolError(errorCode(error, "mailbox_send_error"), errorMessage(error));
    }
  }

  #startWorker(worker: Worker): void {
    // Each worker runs as a managed task under the supervisor, which handles unified tracking and shutdown.
    // Restart only when in-flight tasks finish; Idle teammates reuse the original Runner to return here upon receiving new messages.
    if (worker.task !== undefined) return;
    const abort = new AbortController();
    worker.abort = abort;
    const task = this.#supervisor.startManaged(async (signal) => {
      signal.addEventListener("abort", () => abort.abort(), { once: true });
      await this.#runWorker(worker, abort.signal);
    });
    worker.task = task;
    void task.then(
      () => {
        if (worker.task === task) {
          worker.task = undefined;
          if (!this.#closed && worker.teammate.status === TeammateStatus.Running) {
            this.#startWorker(worker);
          }
        }
        if (worker.abort === abort) worker.abort = undefined;
      },
      () => {
        if (worker.task === task) worker.task = undefined;
        if (worker.abort === abort) worker.abort = undefined;
      },
    );
  }

  async #runWorker(worker: Worker, signal: AbortSignal): Promise<void> {
    // The worker loop splits message processing into three states: transition to idle on no messages; ack after returning results on success; quarantine and expose errors to Lead on failure.
    try {
      while (!this.#closed) {
        // claim acquires a lease: on success, the current message enters processing until ack/release/quarantine.
        const message = await this.#store.claim(worker.teammate.name);
        if (message === undefined) {
          this.#setStatus(worker, TeammateStatus.Idle);
          return;
        }
        worker.currentMessage = message;
        this.#setStatus(worker, TeammateStatus.Running);
        try {
          // The same message UUID serves as this turn's idempotency key, allowing external tools to deduplicate.
          const result = await worker.runner.run(message.content, {
            idempotencyKey: message.id,
            signal,
          });
          await this.#store.send(
            worker.teammate.name,
            this.#leadName,
            result.finalText,
            MailboxMessageKind.Result,
          );
          if (!(await this.#store.ack(message))) {
            throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
          }
          worker.currentMessage = undefined;
        } catch (error) {
          if (this.#closed || signal.aborted) {
            // Releases back to ready instead of quarantining on close or cancel, preserving the chance to replay after crashes.
            try {
              if (!(await this.#store.release(message))) {
                throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
              }
              worker.currentMessage = undefined;
            } catch (releaseError) {
              if (this.#closed) {
                worker.cleanupFailure = releaseError;
                return;
              }
              throw releaseError;
            }
            return;
          }
          // Business failures isolate input into quarantine and publish an observable failure result to Lead.
          if (!(await this.#store.quarantine(message))) {
            throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
          }
          worker.currentMessage = undefined;
          throw error;
        }
        this.#setStatus(worker, TeammateStatus.Idle);
        await this.#notifyLead();
      }
      this.#setStatus(worker, TeammateStatus.Shutdown);
    } catch (error) {
      if (this.#closed) {
        this.#setStatus(worker, TeammateStatus.Shutdown);
        return;
      }
      this.#setStatus(worker, TeammateStatus.Failed);
      try {
        await this.#store.send(
          worker.teammate.name,
          this.#leadName,
          `Teammate ${worker.teammate.name} failed: ${errorMessage(error)}`,
          MailboxMessageKind.Result,
        );
        await this.#notifyLead();
      } catch {
        // When error results cannot be persisted further, state remains failed for callers to observe.
      }
    }
  }

  // Publish all current ready messages for Lead, and request an independent event turn when new events arrive.
  async #notifyLead(): Promise<void> {
    const published = await this.#publishLeadMessages();
    if (published && this.#wakeup !== undefined) await this.#wakeup();
  }
  async #publishLeadMessages(): Promise<boolean> {
    // Keep claiming during the publish phase until the lead mailbox is empty; each claim moves the message to processing.
    let published = false;
    while (true) {
      const message = await this.#store.claim(this.#leadName);
      if (message === undefined) return published;
      if (this.#queuedMessageIds.has(message.id)) {
        throw new MailboxStorageError(`Mailbox message was queued twice: ${message.id}`);
      }
      this.#inbox.publish(message);
      this.#queuedMessageIds.add(message.id);
      published = true;
    }
  }
  // Re-publish the same message to Inbox after drain when ack fails.
  #markMailboxEventsDequeued(events: readonly RuntimeEvent[]): void {
    for (const event of events)
      if (isMailboxMessage(event)) this.#queuedMessageIds.delete(event.id);
  }
  // State changes by replacing the frozen snapshot; external references are not modified in place.
  #setStatus(worker: Worker, status: TeammateStatus): void {
    worker.teammate = snapshot(worker.teammate.name, worker.teammate.role, status);
  }
  // spawn/send can execute only in started and unclosed runtimes.
  #ensureAvailable(): void {
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (!this.#started) throw new TeammateStateError("TeammateRuntime is not started");
  }
  async #withRegistry<T>(operation: () => Promise<T>): Promise<T> {
    // In-process promise queue serializes registration and sending to prevent concurrent spawn/send from causing teammate set inconsistencies.
    const previous = this.#registryTail;
    let release!: () => void;
    this.#registryTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// Creates immutable observable teammate state.
function snapshot(name: string, role: string, status: TeammateStatus): Teammate {
  return Object.freeze({ name, role, status });
}
// Validate and trim role, initial task, and message body.
function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must not be empty`);
  return value.trim();
}
// Identify mailbox messages in the shared event queue to avoid performing mailbox acks on Cron or background events.
function isMailboxMessage(value: RuntimeEvent): value is MailboxMessage {
  return value.toPayload().kind === "mailbox" && "id" in value;
}
function errorCode(error: unknown, fallback: string): string {
  // Domain errors retain errorCode; other exceptions uniformly use tool boundary fallback to prevent leaking internal exception types.
  return error instanceof TeammateError || error instanceof MailboxStorageError
    ? error.errorCode
    : fallback;
}
function errorMessage(error: unknown): string {
  // Only stable message is taken when converting error to string, without writing full stack traces into tool results.
  return error instanceof Error ? error.message : String(error);
}
