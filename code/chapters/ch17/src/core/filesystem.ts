// The file adapter normalizes cross-platform errors into domain errors that the tool layer can handle stably.
export class WorkspacePathError extends Error {}

export class TextNotFoundError extends Error {}

export class InvalidUtf8Error extends Error {}

export class FileNotFoundError extends Error {}

export class InvalidFilePathError extends Error {}

export class FileSystemOperationError extends Error {}

// Windows device names cannot serve as normal path components, even with extensions.
const WINDOWS_DEVICE_NAMES = new Set(["AUX", "CLOCK$", "CON", "CONIN$", "CONOUT$", "NUL", "PRN"]);

// This check is shared by file adapters and Skill path boundaries, preventing components from implementing Windows device name rules separately.
export function isWindowsReservedComponent(component: string): boolean {
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
  const firstPart = component.split(".", 1)[0];
  if (firstPart === undefined) {
    return false;
  }
  const stem = firstPart.replace(/ +$/u, "").toUpperCase();
  if (WINDOWS_DEVICE_NAMES.has(stem)) {
    return true;
  }
  const suffix = stem[3];
  return (
    suffix !== undefined &&
    stem.length === 4 &&
    (stem.startsWith("COM") || stem.startsWith("LPT")) &&
    "123456789¹²³".includes(suffix)
  );
}

// The permission layer depends only on this narrow interface to check write boundaries, avoiding reverse dependencies on concrete file implementations.
export interface WorkspaceWriteBoundary {
  isPathWithinWorkspace(workspace: string, relativePath: string): Promise<boolean>;
}

// Declares only workspace file capabilities required by Agent tools.
// SkillRegistry reuses the reserved component check in this file, but SKILL.md scanning bypasses this adapter:
// It must control byte-by-byte reading of frontmatter and asynchronously recheck real paths on load.
export interface WorkspaceFileSystem extends WorkspaceWriteBoundary {
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
