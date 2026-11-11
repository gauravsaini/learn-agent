// Vendor adapters must normalize to these finish states so the loop can handle unfulfillable or filtered replies.
// Model interface boundary: core depends only on complete() returning normalized ModelReply without binding provider SDKs.
import type { AssistantMessage, ChatMessage } from "./messages.js";

// Vendor adapters must normalize to these finish states so the loop can handle truncation, content filtering, or normal finish.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

export interface OpenAIToolSchema {
  // Tool definitions seen by the model only contain name, description, and JSON Schema, exposing neither handler nor effect.
  readonly type: "function";
  // Function tool metadata container required by SDK protocol.
  readonly function: {
    // Stable tool invocation name in the registry.
    readonly name: string;
    // Capability description used by the model when selecting tools.
    readonly description: string;
    // Vendor-agnostic JSON Schema parameter contract.
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface ModelRequest {
  // Recovery or budget layers in later chapters can override model and maxTokens.
  // Validated conversation history that cannot change mid-call.
  readonly messages: readonly ChatMessage[];
  // Descriptions of callable tools frozen at the same time as history.
  readonly tools: readonly OpenAIToolSchema[];
  // Optional per-request model override.
  readonly model?: string;
  // Optional per-request output budget, distinct from the Agent total turn budget.
  readonly maxTokens?: number;
}

export interface TokenUsage {
  // Usage is used for observability and analysis; Adapters must provide it following a strict integer contract.
  // Input message consumption.
  readonly promptTokens: number;
  // Output reply consumption.
  readonly completionTokens: number;
  // Total amount reported by vendor.
  readonly totalTokens: number;
}

export interface ModelReply {
  // Normalized finishReason is the only authoritative terminal signal; adapter must not keep raw provider enums.
  // Model replies converted to core message contracts.
  readonly message: AssistantMessage;
  // Finish state that determines whether the loop continues, terminates, or fails.
  readonly finishReason: FinishReason;
  // Optional usage data.
  readonly usage?: TokenUsage;
}

export interface ModelClient {
  // core only depends on a single full call, without awareness of OpenAI SDK or HTTP details.
  // core only depends on a single full call; the upper composition root implements retry, fallback, and recovery outside the adapter.
  complete(request: ModelRequest): Promise<ModelReply>;
}
