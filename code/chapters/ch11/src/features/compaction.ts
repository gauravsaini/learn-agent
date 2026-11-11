import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  isChatMessage,
  systemMessage,
  toolMessage,
  validateToolPairing,
} from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import type { ModelClient } from "../core/model.js";
import { copyToolResult, isToolResult, toolSuccess } from "../core/tools.js";
import type { ToolResult } from "../core/tools.js";

// Default budgets are all calculated in UTF-8 bytes; centralized as constants to facilitate tests injecting small budgets.
// When a single tool result exceeds this UTF-8 byte count, persist to disk first and backfill only reference previews.
export const DEFAULT_PERSIST_THRESHOLD_BYTES = 30_000;
// Total budget allowed to remain in context for one turn's results; excess parts persist prioritizing by size.
export const DEFAULT_BATCH_BUDGET_BYTES = 200_000;
// Head preview bytes retained by tool result references.
export const DEFAULT_PREVIEW_HEAD_BYTES = 2_000;
// Tail preview bytes retained by tool result references.
export const DEFAULT_PREVIEW_TAIL_BYTES = 2_000;
// Count of recent complete tool exchange groups retained during micro-compaction.
export const DEFAULT_KEEP_RECENT_TOOL_GROUPS = 3;
// Number of recent message groups retained after prompt-too-long reactive compaction.
export const DEFAULT_REACTIVE_TAIL_GROUPS = 5;
// Generate a summary proactively before model calls when request history exceeds this budget.
export const DEFAULT_PROACTIVE_THRESHOLD_BYTES = 50_000;
// Maximum number of message groups allowed by snip compaction.
export const DEFAULT_SNIP_MAX_GROUPS = 50;
// Number of earliest message groups retained by snip compaction to preserve initial task context.
export const DEFAULT_SNIP_KEEP_HEAD_GROUPS = 3;
export const COMPACTED_TOOL_RESULT = "[Earlier tool result compacted. Re-run if needed.]";

// Default thresholds are all calculated in UTF-8 bytes; centralized as constants to facilitate tests injecting small budgets.
// Default budgets are centrally placed at module top: Byte thresholds by UTF-8 bytes, group counts by complete message groups; tests can inject small values.
const SUMMARY_SYSTEM_PROMPT = `Compress the current Agent history into a JSON object.
Must return only JSON, do not call tools. JSON must strictly and only contain:
current_goal: Non-empty string;
key_findings: Array of strings;
files_read_or_changed: Array of strings;
remaining_work: Array of strings;
user_constraints: Array of strings.`;
const ARTIFACT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ARTIFACT_ID_LENGTH = 96;

// The compaction layer moves oversized results out of model context while keeping traceable workspace artifact references.
// Common base class for compaction domain errors; callers decide to deny, clean up, or retry based on subclasses.
export class CompactionError extends Error {
  override readonly name: string = "CompactionError";
}

// Artifact path or directory violates security boundaries, such as an invalid ID or symlink escape.
export class ArtifactPathError extends CompactionError {
  override readonly name: string = "ArtifactPathError";
}

// Target artifact already exists; do not overwrite old files when exclusive publishing fails.
export class ArtifactConflictError extends CompactionError {
  override readonly name: string = "ArtifactConflictError";
}

// Prompt-too-long compaction was already attempted in the same recovery window; further compaction is forbidden.
export class PromptTooLongRetryError extends CompactionError {
  override readonly name: string = "PromptTooLongRetryError";
}

export interface CompactionSummaryOptions {
  // Current goals, facts, files, remaining work, and constraints together form the minimal recoverable summary.
  readonly currentGoal: string;
  readonly keyFindings: readonly string[];
  readonly filesReadOrChanged: readonly string[];
  readonly remainingWork: readonly string[];
  readonly userConstraints: readonly string[];
}

// The summary object is a strongly typed boundary for model output. Validate fields at construction.
export class CompactionSummary {
  readonly currentGoal: string;
  readonly keyFindings: readonly string[];
  readonly filesReadOrChanged: readonly string[];
  readonly remainingWork: readonly string[];
  readonly userConstraints: readonly string[];

  constructor(options: CompactionSummaryOptions) {
    this.currentGoal = requireNonEmptyText("currentGoal", options.currentGoal);
    this.keyFindings = requireTextArray("keyFindings", options.keyFindings);
    this.filesReadOrChanged = requireTextArray("filesReadOrChanged", options.filesReadOrChanged);
    this.remainingWork = requireTextArray("remainingWork", options.remainingWork);
    this.userConstraints = requireTextArray("userConstraints", options.userConstraints);
    Object.freeze(this);
  }
}

export interface HistorySummarizer {
  // The summarizer only reads message snapshots. It must not modify canonical history or call tools.
  summarize(history: readonly ChatMessage[], signal?: AbortSignal): Promise<CompactionSummary>;
}

// Summary requests have no tools and only accept stop + strict JSON to prevent compaction from introducing side effects.
// Uses primary model to complete summary: requests contain no tools, outputs must be strict JSON, avoiding side effects in summary layer.
export class ModelHistorySummarizer implements HistorySummarizer {
  readonly #model: ModelClient;

  constructor(model: ModelClient) {
    if (typeof model?.complete !== "function") {
      throw new TypeError("model must implement ModelClient");
    }
    this.#model = model;
  }

  async summarize(
    history: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompactionSummary> {
    const { snapshot } = validatedGroups(history);
    // Summary requests have no tools and must stop. Any tool call or truncation fails compaction.
    // Summary requests append history after the fixed system prompt and carry no tool definitions.
    // Tool calls, truncation, or empty content from model output are treated as compaction failures; bad summaries must not enter request history.
    const reply = await this.#model.complete(
      Object.freeze({
        messages: Object.freeze([systemMessage(SUMMARY_SYSTEM_PROMPT), ...snapshot]),
        tools: Object.freeze([]),
      }),
      signal,
    );
    if (reply.message.toolCalls.length > 0) {
      throw new CompactionError("summary model must not call tools");
    }
    if (reply.finishReason !== "stop") {
      throw new CompactionError(
        `summary model finishReason must be stop, got ${reply.finishReason}`,
      );
    }
    const content = reply.message.content;
    if (content === null || content.trim().length === 0) {
      throw new CompactionError("summary model must return non-empty JSON text");
    }
    return parseCompactionSummary(content);
  }
}

export interface ArtifactReference {
  // Absolute path of the artifact, for local cleanup only; models use relativePath.
  readonly path: string;
  // Relative workspace path, safe to write tool results and summaries.
  readonly relativePath: string;
  // UTF-8 byte count of body before flushing to disk, helping the model judge whether to re-read.
  readonly originalBytes: number;
}

export interface ToolResultArtifact {
  readonly resultIndex: number;
  readonly reference: ArtifactReference;
}

export interface ToolResultBudgetOutcome {
  // Replacement snapshot matching input results one-to-one, preserving tool_call pairings.
  readonly results: readonly ToolResult[];
  readonly artifacts: readonly ToolResultArtifact[];
}

export interface HistoryCompactionOutcome {
  // Snapshot of summary plus tail messages used for the next model request.
  readonly history: readonly ChatMessage[];
  // Persistent reference to the canonical transcript; locates full history during failure recovery.
  readonly transcript: ArtifactReference;
}

// A message group is the smallest unit of compaction: normal messages form single groups, and assistant tool calls group with all their results.
interface MessageGroup {
  readonly messages: readonly ChatMessage[];
  readonly isToolExchange: boolean;
}

export interface CompactionManagerOptions {
  // All artifacts must fall under this workspace; path boundaries are resolved at construction time.
  readonly workspace: string;
  // Model boundary for generating structured summaries; summary requests disable tools.
  readonly summarizer: HistorySummarizer;
  readonly idGenerator?: () => string;
  readonly persistThresholdBytes?: number;
  readonly batchBudgetBytes?: number;
  readonly previewHeadBytes?: number;
  readonly previewTailBytes?: number;
  readonly reactiveTailGroups?: number;
  readonly proactiveThresholdBytes?: number;
  readonly snipMaxGroups?: number;
  readonly snipKeepHeadGroups?: number;
  readonly keepRecentToolGroups?: number;
}

// The manager decides persistence, summary, micro-compaction, or snip compaction by byte budget; raw history is not rewritten here.
export class CompactionManager {
  readonly #workspace: string;
  readonly #summarizer: HistorySummarizer;
  readonly #idGenerator: () => string;
  readonly #persistThresholdBytes: number;
  readonly #batchBudgetBytes: number;
  readonly #previewHeadBytes: number;
  readonly #previewTailBytes: number;
  readonly #reactiveTailGroups: number;
  readonly #proactiveThresholdBytes: number;
  readonly #snipMaxGroups: number;
  readonly #snipKeepHeadGroups: number;
  readonly #keepRecentToolGroups: number;
  // Cache for prepare only targets the latest canonical snapshot; caller always holds canonical history.
  #preparedSource: readonly ChatMessage[] | undefined;
  // Request-level compaction result corresponding to #preparedSource; can be reused incrementally on append-only changes.
  #preparedHistory: readonly ChatMessage[] | undefined;

  constructor(options: CompactionManagerOptions) {
    // Centrally resolve defaults and validate parameters at construction so subsequent prepare/compact calls do not re-parse configuration.
    const persistThresholdBytes = optionValue(
      options.persistThresholdBytes,
      DEFAULT_PERSIST_THRESHOLD_BYTES,
    );
    const batchBudgetBytes = optionValue(options.batchBudgetBytes, DEFAULT_BATCH_BUDGET_BYTES);
    const previewHeadBytes = optionValue(options.previewHeadBytes, DEFAULT_PREVIEW_HEAD_BYTES);
    const previewTailBytes = optionValue(options.previewTailBytes, DEFAULT_PREVIEW_TAIL_BYTES);
    const reactiveTailGroups = optionValue(
      options.reactiveTailGroups,
      DEFAULT_REACTIVE_TAIL_GROUPS,
    );
    const proactiveThresholdBytes = optionValue(
      options.proactiveThresholdBytes,
      DEFAULT_PROACTIVE_THRESHOLD_BYTES,
    );
    const snipMaxGroups = optionValue(options.snipMaxGroups, DEFAULT_SNIP_MAX_GROUPS);
    const snipKeepHeadGroups = optionValue(
      options.snipKeepHeadGroups,
      DEFAULT_SNIP_KEEP_HEAD_GROUPS,
    );
    const keepRecentToolGroups = optionValue(
      options.keepRecentToolGroups,
      DEFAULT_KEEP_RECENT_TOOL_GROUPS,
    );

    requirePositiveInteger("persistThresholdBytes", persistThresholdBytes);
    requirePositiveInteger("batchBudgetBytes", batchBudgetBytes);
    requireNonNegativeInteger("previewHeadBytes", previewHeadBytes);
    requireNonNegativeInteger("previewTailBytes", previewTailBytes);
    requirePositiveInteger("reactiveTailGroups", reactiveTailGroups);
    requirePositiveInteger("proactiveThresholdBytes", proactiveThresholdBytes);
    validateSnipConfiguration(snipMaxGroups, snipKeepHeadGroups);
    requireNonNegativeInteger("keepRecentToolGroups", keepRecentToolGroups);
    if (previewHeadBytes === 0 && previewTailBytes === 0) {
      throw new RangeError("at least one preview byte limit must be positive");
    }
    if (typeof options.summarizer?.summarize !== "function") {
      throw new TypeError("summarizer must implement HistorySummarizer");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }

    this.#workspace = resolveWorkspace(options.workspace);
    this.#summarizer = options.summarizer;
    this.#idGenerator =
      options.idGenerator === undefined
        ? () => randomUUID().replaceAll("-", "")
        : options.idGenerator;
    this.#persistThresholdBytes = persistThresholdBytes;
    this.#batchBudgetBytes = batchBudgetBytes;
    this.#previewHeadBytes = previewHeadBytes;
    this.#previewTailBytes = previewTailBytes;
    this.#reactiveTailGroups = reactiveTailGroups;
    this.#proactiveThresholdBytes = proactiveThresholdBytes;
    this.#snipMaxGroups = snipMaxGroups;
    this.#snipKeepHeadGroups = snipKeepHeadGroups;
    this.#keepRecentToolGroups = keepRecentToolGroups;
  }

  async prepare(history: readonly ChatMessage[]): Promise<readonly ChatMessage[]> {
    const { snapshot } = validatedGroups(history);
    // Identical canonical snapshots directly reuse the previous request history; append-only operations only compact new suffixes.
    // Request-level compaction entry: take an immutable snapshot from canonical history first, then proceed via snip -> micro -> summary
    // Sequentially prepares the next model input. The canonical history itself is never rewritten by this function.
    const cachedSource = this.#preparedSource;
    const cachedHistory = this.#preparedHistory;
    if (
      cachedSource !== undefined &&
      cachedHistory !== undefined &&
      historiesEqual(snapshot, cachedSource)
    ) {
      return cachedHistory;
    }

    let prepared: readonly ChatMessage[] = snapshot;
    if (
      cachedSource !== undefined &&
      cachedHistory !== undefined &&
      snapshot.length > cachedSource.length &&
      historyStartsWith(snapshot, cachedSource)
    ) {
      prepared = Object.freeze([...cachedHistory, ...snapshot.slice(cachedSource.length)]);
    }

    prepared = snipCompactHistory(prepared, {
      maxGroups: this.#snipMaxGroups,
      keepHeadGroups: this.#snipKeepHeadGroups,
    });
    prepared = microCompactHistory(prepared, {
      keepRecentToolGroups: this.#keepRecentToolGroups,
    });
    if (historyUtf8Bytes(prepared) > this.#proactiveThresholdBytes) {
      // transcript always comes from canonical; summary reads only request history processed by cheaper layers.
      const outcome = await this.#compactValidated(snapshot, prepared, 0, undefined, false);
      prepared = outcome.history;
    }

    this.#preparedSource = snapshot;
    this.#preparedHistory = prepared;
    return prepared;
  }

  async compactToolResults(results: readonly ToolResult[]): Promise<ToolResultBudgetOutcome> {
    // Tool result handlers: finish persisting to disk before the entire turn of ToolResults backfills canonical history.
    // Receives all results of the same turn, allowing largest-first batch selection against the total budget instead of evaluating items independently.
    if (!Array.isArray(results) || !results.every((result: unknown) => isToolResult(result))) {
      throw new TypeError("results must contain only ToolResult values");
    }
    const snapshot = Object.freeze(results.map((result) => copyToolResult(result)));
    const encoded = snapshot.map((result) => Buffer.from(result.content, "utf8"));
    const sizes = encoded.map((content) => content.byteLength);
    // Flush to disk prioritized by size when exceeding batch budget, until remaining results fit within budget.
    const ranked = sizes
      .map((_size, index) => index)
      .sort((left, right) => {
        const leftSize = sizes[left];
        const rightSize = sizes[right];
        if (leftSize === undefined || rightSize === undefined) {
          throw new CompactionError("tool result size index was lost");
        }
        return rightSize - leftSize || left - right;
      });
    const selected = new Set(
      sizes.flatMap((size, index) => (size > this.#persistThresholdBytes ? [index] : [])),
    );
    let retainedBytes = sizes.reduce(
      (total, size, index) => total + (selected.has(index) ? 0 : size),
      0,
    );
    for (const index of ranked) {
      if (retainedBytes <= this.#batchBudgetBytes) {
        break;
      }
      if (selected.has(index)) {
        continue;
      }
      selected.add(index);
      const selectedSize = sizes[index];
      if (selectedSize === undefined) {
        throw new CompactionError("selected tool result size index was lost");
      }
      retainedBytes -= selectedSize;
    }

    const transformed = [...snapshot];
    const artifacts: ToolResultArtifact[] = [];
    try {
      // Completes persistence for the entire batch first; cleanup below revokes published files of this batch on any failure.
      // Persist the entire batch to disk first. If any fails, cleanup revokes all published files for this batch.
      for (const index of ranked) {
        if (!selected.has(index)) {
          continue;
        }
        const content = encoded[index];
        const original = snapshot[index];
        if (content === undefined || original === undefined) {
          throw new CompactionError("tool result batch index was lost");
        }
        const reference = await this.#writeArtifact("tool-result", ".txt", content);
        artifacts.push(Object.freeze({ resultIndex: index, reference }));
        const rendered = this.#renderToolResultReference(reference, content);
        if (original.isError) {
          const errorCode = original.errorCode;
          if (errorCode === undefined) {
            throw new CompactionError("error tool result lost its errorCode");
          }
          transformed[index] = Object.freeze({ content: rendered, isError: true, errorCode });
        } else {
          transformed[index] = toolSuccess(rendered);
        }
      }
    } catch (error) {
      await removeCreatedArtifacts(
        artifacts.map((artifact) => artifact.reference),
        error,
      );
    }

    return Object.freeze({
      results: Object.freeze(transformed),
      artifacts: Object.freeze(artifacts),
    });
  }

  async compactProactively(
    history: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<HistoryCompactionOutcome> {
    // The explicit compaction API bypasses snip/micro, saves the full transcript directly, and generates a structured summary.
    const { snapshot } = validatedGroups(history);
    return this.#compactValidated(snapshot, snapshot, 0, signal, false);
  }

  async compactOnPromptTooLong(
    history: readonly ChatMessage[],
    options: { readonly retryCount: number },
    signal?: AbortSignal,
  ): Promise<HistoryCompactionOutcome> {
    // Reactive compaction is allowed only once per logical request; retryCount provides recursion protection.
    // Reactive recovery primitive: the caller confirmed input context is too long; this method allows only one compaction in the current window.
    // Retain the latest complete group after summarization so the model still sees recent progress instead of only a compacted summary.
    requireNonNegativeInteger("retryCount", options.retryCount);
    if (options.retryCount > 0) {
      throw new PromptTooLongRetryError("prompt-too-long compaction was already attempted");
    }
    const { snapshot } = validatedGroups(history);
    return this.#compactValidated(snapshot, snapshot, this.#reactiveTailGroups, signal, true);
  }

  async #compactValidated(
    transcriptHistory: readonly ChatMessage[],
    summaryHistory: readonly ChatMessage[],
    keepTailGroups: number,
    signal: AbortSignal | undefined,
    cleanupOnFailure: boolean,
  ): Promise<HistoryCompactionOutcome> {
    // Write transcript to disk first; reactive mode cleans up published artifacts on cancellation or summary failure.
    // Saves complete transcript first; does not lose session snapshot prior to compaction even if summary fails.
    // transcript and summary use different history sources: transcript always comes from full canonical snapshots,
    // The summary only reads request history processed by cheaper layers. Save transcript first to preserve context if summarization fails.
    const transcript = await this.#writeArtifact(
      "transcript",
      ".jsonl",
      serializeTranscript(transcriptHistory),
    );
    try {
      throwIfAborted(signal);
      const compactedSummary: unknown = await this.#summarizer.summarize(summaryHistory, signal);
      throwIfAborted(signal);
      if (!(compactedSummary instanceof CompactionSummary)) {
        throw new TypeError("summarizer must return CompactionSummary");
      }
      const summary = summaryMessage(compactedSummary, transcript.relativePath);
      const tail =
        keepTailGroups === 0
          ? []
          : flattenGroups(validatedGroups(summaryHistory).groups.slice(-keepTailGroups));
      const history = Object.freeze([summary, ...tail]);
      validateToolPairing(history);
      return Object.freeze({ history, transcript });
    } catch (error) {
      if (!cleanupOnFailure) {
        throw error;
      }
      return await removeCreatedArtifacts([transcript], error);
    }
  }

  async #writeArtifact(
    kind: "tool-result" | "transcript",
    extension: ".txt" | ".jsonl",
    content: Buffer,
  ): Promise<ArtifactReference> {
    // The artifact ID is constrained by slug; the final path stays only in the fixed artifacts directory of the workspace.
    // Unified write entry point: validate ID slug, create secure directory, then publish exclusively to generate the final file.
    const artifactId: unknown = this.#idGenerator();
    if (
      typeof artifactId !== "string" ||
      artifactId.length > MAX_ARTIFACT_ID_LENGTH ||
      !ARTIFACT_ID_PATTERN.test(artifactId)
    ) {
      throw new ArtifactPathError("artifact id must be a safe lowercase hyphen-separated slug");
    }
    const root = await ensureArtifactDirectory(this.#workspace);
    const path = join(root, `${kind}-${artifactId}${extension}`);
    const relativePath = relative(this.#workspace, path).split(sep).join("/");
    try {
      await writeExclusiveAtomic(path, content);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ArtifactConflictError(`artifact already exists: ${relativePath}`, {
          cause: error,
        });
      }
      if (error instanceof CompactionError) {
        throw error;
      }
      throw new CompactionError(`artifact could not be written: ${relativePath}`, {
        cause: error,
      });
    }
    return Object.freeze({ path, relativePath, originalBytes: content.byteLength });
  }

  // Messages retain only relative paths, original sizes, and bounded UTF-8 previews; the full body stays in the artifact.
  #renderToolResultReference(reference: ArtifactReference, content: Buffer): string {
    const [head, tail] = boundedUtf8Preview(
      content,
      this.#previewHeadBytes,
      this.#previewTailBytes,
    );
    return [
      "<persisted-tool-result>",
      `path: ${reference.relativePath}`,
      `original_bytes: ${reference.originalBytes}`,
      "head_preview:",
      head,
      "tail_preview:",
      tail,
      "</persisted-tool-result>",
    ].join("\n");
  }
}

// micro replaces old result bodies by complete tool group, preserving assistant call and tool_call_id pairings.
export function microCompactHistory(
  history: readonly ChatMessage[],
  options: { readonly keepRecentToolGroups?: number } = {},
): readonly ChatMessage[] {
  const keepRecentToolGroups = optionValue(
    options.keepRecentToolGroups,
    DEFAULT_KEEP_RECENT_TOOL_GROUPS,
  );
  requireNonNegativeInteger("keepRecentToolGroups", keepRecentToolGroups);
  const { snapshot, groups } = validatedGroups(history);
  const toolGroupIndices = groups.flatMap((group, index) => (group.isToolExchange ? [index] : []));
  const compactCount = Math.max(0, toolGroupIndices.length - keepRecentToolGroups);
  if (compactCount === 0) {
    return snapshot;
  }
  const compactedIndices = new Set(toolGroupIndices.slice(0, compactCount));
  const updated = groups.map((group, groupIndex) => {
    if (!compactedIndices.has(groupIndex)) {
      return group;
    }
    const assistant = group.messages[0];
    if (assistant?.role !== "assistant") {
      throw new CompactionError("tool message group lost its assistant message");
    }
    const messages = [
      assistant,
      ...group.messages.slice(1).map((message) => {
        if (message.role !== "tool") {
          throw new CompactionError("tool message group contains a non-tool result");
        }
        return toolMessage(COMPACTED_TOOL_RESULT, message.toolCallId);
      }),
    ];
    return createMessageGroup(messages);
  });
  const compacted = flattenGroups(updated);
  validateToolPairing(compacted);
  return compacted;
}

// snip preserves head and tail by message group and inserts omission markers to avoid splitting multi-call atomic groups.
export function snipCompactHistory(
  history: readonly ChatMessage[],
  options: { readonly maxGroups?: number; readonly keepHeadGroups?: number } = {},
): readonly ChatMessage[] {
  const maxGroups = optionValue(options.maxGroups, DEFAULT_SNIP_MAX_GROUPS);
  const keepHeadGroups = optionValue(options.keepHeadGroups, DEFAULT_SNIP_KEEP_HEAD_GROUPS);
  validateSnipConfiguration(maxGroups, keepHeadGroups);
  const { snapshot, groups } = validatedGroups(history);
  if (groups.length <= maxGroups) {
    return snapshot;
  }
  const keepTailGroups = maxGroups - keepHeadGroups - 1;
  const omitted = groups.length - keepHeadGroups - keepTailGroups;
  const marker = createMessageGroup([
    systemMessage(`[Compacted: ${omitted} message groups omitted]`),
  ]);
  const compacted = flattenGroups([
    ...groups.slice(0, keepHeadGroups),
    marker,
    ...groups.slice(-keepTailGroups),
  ]);
  validateToolPairing(compacted);
  return compacted;
}

export function historyUtf8Bytes(history: readonly ChatMessage[]): number {
  // Budget evaluation shares the same normalized JSONL with transcript to prevent two serializations from producing different byte counts.
  const { snapshot } = validatedGroups(history);
  return serializeTranscript(snapshot).byteLength;
}

// Splits history into normal message groups and complete tool exchange groups first; all subsequent boundaries are based on these groups.
function validatedGroups(history: readonly ChatMessage[]): {
  // The assistant tool call and all its tool results form an indivisible OpenAI protocol group.
  readonly snapshot: readonly ChatMessage[];
  readonly groups: readonly MessageGroup[];
} {
  if (!Array.isArray(history) || !history.every((message: unknown) => isChatMessage(message))) {
    throw new TypeError("history must contain only ChatMessage values");
  }
  const snapshot = Object.freeze([...history]);
  validateToolPairing(snapshot);
  const groups: MessageGroup[] = [];
  let index = 0;
  while (index < snapshot.length) {
    const message = snapshot[index];
    if (message === undefined) {
      throw new CompactionError("history index was lost");
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      const end = index + 1 + message.toolCalls.length;
      groups.push(createMessageGroup(snapshot.slice(index, end)));
      index = end;
      continue;
    }
    groups.push(createMessageGroup([message]));
    index += 1;
  }
  return Object.freeze({ snapshot, groups: Object.freeze(groups) });
}

function createMessageGroup(messages: readonly ChatMessage[]): MessageGroup {
  const snapshot = Object.freeze([...messages]);
  const first = snapshot[0];
  return Object.freeze({
    messages: snapshot,
    isToolExchange: first?.role === "assistant" && first.toolCalls.length > 0,
  });
}

function flattenGroups(groups: readonly MessageGroup[]): readonly ChatMessage[] {
  return Object.freeze(groups.flatMap((group) => group.messages));
}

// transcript is stable JSONL: serialized with sorted keys for cache comparison and line-by-line restoration.
function serializeTranscript(history: readonly ChatMessage[]): Buffer {
  if (history.length === 0) {
    return Buffer.alloc(0);
  }
  const lines = history.map((message) => stableStringify(toOpenAIMessage(message)));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function toOpenAIMessage(message: ChatMessage): Readonly<Record<string, unknown>> {
  // Converts internal ChatMessage to OpenAI wire shape; keeps only fields required by protocol and preserves tool_call_id.
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content: message.content };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.toolCalls.length === 0) {
    return { role: "assistant", content: message.content };
  }
  return {
    role: "assistant",
    content: message.content,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function summaryMessage(summary: CompactionSummary, transcriptPath: string): ChatMessage {
  // The summary message has system role and includes kind, transcript_path, and five types of continuation information.
  // The model can read these fields directly in the next turn without reviewing compacted history.
  return systemMessage(
    stableStringify({
      kind: "compacted_history",
      transcript_path: transcriptPath,
      current_goal: summary.currentGoal,
      key_findings: summary.keyFindings,
      files_read_or_changed: summary.filesReadOrChanged,
      remaining_work: summary.remainingWork,
      user_constraints: summary.userConstraints,
    }),
  );
}

// Summary model output is an untrusted boundary. Strictly validate field sets, types, and empty values.
function parseCompactionSummary(content: string): CompactionSummary {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    throw new CompactionError("summary model output is not valid JSON", { cause: error });
  }
  const expected = [
    "current_goal",
    "files_read_or_changed",
    "key_findings",
    "remaining_work",
    "user_constraints",
  ];
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join("\0") !== expected.join("\0")
  ) {
    throw new CompactionError("summary model output must contain the exact fields");
  }
  const currentGoal = Reflect.get(payload, "current_goal");
  if (typeof currentGoal !== "string") {
    throw new CompactionError("summary current_goal must be a string");
  }
  const keyFindings = parseStringArray(payload, "key_findings");
  const filesReadOrChanged = parseStringArray(payload, "files_read_or_changed");
  const remainingWork = parseStringArray(payload, "remaining_work");
  const userConstraints = parseStringArray(payload, "user_constraints");
  try {
    return new CompactionSummary({
      currentGoal,
      keyFindings,
      filesReadOrChanged,
      remainingWork,
      userConstraints,
    });
  } catch (error) {
    throw new CompactionError("summary model output contains invalid values", { cause: error });
  }
}

function parseStringArray(payload: object, field: string): readonly string[] {
  const value: unknown = Reflect.get(payload, field);
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new CompactionError(`summary ${field} must be a string array`);
  }
  return Object.freeze([...value]);
}

function boundedUtf8Preview(
  content: Buffer,
  headLimit: number,
  tailLimit: number,
): readonly [string, string] {
  // Truncates head and tail by bytes first, then uses TextDecoder to discard incomplete UTF-8 characters at boundaries.
  const headEnd = Math.min(content.byteLength, headLimit);
  const tailStart = Math.max(headEnd, content.byteLength - tailLimit);
  return Object.freeze([
    decodeUtf8Boundary(content.subarray(0, headEnd), "head"),
    decodeUtf8Boundary(content.subarray(tailStart), "tail"),
  ]);
}

function decodeUtf8Boundary(content: Buffer, boundary: "head" | "tail"): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset <= Math.min(content.byteLength, 3); offset += 1) {
    const candidate =
      boundary === "head"
        ? content.subarray(0, content.byteLength - offset)
        : content.subarray(offset);
    try {
      return decoder.decode(candidate);
    } catch {
      // A UTF-8 code point has at most 4 bytes: discard only incomplete fragments on boundaries.
    }
  }
  return "";
}

async function ensureArtifactDirectory(workspace: string): Promise<string> {
  // Fix artifact root directory and validate real paths layer by layer to prevent .agent_tutorial/artifacts from being replaced by symlinks.
  const stateDirectory = join(workspace, ".agent_tutorial");
  await ensureSafeDirectory(stateDirectory, workspace);
  const artifactDirectory = join(stateDirectory, "artifacts");
  await ensureSafeDirectory(artifactDirectory, workspace);
  return artifactDirectory;
}

// Re-checks real directory after creation, rejecting symlinks and paths pointing outside workspace.
async function ensureSafeDirectory(path: string, workspace: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new ArtifactPathError(`artifact directory could not be created: ${path}`, {
        cause: error,
      });
    }
  }
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ArtifactPathError(`artifact directory is not a real directory: ${path}`);
    }
    const resolvedPath = await realpath(path);
    if (resolve(resolvedPath) !== resolve(path) || !isWithinWorkspace(workspace, resolvedPath)) {
      throw new ArtifactPathError(`artifact directory escapes workspace: ${path}`);
    }
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      throw error;
    }
    throw new ArtifactPathError(`artifact directory could not be verified: ${path}`, {
      cause: error,
    });
  }
}

async function writeExclusiveAtomic(path: string, content: Buffer): Promise<void> {
  // Uses exclusive publication to prevent concurrent compaction from overwriting existing artifacts, leaving conflicts to callers to handle explicitly.
  // Sync temporary files in the same directory before publishing via exclusive hard links; final paths are never overwritten.
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }
    await link(temporary, path);
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
    await rm(temporary, { force: true });
  }
}

async function removeCreatedArtifacts(
  references: readonly ArtifactReference[],
  originalError: unknown,
): Promise<never> {
  // Batch cleanup continues even if it fails halfway, finally merging original errors with cleanup errors.
  const cleanupErrors: unknown[] = [];
  for (const reference of references) {
    try {
      await rm(reference.path);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      "tool result persistence and artifact cleanup both failed",
    );
  }
  throw originalError;
}

function resolveWorkspace(workspace: string): string {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new TypeError("workspace must be a non-empty string");
  }
  try {
    // The composition root resolves once when creating the manager; request paths only use the validated absolute workspace.
    const resolvedWorkspace = realpathSync.native(workspace);
    if (!statSync(resolvedWorkspace).isDirectory()) {
      throw new ArtifactPathError(`workspace is not a directory: ${workspace}`);
    }
    return resolvedWorkspace;
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      throw error;
    }
    throw new ArtifactPathError(`workspace could not be resolved: ${workspace}`, { cause: error });
  }
}

function isWithinWorkspace(workspace: string, candidate: string): boolean {
  // Use relative paths to check containment, avoiding false matches from string prefixes between C:\a and C:\ab.
  const offset = relative(workspace, candidate);
  return (
    offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
  );
}

function historiesEqual(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  return left.length === right.length && historyStartsWith(left, right);
}

// Prefix comparison also uses stable JSON to ensure cross-field ordering can still identify append-only history.
function historyStartsWith(
  history: readonly ChatMessage[],
  prefix: readonly ChatMessage[],
): boolean {
  if (history.length < prefix.length) {
    return false;
  }
  return prefix.every((message, index) => {
    const candidate = history[index];
    return (
      candidate !== undefined &&
      stableStringify(toOpenAIMessage(candidate)) === stableStringify(toOpenAIMessage(message))
    );
  });
}

function optionValue(value: number | undefined, fallback: number): number {
  // Uses module defaults when configuration options are not explicitly passed; explicitly passed invalid values proceed to require validation.
  return value === undefined ? fallback : value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CompactionError("history compaction was cancelled");
  }
}

function requireNonEmptyText(name: string, value: unknown): string {
  // Summary fields reject empty strings to prevent the model from using placeholders to hide missing information.
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireTextArray(name: string, value: readonly string[]): readonly string[] {
  // Each item in the string array must be non-empty and frozen as immutable summary state.
  if (
    !Array.isArray(value) ||
    !value.every((item: unknown) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return Object.freeze([...value]);
}

function requirePositiveInteger(name: string, value: number): void {
  // Budget must be a positive integer to prevent 0 or decimals from causing meaningless thresholds.
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  // Configurations that allow 0 (such as preview bytes or retained groups) must still be integers.
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function validateSnipConfiguration(maxGroups: number, keepHeadGroups: number): void {
  // snip must accommodate at least head, marker, and tail parts to avoid slicing into empty history.
  requirePositiveInteger("maxGroups", maxGroups);
  requirePositiveInteger("keepHeadGroups", keepHeadGroups);
  if (maxGroups < 3) {
    throw new RangeError("maxGroups must leave room for head, marker, and tail groups");
  }
  if (keepHeadGroups > maxGroups - 2) {
    throw new RangeError("keepHeadGroups must leave room for marker and tail groups");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  // Treat only Errors with a code field as Node system errors to identify write results like EEXIST.
  return error instanceof Error && "code" in error;
}
