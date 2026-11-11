import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { assistantMessage, toolCall, validateToolPairing } from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import type {
  FinishReason,
  ModelClient,
  ModelReply,
  ModelRequest,
  TokenUsage,
} from "../core/model.js";
import type { OpenAISettings } from "../config.js";

// OpenAI adapter: narrows loose return types of Chat Completions SDK into the ModelClient contract used by the core loop.
//
// normalizeResponse validates raw SDK responses layer by layer at runtime, rejecting invalid types, legacy function_call,
// Missing fields and unsupported finish_reason. Validation completes at the adapter boundary, and the core loop never contacts SDK types.
//
// Narrow loose responses from OpenAI SDK into strict model contracts used by Agent Loop.
export class OpenAIResponseError extends Error {
  // Stable error name, indicating that the failure occurred during the provider response narrowing phase.
  override readonly name = "OpenAIResponseError";
}

// Minimal SDK surface actually depended on by the adapter, allowing tests to replace network clients.
export interface OpenAIClientBoundary {
  // Declares only the SDK surface used by this adapter so tests can inject network-free client doubles.
  readonly chat: {
    readonly completions: {
      create(request: ChatCompletionCreateParamsNonStreaming): Promise<unknown>;
    };
  };
}

// Encapsulate validated settings and OpenAI SDK into ModelClient implementations for the core layer.
export class OpenAIChatModel implements ModelClient {
  // Replaceable Chat Completions invocation boundary; production defaults to the real SDK.
  readonly #client: OpenAIClientBoundary;
  // Default model in configuration; requests can explicitly override per call.
  readonly #model: string;

  // Creates production client from settings, or accepts double client to isolate network tests.
  constructor(settings: OpenAISettings, client?: OpenAIClientBoundary) {
    // Defaults to creating real SDK; optional client keeps the external request boundary replaceable.
    this.#client =
      client === undefined
        ? new OpenAI({
            apiKey: settings.apiKey,
            baseURL: settings.baseUrl,
            // Retries are controlled uniformly by the provider-agnostic recovery layer from Chapter 11; the SDK must not hide additional requests.
            maxRetries: 0,
          })
        : client;
    this.#model = settings.model;
  }

  // Validates history, converts request, calls SDK, then narrows loose response to ModelReply.
  async complete(request: ModelRequest): Promise<ModelReply> {
    // Validate history before sending to providers; pairing errors must not be disguised as remote model failures.
    validateToolPairing(request.messages);
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new Error("maxTokens must be a positive integer");
    }
    const model = request.model === undefined ? this.#model : request.model;
    const response = await this.#client.chat.completions.create({
      model,
      messages: request.messages.map(toOpenAIMessage),
      ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toOpenAITool) }),
      ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }),
    });
    const normalized = normalizeResponse(response);
    return Object.freeze({
      message: assistantMessage(normalized.content, normalized.calls),
      finishReason: normalized.finishReason,
      ...(normalized.usage === undefined ? {} : { usage: normalized.usage }),
    });
  }
}

// Internal intermediate shape of SDK response after narrowing, before conversion to core message objects.
interface NormalizedResponse {
  // Internal representation of raw SDK response narrowed by runtime, preventing unknown from entering loop state.
  readonly content: string | null;
  readonly calls: readonly ReturnType<typeof toolCall>[];
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

// Extracts single choice, message, tool calls, and usage from unknown SDK return values, rejecting unsupported protocols at the boundary.
function normalizeResponse(response: unknown): NormalizedResponse {
  // SDK return value is an untrusted external boundary; validate layer by layer before allowing it into core message history.
  if (typeof response !== "object" || response === null) {
    throw new OpenAIResponseError("Chat completion response must be an object");
  }
  const choices = Reflect.get(response, "choices");
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw new OpenAIResponseError("Chat completion must return exactly one choice");
  }
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) {
    throw new OpenAIResponseError("Chat completion choice must be an object");
  }
  const finishReason = Reflect.get(choice, "finish_reason");
  if (!isFinishReason(finishReason)) {
    throw new OpenAIResponseError(`Unsupported finish_reason: ${String(finishReason)}`);
  }
  if (finishReason === "function_call") {
    throw new OpenAIResponseError("Legacy function_call finish reason is unsupported");
  }
  const message = Reflect.get(choice, "message");
  if (typeof message !== "object" || message === null) {
    throw new OpenAIResponseError("Chat completion message must be an object");
  }
  if (Reflect.get(message, "role") !== "assistant") {
    throw new OpenAIResponseError("Chat completion message role must be assistant");
  }
  const rawContent = Reflect.get(message, "content");
  if (rawContent !== null && typeof rawContent !== "string") {
    throw new OpenAIResponseError("Chat completion content must be a string or null");
  }
  const refusal = Reflect.get(message, "refusal");
  if (refusal !== undefined && refusal !== null && typeof refusal !== "string") {
    throw new OpenAIResponseError("Chat completion refusal must be a string or null");
  }
  const rawCalls = Reflect.get(message, "tool_calls");
  const legacyCall = Reflect.get(message, "function_call");
  if (legacyCall !== undefined && legacyCall !== null) {
    throw new OpenAIResponseError("Legacy function_call responses are unsupported");
  }
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) {
    throw new OpenAIResponseError("Chat completion tool_calls must be an array");
  }
  const calls = (rawCalls === undefined ? [] : rawCalls).map(normalizeToolCall);
  const rawUsage = Reflect.get(response, "usage");
  const content = rawContent !== null ? rawContent : typeof refusal === "string" ? refusal : null;
  return Object.freeze({
    content,
    calls: Object.freeze(calls),
    finishReason,
    ...(rawUsage === undefined || rawUsage === null ? {} : { usage: normalizeUsage(rawUsage) }),
  });
}

// Convert a vendor function call into a core ToolCall, retaining precise error contexts.
function normalizeToolCall(call: unknown): ReturnType<typeof toolCall> {
  // Chat Completions accepts only function type calls and delegates validation of three string fields to core constructors.
  if (typeof call !== "object" || call === null) {
    throw new OpenAIResponseError("Tool call must be an object");
  }
  const type = Reflect.get(call, "type");
  if (type !== "function") {
    throw new OpenAIResponseError(`Unsupported tool call type: ${String(type)}`);
  }
  const fn = Reflect.get(call, "function");
  if (typeof fn !== "object" || fn === null) {
    throw new OpenAIResponseError("Function tool call payload must be an object");
  }
  try {
    return toolCall(Reflect.get(call, "id"), Reflect.get(fn, "name"), Reflect.get(fn, "arguments"));
  } catch (error) {
    throw new OpenAIResponseError(
      `Invalid function tool call: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Determine whether the provider finish reason belongs to the controlled set understood by the core layer.
function isFinishReason(value: unknown): value is FinishReason {
  // The whitelist preserves legacy values so normalizeResponse can produce clear unsupported errors.
  return (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter" ||
    value === "function_call"
  );
}

// Convert discriminated union messages to OpenAI SDK message shapes, preserving tool call correlation IDs.
function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
  // Retains correlation fields between tool call and tool result to prevent breaking message pairing during conversion.
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "tool":
      return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
    case "assistant": {
      const result: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: message.content,
      };
      if (message.toolCalls.length > 0) {
        result.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return result;
    }
  }
}

// Convert vendor-agnostic schemas generated by the registry into function tool objects required by the SDK.
function toOpenAITool(tool: ModelRequest["tools"][number]): ChatCompletionTool {
  // Tool schemas are generated from the registry as a single source of truth; convert only to SDK request shapes here.
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

// Extract and validate provider token usage to ensure budget policies receive integer metric values.
function normalizeUsage(usage: unknown): TokenUsage {
  // Usage fields participate in recovery strategies of later chapters, so they must be non-negative integers rather than loose conversions.
  if (typeof usage !== "object" || usage === null) {
    throw new OpenAIResponseError("Chat completion usage must be an object");
  }
  const promptTokens = readUsageCount(usage, "prompt_tokens");
  const completionTokens = readUsageCount(usage, "completion_tokens");
  const totalTokens = readUsageCount(usage, "total_tokens");
  return Object.freeze({
    promptTokens,
    completionTokens,
    totalTokens,
  });
}

// Read a single snake_case usage field, rejecting negative numbers, decimals, and missing values.
function readUsageCount(usage: object, field: string): number {
  const value = Reflect.get(usage, field);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OpenAIResponseError(
      `Chat completion usage field ${field} must be non-negative integer`,
    );
  }
  return value;
}
