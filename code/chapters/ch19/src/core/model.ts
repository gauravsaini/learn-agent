// Model adapter contract: normalize provider responses into ModelReply and map rate limit, overload, and length errors into recoverable ModelAPIError subtypes.
import type { AssistantMessage, ChatMessage } from "./messages.js";

// Vendor adapters must normalize to these finish states so the loop can handle unfulfillable or filtered replies.
// content_filter is a valid wire value here, but the loop layer decides if it enters the final result.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

// typed API error carries only status, error code, and request ID extracted stably by adapters for typed recovery dispatch.
// Validate all base class fields at construction; statusCode must be a positive integer; error objects must also satisfy reliable contracts.
export class ModelAPIError extends Error {
  readonly statusCode: number;
  readonly errorCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      readonly statusCode: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    },
  ) {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new TypeError("message must be a non-empty string");
    }
    if (!Number.isInteger(options.statusCode) || options.statusCode <= 0) {
      throw new RangeError("statusCode must be a positive integer");
    }
    if (
      options.errorCode !== undefined &&
      (typeof options.errorCode !== "string" || options.errorCode.trim().length === 0)
    ) {
      throw new TypeError("errorCode must be a non-empty string or undefined");
    }
    if (
      options.requestId !== undefined &&
      (typeof options.requestId !== "string" || options.requestId.trim().length === 0)
    ) {
      throw new TypeError("requestId must be a non-empty string or undefined");
    }
    super(message, { cause: options.cause });
    this.name = "ModelAPIError";
    this.statusCode = options.statusCode;
    this.errorCode = options.errorCode;
    this.requestId = options.requestId;
  }
}

// Rate limit errors consistently correspond to HTTP 429; Retry-After passes through as-is without parsing time format here.
export class ModelRateLimitError extends ModelAPIError {
  readonly retryAfter: string | undefined;

  constructor(
    message: string,
    options: {
      readonly retryAfter?: string;
      readonly statusCode?: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    const statusCode = options.statusCode === undefined ? 429 : options.statusCode;
    if (statusCode !== 429) {
      throw new RangeError("ModelRateLimitError statusCode must be 429");
    }
    if (options.retryAfter !== undefined && typeof options.retryAfter !== "string") {
      throw new TypeError("retryAfter must be a string or undefined");
    }
    super(message, { ...options, statusCode });
    this.name = "ModelRateLimitError";
    this.retryAfter = options.retryAfter;
  }
}

// Overload errors consistently correspond to HTTP 529. RecoveryManager maintains consecutive counts based on turn state.
export class ModelOverloadedError extends ModelAPIError {
  constructor(
    message: string,
    options: {
      readonly statusCode?: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    const statusCode = options.statusCode === undefined ? 529 : options.statusCode;
    if (statusCode !== 529) {
      throw new RangeError("ModelOverloadedError statusCode must be 529");
    }
    super(message, { ...options, statusCode });
    this.name = "ModelOverloadedError";
  }
}

// When the input is too long, map only 400 with a definite error code; do not guess from exception message text.
export class ModelPromptTooLongError extends ModelAPIError {
  constructor(
    message: string,
    options: {
      readonly statusCode?: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    const statusCode = options.statusCode === undefined ? 400 : options.statusCode;
    if (statusCode !== 400) {
      throw new RangeError("ModelPromptTooLongError statusCode must be 400");
    }
    super(message, { ...options, statusCode });
    this.name = "ModelPromptTooLongError";
  }
}

export interface OpenAIToolSchema {
  // Tool schemas accept only OpenAI-compatible function structures; parameters retains raw JSON Schema,
  // Pass through as-is from the request mapping layer without parsing concrete parameter types in core.
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// Recovery layers can override model and maxTokens; messages/tools is a complete snapshot for each request.
// Snapshot of a complete model request. messages/tools is the full context; model/maxTokens are optional,
// Enables RecoveryManager to switch models or increase output budget without modifying message content.
export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolSchema[];
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface TokenUsage {
  // usage accepts only three non-negative integers; adapter populates after validation to avoid recovery layers or logs receiving partial counts.
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

// reply must be a complete model output; upper layers decide whether to continue when finishReason is length.
// reply must be a complete model output; upper layers decide whether to continue when finishReason is length,
// content_filter indicates filtered content; do not treat it as a normal final reply.
export interface ModelReply {
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

// core only depends on a single full call, without awareness of OpenAI SDK or HTTP details; signal propagates cancellation and timeout.
// Callers manage total deadlines and retry policies; ModelClient itself does not retry automatically.
export interface ModelClient {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
}
