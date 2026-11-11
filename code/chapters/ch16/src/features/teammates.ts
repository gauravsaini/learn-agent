// Teammate runtime: manages persistent teammates with independent AgentRunners and identities, collaborating with Lead via mailbox/EventInbox; P16 adds protocol message routing and graceful shutdown.
import type { EventInbox, RuntimeEvent } from "../core/events.js";
import { isRuntimeEvent } from "../core/events.js";
import { AgentRunner } from "../core/loop.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import type { JobSupervisor } from "./background.js";
import type { CronRuntime } from "./cron.js";
import {
  canonicalAgentName,
  isProtocolMailboxMessage,
  isProtocolMailboxStore,
  MailboxMessageKind,
  MailboxStorageError,
  ProtocolMessageKind,
  sendMessageInputSchema,
  spawnTeammateInputSchema,
  type MailboxMessage,
  type MailboxItem,
  type MailboxStore,
  type ProtocolMailboxMessage,
  type SendMessageInput,
  type SpawnTeammateInput,
} from "./mailbox.js";
import type { ProtocolRuntime } from "./protocol.js";

export const LEAD_NAME = "lead";

export const TeammateStatus = Object.freeze({
  // The state machine only describes the teammate lifecycle within the current process; it stops receiving new messages after failed or shutdown.
  Running: "running",
  Idle: "idle",
  Failed: "failed",
  Shutdown: "shutdown",
});
export type TeammateStatus = (typeof TeammateStatus)[keyof typeof TeammateStatus];

// Teammate runtime errors uniformly carry stable errorCode; tool boundaries return structured failures accordingly.
export class TeammateError extends Error {
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
  // In-process worker state snapshot; replace as a whole when state changes.
  readonly status: TeammateStatus;
}

// The factory creates an AgentRunner with independent history for each teammate, injecting controlled message and protocol tools.
export type TeammateRunnerFactory = (
  name: string,
  role: string,
  sendToolDefinition: ToolDefinition<SendMessageInput>,
) => AgentRunner;

interface Worker {
  // Externally observable immutable teammate snapshot.
  teammate: Teammate;
  // AgentRunner and canonical history dedicated to this teammate.
  readonly runner: AgentRunner;
  // Managed task under supervisor; undefined indicates no in-flight loop currently.
  task: Promise<void> | undefined;
  // Current processing lease; must release back to ready on close or cancel.
  currentMessage: MailboxItem | undefined;
  // Cancellation controller for the current worker loop, connecting with supervisor signals.
  abort: AbortController | undefined;
  // Returns true only after both the message lease and Runner are cleaned up successfully, supporting close retry.
  closeComplete: boolean;
  // Buffer messages that cannot be released during cancellation, delegating to close for aggregated reporting.
  cleanupFailure: unknown | undefined;
}

// Each teammate has an independent AgentRunner and identity; shared resources are limited to mailbox, event Inbox, and scheduler.
export class TeammateRuntime {
  // Persistent MailboxStore shared by normal and protocol messages.
  readonly #store: MailboxStore;
  // Lead event publication target, sharing the same instance with CronRuntime.
  readonly #inbox: EventInbox;
  // All teammate workers run as managed tasks of this supervisor.
  readonly #supervisor: JobSupervisor;
  // Uniformly implement event drain, wait, ack, and wakeup ordering.
  readonly #cronRuntime: CronRuntime;
  // Normalized Lead name, fixed to lead by default.
  readonly #leadName: string;
  // Stores only teammates created in the current process and their independent Runners.
  readonly #workers = new Map<string, Worker>();
  // Record mailbox events published to EventInbox to avoid duplicate queueing when redelivered on confirmation failure.
  readonly #queuedMessageIds = new Set<string>();
  // Tool definition exposed to the model by Lead to spawn teammates.
  readonly #spawnToolDefinition: ToolDefinition<SpawnTeammateInput>;
  // Normal message tool definition shared between Lead and teammates.
  readonly #sendToolDefinition: ToolDefinition<SendMessageInput>;
  // The protocol runtime shares the same store with teammates, handling Lead-side message validation and ack state consumption.
  #protocolRuntime: ProtocolRuntime | undefined;
  // Injected before start to create a Runner with independent history for each teammate.
  #runnerFactory: TeammateRunnerFactory | undefined;
  // Trigger the composition root to schedule an event turn after publishing new Lead events.
  #wakeup: (() => Promise<void>) | undefined;
  // Serializes teammate registration, normal sends, and protocol delivery.
  #registryTail: Promise<void> = Promise.resolve();
  // spawn/send/deliverProtocol are permitted only after start completes.
  #started = false;
  // close blocks new operations from the start; if cleanup fails, call close again to retry.
  #closed = false;

  constructor(options: {
    readonly store: MailboxStore;
    readonly inbox: EventInbox;
    readonly supervisor: JobSupervisor;
    readonly cronRuntime: CronRuntime;
    readonly leadName?: string;
  }) {
    // The composition root must inject supervisor, Cron, and EventInbox into the same runtime; otherwise the event stream splits.
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

  get supervisor(): JobSupervisor {
    // The composition root reuses the same supervisor so background jobs and teammate workers share shutdown ordering.
    return this.#supervisor;
  }
  get eventInbox(): EventInbox {
    // Teammate results and Cron events enter the same event pump to prevent parallel history write paths.
    return this.#inbox;
  }
  get cronRuntime(): CronRuntime {
    // Delegate drain/wait/ack to shared CronRuntime to preserve unified event ordering.
    return this.#cronRuntime;
  }
  get mailboxStore(): MailboxStore {
    // Protocol and ordinary messages must share this Store to maintain a single lease state machine.
    return this.#store;
  }
  get hasPendingWork(): boolean {
    // CronRuntime aggregates EventInbox and schedule state, serving as the single TODO check for the event pump.
    return this.#cronRuntime.hasPendingWork;
  }
  get toolDefinitions(): readonly (
    | ToolDefinition<SpawnTeammateInput>
    | ToolDefinition<SendMessageInput>
  )[] {
    // Keeps tool order stable; composition root appends P16 protocol tools separately by identity.
    return Object.freeze([this.#spawnToolDefinition, this.#sendToolDefinition]);
  }
  get spawnToolDefinition(): ToolDefinition<SpawnTeammateInput> {
    // The composition root registers by capability bits without exposing internal mutable definitions.
    return this.#spawnToolDefinition;
  }
  get sendToolDefinition(): ToolDefinition<SendMessageInput> {
    // ToolContext always injects sender; tool input cannot forge message sources.
    return this.#sendToolDefinition;
  }

  configureRunnerFactory(factory: TeammateRunnerFactory): void {
    // Factories can bind only once before startup, preventing existing and newly created teammates from using different contracts.
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    if (this.#runnerFactory !== undefined || this.#started) {
      throw new TeammateStateError("Teammate runner factory must be configured once before start");
    }
    this.#runnerFactory = factory;
  }

  configureProtocol(runtime: ProtocolRuntime): void {
    // The protocol runtime must share the same MailboxStore with teammates, and can be configured only once before startup.
    if (runtime.teamRuntime !== this || runtime.mailboxStore !== this.#store) {
      throw new TeammateStateError("Protocol runtime must share this teammate runtime and mailbox");
    }
    if (this.#protocolRuntime !== undefined || this.#started) {
      throw new TeammateStateError("Protocol runtime must be configured once before start");
    }
    this.#protocolRuntime = runtime;
  }

  bindWakeup(wakeup: () => Promise<void>): void {
    // Composition root binds wakeup to start an independent event turn when new Lead events arrive.
    if (typeof wakeup !== "function") throw new TypeError("wakeup must be a function");
    this.#wakeup = wakeup;
  }

  async start(): Promise<void> {
    // Recover stale processing messages before starting Lead, then publish to EventInbox to prevent crash messages from lingering in leases.
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (this.#runnerFactory === undefined) {
      throw new TeammateStateError("Teammate runner factory is not configured");
    }
    if (this.#started) return;
    await this.#store.recoverProcessing(this.#leadName);
    await this.#publishLeadMessages();
    this.#started = true;
  }

  async ready(): Promise<void> {
    // Called before AgentRunner pulls events to ensure the Lead ready message is published.
    await this.start();
  }

  state(name: string): Teammate {
    // State queries only read the Map, do not start workers, and do not produce mailbox side effects.
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.teammate;
  }

  beginShutdown(name: string): void {
    // shutdown state is set before response delivery, preventing subsequent protocol deliveries to this teammate.
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    this.#setStatus(worker, TeammateStatus.Shutdown);
  }

  async spawn(input: SpawnTeammateInput & { readonly sender: string }): Promise<Teammate> {
    // Recovers processing messages left by teammates first before sending first task, ensuring old messages do not race with new messages and get lost.
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

  // Protocol delivery shares registry serialization and only sends to registered teammates or Lead ready to receive.
  async deliverProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: {
      readonly requestId: string;
      readonly approved: boolean | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<ProtocolMailboxMessage> {
    // Check abort before and after persistence; do not wake participants after cancellation.
    this.#ensureAvailable();
    if (!isProtocolMailboxStore(this.#store)) {
      throw new TeammateStateError("Mailbox store does not support protocol messages");
    }
    const protocolStore = this.#store;
    if (options.signal?.aborted)
      throw new DOMException("Protocol delivery was aborted", "AbortError");
    const from = canonicalAgentName(sender);
    const to = canonicalAgentName(recipient);
    if (from === to) throw new Error("Protocol sender and recipient must differ");
    const message = await this.#withRegistry(async () => {
      this.#ensureAvailable();
      if (options.signal?.aborted)
        throw new DOMException("Protocol delivery was aborted", "AbortError");
      this.#assertParticipant(from, kind === ProtocolMessageKind.ShutdownResponse);
      this.#assertParticipant(to);
      const sent = await protocolStore.sendProtocol(
        from,
        to,
        requireText(content, "Protocol content"),
        kind,
        options,
      );
      if (options.signal?.aborted)
        throw new DOMException("Protocol delivery was aborted", "AbortError");
      const worker = to === this.#leadName ? undefined : this.#workers.get(to);
      if (worker !== undefined && worker.teammate.status === TeammateStatus.Idle) {
        this.#setStatus(worker, TeammateStatus.Running);
        this.#startWorker(worker);
      }
      return sent;
    });
    if (to === this.#leadName) await this.#notifyLead();
    return message;
  }

  drainEvents(limit?: number): readonly RuntimeEvent[] {
    // Clears the queued flag when an event dequeues to ensure republishing after ack failure is recognized as a retry by Runner.
    const events = this.#cronRuntime.drainEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    // The wait path and drain path share deduplication logic; waiting events must not occupy the queued flag indefinitely.
    const events = await this.#cronRuntime.waitForEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    // Protocol events consume ProtocolStore state before transport ack; ordinary messages ack directly.
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
    await this.#cronRuntime.acknowledgeEvents(events);
    for (const event of events) {
      if (!(isMailboxMessage(event) || isProtocolMailboxMessage(event))) continue;
      const mailboxEvent = event as MailboxItem;
      try {
        if (isProtocolMailboxMessage(mailboxEvent)) {
          const runtime = this.#protocolRuntime;
          if (runtime === undefined)
            throw new TeammateStateError("Protocol runtime is not configured");
          await runtime.acknowledgeLeadMessage(mailboxEvent);
        }
        if (!(await this.#store.ack(mailboxEvent))) {
          throw new MailboxStorageError(`Mailbox message is not processing: ${mailboxEvent.id}`);
        }
      } catch (error) {
        // Republish the same event on confirmation failure; Runner deduplicates by event_id to prevent losing messages written to history.
        if (!this.#queuedMessageIds.has(mailboxEvent.id)) {
          this.#inbox.publish(mailboxEvent);
          this.#queuedMessageIds.add(mailboxEvent.id);
        }
        throw error;
      }
      this.#queuedMessageIds.delete(event.id);
    }
  }

  // Shutdown proceeds in order of worker termination and resource release, ensuring unacknowledged messages are not dropped silently.
  async close(): Promise<void> {
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

  // Tool boundaries return observable errors only, without exposing internal stacks to the Agent.
  async #spawnTool(input: SpawnTeammateInput, context: ToolContext): Promise<ToolResult> {
    try {
      const teammate = await this.spawn({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(teammate));
    } catch (error) {
      return toolError(errorCode(error, "teammate_spawn_error"), errorMessage(error));
    }
  }
  // ToolContext.identity injects sender; tool input cannot forge message sources.
  async #sendTool(input: SendMessageInput, context: ToolContext): Promise<ToolResult> {
    try {
      const message = await this.send({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(message.toPayload()));
    } catch (error) {
      return toolError(errorCode(error, "mailbox_send_error"), errorMessage(error));
    }
  }

  #startWorker(worker: Worker): void {
    // Each worker runs as a managed task under the supervisor, which handles unified tracking and shutdown.
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
    // claim acquires a lease: on success, the current message enters processing until ack/release/quarantine.
    try {
      while (!this.#closed) {
        const message = await this.#store.claim(worker.teammate.name);
        if (message === undefined) {
          this.#setStatus(worker, TeammateStatus.Idle);
          return;
        }
        worker.currentMessage = message;
        this.#setStatus(worker, TeammateStatus.Running);
        try {
          // The same message UUID serves as this turn's idempotency key, allowing external tools to deduplicate.
          let finalText: string;
          if (isProtocolMailboxMessage(message)) {
            // Route protocol messages before model calls; shutdown terminates directly, and only plan responses generate model prompts.
            const runtime = this.#protocolRuntime;
            if (runtime === undefined)
              throw new TeammateStateError("Protocol runtime is not configured");
            const route = await runtime.routeTeammateMessage(worker.teammate.name, message, signal);
            if (route.shutdown) {
              if (!(await this.#store.ack(message))) {
                throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
              }
              worker.currentMessage = undefined;
              this.#setStatus(worker, TeammateStatus.Shutdown);
              return;
            }
            if (route.prompt === undefined)
              throw new TeammateStateError("Protocol route did not provide a prompt");
            finalText = (
              await worker.runner.run(route.prompt, {
                idempotencyKey: message.id,
                signal,
              })
            ).finalText;
          } else {
            // Normal messages pass content directly to the teammate Runner.
            finalText = (
              await worker.runner.run(message.content, {
                idempotencyKey: message.id,
                signal,
              })
            ).finalText;
          }
          await this.#store.send(
            worker.teammate.name,
            this.#leadName,
            finalText,
            MailboxMessageKind.Result,
          );
          // Acks original message after teammate results are written back to Lead, so neither results nor lease releases are lost.
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
          if (isProtocolMailboxMessage(message) && !isProtocolQuarantineError(error)) {
            // Non-protocol errors are not quarantined; worker fails after release, keeping messages for replay after diagnostics.
            if (!(await this.#store.release(message))) {
              throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
            }
            worker.currentMessage = undefined;
            throw error;
          }
          if (!(await this.#store.quarantine(message))) {
            // Business failures isolate input into quarantine and publish an observable failure result to Lead.
            throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
          }
          worker.currentMessage = undefined;
          if (isProtocolMailboxMessage(message)) continue;
          throw error;
        }
        this.#setStatus(worker, TeammateStatus.Idle);
        // Actively notify the Lead after completing a turn, giving run_events the opportunity to consume results immediately.
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

  async #notifyLead(): Promise<void> {
    // Wake event turns only when new events are published; empty scans do not produce model calls.
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
      if (isProtocolMailboxMessage(message)) {
        const runtime = this.#protocolRuntime;
        if (runtime === undefined) {
          await this.#store.release(message);
          throw new TeammateStateError("Protocol runtime is not configured");
        }
        try {
          await runtime.validateLeadMessage(message);
        } catch (error) {
          // Lead protocol messages validate read-only first: quarantine if protocol is invalid, release other failures for upper-layer retry.
          if (!isProtocolQuarantineError(error)) {
            await this.#store.release(message);
            throw error;
          }
          if (!(await this.#store.quarantine(message))) {
            throw new MailboxStorageError(`Protocol message is not processing: ${message.id}`);
          }
          continue;
        }
      }
      this.#inbox.publish(message);
      this.#queuedMessageIds.add(message.id);
      published = true;
    }
  }
  #markMailboxEventsDequeued(events: readonly RuntimeEvent[]): void {
    // Dequeue releases in-process deduplication flag only; durable processing state still awaits ack handling.
    for (const event of events) {
      if (!(isMailboxMessage(event) || isProtocolMailboxMessage(event))) continue;
      this.#queuedMessageIds.delete((event as MailboxItem).id);
    }
  }
  #assertParticipant(name: string, allowShutdown = false): void {
    // Lead can always receive; normal teammates must exist and not be failed/shutdown; shutdown responses may be sent to teammates already shutting down.
    if (name === this.#leadName) return;
    const worker = this.#workers.get(name);
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    if (
      worker.teammate.status === TeammateStatus.Failed ||
      (worker.teammate.status === TeammateStatus.Shutdown && !allowShutdown)
    ) {
      throw new TeammateStateError(
        `Teammate ${name} cannot receive protocol messages while ${worker.teammate.status}`,
      );
    }
  }
  #setStatus(worker: Worker, status: TeammateStatus): void {
    // State changes by replacing the frozen snapshot; external references are not modified in place.
    worker.teammate = snapshot(worker.teammate.name, worker.teammate.role, status);
  }
  #ensureAvailable(): void {
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (!this.#started) throw new TeammateStateError("TeammateRuntime is not started");
  }
  async #withRegistry<T>(operation: () => Promise<T>): Promise<T> {
    // In-process promise queue serializes registration, sending, and protocol delivery to prevent concurrent operations from causing teammate set inconsistencies.
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

function snapshot(name: string, role: string, status: TeammateStatus): Teammate {
  // Return newly frozen objects on each transition so observers do not see partially updated fields.
  return Object.freeze({ name, role, status });
}
function requireText(value: string, label: string): string {
  // Mailbox and protocol bodies reject whitespace uniformly to prevent generating non-executable turns.
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must not be empty`);
  return value.trim();
}
function isMailboxMessage(value: RuntimeEvent): value is MailboxMessage {
  // Both normal and protocol events use kind=mailbox; this guard only narrows P15 normal messages.
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
function isProtocolQuarantineError(error: unknown): boolean {
  // Quarantine only on protocol mismatch, non-existence, expiration, or state errors; delegate other errors to outer recovery logic.
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "errorCode");
  return (
    code === "protocol_mismatch" ||
    code === "protocol_not_found" ||
    code === "protocol_expired" ||
    code === "protocol_state_error"
  );
}
