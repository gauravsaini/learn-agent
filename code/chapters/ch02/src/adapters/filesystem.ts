/**
 * Node file system adapter: implements WorkspaceFileSystem in core.
 * All tool paths must resolve from workspace relative paths to safe absolute paths via safePath,
 * Then execute read/write/edit/glob. Node errors are translated to domain errors at the adapter boundary.
 * UTF-8 uses a fatal TextDecoder. Invalid bytes are not silently replaced.
 */
import {
  lstat,
  mkdir,
  readdir,
  readFile as readFileBytes,
  realpath,
  stat,
  writeFile as writeFileBytes,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";

import {
  FileNotFoundError,
  FileSystemOperationError,
  InvalidFilePathError,
  InvalidUtf8Error,
  TextNotFoundError,
  WorkspacePathError,
} from "../core/filesystem.js";
import type { WorkspaceFileSystem } from "../core/filesystem.js";

// Windows reserved device names and strict UTF-8 decoders both belong to the workspace security boundary.
// Set of Win32 device file names; even with extensions, they cannot serve as normal workspace path components.
const WINDOWS_DEVICE_NAMES = new Set(["AUX", "CLOCK$", "CON", "CONIN$", "CONOUT$", "NUL", "PRN"]);
// fatal mode prevents replacement characters masking invalid bytes; read tools must report encoding errors.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// The file system adapter normalizes Node errors into domain errors that the tool layer can map.
// Extracts Node code from unknown exceptions without trusting that any exception object has this field.
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

// Map loose Node exceptions to stable error types of the core filesystem contract.
function translateFileSystemError(error: unknown): Error {
  // Retain known domain errors as-is; map other Node errors to stable tool layer error classes.
  if (
    error instanceof WorkspacePathError ||
    error instanceof TextNotFoundError ||
    error instanceof InvalidUtf8Error ||
    error instanceof FileNotFoundError ||
    error instanceof InvalidFilePathError ||
    error instanceof FileSystemOperationError ||
    error instanceof RangeError
  ) {
    return error;
  }
  const code = errorCode(error);
  if (code === "ENOENT") {
    return new FileNotFoundError("File or directory was not found");
  }
  if (code === "EISDIR" || code === "ENOTDIR") {
    return new InvalidFilePathError("Path has the wrong file type");
  }
  if (code === undefined) {
    return error instanceof Error ? error : new Error("Non-error value thrown by file system code");
  }
  return new FileSystemOperationError("File system operation failed");
}

// Determine whether candidate absolute paths remain inside the root directory, compatible with Windows and POSIX separator semantics.
function isInside(root: string, candidate: string): boolean {
  // relative results indicate candidate remains inside root only when neither parent directory nor absolute path.
  const child = relative(root, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

// Reject Windows illegal characters, trailing spaces/dots, and device names to prevent cross-platform path semantic deviations.
function isWindowsReservedComponent(component: string): boolean {
  // Reject Win32 illegal characters, trailing dots/spaces, and device file names.
  if (component.endsWith(" ") || component.endsWith(".")) {
    return true;
  }
  if (
    [...component].some((character) => {
      const code = character.codePointAt(0);
      return (code !== undefined && code < 32) || '<>:"|*?'.includes(character);
    })
  ) {
    return true;
  }
  const stem = component.split(".", 1)[0]?.replace(/ +$/u, "").toUpperCase();
  if (stem === undefined) {
    return false;
  }
  if (WINDOWS_DEVICE_NAMES.has(stem)) {
    return true;
  }
  return (
    stem.length === 4 &&
    (stem.startsWith("COM") || stem.startsWith("LPT")) &&
    "123456789¹²³".includes(stem[3] ?? "")
  );
}

// Split user paths or globs into safe relative components; allowWildcards permits pattern characters only for globs.
function relativeParts(value: string, label: string, allowWildcards: boolean): string[] {
  // Reject POSIX, Win32, and drive letter absolute paths; all tool paths must be relative to the workspace.
  if (value.length === 0) {
    throw new WorkspacePathError(`${label} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new WorkspacePathError(`${label} contains a null byte`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    normalized.startsWith("/")
  ) {
    throw new WorkspacePathError(
      `${label} must be relative; absolute paths are rejected: ${value}`,
    );
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.includes("..")) {
    throw new WorkspacePathError(`${label} must not contain parent segments: ${value}`);
  }
  for (const part of parts) {
    if (!allowWildcards && isWindowsReservedComponent(part)) {
      throw new WorkspacePathError(`${label} contains a reserved Windows path component: ${part}`);
    }
    if (
      [...part].some((character) => {
        const code = character.codePointAt(0);
        return (code !== undefined && code < 32) || '<>:"|'.includes(character);
      })
    ) {
      throw new WorkspacePathError(`${label} contains a reserved Windows path component: ${part}`);
    }
  }
  return parts;
}

// Resolve and validate workspace real path, serving as the trusted root for symlink verification.
async function workspaceRoot(workspace: string): Promise<string> {
  // The real path is the trusted root for subsequent symlink escape checks, not the lexical path passed by the caller.
  const root = await realpath(workspace);
  const information = await stat(root);
  if (!information.isDirectory()) {
    throw new InvalidFilePathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

// Traverse up to the target's nearest existing parent directory to validate real path boundaries before writing new files.
async function resolvedExistingParent(
  root: string,
  target: string,
): Promise<{ physical: string; lexical: string }> {
  // Write target might not exist yet; traversing upward to the first parent directory that realpath can resolve verifies link boundaries.
  let current = target;
  while (true) {
    try {
      return { physical: await realpath(current), lexical: current };
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || current === root) {
        throw error;
      }
      current = dirname(current);
    }
  }
}

// Dual-resolves relative paths via lexical checks and realpath checks, blocking junction and symlink escapes.
export async function safePath(workspace: string, relativePath: string): Promise<string> {
  // Resolve real path of the existing parent directory after lexical checks for double defense against symlink escapes.
  try {
    const root = await workspaceRoot(workspace);
    const parts = relativeParts(relativePath, "path", false);
    const target = resolve(root, ...parts);
    if (!isInside(root, target)) {
      throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
    }
    // Existing parent paths must resolve to real locations to prevent junctions or symlinks from escaping the workspace.
    const existing = await resolvedExistingParent(root, target);
    const resolved = resolve(existing.physical, relative(existing.lexical, target));
    if (!isInside(root, resolved)) {
      throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
    }
    return resolved;
  } catch (error) {
    throw translateFileSystemError(error);
  }
}

// Read text with a shared strict decoder, returning a domain error instead of replacement characters when files contain invalid UTF-8.
function decodeUtf8(bytes: Uint8Array, relativePath: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new InvalidUtf8Error(`File is not valid UTF-8: ${relativePath}`);
  }
}

// Truncate by lines after normalizing line breaks so output does not depend on host system line endings.
// Trailing empty lines do not count as content lines, ensuring read_file limit consistency across platforms.
function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

// Compile agreed glob subsets into path-level regular expressions; do not pass unimplemented patterns silently to host shells.
function globRegex(pattern: string): RegExp {
  // Implements only the agreed glob subset for tools; match targets are always normalized relative paths.
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) {
      continue;
    }
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const content = pattern.slice(index + 1, end);
        source += content.startsWith("!") ? `[^${content.slice(1)}]` : `[${content}]`;
        index = end;
      }
    } else {
      source += character === "/" ? "/" : character.replace(/[\\^$+?.()|{}]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u");
}

// Extract the deterministic directory before the first wildcard to narrow glob scan scope and validate the path first.
async function literalPrefix(root: string, parts: readonly string[]): Promise<readonly string[]> {
  // Stops at the first wildcard, reduces glob traversal roots, and validates definite directory prefixes first.
  const literal: string[] = [];
  for (const part of parts) {
    if (/[?*[\]]/u.test(part)) {
      break;
    }
    literal.push(part);
  }
  if (literal.length > 0) {
    await safePath(root, literal.join(sep));
  }
  return literal;
}

// Node fs/promises implementation of WorkspaceFileSystem; all public operations maintain workspace boundaries via safePath.
export class NodeWorkspaceFileSystem implements WorkspaceFileSystem {
  // All I/O passes through safePath; cannot bypass workspace boundaries to operate on host files directly.
  // Normalize line endings after reading; limit affects returned content only, not on-disk files.
  async readFile(workspace: string, relativePath: string, limit?: number): Promise<string> {
    try {
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new RangeError("limit must be a positive integer");
      }
      const target = await safePath(workspace, relativePath);
      const text = decodeUtf8(await readFileBytes(target), relativePath);
      const lines = splitLines(text);
      if (limit !== undefined && limit < lines.length) {
        return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
      }
      return lines.join("\n");
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  // Create missing directories in the parent directory of the safe target, write UTF-8 bytes, and return the written size.
  async writeFile(workspace: string, relativePath: string, content: string): Promise<number> {
    try {
      const target = await safePath(workspace, relativePath);
      // Recursively creates directories only within target parent directories confirmed to be safe.
      const bytes = Buffer.from(content, "utf8");
      await mkdir(dirname(target), { recursive: true });
      await writeFileBytes(target, bytes);
      return bytes.byteLength;
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  // Read, find, and replace only the first exact text; throw TextNotFoundError if not found.
  async editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void> {
    // Exact text replacement modifies only the first match, allowing callers to construct predictable edit operations.
    try {
      if (oldText.length === 0) {
        throw new RangeError("old_text must not be empty");
      }
      const target = await safePath(workspace, relativePath);
      const currentBytes = await readFileBytes(target);
      const current = decodeUtf8(currentBytes, relativePath);
      const index = current.indexOf(oldText);
      if (index === -1) {
        throw new TextNotFoundError(`Exact text not found in ${relativePath}`);
      }
      const updated = `${current.slice(0, index)}${newText}${current.slice(index + oldText.length)}`;
      await writeFileBytes(target, Buffer.from(updated, "utf8"));
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  // Traverse directories in the secure workspace and return stable, deduplicated relative matches separated by /.
  async globFiles(workspace: string, pattern: string): Promise<readonly string[]> {
    try {
      const root = await workspaceRoot(workspace);
      const parts = relativeParts(pattern, "glob pattern", true);
      const prefix = await literalPrefix(root, parts);
      const normalizedPattern = parts.length === 0 ? "." : parts.join("/");
      const matcher = globRegex(normalizedPattern);
      const start = resolve(root, ...prefix);
      let startInformation: Stats;
      try {
        startInformation = await lstat(start);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return Object.freeze([]);
        }
        throw error;
      }
      if (prefix.length === parts.length) {
        // Return canonical relative paths directly without scanning directories when there are no wildcards.
        return Object.freeze(matcher.test(normalizedPattern) ? [normalizedPattern] : []);
      }
      if (!startInformation.isDirectory() || startInformation.isSymbolicLink()) {
        return Object.freeze([]);
      }
      const results: string[] = [];
      const pending = [start];
      // Dirent.isDirectory() does not follow symlink directories to avoid recursive traversal out of bounds and symlink loops.
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined) {
          continue;
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = join(directory, entry.name);
          const relativePath = relative(root, target).split(sep).join("/");
          if (matcher.test(relativePath)) {
            const resolved = await safePath(root, relativePath);
            if (!isInside(root, resolved)) {
              throw new WorkspacePathError(`Glob match escapes workspace: ${relativePath}`);
            }
            results.push(relativePath);
          }
          if (entry.isDirectory()) {
            pending.push(target);
          }
        }
      }
      return Object.freeze([...new Set(results)].sort());
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }
}
