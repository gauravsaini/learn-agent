// Runtime event protocol: External asynchronous results such as background tasks enter EventInbox as typed RuntimeEvent, and Agent Loop deduplicates before injecting into history.
import { userMessage } from "./messages.js";
import type { UserMessage } from "./messages.js";

export interface RuntimeEvent {
  // Event carries stable ID and optional idempotency key for Loop to deduplicate and safely inject external results into the next turn.
  readonly eventId: string;
  readonly contextIdentity?: string;
  readonly idempotencyKey?: string;
  // Convert events into pure JSON payloads visible to the model, without exposing mutable runtime objects.
  toPayload(): Readonly<Record<string, unknown>>;
}

// Validates minimal contract of events from shared runtime boundary.
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
  // Inbox is a one-way queue from runtime to Agent Loop; drain preserves FIFO and transfers ownership at once.
  readonly #events: RuntimeEvent[] = [];
  readonly #waiters: Array<() => void> = [];

  // Publish events and wake all waiters; transfer event ownership to the Inbox afterward.
  publish(event: RuntimeEvent): void {
    if (!isRuntimeEvent(event)) {
      throw new TypeError("EventInbox only accepts RuntimeEvent values");
    }
    this.#events.push(event);
    for (const resolve of this.#waiters.splice(0)) {
      resolve();
    }
  }

  // Fetch events in non-blocking FIFO order. limit defaults to the current complete batch.
  drain(limit?: number): readonly RuntimeEvent[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("limit must be a positive integer or undefined");
    }
    const count = limit === undefined ? this.#events.length : Math.min(limit, this.#events.length);
    return Object.freeze(this.#events.splice(0, count));
  }

  // Blocks when queue is empty, and transfers ownership following the same drain rule once events appear.
  async wait(limit?: number): Promise<readonly RuntimeEvent[]> {
    while (this.#events.length === 0) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.drain(limit);
  }
}

// Wrap external events as normal user messages; it does not forge tool_call_id.
export function runtimeEventMessage(event: RuntimeEvent): UserMessage {
  // Events enter history as normal user messages without disguising as tool results or carrying tool_call_id.
  if (!isRuntimeEvent(event)) {
    throw new TypeError("event must be a RuntimeEvent");
  }
  return userMessage(
    JSON.stringify({ runtime_event: event.toPayload() }, (_key, value: unknown) => value),
  );
}
