// TODO session plan: manages model-visible task lists with full snapshot tool todo_write, injecting reminders into next model request when plans are stale.
import { z } from "zod";

import type { ChatMessage } from "../core/messages.js";
import { systemMessage } from "../core/messages.js";
import type { ToolDefinition, ToolResult } from "../core/tools.js";
import { toolSuccess } from "../core/tools.js";

// Upper limit on plan snapshot item count to prevent models from inserting oversized arrays at once.
// Session-level TODO capability: uses complete plan snapshots to combat task amnesia in long context.
// Boundary: State exists only in a single AgentRunner lifecycle; no cross-session or disk persistence is performed;
// Reminders only inject into the next model request and do not write to formal message history.
export const MAX_TODOS = 50;
// Count of consecutive turns of other tools without plan updates; reminds before the next model request once reached.
export const STALE_TOOL_ROUNDS = 3;
// Injected reminders maintain fixed wording so tests and model contexts observe the same contract.
export const TODO_STALE_REMINDER =
  "Keep the TODO list current. Call todo_write with the complete task snapshot when the plan changes.";
// Three valid states serve as the sole source of values for the tool schema.
export const TODO_STATUSES = Object.freeze(["pending", "in_progress", "completed"] as const);
// TODO tool accepts only complete snapshots to prevent incremental patches from drifting model state from actual plan state.
export type TodoStatus = (typeof TODO_STATUSES)[number];

// Trim and validate each item, rejecting unknown fields to keep dirty data out of the session plan.
const todoItemSchema = z
  .object({
    content: z
      .string()
      .transform((content) => content.trim())
      .pipe(z.string().min(1, "todo content must not be empty")),
    status: z.enum(TODO_STATUSES),
  })
  .strict();

// Tool parameters are always complete snapshots without incremental patches, keeping model-seen plans consistent with internal state.
const todoWriteSchema = z
  .object({
    todos: z.array(todoItemSchema).max(MAX_TODOS),
  })
  .strict();

// Validated and frozen plan items; trackers store only this internal safe form.
export type TodoItem = Readonly<z.output<typeof todoItemSchema>>;
// Internal input arguments for tool handlers; enters write paths only after successful schema validation.
type TodoWriteInput = z.output<typeof todoWriteSchema>;

// TodoTracker is session-level state: build a new instance for each Agent to avoid sharing plans across sessions.
export class TodoTracker {
  // Observe tool calls in each turn; inject reminders before the next model request when plans are unupdated for long periods.
  // Current full plan snapshot; replace rather than modify in-place to map tool output one-to-one with memory state.
  #todos: readonly TodoItem[] = Object.freeze([]);
  // Non-TODO tool turns since last plan write; does not count model replies without tool calls.
  #nonTodoToolRounds = 0;
  // The sole write entry point exposed to ToolRegistry; handler closures guarantee no writes to other tracker instances.
  readonly toolDefinition: ToolDefinition<TodoWriteInput>;

  // Each AgentRunner constructs an independent tracker to prevent different users or workspaces from sharing task plans.
  constructor() {
    // toolDefinition binds to the current tracker, sharing the same session state between tools and observers.
    this.toolDefinition = Object.freeze({
      name: "todo_write",
      description: "Replace the current TODO list with a complete task snapshot.",
      inputSchema: todoWriteSchema,
      effect: "write",
      handler: (input: TodoWriteInput) => this.#writeTodos(input),
    });
  }

  get todos(): readonly TodoItem[] {
    // Expose the current snapshot as read-only for testing and higher-level inspection, without external mutation access.
    return this.#todos;
  }

  recordToolRound(toolNames: readonly string[]): void {
    // A todo_write in a turn counts as a new snapshot and resets the staleness counter.
    if (toolNames.length === 0) {
      return;
    }
    if (toolNames.includes(this.toolDefinition.name)) {
      this.#nonTodoToolRounds = 0;
      return;
    }
    this.#nonTodoToolRounds += 1;
  }

  // When reaching the staleness threshold, generate temporary system messages only for the next request; do not pollute replayable history.
  beforeModel(): readonly ChatMessage[] {
    if (this.#nonTodoToolRounds < STALE_TOOL_ROUNDS) {
      return [];
    }
    // Reminders are request-level context. Clearing them immediately avoids repeated injection in subsequent turns.
    this.#nonTodoToolRounds = 0;
    return Object.freeze([systemMessage(TODO_STALE_REMINDER)]);
  }

  // Atomically replace all plans and reset counters on success; rejects partial updates and stale items.
  #writeTodos(input: TodoWriteInput): ToolResult {
    // Validates completely with Zod first, then replaces snapshot in one step; failure paths do not touch old state.
    this.#todos = Object.freeze(
      input.todos.map((item) => Object.freeze({ content: item.content, status: item.status })),
    );
    this.#nonTodoToolRounds = 0;
    return toolSuccess(serializeSnapshot(this.#todos));
  }
}

// Serialize snapshots as ASCII JSON to ensure tool results embed safely into model contexts without relying on terminal encodings.
function serializeSnapshot(todos: readonly TodoItem[]): string {
  // Uses deterministic JSON as model-visible state for convenient complete replacement in the next turn.
  const json = JSON.stringify({
    todos: todos.map((item) => ({ content: item.content, status: item.status })),
  });
  const ascii: string[] = [];

  // Splits non-BMP characters into UTF-16 surrogate pairs, keeping JSON Unicode escapes valid.
  for (const character of json) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("todo snapshot contained an invalid Unicode value");
    }

    if (codePoint <= 0x7f) {
      ascii.push(character);
      continue;
    }

    if (codePoint <= 0xffff) {
      ascii.push(`\\u${codePoint.toString(16).padStart(4, "0")}`);
      continue;
    }

    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    ascii.push(`\\u${high.toString(16)}\\u${low.toString(16)}`);
  }

  return ascii.join("");
}
