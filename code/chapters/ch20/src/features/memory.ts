// Persistent memory: manage cross-session memory using manifests with file locks and markdown records, completing lifecycles via model selection, extraction, and merging.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { lock as acquireFileLock } from "proper-lockfile";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { isWindowsReservedComponent } from "../core/filesystem.js";
import {
  assistantMessage,
  systemMessage,
  toolCall,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "../core/messages.js";
import type { ChatMessage, ToolCall } from "../core/messages.js";
import type { ModelClient } from "../core/model.js";

// memory.ts handles Chapter 9 file-level memory: safe recording, authoritative manifest set, model side-queries, and turn lifecycles.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMORY_FILENAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]+/gu;
// Set budgets for single memories and derived catalogs to prevent memory files from blowing up the context.
const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 4_096;
// Lock parameters: Short retries avoid busy-waiting, while stale/update leave leftover crash locks to proper-lockfile.
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
// In-process mutex tail chain: Concurrent turns in the same process queue first before attempting cross-process file locks.
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

// All three side-query outputs pass directly into JSON.parse(), without fence stripping or substring extraction;
// Therefore the system prompt must explicitly forbid Markdown code fences and explanations to reduce the likelihood of models adding fences.
const NO_FENCE_INSTRUCTION =
  "Output pure JSON text directly. Do not wrap with Markdown code blocks or backticks. Do not output any explanatory text.";
const SELECTOR_SYSTEM_PROMPT = `Select memory names directly related to query from catalog.
Must return only a JSON array of strings, do not call tools; returns [] when there are no relevant items.
${NO_FENCE_INSTRUCTION}`;
const EXTRACTOR_SYSTEM_PROMPT = `Extract new memories from conversation that are worth keeping across sessions.
Must return only a JSON array, do not call tools. Each item must strictly and only contain name, type, description, and body;
type can only be user, feedback, project, or reference; returns [] when there are no new memories.
name must be a safe lowercase slug: only lowercase letters and digits are allowed; separate multiple words with a single hyphen -; no underscores, spaces, uppercase letters, or Chinese characters.
${NO_FENCE_INSTRUCTION}`;
const CONSOLIDATOR_SYSTEM_PROMPT = `Consolidate given memories, merge duplicate or conflicting content, do not call tools.
Must return only a JSON object, containing strictly and only source_names and records;
source_names are replaced original memory names, and records is a non-empty array of new memories.
${NO_FENCE_INSTRUCTION}`;

export class MemoryStoreError extends Error {
  // Maintain names, indexes, and bodies of file memories as a persistent collection protected by locks.
  override readonly name: string = "MemoryStoreError";
}

export const MemoryType = Object.freeze({
  USER: "user",
  FEEDBACK: "feedback",
  PROJECT: "project",
  REFERENCE: "reference",
} as const);

// Memory category is used for stable routing during selection and consolidation; models cannot write other types.
export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

// MemoryRecord is an immutable value object; name directly determines file name, so it validates safe slug rules before persisting to disk.
export interface MemoryRecordOptions {
  // slug serves as both logical name and part of the file name; it must remain stable and safe.
  readonly name: string;
  // A single-line summary displayed in the catalog index.
  readonly description: string;
  // Convenient for categorizing by user preference, feedback, project, or reference materials.
  readonly kind: MemoryType;
  // Memory body, with line breaks normalized and size budget enforced before serialization.
  readonly body: string;
}

export class MemoryRecord {
  readonly name: string;
  readonly description: string;
  readonly kind: MemoryType;
  readonly body: string;

  constructor(options: MemoryRecordOptions) {
    if (
      typeof options.name !== "string" ||
      !SLUG_PATTERN.test(options.name) ||
      isWindowsReservedComponent(options.name)
    ) {
      throw new MemoryStoreError("memory name must be a safe lowercase slug");
    }
    if (typeof options.description !== "string" || options.description.trim().length === 0) {
      throw new MemoryStoreError("memory description must be a non-empty string");
    }
    if (options.description.includes("\n") || options.description.includes("\r")) {
      throw new MemoryStoreError("memory description must fit on one line");
    }
    if (!isMemoryType(options.kind)) {
      throw new MemoryStoreError("memory kind must be MemoryType");
    }
    if (typeof options.body !== "string" || options.body.trim().length === 0) {
      throw new MemoryStoreError("memory body must be a non-empty string");
    }

    this.name = options.name;
    this.description = options.description;
    this.kind = options.kind;
    this.body = stripOuterNewlines(options.body.replace(/\r\n|\r/gu, "\n"));
    const serialized = serializeMemory(this);
    enforceMemoryBudget(serialized);
    Object.freeze(this);
  }
}

export interface MemorySelector {
  select(query: string, catalog: string): Promise<string>;
}

export interface MemoryExtractor {
  extract(history: readonly ChatMessage[], catalog: string): Promise<string>;
}

export interface MemoryConsolidator {
  consolidate(records: readonly MemoryRecord[]): Promise<string>;
}

// Selection, extraction, and consolidation are all called through the same tool-free model boundary; output must be complete JSON/text.
export class ModelMemoryQueries implements MemorySelector, MemoryExtractor, MemoryConsolidator {
  readonly #model: ModelClient;

  constructor(model: ModelClient) {
    if (typeof model?.complete !== "function") {
      throw new TypeError("model must implement ModelClient");
    }
    this.#model = model;
  }

  async select(query: string, catalog: string): Promise<string> {
    return await this.#complete([
      systemMessage(SELECTOR_SYSTEM_PROMPT),
      userMessage(stableJson({ catalog, query })),
    ]);
  }

  async extract(history: readonly ChatMessage[], catalog: string): Promise<string> {
    const snapshot = copyHistory(history);
    validateToolPairing(snapshot);
    return await this.#complete([
      systemMessage(EXTRACTOR_SYSTEM_PROMPT),
      ...snapshot,
      userMessage(stableJson({ existing_catalog: catalog })),
    ]);
  }

  async consolidate(records: readonly MemoryRecord[]): Promise<string> {
    const snapshot = validateRecordCollection(records, false);
    return await this.#complete([
      systemMessage(CONSOLIDATOR_SYSTEM_PROMPT),
      userMessage(stableJson(snapshot.map(memoryRecordPayload))),
    ]);
  }

  async #complete(messages: readonly ChatMessage[]): Promise<string> {
    // All three memory side-queries enforce no tools, stop, and non-empty full text; callers handle JSON parsing.
    const reply = await this.#model.complete(
      Object.freeze({ messages: Object.freeze([...messages]), tools: Object.freeze([]) }),
    );
    if (reply.message.toolCalls.length > 0) {
      throw new MemoryStoreError("memory model must not call tools");
    }
    if (reply.finishReason !== "stop") {
      throw new MemoryStoreError(
        `memory model finishReason must be stop, got ${reply.finishReason}`,
      );
    }
    const content = reply.message.content;
    if (content === null || content.trim().length === 0) {
      throw new MemoryStoreError("memory model must return non-empty text");
    }
    return content;
  }
}

interface StoredMemory {
  readonly filename: string;
  readonly record: MemoryRecord;
}

interface ConsolidationPlan {
  readonly sourceNames: readonly string[];
  readonly records: readonly MemoryRecord[];
}

// Three persistent files: manifest is the authoritative pointer, MEMORY.md is the rebuildable catalog, and *.md stores content; .lock is used only for cross-process mutexes.
interface MemoryStorePaths {
  readonly workspace: string;
  readonly root: string;
  readonly manifest: string;
  readonly index: string;
  readonly lock: string;
}

export interface MemoryStoreOptions {
  // All .memory files belong to this workspace; cannot read across workspaces.
  readonly workspace: string;
  // A slug factory that generates record file suffixes, which tests can fix.
  readonly idGenerator?: () => string;
  // Upper bound of line count for the derived MEMORY.md index.
  readonly maxIndexLines?: number;
  // Upper bound of UTF-8 bytes for the derived MEMORY.md index.
  readonly maxIndexBytes?: number;
}

export interface ApplyConsolidationOptions {
  readonly baseRecords: readonly MemoryRecord[];
  readonly additions: readonly MemoryRecord[];
  readonly sourceNames: readonly string[];
  readonly replacements: readonly MemoryRecord[];
}

// MemoryStore is the sole transactional entry point for the memory collection; all read-modify-writes serialize via in-process queue and file locks.
export class MemoryStore {
  // Access passes through in-process mutexes and cross-process file locks to prevent concurrent turns from corrupting index and record consistency.
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #maxIndexLines: number;
  readonly #maxIndexBytes: number;

  constructor(options: MemoryStoreOptions) {
    if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    const maxIndexLines = options.maxIndexLines === undefined ? 200 : options.maxIndexLines;
    const maxIndexBytes = options.maxIndexBytes === undefined ? 4_096 : options.maxIndexBytes;
    requirePositiveInteger("maxIndexLines", maxIndexLines);
    requirePositiveInteger("maxIndexBytes", maxIndexBytes);
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }

    this.#workspaceInput = options.workspace;
    this.#idGenerator = options.idGenerator === undefined ? randomMemoryId : options.idGenerator;
    this.#maxIndexLines = maxIndexLines;
    this.#maxIndexBytes = maxIndexBytes;
  }

  // Read records: treat missing root directory as empty collection; if present, validate boundary first, then load by manifest within lock.
  async records(): Promise<readonly MemoryRecord[]> {
    // Read entry point: treat missing directory as empty collection; if present, validate root directory first, then reread collection by manifest within lock.
    const paths = await this.#resolvePaths();
    if (!(await pathExists(paths.root))) {
      return Object.freeze([]);
    }
    await this.#validateRoot(paths);
    return await this.#withLock(paths, async () =>
      Object.freeze((await this.#loadStored(paths)).map((item) => item.record)),
    );
  }

  // Render directory: read only lightweight indices, and do not concatenate bodies into the model context.
  async renderCatalog(): Promise<string> {
    // Directory entries only return name, file name, and single-line description; the selector does not read full bodies directly.
    const paths = await this.#resolvePaths();
    if (!(await pathExists(paths.root))) {
      return "";
    }
    await this.#validateRoot(paths);
    return await this.#withLock(paths, async () =>
      this.#renderIndex(await this.#loadStored(paths)),
    );
  }

  async add(record: MemoryRecord): Promise<void> {
    await this.extend([record]);
  }

  // Add memory: reject duplicate names first, write the body exclusively, and finally atomically commit manifest and MEMORY.md.
  async extend(records: readonly MemoryRecord[]): Promise<void> {
    // extend() appends new names only; duplicate writes of the same name fail within the lock to avoid silently overwriting existing memories.
    const validated = validateRecordCollection(records, true);
    if (validated.length === 0) {
      return;
    }
    const paths = await this.#resolvePaths();
    await this.#prepareRoot(paths);
    await this.#withLock(paths, async () => {
      const current = await this.#loadStored(paths);
      const currentNames = new Set(current.map((item) => item.record.name));
      const duplicates = validated
        .map((record) => record.name)
        .filter((name) => currentNames.has(name));
      if (duplicates.length > 0) {
        throw new MemoryStoreError(
          `memory names already exist: ${[...duplicates].sort().join(", ")}`,
        );
      }

      const filenames = validated.map((record) => this.#newFilename(record.name));
      const candidate = [
        ...current,
        ...validated.map((record, index): StoredMemory => {
          const filename = filenames[index];
          if (filename === undefined) {
            throw new MemoryStoreError("memory filename generation failed");
          }
          return Object.freeze({ filename, record });
        }),
      ];
      const index = this.#renderIndex(candidate);
      const written = await this.#writeRecordFiles(
        paths,
        validated.map((record, recordIndex) => {
          const filename = filenames[recordIndex];
          if (filename === undefined) {
            throw new MemoryStoreError("memory filename generation failed");
          }
          return Object.freeze({ filename, record });
        }),
      );
      try {
        await this.#commit(paths, candidate, index);
      } catch (error) {
        await removePaths(written);
        throw error;
      }
    });
  }

  // Merge memories: verify base has not drifted, write and commit new files, and delete replaced old files only after success.
  async applyConsolidation(options: ApplyConsolidationOptions): Promise<void> {
    // Compaction transaction: reread manifest in the lock and fail immediately if baseRecords changed; clean up replaced old files only after commit.
    const base = validateRecordCollection(options.baseRecords, true);
    const additions = validateRecordCollection(options.additions, true);
    const replacements = validateRecordCollection(options.replacements, false);
    const candidates = validateRecordCollection([...base, ...additions], true);
    validateConsolidationSources(options.sourceNames, candidates);

    const paths = await this.#resolvePaths();
    await this.#prepareRoot(paths);
    await this.#withLock(paths, async () => {
      const current = await this.#loadStored(paths);
      const currentByName = new Map(current.map((item) => [item.record.name, item]));
      if (
        base.some((record) => {
          const stored = currentByName.get(record.name);
          return stored === undefined || !recordsEqual(stored.record, record);
        })
      ) {
        throw new MemoryStoreError("memory collection changed during consolidation");
      }

      const sourceSet = new Set(options.sourceNames);
      const retained = current.filter((item) => !sourceSet.has(item.record.name));
      const pending = [
        ...additions.filter((record) => !sourceSet.has(record.name)),
        ...replacements,
      ];
      validateRecordCollection([...retained.map((item) => item.record), ...pending], false);
      const additionsToStore = pending.map(
        (record): StoredMemory =>
          Object.freeze({ filename: this.#newFilename(record.name), record }),
      );
      const candidate = [...retained, ...additionsToStore];
      const index = this.#renderIndex(candidate);
      const written = await this.#writeRecordFiles(paths, additionsToStore);
      try {
        await this.#commit(paths, candidate, index);
      } catch (error) {
        await removePaths(written);
        throw error;
      }

      await Promise.all(
        current
          .filter((item) => sourceSet.has(item.record.name))
          .map((item) => rm(join(paths.root, item.filename), { force: true })),
      );
    });
  }

  // Fix the workspace with realpath first before constructing paths under .memory to prevent relative path drift.
  async #resolvePaths(): Promise<MemoryStorePaths> {
    const workspace = await realpath(this.#workspaceInput);
    if (!(await stat(workspace)).isDirectory()) {
      throw new TypeError(`workspace is not a directory: ${this.#workspaceInput}`);
    }
    const root = join(workspace, ".memory");
    return Object.freeze({
      workspace,
      root,
      manifest: join(root, "manifest.json"),
      index: join(root, "MEMORY.md"),
      lock: join(root, ".lock"),
    });
  }

  async #prepareRoot(paths: MemoryStorePaths): Promise<void> {
    await mkdir(paths.root, { recursive: true });
    await this.#validateRoot(paths);
  }

  async #validateRoot(paths: MemoryStorePaths): Promise<void> {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(paths.root);
    } catch (error) {
      throw new MemoryStoreError("memory root could not be resolved", { cause: error });
    }
    if (resolvedRoot !== paths.root || !pathIsInside(paths.workspace, resolvedRoot)) {
      throw new MemoryStoreError("memory root escapes workspace");
    }
    if (!(await stat(resolvedRoot)).isDirectory()) {
      throw new MemoryStoreError("memory root is not a directory");
    }
  }

  // Two layers of locks: in-process mutex queues tasks in the same process, and proper-lockfile serializes file transactions across processes.
  async #withLock<T>(paths: MemoryStorePaths, operation: () => Promise<T>): Promise<T> {
    return await withProcessMutex(paths.root, async () =>
      this.#withCrossProcessLock(paths, operation),
    );
  }

  // .lock is managed by proper-lockfile; stale/update parameters handle lock recovery after crashes.
  async #withCrossProcessLock<T>(paths: MemoryStorePaths, operation: () => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    let windowsRaceRetries = 0;
    while (true) {
      try {
        release = await acquireFileLock(paths.root, {
          lockfilePath: paths.lock,
          realpath: true,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
          retries: 0,
        });
        break;
      } catch (error) {
        if (isWindowsLockRace(error) && windowsRaceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
          windowsRaceRetries += 1;
          await delay(LOCK_RETRY_MS);
          continue;
        }
        if (!hasErrorCode(error, "EEXIST")) {
          if (!hasErrorCode(error, "ELOCKED")) {
            throw error;
          }
        }
        await delay(LOCK_RETRY_MS);
      }
    }
    try {
      await this.#validateRoot(paths);
      return await operation();
    } finally {
      await release();
    }
  }

  // Append a unique ID to file names so submitting new collections does not overwrite older records of the same name.
  #newFilename(name: string): string {
    const identifier = this.#idGenerator();
    if (typeof identifier !== "string" || !SLUG_PATTERN.test(identifier)) {
      throw new MemoryStoreError("generated memory id must be a safe lowercase slug");
    }
    return `${name}-${identifier}.md`;
  }

  async #writeRecordFiles(
    paths: MemoryStorePaths,
    records: readonly StoredMemory[],
  ): Promise<readonly string[]> {
    // Use "wx" to create the record file exclusively, write and fsync, then read back to validate, cleaning up files on failure.
    const written: string[] = [];
    try {
      for (const item of records) {
        const path = join(paths.root, item.filename);
        let handle: FileHandle;
        try {
          handle = await open(path, "wx");
        } catch (error) {
          if (hasErrorCode(error, "EEXIST")) {
            throw new MemoryStoreError(`memory file already exists: ${item.filename}`, {
              cause: error,
            });
          }
          throw error;
        }
        written.push(path);
        try {
          await handle.writeFile(serializeMemory(item.record));
          await handle.sync();
        } finally {
          await handle.close();
        }
        const verified = parseMemory(await readFile(path));
        if (!recordsEqual(verified, item.record)) {
          throw new MemoryStoreError(`memory file verification failed: ${item.filename}`);
        }
      }
    } catch (error) {
      await removePaths(written);
      throw error;
    }
    return Object.freeze(written);
  }

  async #commit(
    paths: MemoryStorePaths,
    records: readonly StoredMemory[],
    index: string,
  ): Promise<void> {
    // Atomically replaces rebuildable MEMORY.md first, then atomically replaces authoritative manifest; rolls back index on failure.
    const manifest = Buffer.from(
      JSON.stringify({ version: 1, files: records.map((item) => item.filename) }),
      "utf8",
    );
    const previousIndex = (await pathExists(paths.index)) ? await readFile(paths.index) : undefined;
    await atomicReplace(paths.index, Buffer.from(index, "utf8"));
    try {
      await atomicReplace(paths.manifest, manifest);
    } catch (error) {
      if (previousIndex === undefined) {
        await rm(paths.index, { force: true });
      } else {
        await atomicReplace(paths.index, previousIndex);
      }
      throw error;
    }
  }

  async #loadStored(paths: MemoryStorePaths): Promise<readonly StoredMemory[]> {
    // The read end does not trust directory scans, re-validating manifest, file name, realpath, and each record instead.
    if (!(await pathExists(paths.manifest))) {
      return Object.freeze([]);
    }
    let manifest: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(paths.manifest));
      manifest = JSON.parse(text);
    } catch (error) {
      throw new MemoryStoreError("memory manifest is not valid UTF-8 JSON", { cause: error });
    }
    if (!isStrictManifest(manifest)) {
      throw new MemoryStoreError("memory manifest has an invalid schema");
    }
    if (new Set(manifest.files).size !== manifest.files.length) {
      throw new MemoryStoreError("memory manifest filenames must be unique");
    }
    if (manifest.files.length > this.#maxIndexLines) {
      throw new MemoryStoreError("memory manifest exceeds the index line limit");
    }

    const stored: StoredMemory[] = [];
    for (const filename of manifest.files) {
      if (!MEMORY_FILENAME_PATTERN.test(filename) || isWindowsReservedComponent(filename)) {
        throw new MemoryStoreError(`memory manifest contains an unsafe filename: ${filename}`);
      }
      const path = join(paths.root, filename);
      let resolvedPath: string;
      try {
        resolvedPath = await realpath(path);
      } catch (error) {
        throw new MemoryStoreError(`memory file could not be read: ${filename}`, { cause: error });
      }
      if (!pathIsInside(paths.root, resolvedPath)) {
        throw new MemoryStoreError(`memory file escapes the store: ${filename}`);
      }
      let record: MemoryRecord;
      try {
        record = parseMemory(await readFile(resolvedPath));
      } catch (error) {
        if (error instanceof MemoryStoreError) {
          throw error;
        }
        throw new MemoryStoreError(`memory file could not be read: ${filename}`, { cause: error });
      }
      stored.push(Object.freeze({ filename, record }));
    }
    return Object.freeze(stored);
  }

  #renderIndex(records: readonly StoredMemory[]): string {
    // MEMORY.md retains only name, file name, and single-line description as a lightweight catalog for selector.
    if (records.length > this.#maxIndexLines) {
      throw new MemoryStoreError("memory index exceeds the index line limit");
    }
    const index = records
      .map((item) => `- [${item.record.name}](${item.filename}) - ${item.record.description}`)
      .join("\n");
    const rendered = index.length === 0 ? "" : `${index}\n`;
    if (Buffer.byteLength(rendered, "utf8") > this.#maxIndexBytes) {
      throw new MemoryStoreError("memory index exceeds the index byte limit");
    }
    return rendered;
  }
}

// MemorySession wraps MemoryStore into a turn lifecycle callable by AgentRunner.
export interface MemorySessionOptions {
  readonly store: MemoryStore;
  readonly selector?: MemorySelector;
  readonly extractor?: MemoryExtractor;
  readonly consolidator?: MemoryConsolidator;
  readonly maxSelected?: number;
  readonly consolidateThreshold?: number;
  readonly emitContextMessages?: boolean;
}

export class MemorySession {
  // The lifecycle selects relevant memories before a turn, extracts and merges them after a turn, and the model never writes files directly.
  readonly #store: MemoryStore;
  readonly #selector: MemorySelector | undefined;
  readonly #extractor: MemoryExtractor | undefined;
  readonly #consolidator: MemoryConsolidator | undefined;
  readonly #maxSelected: number;
  readonly #consolidateThreshold: number;
  readonly #emitContextMessages: boolean;
  // Read-only snapshot selected for the current turn; next turn beginTurn will replace completely.
  #selected: readonly MemoryRecord[] = Object.freeze([]);
  // Memory side-query or persistence failures are only logged here and do not block the main Agent response.
  #lastError: string | undefined;

  constructor(options: MemorySessionOptions) {
    const maxSelected = options.maxSelected === undefined ? 5 : options.maxSelected;
    const consolidateThreshold =
      options.consolidateThreshold === undefined ? 10 : options.consolidateThreshold;
    requirePositiveInteger("maxSelected", maxSelected);
    requirePositiveInteger("consolidateThreshold", consolidateThreshold);
    this.#store = options.store;
    this.#selector = options.selector;
    this.#extractor = options.extractor;
    this.#consolidator = options.consolidator;
    this.#maxSelected = maxSelected;
    this.#consolidateThreshold = consolidateThreshold;
    this.#emitContextMessages =
      options.emitContextMessages === undefined ? true : options.emitContextMessages;
  }

  get selected(): readonly MemoryRecord[] {
    return this.#selected;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  // Read the current set at turn start; fall back to deterministic keywords when model selection fails to prevent memory issues from interrupting main tasks.
  // Select relevant memories before the turn; fall back to deterministic keyword matching when model selection fails.
  async beginTurn(query: string): Promise<void> {
    const records = await this.#store.records();
    this.#selected = Object.freeze([]);
    this.#lastError = undefined;
    if (records.length === 0) {
      return;
    }

    if (this.#selector !== undefined) {
      try {
        const output = await this.#selector.select(query, await this.#store.renderCatalog());
        const names = parseSelectedNames(output);
        const byName = new Map(records.map((record) => [record.name, record]));
        if (names.some((name) => !byName.has(name))) {
          throw new MemoryStoreError("selector returned an unknown memory name");
        }
        this.#selected = Object.freeze(
          names.slice(0, this.#maxSelected).map((name) => {
            const selected = byName.get(name);
            if (selected === undefined) {
              throw new MemoryStoreError("selector returned an unknown memory name");
            }
            return selected;
          }),
        );
        return;
      } catch {
        this.#lastError = "Memory selection failed; deterministic fallback used";
      }
    }
    this.#selected = keywordSelect(query, records, this.#maxSelected);
  }

  // Attach selected memories only as system context to the next model request; do not write to canonical history.
  beforeModel(): readonly ChatMessage[] {
    if (!this.#emitContextMessages || this.#selected.length === 0) {
      return Object.freeze([]);
    }
    return Object.freeze([systemMessage(this.renderSelected())]);
  }

  renderSelected(): string {
    if (this.#selected.length === 0) {
      return "";
    }
    const sections = ["<relevant_memories>"];
    for (const record of this.#selected) {
      sections.push(`## ${record.name} (${record.kind})`, record.description, record.body);
    }
    sections.push("</relevant_memories>");
    return sections.join("\n\n");
  }

  // Extract with complete canonical history at turn end; record only lastError on extract, organize, or write failure without modifying the existing set.
  // Extract, append, or organize memories from complete canonical history at turn end.
  async complete(history: readonly ChatMessage[]): Promise<void> {
    const current = await this.#store.records();
    let candidate = current;
    let extracted: readonly MemoryRecord[] = Object.freeze([]);
    if (this.#extractor !== undefined) {
      try {
        const snapshot = copyHistory(history);
        const output = await this.#extractor.extract(snapshot, await this.#store.renderCatalog());
        extracted = parseRecordList(output, true);
        candidate = validateRecordCollection([...current, ...extracted], true);
      } catch {
        this.#lastError = "Memory extraction failed";
        return;
      }
    }

    if (this.#consolidator === undefined || candidate.length < this.#consolidateThreshold) {
      if (extracted.length > 0) {
        try {
          await this.#store.extend(extracted);
        } catch {
          this.#lastError = "Memory extraction failed";
        }
      }
      return;
    }

    try {
      const output = await this.#consolidator.consolidate(candidate);
      const plan = parseConsolidationPlan(output, candidate);
      await this.#store.applyConsolidation({
        baseRecords: current,
        additions: extracted,
        sourceNames: plan.sourceNames,
        replacements: plan.records,
      });
    } catch {
      this.#lastError = "Memory consolidation failed";
    }
  }
}

function isMemoryType(value: unknown): value is MemoryType {
  return Object.values(MemoryType).some((kind) => kind === value);
}

// Each memory is a separate Markdown file: frontmatter provides searchable metadata and the body stores full details.
function serializeMemory(record: MemoryRecord): Buffer {
  const metadata = stringifyYaml({
    name: record.name,
    description: record.description,
    type: record.kind,
  }).trimEnd();
  return Buffer.from(`---\n${metadata}\n---\n\n${record.body}\n`, "utf8");
}

function parseMemory(raw: Buffer): MemoryRecord {
  enforceMemoryBudget(raw);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new MemoryStoreError("memory file is not valid UTF-8", { cause: error });
  }
  const lines = text.split(/\r\n|\r|\n/gu);
  if (lines[0] !== "---") {
    throw new MemoryStoreError("memory file is missing YAML frontmatter");
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    throw new MemoryStoreError("memory file has unclosed YAML frontmatter");
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(lines.slice(1, end).join("\n"));
  } catch (error) {
    throw new MemoryStoreError("memory frontmatter is invalid YAML", { cause: error });
  }
  if (!hasExactKeys(metadata, ["name", "description", "type"])) {
    throw new MemoryStoreError("memory frontmatter has an invalid schema");
  }
  try {
    return new MemoryRecord({
      name: requireStringField(metadata.name, "name"),
      description: requireStringField(metadata.description, "description"),
      kind: requireMemoryTypeField(metadata.type),
      body: stripOuterNewlines(lines.slice(end + 1).join("\n")),
    });
  } catch (error) {
    if (error instanceof MemoryStoreError) {
      throw error;
    }
    throw new MemoryStoreError("memory frontmatter fields have invalid types", { cause: error });
  }
}

// Budget constrains both serialization and original files after reading; manually enlarged memories are also rejected.
function enforceMemoryBudget(raw: Buffer): void {
  if (countLines(raw) > MAX_MEMORY_LINES) {
    throw new MemoryStoreError(`memory file must not exceed ${MAX_MEMORY_LINES} lines`);
  }
  if (raw.byteLength > MAX_MEMORY_BYTES) {
    throw new MemoryStoreError(`memory file must not exceed ${MAX_MEMORY_BYTES} UTF-8 bytes`);
  }
}

function countLines(raw: Buffer): number {
  if (raw.byteLength === 0) {
    return 0;
  }
  const text = raw.toString("latin1");
  const pieces = text.split(/\r\n|\r|\n/gu);
  return pieces.at(-1) === "" ? pieces.length - 1 : pieces.length;
}

function stripOuterNewlines(value: string): string {
  return value.replace(/^\n+|\n+$/gu, "");
}

// Collection-level contract: Accepts only MemoryRecord with unique names; whether an empty collection is valid depends on the call scenario.
function validateRecordCollection(
  records: readonly MemoryRecord[],
  allowEmpty: boolean,
): readonly MemoryRecord[] {
  if (!Array.isArray(records) || !records.every((record) => record instanceof MemoryRecord)) {
    throw new MemoryStoreError("memory collection must contain MemoryRecord values");
  }
  if (!allowEmpty && records.length === 0) {
    throw new MemoryStoreError("memory collection must not be empty");
  }
  const names = records.map((record) => record.name);
  if (new Set(names).size !== names.length) {
    throw new MemoryStoreError("memory names must be unique");
  }
  return Object.freeze([...records]);
}

// Model output must parse entirely as JSON; do not extract substrings from code fences or explanatory text.
function parseRecordList(output: string, allowEmpty: boolean): readonly MemoryRecord[] {
  if (typeof output !== "string") {
    throw new MemoryStoreError("memory model output must be a JSON string");
  }
  let values: unknown;
  try {
    values = JSON.parse(output);
  } catch (error) {
    throw new MemoryStoreError("memory model output is not valid JSON", { cause: error });
  }
  return parseRecordValues(values, allowEmpty);
}

function parseRecordValues(values: unknown, allowEmpty: boolean): readonly MemoryRecord[] {
  if (!Array.isArray(values)) {
    throw new MemoryStoreError("memory model output must be a JSON array");
  }
  const records = values.map((value) => {
    if (!hasExactKeys(value, ["name", "type", "description", "body"])) {
      throw new MemoryStoreError("memory model item has an invalid schema");
    }
    try {
      return new MemoryRecord({
        name: requireStringField(value.name, "name"),
        description: requireStringField(value.description, "description"),
        kind: requireMemoryTypeField(value.type),
        body: requireStringField(value.body, "body"),
      });
    } catch (error) {
      throw new MemoryStoreError("memory model item has invalid fields", { cause: error });
    }
  });
  return validateRecordCollection(records, allowEmpty);
}

function parseConsolidationPlan(
  output: string,
  candidates: readonly MemoryRecord[],
): ConsolidationPlan {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new MemoryStoreError("consolidation output is not valid JSON", { cause: error });
  }
  if (!hasExactKeys(value, ["source_names", "records"])) {
    throw new MemoryStoreError("consolidation output has an invalid schema");
  }
  if (
    !Array.isArray(value.source_names) ||
    value.source_names.length === 0 ||
    !value.source_names.every((name): name is string => typeof name === "string")
  ) {
    throw new MemoryStoreError("consolidation source_names must be a non-empty string array");
  }
  validateConsolidationSources(value.source_names, candidates);
  return Object.freeze({
    sourceNames: Object.freeze([...value.source_names]),
    records: parseRecordValues(value.records, false),
  });
}

function validateConsolidationSources(
  sourceNames: readonly string[],
  candidates: readonly MemoryRecord[],
): void {
  if (
    !Array.isArray(sourceNames) ||
    sourceNames.length === 0 ||
    !sourceNames.every((name) => typeof name === "string")
  ) {
    throw new MemoryStoreError("consolidation sourceNames must be a non-empty string array");
  }
  if (new Set(sourceNames).size !== sourceNames.length) {
    throw new MemoryStoreError("consolidation sourceNames must be unique");
  }
  const candidateNames = new Set(candidates.map((record) => record.name));
  const unknown = sourceNames.filter((name) => !candidateNames.has(name));
  if (unknown.length > 0) {
    throw new MemoryStoreError(
      `consolidation contains unknown source names: ${[...unknown].sort().join(", ")}`,
    );
  }
}

function parseSelectedNames(output: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new MemoryStoreError("selector output is not valid JSON", { cause: error });
  }
  if (!Array.isArray(value) || !value.every((name): name is string => typeof name === "string")) {
    throw new MemoryStoreError("selector output must be a JSON string array");
  }
  if (new Set(value).size !== value.length) {
    throw new MemoryStoreError("selector output names must be unique");
  }
  return Object.freeze([...value]);
}

// Keyword fallback scans name/description only and does not read body, matching directory budget seen by selector.
function keywordSelect(
  query: string,
  records: readonly MemoryRecord[],
  limit: number,
): readonly MemoryRecord[] {
  const keywords = keywordTokens(query);
  const ranked = records
    .map((record) => {
      const searchable = `${record.name} ${record.description}`.toLowerCase();
      const score = [...keywords].filter((keyword) => searchable.includes(keyword)).length;
      return Object.freeze({ record, score });
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      return scoreDifference === 0
        ? compareText(left.record.name, right.record.name)
        : scoreDifference;
    });
  return Object.freeze(ranked.slice(0, limit).map((item) => item.record));
}

// English uses tokens of at least 3 characters, while Chinese uses adjacent bigrams, so both English and Chinese queries produce comparable features.
function keywordTokens(value: string): ReadonlySet<string> {
  const folded = value.toLowerCase();
  const tokens = new Set((folded.match(/[a-z0-9]+/gu) ?? []).filter((token) => token.length >= 3));
  for (const run of folded.match(CJK_RUN_PATTERN) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return tokens;
}

// extractor receives a deep-copied immutable message snapshot to prevent caller modifications affecting extraction input.
function copyHistory(history: readonly ChatMessage[]): readonly ChatMessage[] {
  if (!Array.isArray(history)) {
    throw new MemoryStoreError("memory extraction history must be an array");
  }
  const copied = history.map((message) => {
    if (message.role === "system") {
      return systemMessage(message.content);
    }
    if (message.role === "user") {
      return userMessage(message.content);
    }
    if (message.role === "tool") {
      return toolMessage(message.content, message.toolCallId);
    }
    return assistantMessage(
      message.content,
      message.toolCalls.map((call: ToolCall) => toolCall(call.id, call.name, call.arguments)),
    );
  });
  validateToolPairing(copied);
  return Object.freeze(copied);
}

function memoryRecordPayload(record: MemoryRecord): Readonly<Record<string, string>> {
  return Object.freeze({
    name: record.name,
    type: record.kind,
    description: record.description,
    body: record.body,
  });
}

// Recursively sorts by key to generate stable JSON, ensuring identical objects maintain deterministic input across different runs and tests.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new MemoryStoreError("memory JSON payload contains an unsupported value");
  }
  return serialized;
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStrictManifest(value: unknown): value is { version: 1; files: string[] } {
  return (
    hasExactKeys(value, ["version", "files"]) &&
    typeof value.version === "number" &&
    value.version === 1 &&
    Array.isArray(value.files) &&
    value.files.every((filename): filename is string => typeof filename === "string")
  );
}

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MemoryStoreError(`memory field ${field} must be a string`);
  }
  return value;
}

function requireMemoryTypeField(value: unknown): MemoryType {
  if (!isMemoryType(value)) {
    throw new MemoryStoreError("memory type is invalid");
  }
  return value;
}

function recordsEqual(left: MemoryRecord, right: MemoryRecord): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.kind === right.kind &&
    left.body === right.body
  );
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// Writes sibling temporary file first and fsyncs, then renames to overwrite; readers see either old file or complete new file.
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  const temporary = join(resolve(path, ".."), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
    await rm(temporary, { force: true });
  }
}

async function removePaths(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

// Use a Promise tail chain for intra-process serialization; record failures in the tail chain so subsequent operations wait for transaction completion.
async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = PROCESS_LOCK_TAILS.get(key);
  const result = previous === undefined ? operation() : previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  PROCESS_LOCK_TAILS.set(key, tail);
  try {
    return await result;
  } finally {
    if (PROCESS_LOCK_TAILS.get(key) === tail) {
      PROCESS_LOCK_TAILS.delete(key);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

// Use relative paths to determine if child is inside parent for manifest file and .memory root directory boundary validation.
function pathIsInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

// On Windows, proper-lockfile lock file rename or deletion can briefly return these errors; retry a fixed number of times.
function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function randomMemoryId(): string {
  return randomUUID().replaceAll("-", "");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
