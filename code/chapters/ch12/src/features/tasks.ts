// Chapter 12 task DAG domain model and tool registration: Task constructor, TaskStore interface, and five task tools share the same validation boundary.
import { z } from "zod";

import type { ToolDefinition, ToolRegistry } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const TaskStatus = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const);

// The state set is the single source of truth for task transitions; states other than pending, in_progress, and completed do not enter the model.
// "blocked" does not persist separately; the dependency graph derives it at claim time to avoid rewriting downstream files when upstream tasks finish.
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export interface TaskOptions {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly owner: string | null;
  readonly blockedBy: readonly string[];
}

export class Task {
  // Task constructor centrally maintains domain invariants for status, owner, and dependencies; storage layers must not bypass it.
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly owner: string | null;
  readonly blockedBy: readonly string[];

  constructor(options: TaskOptions) {
    this.id = canonicalTaskId(options.id);
    this.subject = normalizeSubject(options.subject);
    this.description = normalizeDescription(options.description);
    if (!isTaskStatus(options.status)) {
      throw new TaskStorageError("task status is invalid");
    }
    this.status = options.status;
    this.owner = normalizeOptionalOwner(options.owner);
    this.blockedBy = normalizeDependencies(options.blockedBy);
    if (this.status === TaskStatus.PENDING && this.owner !== null) {
      throw new TaskStorageError("pending task must not have an owner");
    }
    if (this.status !== TaskStatus.PENDING && this.owner === null) {
      throw new TaskStorageError("in-progress or completed task requires an owner");
    }
    Object.freeze(this.blockedBy);
    Object.freeze(this);
  }
}

export interface TaskCompletion {
  readonly task: Task;
  readonly unblocked: readonly Task[];
}

// Domain errors uniformly carry stable code; tool layer returns distinguishable error codes accordingly instead of collapsing all into generic failures.
export class TaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskError";
    this.code = code;
  }
}

export class TaskNotFoundError extends TaskError {
  constructor(message: string) {
    super("task_not_found", message);
    this.name = "TaskNotFoundError";
  }
}

export class TaskGraphError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_graph_error", message, options);
    this.name = "TaskGraphError";
  }
}

export class TaskStateError extends TaskError {
  constructor(message: string, code = "task_invalid_state") {
    super(code, message);
    this.name = "TaskStateError";
  }
}

export class TaskBlockedError extends TaskStateError {
  readonly taskId: string;
  readonly blockedBy: readonly string[];

  constructor(taskId: string, blockedBy: readonly string[]) {
    super(`Task ${taskId} is blocked by: ${blockedBy.join(", ")}`, "task_blocked");
    this.name = "TaskBlockedError";
    this.taskId = taskId;
    this.blockedBy = Object.freeze([...blockedBy]);
  }
}

export class TaskOwnershipError extends TaskError {
  constructor(message: string) {
    super("task_owner_mismatch", message);
    this.name = "TaskOwnershipError";
  }
}

export class TaskStorageError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_storage_error", message, options);
    this.name = "TaskStorageError";
  }
}

export interface CreateTaskInput {
  readonly subject: string;
  readonly description?: string;
  readonly blockedBy?: readonly string[];
}

// TaskStore is the narrow interface all persistent implementations must satisfy; tool layer does not depend on concrete JSON or SQLite implementations.
export interface TaskStore {
  // Task graph operations return complete Task; callers cannot bypass state transition checks via partial patches.
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  listTasks(): Promise<readonly Task[]>;
  claimTask(taskId: string, owner: string): Promise<Task>;
  completeTask(taskId: string, owner: string): Promise<TaskCompletion>;
}

// All tool schemas use .strict(); extra fields (such as forged owners) are rejected before any side effects.
const taskIdSchema = z.string().regex(CANONICAL_UUID, "task_id must be a canonical UUID");
const createTaskSchema = z
  .object({
    subject: z.string().trim().min(1),
    description: z.string().trim().default(""),
    blocked_by: z.array(taskIdSchema).default([]),
  })
  .strict();
const taskIdInputSchema = z.object({ task_id: taskIdSchema }).strict();
const listTasksInputSchema = z.object({}).strict();

// Tool parameters follow on-disk naming blocked_by, avoiding another mapping layer between model-visible fields and storage formats.
export function registerTaskTools(registry: ToolRegistry, store: TaskStore): void {
  // Five tools are registered centrally here; schema and handler both come from the same ToolDefinition.
  registry.register(createTaskDefinition(store));
  registry.register(
    taskIdDefinition(
      "get_task",
      "Read one persistent project task by canonical UUID. Read-only; it does not change status or owner.",
      "read",
      store,
    ),
  );
  registry.register({
    name: "list_tasks",
    description:
      "List the complete persistent project task graph sorted by ID. Use it before create_task to find canonical UUIDs or before claim_task to find ready tasks.",
    inputSchema: listTasksInputSchema,
    effect: "read",
    handler: async (_input, _context) => {
      try {
        // Returns a full graph snapshot instead of local tasks so callers can plan based on dependencies and ready states.
        const tasks = await store.listTasks();
        return toolSuccess(encodePayload({ tasks: tasks.map(taskPayload) }));
      } catch (error) {
        return taskToolError(error);
      }
    },
  });
  registry.register(
    taskIdDefinition(
      "claim_task",
      "Atomically claim a ready pending task as the current identity. Owner is set by the runtime identity; do not pass an owner argument.",
      "write",
      store,
    ),
  );
  registry.register({
    name: "complete_task",
    description:
      "Complete a claimed task owned by the current identity. Returns the completed task and any pending tasks directly unblocked by this completion.",
    inputSchema: taskIdInputSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
        // Completers can only come from trusted ToolContext.identity; the model cannot choose on whose behalf to complete tasks.
        const completion = await store.completeTask(
          input.task_id,
          normalizeOwner(context.identity),
        );
        return toolSuccess(
          encodePayload({
            task: taskPayload(completion.task),
            unblocked: completion.unblocked.map(taskPayload),
          }),
        );
      } catch (error) {
        return taskToolError(error);
      }
    },
  });
}

function createTaskDefinition(store: TaskStore): ToolDefinition<z.infer<typeof createTaskSchema>> {
  return {
    name: "create_task",
    description:
      "Create a persistent project task after planning. blocked_by must contain canonical task UUIDs returned by list_tasks or get_task.",
    inputSchema: createTaskSchema,
    effect: "write",
    handler: async (input) => {
      try {
        // handler only forwards input to TaskStore; the persistence boundary handles full graph validation and atomic writes.
        const task = await store.createTask({
          subject: input.subject,
          description: input.description,
          blockedBy: input.blocked_by,
        });
        return toolSuccess(encodePayload(taskPayload(task)));
      } catch (error) {
        return taskToolError(error);
      }
    },
  };
}

function taskIdDefinition(
  name: "get_task" | "claim_task",
  description: string,
  effect: "read" | "write",
  store: TaskStore,
): ToolDefinition<z.infer<typeof taskIdInputSchema>> {
  // get/claim share the task_id schema; claim owner comes only from ToolContext.identity and rejects model arguments.
  return {
    name,
    description,
    inputSchema: taskIdInputSchema,
    effect,
    handler: async (input, context) => {
      try {
        const task =
          name === "get_task"
            ? await store.getTask(input.task_id)
            : await store.claimTask(input.task_id, normalizeOwner(context.identity));
        return toolSuccess(encodePayload(taskPayload(task)));
      } catch (error) {
        return taskToolError(error);
      }
    },
  };
}

function taskToolError(error: unknown) {
  // Known domain errors retain stable error codes; throw unknown exceptions upward to avoid swallowing bugs.
  if (error instanceof TaskError) {
    return toolError(error.code, error.message);
  }
  throw error;
}

export function canonicalTaskId(value: string): string {
  // Normalize all IDs to canonical UUIDs first; external path strings cannot enter the filesystem.
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new TaskGraphError("task id must be a canonical UUID");
  }
  return value;
}

export function normalizeOwner(value: string): string {
  if (typeof value !== "string") {
    throw new TaskOwnershipError("task owner must be a string");
  }
  // Trims before checking emptiness to prevent strings with leading/trailing spaces from counting as different owners.
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskOwnershipError("task owner must not be empty");
  }
  return normalized;
}

function normalizeOptionalOwner(value: string | null): string | null {
  return value === null ? null : normalizeOwner(value);
}

function normalizeSubject(value: string): string {
  if (typeof value !== "string") {
    throw new TaskStorageError("task subject must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskStorageError("task subject must not be empty");
  }
  return normalized;
}

function normalizeDescription(value: string): string {
  if (typeof value !== "string") {
    throw new TaskStorageError("task description must be a string");
  }
  return value.trim();
}

function normalizeDependencies(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new TaskStorageError("task dependencies must be an array");
  }
  // Dependencies normalize to canonical UUIDs before checking duplicate references; duplicate dependencies fail explicitly before writing.
  const normalized = values.map(canonicalTaskId);
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("task dependencies must be unique");
  }
  return normalized;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  // Unknown strings cannot enter domain objects; treat any value outside the three states as a storage error.
  return (
    value === TaskStatus.PENDING ||
    value === TaskStatus.IN_PROGRESS ||
    value === TaskStatus.COMPLETED
  );
}

function taskPayload(task: Task): Readonly<Record<string, unknown>> {
  // Fields returned to the model use the disk name blocked_by to avoid inconsistency between wire format and storage format.
  return {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
}

function encodePayload(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}
