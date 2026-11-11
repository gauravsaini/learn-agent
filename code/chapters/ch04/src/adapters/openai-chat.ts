// OpenAI SDK exists only in this adapter; core does not depend on vendor types.
// OpenAI Adapter: maps core ModelClient interface to OpenAI SDK, performing response normalization and error checks.
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

// Boundary error used when vendor responses violate the internal model contract.
export class OpenAIResponseError extends Error {
  override readonly name = "OpenAIResponseError";
}

export interface OpenAIClientBoundary {
  readonly chat: {
    readonly completions: {
      create(request: ChatCompletionCreateParamsNonStreaming): Promise<unknown>;
    };
  };
}

export class OpenAIChatModel implements ModelClient {
  readonly #client: OpenAIClientBoundary;
  readonly #model: string;

  constructor(settings: OpenAISettings, client?: OpenAIClientBoundary) {
    this.#client =
      client === undefined
        ? new OpenAI({
            apiKey: settings.apiKey,
            baseURL: settings.baseUrl,
            // Retries are controlled uniformly by the provider-agnostic recovery layer from Chapter 11; the SDK must not hide additional requests.
            maxRetries: 0,
          })
        : client;
    // Fixed model name; subsequent chapters can override temporarily via ModelRequest.model.
    this.#model = settings.model;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    // Validate history pairing before sending requests to avoid sending invalid sessions to providers.
    validateToolPairing(request.messages);
    // maxTokens check prevents zero or negative values causing provider API errors instead of fixing caller mistakes.
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

interface NormalizedResponse {
  readonly content: string | null;
  readonly calls: readonly ReturnType<typeof toolCall>[];
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

function normalizeResponse(response: unknown): NormalizedResponse {
  // OpenAI SDK boundary returns unknown; narrow layer by layer before entering trusted core types.
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

function normalizeToolCall(call: unknown): ReturnType<typeof toolCall> {
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

function isFinishReason(value: unknown): value is FinishReason {
  // Explicitly list all known finish_reason values; reject unknown values as unrecoverable errors.
  return (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter" ||
    value === "function_call"
  );
}

function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
  // Conversion between internal message model and OpenAI structures is centralized in adapter; core does not depend on SDK types.
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

function toOpenAITool(tool: ModelRequest["tools"][number]): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

function normalizeUsage(usage: unknown): TokenUsage {
  // Usage fields are used for observability and still reject incomplete responses following a strict integer contract.
  if (typeof usage !== "object" || usage === null) {
    throw new OpenAIResponseError("Chat completion usage must be an object");
  }
  // Field types and value ranges are converged by adapters; core does not perform runtime negative value checks.
  const promptTokens = readUsageCount(usage, "prompt_tokens");
  const completionTokens = readUsageCount(usage, "completion_tokens");
  const totalTokens = readUsageCount(usage, "total_tokens");
  return Object.freeze({
    promptTokens,
    completionTokens,
    totalTokens,
  });
}

function readUsageCount(usage: object, field: string): number {
  const value = Reflect.get(usage, field);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OpenAIResponseError(
      `Chat completion usage field ${field} must be non-negative integer`,
    );
  }
  return value;
}
