/**
 * File system domain errors and interface definitions.
 * Each error type maps to an exact failure scenario. The tool layer maps it via instanceof to a stable error code visible to the model.
 * WorkspaceFileSystem uses only string paths and primitive types. It does not expose Node implementation details.
 */
// File tools use specific error types to distinguish path escape, encoding, missing files, and I/O failures.
// Thrown when the relative path escapes the workspace after lexical or real path resolution.
export class WorkspacePathError extends Error {}

// edit_file throws when required exact old text is missing, ensuring no partial modifications to the file.
export class TextNotFoundError extends Error {}

// Throw when file bytes cannot be decoded as strict UTF-8. Silent replacement of corrupt bytes is forbidden.
export class InvalidUtf8Error extends Error {}

// Thrown when the target file or directory does not exist before performing an operation.
export class FileNotFoundError extends Error {}

// Thrown when path points to the wrong file type, such as treating a directory as a text file.
export class InvalidFilePathError extends Error {}

// Underlying file system failures that cannot be categorized into other domain errors.
export class FileSystemOperationError extends Error {}

// All path parameters must be relative to workspace; implementations are responsible for preserving this boundary before each operation.
// This is the only file system boundary depended on by the tool layer; Node details do not enter the Agent Loop.
export interface WorkspaceFileSystem {
  // Read strict UTF-8 text; truncate output by normalized lines when limit is present.
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  // Writes full UTF-8 content and returns actual byte count, which callers use to report effects to the model.
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  // Replaces only the first exact match; writes no changes if oldText does not exist.
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  // List workspace-relative paths using a restricted glob subset. Results must be stably sorted.
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
