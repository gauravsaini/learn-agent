import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import { AgentRunner } from "./core/loop.js";
import type { ToolAuthorizer } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ChapterProfile } from "./core/profiles.js";
import { createChapterOneTools } from "./features/builtin-tools.js";

// Composition Root: responsible for assembling model adapters, command adapters, and Tool Registry into AgentRunner.
//
// The core loop depends only on interfaces like ModelClient, CommandRunner, and ToolRegistry,
// Concentrates concrete process and SDK creation here, allowing tests to inject doubles to isolate network and operating system.
// buildAgent also limits the capability profile with ChapterProfile to prevent subsequent chapter capabilities leaking into Chapter 1.
//
// Fixed system prompt is assembly configuration; the loop injects it before each turn model request.
const SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";

// The assembly layer injects chapter dependencies; the core loop does not depend directly on concrete process implementations.
export interface BuildDependencies {
  // Callers provide model boundaries; tests can inject deterministic stubs to isolate the network.
  readonly model: ModelClient;
  // AgentRunner ultimately normalizes absolute or relative working directories and passes them to tools.
  readonly workspace: string;
  // Create a real PowerShell adapter only when not injected to prevent tests from depending on processes.
  readonly commandRunner?: CommandRunner;
  // Optional human authorization boundary; execute tools directly using the chapter minimal loop when omitted.
  readonly authorizer?: ToolAuthorizer;
  // Sets a finite turn budget for the loop to prevent the model from requesting tools indefinitely.
  readonly maxTurns?: number;
}

// Composition root: assembles allowed tools, models, and execution contexts for Chapter 1 into a single loop instance.
// profile must belong to this chapter; dependencies carries infrastructure only, not business workflows.
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // Fixed chapter entrypoints reject higher-version profiles, preventing capabilities from accidentally leaking from subsequent chapters.
  if (profile.chapter !== 1) {
    throw new Error(`Chapter ${profile.chapter} has not been migrated to TypeScript yet`);
  }
  // Uses default adapter only when dependency is not injected; other dependencies pass through as-is to the core loop.
  return new AgentRunner({
    model: dependencies.model,
    tools: createChapterOneTools(
      dependencies.commandRunner === undefined
        ? new PowerShellRunner()
        : dependencies.commandRunner,
    ),
    systemPrompt: SYSTEM_PROMPT,
    workspace: dependencies.workspace,
    ...(dependencies.authorizer === undefined ? {} : { authorizer: dependencies.authorizer }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}
