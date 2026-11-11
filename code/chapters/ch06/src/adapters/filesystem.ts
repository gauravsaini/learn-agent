// Node.js file system adapter: normalizes workspace read, write, edit, and glob into core interfaces.
// Paths always enter from workspace-relative paths, and platform errors translate uniformly into domain errors.
// Node.js file system adapter: normalizes platform capabilities into the WorkspaceFileSystem interface.
// Path safety is verified via safePath, rejecting absolute paths, drive letters, parent directories, and symlink out-of-bounds.
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

// Windows device names cannot serve as normal path components, even with extensions.
const WINDOWS_DEVICE_NAMES = new Set(["AUX", "CLOCK$", "CON", "CONIN$", "CONOUT$", "NUL", "PRN"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

// Platform errnos converge into domain errors that core can stably map to models.
// Node.js file system adapter: normalizes platform capabilities into the WorkspaceFileSystem interface.
// Paths always enter from workspace-relative paths; errors normalize uniformly to domain errors mappable by core.
function translateFileSystemError(error: unknown): Error {
  // Adapter converges platform errno into domain errors that core can stably map for the model.
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

// All paths enter as relative paths, rejecting drive letters, absolute paths, and parent directories at lexical analysis first.
function isInside(root: string, candidate: string): boolean {
  // An empty relative path indicates that candidate is root; others must start with a non-absolute subpath other than ..
  const child = relative(root, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function isWindowsReservedComponent(component: string): boolean {
  // Trailing spaces/dots, control characters, and Windows path special characters are not permitted in normal file components.
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

function relativeParts(value: string, label: string, allowWildcards: boolean): string[] {
  // All paths enter as relative paths, rejecting drive letters, absolute paths, and parent directories at lexical analysis first.
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

async function workspaceRoot(workspace: string): Promise<string> {
  // realpath resolves the workspace itself first; subsequent safePath calls compute boundaries against the real root directory.
  const root = await realpath(workspace);
  const information = await stat(root);
  if (!information.isDirectory()) {
    throw new InvalidFilePathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

async function resolvedExistingParent(
  root: string,
  target: string,
): Promise<{ physical: string; lexical: string }> {
  // Traverses upward from target to find existing parent path, resolves real path, then appends non-existent tail to prevent symlink escape.
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

export async function safePath(workspace: string, relativePath: string): Promise<string> {
  try {
    const root = await workspaceRoot(workspace);
    // Performs lexical checks first, rejecting absolute paths, .., Windows reserved names, and illegal characters.
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

function decodeUtf8(bytes: Uint8Array, relativePath: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new InvalidUtf8Error(`File is not valid UTF-8: ${relativePath}`);
  }
}

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

// Implements only *, **, ?, and character classes required by the tool contract, without passing unvalidated patterns to Shell.
function globRegex(pattern: string): RegExp {
  // Implements only *, **, ?, and character classes required by the tool contract, without passing unvalidated patterns to Shell.
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

async function literalPrefix(root: string, parts: readonly string[]): Promise<readonly string[]> {
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

export class NodeWorkspaceFileSystem implements WorkspaceFileSystem {
  async isPathWithinWorkspace(workspace: string, relativePath: string): Promise<boolean> {
    try {
      await safePath(workspace, relativePath);
      return true;
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return false;
      }
      throw error;
    }
  }

  async readFile(workspace: string, relativePath: string, limit?: number): Promise<string> {
    try {
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new RangeError("limit must be a positive integer");
      }
      const target = await safePath(workspace, relativePath);
      const text = decodeUtf8(await readFileBytes(target), relativePath);
      const lines = splitLines(text);
      if (limit !== undefined && limit < lines.length) {
        // Truncation notices retain total line counts; callers can decide whether to continue reading.
        return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
      }
      return lines.join("\n");
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  async writeFile(workspace: string, relativePath: string, content: string): Promise<number> {
    try {
      const target = await safePath(workspace, relativePath);
      const bytes = Buffer.from(content, "utf8");
      await mkdir(dirname(target), { recursive: true });
      await writeFileBytes(target, bytes);
      return bytes.byteLength;
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  async editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void> {
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
      // Replace only the first exact match to prevent edits proposed by the model from affecting multiple locations.
      const updated = `${current.slice(0, index)}${newText}${current.slice(index + oldText.length)}`;
      await writeFileBytes(target, Buffer.from(updated, "utf8"));
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

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
