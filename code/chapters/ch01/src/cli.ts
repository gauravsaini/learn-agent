#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { OpenAIChatModel } from "./adapters/openai-chat.js";
import { buildAgent } from "./bootstrap.js";
import { ConfigurationError, settingsFromEnvFile, settingsFromMapping } from "./config.js";
import type { ToolAuthorizer, ToolAuthorizationDecision } from "./core/loop.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import type { PreparedToolCall, ToolContext } from "./core/tools.js";

// The CLI layer provides two entry points: fixed chapter scripts and general CLI, sharing permission, configuration, and error handling boundaries.
//
// TerminalAuthorizer is the manual approval point for execute tools such as shell;
// Non-interactive terminals, Enter, non-y/yes inputs, or approval exceptions all fail-closed to deny execution.
// runCli / runProfile only handle argument parsing and startup assembly, containing no Agent Loop logic.
//
// The terminal is the manual authorization boundary for side-effect tools; execution must be denied when there is no interactive terminal.
class TerminalAuthorizer implements ToolAuthorizer {
  // Request explicit approval for this side-effect call in a real terminal; deny execution on any interaction exception.
  async authorize(
    prepared: PreparedToolCall,
    _context: ToolContext,
  ): Promise<ToolAuthorizationDecision> {
    const definition = prepared.definition;
    if (definition === undefined) {
      throw new Error("approval request is incomplete");
    }
    stderr.write(`\nTool call requires approval: ${definition.name}\n`);
    stderr.write("Reason: PowerShell command execution requires explicit approval.\n");
    stderr.write(`Arguments: ${JSON.stringify(prepared.arguments)}\n`);
    if (!stdin.isTTY) {
      stderr.write("No interactive input, rejecting by default.\n");
      return { allowed: false, reason: "No interactive approval input was available" };
    }

    const terminal = createInterface({ input: stdin, output: stderr });
    try {
      const answer = await terminal.question("Allow this call? [y/N] ");
      const normalized = answer.trim().toLowerCase();
      const allowed = normalized === "y" || normalized === "yes";
      return {
        allowed,
        reason: allowed ? "User approved this tool call" : "User denied this tool call",
      };
    } finally {
      terminal.close();
    }
  }
}

// Minimal startup parameters after CLI parsing; both chapter and user request are required.
interface RunArguments {
  // Parsed target chapter, which must subsequently map to an actual migrated profile.
  readonly chapter: number;
  // Raw user task text passed to AgentRunner.run.
  readonly prompt: string;
}

// Parse arguments for general or fixed chapter entry points; fixed entries populate chapter automatically, forbidding user overrides.
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

// Real execution path: read configuration, create SDK adapters, assemble the Agent, and output final text.
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // Completes configuration validation before creating model and Agent, avoiding external calls when keys are missing.
  const workspace = resolve(process.cwd());
  const envPath = resolve(workspace, ".env");
  const settings = existsSync(envPath) ? settingsFromEnvFile(envPath) : settingsFromMapping({});
  const model = new OpenAIChatModel(settings);
  const runner = buildAgent(profile, {
    model,
    workspace,
    authorizer: new TerminalAuthorizer(),
  });
  const result = await runner.run(prompt);
  stdout.write(`${result.finalText}\n`);
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  // The general CLI must start with the run subcommand, then choose a migrated chapter.
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
  // Fixed chapter scripts reject --chapter to prevent entrypoints and profiles from targeting different chapters.
  return runWithErrorHandling(async () => {
    const parsed = parseRunArguments(argv, profile.chapter);
    return await execute(profile, parsed.prompt);
  });
}

async function runWithErrorHandling(run: () => Promise<number>): Promise<number> {
  // CLI boundary maps domain configuration errors to distinguishable exit codes; internal errors are not swallowed here.
  try {
    return await run();
  } catch (error) {
    const label = error instanceof ConfigurationError ? "Configuration Error" : "Runtime Failure";
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: ${message}\n`);
    return error instanceof ConfigurationError ? 2 : 1;
  }
}

// Does not start processes when imported by other modules; consumes process.argv only as a direct entry point.
const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
