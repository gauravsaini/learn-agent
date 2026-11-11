// Composition root: selects infrastructure, tool sets, permission policies, Hooks, TODO observers, Skill catalogs, and persistent task stores by chapter capabilities.
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import { HookRegistry } from "./core/hooks.js";
import { AgentRunner } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionPolicy, PermissionRule } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import type { ToolRegistry } from "./core/tools.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";
import { CompactionManager, ModelHistorySummarizer } from "./features/compaction.js";
import { MemorySession, MemoryStore, ModelMemoryQueries } from "./features/memory.js";
import { DynamicPromptProvider, DynamicPromptRenderer } from "./features/prompting.js";
import { RecoveryManager } from "./features/recovery.js";
import type { RecoveryConfig } from "./features/recovery.js";
import { SkillRegistry } from "./features/skills.js";
import { SubagentTool } from "./features/subagents.js";
import { registerTaskTools } from "./features/tasks.js";
import type { TaskStore } from "./features/tasks.js";
import { TodoTracker } from "./features/todos.js";

// Fixed identity and behavioral baseline; serves as the starting point of the identity section in dynamic rendering, and remains the complete system prompt in non-dynamic mode.
export const BASE_SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
// TODO tracking instructions for complex tasks; applicable in both dynamic and non-dynamic modes.
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
// Skill catalog insertion prompt, used only in non-dynamic mode; handled by DynamicPromptRenderer in dynamic mode.
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// P10 uses dynamic Provider to assemble identity, tools, workspace, Skill, and memory contexts uniformly;
// P11 makes RecoveryManager the sole execution boundary for model requests; neither SDK nor loop retries independently.
// P12 requires injecting TaskStore; task tools and subagents share the same task graph rather than separate copies.
export interface BuildDependencies {
  // All external boundaries are injectable; offline tests do not need to start real processes or network clients.
  readonly model: ModelClient;
  readonly workspace: string;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly approvalProvider?: ApprovalProvider;
  readonly auditSink?: AuditSink;
  readonly hooks?: HookRegistry;
  readonly maxTurns?: number;
  // identity is only used as a dynamic Prompt context field; defaults to "user" when omitted.
  readonly identity?: string;
  // recoveryConfig only appears on P11+ capability flags, constructed explicitly by CLI or tests.
  readonly recoveryConfig?: RecoveryConfig;
  // taskStore appears only on P12+ capability flags, sharing the same persistence graph with task tools and subagents.
  readonly taskStore?: TaskStore;
}

export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  if (profileForChapter(profile.chapter) !== profile) {
    // The runtime validates profile reference equality to prevent callers from passing corrupted or dynamically constructed profiles.
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    // hooks capability is unavailable before P04; callers passing hooks must also enable the hooks capability flag.
    throw new Error("hooks require chapter 4 or later");
  }
  if (dependencies.recoveryConfig !== undefined && !profile.capabilities.has("recovery")) {
    throw new Error("recoveryConfig requires chapter 11 or later");
  }
  if (profile.capabilities.has("recovery") && dependencies.recoveryConfig === undefined) {
    // recovery capabilities and configurations must appear in pairs to prevent P11 silently degrading to raw ModelClient.
    throw new Error("recoveryConfig is required for chapter 11 or later");
  }
  if (profile.capabilities.has("task_dag_json") && dependencies.taskStore === undefined) {
    // DAG capability must not silently degrade to in-memory tasks; rejects assembly directly when persistent boundary is missing.
    throw new Error("taskStore is required for chapter 12 or later");
  }
  if (!profile.capabilities.has("task_dag_json") && dependencies.taskStore !== undefined) {
    throw new Error("taskStore requires chapter 12 or later");
  }
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const fileSystem =
    dependencies.fileSystem === undefined ? new NodeWorkspaceFileSystem() : dependencies.fileSystem;
  const standardTools = createStandardTools(profile, commandRunner, fileSystem);
  const tools = standardTools.tools;
  const todoTracker = standardTools.todoTracker;
  // identity fallback matches AgentRunner constructor defaults, ensuring the context field is never empty.
  const identity = dependencies.identity === undefined ? "user" : dependencies.identity;
  // When dynamic_prompt is enabled, DynamicPromptProvider re-renders system prompts each turn; when disabled, fall back to static strings.
  const dynamicPrompt = profile.capabilities.has("dynamic_prompt");
  // Scan once during chapter assembly; runtime load_skill still re-checks real paths.
  const skillRegistry = profile.capabilities.has("skills")
    ? SkillRegistry.scan(dependencies.workspace)
    : undefined;
  // Permission policy is decided by profile capabilities; subagents reuse the same policy and cannot bypass parent approval.
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  // The same compaction manager serves both request history and tool result boundaries.
  const compactionManager = profile.capabilities.has("compaction")
    ? new CompactionManager({
        workspace: dependencies.workspace,
        summarizer: new ModelHistorySummarizer(dependencies.model),
      })
    : undefined;
  let modelRequestExecutor: RecoveryManager | undefined;
  // Reactive compaction reuses the same CompactionManager, ensuring protocol group splitting rules match proactive compaction.
  if (dependencies.recoveryConfig !== undefined) {
    if (compactionManager === undefined) {
      throw new Error("recovery capability requires compaction");
    }
    // Recovery depends on the same compaction manager to reduce history while keeping protocol groups intact on prompt-too-long.
    modelRequestExecutor = new RecoveryManager({
      model: dependencies.model,
      compaction: compactionManager,
      config: dependencies.recoveryConfig,
    });
  }
  // When enabling dynamic prompts, disable standalone MemorySession.beforeModel() message injection; Provider outputs memory content uniformly.
  const memorySession = profile.capabilities.has("memory")
    ? createMemorySession(dependencies, !dynamicPrompt)
    : undefined;
  const hooks =
    dependencies.hooks === undefined && profile.capabilities.has("hooks")
      ? new HookRegistry()
      : dependencies.hooks;
  if (profile.capabilities.has("subagent")) {
    if (hooks === undefined || permissionPolicy === undefined) {
      throw new Error("subagent capability requires hooks and permission policy");
    }
    // Subagents are enabled in P06+, requiring hooks and permissionPolicy to form cross-Agent boundaries together.
    const subagent = new SubagentTool({
      modelFactory: () => dependencies.model,
      toolsFactory: () => {
        const childTools = createStandardTools(profile, commandRunner, fileSystem).tools;
        if (skillRegistry !== undefined) {
          // Subagents share Skill metadata snapshots, but create an independent Tool Registry each time to prevent state leaks across tasks.
          childTools.register(skillRegistry.toolDefinition);
        }
        if (dependencies.taskStore !== undefined) {
          // Subagents and the main Agent use the same TaskStore and see the same project graph.
          registerTaskTools(childTools, dependencies.taskStore);
        }
        return childTools;
      },
      hooks,
      permissionPolicy,
    });
    tools.register(subagent.toolDefinition);
  }
  if (skillRegistry !== undefined) {
    // Primary Agent registers Skill tools statically to keep the tool list order stable.
    tools.register(skillRegistry.toolDefinition);
  }
  if (dependencies.taskStore !== undefined) {
    // Primary Agent directly registers persistent task tools and shares the same TaskStore with subagents.
    registerTaskTools(tools, dependencies.taskStore);
  }
  // Assemble base system prompt; embed todo/Skill sections with legacy logic when not in dynamic mode.
  let systemPrompt =
    todoTracker === undefined ? BASE_SYSTEM_PROMPT : `${BASE_SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`;
  if (!dynamicPrompt && skillRegistry !== undefined) {
    // In non-dynamic mode, the Skill catalog is statically embedded at the end of the system prompt during build.
    const catalog = skillRegistry.renderCatalog();
    systemPrompt = `${systemPrompt}${SKILLS_SYSTEM_PROMPT}${catalog.length === 0 ? EMPTY_SKILLS_CATALOG : catalog}`;
  }
  // In dynamic mode, create the Provider to render identity, tool list, workspace, Skill catalog, and selected memory.
  const systemPromptProvider = dynamicPrompt
    ? new DynamicPromptProvider({
        renderer: new DynamicPromptRenderer(),
        identity: systemPrompt,
        tools,
        workspace: dependencies.workspace,
        context: Object.freeze({ chapter: profile.chapter, identity }),
        ...(skillRegistry === undefined ? {} : { skills: skillRegistry }),
        ...(memorySession === undefined ? {} : { memory: memorySession }),
      })
    : undefined;
  return new AgentRunner({
    // Retain fixed systemPrompt as fallback; get rendered results through render() each turn when provider exists.
    model: dependencies.model,
    tools,
    systemPrompt,
    workspace: dependencies.workspace,
    ...(systemPromptProvider === undefined ? {} : { systemPromptProvider }),
    ...(dependencies.identity === undefined ? {} : { identity }),
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(todoTracker === undefined ? {} : { toolRoundObserver: todoTracker }),
    ...(compactionManager === undefined
      ? {}
      : {
          // Request history is prepared before model calls; tool results pass through processors before backfilling into canonical history.
          historyProcessor: compactionManager,
          toolResultProcessor: async (results) =>
            (await compactionManager.compactToolResults(results)).results,
        }),
    // Memory lifecycle and request-level compaction complement each other: compaction changes past history seen by the model, while memory reads and writes persistence at turn boundaries.
    ...(memorySession === undefined ? {} : { turnLifecycle: memorySession }),
    ...(modelRequestExecutor === undefined ? {} : { modelRequestExecutor }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

function createMemorySession(
  dependencies: BuildDependencies,
  emitContextMessages: boolean,
): MemorySession {
  // When emitContextMessages is false, disable independent injection of MemorySession.beforeModel().
  const queries = new ModelMemoryQueries(dependencies.model);
  return new MemorySession({
    store: new MemoryStore({ workspace: dependencies.workspace }),
    selector: queries,
    extractor: queries,
    consolidator: queries,
    emitContextMessages,
  });
}

interface StandardTools {
  readonly tools: ToolRegistry;
  readonly todoTracker?: TodoTracker;
}

function createStandardTools(
  profile: ChapterProfile,
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
): StandardTools {
  // createStandardTools encapsulates chapter tool registration: create shell and file tools first, then append todo tools based on profile capabilities.
  const tools =
    profile.chapter === 1
      ? createChapterOneTools(commandRunner)
      : createChapterTwoTools(commandRunner, fileSystem);
  const todoTracker = profile.capabilities.has("todo") ? new TodoTracker() : undefined;
  if (todoTracker === undefined) {
    return Object.freeze({ tools });
  }
  // After registering todo tools, pass the corresponding toolRoundObserver as agentOption to provide automatic planning.
  tools.register(todoTracker.toolDefinition);
  return Object.freeze({ tools, todoTracker });
}

function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
  // permissionPolicyForProfile composes permission policies based on profile policy capabilities; subagents reuse the same policies.
  if (!profile.capabilities.has("policy")) {
    // Accept only externally injected approvalProvider when lacking policy capability; external controls manage audit and write boundaries.
    return dependencies.approvalProvider === undefined
      ? undefined
      : new PermissionPolicy({ approval: dependencies.approvalProvider });
  }
  if (dependencies.approvalProvider === undefined) {
    // When policy capability exists, provide approvalProvider as well; otherwise, disconnect the origination path completely.
    throw new Error("approvalProvider is required for chapter 3 or later");
  }
  if (dependencies.auditSink === undefined) {
    // policy capability requires auditable decision records; startup is rejected when an audit sink is missing.
    throw new Error("auditSink is required for chapter 3 or later");
  }
  return new PermissionPolicy({
    // Promote only write tools; default policy rules handle Shell execution approval.
    rules: [
      new PermissionRule({
        // File write approval rule: only write_file and edit_file trigger the confirmation dialog.
        name: "confirm-file-write",
        behavior: "ask",
        reason: "File writes require explicit approval from chapter 3 onward",
        matches: (request) => {
          const name = request.prepared.definition?.name;
          return name === "write_file" || name === "edit_file";
        },
      }),
    ],
    approval: dependencies.approvalProvider,
    audit: dependencies.auditSink,
    writeBoundary: fileSystem,
  });
}
