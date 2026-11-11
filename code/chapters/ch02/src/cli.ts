#!/usr/bin/env node

/**
 * CLI entry module: parses command-line arguments, creates the model and authorizer, and triggers AgentRunner.
 * TerminalAuthorizer requires interactive approval only for tools with effect === "execute";
 * read/write tools pass directly. Non-TTY stdin rejects execute calls by default.
 * Exit codes: 0 success, 1 runtime error, 2 configuration error.
 */
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

// The terminal boundary only requires users to approve tools executing host commands; reading or writing workspace files does not block interactive flows.
class TerminalAuthorizer implements ToolAuthorizer {
  // Requests terminal approval only for execute tools; non-interactive or exceptional runs always fail-closed.
  async authorize(
    prepared: PreparedToolCall,
    _context: ToolContext,
  ): Promise<ToolAuthorizationDecision> {
    const definition = prepared.definition;
    if (definition === undefined) {
      throw new Error("approval request is incomplete");
    }
    if (definition.effect !== "execute") {
      return { allowed: true, reason: "This tool effect does not require approval" };
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

interface RunArguments {
  // Chapter number mapped to a frozen profile after parsing.
  readonly chapter: number;
  // User task passed to AgentRunner.run.
  readonly prompt: string;
}

// Fixed chapter entrypoints inject the chapter number via fixedChapter, reusing generic argument validation logic.
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

// Real startup path: load configuration, create SDK adapters, assemble the Agent, and output final text.
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // Resolve workspace and .env from the startup directory at all times, avoiding influence from module file locations.
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

// CLI process boundary uniformly converts errors into stable labels and exit codes.
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
// Does not re-execute when imported by chapter entry points; parses argv only when running this file directly.
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
