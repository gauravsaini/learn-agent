import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../core/commands.js";

// PowerShell command adapter: converts string commands into restricted child process execution and collects output uniformly.
//
// Explicit NoLogo, NoProfile, and NonInteractive parameters guarantee clean script execution without loading user configuration.
// Default 120-second timeout and 50,000-character output limit to prevent a single command from exhausting runtime resources or flooding context.
// Passing argument arrays avoids re-parsing by the shell; UTF-8 encoding decodes stdout and stderr consistently.
//
// PowerShell process boundary: unifies UTF-8, timeout, and output caps to prevent a single command from exhausting runtime resources.
export interface PowerShellRunnerOptions {
  // Replaceable process executable path, primarily used for tests or controlled deployment environments.
  readonly executable?: string;
  // Default time budget for each command, individually overridable during calls.
  readonly timeoutMs?: number;
  // Character ceiling for merged stdout and stderr to prevent results flooding Agent context.
  readonly outputLimit?: number;
}

// Node child process CommandRunner collects controlled PowerShell execution results uniformly.
export class PowerShellRunner implements CommandRunner {
  // Actual launched PowerShell program name or absolute path.
  readonly #executable: string;
  // Single command timeout used when not explicitly overridden.
  readonly #timeoutMs: number;
  // Maximum characters shared across both output streams.
  readonly #outputLimit: number;

  // Initialize execution limits and reject invalid budgets before starting the process.
  constructor(options: PowerShellRunnerOptions = {}) {
    // Runtime limits can be replaced for tests; production defaults limit single command time and response size.
    this.#executable = options.executable === undefined ? "powershell.exe" : options.executable;
    this.#timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    this.#outputLimit = options.outputLimit === undefined ? 50_000 : options.outputLimit;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.#outputLimit) || this.#outputLimit <= 0) {
      throw new Error("outputLimit must be a positive integer");
    }
  }

  // Launch non-interactive PowerShell, converging exit, timeout, and truncation states into a CommandResult.
  run(command: string, cwd: string, timeoutOverrideMs?: number): Promise<CommandResult> {
    // Calls can shorten or extend budgets, but still require positive integers to maintain explicit timer semantics.
    if (command.length === 0) {
      throw new Error("command must not be empty");
    }
    const timeoutMs = timeoutOverrideMs === undefined ? this.#timeoutMs : timeoutOverrideMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    return new Promise((resolve, reject) => {
      // Argument arrays avoid re-parsing through the shell; explicit UTF-8 decodes stdout and stderr consistently.
      const child = spawn(
        this.#executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; ${command}`,
        ],
        { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: string[] = [];
      let outputLength = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      // Both output streams share a single limit, keeping earliest content and recording truncation state.
      const append = (chunk: Buffer): void => {
        // stdout and stderr share the same budget to ensure error outputs cannot bypass result limits.
        if (outputLength >= this.#outputLimit) {
          truncated = true;
          return;
        }
        const text = chunk.toString("utf8");
        const remaining = this.#outputLimit - outputLength;
        chunks.push(text.slice(0, remaining));
        outputLength += Math.min(text.length, remaining);
        if (text.length > remaining) {
          truncated = true;
        }
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);
      // error and close can arrive out of order; settled ensures the Promise resolves only once.
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(
          Object.freeze({
            output: chunks.join("").trimEnd(),
            exitCode: code === null ? 1 : code,
            timedOut,
            truncated,
          }),
        );
      });

      // Timeouts only terminate child processes; close collects final exit codes and returns the timedOut flag.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    });
  }
}
