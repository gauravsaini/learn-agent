// Mailbox domain model: defines persistent messages, state directories, and Store protocols shared by teammate runtime and file adapters; P16 extends structured protocol messages.
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RuntimeEvent } from "../core/events.js";
import { isWindowsReservedComponent } from "../core/filesystem.js";

// The message type determines how consumers interpret content, but cannot change the mailbox persistence protocol.
export const MailboxMessageKind = Object.freeze({
  Task: "task",
  Message: "message",
  Result: "result",
});
export type MailboxMessageKind = (typeof MailboxMessageKind)[keyof typeof MailboxMessageKind];

// Protocol messages add typed extensions to ordinary mailboxes; the kind of request and response determines the value of approved.
export const ProtocolMessageKind = Object.freeze({
  ShutdownRequest: "shutdown_request",
  ShutdownResponse: "shutdown_response",
  PlanApprovalRequest: "plan_approval_request",
  PlanApprovalResponse: "plan_approval_response",
});
export type ProtocolMessageKind = (typeof ProtocolMessageKind)[keyof typeof ProtocolMessageKind];

// Each directory name corresponds to a persistent state; a message is allowed only in ready, processing, done, or quarantine.
export const MailboxState = Object.freeze({
  Ready: "ready",
  Processing: "processing",
  Done: "done",
  Quarantine: "quarantine",
});
export type MailboxState = (typeof MailboxState)[keyof typeof MailboxState];

// Protocol or persistence errors carry a stable errorCode so the tool boundary can convert them to structured ToolResult.
export class MailboxError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailboxError";
    this.errorCode = errorCode;
  }
}

// Map file corruption, lock failures, and state transition conflicts to the same error family. Callers do not need to guess underlying exceptions.
export class MailboxStorageError extends MailboxError {
  constructor(message: string, options?: ErrorOptions) {
    super("mailbox_storage_error", message, options);
    this.name = "MailboxStorageError";
  }
}

// Mailbox messages are modeled with stable ID, sender, and recipient; the persistence layer guarantees delivery and acknowledgment are traceable.
export interface MailboxMessage extends RuntimeEvent {
  readonly id: string;
  readonly sender: string;
  readonly recipient: string;
  readonly kind: MailboxMessageKind;
  readonly content: string;
  readonly createdAtUtc: Date;
  readonly eventId: string;
  readonly idempotencyKey: string;
}

// Protocol messages carry requestId and approved; requests only accept null, and responses must carry a boolean decision.
export interface ProtocolMailboxMessage extends RuntimeEvent {
  // Transport message UUID, serves as both RuntimeEvent.eventId and idempotency key.
  readonly id: string;
  // Request direction points to the original initiator; response direction points to the original target.
  readonly sender: string;
  // Must match strictly with the opposite direction of the associated request.
  readonly recipient: string;
  // typed kind determines whether this message is a request or response, along with the corresponding protocol type.
  readonly kind: ProtocolMessageKind;
  // Request body must match the registered request; response body carries feedback or confirmation.
  readonly content: string;
  // Message creation time belongs to the transport record and does not replace the state transition time of the request.
  readonly createdAtUtc: Date;
  // Correlates request UUID in ProtocolStore, not the current message ID.
  readonly requestId: string;
  // Request is fixed to null; response must be an explicit boolean decision.
  readonly approved: boolean | null;
  // Agent Loop uses this value to deduplicate event publication and ack retries.
  readonly eventId: string;
  // Tool execution follows message ids, supporting side-effect deduplication when protocol responses restore the same Runner.
  readonly idempotencyKey: string;
}

// MailboxItem lets normal collaboration messages and typed protocol messages share the same lease state machine.
export type MailboxItem = MailboxMessage | ProtocolMailboxMessage;

// Store exposes protocol operations for send, claim, and ack; concrete file persistence remains in adapters.
export interface MailboxStore {
  // Normal and protocol messages share the four-state migration; the Store does not care about the business meaning of content.
  send(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): Promise<MailboxMessage>;
  // claim atomically transitions the earliest ready message to processing and returns its lease snapshot.
  claim(recipient: string): Promise<MailboxItem | undefined>;
  // ack accepts only the current processing message and transitions it to done.
  ack(message: MailboxItem): Promise<boolean>;
  // release reverts cancelled or retriable failed processing messages to ready.
  release(message: MailboxItem): Promise<boolean>;
  // quarantine isolates non-retriable malformed or business failure messages.
  quarantine(message: MailboxItem): Promise<boolean>;
  // Recover processing leases leftover from process crashes on startup, returning the recovered count.
  recoverProcessing(recipient: string): Promise<number>;
}

// Only stores supporting protocol messages implement sendProtocol; Runtime performs type checks at construction boundaries.
export interface ProtocolMailboxStore extends MailboxStore {
  // sendProtocol turns request_id/approved into typed payloads on send, preventing models constructing JSON manually.
  sendProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: { readonly requestId: string; readonly approved: boolean | null },
  ): Promise<ProtocolMailboxMessage>;
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
export type SpawnTeammateInput = z.infer<typeof spawnTeammateInputSchema>;

export const sendMessageInputSchema = z
  .object({
    to: z.string(),
    content: z.string(),
  })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

// The Agent name is used as a directory name, so it validates both slug rules and Windows reserved components.
export function canonicalAgentName(value: string): string {
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

// Validate id, sender, recipient, kind, content, and clock at the construction boundary, returning immutable messages.
export function createMailboxMessage(input: {
  id: string;
  sender: string;
  recipient: string;
  kind: MailboxMessageKind;
  content: string;
  createdAtUtc: Date;
}): MailboxMessage {
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

// The protocol message construction boundary validates matching between requestId and approved; requests and responses cannot disguise as each other.
export function createProtocolMailboxMessage(input: {
  id: string;
  sender: string;
  recipient: string;
  kind: ProtocolMessageKind;
  content: string;
  createdAtUtc: Date;
  requestId: string;
  approved: boolean | null;
}): ProtocolMailboxMessage {
  const id = canonicalMailboxMessageId(input.id);
  const sender = canonicalAgentName(input.sender);
  const recipient = canonicalAgentName(input.recipient);
  const requestId = canonicalMailboxMessageId(input.requestId);
  if (!Object.values(ProtocolMessageKind).includes(input.kind)) {
    throw new TypeError("ProtocolMailboxMessage kind must be a protocol kind");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new Error("Mailbox message content must not be empty");
  }
  if (!(input.createdAtUtc instanceof Date) || !Number.isFinite(input.createdAtUtc.valueOf())) {
    throw new Error("Mailbox clock value must be a valid UTC Date");
  }
  const isResponse =
    input.kind === ProtocolMessageKind.ShutdownResponse ||
    input.kind === ProtocolMessageKind.PlanApprovalResponse;
  if (
    (isResponse && typeof input.approved !== "boolean") ||
    (!isResponse && input.approved !== null)
  ) {
    throw new TypeError(
      "Protocol response approved must be a boolean and request approved must be null",
    );
  }
  const createdAtUtc = new Date(input.createdAtUtc.valueOf());
  return Object.freeze({
    id,
    sender,
    recipient,
    kind: input.kind,
    content: input.content,
    createdAtUtc,
    requestId,
    approved: input.approved,
    eventId: id,
    idempotencyKey: id,
    toPayload: protocolMailboxPayload,
  });
}

// On-disk JSON is external input and must reject unknown fields and invalid values to prevent bad messages from corrupting runtime state.
export function mailboxMessageFromJson(value: unknown): MailboxMessage {
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

// Normal and protocol messages share a deserialization entry point: branch by kind first, then apply strict field validation.
export function mailboxItemFromJson(value: unknown): MailboxItem {
  // Discriminated deserialization branches by kind first: normal messages use the original schema; protocol messages allow request_id/approved.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string")
    throw new MailboxStorageError("Mailbox message kind is invalid");
  if (Object.values(MailboxMessageKind).includes(record.kind as MailboxMessageKind)) {
    return mailboxMessageFromJson(record);
  }
  const expected = [
    "approved",
    "content",
    "created_at_utc",
    "id",
    "kind",
    "recipient",
    "request_id",
    "sender",
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new MailboxStorageError("Protocol mailbox payload contains unsupported fields");
  }
  if (
    typeof record.id !== "string" ||
    typeof record.sender !== "string" ||
    typeof record.recipient !== "string" ||
    typeof record.content !== "string" ||
    typeof record.created_at_utc !== "string" ||
    typeof record.request_id !== "string" ||
    (record.approved !== null && typeof record.approved !== "boolean")
  ) {
    throw new MailboxStorageError("Protocol mailbox payload is invalid");
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
    return createProtocolMailboxMessage({
      id: record.id,
      sender: record.sender,
      recipient: record.recipient,
      kind: record.kind as ProtocolMessageKind,
      content: record.content,
      createdAtUtc,
      requestId: record.request_id,
      approved: record.approved,
    });
  } catch (error) {
    throw new MailboxStorageError("Protocol mailbox fields failed validation", { cause: error });
  }
}

// Persistence uses stable snake_case field names while in-memory objects keep camelCase; conversions occur at boundaries only.
export function mailboxMessageToJson(message: MailboxMessage): Readonly<Record<string, string>> {
  return Object.freeze({
    id: message.id,
    sender: message.sender,
    recipient: message.recipient,
    kind: message.kind,
    content: message.content,
    created_at_utc: message.createdAtUtc.toISOString(),
  });
}

// Normal and protocol messages share a serialization entry point; protocol fields appear only at boundaries to avoid polluting normal messages.
export function mailboxItemToJson(
  message: MailboxItem,
): Readonly<Record<string, string | boolean | null>> {
  if (isProtocolMailboxMessage(message)) {
    return Object.freeze({
      id: message.id,
      sender: message.sender,
      recipient: message.recipient,
      kind: message.kind,
      content: message.content,
      created_at_utc: message.createdAtUtc.toISOString(),
      request_id: message.requestId,
      approved: message.approved,
    });
  }
  return mailboxMessageToJson(message);
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

export function equalMailboxItems(left: MailboxItem, right: MailboxItem): boolean {
  const leftProtocol = isProtocolMailboxMessage(left);
  const rightProtocol = isProtocolMailboxMessage(right);
  if (leftProtocol !== rightProtocol) return false;
  if (!leftProtocol && !rightProtocol) {
    return equalMailboxMessages(left, right);
  }
  const leftProtocolMessage = left as ProtocolMailboxMessage;
  const rightProtocolMessage = right as ProtocolMailboxMessage;
  return (
    leftProtocolMessage.id === rightProtocolMessage.id &&
    leftProtocolMessage.sender === rightProtocolMessage.sender &&
    leftProtocolMessage.recipient === rightProtocolMessage.recipient &&
    leftProtocolMessage.kind === rightProtocolMessage.kind &&
    leftProtocolMessage.content === rightProtocolMessage.content &&
    leftProtocolMessage.createdAtUtc.valueOf() === rightProtocolMessage.createdAtUtc.valueOf() &&
    leftProtocolMessage.requestId === rightProtocolMessage.requestId &&
    leftProtocolMessage.approved === rightProtocolMessage.approved
  );
}

// Identifies protocol messages via stable markers on payload, without relying on string prefixes or duck-typed fields.
export function isProtocolMailboxMessage(message: RuntimeEvent): message is ProtocolMailboxMessage {
  const payload = message.toPayload();
  return payload.kind === "protocol" && "request_id" in payload && "protocol_kind" in payload;
}

// Use sendProtocol capability at construction to distinguish standard MailboxStore from protocol extension stores.
export function isProtocolMailboxStore(store: MailboxStore): store is ProtocolMailboxStore {
  return typeof Reflect.get(store, "sendProtocol") === "function";
}

export function randomMailboxMessageId(): string {
  // Default ID generator is used only during production construction; tests can inject deterministic UUIDs.
  return randomUUID();
}

// RuntimeEvent payload exposes structured fields to prevent callers from determining message types by string prefixes.
function mailboxPayload(this: MailboxMessage): Readonly<Record<string, unknown>> {
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

// Protocol payloads carry request_id and approved so EventInbox and protocol routing distinguish message types.
function protocolMailboxPayload(this: ProtocolMailboxMessage): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: "protocol",
    message_id: this.id,
    sender: this.sender,
    recipient: this.recipient,
    protocol_kind: this.kind,
    content: this.content,
    created_at_utc: this.createdAtUtc.toISOString(),
    request_id: this.requestId,
    approved: this.approved,
  });
}
