import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../core/commands.js";

export interface PowerShellRunnerOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
}

export class PowerShellRunner implements CommandRunner {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #outputLimit: number;

  constructor(options: PowerShellRunnerOptions = {}) {
    // Default values limit waiting time and returned content of a single tool call, preventing the loop from being dragged down by infinite commands.
    this.#executable = options.executable === undefined ? "powershell.exe" : options.executable;
    // A 120-second timeout covers most normal commands; long-blocking commands must be truncated rather than awaited indefinitely.
    this.#timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    // A 50 KB output cap prevents tool output from overflowing model context; excess bytes are truncated without losing the final exit code.
    this.#outputLimit = options.outputLimit === undefined ? 50_000 : options.outputLimit;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.#outputLimit) || this.#outputLimit <= 0) {
      throw new Error("outputLimit must be a positive integer");
    }
  }

  run(command: string, cwd: string, timeoutOverrideMs?: number): Promise<CommandResult> {
    if (command.length === 0) {
      throw new Error("command must not be empty");
    }
    const timeoutMs = timeoutOverrideMs === undefined ? this.#timeoutMs : timeoutOverrideMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    return new Promise((resolve, reject) => {
      // Disable Profiles and interactive input to make the execution environment predictable; unify output to UTF-8.
      const child = spawn(
        this.#executable,
        // -NoLogo removes the startup banner, -NoProfile prevents user profile from modifying command semantics, and -NonInteractive blocks interactive prompts.
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
      // truncated marks whether output reached limits; timedOut marks whether timeout killed the process.
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const append = (chunk: Buffer): void => {
        // stdout and stderr share the same ceiling to prevent error outputs bypassing resource controls.
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

      const timer = setTimeout(() => {
        // The close callback handles settlement to prevent timeout and close producing conflicting results.
        timedOut = true;
        child.kill();
      }, timeoutMs);
    });
  }
}
