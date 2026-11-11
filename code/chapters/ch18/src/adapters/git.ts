import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { GitExecutionError } from "../features/worktrees.js";
import type { GitCommandResult, GitRunner } from "../features/worktrees.js";

const execFileAsync = promisify(execFile);

// Git child process boundary uniformly validates working directory and timeout; callers receive only structured command results.
export class SubprocessGitRunner implements GitRunner {
  readonly #timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    // Timeout policy is fixed during adapter construction; domain runtime does not handle process-level details.
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be positive");
    }
    this.#timeoutMs = timeoutMs;
  }

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    // Enforce array arguments + execFile to prevent shell injection; the working directory must exist and be a directory.
    if (
      !Array.isArray(argumentsValue) ||
      argumentsValue.length === 0 ||
      argumentsValue.some((argument) => typeof argument !== "string" || argument.length === 0)
    ) {
      throw new TypeError("Git arguments must contain non-empty strings");
    }
    let workingDirectory: string;
    try {
      workingDirectory = await realpath(cwd);
      if (!(await stat(workingDirectory)).isDirectory())
        throw new Error("Git cwd is not a directory");
    } catch (error) {
      throw new GitExecutionError("Git cwd could not be resolved", { cause: error });
    }
    try {
      const result = await execFileAsync("git", ["--no-pager", ...argumentsValue], {
        // execFile bypasses shell and passes array elements directly as argv, remaining safe even with spaces or special characters.
        cwd: workingDirectory,
        encoding: "utf8",
        timeout: this.#timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return Object.freeze({
        returncode: 0,
        stdout: String(result.stdout),
        stderr: String(result.stderr),
      });
    } catch (error) {
      const details = error as {
        code?: unknown;
        stdout?: unknown;
        stderr?: unknown;
        killed?: unknown;
      };
      // Timeouts and startup failures are distinct error categories: timeouts throw explicitly, while normal non-zero exit codes convert to structured results.
      if (details.killed === true || details.code === "ETIMEDOUT") {
        throw new GitExecutionError("Git command timed out", { cause: error });
      }
      if (typeof details.code === "number") {
        return Object.freeze({
          returncode: details.code,
          stdout: typeof details.stdout === "string" ? details.stdout : "",
          stderr: typeof details.stderr === "string" ? details.stderr : "",
        });
      }
      throw new GitExecutionError("Git command could not be started", { cause: error });
    }
  }
}
