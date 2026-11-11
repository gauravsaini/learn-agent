// Discriminant tag for chat history; role determines allowed fields for each message and tool pairing rules.
export type Role = "system" | "user" | "assistant" | "tool";

// The message contract guarantees that model tool calls and subsequent tool results match one-to-one strictly in history.
//
// ChatMessage is a discriminated union of four message types:
//   system     - System prompt, prepended by AgentRunner on each request
//   user       - User input, enters history when the run begins
//   assistant  - Model reply, may contain zero or more toolCalls
//   tool       - Tool execution result, must correspond to an assistant call via toolCallId
// This contract is the foundation of Agent Loop correctness: The model must know precisely which call each tool result belongs to.
export class MessageContractError extends Error {
  // Keeps stable error names so CLI and tests can distinguish message contract errors from external failures.
  override readonly name = "MessageContractError";
}

// A tool call declared by the model in an assistant reply; a corresponding ToolMessage must backfill afterward.
export interface ToolCall {
  // ToolCall represents one tool that the model requests to execute in one reply.
  // id is the unique identifier for this call; arguments is a JSON string parsed and validated by ToolRegistry.
  readonly id: string;
  // Name used to look up tool definitions in the registry, not the user-facing description.
  readonly name: string;
  // Retains vendor-provided JSON text to prevent message layer from overstepping into schema parsing responsibilities.
  readonly arguments: string;
}

// System constraints prepended each request; do not write to mutable history to avoid saving repeatedly each turn.
export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

// User input recorded when a run starts.
export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

// Model reply; when content is null, it must carry tool calls, otherwise the reply is incomplete.
export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

// Backfilled results of tool calls; toolCallId associates it with the immediately preceding assistant call.
export interface ToolMessage {
  readonly role: "tool";
  readonly content: string;
  readonly toolCallId: string;
}

// Discriminated union of four message kinds, used for exhaustive branching in history validation and provider conversion.
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// Common string boundary validation for all message constructors, distinguishing type errors from disallowed empty values clearly.
function requireString(value: unknown, field: string, allowEmpty = false): string {
  // All message constructors share this boundary check, distinguishing "not a string" from "empty strings not allowed".
  // allowEmpty=true is used when arguments/content can be empty.
  if (typeof value !== "string") {
    throw new MessageContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new MessageContractError(`${field} must not be empty`);
  }
  return value;
}

// Creates and freezes tool call; parameter text parses and validates only during registry prepare stage.
export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  // arguments preserves raw JSON text; ToolRegistry handles parsing and schema validation.
  // The core loop does not parse arguments; it passes raw text directly to the Tool Registry.
  return Object.freeze({
    id: requireString(id, "tool call id"),
    name: requireString(name, "tool call name"),
    arguments: requireString(argumentsJson, "tool call arguments", true),
  });
}

// Create a system message; allow empty content for provider protocol compatibility, while AgentRunner enforces system prompt limits.
export function systemMessage(content: string): SystemMessage {
  return Object.freeze({ role: "system", content: requireString(content, "system content", true) });
}

// Create a user message; allow empty text so the message layer does not change higher-level input policy.
export function userMessage(content: string): UserMessage {
  return Object.freeze({ role: "user", content: requireString(content, "user content", true) });
}

// Create a model message and verify call IDs are unique in the same reply to ensure one-to-one result backfill.
export function assistantMessage(
  content: string | null,
  toolCalls: readonly ToolCall[] = [],
): AssistantMessage {
  // Call IDs within the same assistant reply must be unique, or tool results cannot correspond one-to-one.
  // When multiple tools run in parallel, each call must have a unique ID to pair results correctly.
  if (content !== null) {
    requireString(content, "assistant content", true);
  }
  const ids = toolCalls.map((call) => call.id);
  if (new Set(ids).size !== ids.length) {
    throw new MessageContractError("assistant tool call ids must be unique");
  }
  return Object.freeze({ role: "assistant", content, toolCalls: Object.freeze([...toolCalls]) });
}

// Creates tool result message and enforces non-empty toolCallId to preserve auditable call correlation.
export function toolMessage(content: string, toolCallId: string): ToolMessage {
  return Object.freeze({
    role: "tool",
    content: requireString(content, "tool content", true),
    toolCallId: requireString(toolCallId, "tool_call_id"),
  });
}

// Validates tool call and result pairing invariants across full history, preventing corrupted history from leaking before requesting provider.
export function validateToolPairing(messages: readonly ChatMessage[]): void {
  // After encountering assistant calls, accepts only unfilled tool messages until the set is empty.
  // This is a core invariant: Any assistant tool call must have exactly one corresponding tool result.
  // Call it before sending requests to the model to detect history corruption early and avoid wasted remote requests.
  const pending = new Set<string>();

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
