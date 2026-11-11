import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  readFile as readFileBytes,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";

import { parse } from "yaml";
import { z } from "zod";

import { isWindowsReservedComponent } from "../core/filesystem.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

// Skill directories, tool names, and catalog limits are public boundaries of Skill features.
export const LOAD_SKILL_TOOL_NAME = "load_skill";
export const DEFAULT_SKILLS_DIRECTORY = "skills";
// Upper limit on catalog summary item count to prevent many Skills from consuming the initial system prompt.
export const DEFAULT_MAX_CATALOG_ENTRIES = 100;
// The upper limit for catalog summary in UTF-8 bytes, constraining prompt budget together with item count.
export const DEFAULT_MAX_CATALOG_BYTES = 8_000;
// Maximum allowed length for tool parameters and directory names; overly long names do not enter path resolution.
export const MAX_SKILL_NAME_LENGTH = 64;

// Skill registry exposes only catalog summaries in restricted directories; load_skill must read full content on demand.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SKILL_NAME_REGEXP = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// Validate that name is a legal alphanumeric identifier with hyphens and reject Windows device names.
const loadSkillInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_SKILL_NAME_LENGTH)
      .regex(SKILL_NAME_REGEXP)
      .refine((name) => !isWindowsReservedComponent(name))
      .describe("The exact Skill name from the available catalog."),
  })
  .strict();

// Loading request that passed strict schema, carrying only candidate names appearing in the catalog snapshot.
export type LoadSkillInput = Readonly<z.output<typeof loadSkillInputSchema>>;

// Common base class for Skill domain errors; load_skill handler maps it to stable tool error codes.
export class SkillError extends Error {}

// Path resolution failed or out of bounds. For example, the workspace does not exist, or a symlink escapes the directory.
export class SkillPathError extends SkillError {}

// Missing frontmatter, invalid YAML format, or non-compliant name/description.
export class SkillManifestError extends SkillError {}

// Fail directly when scanning finds multiple Skills using the same name; do not allow silent overwriting.
export class DuplicateSkillError extends SkillError {}

// Request name is invalid, such as exceeding length limits or containing Windows reserved names.
export class SkillNameError extends SkillError {}

// Request name format is valid, but does not exist in the current registry.
export class SkillNotFoundError extends SkillError {}

// The only metadata exposed to the model in the catalog: name and single-line routing description.
export interface SkillSummary {
  // A stable identifier used for tool routing that must match the Skill directory name.
  readonly name: string;
  // Single-line summary used by the model to decide whether to load full text, containing no private instruction content.
  readonly description: string;
}

// Internal records retain logical paths and re-resolve physical paths on explicit loading.
interface SkillRecord extends SkillSummary {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly manifestPath: string;
}

// Scan options control catalog summary boundaries only, not body content or file counts.
export interface SkillScanOptions {
  // Relative root directory within workspace; reject absolute paths and parent segments before scanning.
  readonly skillsDirectory?: string;
  // Maximum number of Skills exposed in the initial catalog.
  readonly maxCatalogEntries?: number;
  // UTF-8 byte budget for the rendered text of the initial catalog.
  readonly maxCatalogBytes?: number;
}

// Parsed Skill document: frontmatter metadata plus SKILL.md body.
interface ParsedSkillDocument extends SkillSummary {
  readonly body: string;
}

// Scanning generates immutable metadata snapshots; revalidate real paths at each layer during loading.
export class SkillRegistry {
  // Record entry points during scanning and validate real paths again on load, preventing links from being replaced after scanning.
  // Normalized workspace root, serving as the common trust boundary for all directories and request contexts.
  readonly #workspaceRoot: string;
  // Validated skills root; loadSkill re-resolves its real path before each use.
  readonly #skillsRoot: string;
  // Full registration records are kept internally only; models can discover available Skills only through names/catalogEntries.
  readonly #records: ReadonlyMap<string, SkillRecord>;
  // Stably sorted snapshot of registered names, for composition roots and tests to enumerate capabilities.
  readonly names: readonly string[];
  // Public summary snapshot restricted by entry and byte budgets.
  readonly catalogEntries: readonly SkillSummary[];
  // Bind read-only tools of this registry workspace; the handler verifies ToolContext ownership.
  readonly toolDefinition: ToolDefinition<LoadSkillInput>;

  private constructor(
    workspaceRoot: string,
    skillsRoot: string,
    records: ReadonlyMap<string, SkillRecord>,
    catalogEntries: readonly SkillSummary[],
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#skillsRoot = skillsRoot;
    this.#records = new Map(records);
    this.names = Object.freeze([...records.keys()].sort());
    this.catalogEntries = Object.freeze(catalogEntries.map((entry) => Object.freeze({ ...entry })));
    this.toolDefinition = Object.freeze({
      name: LOAD_SKILL_TOOL_NAME,
      description: "Load the full instructions for one Skill listed in the workspace catalog.",
      inputSchema: loadSkillInputSchema,
      effect: "read",
      handler: (input: LoadSkillInput, context: ToolContext) => this.#handleLoad(input, context),
    });
  }

  // The scan phase builds immutable snapshots only: fix real paths of workspace and skills roots first,
  // Reads frontmatter item by item next; body and dynamic re-checks are left to loadSkill.
  static scan(workspace: string, options: SkillScanOptions = {}): SkillRegistry {
    // Catalog has item and byte caps to prevent workspace files from expanding the system prompt indefinitely.
    const workspaceRoot = resolveWorkspace(workspace);
    const skillsDirectory =
      options.skillsDirectory === undefined ? DEFAULT_SKILLS_DIRECTORY : options.skillsDirectory;
    const maxCatalogEntries = positiveInteger(
      options.maxCatalogEntries,
      DEFAULT_MAX_CATALOG_ENTRIES,
      "maxCatalogEntries",
    );
    const maxCatalogBytes = positiveInteger(
      options.maxCatalogBytes,
      DEFAULT_MAX_CATALOG_BYTES,
      "maxCatalogBytes",
    );
    const skillsPath = resolveSkillRoot(workspaceRoot, skillsDirectory);
    if (!existsSync(skillsPath)) {
      return new SkillRegistry(workspaceRoot, skillsPath, new Map(), []);
    }

    const skillsRoot = checkedRealDirectory(
      skillsPath,
      workspaceRoot,
      `Skills directory escapes workspace: ${skillsDirectory}`,
    );
    const discovered: SkillRecord[] = [];
    const byName = new Map<string, SkillRecord>();

    for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) =>
      compareSkillNames(left.name, right.name),
    )) {
      const lexicalDirectory = resolve(skillsRoot, entry.name);
      const information = lstatSync(lexicalDirectory);
      if (!information.isDirectory() && !information.isSymbolicLink()) {
        continue;
      }
      const directoryPath = checkedRealDirectory(
        lexicalDirectory,
        skillsRoot,
        `Skill directory escapes Skills root: ${entry.name}`,
      );
      const lexicalManifest = resolve(directoryPath, "SKILL.md");
      if (!existsSync(lexicalManifest)) {
        continue;
      }
      const manifestPath = checkedRealFile(
        lexicalManifest,
        directoryPath,
        `Skill manifest escapes its directory: ${entry.name}`,
      );
      const parsed = parseSkillDocument(readFrontmatter(manifestPath), manifestPath);
      // Save logic entry point; re-parses during explicit loads to discover link replacements after scans.
      const record: SkillRecord = Object.freeze({
        name: parsed.name,
        description: parsed.description,
        directoryName: entry.name,
        directoryPath: lexicalDirectory,
        manifestPath: resolve(lexicalDirectory, "SKILL.md"),
      });
      if (byName.has(record.name)) {
        throw new DuplicateSkillError(`Duplicate Skill name: ${record.name}`);
      }
      byName.set(record.name, record);
      discovered.push(record);
    }

    for (const record of discovered) {
      if (record.name !== record.directoryName) {
        throw new SkillManifestError(
          `Skill name must match its directory: ${record.directoryName}`,
        );
      }
    }

    const ordered = [...byName.values()].sort((left, right) =>
      compareSkillNames(left.name, right.name),
    );
    const catalog = boundedCatalog(ordered, maxCatalogEntries, maxCatalogBytes);
    return new SkillRegistry(
      workspaceRoot,
      skillsRoot,
      new Map(ordered.map((record) => [record.name, record])),
      catalog,
    );
  }

  // The catalog is a plain text summary for the model; it contains only names and descriptions, and bodies never enter this result.
  // Render truncated snapshots as system prompt fragments; trigger no extra file reads.
  renderCatalog(): string {
    return this.catalogEntries
      .map((entry) => `- **${entry.name}**: ${entry.description}`)
      .join("\n");
  }

  // Explicit load: re-resolve real paths of workspace, Skill directory, and manifest.
  // Prevents link replacement or file content changes after scanning.
  // Retrieve the body by name. Confirm the record remains under the original trusted path before success.
  async loadSkill(name: string): Promise<string> {
    // Read request boundary re-resolves physical locations of workspace, Skill directory, and manifest.
    validateSkillName(name);
    const record = this.#records.get(name);
    if (record === undefined) {
      throw new SkillNotFoundError(`Skill not found: ${name}`);
    }

    // load_skill is on the request path, uses async I/O, and re-checks real paths at every level.
    const currentSkillsRoot = await checkedRealDirectoryAsync(
      this.#skillsRoot,
      this.#workspaceRoot,
      "Skills directory escapes workspace",
    );
    const currentDirectory = await checkedRealDirectoryAsync(
      record.directoryPath,
      currentSkillsRoot,
      `Skill directory escapes Skills root: ${name}`,
    );
    const currentManifest = await checkedRealFileAsync(
      record.manifestPath,
      currentDirectory,
      `Skill manifest escapes its directory: ${name}`,
    );
    const document = parseSkillDocument(
      decodeUtf8(await readFileBytes(currentManifest), currentManifest),
      currentManifest,
    );
    if (document.name !== record.name || document.name !== record.directoryName) {
      throw new SkillManifestError(`Skill name must match its directory: ${name}`);
    }
    return document.body;
  }

  // handler validates that tool context and registry belong to the same workspace first, then via loadSkill
  // Read body; classify error codes as domain errors to prevent leaking internal file paths to the model.
  async #handleLoad(input: LoadSkillInput, context: ToolContext): Promise<ToolResult> {
    let contextWorkspace: string;
    try {
      contextWorkspace = await resolveWorkspaceAsync(context.workspace);
    } catch (error) {
      if (error instanceof SkillPathError) {
        return toolError("skill_workspace_error", "Current workspace could not be resolved");
      }
      throw error;
    }
    if (contextWorkspace !== this.#workspaceRoot) {
      return toolError(
        "skill_workspace_mismatch",
        "Skill registry belongs to a different workspace",
      );
    }
    try {
      return toolSuccess(await this.loadSkill(input.name));
    } catch (error) {
      // Map domain exceptions to stable errorCodes; models do not need and should not see internal path details.
      if (error instanceof SkillNotFoundError) {
        return toolError("skill_not_found", "Requested Skill is not registered");
      }
      if (error instanceof SkillPathError) {
        return toolError("skill_path_escape", "Registered Skill path is no longer safe");
      }
      if (error instanceof SkillManifestError) {
        return toolError("invalid_skill", "Registered Skill manifest is invalid");
      }
      return toolError("skill_load_error", "Skill could not be loaded");
    }
  }
}

// Scan option budgets must be positive integers; use chapter defaults when undefined.
function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return selected;
}

// Use realpath in the synchronization phase to get canonical absolute paths, avoiding ambiguity from relative paths and links.
function resolveWorkspace(workspace: string): string {
  let root: string;
  try {
    root = realpathSync.native(workspace);
  } catch {
    throw new SkillPathError(`Workspace does not exist: ${workspace}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new SkillPathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

// Asynchronous phases reuse the same workspace validation to re-resolve tool request paths.
async function resolveWorkspaceAsync(workspace: string): Promise<string> {
  let root: string;
  try {
    root = await realpathAsync(workspace);
  } catch {
    throw new SkillPathError(`Workspace does not exist: ${workspace}`);
  }
  if (!(await statAsync(root)).isDirectory()) {
    throw new SkillPathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

// Skill root must be a relative directory inside workspace; rejects absolute paths, parent traversal, NUL, and reserved components.
function resolveSkillRoot(workspaceRoot: string, skillsDirectory: string): string {
  if (skillsDirectory.length === 0 || skillsDirectory.includes("\0")) {
    throw new SkillPathError("Skills directory must be a non-empty relative path");
  }
  const normalized = skillsDirectory.replaceAll("\\", "/");
  if (
    isAbsolute(skillsDirectory) ||
    win32.isAbsolute(skillsDirectory) ||
    /^[A-Za-z]:/u.test(skillsDirectory) ||
    normalized.startsWith("/")
  ) {
    throw new SkillPathError("Skills directory must be relative to the workspace");
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new SkillPathError("Skills directory must not contain parent segments");
  }
  for (const part of parts) {
    if (isWindowsReservedComponent(part)) {
      throw new SkillPathError(`Skills directory contains a reserved path component: ${part}`);
    }
  }
  const target = resolve(workspaceRoot, ...parts);
  if (!isInside(workspaceRoot, target)) {
    throw new SkillPathError("Skills directory escapes workspace");
  }
  return target;
}

// Synchronous path recheck: realpath must remain inside root, and the target must be a directory.
function checkedRealDirectory(path: string, root: string, message: string): string {
  let physical: string;
  try {
    physical = realpathSync.native(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !statSync(physical).isDirectory()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// Synchronous path recheck: manifest must be a real existing file inside root.
function checkedRealFile(path: string, root: string, message: string): string {
  let physical: string;
  try {
    physical = realpathSync.native(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !statSync(physical).isFile()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// Asynchronous path recheck: recheck directories on load to prevent scanned links from being replaced with escape targets.
async function checkedRealDirectoryAsync(
  path: string,
  root: string,
  message: string,
): Promise<string> {
  let physical: string;
  try {
    physical = await realpathAsync(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !(await statAsync(physical)).isDirectory()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// Asynchronous path recheck: recheck manifests on load to prevent scanned files from being replaced by links.
async function checkedRealFileAsync(path: string, root: string, message: string): Promise<string> {
  let physical: string;
  try {
    physical = await realpathAsync(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !(await statAsync(physical)).isFile()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// Use relative paths to check containment, avoiding false matches from string prefixes between C:\a and C:\ab.
function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

// Read only bytes preceding the frontmatter closing delimiter to avoid decoding full text during scanning.
function readFrontmatter(path: string): string {
  const descriptor = openSync(path, "r");
  const completeLines: Buffer[] = [];
  let pending = Buffer.alloc(0);
  // Chunked read splits by line; lines spanning chunks stay in pending first and return upon reaching end delimiter.
  const chunk = Buffer.allocUnsafe(4_096);
  try {
    while (true) {
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        break;
      }
      let offset = 0;
      while (offset < count) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1 || newline >= count) {
          pending = Buffer.concat([pending, chunk.subarray(offset, count)]);
          break;
        }
        const line = Buffer.concat([pending, chunk.subarray(offset, newline + 1)]);
        pending = Buffer.alloc(0);
        completeLines.push(line);
        if (completeLines.length > 1 && isFrontmatterSeparator(line)) {
          // catalog only decodes frontmatter; the body remains until load_skill is explicitly called.
          return decodeUtf8(Buffer.concat(completeLines), path);
        }
        offset = newline + 1;
      }
    }
    if (pending.byteLength > 0) {
      completeLines.push(pending);
    }
    // Return read content even when missing the second delimiter; parseSkillDocument reports the missing delimiter.
    return decodeUtf8(Buffer.concat(completeLines), path);
  } finally {
    closeSync(descriptor);
  }
}

// Treat only a line with exactly three hyphens as a delimiter, compatible with CRLF line endings.
function isFrontmatterSeparator(line: Buffer): boolean {
  let end = line.byteLength;
  if (end > 0 && line[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end > 0 && line[end - 1] === 0x0d) {
    end -= 1;
  }
  return end === 3 && line[0] === 0x2d && line[1] === 0x2d && line[2] === 0x2d;
}

// Uses fatal TextDecoder; non-UTF-8 content maps directly to SkillManifestError.
function decodeUtf8(bytes: Uint8Array, source: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new SkillManifestError(`Skill manifest is not valid UTF-8: ${source}`);
  }
}

// Split by \n and preserve line endings to help distinguish the boundary between frontmatter and body.
function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

// Strip \n and optional \r\n uniformly so delimiter detection does not depend on newline style.
function stripLineEnding(line: string): string {
  if (line.endsWith("\r\n")) {
    return line.slice(0, -2);
  }
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

// Validate frontmatter format and structure to ensure name and description comply.
function parseSkillDocument(text: string, source: string): ParsedSkillDocument {
  const lines = splitLinesKeepEnds(text);
  if (lines.length === 0 || stripLineEnding(lines[0] as string) !== "---") {
    throw new SkillManifestError(`Skill manifest must begin with YAML frontmatter: ${source}`);
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && stripLineEnding(line) === "---",
  );
  if (closingIndex === -1) {
    throw new SkillManifestError(`Skill manifest has no closing frontmatter delimiter: ${source}`);
  }

  let metadata: unknown;
  try {
    metadata = parse(lines.slice(1, closingIndex).join(""));
  } catch {
    throw new SkillManifestError(`Skill frontmatter is not valid YAML: ${source}`);
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new SkillManifestError(`Skill frontmatter must be a mapping: ${source}`);
  }
  const name = Reflect.get(metadata, "name");
  const description = Reflect.get(metadata, "description");
  if (typeof name !== "string" || typeof description !== "string") {
    throw new SkillManifestError(
      `Skill frontmatter requires string name and description: ${source}`,
    );
  }
  try {
    validateSkillName(name);
  } catch (error) {
    if (error instanceof SkillNameError) {
      throw new SkillManifestError(`Skill frontmatter contains an invalid name: ${source}`);
    }
    throw error;
  }
  const normalizedDescription = description.trim();
  if (
    normalizedDescription.length === 0 ||
    normalizedDescription.includes("\n") ||
    normalizedDescription.includes("\r")
  ) {
    throw new SkillManifestError(`Skill description must be one non-empty line: ${source}`);
  }
  return Object.freeze({
    name,
    description: normalizedDescription,
    // The body retains original line breaks and enters tool result unchanged after explicit loading.
    body: lines.slice(closingIndex + 1).join(""),
  });
}

function validateSkillName(name: string): void {
  // Naming rules constrain directory names and tool parameters, ensuring stable mapping from requested names to files.
  if (
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_REGEXP.test(name) ||
    isWindowsReservedComponent(name)
  ) {
    throw new SkillNameError(`Invalid Skill name: ${name}`);
  }
}

// Sort directories lexicographically to reproduce the catalog in system prompts stably.
function compareSkillNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// Catalog truncates on both item count and UTF-8 byte caps, returning an immutable snapshot.
// separatorBytes accounts for newlines between entries to ensure rendered output does not exceed maxCatalogBytes.
function boundedCatalog(
  records: readonly SkillRecord[],
  maxEntries: number,
  maxBytes: number,
): readonly SkillSummary[] {
  const catalog: SkillSummary[] = [];
  let usedBytes = 0;
  for (const record of records) {
    if (catalog.length >= maxEntries) {
      break;
    }
    const line = `- **${record.name}**: ${record.description}`;
    const separatorBytes = catalog.length === 0 ? 0 : 1;
    const entryBytes = Buffer.byteLength(line, "utf8") + separatorBytes;
    if (usedBytes + entryBytes > maxBytes) {
      break;
    }
    catalog.push(Object.freeze({ name: record.name, description: record.description }));
    usedBytes += entryBytes;
  }
  return Object.freeze(catalog);
}
