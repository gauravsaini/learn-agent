#!/usr/bin/env node

// CLI is the real runtime entry point: handles argument parsing, environment reading, model and persistent resource assembly, user approval/audit boundaries, and execution/cleanup error normalization.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { SubprocessGitRunner } from "./adapters/git.js";
import { StdioMcpConnectionFactory } from "./adapters/mcp-client.js";
import { AjvMcpSchemaValidator } from "./adapters/mcp-schema.js";
import { OpenAIChatModel } from "./adapters/openai-chat.js";
import { JsonTaskStore } from "./adapters/task-json.js";
import { SqliteTaskStore } from "./adapters/task-sqlite.js";
import { JsonBackgroundJobStore } from "./adapters/background-json.js";
import { JsonCronStore } from "./adapters/cron-json.js";
import { FileMailboxStore } from "./adapters/mailbox-json.js";
import { JsonProtocolStore } from "./adapters/protocol-json.js";
import { buildAgent } from "./bootstrap.js";
import type { BuildDependencies } from "./bootstrap.js";
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
import { WorkStealingRuntime } from "./features/work-stealing.js";
import { WorktreeRuntime } from "./features/worktrees.js";
import { McpRuntime, McpServerSpec, McpToolPolicy } from "./features/mcp-tools.js";

const require = createRequire(import.meta.url);

// Terminal approval is implemented at the real interactive entry; non-TTY defaults to deny to prevent automatically allowing tools when unattended.
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

// Terminal audit writes permission decisions to stderr, retaining minimal traceable records for real runs.
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
  readonly chapter: number;
  readonly prompt: string;
}

// LiveRuntime records runtimes that execute must close as fallback; released by Runner after buildAgent succeeds.
interface LiveRuntime {
  // After buildAgent succeeds, dependencies.resources takes over these objects; on failure, execute closes them via explicit fields as a fallback.
  readonly model: OpenAIChatModel;
  readonly dependencies: BuildDependencies;
  readonly worktreeRuntime?: WorktreeRuntime;
  readonly backgroundSupervisor?: JobSupervisor;
  readonly cronRuntime?: CronRuntime;
  readonly teammateRuntime?: TeammateRuntime;
  readonly mcpRuntime?: McpRuntime;
}

// Only accept --chapter/--prompt; fixed chapter entrypoints automatically supply chapter, failing immediately on other arguments.
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

// execute manages real resource lifecycles: create shared runtime first, run the Agent, and close via unified failure list.
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // Creates a traceable LiveRuntime first, then passes the same dependencies to buildAgent;
  // Runner takes over the success path; construction failure paths can still reclaim started resources in creation order.
  const workspace = resolve(process.cwd());
  const runtime = createLiveRuntime(profile, workspace);
  const {
    model,
    dependencies,
    worktreeRuntime,
    backgroundSupervisor,
    cronRuntime,
    teammateRuntime,
    mcpRuntime,
  } = runtime;
  let runner: ReturnType<typeof buildAgent> | undefined;
  const failures: unknown[] = [];
  let exitCode: number | undefined;
  try {
    // Verify cwd is the Git repository root before creating any runtime state to avoid leaving task stores in the wrong directory.
    if (worktreeRuntime !== undefined) await worktreeRuntime.validateRepository();
    runner = buildAgent(profile, dependencies);
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
      // Cron wakeup binds after the runner is ready; the same AgentRunner consumes event turns.
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
    // When buildAgent fails, no unified resources exist; close them in creation order as a fallback.
    for (const resource of [mcpRuntime, teammateRuntime, cronRuntime, backgroundSupervisor]) {
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

// Construct real runtimes by chapter capabilities and reuse the same supervisor, inbox, and store to avoid separate state.
function createLiveRuntime(profile: ChapterProfile, workspace: string): LiveRuntime {
  // This is the only real composition root of P20: All cross-capability sharing relationships are established here, and the returned object is read-only to prevent swapping dependencies during execution.
  const envPath = resolve(workspace, ".env");
  const requiresFallback = profile.capabilities.has("recovery");
  const settings = existsSync(envPath)
    ? settingsFromEnvFile(envPath, requiresFallback)
    : settingsFromMapping({}, requiresFallback);
  const model = new OpenAIChatModel(settings);
  const fileSystem = new NodeWorkspaceFileSystem();
  const taskStore =
    profile.capabilities.has("task_dag_json") && !profile.capabilities.has("task_dag_sqlite")
      ? new JsonTaskStore(workspace)
      : undefined;
  // A single SqliteTaskStore injects into Lead, Subagent, and Teammate factories to prevent database forks.
  const sqliteTaskStore = profile.capabilities.has("task_dag_sqlite")
    ? new SqliteTaskStore(workspace)
    : undefined;
  // P18 WorktreeRuntime implements both TaskClaimService and ToolContextProvider, reusing the same SQLite store.
  const worktreeRuntime =
    profile.capabilities.has("worktree") && sqliteTaskStore !== undefined
      ? new WorktreeRuntime({
          workspace,
          store: sqliteTaskStore,
          gitRunner: new SubprocessGitRunner(),
        })
      : undefined;
  // WorkStealingRuntime and Worktree share the store/claim service so claims and tool context point to the same task set.
  const workStealingRuntime =
    sqliteTaskStore === undefined
      ? undefined
      : new WorkStealingRuntime({
          store: sqliteTaskStore,
          ...(worktreeRuntime === undefined ? {} : { claimService: worktreeRuntime }),
        });
  // Background supervisor and EventInbox form the single event source shared by Cron and Teammates.
  const backgroundSupervisor = profile.capabilities.has("background")
    ? new JobSupervisor({ store: new JsonBackgroundJobStore(workspace), inbox: new EventInbox() })
    : undefined;
  const cronRuntime = profile.capabilities.has("cron")
    ? createCronRuntime(workspace, backgroundSupervisor)
    : undefined;
  const teammateRuntime = profile.capabilities.has("teammate")
    ? createTeammateRuntime(workspace, backgroundSupervisor, cronRuntime)
    : undefined;
  const protocolRuntime =
    profile.capabilities.has("protocol") && teammateRuntime !== undefined
      ? new ProtocolRuntime({
          store: new JsonProtocolStore(workspace),
          team: teammateRuntime,
        })
      : undefined;
  // The protocol runtime reuses the teammate TeammateRuntime/MailboxStore; request states persist in a separate JsonProtocolStore.
  // Create the runtime only when the profile declares mcp capability, avoiding extra child processes in earlier chapters.
  const mcpRuntime = profile.capabilities.has("mcp") ? createMcpRuntime() : undefined;
  const dependencies: BuildDependencies = {
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
    ...(workStealingRuntime === undefined ? {} : { workStealingRuntime }),
    ...(worktreeRuntime === undefined ? {} : { worktreeRuntime }),
    ...(backgroundSupervisor === undefined ? {} : { backgroundSupervisor }),
    ...(cronRuntime === undefined ? {} : { cronRuntime }),
    ...(teammateRuntime === undefined ? {} : { teammateRuntime }),
    ...(protocolRuntime === undefined ? {} : { protocolRuntime }),
    ...(mcpRuntime === undefined ? {} : { mcpRuntime }),
  };
  return Object.freeze({
    model,
    dependencies,
    ...(worktreeRuntime === undefined ? {} : { worktreeRuntime }),
    ...(backgroundSupervisor === undefined ? {} : { backgroundSupervisor }),
    ...(cronRuntime === undefined ? {} : { cronRuntime }),
    ...(teammateRuntime === undefined ? {} : { teammateRuntime }),
    ...(mcpRuntime === undefined ? {} : { mcpRuntime }),
  });
}

// Local demos connect to two stdio demo servers; the CLI assembles and injects remote tool policy and schema validation.
function createMcpRuntime(): McpRuntime {
  // Local demos allow an allowlist declaring four remote tools and their effects; production should supply this by configuration.
  const policies = Object.freeze([
    new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
    new McpToolPolicy({ remoteName: "fail", effect: "read" }),
    new McpToolPolicy({ remoteName: "delay", effect: "read" }),
    new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
  ]);
  const sourceServerScript = fileURLToPath(new URL("./mcp-servers/demo.ts", import.meta.url));
  const builtServerScript = fileURLToPath(new URL("./mcp-servers/demo.js", import.meta.url));
  const useSourceServer = existsSync(sourceServerScript);
  const serverScript = useSourceServer ? sourceServerScript : builtServerScript;
  const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
  const serverCommand = process.execPath;
  const serverPrefix = useSourceServer ? [tsxCli] : [];
  // Two demo servers share the same policy set but have different aliases to verify that same-named remote tools do not conflict after alias isolation.
  const servers: readonly (readonly [string, string])[] = [
    ["demo_alpha", "alpha"],
    ["demo_beta", "beta"],
  ] as const;
  const specs = servers.map(
    ([alias, label]) =>
      new McpServerSpec({
        alias,
        command: serverCommand,
        args: [...serverPrefix, serverScript, "--label", label],
        toolPolicies: policies,
        startupTimeoutSeconds: 5,
        toolTimeoutSeconds: 5,
      }),
  );
  // CLI assembles stdio adapter and Ajv schema validator before injecting into McpRuntime.
  return new McpRuntime({
    servers: specs,
    connectionFactory: new StdioMcpConnectionFactory(),
    schemaValidator: new AjvMcpSchemaValidator(),
  });
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

// recovery must configure fallback models explicitly; missing configurations fail before running rather than falling back later.
function requiredFallbackModel(fallbackModel: string | undefined): string {
  if (fallbackModel === undefined) {
    throw new ConfigurationError(["OPENAI_FALLBACK_MODEL"]);
  }
  return fallbackModel;
}

// Real run Hooks only output lifecycle events to stderr, helping users verify user prompts, tool calls, and stop timing.
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

// Configuration errors and runtime failures use different exit codes to prevent callers from treating missing keys as ordinary execution errors.
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
