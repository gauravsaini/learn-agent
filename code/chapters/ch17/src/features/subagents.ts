// One-off subagent: creates an isolated AgentRunner through the task tool, returns only the final conclusion, and forbids recursive task registration by subagents.
// Chapter 6 introduces subagent capability: the task tool delegates self-contained tasks to isolated AgentRunners.
import { z } from "zod";

import { HookRegistry } from "../core/hooks.js";
import { AgentLimitError, AgentRunner } from "../core/loop.js";
import type { ModelClient } from "../core/model.js";
import { PermissionPolicy } from "../core/permissions.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { ToolRegistry, toolError, toolSuccess } from "../core/tools.js";

export const TASK_TOOL_NAME = "task";
// Default 30-turn limit: Subagents perform only limited delegation to avoid synchronous calls dragging down parent loops.
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
// Fixed duty prompt for subagents; defines single-task and no-further-delegation execution boundaries.
export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  "You are a focused coding subagent working in the current workspace. " +
  "Complete only the delegated task, then return a concise, evidence-based final conclusion. " +
  "Do not delegate further.";

// Subagents receive only self-contained tasks and return final conclusions instead of intermediate history through independent runners.
const taskInputSchema = z
  .object({
    description: z
      .string()
      .transform((description) => description.trim())
      .pipe(z.string().min(1))
      .describe("A self-contained task for the subagent to complete."),
  })
  .strict();

// Sanitized delegation descriptions; parent Agents permit passing only this single field to child runners.
export type TaskInput = Readonly<z.output<typeof taskInputSchema>>;
// Each task call must create an independent model to avoid reusing context or response queues across subtasks.
export type ModelClientFactory = () => ModelClient;
// Each task call must create an independent Tool Registry to prevent subtasks from retaining tool state.
export type ToolRegistryFactory = () => ToolRegistry;

// Factory signatures allow callers to lazily create independent model and tool instances for each delegation.
export interface SubagentToolOptions {
  // Use factories instead of instances to ensure each subtask has its own model and registry.
  readonly modelFactory: ModelClientFactory;
  readonly toolsFactory: ToolRegistryFactory;
  // Hooks and policies share controlled boundaries so subagents cannot bypass parent governance.
  readonly hooks: HookRegistry;
  readonly permissionPolicy: PermissionPolicy;
  // Subagent role prompts can be overridden, but empty prompts are rejected.
  readonly systemPrompt?: string;
  // Only allows tightening the default ceiling to prevent callers from inflating single delegation costs.
  readonly maxTurns?: number;
}

// task is an external tool callable by parent Agents, establishing and encapsulating an isolated child execution.
export class SubagentTool {
  // Factories create isolated dependencies on each delegation; tool states of parent agents are not shared or overwritten by subagents.
  readonly #modelFactory: ModelClientFactory;
  readonly #toolsFactory: ToolRegistryFactory;
  readonly #hooks: HookRegistry;
  readonly #permissionPolicy: PermissionPolicy;
  readonly #systemPrompt: string;
  readonly #maxTurns: number;
  readonly toolDefinition: ToolDefinition<TaskInput>;

  constructor(options: SubagentToolOptions) {
    if (typeof options.modelFactory !== "function") {
      throw new TypeError("modelFactory must be callable");
    }
    if (typeof options.toolsFactory !== "function") {
      throw new TypeError("toolsFactory must be callable");
    }
    if (!(options.hooks instanceof HookRegistry)) {
      throw new TypeError("hooks must be HookRegistry");
    }
    if (!(options.permissionPolicy instanceof PermissionPolicy)) {
      throw new TypeError("permissionPolicy must be PermissionPolicy");
    }
    const systemPrompt =
      options.systemPrompt === undefined ? DEFAULT_SUBAGENT_SYSTEM_PROMPT : options.systemPrompt;
    if (systemPrompt.trim().length === 0) {
      throw new Error("systemPrompt must not be empty");
    }
    const maxTurns = options.maxTurns === undefined ? DEFAULT_SUBAGENT_MAX_TURNS : options.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error("maxTurns must be a positive integer");
    }
    if (maxTurns > DEFAULT_SUBAGENT_MAX_TURNS) {
      throw new Error("maxTurns must be at most 30");
    }

    this.#modelFactory = options.modelFactory;
    this.#toolsFactory = options.toolsFactory;
    this.#hooks = options.hooks;
    this.#permissionPolicy = options.permissionPolicy;
    this.#systemPrompt = systemPrompt;
    this.#maxTurns = maxTurns;
    this.toolDefinition = Object.freeze({
      name: TASK_TOOL_NAME,
      description: "Launch an isolated subagent and return only its final conclusion.",
      inputSchema: taskInputSchema,
      effect: "external",
      handler: (input: TaskInput, context: ToolContext) => this.#runTask(input, context),
    });
  }

  // Pass verified descriptions to new runners; convert all internal exceptions here into safely returnable tool errors.
  async #runTask(input: TaskInput, context: ToolContext): Promise<ToolResult> {
    // Subagents execute in independent AgentRunners; parent history, TODO state, and tool results do not flow back.
    try {
      const tools: unknown = this.#toolsFactory();
      if (!(tools instanceof ToolRegistry)) {
        return toolError(
          "subagent_configuration_error",
          "Subagent tools factory must return ToolRegistry",
        );
      }
      if (tools.names.includes(TASK_TOOL_NAME)) {
        // Forbids subagents from registering task again, preventing unbounded recursive delegation.
        return toolError("subagent_configuration_error", "Subagent tools must not include task");
      }

      const model: unknown = this.#modelFactory();
      if (!isModelClient(model)) {
        return toolError(
          "subagent_configuration_error",
          "Subagent model factory must return ModelClient",
        );
      }

      // The new Runner only inherits execution boundaries. Parent history and other subtask histories do not pass in.
      const runner = new AgentRunner({
        model,
        tools,
        systemPrompt: this.#systemPrompt,
        workspace: context.workspace,
        identity: context.identity,
        maxTurns: this.#maxTurns,
        hooks: this.#hooks,
        permissionPolicy: this.#permissionPolicy,
      });
      const result = await runner.run(input.description);
      // Returns only final conclusion as tool result; internal reasoning and tool history stay within sub-execution boundary.
      return toolSuccess(result.finalText);
    } catch (error) {
      if (error instanceof AgentLimitError) {
        return toolError(
          "subagent_turn_limit",
          `Subagent exceeded max_turns=${this.#maxTurns} without a final answer`,
        );
      }
      // task handler is a child execution boundary; it does not leak internal exception text to the parent model.
      return toolError("subagent_execution_error", "Subagent execution failed");
    }
  }
}

// Validates factory result with minimal runtime shape to prevent misconfigurations from producing ambiguous exceptions after reaching AgentRunner.
function isModelClient(value: unknown): value is ModelClient {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "complete") === "function"
  );
}
