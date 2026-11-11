// Chapter 12 task DAG domain model and tool registration: Task constructor, TaskStore interface, and five task tools share the same validation boundary.
import { z } from "zod";

import type { ToolDefinition, ToolRegistry } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// The three task states are the sole source of transitions; blocked does not persist, but derives from the dependency graph during claim.
export const TaskStatus = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const);

// The state set is the single source of truth for task transitions; states other than pending, in_progress, and completed do not enter the model.
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export interface TaskOptions {
  // Canonical UUID, uniquely identifying a task.
  readonly id: string;
  // Task title, used for model planning and list display.
  readonly subject: string;
  // Detailed task description, can be an empty string.
  readonly description: string;
  // Current status; pending has no owner, other states must have an owner.
  readonly status: TaskStatus;
  // Claimer identity; pending must be null.
  readonly owner: string | null;
  // Canonical UUID of dependent task; task cannot be claimed when dependency is incomplete.
  readonly blockedBy: readonly string[];
}

export class Task {
  // Task constructor centrally maintains domain invariants for status, owner, and dependencies; storage layers must not bypass it.
  // Canonical UUID, acting as both storage file name and reference key.
  readonly id: string;
  // Normalized task title.
  readonly subject: string;
  // Normalized task description.
  readonly description: string;
  // Current task status.
  readonly status: TaskStatus;
  // Current owner; pending must be null.
  readonly owner: string | null;
  // Upstream dependency ID list, immutable once frozen.
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
  // Tasks completed this time.
  readonly task: Task;
  // Pending tasks transitioning from blocked to ready due to this completion.
  readonly unblocked: readonly Task[];
}

// Base class for task domain errors; code is used by tool layer to return stable error codes.
export class TaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskError";
    this.code = code;
  }
}

// Task does not exist.
export class TaskNotFoundError extends TaskError {
  constructor(message: string) {
    super("task_not_found", message);
    this.name = "TaskNotFoundError";
  }
}

// Dependency graph does not satisfy acyclic or reference constraints.
export class TaskGraphError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_graph_error", message, options);
    this.name = "TaskGraphError";
  }
}

// Task state does not allow the current transition.
export class TaskStateError extends TaskError {
  constructor(message: string, code = "task_invalid_state") {
    super(code, message);
    this.name = "TaskStateError";
  }
}

// Task is still blocked by unfinished tasks; claim is denied.
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

// owner does not match the current claimant.
export class TaskOwnershipError extends TaskError {
  constructor(message: string) {
    super("task_owner_mismatch", message);
    this.name = "TaskOwnershipError";
  }
}

// Task store read/write or schema validation failed.
export class TaskStorageError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_storage_error", message, options);
    this.name = "TaskStorageError";
  }
}

export interface CreateTaskInput {
  // Required task title.
  readonly subject: string;
  // Optional description; the store normalizes to an empty string when omitted.
  readonly description?: string;
  // Optional upstream dependencies; defaults to empty.
  readonly blockedBy?: readonly string[];
}

// TaskStore is the narrow interface all persistent implementations must satisfy; tool layer does not depend on concrete JSON or SQLite implementations.
export interface TaskStore {
  // Task graph operations return complete Task; callers cannot bypass state transition checks via partial patches.
  // Create tasks inside the lock and validate unique id, dependency existence, and acyclicity of the full graph.
  createTask(input: CreateTaskInput): Promise<Task>;
  // Read a single task by canonical UUID.
  getTask(taskId: string): Promise<Task>;
  // Returns a full task graph snapshot sorted by ID.
  listTasks(): Promise<readonly Task[]>;
  // Atomically transitions only ready pending tasks to in_progress for the specified owner.
  claimTask(taskId: string, owner: string): Promise<Task>;
  // Completes in_progress tasks only by current owner, and returns pending tasks unblocked directly.
  completeTask(taskId: string, owner: string): Promise<TaskCompletion>;
}

// All tool schemas use .strict(); extra fields are rejected before any side effects.
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
    // get_task is a read-only query; it does not change state or owner.
    taskIdDefinition(
      "get_task",
      "Read one persistent project task by canonical UUID. Read-only; it does not change status or owner.",
      "read",
      store,
    ),
  );
  registry.register({
    name: "list_tasks",
    // Returns a full graph snapshot so callers can plan based on dependencies and ready states.
    description:
      "List the complete persistent project task graph sorted by ID. Use it before create_task to find canonical UUIDs or before claim_task to find ready tasks.",
    inputSchema: listTasksInputSchema,
    effect: "read",
    handler: async (_input, _context) => {
      try {
        // Returns the full graph instead of local tasks to prevent the model from seeing only partial dependencies.
        const tasks = await store.listTasks();
        return toolSuccess(encodePayload({ tasks: tasks.map(taskPayload) }));
      } catch (error) {
        return taskToolError(error);
      }
    },
  });
  registry.register(
    // The claim owner comes only from ToolContext.identity; the model cannot choose on whose behalf to complete the task.
    taskIdDefinition(
      "claim_task",
      "Atomically claim a ready pending task as the current identity. Owner is set by the runtime identity; do not pass an owner argument.",
      "write",
      store,
    ),
  );
  registry.register({
    name: "complete_task",
    // Completer can only come from trusted ToolContext.identity.
    description:
      "Complete a claimed task owned by the current identity. Returns the completed task and any pending tasks directly unblocked by this completion.",
    inputSchema: taskIdInputSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
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
    // blocked_by must reference a canonical UUID returned by list_tasks/get_task.
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
  // get/claim share the task_id schema; only store invocations and effects differ.
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
  const normalized = values.map(canonicalTaskId);
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("task dependencies must be unique");
  }
  return normalized;
}

function isTaskStatus(value: unknown): value is TaskStatus {
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
