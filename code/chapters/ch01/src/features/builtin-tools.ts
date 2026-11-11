import { z } from "zod";

import type { CommandResult, CommandRunner } from "../core/commands.js";
import type { ToolDefinition } from "../core/tools.js";
import { ToolRegistry, toolError, toolSuccess } from "../core/tools.js";

// Chapter 1 built-in tools: currently registers only one schema-constrained shell (PowerShell) tool.
//
// Input, handler, and effect for shell come from the same ToolDefinition,
// Prevents parallel maintenance between the schema seen by the model and actual execution logic. Errors are classified as startup failures, timeouts, and non-zero exit codes,
// Allow the model to read actionable text and distinguish failure causes by errorCode.
//
// Strict object rejects extra fields, and command strings cannot be empty; actual command semantics are left to PowerShell.
const shellInputSchema = z.strictObject({ command: z.string().min(1) });

// Chapter 1 exposes only schema-constrained PowerShell tools; working directory comes from controlled context.
// commandRunner is the only process boundary; tool definitions do not spawn child processes directly.
export function createShellTool(commandRunner: CommandRunner): ToolDefinition<{ command: string }> {
  return {
    name: "shell",
    description: "Run a PowerShell command in the current workspace.",
    inputSchema: shellInputSchema,
    effect: "execute",
    handler: async ({ command }, context) => {
      let result: CommandResult;
      try {
        result = await commandRunner.run(command, context.workspace);
      } catch {
        return toolError("shell_start_failed", "PowerShell process could not be started");
      }

      // Result text accommodates empty output, truncation, timeouts, and non-zero exit codes as next turn model context.
      let output = result.output.length === 0 ? "(no output)" : result.output;
      if (result.truncated) {
        output = `${output}\n[output truncated]`;
      }
      if (result.timedOut) {
        return toolError("shell_timeout", output);
      }
      if (result.exitCode !== 0) {
        return toolError(
          "shell_failed",
          `PowerShell exited with code ${result.exitCode}\n${output}`,
        );
      }
      return toolSuccess(output);
    },
  };
}

// Creates full Tool Registry for this chapter; new tools must register centrally here so composition root does not miss capabilities.
export function createChapterOneTools(commandRunner: CommandRunner): ToolRegistry {
  // Chapter tools register all available effects centrally for one-time injection by the assembly layer.
  const registry = new ToolRegistry();
  registry.register(createShellTool(commandRunner));
  return registry;
}
