// Minimal result contract exposed by command adapters to the tool layer, preserving bounded execution state.
//
// CommandResult contains all possible runtime result states; the tool layer decides toolSuccess or specific toolError accordingly.
export interface CommandResult {
  // Bounded text merging stdout and stderr, backfilled by tools to the model.
  readonly output: string;
  // Subprocess exit status; non-zero values are converted by upper layers into recoverable tool errors.
  readonly exitCode: number;
  // Timeout termination and normal non-zero exit require distinct handling, so retain this flag separately.
  readonly timedOut: boolean;
  // True when output exceeds the shared budget. Callers use this to avoid treating incomplete results as full results.
  readonly truncated: boolean;
}

//
// CommandRunner abstracts the process execution boundary so core loop does not depend on concrete child process implementations;
// Tests can use FakeCommandRunner to inject deterministic results and isolate operating system dependencies.
//
export interface CommandRunner {
  // Replaceable process boundary relied on by command tools; implementations handle cwd, timeouts, and output collection.
  // timeoutMs covers only the time budget for this call; omitted values fall back to adapter default limits.
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
