/**
 * Built-in tool definitions: the P02 capability surface consists of shell and four file tools.
 * Each tool binds its Zod schema, description, effect, and handler in a ToolDefinition.
 * description enters model context with z.toJSONSchema, so it is both documentation and a decision prompt;
 * handler maps domain errors to stable error codes visible to the model. It does not modify the Agent Loop.
 */
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

// Minimal input contract for shell; strict objects reject undeclared arguments from the model.
const shellInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .describe("Exact PowerShell command to run. The process starts in the current workspace."),
});

// Tool definitions keep model parameter constraints, effect classifications, and workspace executors in the same place.
export function createShellTool(commandRunner: CommandRunner): ToolDefinition<{ command: string }> {
  return {
    name: "shell",
    description:
      "Run a PowerShell command in the current workspace. Prefer it only when the file tools cannot express the operation. Execution requires interactive approval, and stdout/stderr are returned together with an explicit marker when output is truncated.",
    inputSchema: shellInputSchema,
    effect: "execute",
    handler: async ({ command }, context) => {
      let result: CommandResult;
      try {
        result = await commandRunner.run(command, context.workspace);
      } catch {
        return toolError("shell_start_failed", "PowerShell process could not be started");
      }

      let output = result.output.length === 0 ? "(no output)" : result.output;
      // Include truncation flags in content so models know output does not represent full command results.
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

// Build the P01 cumulative toolset for P02 to extend while preserving shell behavior.
export function createChapterOneTools(commandRunner: CommandRunner): ToolRegistry {
  // P02 reuses registration results from P01 to ensure cumulative behavior across chapter snapshots.
  const registry = new ToolRegistry();
  registry.register(createShellTool(commandRunner));
  return registry;
}

// Path and optional line limit for reading tool; file system boundary re-validates path safety.
const readFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative file path. `..`, absolute paths, Windows device names, and symlink/junction escapes are rejected.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional maximum number of lines to return. The full file is returned when omitted.",
    ),
});
// Input contract for full writes; empty content intentionally represents clearing files rather than parameter errors.
const writeFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative destination path. Parent directories are created automatically."),
  content: z
    .string()
    .describe("UTF-8 text content to write. Use an empty string to clear the file."),
});
// Input contract for exact editing; old_text is required and non-empty to prevent unbounded insertion.
const editFileInputSchema = z.strictObject({
  path: z.string().min(1).describe("Workspace-relative target file path."),
  old_text: z
    .string()
    .min(1)
    .describe(
      "Exact existing text to replace. Only the first occurrence is changed; read the file first to get exact text.",
    ),
  new_text: z
    .string()
    .describe("Replacement text. Use an empty string to delete the matched text."),
});
// Restricted glob input contract for file discovery. The security boundary rejects parent directory segments.
const globInputSchema = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative glob pattern, for example `**/*.ts`; patterns containing `..` are rejected.",
    ),
});

// Derives executor input from Zod schema; avoids maintaining model descriptions and actual parameter types redundantly.
// Read handler input derived from schema to prevent drift between TypeScript types and model parameters.
type ReadFileInput = z.infer<typeof readFileInputSchema>;
// Full write handler input derived from schema.
type WriteFileInput = z.infer<typeof writeFileInputSchema>;
// Exact edit handler input derived from schema.
type EditFileInput = z.infer<typeof editFileInputSchema>;
// File discovery handler input derived from schema.
type GlobInput = z.infer<typeof globInputSchema>;

// Creates read-only text tool, translating file system domain errors into model-recoverable error codes.
function createReadFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<ReadFileInput> {
  // Map infrastructure errors here to stable error codes visible to the model.
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the current workspace. Pass a workspace-relative path; `limit` limits the returned output to that many lines and appends a visible remaining-line marker. Invalid UTF-8 fails with `invalid_utf8` instead of silently replacing bytes.",
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

// Creates full content write tool, reporting actual UTF-8 byte count instead of character count on success.
function createWriteFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<WriteFileInput> {
  // Each file tool maps domain errors independently so the model can correct its next call by error code.
  return {
    name: "write_file",
    description:
      "Write UTF-8 text to a file in the current workspace. Use this when the full target content is known; parent directories are created automatically and the result reports the actual UTF-8 byte count.",
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

// Create the first exact-match replacement tool to prevent unpredictable edits from fuzzy line numbers.
function createEditFileTool(fileSystem: WorkspaceFileSystem): ToolDefinition<EditFileInput> {
  // Editing replaces only the first exact match, preventing vague model instructions from causing accidental bulk edits.
  return {
    name: "edit_file",
    description:
      "Replace the first exact occurrence of `old_text` with `new_text` in a UTF-8 file in the current workspace. Use this for surgical edits after reading the file; line numbers are never accepted. If the exact text is missing, the file is left unchanged and `text_not_found` is returned.",
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

// Creates read-only path discovery tool; empty matches are normal tool results rather than exceptions.
function createGlobTool(fileSystem: WorkspaceFileSystem): ToolDefinition<GlobInput> {
  return {
    name: "glob",
    description:
      "List workspace-relative paths matching a glob pattern. Use this to discover files before reading or editing. Matches are returned one per line in stable alphabetical order with `/` separators; `(no matches)` is returned when nothing matches.",
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
  // Chapter capability accumulation: retain P01 Shell, then register file read, write, and enumeration tools.
  const registry = createChapterOneTools(commandRunner);
  registry.register(createReadFileTool(fileSystem));
  registry.register(createWriteFileTool(fileSystem));
  registry.register(createEditFileTool(fileSystem));
  registry.register(createGlobTool(fileSystem));
  return registry;
}
