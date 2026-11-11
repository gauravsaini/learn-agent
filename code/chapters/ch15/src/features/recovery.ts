import { userMessage, validateToolPairing } from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../core/model.js";
import type { ModelClient, ModelReply, ModelRequest } from "../core/model.js";
import { CompactionManager } from "./compaction.js";

// Default recovery parameters are centrally defined; tests can inject small budgets; production defaults keep retries and waiting within one turn.
// File responsibility: provide a provider-agnostic model recovery layer. RecoveryManager operates with a logical ModelRequest as its boundary.
// Handles length continuation, prompt-too-long compaction, 429/529 backoff, and fallback internally;
// Cancellation and total deadlines span all async operations; each typed failure is a verifiable termination condition.
export const DEFAULT_INITIAL_MAX_TOKENS = 8_000;
export const DEFAULT_ESCALATED_MAX_TOKENS = 64_000;
export const DEFAULT_MAX_CONTINUATIONS = 3;
export const DEFAULT_MAX_TRANSIENT_ATTEMPTS = 10;
export const DEFAULT_BASE_DELAY_SECONDS = 0.5;
export const DEFAULT_MAX_DELAY_SECONDS = 32;
export const DEFAULT_JITTER_RATIO = 0.25;
export const DEFAULT_OVERLOAD_FALLBACK_THRESHOLD = 3;
export const DEFAULT_TOTAL_TIMEOUT_SECONDS = 300;
// Continuation prompt instructs the model to continue without pleasantries, avoiding repeating text or replanning.
export const CONTINUATION_PROMPT =
  "Continue exactly where you left off. Do not repeat any text, no apology, no recap. Pick up mid-thought.";

// typed failure lets callers and tests determine cancellation, timeout, exhaustion, and invalid Retry-After by type.
export class RecoveryError extends Error {
  override readonly name: string = "RecoveryError";
}

export class InvalidRetryAfterError extends RecoveryError {
  override readonly name: string = "InvalidRetryAfterError";
}

export class RecoveryCancelledError extends RecoveryError {
  override readonly name: string = "RecoveryCancelledError";
}

export class RecoveryDeadlineExceeded extends RecoveryError {
  override readonly name: string = "RecoveryDeadlineExceeded";
}

export class RecoveryRetriesExhausted extends RecoveryError {
  override readonly name: string = "RecoveryRetriesExhausted";
}

// A lightweight cancellation token lets tests trigger manually, and constrains all asynchronous operations together with AbortSignal.
// Contract: cancel() is idempotent and triggers only once; new subscriptions after cancellation execute immediately and return a no-op unsubscribe function.
export class CancellationToken {
  #cancelled = false;
  readonly #listeners = new Set<() => void>();

  get isCancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    // Return directly when already cancelled; otherwise trigger all listeners once and clear them to prevent duplicate notifications.
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    for (const listener of this.#listeners) {
      listener();
    }
    this.#listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    // Subscriptions after cancellation wake callers immediately to avoid missing cancellation events that already occurred.
    if (this.#cancelled) {
      listener();
      return () => {};
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

// Validate budget relationships at construction to prevent sending maxTokens values rejected by the provider at runtime.
export interface RecoveryConfigOptions {
  // Fallback model name to switch to when the primary model is continuously overloaded.
  readonly primaryModel: string;
  readonly fallbackModel: string;
  // Output budget for the first request; escalated to escalatedMaxTokens after length finish.
  readonly initialMaxTokens?: number;
  // Second-tier budget used during length recovery, which cannot exceed model limits.
  readonly escalatedMaxTokens?: number;
  // Maximum output budget allowed by vendor, protecting configuration against sending illegal values.
  readonly modelMaxTokens?: number;
  // Maximum number of plain-text continuations appended to the same logical request.
  readonly maxContinuations?: number;
  // Total attempt cap for transient failures such as 429/529.
  readonly maxTransientAttempts?: number;
  readonly baseDelaySeconds?: number;
  readonly maxDelaySeconds?: number;
  readonly jitterRatio?: number;
  readonly overloadFallbackThreshold?: number;
  readonly totalTimeoutSeconds?: number;
}

export class RecoveryConfig {
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly initialMaxTokens: number;
  readonly escalatedMaxTokens: number;
  readonly modelMaxTokens: number;
  readonly maxContinuations: number;
  readonly maxTransientAttempts: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  readonly jitterRatio: number;
  readonly overloadFallbackThreshold: number;
  readonly totalTimeoutSeconds: number;

  constructor(options: RecoveryConfigOptions) {
    this.primaryModel = nonEmptyText("primaryModel", options.primaryModel);
    this.fallbackModel = nonEmptyText("fallbackModel", options.fallbackModel);
    this.initialMaxTokens = positiveInteger(
      "initialMaxTokens",
      option(options.initialMaxTokens, DEFAULT_INITIAL_MAX_TOKENS),
    );
    this.escalatedMaxTokens = positiveInteger(
      "escalatedMaxTokens",
      option(options.escalatedMaxTokens, DEFAULT_ESCALATED_MAX_TOKENS),
    );
    this.modelMaxTokens = positiveInteger(
      "modelMaxTokens",
      option(options.modelMaxTokens, DEFAULT_ESCALATED_MAX_TOKENS),
    );
    this.maxContinuations = nonNegativeInteger(
      "maxContinuations",
      option(options.maxContinuations, DEFAULT_MAX_CONTINUATIONS),
    );
    this.maxTransientAttempts = positiveInteger(
      "maxTransientAttempts",
      option(options.maxTransientAttempts, DEFAULT_MAX_TRANSIENT_ATTEMPTS),
    );
    this.baseDelaySeconds = positiveFinite(
      "baseDelaySeconds",
      option(options.baseDelaySeconds, DEFAULT_BASE_DELAY_SECONDS),
    );
    this.maxDelaySeconds = positiveFinite(
      "maxDelaySeconds",
      option(options.maxDelaySeconds, DEFAULT_MAX_DELAY_SECONDS),
    );
    this.jitterRatio = nonNegativeFinite(
      "jitterRatio",
      option(options.jitterRatio, DEFAULT_JITTER_RATIO),
    );
    this.overloadFallbackThreshold = positiveInteger(
      "overloadFallbackThreshold",
      option(options.overloadFallbackThreshold, DEFAULT_OVERLOAD_FALLBACK_THRESHOLD),
    );
    this.totalTimeoutSeconds = positiveFinite(
      "totalTimeoutSeconds",
      option(options.totalTimeoutSeconds, DEFAULT_TOTAL_TIMEOUT_SECONDS),
    );
    if (this.initialMaxTokens >= this.escalatedMaxTokens) {
      throw new RangeError("escalatedMaxTokens must exceed initialMaxTokens");
    }
    if (this.escalatedMaxTokens > this.modelMaxTokens) {
      throw new RangeError("escalatedMaxTokens must not exceed modelMaxTokens");
    }
    if (this.baseDelaySeconds > this.maxDelaySeconds) {
      throw new RangeError("baseDelaySeconds must not exceed maxDelaySeconds");
    }
    Object.freeze(this);
  }
}

// Mutable recovery state within a turn is held only by RecoveryManager; external callers observe through read-only snapshots.
export interface RecoveryState {
  // Model and output budget actually used to send requests currently.
  currentModel: string;
  currentMaxTokens: number;
  // Whether escalated from the initial budget, preventing duplicate escalation branches.
  hasEscalated: boolean;
  // Count of appended continuation fragments.
  recoveryCount: number;
  // Count of consecutive 529s; switches to fallback after reaching the threshold.
  consecutive529: number;
  // Whether prompt-too-long reactive compaction has already executed for the current window.
  hasAttemptedReactiveCompact: boolean;
}

export interface RecoveryManagerOptions {
  // Raw model invocation boundary; all retries remain attributed to the same logical request.
  readonly model: ModelClient;
  // Context compactor reused during prompt-too-long.
  readonly compaction: CompactionManager;
  // Fixed constraints for budget, backoff, fallback, and deadline.
  readonly config: RecoveryConfig;
  readonly monotonic?: () => number;
  readonly utcNow?: () => Date;
  readonly sleeper?: (seconds: number, signal: AbortSignal) => Promise<void>;
  readonly jitter?: (upperBound: number) => number;
  readonly cancellation?: CancellationToken;
}

// Each user turn shares a total deadline; retries, compaction, and continuations cannot extend the time limit independently.
export class RecoveryManager {
  readonly #model: ModelClient;
  readonly #compaction: CompactionManager;
  readonly #config: RecoveryConfig;
  readonly #monotonic: () => number;
  readonly #utcNow: () => Date;
  readonly #sleeper: (seconds: number, signal: AbortSignal) => Promise<void>;
  readonly #jitter: (upperBound: number) => number;
  readonly #cancellation: CancellationToken;
  #state: RecoveryState | undefined;
  // Total deadline for a single turn; retries, sleep, and compaction share this deadline.
  #deadline: number | undefined;

  constructor(options: RecoveryManagerOptions) {
    if (typeof options.model?.complete !== "function") {
      throw new TypeError("model must implement ModelClient");
    }
    if (!(options.compaction instanceof CompactionManager)) {
      throw new TypeError("compaction must be a CompactionManager");
    }
    if (!(options.config instanceof RecoveryConfig)) {
      throw new TypeError("config must be a RecoveryConfig");
    }
    if (options.monotonic !== undefined && typeof options.monotonic !== "function") {
      throw new TypeError("monotonic must be a function");
    }
    if (options.utcNow !== undefined && typeof options.utcNow !== "function") {
      throw new TypeError("utcNow must be a function");
    }
    if (options.sleeper !== undefined && typeof options.sleeper !== "function") {
      throw new TypeError("sleeper must be a function");
    }
    if (options.jitter !== undefined && typeof options.jitter !== "function") {
      throw new TypeError("jitter must be a function");
    }
    if (
      options.cancellation !== undefined &&
      !(options.cancellation instanceof CancellationToken)
    ) {
      throw new TypeError("cancellation must be a CancellationToken");
    }
    this.#model = options.model;
    this.#compaction = options.compaction;
    this.#config = options.config;
    this.#monotonic =
      options.monotonic === undefined ? () => performance.now() / 1_000 : options.monotonic;
    this.#utcNow = options.utcNow === undefined ? () => new Date() : options.utcNow;
    this.#sleeper = options.sleeper === undefined ? sleep : options.sleeper;
    this.#jitter =
      options.jitter === undefined ? (upperBound) => Math.random() * upperBound : options.jitter;
    this.#cancellation =
      options.cancellation === undefined ? new CancellationToken() : options.cancellation;
  }

  get state(): Readonly<RecoveryState> {
    if (this.#state === undefined) {
      throw new RecoveryError("Recovery turn has not been started");
    }
    return Object.freeze({ ...this.#state });
  }

  beginTurn(): void {
    // State resets at the turn boundary to prevent fallbacks, length escalations, or retry counts from leaking into the next request.
    const startedAt = this.#monotonicNow();
    this.#state = {
      currentModel: this.#config.primaryModel,
      currentMaxTokens: this.#config.initialMaxTokens,
      hasEscalated: false,
      recoveryCount: 0,
      consecutive529: 0,
      hasAttemptedReactiveCompact: false,
    };
    this.#deadline = startedAt + this.#config.totalTimeoutSeconds;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
    // External AbortSignal and internal CancellationToken share the same cancellation boundary; callers can actively interrupt.
    const state = this.#requireState();
    validateToolPairing(request.messages);
    // complete() accepts only the raw request from the outer Loop: model must still be primary, and maxTokens must be initial.
    // Overrides inside RecoveryManager occur only via local state/effectiveRequest to prevent callers from bypassing recovery state.
    if (request.model !== undefined && request.model !== this.#config.primaryModel) {
      throw new RangeError("request.model must match RecoveryConfig.primaryModel");
    }
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) ||
        request.maxTokens <= 0 ||
        request.maxTokens !== this.#config.initialMaxTokens)
    ) {
      throw new RangeError("request.maxTokens must match RecoveryConfig.initialMaxTokens");
    }

    let requestMessages = Object.freeze([...request.messages]);
    const fragments: string[] = [];
    let promptTooLongRetries = 0;
    let transientFailures = 0;
    state.hasAttemptedReactiveCompact = false;

    while (true) {
      // The loop retries only within one logical request: length upgrades, continuations, compaction, and transient backoffs return the same ModelReply.
      // Reconstruct the full request snapshot on each attempt; model and maxTokens change with recovery state.
      const effectiveRequest: ModelRequest = Object.freeze({
        ...request,
        messages: requestMessages,
        model: state.currentModel,
        maxTokens: state.currentMaxTokens,
      });
      let reply: ModelReply;
      try {
        reply = await this.#runBounded(
          (requestSignal) => this.#model.complete(effectiveRequest, requestSignal),
          signal,
        );
      } catch (error) {
        // Enters recovery branch only for recognized model boundary errors; re-throws other errors as-is.
        if (error instanceof ModelRateLimitError) {
          // 429 is a rate limit signal and does not accumulate toward 529 fallback.
          state.consecutive529 = 0;
          transientFailures += 1;
          await this.#retryTransient(transientFailures, error.retryAfter, "rate limit", signal);
          continue;
        }
        if (error instanceof ModelOverloadedError) {
          // Switch to fallback after consecutive 529 responses reach the threshold; only the next request explicitly carries the new model.
          state.consecutive529 += 1;
          if (state.consecutive529 >= this.#config.overloadFallbackThreshold) {
            state.currentModel = this.#config.fallbackModel;
            state.consecutive529 = 0;
          }
          transientFailures += 1;
          await this.#retryTransient(transientFailures, undefined, "overload", signal);
          continue;
        }
        if (error instanceof ModelPromptTooLongError) {
          // When the input is too long, keep the first system message, and compact the request snapshot only once.
          state.consecutive529 = 0;
          const [leadingSystem, compactableHistory] = splitLeadingSystem(requestMessages);
          const outcome = await this.#runBounded(
            (requestSignal) =>
              this.#compaction.compactOnPromptTooLong(
                compactableHistory,
                {
                  retryCount: promptTooLongRetries,
                },
                requestSignal,
              ),
            signal,
          );
          promptTooLongRetries += 1;
          state.hasAttemptedReactiveCompact = true;
          requestMessages = Object.freeze([...leadingSystem, ...outcome.history]);
          validateToolPairing(requestMessages);
          continue;
        }
        throw error;
      }

      transientFailures = 0;
      state.consecutive529 = 0;
      if (reply.finishReason !== "length") {
        // Return immediately on normal completion; merge fragments only into the final reply.
        state.hasAttemptedReactiveCompact = false;
        return mergeFragments(reply, fragments);
      }
      if (!state.hasEscalated) {
        // On first length finish, escalate output budget, discard incomplete reply completely, and retry the same request.
        state.currentMaxTokens = this.#config.escalatedMaxTokens;
        state.hasEscalated = true;
        continue;
      }
      const fragment = reply.message.content;
      // When length occurs even after increasing budget, put text fragments and continuation prompts into local requestMessages.
      if (reply.message.toolCalls.length > 0 || fragment === null || fragment.length === 0) {
        throw new RecoveryRetriesExhausted(
          "length recovery requires a non-empty text-only assistant fragment",
        );
      }
      if (state.recoveryCount >= this.#config.maxContinuations) {
        throw new RecoveryRetriesExhausted("continuation recovery attempts exhausted");
      }
      fragments.push(fragment);
      requestMessages = Object.freeze([
        ...requestMessages,
        reply.message,
        userMessage(CONTINUATION_PROMPT),
      ]);
      validateToolPairing(requestMessages);
      state.recoveryCount += 1;
    }
  }

  async #retryTransient(
    transientFailures: number,
    retryAfter: string | undefined,
    label: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // 429/529 share a transient retry path: check count and deadline first, then sleep.
    // Retry counts and wait times are constrained by the total deadline and cannot queue past the turn timeout.
    if (transientFailures >= this.#config.maxTransientAttempts) {
      throw new RecoveryRetriesExhausted(`${label} recovery attempts exhausted`);
    }
    const delay =
      retryAfter === undefined
        ? this.#backoffDelay(transientFailures - 1)
        : this.#parseRetryAfter(retryAfter);
    if (delay >= this.#remainingSeconds()) {
      throw new RecoveryDeadlineExceeded("retry delay would reach or cross the turn deadline");
    }
    await this.#runBounded((requestSignal) => this.#sleeper(delay, requestSignal), signal);
  }

  #parseRetryAfter(value: string): number {
    // Seconds take precedence; HTTP-date must have an explicit time zone; invalid values do not sleep and do not retry.
    const normalized = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(normalized)) {
      const delay = Number(normalized);
      if (Number.isFinite(delay)) {
        return delay;
      }
      throw new InvalidRetryAfterError("Retry-After seconds must be finite");
    }
    const target = Date.parse(normalized);
    if (!Number.isFinite(target) || !/(?:\b(?:GMT|UTC)\b|[+-]\d{4})$/i.test(normalized)) {
      throw new InvalidRetryAfterError("Retry-After is not seconds or an HTTP date");
    }
    const now = this.#utcNow();
    if (Number.isNaN(now.getTime())) {
      throw new RecoveryError("UTC clock must return a valid Date");
    }
    return Math.max(0, (target - now.getTime()) / 1_000);
  }

  #backoffDelay(attempt: number): number {
    // Exponential backoff caps at 32 seconds and adds injectable jitter to prevent simultaneous retries in the same request batch.
    const base = Math.min(
      this.#config.baseDelaySeconds * 2 ** attempt,
      this.#config.maxDelaySeconds,
    );
    const upperBound = base * this.#config.jitterRatio;
    const jitter = this.#jitter(upperBound);
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > upperBound) {
      throw new RecoveryError("jitter must return a finite value within its upper bound");
    }
    return base + jitter;
  }

  async #runBounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined = undefined,
  ): Promise<T> {
    // Model calls, sleep, and reactive compaction all run within the same cancellation/timeout boundary.
    // Cancellation or timeout aborts boundary operations first, then waits for convergence, leaving no background requests or summary writes behind.
    this.#raiseIfCancelled();
    const remaining = this.#remainingSeconds();
    const controller = new AbortController();
    if (signal?.aborted) {
      // If an external signal is already aborted when the request begins, fail before starting operations to avoid meaningless calls.
      controller.abort();
      throw new RecoveryCancelledError("recovery request was cancelled");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const deadlinePromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RecoveryDeadlineExceeded("turn deadline exceeded")),
        remaining * 1_000,
      );
    });
    let unsubscribeCancellation = () => {};
    const cancellationPromise = new Promise<never>((_resolve, reject) => {
      unsubscribeCancellation = this.#cancellation.subscribe(() => {
        controller.abort();
        reject(new RecoveryCancelledError("recovery turn was cancelled"));
      });
    });
    let unsubscribeRequestCancellation = () => {};
    const requestCancellationPromise = new Promise<never>((_resolve, reject) => {
      // When an external signal cancels, abort the model call first; listeners must be removed before completion.
      if (signal === undefined) {
        return;
      }
      const cancel = () => {
        controller.abort();
        reject(new RecoveryCancelledError("recovery request was cancelled"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      unsubscribeRequestCancellation = () => signal.removeEventListener("abort", cancel);
    });
    try {
      const result = await Promise.race([
        operationPromise,
        deadlinePromise,
        cancellationPromise,
        requestCancellationPromise,
      ]);
      this.#raiseIfCancelled();
      this.#remainingSeconds();
      return result;
    } catch (error) {
      if (error instanceof RecoveryCancelledError || error instanceof RecoveryDeadlineExceeded) {
        controller.abort();
        await operationPromise.catch(() => undefined);
      }
      throw error;
    } finally {
      unsubscribeCancellation();
      unsubscribeRequestCancellation();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      controller.abort();
    }
  }

  #remainingSeconds(): number {
    // Fail immediately when remaining time <= 0, instead of sleeping before timeout.
    if (this.#deadline === undefined) {
      throw new RecoveryError("Recovery turn has not been started");
    }
    const remaining = this.#deadline - this.#monotonicNow();
    if (remaining <= 0) {
      throw new RecoveryDeadlineExceeded("turn deadline exceeded");
    }
    return remaining;
  }

  #raiseIfCancelled(): void {
    if (this.#cancellation.isCancelled) {
      throw new RecoveryCancelledError("recovery turn was cancelled");
    }
  }

  #monotonicNow(): number {
    const value = this.#monotonic();
    if (!Number.isFinite(value)) {
      throw new RecoveryError("monotonic clock must return a finite number");
    }
    return value;
  }

  #requireState(): RecoveryState {
    if (this.#state === undefined) {
      throw new RecoveryError("Recovery turn has not been started");
    }
    return this.#state;
  }
}

function mergeFragments(reply: ModelReply, fragments: readonly string[]): ModelReply {
  // Successful replies concatenate final text fragments only, without automatically padding spaces or rewriting content.
  if (fragments.length === 0) {
    return reply;
  }
  return Object.freeze({
    ...reply,
    message: {
      ...reply.message,
      content: `${fragments.join("")}${reply.message.content ?? ""}`,
    },
  });
}

function splitLeadingSystem(
  messages: readonly ChatMessage[],
): readonly [readonly ChatMessage[], readonly ChatMessage[]] {
  // system must remain first in the request; when system is absent, the entire snapshot can be compacted.
  if (messages.length > 1 && messages[0]?.role === "system") {
    return Object.freeze([Object.freeze([messages[0]]), Object.freeze(messages.slice(1))]);
  }
  return Object.freeze([Object.freeze([]), Object.freeze([...messages])]);
}

function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  // Default sleeper responds to AbortSignal, ending immediately with RecoveryCancelledError upon cancellation.
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, seconds * 1_000);
    const cancel = () => {
      clearTimeout(timeout);
      reject(new RecoveryCancelledError("recovery turn was cancelled"));
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function option(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value;
}

function nonEmptyText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(name: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(name: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function positiveFinite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}
