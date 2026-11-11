#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { OpenAIChatModel } from "./adapters/openai-chat.js";
import { buildAgent } from "./bootstrap.js";
import { ConfigurationError, settingsFromEnvFile, settingsFromMapping } from "./config.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionDecision } from "./core/permissions.js";
import type { PermissionRequest } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";

// CLI adapter provides human approval and audit output; the policy itself does not depend on terminal implementations.
class TerminalApprovalProvider implements ApprovalProvider {
  // Resolve ask decisions in the terminal; return deny on no TTY, exceptions, or non-affirmative answers.
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
      // Automated environments have no verifiable human intent; approvals must deny instead of allowing by default.
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
  // Write final permission conclusions to stderr to avoid mixing into user-visible final answer stdout.
  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    // Audit output uses stderr to avoid polluting final response stdout.
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
  // Chapter numbers mapped to fixed profiles.
  readonly chapter: number;
  // User task passed to AgentRunner.
  readonly prompt: string;
}

// Parse general or fixed chapter entry parameters; fixedChapter prevents script entries from being overridden by --chapter.
function parseRunArguments(argv: readonly string[], fixedChapter?: number): RunArguments {
  // Fixed chapter entrypoints reuse the same parser, thereby forbidding passing another --chapter.
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

// Real startup path: load configuration, create model/file boundaries, inject terminal approvals and audits, and output final text.
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // The workspace uses the current directory as its sole file and command boundary, avoiding extra paths from command lines.
  const workspace = resolve(process.cwd());
  const envPath = resolve(workspace, ".env");
  // Still construct the model when .env is missing, letting OpenAIChatModel throw configuration errors uniformly.
  const settings = existsSync(envPath) ? settingsFromEnvFile(envPath) : settingsFromMapping({});
  const model = new OpenAIChatModel(settings);
  const fileSystem = new NodeWorkspaceFileSystem();
  const runner = buildAgent(profile, {
    model,
    workspace,
    fileSystem,
    approvalProvider: new TerminalApprovalProvider(),
    auditSink: new TerminalAuditSink(),
  });
  const result = await runner.run(prompt);
  stdout.write(`${result.finalText}\n`);
  return 0;
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

// The process boundary converts configuration failures and runtime failures into stable Chinese labels and exit codes.
async function runWithErrorHandling(run: () => Promise<number>): Promise<number> {
  // The process boundary maps expected configuration errors and runtime errors to stable exit codes.
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
