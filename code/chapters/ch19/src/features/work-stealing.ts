// Task claim and completion capabilities: Lead, subagents, and continuous teammates operate on tasks via the same SQLite store and claim service, avoiding independent state reads and writes.
import { z } from "zod";

import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import { canonicalTaskId, type Task, TaskError } from "./tasks.js";
import type { CreateTaskInput, TaskCompletion } from "./tasks.js";

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const createTaskSchema = z.strictObject({
  subject: z.string().trim().min(1),
  description: z.string().trim().default(""),
  blocked_by: z.array(uuidSchema).default([]),
});
const taskIdSchema = z.strictObject({ task_id: uuidSchema });
const listTasksSchema = z.strictObject({});
const completeTaskSchema = z.strictObject({ task_id: uuidSchema, claim_token: uuidSchema });

export class TaskClaimError extends TaskError {
  // Indicates caller-submitted owner/token does not match current lease, reliably mapping to a tool error code.
  constructor(message: string, code = "task_claim_mismatch") {
    super(code, message);
    this.name = "TaskClaimError";
  }
}

export class TaskLeaseExpiredError extends TaskClaimError {
  // Explicitly distinguish "previously valid but expired" so the model re-claims instead of repeatedly completing.
  constructor(message: string) {
    super(message, "task_lease_expired");
    this.name = "TaskLeaseExpiredError";
  }
}

export interface TaskClaim {
  // claimToken proves completion permission; even with the same owner, old leases cannot complete a re-claimed task.
  readonly task: Task;
  readonly claimToken: string;
  readonly leaseExpiresAtUtc: Date;
}

export interface LeasedTaskStore {
  // The storage layer handles atomic semantics for DAG, leases, and tokens; the tool layer does not splice persistence operations directly.
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  listTasks(): Promise<readonly Task[]>;
  claimTask(taskId: string, owner: string): Promise<TaskClaim>;
  claimNext(owner: string): Promise<TaskClaim | undefined>;
  completeTask(taskId: string, owner: string, claimToken: string): Promise<TaskCompletion>;
}

export interface TaskClaimService {
  // service binds execution identity to storage owner, preventing models forging other Agents via tool arguments.
  readonly store: LeasedTaskStore;
  claimTask(taskId: string, context: ToolContext): Promise<TaskClaim>;
  claimNext(owner: string): Promise<TaskClaim | undefined>;
  completeTask(taskId: string, claimToken: string, context: ToolContext): Promise<TaskCompletion>;
}

// Default service maps ToolContext.identity to owner, preventing tool inputs from forging claim owners.
class DirectTaskClaimService implements TaskClaimService {
  readonly #store: LeasedTaskStore;

  constructor(store: LeasedTaskStore) {
    // service does not copy state; it holds only the single store reference provided by the composition root.
    this.#store = store;
  }

  get store(): LeasedTaskStore {
    // Expose reference identity for WorkStealingRuntime to reject mismatched services.
    return this.#store;
  }

  async claimTask(taskId: string, context: ToolContext): Promise<TaskClaim> {
    // Owners for manual tool claims are fixed from ToolContext.identity.
    return await this.#store.claimTask(taskId, context.identity);
  }

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    // Automatic scanning is not a model tool call; callers pass owner directly, bypassing ToolContext and preventing model forgery.
    return await this.#store.claimNext(owner);
  }

  async completeTask(
    taskId: string,
    claimToken: string,
    context: ToolContext,
  ): Promise<TaskCompletion> {
    // Completion also binds owner from context and requires the model to return the current claim token.
    return await this.#store.completeTask(taskId, context.identity, claimToken);
  }
}

export interface WorkStealingSleeper {
  // New messages, protocol events, or shutdown workflows can interrupt wakeup to avoid workers waiting for the entire polling cycle.
  sleep(seconds: number, wakeup: AbortSignal): Promise<void>;
}

// Lead uses the full five-tool tuple; Teammate removes create_task via slicing.
type LeasedToolDefinitions = ReturnType<typeof leasedTaskToolDefinitions>;
type TeammateLeasedToolDefinitions = readonly LeasedToolDefinitions[number][];

// AsyncioWorkStealingSleeper default sleeper uses timer + abort listener to prevent idle polling from blocking shutdown.
export class AsyncioWorkStealingSleeper implements WorkStealingSleeper {
  async sleep(seconds: number, wakeup: AbortSignal): Promise<void> {
    // Return directly if wakeup has triggered, avoiding missing wakeups that occurred before binding listeners.
    if (wakeup.aborted) return;
    await new Promise<void>((resolve) => {
      // Listen to timer and abort simultaneously: end waiting early when new messages arrive, preventing idle workers from blocking for a full 5 seconds.
      const timer = setTimeout(finish, seconds * 1000);
      const onAbort = (): void => {
        clearTimeout(timer);
        finish();
      };
      function finish(): void {
        wakeup.removeEventListener("abort", onAbort);
        resolve();
      }
      wakeup.addEventListener("abort", onAbort, { once: true });
      if (wakeup.aborted) onAbort();
    });
  }
}

// WorkStealingRuntime encapsulates task claim/completion, polling parameters, and tool definitions, so bootstrap only composes capabilities without claim details.
export class WorkStealingRuntime {
  // The runtime claims and completes tasks only through shared TaskClaimService, preventing multiple teammates from competing directly for storage details.
  readonly #store: LeasedTaskStore;
  readonly #claimService: TaskClaimService;
  readonly #sleeper: WorkStealingSleeper;
  readonly #pollIntervalSeconds: number;
  readonly #maxIdlePolls: number;
  readonly #leadToolDefinitions: LeasedToolDefinitions;
  readonly #teammateToolDefinitions: TeammateLeasedToolDefinitions;

  constructor(options: {
    readonly store: LeasedTaskStore;
    readonly claimService?: TaskClaimService;
    readonly sleeper?: WorkStealingSleeper;
    readonly pollIntervalSeconds?: number;
    readonly maxIdlePolls?: number;
  }) {
    // Freeze store, service, polling policy, and tool snapshot at construction; hot-swapping claim semantics at runtime is disallowed.
    if (!isLeasedTaskStore(options.store))
      throw new TypeError("store must implement LeasedTaskStore");
    const claimService =
      options.claimService === undefined
        ? new DirectTaskClaimService(options.store)
        : options.claimService;
    // claimService must point to the same store; otherwise Lead and Teammate might operate on two databases.
    if (!isTaskClaimService(claimService))
      throw new TypeError("claimService must implement TaskClaimService");
    if (claimService.store !== options.store) {
      throw new Error("claimService must use the WorkStealingRuntime store");
    }
    const sleeper =
      options.sleeper === undefined ? new AsyncioWorkStealingSleeper() : options.sleeper;
    if (typeof sleeper.sleep !== "function") throw new TypeError("sleeper must implement sleep()");
    const pollIntervalSeconds =
      options.pollIntervalSeconds === undefined ? 5 : options.pollIntervalSeconds;
    const maxIdlePolls = options.maxIdlePolls === undefined ? 12 : options.maxIdlePolls;
    if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
      throw new RangeError("pollIntervalSeconds must be positive");
    }
    if (!Number.isInteger(maxIdlePolls) || maxIdlePolls <= 0) {
      throw new RangeError("maxIdlePolls must be a positive integer");
    }
    this.#store = options.store;
    this.#claimService = claimService;
    this.#sleeper = sleeper;
    this.#pollIntervalSeconds = pollIntervalSeconds;
    this.#maxIdlePolls = maxIdlePolls;
    // The same five tools are provided to Lead; Teammates start at index 1, exposing only read, claim, and complete.
    const definitions = leasedTaskToolDefinitions(this.#store, this.#claimService);
    this.#leadToolDefinitions = definitions;
    this.#teammateToolDefinitions = Object.freeze(definitions.slice(1));
  }

  get store(): LeasedTaskStore {
    // Expose the same instance for bootstrap to verify Lead, Subagent, and Teammate do not fork storage.
    return this.#store;
  }

  get claimService(): TaskClaimService {
    // Tool registration and automatic claims must reuse the same identity binding service.
    return this.#claimService;
  }

  get maxIdlePolls(): number {
    // TeammateRuntime uses this ceiling to decide when consecutive empty polls terminate the worker.
    return this.#maxIdlePolls;
  }

  get leadToolDefinitions(): LeasedToolDefinitions {
    // Lead can create, query, claim, and complete tasks.
    return this.#leadToolDefinitions;
  }

  get teammateToolDefinitions(): TeammateLeasedToolDefinitions {
    // Persistent teammates can only process existing tasks. They cannot expand the task graph in idle loops.
    return this.#teammateToolDefinitions;
  }

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    // Auto-claim owner comes from the worker identity, bypassing model tool input.
    return await this.#claimService.claimNext(owner);
  }

  async waitForPoll(wakeup: AbortSignal): Promise<void> {
    // A sleeper abstracts polling wait. Tests can use a deterministic implementation without real waiting.
    await this.#sleeper.sleep(this.#pollIntervalSeconds, wakeup);
  }

  renderClaimPrompt(claim: TaskClaim): string {
    // Pass token, lease, and task state to the model in deterministic JSON; the model must call complete_task explicitly.
    const payload = {
      claim_token: claim.claimToken,
      lease_expires_at_utc: claim.leaseExpiresAtUtc.toISOString(),
      task: taskPayload(claim.task),
    };
    return `<auto-claimed-task>\n${JSON.stringify(payload)}\n</auto-claimed-task>`;
  }
}

export function leasedTaskToolDefinitions(
  store: LeasedTaskStore,
  claimService: TaskClaimService = new DirectTaskClaimService(store),
): readonly [
  ToolDefinition<z.infer<typeof createTaskSchema>>,
  ToolDefinition<z.infer<typeof taskIdSchema>>,
  ToolDefinition<z.infer<typeof listTasksSchema>>,
  ToolDefinition<z.infer<typeof taskIdSchema>>,
  ToolDefinition<z.infer<typeof completeTaskSchema>>,
] {
  if (!isLeasedTaskStore(store)) throw new TypeError("store must implement LeasedTaskStore");
  if (!isTaskClaimService(claimService) || claimService.store !== store) {
    throw new Error("claimService must use the leased Task store");
  }
  // Array order defines the Lead/Teammate tool boundary: Teammates skip create_task during registration.
  const create: ToolDefinition<z.infer<typeof createTaskSchema>> = {
    name: "create_task",
    description: "Create a persistent SQLite project task with explicit dependencies.",
    inputSchema: createTaskSchema,
    effect: "write",
    handler: async (input) => {
      try {
        return toolSuccess(
          JSON.stringify(
            taskPayload(
              await store.createTask({
                subject: input.subject,
                description: input.description,
                blockedBy: input.blocked_by,
              }),
            ),
          ),
        );
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const get: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "get_task",
    description: "Read one persistent SQLite project task by ID.",
    inputSchema: taskIdSchema,
    effect: "read",
    handler: async (input) => {
      try {
        return toolSuccess(JSON.stringify(taskPayload(await store.getTask(input.task_id))));
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const list: ToolDefinition<z.infer<typeof listTasksSchema>> = {
    name: "list_tasks",
    description: "List the SQLite project task graph in stable creation order.",
    inputSchema: listTasksSchema,
    effect: "read",
    handler: async () => {
      try {
        const tasks = await store.listTasks();
        return toolSuccess(JSON.stringify({ tasks: tasks.map(taskPayload) }));
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const claim: ToolDefinition<z.infer<typeof taskIdSchema>> = {
    name: "claim_task",
    description: "Atomically claim a ready task and return its claim token and lease.",
    inputSchema: taskIdSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
        // claimService derives owner from ToolContext.identity; tool arguments have no owner field.
        return toolSuccess(
          JSON.stringify(claimPayload(await claimService.claimTask(input.task_id, context))),
        );
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  const complete: ToolDefinition<z.infer<typeof completeTaskSchema>> = {
    name: "complete_task",
    description: "Complete an owned task with its current claim token.",
    inputSchema: completeTaskSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
        // context.identity still injects owner; claim_token is the only permission proof the model must return.
        const result = await claimService.completeTask(input.task_id, input.claim_token, context);
        return toolSuccess(
          JSON.stringify({
            task: taskPayload(result.task),
            unblocked: result.unblocked.map(taskPayload),
          }),
        );
      } catch (error) {
        return leasedTaskError(error);
      }
    },
  };
  return [create, get, list, claim, complete];
}

export function registerLeasedTaskTools(
  registry: ToolRegistry,
  store: LeasedTaskStore,
  claimService?: TaskClaimService,
): void {
  // Lead and one-shot subagents can create, query, claim, and complete tasks across the entire DAG.
  const [create, get, list, claim, complete] = leasedTaskToolDefinitions(store, claimService);
  registry.register(create);
  registry.register(get);
  registry.register(list);
  registry.register(claim);
  registry.register(complete);
}

export function registerTeammateLeasedTaskTools(
  registry: ToolRegistry,
  store: LeasedTaskStore,
  claimService?: TaskClaimService,
): void {
  // Persistent teammates only process existing tasks and do not expose create_task, preventing idle loops from expanding the task graph without bound.
  const [, get, list, claim, complete] = leasedTaskToolDefinitions(store, claimService);
  registry.register(get);
  registry.register(list);
  registry.register(claim);
  registry.register(complete);
}

export function canonicalClaimToken(value: string): string {
  // token uses canonical UUIDs, rejecting case or format variations that create multiple textual identities.
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskClaimError("Claim token must be a canonical UUID");
  }
}

function isLeasedTaskStore(value: unknown): value is LeasedTaskStore {
  // The composition root only depends on a minimal structural contract, avoiding leaking concrete SQLite classes to the domain layer.
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "createTask") === "function" &&
    typeof Reflect.get(value, "getTask") === "function" &&
    typeof Reflect.get(value, "listTasks") === "function" &&
    typeof Reflect.get(value, "claimTask") === "function" &&
    typeof Reflect.get(value, "claimNext") === "function" &&
    typeof Reflect.get(value, "completeTask") === "function"
  );
}

function isTaskClaimService(value: unknown): value is TaskClaimService {
  // Validates store in addition to method shapes; subsequent constructor continues to require completely identical instance references.
  return (
    typeof value === "object" &&
    value !== null &&
    isLeasedTaskStore(Reflect.get(value, "store")) &&
    typeof Reflect.get(value, "claimTask") === "function" &&
    typeof Reflect.get(value, "claimNext") === "function" &&
    typeof Reflect.get(value, "completeTask") === "function"
  );
}

function taskPayload(task: Task): Readonly<Record<string, unknown>> {
  // In-memory Task uses blockedBy; tool results map uniformly to wire format blocked_by.
  return {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
}

function claimPayload(claim: TaskClaim): Readonly<Record<string, unknown>> {
  // TaskClaim internal fields are camelCase; serialization for the model uniformly uses claim_token and lease_expires_at_utc.
  return {
    claim_token: claim.claimToken,
    lease_expires_at_utc: claim.leaseExpiresAtUtc.toISOString(),
    task: taskPayload(claim.task),
  };
}

function leasedTaskError(error: unknown): ToolResult {
  if (error instanceof TaskError) return toolError(error.code, error.message);
  throw error;
}
