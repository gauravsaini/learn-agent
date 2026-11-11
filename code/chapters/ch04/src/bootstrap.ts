// Composition root: selects infrastructure, tool sets, permission policies, and Hook lifecycles by chapter capabilities.
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

// Hooks are assembled only in P04 and later to avoid injecting unexplained lifecycles into early tutorial snapshots.
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";

export interface BuildDependencies {
  // All external boundaries are injectable; offline tests do not need to start real processes or network clients.
  readonly model: ModelClient;
  // Workspace root shared by command, file, and Hook contexts.
  readonly workspace: string;
  // Replaceable command execution boundary.
  readonly commandRunner?: CommandRunner;
  // Replaceable file system boundary, also used for write path safety validation.
  readonly fileSystem?: WorkspaceFileSystem;
  // Ask decision convergence boundary for P03+.
  readonly approvalProvider?: ApprovalProvider;
  // Final decision audit boundary for P03+.
  readonly auditSink?: AuditSink;
  // Optional Hook queue for P04; earlier profiles explicitly reject it.
  readonly hooks?: HookRegistry;
  // Optional model turn limit.
  readonly maxTurns?: number;
}

// Accumulate capabilities by fixed profile, rejecting forged profiles and unauthorized hook injections.
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
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    workspace: dependencies.workspace,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(dependencies.hooks === undefined ? {} : { hooks: dependencies.hooks }),
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
