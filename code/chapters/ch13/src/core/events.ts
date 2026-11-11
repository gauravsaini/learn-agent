// Runtime event protocol: External asynchronous results must implement RuntimeEvent before entering EventInbox;
// Agent Loop batches ready events, deduplicates them, and injects them into history as normal user messages.
import { userMessage } from "./messages.js";
import type { UserMessage } from "./messages.js";

export interface RuntimeEvent {
  // Event carries stable ID and optional idempotency key for Loop to deduplicate and safely inject external results into the next turn.
  readonly eventId: string;
  readonly contextIdentity?: string;
  readonly idempotencyKey?: string;
  // Serialize events into pure JSON data visible to the model; implementors are responsible for stable field names.
  toPayload(): Readonly<Record<string, unknown>>;
}

export interface RuntimeEventBatchPosition {
  // Record event positions within the message batch during batch injection to help models identify which result among multiple this is.
  readonly index: number;
  readonly total: number;
}

// Validate whether external objects satisfy the RuntimeEvent contract; do not trust runtime duck-typed inputs.
export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const eventId = Reflect.get(value, "eventId");
  const toPayload = Reflect.get(value, "toPayload");
  const contextIdentity = Reflect.get(value, "contextIdentity");
  const idempotencyKey = Reflect.get(value, "idempotencyKey");
  return (
    typeof eventId === "string" &&
    eventId.trim().length > 0 &&
    typeof toPayload === "function" &&
    (contextIdentity === undefined ||
      (typeof contextIdentity === "string" && contextIdentity.trim().length > 0)) &&
    (idempotencyKey === undefined ||
      (typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0))
  );
}

export class EventInbox {
  // Inbox is a one-way queue from runtime to Agent Loop; drain preserves FIFO and transfers ownership of the entire event batch at once.
  readonly #events: RuntimeEvent[] = [];
  readonly #waiters: Array<() => void> = [];

  // Publish an event and wake waiters; accept only objects validated by RuntimeEvent.
  publish(event: RuntimeEvent): void {
    if (!isRuntimeEvent(event)) {
      throw new TypeError("EventInbox only accepts RuntimeEvent values");
    }
    this.#events.push(event);
    for (const resolve of this.#waiters.splice(0)) {
      resolve();
    }
  }

  // Drain currently ready events; limit defaults to the complete FIFO batch.
  drain(limit?: number): readonly RuntimeEvent[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("limit must be a positive integer or undefined");
    }
    const count = limit === undefined ? this.#events.length : Math.min(limit, this.#events.length);
    return Object.freeze(this.#events.splice(0, count));
  }

  // Blocks waiting for non-empty queue then drains a batch of events; called by Agent Loop when waiting for background results.
  async wait(limit?: number): Promise<readonly RuntimeEvent[]> {
    while (this.#events.length === 0) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.drain(limit);
  }
}

// Events enter history as normal user messages without disguising as tool results or carrying tool_call_id.
// batch is used only when one drain injects multiple events; process as a single event when not passed.
export function runtimeEventMessage(
  event: RuntimeEvent,
  batch?: RuntimeEventBatchPosition,
): UserMessage {
  if (!isRuntimeEvent(event)) {
    throw new TypeError("event must be a RuntimeEvent");
  }
  const position = batch === undefined ? { index: 0, total: 1 } : batch;
  if (
    !Number.isInteger(position.index) ||
    position.index < 0 ||
    !Number.isInteger(position.total) ||
    position.total <= 0 ||
    position.index >= position.total
  ) {
    throw new TypeError("batch position must satisfy 0 <= index < total");
  }
  return userMessage(
    JSON.stringify(
      { runtime_event: event.toPayload(), batch: position },
      (_key, value: unknown) => value,
    ),
  );
}
