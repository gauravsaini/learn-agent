// Minimal process result contract between command adapters and the tool layer.
// Abstract command execution boundary: CommandRunner accepts only command and cwd, returning output, exit code, and timeout status.
export interface CommandResult {
  // output is stable truncated text; timedOut and truncated provide execution boundary info outside permissions.
  readonly output: string;
  // Subprocess exit code; non-zero values are converted by the tool layer into stable error codes.
  readonly exitCode: number;
  // Whether the process terminated because the call budget was exhausted.
  readonly timedOut: boolean;
  // Whether merged output reaches the context protection limit.
  readonly truncated: boolean;
}

export interface CommandRunner {
  // Agent context must provide cwd; command text cannot expand working directory scope on its own.
  // timeoutMs covers only this process call; omitted values use adapter default budgets.
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
