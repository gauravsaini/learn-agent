/**
 * PowerShell child process adapter: implements CommandRunner.
 * Use -NoLogo, -NoProfile, -NonInteractive to reduce host configuration impact;
 * windowsHide hides console windows; kills on timeout and preserves the timedOut state;
 * stdout/stderr share an output budget. Truncation is exposed to the tool layer through the truncated flag.
 */
import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../core/commands.js";

// Process options can be injected; tests can verify timeout and truncation without depending on system defaults.
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
    // Default values limit the duration and output volume of a single command, preventing tool calls from consuming runtime resources indefinitely.
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

  run(command: string, cwd: string, timeoutOverrideMs?: number): Promise<CommandResult> {
    if (command.length === 0) {
      throw new Error("command must not be empty");
    }
    const timeoutMs = timeoutOverrideMs === undefined ? this.#timeoutMs : timeoutOverrideMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    return new Promise((resolve, reject) => {
      // Closes Profile and interactive input, reducing host environment configuration impact on tool results.
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

      const append = (chunk: Buffer): void => {
        // stdout and stderr share a budget; returned results preserve the fact that truncation occurred.
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
        // error and close can arrive out of order; settled ensures the Promise settles only once.
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
        // Wait for close to collect final process state after timeout before returning timedOut to the tool layer.
        timedOut = true;
        child.kill();
      }, timeoutMs);
    });
  }
}
