#!/usr/bin/env node

// CLI is the real runtime entry point: handles argument parsing, environment reading, model and persistent resource assembly, and user approval/audit boundaries.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { OpenAIChatModel } from "./adapters/openai-chat.js";
import { JsonTaskStore } from "./adapters/task-json.js";
import { JsonBackgroundJobStore } from "./adapters/background-json.js";
import { JsonCronStore } from "./adapters/cron-json.js";
import { FileMailboxStore } from "./adapters/mailbox-json.js";
import { JsonProtocolStore } from "./adapters/protocol-json.js";
import { buildAgent } from "./bootstrap.js";
import { ConfigurationError, settingsFromEnvFile, settingsFromMapping } from "./config.js";
import type { HookContext } from "./core/hooks.js";
import { HookRegistry, HookResult } from "./core/hooks.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionDecision } from "./core/permissions.js";
import type { PermissionRequest } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import { EventInbox } from "./core/events.js";
import { JobSupervisor } from "./features/background.js";
import { CronRuntime } from "./features/cron.js";
import { TeammateRuntime } from "./features/teammates.js";
import { ProtocolRuntime } from "./features/protocol.js";
import { RecoveryConfig } from "./features/recovery.js";

class TerminalApprovalProvider implements ApprovalProvider {
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const definition = request.prepared.definition;
    const proposed = request.proposedDecision;
    if (definition === undefined || proposed === undefined) {
      throw new Error("approval request is incomplete");
    }
    stderr.write(`\nTool call requires approval: ${definition.name}\n`);
    stderr.write(`Reason: ${proposed.reason}\n`);
    stderr.write(`Arguments: ${JSON.stringify(request.prepared.arguments)}\n`);
    if (!stdin.isTTY) {
      stderr.write("No interactive input, rejecting by default.\n");
      return new PermissionDecision(
        "deny",
        "No interactive approval input was available",
        "terminal-approval",
      );
    }

    const terminal = createInterface({ input: stdin, output: stderr });
    try {
      const answer = await terminal.question("Allow this call? [y/N] ");
      const normalized = answer.trim().toLowerCase();
      const allowed = normalized === "y" || normalized === "yes";
      return new PermissionDecision(
        allowed ? "allow" : "deny",
        allowed ? "User approved this tool call" : "User denied this tool call",
        "terminal-approval",
      );
    } finally {
      terminal.close();
    }
  }
}

class TerminalAuditSink implements AuditSink {
  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    const definition = request.prepared.definition;
    if (definition === undefined) {
      throw new Error("audit request is incomplete");
    }
    stderr.write(
      `[Permission] ${definition.name}: ${decision.behavior} (${decision.source}) - ${decision.reason}\n`,
    );
  }
}

interface RunArguments {
  // Final chapter number run by fixed entrypoints or generic entrypoints.
  readonly chapter: number;
  // Initial user prompt sent to the Agent Loop.
  readonly prompt: string;
}

function parseRunArguments(argv: readonly string[], fixedChapter?: number): RunArguments {
  const args = fixedChapter === undefined ? argv : ["--chapter", String(fixedChapter), ...argv];
  let chapter: number | undefined;
  let prompt: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--chapter") {
      const value = args[index + 1];
      if (value === undefined || !/^(?:[1-9]|1[0-9]|20)$/.test(value)) {
        throw new Error("--chapter must be an integer from 1 to 20");
      }
      chapter = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--prompt must not be empty");
      }
      prompt = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(arg)}`);
  }
  if (chapter === undefined || prompt === undefined) {
    throw new Error("Both --chapter and --prompt are required");
  }
  return { chapter, prompt };
}

async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // The real entry point creates resources selectively by chapter capabilities; the protocol and teammates must share the same MailboxStore.
  const workspace = resolve(process.cwd());
  const envPath = resolve(workspace, ".env");
  const requiresFallback = profile.capabilities.has("recovery");
  const settings = existsSync(envPath)
    ? settingsFromEnvFile(envPath, requiresFallback)
    : settingsFromMapping({}, requiresFallback);
  const model = new OpenAIChatModel(settings);
  const fileSystem = new NodeWorkspaceFileSystem();
  const taskStore = profile.capabilities.has("task_dag_json")
    ? new JsonTaskStore(workspace)
    : undefined;
  const backgroundSupervisor = profile.capabilities.has("background")
    ? new JobSupervisor({ store: new JsonBackgroundJobStore(workspace), inbox: new EventInbox() })
    : undefined;
  const cronRuntime = profile.capabilities.has("cron")
    ? createCronRuntime(workspace, backgroundSupervisor)
    : undefined;
  const teammateRuntime = profile.capabilities.has("teammate")
    ? createTeammateRuntime(workspace, backgroundSupervisor, cronRuntime)
    : undefined;
  // The protocol runtime reuses the teammate TeammateRuntime and registers requests in JsonProtocolStore; both share the same mailbox state.
  const protocolRuntime =
    profile.capabilities.has("protocol") && teammateRuntime !== undefined
      ? new ProtocolRuntime({
          store: new JsonProtocolStore(workspace),
          team: teammateRuntime,
        })
      : undefined;
  let runner: ReturnType<typeof buildAgent> | undefined;
  const failures: unknown[] = [];
  let exitCode: number | undefined;
  try {
    runner = buildAgent(profile, {
      model,
      workspace,
      fileSystem,
      approvalProvider: new TerminalApprovalProvider(),
      auditSink: new TerminalAuditSink(),
      ...(profile.capabilities.has("hooks") ? { hooks: liveHooks() } : {}),
      ...(requiresFallback
        ? {
            recoveryConfig: new RecoveryConfig({
              primaryModel: settings.model,
              fallbackModel: requiredFallbackModel(settings.fallbackModel),
            }),
          }
        : {}),
      ...(taskStore === undefined ? {} : { taskStore }),
      ...(backgroundSupervisor === undefined ? {} : { backgroundSupervisor }),
      ...(cronRuntime === undefined ? {} : { cronRuntime }),
      ...(teammateRuntime === undefined ? {} : { teammateRuntime }),
      // After explicitly injecting ProtocolRuntime, bootstrap verifies it shares a store with teammateRuntime to prevent split state.
      ...(protocolRuntime === undefined ? {} : { protocolRuntime }),
    });
    if (teammateRuntime !== undefined) {
      // Immediately requests an independent event turn after teammate results reach Lead mailbox.
      teammateRuntime.bindWakeup(async () => {
        if (runner === undefined) {
          throw new Error("Teammate wakeup received before AgentRunner was built");
        }
        await runner.runEvents();
      });
    }
    if (cronRuntime !== undefined) {
      cronRuntime.bindWakeup(async () => {
        if (runner === undefined) {
          throw new Error("Cron wakeup received before AgentRunner was built");
        }
        await runner.runEvents();
      });
      cronRuntime.start();
    }
    const result = await runner.run(prompt);
    stdout.write(`${result.finalText}\n`);
    exitCode = 0;
  } catch (error) {
    failures.push(error);
  }
  if (runner !== undefined) {
    try {
      await runner.close();
    } catch (error) {
      failures.push(error);
    }
  } else {
    for (const resource of [teammateRuntime, cronRuntime, backgroundSupervisor]) {
      if (resource === undefined) continue;
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  try {
    await model.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "CLI execution or cleanup failed");
  if (exitCode === undefined) throw new Error("CLI execution completed without an exit code");
  return exitCode;
}

// Cron reuses supervisor EventInbox to ensure periodic events and background tasks enter the same event stream.
function createCronRuntime(workspace: string, supervisor: JobSupervisor | undefined): CronRuntime {
  if (supervisor === undefined) {
    throw new Error("cron capability requires background supervisor");
  }
  return new CronRuntime({
    store: new JsonCronStore(workspace),
    inbox: supervisor.eventInbox,
    supervisor,
    clock: { now: () => new Date() },
  });
}

// Teammates reuse inbox/supervisor from background supervisor and cron to prevent mailbox, cron, and background tasks from handling events separately.
function createTeammateRuntime(
  workspace: string,
  supervisor: JobSupervisor | undefined,
  cronRuntime: CronRuntime | undefined,
): TeammateRuntime {
  if (supervisor === undefined || cronRuntime === undefined) {
    throw new Error("teammate capability requires background supervisor and cron runtime");
  }
  return new TeammateRuntime({
    store: new FileMailboxStore(workspace),
    inbox: supervisor.eventInbox,
    supervisor,
    cronRuntime,
  });
}

function requiredFallbackModel(fallbackModel: string | undefined): string {
  if (fallbackModel === undefined) {
    throw new ConfigurationError(["OPENAI_FALLBACK_MODEL"]);
  }
  return fallbackModel;
}

function liveHooks(): HookRegistry {
  const hooks = new HookRegistry();
  hooks.register("UserPromptSubmit", () => {
    stderr.write("[Hook] UserPromptSubmit\n");
    return new HookResult();
  });
  hooks.register("PreToolUse", (context: HookContext) => {
    stderr.write(`[Hook] PreToolUse: ${hookToolName(context)}\n`);
    return new HookResult();
  });
  hooks.register("PostToolUse", (context: HookContext) => {
    if (context.result === undefined) {
      throw new Error("PostToolUse context is incomplete");
    }
    const outcome = context.result.isError ? "error" : "ok";
    stderr.write(`[Hook] PostToolUse: ${hookToolName(context)} -> ${outcome}\n`);
    return new HookResult();
  });
  hooks.register("Stop", () => {
    stderr.write("[Hook] Stop\n");
    return new HookResult();
  });
  return hooks;
}

function hookToolName(context: HookContext): string {
  const definition = context.prepared?.definition;
  if (definition === undefined) {
    throw new Error(`${context.event} context is incomplete`);
  }
  return definition.name;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  return runWithErrorHandling(async () => {
    if (argv[0] !== "run") {
      throw new Error("Expected command: run");
    }
    const parsed = parseRunArguments(argv.slice(1));
    return await execute(profileForChapter(parsed.chapter), parsed.prompt);
  });
}

export async function runProfile(
  profile: ChapterProfile,
  argv: readonly string[],
): Promise<number> {
  return runWithErrorHandling(async () => {
    const parsed = parseRunArguments(argv, profile.chapter);
    return await execute(profile, parsed.prompt);
  });
}

async function runWithErrorHandling(run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    const label = error instanceof ConfigurationError ? "Configuration Error" : "Runtime Failure";
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: ${message}\n`);
    return error instanceof ConfigurationError ? 2 : 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
