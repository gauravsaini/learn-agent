// Composition root: selects infrastructure, tool sets, permission policies, Hooks, and TODO observers by chapter capabilities.
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import type { HookRegistry } from "./core/hooks.js";
import { AgentRunner } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionPolicy, PermissionRule } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";
import { TodoTracker } from "./features/todos.js";

const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";

// Hooks are assembled only in P04 and later to avoid injecting unexplained lifecycles into early tutorial snapshots.
// P05 registers TodoTracker as both tool and per-turn observer to prevent decoupling state from prompts.
export interface BuildDependencies {
  // All external boundaries are injectable; offline tests do not need to start real processes or network clients.
  readonly model: ModelClient;
  // Pass workspace to both tool context and file system boundaries as the root directory for a run.
  readonly workspace: string;
  // Use real PowerShell when not injected; tests can replace it with a controlled executor.
  readonly commandRunner?: CommandRunner;
  // Create a Node file system adapter when not injected; callers can provide in-memory implementations to isolate side effects.
  readonly fileSystem?: WorkspaceFileSystem;
  // External approval boundary handling ask decisions from P03 onward.
  readonly approvalProvider?: ApprovalProvider;
  // Audit boundary recording allow, deny, and failure outcomes from P03 onward.
  readonly auditSink?: AuditSink;
  // Injectable lifecycle extension registry from P04 onward.
  readonly hooks?: HookRegistry;
  // Overriding loop limits is used only for callers to control costs and test termination conditions.
  readonly maxTurns?: number;
}

export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // Validates that profile matches chapter first, selects toolset and permission policy by capability, and finally assembles AgentRunner.
  // Forbids forging profiles with identical chapter numbers but different capabilities, keeping tutorial snapshots fixed.
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    throw new Error("hooks require chapter 4 or later");
  }
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const fileSystem =
    dependencies.fileSystem === undefined ? new NodeWorkspaceFileSystem() : dependencies.fileSystem;
  const tools =
    profile.chapter === 1
      ? createChapterOneTools(commandRunner)
      : createChapterTwoTools(commandRunner, fileSystem);
  const todoTracker = profile.capabilities.has("todo") ? new TodoTracker() : undefined;
  // Expose planning tools and corresponding system prompts only when the profile has todo capability.
  if (todoTracker !== undefined) {
    tools.register(todoTracker.toolDefinition);
  }
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt:
      todoTracker === undefined ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`,
    workspace: dependencies.workspace,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(dependencies.hooks === undefined ? {} : { hooks: dependencies.hooks }),
    // The same tracker instance acts as both todo_write handler and per-turn observer;
    // Therefore writing plans resets stale counters, and forgetting plans injects reminders for subsequent requests.
    ...(todoTracker === undefined ? {} : { toolRoundObserver: todoTracker }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
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
  // Promote only write tools; default policy rules handle Shell execution approval.
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
