/**
 * Assembly layer: selects P01/P02 tool set by fixed ChapterProfile and creates AgentRunner.
 * All dependencies are injectable. Offline tests do not require real models, processes, or file systems.
 * The adapters enforce workspace boundaries. This layer only composes the profile, tool set, authorizer, and max turns.
 */
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import { AgentRunner } from "./core/loop.js";
import type { ToolAuthorizer } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";

// The assembly layer selects infrastructure by chapter profile; the core loop does not depend on concrete SDKs or Node I/O implementations.
// Chapter 2 injects workspace-constrained file system capabilities onto the Chapter 1 loop.
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";

export interface BuildDependencies {
  // Replaceable dependencies allow offline tests without real models, processes, or file systems.
  readonly model: ModelClient;
  // Workspace root accessible to tools; concrete path security checks are executed by file adapters.
  readonly workspace: string;
  // Optional command process boundary; construct a real PowerShellRunner when missing.
  readonly commandRunner?: CommandRunner;
  // Optional file system boundary; constructs NodeWorkspaceFileSystem when omitted.
  readonly fileSystem?: WorkspaceFileSystem;
  // Optional side-effect approval boundary.
  readonly authorizer?: ToolAuthorizer;
  // Optional model request count limit.
  readonly maxTurns?: number;
}

// Assemble cumulative toolsets by fixed profile; reject forged profiles to prevent unauthorized chapter capability escalation.
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // Only accept fixed profiles, then select cumulative tool sets by chapter.
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
  }
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const tools =
    // P01 exposes only Shell; P02 gains file tools to prevent early leaks of chapter capabilities.
    profile.chapter === 1
      ? createChapterOneTools(commandRunner)
      : createChapterTwoTools(
          commandRunner,
          dependencies.fileSystem === undefined
            ? new NodeWorkspaceFileSystem()
            : dependencies.fileSystem,
        );
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    workspace: dependencies.workspace,
    ...(dependencies.authorizer === undefined ? {} : { authorizer: dependencies.authorizer }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}
