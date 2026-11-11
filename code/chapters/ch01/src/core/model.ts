import type { AssistantMessage, ChatMessage } from "./messages.js";

// The model boundary decouples from provider SDKs; the loop handles only normalized requests and replies.
//
// The core loop (AgentRunner) only knows a single entry point: ModelClient.complete(),
// Does not know whether the backend is OpenAI, Anthropic, or a local simulator.
// This boundary allows tests to inject ScriptedModelClient and makes it easy for later chapters to replace providers.
// Controlled union of vendor finish reasons; retains function_call only to reject legacy protocols explicitly at adapter boundaries.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

// Function tool definitions published to the model by the registry; parameters is JSON Schema.
//
// OpenAIToolSchema corresponds to the tools parameter format of Chat Completions.
// The model learns available tools and accepted parameters through this JSON Schema.
export interface OpenAIToolSchema {
  // Current protocols publish function tools only, avoiding passing unsupported tool shapes to vendor boundaries.
  readonly type: "function";
  // Tool metadata that vendors require nested inside the function field.
  readonly function: {
    // Stable tool identifier returned during model calls; must match the name in the registry.
    readonly name: string;
    // Instructions for the model on capabilities and when to use them.
    readonly description: string;
    // JSON Schema parameter contract; core layer does not depend on concrete vendor SDK types.
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// Frozen snapshot of a single model request to prevent history or tool definitions from changing after construction.
export interface ModelRequest {
  // Immutable snapshot sent by the loop to model boundaries; optional model/budget for subsequent chapter policies.
  // messages must be paired session history; tools is a snapshot of the Tool Registry.
  // model/maxTokens allows later chapters to override default models or limit tokens per request.
  readonly messages: readonly ChatMessage[];
  // Tool descriptions frozen at the same time as messages; the model sees only capabilities callable in this turn.
  readonly tools: readonly OpenAIToolSchema[];
  // Optional per-request model override value; the adapter uses the validated default model when omitted.
  readonly model?: string;
  // Optional per-request output budget; not the turn budget for the entire Agent.
  readonly maxTokens?: number;
}

// Standardize provider usage statistics fields, preventing core logic from depending on SDK naming conventions.
export interface TokenUsage {
  // Unifies vendor usage to internal field names, avoiding core dependence on SDK snake_case.
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

// Normalized result returned to the Agent Loop by the model adapter, including message, finish reason, and optional usage.
export interface ModelReply {
  // The adapter must normalize provider replies into assistant messages and explicit finish reasons.
  // finishReason distinguishes normal completion (stop), truncation (length), and tool requests (tool_calls).
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

// The sole model dependency of the core loop; implementations handle boundary validation of networks, SDKs, and external responses.
export interface ModelClient {
  // The sole model dependency point; tests can use scripted implementations to verify per-turn requests.
  // complete() receives the full request (messages + tool definitions) and returns a normalized reply.
  // This keeps the core loop completely isolated from the SDK.
  complete(request: ModelRequest): Promise<ModelReply>;
}
