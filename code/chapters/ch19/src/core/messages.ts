// The message type is the only conversation structure between core and model adapters; the constructor handles freezing and field validation.
// Minimal conversation message model aligned with Chat Completions.
// validateToolPairing strictly ensures each tool_call has a corresponding tool message.
// Conversation message model: matches minimal roles and field set of OpenAI Chat Completions.
// validateToolPairing strictly ensures each tool_call has a corresponding tool message, preserving provider pairing contracts.
export type Role = "system" | "user" | "assistant" | "tool";

export class MessageContractError extends Error {
  override readonly name = "MessageContractError";
}

// Arguments remain JSON strings; concrete parsing and schema validation belong to the Tool Registry.
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

// Call IDs in the same assistant message are unique keys for subsequent tool result pairing.
export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolMessage {
  readonly role: "tool";
  readonly content: string;
  readonly toolCallId: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const role = Reflect.get(value, "role");
  const content = Reflect.get(value, "content");
  if (role === "system" || role === "user") {
    return typeof content === "string";
  }
  if (role === "tool") {
    return typeof content === "string" && typeof Reflect.get(value, "toolCallId") === "string";
  }
  if (role !== "assistant" || (content !== null && typeof content !== "string")) {
    return false;
  }
  const calls = Reflect.get(value, "toolCalls");
  return (
    Array.isArray(calls) &&
    calls.every(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        typeof Reflect.get(call, "id") === "string" &&
        typeof Reflect.get(call, "name") === "string" &&
        typeof Reflect.get(call, "arguments") === "string",
    )
  );
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new MessageContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new MessageContractError(`${field} must not be empty`);
  }
  return value;
}

export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  // Arguments remain JSON strings; concrete parsing and schema validation belong to the Tool Registry.
  return Object.freeze({
    id: requireString(id, "tool call id"),
    name: requireString(name, "tool call name"),
    arguments: requireString(argumentsJson, "tool call arguments", true),
  });
}

export function systemMessage(content: string): SystemMessage {
  return Object.freeze({ role: "system", content: requireString(content, "system content", true) });
}

export function userMessage(content: string): UserMessage {
  return Object.freeze({ role: "user", content: requireString(content, "user content", true) });
}

export function assistantMessage(
  content: string | null,
  toolCalls: readonly ToolCall[] = [],
): AssistantMessage {
  if (content !== null) {
    requireString(content, "assistant content", true);
  }
  // Call IDs in the same assistant message are unique keys for subsequent tool result pairing.
  const ids = toolCalls.map((call) => call.id);
  if (new Set(ids).size !== ids.length) {
    throw new MessageContractError("assistant tool call ids must be unique");
  }
  return Object.freeze({ role: "assistant", content, toolCalls: Object.freeze([...toolCalls]) });
}

export function toolMessage(content: string, toolCallId: string): ToolMessage {
  return Object.freeze({
    role: "tool",
    content: requireString(content, "tool content", true),
    toolCallId: requireString(toolCallId, "tool_call_id"),
  });
}

// The exact number of tool messages must follow assistant tool calls to keep provider protocol history valid.
export function validateToolPairing(messages: readonly ChatMessage[]): void {
  // Each assistant tool call must be immediately followed by a matching tool result; otherwise the provider protocol fails directly.
  // The exact number of tool messages must follow assistant tool calls to keep provider protocol history valid.
  const pending = new Set<string>();

  // The pending set represents "current assistant tool call block has not finished backfilling":
  // The next batch of messages must be tool messages and consume only IDs in pending; no orphaned or missing messages are allowed.
  for (const message of messages) {
    if (pending.size > 0) {
      if (message.role !== "tool") {
        throw new MessageContractError(
          `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
        );
      }
      if (!pending.delete(message.toolCallId)) {
        throw new MessageContractError(`unexpected tool result id: ${message.toolCallId}`);
      }
      continue;
    }

    if (message.role === "tool") {
      throw new MessageContractError(`orphan tool result id: ${message.toolCallId}`);
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        pending.add(call.id);
      }
    }
  }

  if (pending.size > 0) {
    throw new MessageContractError(
      `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
    );
  }
}
