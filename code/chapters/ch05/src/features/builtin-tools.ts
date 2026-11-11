// Chapter 1-5 built-in tool set: shell, read_file, write_file, edit_file, glob.
// Tool schemas use strict objects to prevent excess fields from bypassing model-visible JSON Schemas.
// Chapter 1-4 built-in tool set: shell, read_file, write_file, edit_file, glob.
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

export function createShellTool(commandRunner: CommandRunner): ToolDefinition<{ command: string }> {
  // shell belongs to execute effects; even if commands appear read-only, permission policies require approval by default.
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

      // Preserves bounded output and timeout state so the model can decide whether to adjust commands.
      let output = result.output.length === 0 ? "(no output)" : result.output;
      // Preserves bounded output and timeout state so the model can decide whether to adjust commands.
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

export function createChapterOneTools(commandRunner: CommandRunner): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createShellTool(commandRunner));
  return registry;
}

const readFileInputSchema = z.strictObject({
  path: z.string().min(1),
  limit: z.number().int().positive().optional(),
});
// Writes and edits both carry path, which the permission layer uses to determine hard workspace boundaries.
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
  // read effects produce no external side effects; allow by default when no rules object.
  return {
    name: "read_file",
    description: "Read a UTF-8 text file from the current workspace.",
    inputSchema: readFileInputSchema,
    effect: "read",
    handler: async ({ path, limit }, context) => {
      try {
        return toolSuccess(await fileSystem.readFile(context.workspace, path, limit));
      } catch (error) {
        // Map known file domain errors to stable error codes; delegate unknown errors to upper layers for uniform handling.
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
  // The write effect triggers the workspace boundary check first, then enters the confirm-file-write approval rule.
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
  // edit and write are both tagged as write; P03 permission policy does not distinguish specific file write methods.
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
): ToolRegistry {
  // Chapters 2 through 5 reuse the same tool set; new capabilities exist at the loop boundary, not in tools themselves.
  // Chapters 2 through 4 reuse the same tool set; new capabilities exist at the loop boundary, not in tools themselves.
  // Chapters 2 and 3 reuse the same tool set; Chapter 3 introduces pre-execution permission policies, not new tools.
  const registry = createChapterOneTools(commandRunner);
  registry.register(createReadFileTool(fileSystem));
  registry.register(createWriteFileTool(fileSystem));
  registry.register(createEditFileTool(fileSystem));
  registry.register(createGlobTool(fileSystem));
  return registry;
}
