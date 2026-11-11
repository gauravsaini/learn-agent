// Teammate runtime: manages persistent teammates with independent AgentRunners and identities, collaborating with Lead via mailbox/EventInbox; P16 adds protocol message routing and graceful shutdown, P17 adds automatic SQLite task claims and idle polling, P18 uses claim tokens as idempotency keys for task turns.
// Teammate runtime: manages persistent teammates with independent AgentRunners and identities, collaborating with Lead via mailbox/EventInbox; P16 adds protocol message routing and graceful shutdown, P17 adds automatic SQLite task claims and idle polling.
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
import type { WorkStealingRuntime } from "./work-stealing.js";

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
  readonly name: string;
  readonly role: string;
  readonly status: TeammateStatus;
}

export type TeammateRunnerFactory = (
  name: string,
  role: string,
  sendToolDefinition: ToolDefinition<SendMessageInput>,
) => AgentRunner;

interface Worker {
  // Worker aggregates Runner, cancel signals, wakeup signals, and lifecycle states for a single persistent teammate.
  teammate: Teammate;
  readonly runner: AgentRunner;
  task: Promise<void> | undefined;
  currentMessage: MailboxItem | undefined;
  abort: AbortController | undefined;
  closeComplete: boolean;
  cleanupFailure: unknown | undefined;
  // Idle polling state is held by the worker; upon receiving a new message, it stops waiting immediately and rescans.
  pollWakeup: AbortController | undefined;
  idlePolls: number;
  idleTimeoutCount: number;
  idleTimeout: Deferred<void>;
}

interface Deferred<T> {
  // P17 preserves an independent completion signal for managed polling so idle termination is awaitable without relying solely on counters.
  // ready/idle waits use explicit Promise controllers; state transitions occur only inside runtime.
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

// Each teammate has an independent AgentRunner and identity; shared resources are limited to mailbox, event Inbox, and scheduler.
export class TeammateRuntime {
  // Lead, all workers, mailbox, protocol, and work stealing share this runtime to avoid maintaining duplicate state copies.
  readonly #store: MailboxStore;
  readonly #inbox: EventInbox;
  readonly #supervisor: JobSupervisor;
  readonly #cronRuntime: CronRuntime;
  readonly #leadName: string;
  readonly #workers = new Map<string, Worker>();
  // Record mailbox events published to EventInbox to avoid duplicate queueing when redelivered on confirmation failure.
  readonly #queuedMessageIds = new Set<string>();
  readonly #spawnToolDefinition: ToolDefinition<SpawnTeammateInput>;
  readonly #sendToolDefinition: ToolDefinition<SendMessageInput>;
  // The protocol runtime shares the same store with teammates, handling Lead-side message validation and ack state consumption.
  #protocolRuntime: ProtocolRuntime | undefined;
  // Bind work-stealing runtime before startup to manage SQLite task claims and idle polling.
  #workStealingRuntime: WorkStealingRuntime | undefined;
  #runnerFactory: TeammateRunnerFactory | undefined;
  #wakeup: (() => Promise<void>) | undefined;
  #registryTail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor(options: {
    readonly store: MailboxStore;
    readonly inbox: EventInbox;
    readonly supervisor: JobSupervisor;
    readonly cronRuntime: CronRuntime;
    readonly leadName?: string;
  }) {
    // Constructor validates shared supervisor/inbox/cron references; complete Runner, protocol, and work stealing before start.
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
    return this.#supervisor;
  }
  get eventInbox(): EventInbox {
    return this.#inbox;
  }
  get cronRuntime(): CronRuntime {
    return this.#cronRuntime;
  }
  get mailboxStore(): MailboxStore {
    return this.#store;
  }
  get workStealingRuntime(): WorkStealingRuntime | undefined {
    return this.#workStealingRuntime;
  }
  get hasPendingWork(): boolean {
    return this.#cronRuntime.hasPendingWork;
  }
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

  configureRunnerFactory(factory: TeammateRunnerFactory): void {
    // The factory must be configured once before use; it decides tool sets and identities for teammate independent Runners.
    // factory can be configured only once before start, ensuring all workers use the same tools and governance policy.
    if (typeof factory !== "function") throw new TypeError("factory must be a function");
    if (this.#runnerFactory !== undefined || this.#started) {
      throw new TeammateStateError("Teammate runner factory must be configured once before start");
    }
    this.#runnerFactory = factory;
  }

  configureProtocol(runtime: ProtocolRuntime): void {
    // The protocol runtime must bind before startup and share the same MailboxStore with teammates.
    // The protocol runtime must reuse the current team and mailbox store to prevent forks between request registration and message delivery.
    // The protocol runtime must share the same MailboxStore with teammates, and can be configured only once before startup.
    if (runtime.teamRuntime !== this || runtime.mailboxStore !== this.#store) {
      throw new TeammateStateError("Protocol runtime must share this teammate runtime and mailbox");
    }
    if (this.#protocolRuntime !== undefined || this.#started) {
      throw new TeammateStateError("Protocol runtime must be configured once before start");
    }
    this.#protocolRuntime = runtime;
  }

  configureWorkStealing(runtime: WorkStealingRuntime): void {
    // work-stealing requires protocol runtime as plan gate, configurable only once before startup.
    // Must bind before start; replacing claim services after worker startup breaks identity consistency of active leases.
    // work-stealing requires ProtocolRuntime as plan gate: do not claim automatically when the latest plan is pending/rejected.
    if (this.#workStealingRuntime !== undefined || this.#started) {
      throw new TeammateStateError("Work-stealing runtime must be configured once before start");
    }
    if (this.#protocolRuntime === undefined) {
      throw new TeammateStateError("Work-stealing runtime requires Protocol runtime");
    }
    this.#workStealingRuntime = runtime;
  }

  bindWakeup(wakeup: () => Promise<void>): void {
    // wakeup serves only as external notification; teammate runtimes do not depend directly on concrete CLI/AgentRunner implementations.
    // Calls outer AgentRunner.runEvents when Lead events arrive; duplicate bindings fail explicitly.
    if (typeof wakeup !== "function") throw new TypeError("wakeup must be a function");
    this.#wakeup = wakeup;
  }

  async start(): Promise<void> {
    // Recover stale processing messages before startup, then publish to EventInbox to prevent crash messages from lingering in leases.
    // Recover processing messages for Lead and workers on startup before starting event pumps and registered workers.
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
    // RuntimeEventPump contract requires ready; idempotent with start, so duplicate calls do not trigger duplicate starts.
    // Wait for the Lead message pump to complete first recovery; callers can safely send protocol requests afterward.
    await this.start();
  }

  state(name: string): Teammate {
    // Return only a read-only snapshot; callers cannot mutate the teammate state machine through state().
    // Returns an immutable public snapshot without exposing internal resources like Worker Runner or AbortController.
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.teammate;
  }

  idleTimeoutCount(name: string): number {
    // Observe idle polling completion counts as read-only, allowing tests to confirm idle teammates do not forge shutdown or exit states.
    // Expose consecutive empty poll counts for tests and shutdown strategies to observe; callers cannot modify it directly.
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    return worker.idleTimeoutCount;
  }

  async waitForIdleTimeout(name: string): Promise<void> {
    // Wait for the current worker idle poll to complete; tests can verify managed task completion without fixed poll durations.
    // Completes only after reaching maxIdlePolls; new tasks or messages reset the counter.
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    await worker.idleTimeout.promise;
  }

  beginShutdown(name: string): void {
    // External explicit shutdown entry; the worker enters Shutdown after processing the current message.
    // Marks closing first and wakes waiting workers; shutdown protocol response confirms actual terminal state.
    const worker = this.#workers.get(canonicalAgentName(name));
    if (worker === undefined) throw new TeammateNotFoundError(`Unknown teammate: ${name}`);
    this.#setStatus(worker, TeammateStatus.Shutdown);
  }

  async spawn(input: SpawnTeammateInput & { readonly sender: string }): Promise<Teammate> {
    // When creating a teammate, recover leftover processing messages before sending the first task to ensure old messages do not race with new messages and get lost.
    // Registry writes serialize with worker starts, preventing name collision checks and status publications from interleaving.
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
        pollWakeup: undefined,
        idlePolls: 0,
        idleTimeoutCount: 0,
        idleTimeout: deferred<void>(),
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
    // Message sending serializes through the registry; Idle teammates wake immediately to rescan upon receiving messages.
    // Verify participant states before sending; wake the target worker or notify the Lead event pump after successful disk write.
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
        this.#wakeWorker(worker);
        this.#startWorker(worker);
      }
      return sent;
    });
    if (to === this.#leadName) await this.#notifyLead();
    return message;
  }

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
    // Protocol delivery shares registry serialization and only sends to registered teammates or Lead ready to receive.
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
        this.#wakeWorker(worker);
        this.#startWorker(worker);
      }
      return sent;
    });
    if (to === this.#leadName) await this.#notifyLead();
    return message;
  }

  drainEvents(limit?: number): readonly RuntimeEvent[] {
    // Pulls background events from CronRuntime and records dequeued mailbox events to prevent duplicate queuing.
    // Non-blocking pull of shared events, synchronously updating the mailbox deduplication set.
    const events = this.#cronRuntime.drainEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    // Register mailbox dequeue state when waiting for events, maintaining the same deduplication semantics as drain.
    // Blocking wait and drain use the same dequeue accounting to prevent duplicate publishing of the same message.
    const events = await this.#cronRuntime.waitForEvents(limit);
    this.#markMailboxEventsDequeued(events);
    return events;
  }
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    // Protocol events consume ProtocolStore state before transport ack; ordinary messages ack directly.
    // Acknowledges Cron events first before consuming protocol state and mailbox lease; failed events re-enqueue for retry.
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

  async close(): Promise<void> {
    // Shutdown proceeds in order of worker termination and resource release, ensuring unacknowledged messages are not dropped silently.
    if (this.#closed && [...this.#workers.values()].every((worker) => worker.closeComplete)) return;
    this.#closed = true;
    for (const worker of this.#workers.values()) {
      worker.abort?.abort();
      this.#wakeWorker(worker);
    }
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
    // Tool boundaries return observable errors only, without exposing internal stacks to the Agent.
    try {
      const teammate = await this.spawn({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(teammate));
    } catch (error) {
      return toolError(errorCode(error, "teammate_spawn_error"), errorMessage(error));
    }
  }
  async #sendTool(input: SendMessageInput, context: ToolContext): Promise<ToolResult> {
    // ToolContext.identity injects sender; tool input cannot forge message sources.
    try {
      const message = await this.send({ ...input, sender: context.identity });
      return toolSuccess(JSON.stringify(message.toPayload()));
    } catch (error) {
      return toolError(errorCode(error, "mailbox_send_error"), errorMessage(error));
    }
  }

  #startWorker(worker: Worker): void {
    // Each worker runs as a managed task under the supervisor, which handles unified tracking and shutdown.
    // Each worker allows only one running Promise at a time, resolving waiters like shutdown or idle upon completion.
    if (worker.task !== undefined) return;
    const abort = new AbortController();
    worker.abort = abort;
    const task = this.#supervisor.startManaged(async (signal) => {
      signal.addEventListener(
        "abort",
        () => {
          abort.abort();
          this.#wakeWorker(worker);
        },
        { once: true },
      );
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

  // Main loop for a single teammate: claim dedicated mailbox messages first, then attempt work stealing within protocol limits;
  // Enter polling wait when no executable tasks exist, waking on new messages or shutdown signals.
  async #runWorker(worker: Worker, signal: AbortSignal): Promise<void> {
    // Turn priority order: mailbox/protocol, plan gating, automatic claim, interruptible wait; prevents tasks from preempting control messages.
    // claim acquires a lease: on success, the current message enters processing until ack/release/quarantine ends this turn.
    try {
      while (!this.#closed) {
        // The registry serializes scans to prevent teammates from concurrently claiming the same message or claim.
        // Priority order for each scan: Mailbox message > typed Protocol > auto-claim > poll wait.
        // Mailbox prioritizes shutdown/plan response to prevent starvation by ready tasks.
        // Skips claim when Protocol.planAllowsEffectful is false, maintaining the latest plan gate.
        const scan = await this.#withRegistry(async () => {
          this.#ensureAvailable();
          const message = await this.#store.claim(worker.teammate.name);
          if (message !== undefined) {
            return { message, workStealing: undefined, claim: undefined };
          }
          const workStealing = this.#workStealingRuntime;
          if (workStealing === undefined) {
            return { message: undefined, workStealing: undefined, claim: undefined };
          }
          const protocol = this.#protocolRuntime;
          if (protocol === undefined) {
            throw new TeammateStateError("Work-stealing runtime requires Protocol runtime");
          }
          // When the current plan does not allow side effects, do not enter work stealing to avoid unauthorized actions on behalf of the Lead.
          if (!(await protocol.planAllowsEffectful(worker.teammate.name))) {
            return { message: undefined, workStealing, claim: undefined };
          }
          return {
            message: undefined,
            workStealing,
            claim: await workStealing.claimNext(worker.teammate.name),
          };
        });
        const message = scan.message;
        if (message === undefined) {
          const workStealing = scan.workStealing;
          if (workStealing === undefined) {
            this.#setStatus(worker, TeammateStatus.Idle);
            return;
          }
          const claim = scan.claim;
          // claim is an atomic SQLite lease; claimToken also acts as an idempotency key so failure replay does not execute the same task repeatedly.
          if (claim !== undefined) {
            // claim token also acts as the idempotency key for this AgentRunner.run() turn to prevent the model completing tasks repeatedly on retry.
            worker.idlePolls = 0;
            this.#setStatus(worker, TeammateStatus.Running);
            const finalText = (
              await worker.runner.run(workStealing.renderClaimPrompt(claim), {
                idempotencyKey: claim.claimToken,
                claimToken: claim.claimToken,
                signal,
              })
            ).finalText;
            // Subagent results write back to the Lead mailbox and #notifyLead aggregates them into the inbox.
            await this.#store.send(
              worker.teammate.name,
              this.#leadName,
              finalText,
              MailboxMessageKind.Result,
            );
            this.#setStatus(worker, TeammateStatus.Idle);
            await this.#notifyLead();
            continue;
          }
          // Suspend and wait when no claimable tasks exist; send, deliverProtocol, or close aborts pollWakeup to rescan immediately.
          this.#setStatus(worker, TeammateStatus.Idle);
          const wakeup = new AbortController();
          worker.pollWakeup = wakeup;
          // #wakeWorker can abort waitForPoll early so idle teammates restart scanning immediately upon receiving new messages.
          await workStealing.waitForPoll(wakeup.signal);
          if (worker.pollWakeup === wakeup) worker.pollWakeup = undefined;
          if (wakeup.signal.aborted) continue;
          worker.idlePolls += 1;
          if (worker.idlePolls >= workStealing.maxIdlePolls) {
            worker.idleTimeoutCount += 1;
            worker.idleTimeout.resolve();
            return;
          }
          continue;
        }
        worker.idlePolls = 0;
        worker.currentMessage = message;
        this.#setStatus(worker, TeammateStatus.Running);
        try {
          // The same mailbox message UUID serves as this turn's idempotency key; auto-claims use the claim token.
          let finalText: string;
          // ProtocolRuntime parses protocol messages first, which may trigger shutdown, continuation, or quarantine.
          if (isProtocolMailboxMessage(message)) {
            // Route protocol messages before model calls; shutdown terminates directly, and only plan responses generate model prompts.
            const runtime = this.#protocolRuntime;
            if (runtime === undefined)
              throw new TeammateStateError("Protocol runtime is not configured");
            const route = await runtime.routeTeammateMessage(worker.teammate.name, message, signal);
            if (route.shutdown) {
              // When the protocol requests shutdown, confirm the original message is acked before ending the teammate loop to avoid lingering shutdown state.
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
          // Persists result before acking original message; teammates can still replay original tasks on failure before Lead receives result.
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
          // Does not mark tasks as failed on close or cancel; releases messages for rescanning next turn to avoid mistaking interruptions for results.
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
          // Non-isolation protocol errors release the message and throw, logged as failed by the outer layer; isolation errors go to quarantine.
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
      // If not closed, teammate loop exit marks failed and attempts to persist the failure cause to the Lead.
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

  // After a teammate produces new results, publishes messages from the Lead mailbox to inbox and wakes event consumers.
  async #notifyLead(): Promise<void> {
    // Coalesce concurrent notifications into a single pump task to prevent parallel runEvents triggers for every mailbox message.
    const published = await this.#publishLeadMessages();
    if (published && this.#wakeup !== undefined) await this.#wakeup();
  }
  // Loop claims persisted Lead messages and publishes them; use queuedMessageIds to prevent duplicate enqueuing.
  async #publishLeadMessages(): Promise<boolean> {
    // Publish Lead messages in mailbox lease order. If publishing fails, release the lease and wait for the next retry.
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
          // When protocol message validation fails, quarantine only isolatable errors such as protocol mismatch or expiration; release and throw the rest.
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
      // Published messages are removed from the set after dequeuing by event pumps; rescan on ack failure will not redeliver.
      this.#inbox.publish(message);
      this.#queuedMessageIds.add(message.id);
      published = true;
    }
  }
  // Event pump removes messages from the deduplication set upon retrieval; if ack fails later, messages can re-enter the event stream.
  #markMailboxEventsDequeued(events: readonly RuntimeEvent[]): void {
    // Removes queued flag after event leaves Inbox; allows republishing only when ack fails.
    for (const event of events) {
      if (!(isMailboxMessage(event) || isProtocolMailboxMessage(event))) continue;
      this.#queuedMessageIds.delete((event as MailboxItem).id);
    }
  }
  // Verify participants exist and can receive before protocol delivery; shutdown response allows terminated teammates to send confirmations.
  #assertParticipant(name: string, allowShutdown = false): void {
    // Lead can always receive; normal teammates must exist with permitted status; shutdown response is the only terminal exception.
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
  // State is stored in an immutable snapshot to prevent external references from directly modifying teammate records.
  #setStatus(worker: Worker, status: TeammateStatus): void {
    // State changes are written centrally to ensure public snapshots and internal workers always stay consistent.
    worker.teammate = snapshot(worker.teammate.name, worker.teammate.role, status);
  }
  // Aborts current polling wait so teammates immediately rescan for new messages.
  #wakeWorker(worker: Worker): void {
    // abort only wakes up the current sleep; a new controller replaces it immediately, and the worker lifecycle itself is not cancelled.
    // Interrupts polling sleep so that idle workers rescan the Mailbox in the next loop.
    worker.pollWakeup?.abort();
  }
  // Business entry points must be explicitly started and not closed; fail on missing state instead of silently creating an empty runtime.
  #ensureAvailable(): void {
    // Runtime rejects all new operations after shutdown, avoiding writes to disk after resources are released.
    if (this.#closed) throw new TeammateClosedError("TeammateRuntime is closed");
    if (!this.#started) throw new TeammateStateError("TeammateRuntime is not started");
  }
  // Use a trailing Promise to serialize teammate registry operations, ensuring concurrent entries change workers and status in order.
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

// Returns a frozen teammate snapshot so external code can only read unmodifiable state.
function snapshot(name: string, role: string, status: TeammateStatus): Teammate {
  return Object.freeze({ name, role, status });
}
// Creates one-off deferred for single wake-up scenarios such as polling timeouts and shutdown completion.
function deferred<T>(): Deferred<T> {
  // Each worker uses an independent Deferred to ensure test waits do not cross teammates.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}
// Uniformly validate required strings, stripping leading and trailing whitespace and rejecting empty values.
function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must not be empty`);
  return value.trim();
}
// Use payload kind to distinguish mailbox message events, facilitating event deduplication and protocol routing.
function isMailboxMessage(value: RuntimeEvent): value is MailboxMessage {
  return value.toPayload().kind === "mailbox" && "id" in value;
}
// The tool result layer preferentially returns structured error codes, using fallback for unknown errors to keep output stable.
function errorCode(error: unknown, fallback: string): string {
  // Domain errors retain errorCode; other exceptions uniformly use tool boundary fallback to prevent leaking internal exception types.
  return error instanceof TeammateError || error instanceof MailboxStorageError
    ? error.errorCode
    : fallback;
}
// Extract error messages uniformly, converting non-Error values into displayable text.
function errorMessage(error: unknown): string {
  // Only stable message is taken when converting error to string, without writing full stack traces into tool results.
  return error instanceof Error ? error.message : String(error);
}
// Protocol version and state errors are isolatable issues, not fatal teammate runtime errors.
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
