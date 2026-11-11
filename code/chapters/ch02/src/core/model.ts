/**
 * Model boundary module: defines the minimal model interface required by the core loop.
 * ModelClient.complete is the only asynchronous entry point. The adapter normalizes provider responses into ModelReply.
 * OpenAIToolSchema describes the tool structure visible to the model. FinishReason retains only the finish reasons supported by this project.
 */
import type { AssistantMessage, ChatMessage } from "./messages.js";

// Minimal union type aligned with vendor finish_reason; adapters explicitly reject legacy function_call.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

// Model-visible function tool description decoupled from internal ToolDefinition.
export interface OpenAIToolSchema {
  // Current protocols allow function tools only.
  readonly type: "function";
  // Container for function tool metadata mandated by vendor.
  readonly function: {
    // Stable invocation name consistent with the registry.
    readonly name: string;
    // Capability description for the model.
    readonly description: string;
    // JSON Schema parameter contract independent of SDK types.
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// Frozen snapshot of a single model request to prevent history or tool sets from changing after construction.
export interface ModelRequest {
  // Validated conversation history.
  readonly messages: readonly ChatMessage[];
  // Frozen descriptions of tools actually callable in this turn.
  readonly tools: readonly OpenAIToolSchema[];
  // Optional per-request model override.
  readonly model?: string;
  // Optional per-request output budget, distinct from the Agent turn limit.
  readonly maxTokens?: number;
}

// Usage is optional observability data; adapters populate it only when the provider returns it completely.
export interface TokenUsage {
  // The number of tokens consumed by input messages.
  readonly promptTokens: number;
  // The number of tokens consumed by the output reply.
  readonly completionTokens: number;
  // Total token count reported by vendor.
  readonly totalTokens: number;
}

// Normalized reply handed back to the core loop by the adapter.
export interface ModelReply {
  // Model replies narrowed to core message contracts.
  readonly message: AssistantMessage;
  // Finish reason that determines whether the loop continues, terminates, or fails.
  readonly finishReason: FinishReason;
  // Optional statistics for subsequent budget strategies.
  readonly usage?: TokenUsage;
}

export interface ModelClient {
  // The core loop requests the next model message only through this asynchronous boundary.
  complete(request: ModelRequest): Promise<ModelReply>;
}
