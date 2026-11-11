// Composition root: selects infrastructure, tool sets, and permission policies by chapter capabilities.
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import { AgentRunner } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionPolicy, PermissionRule } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";

// Chapter 3 connects permission policies to the existing loop; write operations and Shell executions both require approval.
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";

export interface BuildDependencies {
  // All external boundaries are injectable; offline tests do not need to start real processes or network clients.
  readonly model: ModelClient;
  // Workspace root shared by command and file tools.
  readonly workspace: string;
  // Replaceable command execution boundary.
  readonly commandRunner?: CommandRunner;
  // Replaceable file system boundary, also used for write path safety validation.
  readonly fileSystem?: WorkspaceFileSystem;
  // Required ask decision convergence boundary for P03 and later.
  readonly approvalProvider?: ApprovalProvider;
  // Required final decision audit boundary for P03 and later.
  readonly auditSink?: AuditSink;
  // Optional model turn limit.
  readonly maxTurns?: number;
}

// Combine cumulative tools and permission policies by fixed chapter profiles, rejecting forged profiles with identical names.
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // Callers cannot forge profiles with identical chapter numbers but different capabilities, keeping tutorial snapshots fixed.
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
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
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

// Builds full policy for chapters with policy capabilities; legacy profiles preserve the direct execution path of previous chapters.
function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
  // Approval and audit are required dependencies from P03 onward; earlier profiles maintain policy-free execution.
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
          // Promote only write tools; default policy rules handle Shell execution approval.
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
