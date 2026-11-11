// File responsibility: this module is the only provider adapter layer that directly depends on the OpenAI SDK; core does not import provider types.
// It is responsible for three tasks: mapping internal ModelRequest to OpenAI wire format, normalizing HTTP errors into stable fields
// typed model error, converting validated success responses field by field into ModelReply.
import OpenAI, { APIError } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { assistantMessage, toolCall, validateToolPairing } from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../core/model.js";
import type {
  FinishReason,
  ModelClient,
  ModelReply,
  ModelRequest,
  TokenUsage,
} from "../core/model.js";
import type { OpenAISettings } from "../config.js";

// Throw this error when successful responses fail structural validation. Vendor 200 returns do not guarantee trusted structures; never guess field types.
export class OpenAIResponseError extends Error {
  override readonly name = "OpenAIResponseError";
}

// A minimal client boundary exposes only create, allowing tests to inject fake OpenAI state objects.
export interface OpenAIClientBoundary {
  readonly chat: {
    readonly completions: {
      create(
        request: ChatCompletionCreateParamsNonStreaming,
        options?: { readonly signal?: AbortSignal },
      ): Promise<unknown>;
    };
  };
}

export class OpenAIChatModel implements ModelClient {
  readonly #client: OpenAIClientBoundary;
  readonly #model: string;

  // Defaults to creating a real OpenAI client and turns off SDK retries to 0; retry decisions are delegated uniformly to the recovery layer.
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
    this.#model = settings.model;
  }

  // complete() is the provider boundary: reject non-compliant requests first, then call the OpenAI SDK.
  // Pass signal directly to network layers; validate returned success responses field by field as untrusted data.
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    validateToolPairing(request.messages);
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new Error("maxTokens must be a positive integer");
    }
    const model = request.model === undefined ? this.#model : request.model;
    let response: unknown;
    try {
      response = await this.#client.chat.completions.create(
        {
          model,
          messages: request.messages.map(toOpenAIMessage),
          ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toOpenAITool) }),
          ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }),
        },
        ...(signal === undefined ? [] : [{ signal }]),
      );
    } catch (error) {
      const mapped = mapApiStatusError(error);
      if (mapped === undefined) {
        throw error;
      }
      throw mapped;
    }
    const normalized = normalizeResponse(response);
    return Object.freeze({
      message: assistantMessage(normalized.content, normalized.calls),
      finishReason: normalized.finishReason,
      ...(normalized.usage === undefined ? {} : { usage: normalized.usage }),
    });
  }
}

// When the input is too long, accept only stable code/type identifiers; do not match message text.
const PROMPT_TOO_LONG_CODES = new Set([
  "context_length_exceeded",
  "max_context_window",
  "prompt_is_too_long",
  "prompt_too_long",
]);

// Recognize only structured fields in APIError; rethrow unknown errors as-is.
function mapApiStatusError(error: unknown): Error | undefined {
  if (!(error instanceof APIError)) {
    return undefined;
  }
  const status = error.status;
  if (!Number.isInteger(status)) {
    return undefined;
  }
  const body = error.error;
  const errorCode = structuredErrorIdentifier(body);
  const requestId = nonEmptyText(error.requestID);
  if (status === 429) {
    const retryAfter = retryAfterValue(error.headers);
    return new ModelRateLimitError("OpenAI request was rate limited", {
      statusCode: status,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  if (status === 529) {
    return new ModelOverloadedError("OpenAI model was overloaded", {
      statusCode: status,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  if (status === 400 && errorCode !== undefined && PROMPT_TOO_LONG_CODES.has(errorCode)) {
    return new ModelPromptTooLongError("OpenAI prompt exceeded the model context window", {
      statusCode: status,
      errorCode,
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  return undefined;
}

// error code only extracts code/type from flat objects or one-level error objects, avoiding recursive searches of untrusted JSON.
function structuredErrorIdentifier(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const candidates = [body];
  const nested = Reflect.get(body, "error");
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    candidates.push(nested);
  }
  for (const candidate of candidates) {
    for (const field of ["code", "type"]) {
      const value = nonEmptyText(Reflect.get(candidate, field));
      if (value !== undefined) {
        return value.toLowerCase();
      }
    }
  }
  return undefined;
}

// Read Retry-After only from standard Headers; do not guess for other response types.
function retryAfterValue(headers: unknown): string | undefined {
  if (headers instanceof Headers) {
    return nonEmptyText(headers.get("retry-after"));
  }
  return undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

interface NormalizedResponse {
  readonly content: string | null;
  readonly calls: readonly ReturnType<typeof toolCall>[];
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

// Successful responses belong to untrusted boundaries. HTTP 200 indicates only that requests were accepted, not that choices/message/finish_reason/
// tool_calls/usage conforms to model interfaces; validate field by field here, failing immediately on mismatches to keep incomplete objects out of recovery layers.
function normalizeResponse(response: unknown): NormalizedResponse {
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

// tool_calls must carry complete id/name/arguments; if the provider returns missing fields or invalid arguments, this turn fails explicitly,
// Cannot write incomplete tool calls into history, nor guess completions in the recovery layer.
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
  return (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter" ||
    value === "function_call"
  );
}

// Mapping from ChatMessage to OpenAI wire format. system/user sends only content; tool must include tool_call_id,
// Pairs with assistant tool_calls; assistant tool_calls expand into function structures as-is.
function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
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

// Tool schemas map directly to function objects accepted by OpenAI; internal contracts require type fixed to "function".
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

// usage is not purely diagnostic; external services or proxies can rewrite it; fail this turn if any count is missing, negative, or decimal.
function normalizeUsage(usage: unknown): TokenUsage {
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

function readUsageCount(usage: object, field: string): number {
  const value = Reflect.get(usage, field);
  // Counts must be enumerable non-negative integers; floats, NaN, and negative numbers violate the structural contract.
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OpenAIResponseError(
      `Chat completion usage field ${field} must be non-negative integer`,
    );
  }
  return value;
}
