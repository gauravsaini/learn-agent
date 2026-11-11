// The file adapter normalizes cross-platform errors into domain errors that the tool layer can handle stably.
export class WorkspacePathError extends Error {}

// target text not found in file; unique error for edit_file.
export class TextNotFoundError extends Error {}

// File content is not valid UTF-8, a specific error for read operations.
export class InvalidUtf8Error extends Error {}

// ENOENT normalizes to this error without leaking concrete file system paths.
export class FileNotFoundError extends Error {}

// Used when EISDIR / ENOTDIR occurs or path type does not match expectations.
export class InvalidFilePathError extends Error {}

// Used for other unclassifiable file system failures.
export class FileSystemOperationError extends Error {}

export interface WorkspaceWriteBoundary {
  // The permission layer depends only on this narrow interface to check write boundaries, avoiding reverse dependencies on concrete file implementations.
  isPathWithinWorkspace(workspace: string, relativePath: string): Promise<boolean>;
}

export interface WorkspaceFileSystem extends WorkspaceWriteBoundary {
  // Declares only workspace file capabilities required by Agent tools.
  // Read strict UTF-8 text; truncate by normalized lines when limit is present.
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  // Writes full UTF-8 content and returns byte count.
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  // Replaces only the first exact match; writes no changes if not found.
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  // Return stably sorted workspace-relative paths using a restricted glob subset.
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
