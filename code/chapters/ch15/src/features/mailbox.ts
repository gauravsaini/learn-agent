// Mailbox domain model: defines persistent messages, state directories, and Store protocols shared by teammate runtime and file adapters.
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RuntimeEvent } from "../core/events.js";
import { isWindowsReservedComponent } from "../core/filesystem.js";

export const MailboxMessageKind = Object.freeze({
  // The message type determines how consumers interpret content, but cannot change the mailbox persistence protocol.
  Task: "task",
  Message: "message",
  Result: "result",
});
export type MailboxMessageKind = (typeof MailboxMessageKind)[keyof typeof MailboxMessageKind];

export const MailboxState = Object.freeze({
  // Each directory name corresponds to a persistent state; a message is allowed only in ready, processing, done, or quarantine.
  Ready: "ready",
  Processing: "processing",
  Done: "done",
  Quarantine: "quarantine",
});
export type MailboxState = (typeof MailboxState)[keyof typeof MailboxState];

export class MailboxError extends Error {
  // Protocol or persistence errors carry a stable errorCode so the tool boundary can convert them to structured ToolResult.
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailboxError";
    this.errorCode = errorCode;
  }
}

export class MailboxStorageError extends MailboxError {
  // Map file corruption, lock failures, and state transition conflicts to the same error family. Callers do not need to guess underlying exceptions.
  constructor(message: string, options?: ErrorOptions) {
    super("mailbox_storage_error", message, options);
    this.name = "MailboxStorageError";
  }
}

export interface MailboxMessage extends RuntimeEvent {
  // Mailbox messages are modeled with stable ID, sender, and recipient; the persistence layer guarantees delivery and acknowledgment are traceable.
  readonly id: string;
  // Sender and recipient are canonical Agent slugs safe to use as directory names.
  readonly sender: string;
  readonly recipient: string;
  // task/message/result affects consumer semantics only without altering the delivery state machine.
  readonly kind: MailboxMessageKind;
  // Raw text payload passed to the target Agent.
  readonly content: string;
  // UTC time that determines stable FIFO order within the same inbox.
  readonly createdAtUtc: Date;
  // Deduplication id of RuntimeEvent matches message primary key.
  readonly eventId: string;
  // Tool side-effect idempotent keys match message UUIDs; retries do not generate new identities.
  readonly idempotencyKey: string;
}

export interface MailboxStore {
  // Store exposes protocol operations for send, claim, and ack; concrete file persistence remains in adapters.
  send(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): Promise<MailboxMessage>;
  // Atomically claim the earliest ready message and move it to processing; return undefined when the mailbox is empty.
  claim(recipient: string): Promise<MailboxMessage | undefined>;
  // processing -> done; identical completion records allow idempotent confirmation.
  ack(message: MailboxMessage): Promise<boolean>;
  // processing -> ready, used for cancellation, shutdown, or retriable failures.
  release(message: MailboxMessage): Promise<boolean>;
  // processing -> quarantine, used for non-retriable business failures.
  quarantine(message: MailboxMessage): Promise<boolean>;
  // Process recovery rolls back leftover processing leases to ready, and returns the recovered count.
  recoverProcessing(recipient: string): Promise<number>;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const spawnTeammateInputSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    prompt: z.string(),
  })
  .strict();
// Strict tool input for spawn_teammate; does not allow the model to specify sender or runtime identity.
export type SpawnTeammateInput = z.infer<typeof spawnTeammateInputSchema>;

export const sendMessageInputSchema = z
  .object({
    to: z.string(),
    content: z.string(),
  })
  .strict();
// Strict tool input for send_message; sender always comes from ToolContext.identity.
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export function canonicalAgentName(value: string): string {
  // The Agent name is used as a directory name, so it validates both slug rules and Windows reserved components.
  if (typeof value !== "string" || !AGENT_NAME.test(value) || isWindowsReservedComponent(value)) {
    throw new Error("Invalid or unsafe Agent name; expected a safe lowercase slug");
  }
  return value;
}

export function canonicalMailboxMessageId(value: string): string {
  // The UUID is both the message primary key and the event idempotency key: it must use canonical format.
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new Error("Mailbox message id must be a canonical UUID");
  }
  return value;
}

export function createMailboxMessage(input: {
  id: string;
  sender: string;
  recipient: string;
  kind: MailboxMessageKind;
  content: string;
  createdAtUtc: Date;
}): MailboxMessage {
  // Validate id, sender, recipient, kind, content, and clock at the construction boundary, returning immutable messages.
  const id = canonicalMailboxMessageId(input.id);
  const sender = canonicalAgentName(input.sender);
  const recipient = canonicalAgentName(input.recipient);
  if (!Object.values(MailboxMessageKind).includes(input.kind)) {
    throw new TypeError("Mailbox message kind must be task, message, or result");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new Error("Mailbox message content must not be empty");
  }
  if (!(input.createdAtUtc instanceof Date) || !Number.isFinite(input.createdAtUtc.valueOf())) {
    throw new Error("Mailbox clock value must be a valid UTC Date");
  }
  const createdAtUtc = new Date(input.createdAtUtc.valueOf());
  return Object.freeze({
    id,
    sender,
    recipient,
    kind: input.kind,
    content: input.content,
    createdAtUtc,
    eventId: id,
    idempotencyKey: id,
    toPayload: mailboxPayload,
  });
}

export function mailboxMessageFromJson(value: unknown): MailboxMessage {
  // On-disk JSON is external input and must reject unknown fields and invalid values to prevent bad messages from corrupting runtime state.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  const record = value as Record<string, unknown>;
  const expected = ["content", "created_at_utc", "id", "kind", "recipient", "sender"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new MailboxStorageError("Mailbox message payload contains unsupported fields");
  }
  if (
    typeof record.id !== "string" ||
    typeof record.sender !== "string" ||
    typeof record.recipient !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.content !== "string" ||
    typeof record.created_at_utc !== "string"
  ) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  if (!Object.values(MailboxMessageKind).includes(record.kind as MailboxMessageKind)) {
    throw new MailboxStorageError("Mailbox message kind is invalid");
  }
  const createdAtUtc = new Date(record.created_at_utc);
  if (
    !record.created_at_utc.endsWith("Z") ||
    !Number.isFinite(createdAtUtc.valueOf()) ||
    createdAtUtc.toISOString() !== record.created_at_utc
  ) {
    throw new MailboxStorageError("Mailbox message timestamp is invalid");
  }
  try {
    return createMailboxMessage({
      id: record.id,
      sender: record.sender,
      recipient: record.recipient,
      kind: record.kind as MailboxMessageKind,
      content: record.content,
      createdAtUtc,
    });
  } catch (error) {
    throw new MailboxStorageError("Mailbox message fields failed validation", { cause: error });
  }
}

export function mailboxMessageToJson(message: MailboxMessage): Readonly<Record<string, string>> {
  // Persistence uses stable snake_case field names while in-memory objects keep camelCase; conversions occur at boundaries only.
  return Object.freeze({
    id: message.id,
    sender: message.sender,
    recipient: message.recipient,
    kind: message.kind,
    content: message.content,
    created_at_utc: message.createdAtUtc.toISOString(),
  });
}

export function equalMailboxMessages(left: MailboxMessage, right: MailboxMessage): boolean {
  // Idempotent ack requires comparing full message content rather than just ids; otherwise it might confirm the wrong payload.
  return (
    left.id === right.id &&
    left.sender === right.sender &&
    left.recipient === right.recipient &&
    left.kind === right.kind &&
    left.content === right.content &&
    left.createdAtUtc.valueOf() === right.createdAtUtc.valueOf()
  );
}

export function randomMailboxMessageId(): string {
  // Default ID generator is used only during production construction; tests can inject deterministic UUIDs.
  return randomUUID();
}

function mailboxPayload(this: MailboxMessage): Readonly<Record<string, unknown>> {
  // RuntimeEvent payload exposes structured fields to prevent callers from determining message types by string prefixes.
  return Object.freeze({
    kind: "mailbox",
    message_id: this.id,
    sender: this.sender,
    recipient: this.recipient,
    message_kind: this.kind,
    content: this.content,
    created_at_utc: this.createdAtUtc.toISOString(),
  });
}
