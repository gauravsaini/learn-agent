/**
 * Command execution boundary: core tools do not directly depend on child_process.
 * CommandResult unifies output, exit code, timeout, and truncation into an observable state,
 * Tests can replace the real PowerShellRunner with a deterministic CommandRunner.
 */
// Standard result for command adapters: output limits and timeouts are observable states, not implicit exceptions.
export interface CommandResult {
  // Bounded output merging stdout/stderr, backfilled by tools to the model.
  readonly output: string;
  // Subprocess exit code; non-zero states are classified by the tool layer as error results.
  readonly exitCode: number;
  // Whether the command was terminated because its time budget expired.
  readonly timedOut: boolean;
  // Whether merged output exceeds the limit, preventing the model from mistaking partial results for complete results.
  readonly truncated: boolean;
}

// Core tools depend only on this boundary; tests can replace it with a deterministic command runner.
export interface CommandRunner {
  // Replaceable process execution boundary; timeoutMs applies only to this invocation.
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
