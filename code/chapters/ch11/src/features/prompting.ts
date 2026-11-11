import { resolve } from "node:path";

import type { SystemPromptProvider } from "../core/loop.js";
import { MemorySession } from "./memory.js";
import { SkillRegistry } from "./skills.js";
import { ToolRegistry } from "../core/tools.js";

// P10 dynamic system prompt rendering: sources provide identity, tools, workspace, Skill, and memory in fixed order.

// JSON types allow only stably serializable values; objects such as functions, symbols, and Date do not enter Prompt.
export type JsonScalar = boolean | number | string | null;
export interface JsonObject {
  // Allows only string keys; values are constrained recursively by JsonValue to ensure stable serialization.
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonScalar | readonly JsonValue[] | JsonObject;

export class PromptContextError extends Error {
  // The dynamic prompt only accepts stably serializable JSON context; reject functions, prototype objects, and circular references.
  override readonly name: string = "PromptContextError";
}

export interface DynamicPromptRendererOptions {
  // Identity text visible to Prompt; trims and rejects empty values before rendering.
  readonly identity: string;
  // Tool name snapshots determine tools sections and cache keys.
  readonly tools: ToolRegistry;
  // Normalized absolute workspace path, allowing the model to understand the current operation boundary.
  readonly workspace: string;
  // Additional structured context; must not contain functions, circular references, or non-finite numbers.
  readonly context: JsonObject;
  // Optional Skill summary source; SkillRegistry still loads full text on demand.
  readonly skills?: SkillRegistry;
  // Optional memory session that reads only memories selected for the current turn.
  readonly memory?: MemorySession;
}

export class DynamicPromptRenderer {
  // The cache key covers all model-visible inputs; any tool, memory, or Skill change invalidates it.
  // Stable JSON key for the previous complete input; data from different sections does not falsely hit the cache.
  #lastKey: string | undefined;
  // Final prompt text corresponding to #lastKey.
  #lastPrompt: string | undefined;
  // Used only to observe cache reuse count; does not affect rendering results.
  #cacheHits = 0;

  // Cache hit counts are used for tests and observability, proving identical inputs do not reassemble strings.
  get cacheHits(): number {
    return this.#cacheHits;
  }

  // render is the only entry point: validate object type, normalize context, generate cache keys, and output ordered sections.
  render(options: DynamicPromptRendererOptions): string {
    const identity = normalizeIdentity(options.identity);
    if (!(options.tools instanceof ToolRegistry)) {
      throw new TypeError("tools must be ToolRegistry");
    }
    if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.skills !== undefined && !(options.skills instanceof SkillRegistry)) {
      throw new TypeError("skills must be SkillRegistry or undefined");
    }
    if (options.memory !== undefined && !(options.memory instanceof MemorySession)) {
      throw new TypeError("memory must be MemorySession or undefined");
    }

    // context is normalized to JSON first; subsequent cache keys and display text use the same normalized value.
    const context = normalizeContext(options.context);
    const contextJson = stableJson(context);
    const tools = options.tools.names;
    const workspace = resolve(options.workspace);
    // Skill catalog and selected memories are read on demand; respective modules retain full text, fetching only summaries needed for rendering here.
    const skillCatalog = options.skills === undefined ? "" : options.skills.renderCatalog();
    const memoryBody =
      options.memory === undefined || options.memory.selected.length === 0
        ? ""
        : options.memory.renderSelected();
    // The cache key covers all model-visible inputs; any runtime state change invalidates it.
    const key = stableJson({
      context,
      identity,
      memory: memoryBody,
      skills: skillCatalog,
      tools: [...tools],
      workspace,
    });
    if (key === this.#lastKey && this.#lastPrompt !== undefined) {
      this.#cacheHits += 1;
      return this.#lastPrompt;
    }

    // Output "(none)" even when tool lists are empty, letting models know clearly that no tools are currently available.
    const toolCatalog = tools.length === 0 ? "(none)" : tools.map((name) => `- ${name}`).join("\n");
    const sections = [
      // Fixed section order keeps prompts predictable; subsequent optional sections only append without interleaving.
      `## identity\n${identity}\ncontext: ${contextJson}`,
      `## tools\n${toolCatalog}`,
      `## workspace\n${workspace}`,
    ];
    if (skillCatalog.length > 0) {
      sections.push(`## skills\n${skillCatalog}`);
    }
    if (memoryBody.length > 0) {
      sections.push(`## memory\n${memoryBody}`);
    }
    // Fixed section order is a contract; append optional sections only to the end without changing relative positions of earlier content.
    const prompt = sections.join("\n\n");
    this.#lastKey = key;
    this.#lastPrompt = prompt;
    return prompt;
  }
}

export interface DynamicPromptProviderOptions extends DynamicPromptRendererOptions {
  // Provider reuses caching and normalization logic of this renderer.
  readonly renderer: DynamicPromptRenderer;
}

// Provider exposes zero-argument render() to AgentRunner, confining renderer and runtime object binding to the composition root.
export class DynamicPromptProvider implements SystemPromptProvider {
  // Provider re-renders on each request turn, reading current tools, Skill, and selected memories.
  readonly #renderer: DynamicPromptRenderer;
  readonly #identity: string;
  readonly #tools: ToolRegistry;
  readonly #workspace: string;
  readonly #context: JsonObject;
  readonly #skills: SkillRegistry | undefined;
  readonly #memory: MemorySession | undefined;

  constructor(options: DynamicPromptProviderOptions) {
    if (!(options.renderer instanceof DynamicPromptRenderer)) {
      throw new TypeError("renderer must be DynamicPromptRenderer");
    }
    // Provider binds runtime objects during construction; subsequent render() only forwards and does not rediscover dependencies.
    this.#renderer = options.renderer;
    this.#identity = options.identity;
    this.#tools = options.tools;
    this.#workspace = options.workspace;
    this.#context = options.context;
    this.#skills = options.skills;
    this.#memory = options.memory;
  }

  render(): string {
    return this.#renderer.render({
      identity: this.#identity,
      tools: this.#tools,
      workspace: this.#workspace,
      context: this.#context,
      ...(this.#skills === undefined ? {} : { skills: this.#skills }),
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
    });
  }
}

function normalizeIdentity(identity: string): string {
  // identity is a Prompt-visible input; empty strings fail before entering the cache.
  if (typeof identity !== "string") {
    throw new TypeError("identity must be a string");
  }
  const normalized = identity.trim();
  if (normalized.length === 0) {
    throw new Error("identity must not be empty");
  }
  return normalized;
}

function normalizeContext(context: unknown): JsonObject {
  // context must be a plain JSON object; reject non-object types immediately.
  if (!isPlainObject(context)) {
    throw new PromptContextError("context must be a JSON object");
  }
  const normalized = normalizeJsonValue(context, new Set<object>());
  if (!isPlainObject(normalized)) {
    throw new PromptContextError("context must be a JSON object");
  }
  return normalized;
}

// Recursively normalizes all nested values: Rejects NaN, infinity, symbol keys, non-plain objects, and circular references.
function normalizeJsonValue(value: unknown, active: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PromptContextError("context contains a non-finite JSON number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    // The active set stores objects on the current recursive path to detect circular references.
    if (active.has(value)) {
      throw new PromptContextError("context contains a cyclic JSON array");
    }
    active.add(value);
    try {
      return Object.freeze(value.map((item) => normalizeJsonValue(item, active)));
    } finally {
      active.delete(value);
    }
  }
  if (isPlainObject(value)) {
    // Only accept string keys; construct object keys after sorting to keep cache and display inputs stable.
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new PromptContextError("context JSON object keys must be strings");
    }
    if (active.has(value)) {
      throw new PromptContextError("context contains a cyclic JSON object");
    }
    active.add(value);
    try {
      const normalized: Record<string, JsonValue> = {};
      for (const key of Object.keys(value).sort(compareText)) {
        Object.defineProperty(normalized, key, {
          configurable: false,
          enumerable: true,
          value: normalizeJsonValue(value[key], active),
          writable: false,
        });
      }
      return Object.freeze(normalized);
    } finally {
      active.delete(value);
    }
  }
  throw new PromptContextError("context contains an unsupported JSON value");
}

// Plain objects refer to objects whose prototype is Object.prototype; class instances, Maps, and Sets are not accepted as JSON objects.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// Recursively serialize canonical JSON sorted by key to ensure semantically identical contexts always generate the same cache key.
function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Simple string sorting stabilizes object keys, avoiding reliance on engine default enumeration order.
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
