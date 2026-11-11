import { z } from "zod";

import type { CommandResult, CommandRunner } from "../core/commands.js";
import {
  FileNotFoundError,
  FileSystemOperationError,
  InvalidFilePathError,
  InvalidUtf8Error,
  TextNotFoundError,
  WorkspacePathError,
} from "../core/filesystem.js";
import type { WorkspaceFileSystem } from "../core/filesystem.js";
import type { ToolDefinition } from "../core/tools.js";
import { ToolRegistry, toolError, toolSuccess } from "../core/tools.js";

// Strict object rejects extraneous fields, ensuring tool contracts match the JSON Schema seen by the model.
const shellInputSchema = z.strictObject({ command: z.string().min(1) });
// Only the shell of the main Agent in P13 adds the tri-state parameter run_in_background; other chapters and subagents use single-field schema.
const backgroundShellInputSchema = z.strictObject({
  command: z.string().min(1),
  run_in_background: z.boolean().nullable().optional().default(null),
});

export interface BackgroundShellInput {
  // Raw command text passed to PowerShellRunner.
  readonly command: string;
  // true/false determines scheduling explicitly; allow keyword heuristics when null or omitted.
  readonly run_in_background?: boolean | null;
}

// The background switch moves execution to background explicitly; when omitted, Dispatcher uses keyword heuristics.
export function createShellTool(
  commandRunner: CommandRunner,
  background = false,
): ToolDefinition<{ command: string; run_in_background?: boolean | null }> {
  // The background flag lets Dispatcher choose background submission; synchronous chapters still execute directly.
  return {
    name: "shell",
    description: "Run a PowerShell command in the current workspace.",
    inputSchema: background ? backgroundShellInputSchema : shellInputSchema,
    effect: "execute",
    ...(background ? { concurrency: "background_eligible" as const } : {}),
    handler: async ({ command }, context) => {
      let result: CommandResult;
      try {
        result = await commandRunner.run(command, context.workspace);
      } catch {
        return toolError("shell_start_failed", "PowerShell process could not be started");
      }

      // Preserves bounded output and timeout state so the model can decide whether to adjust commands.
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

// Chapter 1 has only shell tools; the background flag is passed explicitly by the P13 composition root.
export function createChapterOneTools(
  commandRunner: CommandRunner,
  background = false,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createShellTool(commandRunner, background));
  return registry;
}

const readFileInputSchema = z.strictObject({
  path: z.string().min(1),
  limit: z.number().int().positive().optional(),
});
const writeFileInputSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
});
const editFileInputSchema = z.strictObject({
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
});
const globInputSchema = z.strictObject({ pattern: z.string().min(1) });

type ReadFileInput = z.infer<typeof readFileInputSchema>;
type WriteFileInput = z.infer<typeof writeFileInputSchema>;
type EditFileInput = z.infer<typeof editFileInputSchema>;
type GlobInput = z.infer<typeof globInputSchema>;

function createReadFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<ReadFileInput> {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file from the current workspace.",
    inputSchema: readFileInputSchema,
    effect: "read",
    handler: async ({ path, limit }, context) => {
      try {
        return toolSuccess(await fileSystem.readFile(context.workspace, path, limit));
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (error instanceof InvalidUtf8Error) {
          return toolError("invalid_utf8", `File is not valid UTF-8: ${path}`);
        }
        if (error instanceof FileNotFoundError) {
          return toolError("file_not_found", `File not found: ${path}`);
        }
        if (error instanceof InvalidFilePathError) {
          return toolError("invalid_path", `Path is a directory: ${path}`);
        }
        if (error instanceof FileSystemOperationError) {
          return toolError("filesystem_error", `Could not read file: ${path}`);
        }
        throw error;
      }
    },
  };
}

function createWriteFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<WriteFileInput> {
  return {
    name: "write_file",
    description: "Write UTF-8 text to a file in the current workspace.",
    inputSchema: writeFileInputSchema,
    effect: "write",
    handler: async ({ path, content }, context) => {
      try {
        const byteCount = await fileSystem.writeFile(context.workspace, path, content);
        return toolSuccess(`Wrote ${byteCount} UTF-8 bytes to ${path}`);
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (error instanceof InvalidFilePathError) {
          return toolError("invalid_path", `Path is a directory: ${path}`);
        }
        if (error instanceof FileNotFoundError || error instanceof FileSystemOperationError) {
          return toolError("filesystem_error", `Could not write file: ${path}`);
        }
        throw error;
      }
    },
  };
}

function createEditFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<EditFileInput> {
  return {
    name: "edit_file",
    description: "Replace exact text once in a UTF-8 file in the current workspace.",
    inputSchema: editFileInputSchema,
    effect: "write",
    handler: async ({ path, old_text, new_text }, context) => {
      try {
        await fileSystem.editFile(context.workspace, path, old_text, new_text);
        return toolSuccess(`Edited ${path}`);
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (error instanceof TextNotFoundError) {
          return toolError("text_not_found", `Exact text not found in ${path}`);
        }
        if (error instanceof InvalidUtf8Error) {
          return toolError("invalid_utf8", `File is not valid UTF-8: ${path}`);
        }
        if (error instanceof FileNotFoundError) {
          return toolError("file_not_found", `File not found: ${path}`);
        }
        if (error instanceof InvalidFilePathError) {
          return toolError("invalid_path", `Path is a directory: ${path}`);
        }
        if (error instanceof FileSystemOperationError) {
          return toolError("filesystem_error", `Could not edit file: ${path}`);
        }
        throw error;
      }
    },
  };
}

function createGlobTool(fileSystem: WorkspaceFileSystem): ToolDefinition<GlobInput> {
  return {
    name: "glob",
    description: "List workspace-relative paths matching a glob pattern.",
    inputSchema: globInputSchema,
    effect: "read",
    handler: async ({ pattern }, context) => {
      try {
        const matches = await fileSystem.globFiles(context.workspace, pattern);
        return toolSuccess(matches.length === 0 ? "(no matches)" : matches.join("\n"));
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          return toolError("path_escape", error.message);
        }
        if (
          error instanceof FileNotFoundError ||
          error instanceof InvalidFilePathError ||
          error instanceof FileSystemOperationError
        ) {
          return toolError("filesystem_error", `Could not list files: ${pattern}`);
        }
        throw error;
      }
    },
  };
}

export function createChapterTwoTools(
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
  background = false,
): ToolRegistry {
  // Chapters 2 through 13 reuse the same file tool set; background only affects shell scheduling, not file tool behavior.
  const registry = createChapterOneTools(commandRunner, background);
  registry.register(createReadFileTool(fileSystem));
  registry.register(createWriteFileTool(fileSystem));
  registry.register(createEditFileTool(fileSystem));
  registry.register(createGlobTool(fileSystem));
  return registry;
}
