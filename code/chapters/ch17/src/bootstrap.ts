// Composition root: selects infrastructure, tool sets, permission policies, Hooks, TODO, Skills, background/Cron/teammate/protocol runtimes by chapter capabilities; P17 appends SQLite Task Claims and work-stealing shared dependencies.
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import { HookRegistry } from "./core/hooks.js";
import { AgentRunner } from "./core/loop.js";
import type { AsyncResource, ToolDispatcher } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionPolicy, PermissionRule } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import type { ToolRegistry } from "./core/tools.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";
import {
  BackgroundDispatcher,
  registerBackgroundJobTools,
  type JobSupervisor,
} from "./features/background.js";
import type { CronRuntime } from "./features/cron.js";
import type { TeammateRuntime } from "./features/teammates.js";
import type { ProtocolRuntime } from "./features/protocol.js";
import { CompactionManager, ModelHistorySummarizer } from "./features/compaction.js";
import { MemorySession, MemoryStore, ModelMemoryQueries } from "./features/memory.js";
import { DynamicPromptProvider, DynamicPromptRenderer } from "./features/prompting.js";
import { RecoveryManager } from "./features/recovery.js";
import type { RecoveryConfig } from "./features/recovery.js";
import { SkillRegistry } from "./features/skills.js";
import { SubagentTool } from "./features/subagents.js";
import { registerTaskTools } from "./features/tasks.js";
import type { TaskStore } from "./features/tasks.js";
import {
  registerLeasedTaskTools,
  registerTeammateLeasedTaskTools,
} from "./features/work-stealing.js";
import type { WorkStealingRuntime } from "./features/work-stealing.js";
import { TodoTracker } from "./features/todos.js";

export const BASE_SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// P17 injects independent SQLite claim service; Lead, subagents, and teammates share the same claim path.
export interface BuildDependencies {
  // Inject external dependencies explicitly by capability; P17 does not allow injecting legacy JSON taskStore and SQLite runtime simultaneously.
  readonly model: ModelClient;
  readonly workspace: string;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly approvalProvider?: ApprovalProvider;
  readonly auditSink?: AuditSink;
  readonly hooks?: HookRegistry;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly recoveryConfig?: RecoveryConfig;
  readonly taskStore?: TaskStore;
  readonly workStealingRuntime?: WorkStealingRuntime;
  readonly backgroundSupervisor?: JobSupervisor;
  readonly cronRuntime?: CronRuntime;
  readonly teammateRuntime?: TeammateRuntime;
  readonly protocolRuntime?: ProtocolRuntime;
}

export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // Validates profile and dependency matrix first before creating any Runner, preventing configuration errors from leaving half-initialized background resources.
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    throw new Error("hooks require chapter 4 or later");
  }
  if (dependencies.recoveryConfig !== undefined && !profile.capabilities.has("recovery")) {
    throw new Error("recoveryConfig requires chapter 11 or later");
  }
  if (profile.capabilities.has("recovery") && dependencies.recoveryConfig === undefined) {
    throw new Error("recoveryConfig is required for chapter 11 or later");
  }
  const usesJsonTaskStore =
    profile.capabilities.has("task_dag_json") && !profile.capabilities.has("task_dag_sqlite");
  if (usesJsonTaskStore && dependencies.taskStore === undefined) {
    throw new Error("taskStore is required for chapter 12 or later");
  }
  if (!usesJsonTaskStore && dependencies.taskStore !== undefined) {
    throw new Error("taskStore requires chapter 12 or later");
  }
  if (
    profile.capabilities.has("task_dag_sqlite") &&
    dependencies.workStealingRuntime === undefined
  ) {
    throw new Error("workStealingRuntime is required for chapter 17 or later");
  }
  if (
    !profile.capabilities.has("task_dag_sqlite") &&
    dependencies.workStealingRuntime !== undefined
  ) {
    throw new Error("workStealingRuntime requires chapter 17 or later");
  }
  if (profile.capabilities.has("background") && dependencies.backgroundSupervisor === undefined) {
    throw new Error("backgroundSupervisor is required for chapter 13 or later");
  }
  if (!profile.capabilities.has("background") && dependencies.backgroundSupervisor !== undefined) {
    throw new Error("backgroundSupervisor requires chapter 13 or later");
  }
  if (profile.capabilities.has("cron") && dependencies.cronRuntime === undefined) {
    throw new Error("cronRuntime is required for chapter 14 or later");
  }
  if (!profile.capabilities.has("cron") && dependencies.cronRuntime !== undefined) {
    throw new Error("cronRuntime requires chapter 14 or later");
  }
  if (
    dependencies.cronRuntime !== undefined &&
    (dependencies.backgroundSupervisor === undefined ||
      dependencies.cronRuntime.supervisor !== dependencies.backgroundSupervisor ||
      dependencies.cronRuntime.eventInbox !== dependencies.backgroundSupervisor.eventInbox)
  ) {
    throw new Error("cronRuntime must share the background supervisor and event inbox");
  }
  if (profile.capabilities.has("teammate") && dependencies.teammateRuntime === undefined) {
    throw new Error("teammateRuntime is required for chapter 15 or later");
  }
  if (!profile.capabilities.has("teammate") && dependencies.teammateRuntime !== undefined) {
    throw new Error("teammateRuntime requires chapter 15 or later");
  }
  // P16 protocol capability requires explicit ProtocolRuntime injection; earlier chapters cannot inadvertently include protocol dependencies.
  if (profile.capabilities.has("protocol") && dependencies.protocolRuntime === undefined) {
    throw new Error("protocolRuntime is required for chapter 16 or later");
  }
  if (!profile.capabilities.has("protocol") && dependencies.protocolRuntime !== undefined) {
    throw new Error("protocolRuntime requires chapter 16 or later");
  }
  // The protocol and teammates must share the same TeammateRuntime and MailboxStore, or requests and deliveries write to different states.
  if (
    dependencies.protocolRuntime !== undefined &&
    (dependencies.teammateRuntime === undefined ||
      dependencies.protocolRuntime.teamRuntime !== dependencies.teammateRuntime ||
      dependencies.protocolRuntime.mailboxStore !== dependencies.teammateRuntime.mailboxStore)
  ) {
    throw new Error("protocolRuntime must share the teammate runtime and mailbox store");
  }
  if (
    dependencies.teammateRuntime !== undefined &&
    (dependencies.backgroundSupervisor === undefined ||
      dependencies.cronRuntime === undefined ||
      dependencies.teammateRuntime.supervisor !== dependencies.backgroundSupervisor ||
      dependencies.teammateRuntime.eventInbox !== dependencies.backgroundSupervisor.eventInbox ||
      dependencies.teammateRuntime.cronRuntime !== dependencies.cronRuntime)
  ) {
    throw new Error(
      "teammateRuntime must share the background supervisor, EventInbox, and CronRuntime",
    );
  }
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const fileSystem =
    dependencies.fileSystem === undefined ? new NodeWorkspaceFileSystem() : dependencies.fileSystem;
  const standardTools = createStandardTools(
    profile,
    commandRunner,
    fileSystem,
    profile.capabilities.has("background"),
  );
  const tools = standardTools.tools;
  const todoTracker = standardTools.todoTracker;
  const identity = dependencies.identity === undefined ? "user" : dependencies.identity;
  const dynamicPrompt = profile.capabilities.has("dynamic_prompt");
  const skillRegistry = profile.capabilities.has("skills")
    ? SkillRegistry.scan(dependencies.workspace)
    : undefined;
  const basePermissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  const permissionPolicy = basePermissionPolicy;
  // plan gate only appends to teammate permission policies; Lead retains the original policy to avoid blocking Lead tools.
  const teammatePermissionPolicy =
    dependencies.protocolRuntime === undefined || basePermissionPolicy === undefined
      ? basePermissionPolicy
      : basePermissionPolicy.withRules([dependencies.protocolRuntime.planGateRule]);
  const compactionManager = profile.capabilities.has("compaction")
    ? new CompactionManager({
        workspace: dependencies.workspace,
        summarizer: new ModelHistorySummarizer(dependencies.model),
      })
    : undefined;
  let modelRequestExecutor: RecoveryManager | undefined;
  if (dependencies.recoveryConfig !== undefined) {
    if (compactionManager === undefined) {
      throw new Error("recovery capability requires compaction");
    }
    modelRequestExecutor = new RecoveryManager({
      model: dependencies.model,
      compaction: compactionManager,
      config: dependencies.recoveryConfig,
    });
  }
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
    // Subagents (one-off Subagents) share the full five-tool suite of the Lead, including create_task.
    const subagent = new SubagentTool({
      modelFactory: () => dependencies.model,
      toolsFactory: () => {
        const childTools = createStandardTools(profile, commandRunner, fileSystem, false).tools;
        if (skillRegistry !== undefined) {
          childTools.register(skillRegistry.toolDefinition);
        }
        if (usesJsonTaskStore && dependencies.taskStore !== undefined) {
          registerTaskTools(childTools, dependencies.taskStore);
        }
        if (dependencies.workStealingRuntime !== undefined) {
          registerLeasedTaskTools(
            childTools,
            dependencies.workStealingRuntime.store,
            dependencies.workStealingRuntime.claimService,
          );
        }
        return childTools;
      },
      hooks,
      permissionPolicy,
    });
    tools.register(subagent.toolDefinition);
  }
  if (skillRegistry !== undefined) {
    tools.register(skillRegistry.toolDefinition);
  }
  if (dependencies.taskStore !== undefined) {
    registerTaskTools(tools, dependencies.taskStore);
  }
  if (dependencies.workStealingRuntime !== undefined) {
    // Lead registers all five tools including create_task. Teammate registers the version without create_task inside factory.
    registerLeasedTaskTools(
      tools,
      dependencies.workStealingRuntime.store,
      dependencies.workStealingRuntime.claimService,
    );
  }
  if (dependencies.backgroundSupervisor !== undefined) {
    // Primary Agent registers background query and cancellation tools; subagents receive no background Supervisor, so do not expose these capabilities.
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
  if (dependencies.cronRuntime !== undefined) {
    tools.register(dependencies.cronRuntime.toolDefinition);
  }
  // Register Lead protocol tools and bind ProtocolRuntime to TeammateRuntime before startup.
  if (dependencies.teammateRuntime !== undefined) {
    tools.register(dependencies.teammateRuntime.spawnToolDefinition);
    tools.register(dependencies.teammateRuntime.sendToolDefinition);
    if (dependencies.protocolRuntime !== undefined) {
      // Lead receives request_shutdown/review_plan; submit_plan registers only to teammate factory.
      const [requestShutdownTool, reviewPlanTool] =
        dependencies.protocolRuntime.leadToolDefinitions;
      tools.register(requestShutdownTool);
      tools.register(reviewPlanTool);
      // configureProtocol validates shared dependencies to ensure protocol messages route back to the same MailboxStore.
      dependencies.teammateRuntime.configureProtocol(dependencies.protocolRuntime);
    }
    if (dependencies.workStealingRuntime !== undefined) {
      dependencies.teammateRuntime.configureWorkStealing(dependencies.workStealingRuntime);
    }
    // The persistent Teammate factory only registers get_task, list_tasks, claim_task, and complete_task; it does not expose create_task.
    const teammateRuntime = dependencies.teammateRuntime;
    teammateRuntime.configureRunnerFactory((name, role, sendDefinition) => {
      const teammateTools = standardTools.tools.subset(["shell", "read_file", "write_file"]);
      teammateTools.register(sendDefinition);
      if (dependencies.protocolRuntime !== undefined) {
        // Teammates only have one extra submit_plan, and cannot obtain Lead approval or shutdown tools.
        teammateTools.register(dependencies.protocolRuntime.submitPlanToolDefinition);
      }
      if (dependencies.workStealingRuntime !== undefined) {
        // Persistent Teammate tool set: shell, read_file, write_file + submit_plan + four worker tools.
        registerTeammateLeasedTaskTools(
          teammateTools,
          dependencies.workStealingRuntime.store,
          dependencies.workStealingRuntime.claimService,
        );
      }
      const teammateCompaction = new CompactionManager({
        workspace: dependencies.workspace,
        summarizer: new ModelHistorySummarizer(dependencies.model),
      });
      const teammateRecovery =
        dependencies.recoveryConfig === undefined
          ? undefined
          : new RecoveryManager({
              model: dependencies.model,
              compaction: teammateCompaction,
              config: dependencies.recoveryConfig,
            });
      return new AgentRunner({
        model: dependencies.model,
        tools: teammateTools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: dependencies.workspace,
        identity: name,
        ...(teammatePermissionPolicy === undefined
          ? {}
          : { permissionPolicy: teammatePermissionPolicy }),
        ...(hooks === undefined ? {} : { hooks }),
        historyProcessor: teammateCompaction,
        toolResultProcessor: async (results) =>
          (await teammateCompaction.compactToolResults(results)).results,
        ...(teammateRecovery === undefined ? {} : { modelRequestExecutor: teammateRecovery }),
        ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
      });
    });
  }
  const toolDispatcher: ToolDispatcher | undefined =
    dependencies.backgroundSupervisor === undefined
      ? undefined
      : new BackgroundDispatcher(tools, dependencies.backgroundSupervisor);
  let systemPrompt =
    todoTracker === undefined ? BASE_SYSTEM_PROMPT : `${BASE_SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`;
  if (!dynamicPrompt && skillRegistry !== undefined) {
    const catalog = skillRegistry.renderCatalog();
    systemPrompt = `${systemPrompt}${SKILLS_SYSTEM_PROMPT}${catalog.length === 0 ? EMPTY_SKILLS_CATALOG : catalog}`;
  }
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
  const eventPump =
    dependencies.teammateRuntime ?? dependencies.cronRuntime ?? dependencies.backgroundSupervisor;
  const resources: readonly AsyncResource[] = Object.freeze([
    ...(dependencies.backgroundSupervisor === undefined ? [] : [dependencies.backgroundSupervisor]),
    ...(dependencies.cronRuntime === undefined ? [] : [dependencies.cronRuntime]),
    ...(dependencies.teammateRuntime === undefined ? [] : [dependencies.teammateRuntime]),
  ]);
  return new AgentRunner({
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
          historyProcessor: compactionManager,
          toolResultProcessor: async (results) =>
            (await compactionManager.compactToolResults(results)).results,
        }),
    ...(memorySession === undefined ? {} : { turnLifecycle: memorySession }),
    ...(modelRequestExecutor === undefined ? {} : { modelRequestExecutor }),
    ...(toolDispatcher === undefined ? {} : { toolDispatcher }),
    ...(eventPump === undefined ? {} : { eventPump }),
    ...(resources.length === 0 ? {} : { resources }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

function createMemorySession(
  dependencies: BuildDependencies,
  emitContextMessages: boolean,
): MemorySession {
  // The same model query object handles selection, extraction, and merging, while MemoryStore binds to the current workspace.
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
  // Return base tools together with optional TODO observers to ensure parent and child Runners use the same registration path.
  readonly tools: ToolRegistry;
  readonly todoTracker?: TodoTracker;
}

function createStandardTools(
  profile: ChapterProfile,
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
  background: boolean,
): StandardTools {
  // The first two chapter tool sets are the cumulative baseline; append TODO capabilities only after declaration in the profile.
  const tools =
    profile.chapter === 1
      ? createChapterOneTools(commandRunner, background)
      : createChapterTwoTools(commandRunner, fileSystem, background);
  const todoTracker = profile.capabilities.has("todo") ? new TodoTracker() : undefined;
  if (todoTracker === undefined) {
    return Object.freeze({ tools });
  }
  tools.register(todoTracker.toolDefinition);
  return Object.freeze({ tools, todoTracker });
}

function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
  // Injecting only an authorizer is allowed before P03; from P03 onward, approval, audit, and write-path boundaries are all required.
  if (!profile.capabilities.has("policy")) {
    return dependencies.approvalProvider === undefined
      ? undefined
      : new PermissionPolicy({ approval: dependencies.approvalProvider });
  }
  if (dependencies.approvalProvider === undefined) {
    throw new Error("approvalProvider is required for chapter 3 or later");
  }
  if (dependencies.auditSink === undefined) {
    throw new Error("auditSink is required for chapter 3 or later");
  }
  return new PermissionPolicy({
    rules: [
      new PermissionRule({
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
