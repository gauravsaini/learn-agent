// Managed Git Worktree domain and runtime: bind task lease, branch, directory, Execution Context, and cleanup audit into a state chain.
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from "../core/tools.js";
import type { ToolContextProvider } from "../core/loop.js";
import { toolError, toolSuccess } from "../core/tools.js";
import { canonicalAgentName } from "./mailbox.js";
import { canonicalTaskId, TaskError, TaskStatus } from "./tasks.js";
import type { TaskCompletion } from "./tasks.js";
import {
  canonicalClaimToken,
  type LeasedTaskStore,
  type TaskClaim,
  type TaskClaimService,
} from "./work-stealing.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const INVALID_REF_CHARACTERS = new Set([" ", "~", "^", ":", "?", "*", "[", "\\"]);

export class GitExecutionError extends Error {
  // Indicates only that the Git process failed to start or timed out; normal non-zero exit codes are carried by structured results.
  override readonly name = "GitExecutionError";
}

export interface GitCommandResult {
  // Preserves exit code and both streams; domain layer does not parse shell concatenated text.
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  // Argument arrays map directly to argv; the adapter must verify cwd is a real directory.
  run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult>;
}

export const WorktreeStatus = Object.freeze({
  RESERVED: "reserved",
  ACTIVE: "active",
  KEPT: "kept",
  NEEDS_REVIEW: "needs_review",
  REMOVED: "removed",
} as const);

export type WorktreeStatus = (typeof WorktreeStatus)[keyof typeof WorktreeStatus];

export const WorktreeAction = Object.freeze({
  RESERVE: "reserve",
  CREATE: "create",
  KEEP: "keep",
  NEEDS_REVIEW: "needs_review",
  REMOVE: "remove",
} as const);

export type WorktreeAction = (typeof WorktreeAction)[keyof typeof WorktreeAction];

export class WorktreeError extends TaskError {
  // Reuse stable TaskError codes so tool boundaries can return structured failures directly.
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "WorktreeError";
  }
}

export class WorktreeRepositoryError extends WorktreeError {
  // Repository root, Git metadata, or ref resolution does not satisfy controlled conditions.
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_repository_error", message, options);
    this.name = "WorktreeRepositoryError";
  }
}

export class WorktreeStateError extends WorktreeError {
  // Conflicts in binding state, task state, or migration preconditions.
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_invalid_state", message, options);
    this.name = "WorktreeStateError";
  }
}

export class WorktreeGitError extends WorktreeError {
  // Git command executed, but the result does not meet domain expectations.
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_git_error", message, options);
    this.name = "WorktreeGitError";
  }
}

export class WorktreeContextError extends WorktreeError {
  // Tool context lacks claim/scope or is inconsistent with current lease.
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_context_error", message, options);
    this.name = "WorktreeContextError";
  }
}

export interface WorktreeBindingOptions {
  // task/name uniquely determines branch and relativePath; callers cannot customize arbitrary directories.
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly status: WorktreeStatus;
  readonly reviewReason: string | null;
  readonly createdAtUtc: Date;
  readonly updatedAtUtc: Date;
}

export class WorktreeBinding {
  // Current state snapshot; SQLite event tables save immutable history separately.
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly status: WorktreeStatus;
  readonly reviewReason: string | null;
  readonly createdAtUtc: Date;
  readonly updatedAtUtc: Date;

  constructor(options: WorktreeBindingOptions) {
    // Centrally validates naming, paths, references, state/reason pairs, and time monotonicity, then freezes the instance.
    this.taskId = canonicalTaskId(options.taskId);
    this.name = canonicalAgentName(options.name);
    if (options.branch !== `wt/${this.name}`) {
      throw new WorktreeStateError("Worktree branch must match the managed name");
    }
    if (options.relativePath !== `.agent_tutorial/worktrees/${this.name}`) {
      throw new WorktreeStateError("Worktree path must match the managed name");
    }
    if (!isWorktreeStatus(options.status))
      throw new WorktreeStateError("Worktree status is invalid");
    const reason = normalizeReason(options.reviewReason);
    if (options.status === WorktreeStatus.NEEDS_REVIEW ? reason === null : reason !== null) {
      throw new WorktreeStateError("Worktree review reason does not match its status");
    }
    this.branch = options.branch;
    this.relativePath = options.relativePath;
    this.integrationRef = canonicalIntegrationRef(options.integrationRef);
    this.baselineCommit = canonicalGitObjectId(options.baselineCommit);
    this.branchTip = options.branchTip === null ? null : canonicalGitObjectId(options.branchTip);
    this.status = options.status;
    this.reviewReason = reason;
    this.createdAtUtc = validUtcDate(options.createdAtUtc, "Worktree creation time");
    this.updatedAtUtc = validUtcDate(options.updatedAtUtc, "Worktree update time");
    if (this.updatedAtUtc < this.createdAtUtc) {
      throw new WorktreeStateError("Worktree updatedAtUtc precedes createdAtUtc");
    }
    Object.freeze(this);
  }
}

export interface WorktreeEventOptions {
  // Event copies key fields of the current binding so audit does not depend on subsequent state tables.
  readonly sequence: number;
  readonly action: WorktreeAction;
  readonly status: WorktreeStatus;
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly reason: string | null;
  readonly createdAtUtc: Date;
}

export class WorktreeEvent {
  // SQLite autoincrement generates sequence; action must correspond one-to-one with target status.
  readonly sequence: number;
  readonly action: WorktreeAction;
  readonly status: WorktreeStatus;
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly reason: string | null;
  readonly createdAtUtc: Date;

  constructor(options: WorktreeEventOptions) {
    // Reuse WorktreeBinding to validate event payloads; audit tables will not accept looser data.
    if (!Number.isInteger(options.sequence) || options.sequence <= 0) {
      throw new WorktreeStateError("Worktree event sequence must be positive");
    }
    if (!isWorktreeAction(options.action) || !isWorktreeStatus(options.status)) {
      throw new WorktreeStateError("Worktree event action or status is invalid");
    }
    if (eventStatus(options.action) !== options.status) {
      throw new WorktreeStateError("Worktree event action and status do not match");
    }
    const binding = new WorktreeBinding({
      taskId: options.taskId,
      name: options.name,
      branch: options.branch,
      relativePath: options.relativePath,
      integrationRef: options.integrationRef,
      baselineCommit: options.baselineCommit,
      branchTip: options.branchTip,
      status: options.status,
      reviewReason: options.reason,
      createdAtUtc: options.createdAtUtc,
      updatedAtUtc: options.createdAtUtc,
    });
    this.sequence = options.sequence;
    this.action = options.action;
    this.status = options.status;
    this.taskId = binding.taskId;
    this.name = binding.name;
    this.branch = binding.branch;
    this.relativePath = binding.relativePath;
    this.integrationRef = binding.integrationRef;
    this.baselineCommit = binding.baselineCommit;
    this.branchTip = binding.branchTip;
    this.reason = binding.reviewReason;
    this.createdAtUtc = binding.createdAtUtc;
    Object.freeze(this);
  }
}

export interface WorktreeStore extends LeasedTaskStore {
  // task, binding, claim token, and append-only events must be implemented by the same atomic store.
  reserveWorktree(binding: WorktreeBinding): Promise<WorktreeBinding>;
  activateWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding>;
  keepWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding>;
  markWorktreeNeedsReview(
    taskId: string,
    options: {
      readonly branchTip: string | null;
      readonly reason: string;
      readonly occurredAtUtc: Date;
    },
  ): Promise<WorktreeBinding>;
  markWorktreeRemoved(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding>;
  getWorktreeBinding(taskId: string): Promise<WorktreeBinding>;
  listWorktreeEvents(): Promise<readonly WorktreeEvent[]>;
  claimNextBound(owner: string): Promise<TaskClaim | undefined>;
  lookupClaim(claimToken: string): Promise<TaskClaim | undefined>;
}

const taskIdSchema = z.strictObject({ task_id: z.string().uuid().toLowerCase() });
const createWorktreeSchema = z.strictObject({
  task_id: z.string().uuid().toLowerCase(),
  name: z.string().trim().min(1),
  integration_ref: z.string().trim().min(1),
});

// Managed worktrees bind task, branch, and Execution Context, defaulting to manual review when cleanup safety cannot be proven.
export class WorktreeRuntime implements TaskClaimService, ToolContextProvider {
  // workspaceRoot is pinned to repository root; all managed paths derive from binding.relativePath.
  readonly #workspaceRoot: string;
  readonly #store: WorktreeStore;
  readonly #git: GitRunner;
  readonly #clock: () => Date;
  // executionScope -> claimToken mapping; consecutive tool calls in the same reply share this binding.
  readonly #scopeClaims = new WeakMap<object, string>();
  #repositoryValidated = false;

  constructor(options: {
    readonly workspace: string;
    readonly store: WorktreeStore;
    readonly gitRunner: GitRunner;
    readonly clock?: () => Date;
  }) {
    // Validate only dependency shapes at construction; validateRepository explicitly performs and caches real repository checks.
    if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (!isWorktreeStore(options.store)) throw new TypeError("store must implement WorktreeStore");
    if (typeof options.gitRunner.run !== "function")
      throw new TypeError("gitRunner must implement run()");
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    this.#workspaceRoot = resolve(options.workspace);
    this.#store = options.store;
    this.#git = options.gitRunner;
    this.#clock = options.clock === undefined ? () => new Date() : options.clock;
  }

  get workspaceRoot(): string {
    // AgentRunner uses this value to verify that provider and initial workspace share the same root.
    return this.#workspaceRoot;
  }

  get store(): WorktreeStore {
    // WorkStealingRuntime uses reference identity to confirm the claim service and SQLite store did not fork.
    return this.#store;
  }

  get leadToolDefinitions(): ReturnType<typeof worktreeToolDefinitions> {
    // Management tools are registered only to Lead; sub-executors consume only bound execution directories.
    return worktreeToolDefinitions(this);
  }

  async validateRepository(): Promise<void> {
    // Precondition gate for all Worktree operations: workspace must be the real root directory of the main repository,
    // This ensures relativePath, .git/common-dir, and subsequent cleanup checks share the same coordinate system.
    // Only accept Git repository root: Worktree paths are relative to the repository root,
    // Subdirectories cannot form controllable isolation boundaries. Cache after validation passes to avoid repeated probing on every tool call.
    if (this.#repositoryValidated) return;
    let root: string;
    try {
      root = await realpath(this.#workspaceRoot);
      if (!(await stat(root)).isDirectory()) throw new Error("workspace is not a directory");
    } catch (error) {
      throw new WorktreeRepositoryError("workspace is not a Git repository", { cause: error });
    }
    const inside = await this.#runGit(["rev-parse", "--is-inside-work-tree"], root);
    if (inside.returncode !== 0 || inside.stdout.trim() !== "true") {
      throw new WorktreeRepositoryError("workspace is not a Git repository");
    }
    const top = await this.#runGit(["rev-parse", "--show-toplevel"], root);
    if (top.returncode !== 0)
      throw new WorktreeRepositoryError("workspace is not a Git repository");
    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(top.stdout.trim());
    } catch (error) {
      throw new WorktreeRepositoryError("Git repository root could not be resolved", {
        cause: error,
      });
    }
    if (repositoryRoot !== root) {
      throw new WorktreeRepositoryError("workspace is not a Git repository root");
    }
    this.#repositoryValidated = true;
  }

  async createWorktree(input: {
    readonly taskId: string;
    readonly name: string;
    readonly integrationRef: string;
  }): Promise<WorktreeBinding> {
    // The creation flow treats persistent bindings as intent records and Git as external side effects;
    // Activate binding only after worktree, branch, and branch tip are all confirmed via readback.
    // Cross-system creation cannot pretend atomicity: persist reserved intent in SQLite first,
    // Executes git worktree add next; transaction transitions to active only after Git verification succeeds.
    await this.validateRepository();
    const taskId = canonicalTaskId(input.taskId);
    const name = canonicalAgentName(input.name);
    const integrationRef = canonicalIntegrationRef(input.integrationRef);
    const task = await this.#store.getTask(taskId);
    if (task.status !== TaskStatus.PENDING) {
      throw new WorktreeStateError(
        `Task ${task.id} is ${task.status}; creating a worktree requires pending`,
      );
    }
    const baseline = await this.#resolveCommit(integrationRef, this.#workspaceRoot);
    const now = this.#now();
    const binding = await this.#store.reserveWorktree(
      new WorktreeBinding({
        taskId,
        name,
        branch: `wt/${name}`,
        relativePath: `.agent_tutorial/worktrees/${name}`,
        integrationRef,
        baselineCommit: baseline,
        branchTip: null,
        status: WorktreeStatus.RESERVED,
        reviewReason: null,
        createdAtUtc: now,
        updatedAtUtc: now,
      }),
    );
    const path = await this.#prepareNewWorktreePath(binding);
    const result = await this.#runGit(
      ["worktree", "add", "-b", binding.branch, path, binding.baselineCommit],
      this.#workspaceRoot,
    );
    if (result.returncode !== 0)
      throw new WorktreeGitError("Git could not create the reserved worktree");
    const branchTip = await this.#resolveCommit("HEAD", path);
    const branch = await this.#runGit(["branch", "--show-current"], path);
    if (branch.returncode !== 0 || branch.stdout.trim() !== binding.branch) {
      throw new WorktreeGitError("Git created a worktree with an unexpected branch");
    }
    return await this.#store.activateWorktree(binding.taskId, {
      branchTip,
      occurredAtUtc: this.#now(),
    });
  }

  async keepWorktree(taskId: string): Promise<WorktreeBinding> {
    // Handles only completed + active; transitions to needs_review when uncommitted changes exist.
    // Explicitly retain the Worktree of completed tasks for review or follow-up processing.
    // When the branch tip cannot be proven, transition to needs_review; do not fake successful retention.
    const binding = await this.#completedBinding(taskId, [WorktreeStatus.ACTIVE]);
    let branchTip: string;
    try {
      const path = await this.#registeredWorktreePath(binding, true);
      branchTip = await this.#resolveCommit("HEAD", path);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "managed worktree path or branch tip could not be resolved",
      );
    }
    return await this.#store.keepWorktree(binding.taskId, {
      branchTip,
      occurredAtUtc: this.#now(),
    });
  }

  async removeWorktree(taskId: string): Promise<WorktreeBinding> {
    // Verify managed paths and Git registries before deletion; preserve the site for manual review when safety cannot be proven.
    // Cleans up only worktrees that are completed, clean, and confirmed merged into integration branch, avoiding deletion of undelivered work.
    // Cleanup chain verifies step by step: registered path, clean git status, branch tip merged
    // integration ref, detach HEAD, delete branch, git worktree remove;
    // Transitions to needs_review on any step failure, preserving state for manual inspection.
    const binding = await this.#completedBinding(taskId, [
      WorktreeStatus.ACTIVE,
      WorktreeStatus.KEPT,
      WorktreeStatus.NEEDS_REVIEW,
    ]);
    let path: string;
    try {
      path = await this.#registeredWorktreePath(binding, true);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "managed worktree path is unavailable or escapes the workspace",
      );
    }
    if (!(await this.#isRegisteredWorktree(binding, path))) {
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "managed path is not the registered worktree and branch",
      );
    }
    const status = await this.#runGit(["status", "--porcelain=v1", "--untracked-files=all"], path);
    if (status.returncode !== 0) {
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "git status could not prove the worktree is clean",
      );
    }
    if (status.stdout.length > 0) {
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "worktree has uncommitted changes",
      );
    }
    let branchTip: string;
    let integrationTip: string;
    try {
      branchTip = await this.#resolveCommit("HEAD", path);
      integrationTip = await this.#resolveCommit(binding.integrationRef, this.#workspaceRoot);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "integration ref or branch tip could not be resolved",
      );
    }
    const ancestry = await this.#runGit(
      ["merge-base", "--is-ancestor", branchTip, integrationTip],
      this.#workspaceRoot,
    );
    if (ancestry.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "worktree branch tip is not contained by the integration ref",
      );
    }
    const detach = await this.#runGit(["switch", "--detach", branchTip], path);
    if (detach.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "git could not detach the managed worktree",
      );
    }
    const deleteBranch = await this.#runGit(["branch", "-d", binding.branch], this.#workspaceRoot);
    if (deleteBranch.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "git could not safely delete the integrated branch",
      );
    }
    const removal = await this.#runGit(["worktree", "remove", path], this.#workspaceRoot);
    if (removal.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "git could not remove the detached worktree",
      );
    }
    return await this.#store.markWorktreeRemoved(binding.taskId, {
      branchTip,
      occurredAtUtc: this.#now(),
    });
  }

  async claimTask(taskId: string, context: ToolContext): Promise<TaskClaim> {
    // Manual claims permit active bindings only; owners are still provided by ToolContext.identity.
    // Manual claims must fall on active Worktrees and associate claimToken with current executionScope,
    // Allow subsequent tool calls in the same assistant reply to resolve directly to that Worktree.
    const binding = await this.#store.getWorktreeBinding(taskId);
    if (binding.status !== WorktreeStatus.ACTIVE) {
      throw new WorktreeStateError(`Task ${binding.taskId} does not have an active worktree`);
    }
    if (context.executionScope === undefined) {
      throw new WorktreeContextError("Task claim requires an execution scope");
    }
    const claim = await this.#store.claimTask(binding.taskId, context.identity);
    this.#scopeClaims.set(context.executionScope, claim.claimToken);
    return claim;
  }

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    // Auto-claim scans only ready tasks corresponding to active bindings.
    // Auto-claim uses claimNextBound: picks only ready tasks with existing active bindings,
    // Prevents idle polling from bypassing Worktree constraints.
    return await this.#store.claimNextBound(owner);
  }

  async completeTask(
    taskId: string,
    claimToken: string,
    context: ToolContext,
  ): Promise<TaskCompletion> {
    // Before completion, re-resolve the claim with the current context first, then check explicit task/claimToken;
    // Completion updates only the store without modifying executionScope; subsequent calls are still re-validated by resolve() against leases.
    const resolved = await this.resolve(context);
    const normalizedTaskId = canonicalTaskId(taskId);
    const normalizedToken = canonicalClaimToken(claimToken);
    if (resolved.taskId !== normalizedTaskId || resolved.claimToken !== normalizedToken) {
      throw new WorktreeContextError("Task completion does not match the resolved execution claim");
    }
    const outcome = await this.#store.completeTask(
      normalizedTaskId,
      context.identity,
      normalizedToken,
    );
    return outcome;
  }

  async resolve(context: ToolContext): Promise<ToolContext> {
    // Prioritizes explicit tokens, then uses executionScope mappings from the same assistant reply;
    // Replace only workspace and append task/claim/worktree fields on success.
    // Re-resolve leases on each tool call to prevent stale tokens or other identities from breaching task isolation boundaries.
    // Resolution priority: explicit claimToken, executionScope mapping, and finally main workspace without claim;
    // When a claim exists, it must pass validation of owner, task, binding, Worktree name, and path.
    const token = this.#explicitContextToken(context);
    if (!token.required) {
      if (context.taskId !== undefined) {
        throw new WorktreeContextError("Explicit task context does not have an active claim");
      }
      return contextForWorkspace(context, this.#workspaceRoot);
    }
    let claim: TaskClaim | undefined;
    try {
      claim = await this.#store.lookupClaim(token.value);
    } catch (error) {
      if (error instanceof TaskError) {
        throw new WorktreeContextError("Execution claim is no longer active", { cause: error });
      }
      throw error;
    }
    if (claim === undefined) {
      throw new WorktreeContextError("Execution claim does not have a known active lease");
    }
    if (claim.task.owner !== context.identity) {
      throw new WorktreeContextError("Execution identity does not own the active Task claim");
    }
    if (context.taskId !== undefined && context.taskId !== claim.task.id) {
      throw new WorktreeContextError("Execution task does not match the active Task claim");
    }
    const binding = await this.#store.getWorktreeBinding(claim.task.id);
    if (binding.status !== WorktreeStatus.ACTIVE) {
      throw new WorktreeContextError("Active Task claim does not have an active worktree binding");
    }
    if (context.worktreeName !== undefined && context.worktreeName !== binding.name) {
      throw new WorktreeContextError("Execution worktree does not match the active Task binding");
    }
    const path = await this.#registeredWorktreePath(binding, true);
    return Object.freeze({
      ...context,
      workspace: path,
      taskId: claim.task.id,
      claimToken: claim.claimToken,
      worktreeName: binding.name,
    });
  }

  async #completedBinding(
    taskId: string,
    allowed: readonly WorktreeStatus[],
  ): Promise<WorktreeBinding> {
    // Terminal operations share task completed and allowed state checks, preventing keep and remove from drifting apart.
    // Before terminal operations, uniformly verify that Task is completed and binding is in an allowed state.
    await this.validateRepository();
    const normalized = canonicalTaskId(taskId);
    const task = await this.#store.getTask(normalized);
    if (task.status !== TaskStatus.COMPLETED) {
      throw new WorktreeStateError(
        `Task ${task.id} is ${task.status}; worktree finalization requires completed`,
      );
    }
    const binding = await this.#store.getWorktreeBinding(normalized);
    if (!allowed.includes(binding.status)) {
      throw new WorktreeStateError(
        `Worktree binding ${binding.taskId} is ${binding.status}; transition is not allowed`,
      );
    }
    return binding;
  }

  async #needsReview(
    binding: WorktreeBinding,
    branchTip: string | null,
    reason: string,
  ): Promise<WorktreeBinding> {
    // This is the unified exit for all branches that cannot prove safe cleanup; keeping the status quo is safer than faking a transition,
    // Therefore kept/needs_review will not be rewritten repeatedly, and active will append audit events.
    // Cleanup failures fall back to needs_review; non-active states stay unchanged to avoid duplicate or fictitious transitions.
    if (binding.status !== WorktreeStatus.ACTIVE) return binding;
    return await this.#store.markWorktreeNeedsReview(binding.taskId, {
      branchTip,
      reason,
      occurredAtUtc: this.#now(),
    });
  }

  async #resolveCommit(reference: string, cwd: string): Promise<string> {
    // `rev-parse --verify <ref>^{commit}` pins the branch or tag to an immutable object ID.
    // Use git rev-parse --verify to fix the commit, avoiding passing arbitrary strings to the shell or weak reference resolution.
    const result = await this.#runGit(["rev-parse", "--verify", `${reference}^{commit}`], cwd);
    if (result.returncode !== 0) {
      throw new WorktreeRepositoryError("Git reference could not be resolved to a commit");
    }
    try {
      return canonicalGitObjectId(result.stdout.trim());
    } catch (error) {
      throw new WorktreeRepositoryError("Git returned an invalid commit object ID", {
        cause: error,
      });
    }
  }

  // Use git rev-parse to verify the worktree remains registered under main repo .git, and the current branch matches the binding.
  async #isRegisteredWorktree(binding: WorktreeBinding, path: string): Promise<boolean> {
    // Check path, branch, and HEAD together; do not assume management solely based on directory existence.
    const [top, common, branch] = await Promise.all([
      this.#runGit(["rev-parse", "--show-toplevel"], path),
      this.#runGit(["rev-parse", "--git-common-dir"], path),
      this.#runGit(["branch", "--show-current"], path),
    ]);
    if (top.returncode !== 0 || common.returncode !== 0 || branch.returncode !== 0) return false;
    try {
      const topPath = await realpath(top.stdout.trim());
      const rawCommon = common.stdout.trim();
      const commonPath = await realpath(isAbsolute(rawCommon) ? rawCommon : join(path, rawCommon));
      const expectedCommon = await realpath(join(this.#workspaceRoot, ".git"));
      return (
        topPath === path && commonPath === expectedCommon && branch.stdout.trim() === binding.branch
      );
    } catch {
      return false;
    }
  }

  // Git child process startup failures uniformly convert to returncode -1, allowing callers to handle command failure rather than interrupting execution.
  async #runGit(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    // Adapter exceptions are converted to domain errors; normal non-zero exit codes are still interpreted by specific operations.
    try {
      return await this.#git.run(argumentsValue, cwd);
    } catch (error) {
      if (error instanceof GitExecutionError) return { returncode: -1, stdout: "", stderr: "" };
      throw error;
    }
  }

  async #prepareNewWorktreePath(binding: WorktreeBinding): Promise<string> {
    // New directories must reside inside the fixed root and not yet exist. Validate boundaries again after creating parent directories.
    // Only create managed parent directories and verify the real path remains inside the workspace; the target path must not exist yet.
    const path = await this.#registeredWorktreePath(binding, false);
    const parent = join(path, "..");
    try {
      await mkdir(parent, { recursive: true });
      const resolvedParent = await realpath(parent);
      if (resolvedParent !== resolve(parent) || !isWithin(this.#workspaceRoot, resolvedParent)) {
        throw new Error("parent escapes workspace");
      }
    } catch (error) {
      throw new WorktreeStateError("Managed worktree parent could not be created", {
        cause: error,
      });
    }
    try {
      await lstat(path);
      throw new WorktreeStateError("Managed worktree path already exists");
    } catch (error) {
      if (error instanceof WorktreeStateError) throw error;
      if (isNodeError(error, "ENOENT")) return path;
      throw new WorktreeStateError("Managed worktree path could not be inspected", {
        cause: error,
      });
    }
  }

  async #registeredWorktreePath(binding: WorktreeBinding, mustExist: boolean): Promise<string> {
    // Cleanup and retention operations re-validate real paths to prevent directories from symlink replacement or escape.
    // Reconstructs managed path from persisted binding; verifies directory exists and has not escaped workspace when mustExist is true.
    const expected = `.agent_tutorial/worktrees/${binding.name}`;
    if (binding.relativePath !== expected) {
      throw new WorktreeStateError("Persisted worktree path is not managed by this runtime");
    }
    const path = join(this.#workspaceRoot, ".agent_tutorial", "worktrees", binding.name);
    if (!mustExist) return path;
    try {
      const resolved = await realpath(path);
      if (
        !(await stat(resolved)).isDirectory() ||
        resolved !== path ||
        !isWithin(this.#workspaceRoot, resolved)
      ) {
        throw new Error("managed path escapes workspace");
      }
      return resolved;
    } catch (error) {
      throw new WorktreeStateError(
        "Managed worktree path does not exist or escapes the workspace",
        {
          cause: error,
        },
      );
    }
  }

  #explicitContextToken(
    context: ToolContext,
  ): { readonly required: true; readonly value: string } | { readonly required: false } {
    // An explicit token is a recovery credential across replies; scope only establishes transient associations within a single assistant reply.
    // Explicit claimToken has highest priority; executionScope only serves as a transient link to earlier claims in the same reply.
    // Returns "not required" when neither source exists, letting resolve decide whether to fall back to the main workspace.
    if (context.claimToken !== undefined) {
      try {
        return { required: true, value: canonicalClaimToken(context.claimToken) };
      } catch (error) {
        throw new WorktreeContextError("Execution claim token is invalid", { cause: error });
      }
    }
    if (context.executionScope !== undefined) {
      const token = this.#scopeClaims.get(context.executionScope);
      if (token !== undefined) return { required: true, value: token };
    }
    return { required: false };
  }

  #now(): Date {
    // Returns a clock copy so external code cannot modify state transition time.
    const value = this.#clock();
    return validUtcDate(value, "Worktree clock");
  }
}

export function worktreeToolDefinitions(
  runtime: WorktreeRuntime,
): readonly [
  ToolDefinition<z.output<typeof createWorktreeSchema>>,
  ToolDefinition<z.output<typeof taskIdSchema>>,
  ToolDefinition<z.output<typeof taskIdSchema>>,
] {
  // create/keep/remove are all Lead management commands; handler only translates domain errors.
  return Object.freeze([
    {
      name: "create_worktree",
      description: "Create and bind a managed Git worktree for one pending project task.",
      inputSchema: createWorktreeSchema,
      effect: "external",
      handler: async (input: z.output<typeof createWorktreeSchema>) => {
        try {
          return toolSuccess(
            encodeBinding(
              await runtime.createWorktree({
                taskId: input.task_id,
                name: input.name,
                integrationRef: input.integration_ref,
              }),
            ),
          );
        } catch (error) {
          return worktreeToolError(error);
        }
      },
    },
    {
      name: "keep_worktree",
      description: "Keep a completed task's managed worktree for deliberate follow-up.",
      inputSchema: taskIdSchema,
      effect: "write",
      handler: async (input: z.output<typeof taskIdSchema>) => {
        try {
          return toolSuccess(encodeBinding(await runtime.keepWorktree(input.task_id)));
        } catch (error) {
          return worktreeToolError(error);
        }
      },
    },
    {
      name: "remove_worktree",
      description: "Remove a completed, clean, explicitly integrated managed worktree.",
      inputSchema: taskIdSchema,
      effect: "external",
      handler: async (input: z.output<typeof taskIdSchema>) => {
        try {
          return toolSuccess(encodeBinding(await runtime.removeWorktree(input.task_id)));
        } catch (error) {
          return worktreeToolError(error);
        }
      },
    },
  ] as const);
}

export function registerWorktreeTools(registry: ToolRegistry, runtime: WorktreeRuntime): void {
  // The three tools create/keep/remove operate only on runtime, without reading or writing Git or SQLite directly.
  const [create, keep, remove] = worktreeToolDefinitions(runtime);
  registry.register(create);
  registry.register(keep);
  registry.register(remove);
}

// Integration Ref must be an explicit safe refs/... reference, rejecting inputs like spaces, .., and @{ that might escape Git semantics.
export function canonicalIntegrationRef(value: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value.startsWith("refs/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || INVALID_REF_CHARACTERS.has(character) || codePoint < 32;
    })
  ) {
    throw new WorktreeStateError("integration_ref must be an explicit safe refs/... Git reference");
  }
  return value;
}

// Git object id accepts only lowercase SHA-1/SHA-256 to prevent incorrect commits from weak validation or string concatenation.
export function canonicalGitObjectId(value: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new WorktreeStateError("Git object ID must be a lowercase SHA-1 or SHA-256 hex string");
  }
  return value;
}

function isWorktreeStore(value: unknown): value is WorktreeStore {
  // Relies on minimal structural contract; concrete persistence implementations can be replaced with test doubles.
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "reserveWorktree") === "function" &&
    typeof Reflect.get(value, "activateWorktree") === "function" &&
    typeof Reflect.get(value, "keepWorktree") === "function" &&
    typeof Reflect.get(value, "markWorktreeNeedsReview") === "function" &&
    typeof Reflect.get(value, "markWorktreeRemoved") === "function" &&
    typeof Reflect.get(value, "getWorktreeBinding") === "function" &&
    typeof Reflect.get(value, "listWorktreeEvents") === "function" &&
    typeof Reflect.get(value, "claimNextBound") === "function" &&
    typeof Reflect.get(value, "lookupClaim") === "function"
  );
}

function isWorktreeStatus(value: unknown): value is WorktreeStatus {
  return Object.values(WorktreeStatus).includes(value as WorktreeStatus);
}

function isWorktreeAction(value: unknown): value is WorktreeAction {
  return Object.values(WorktreeAction).includes(value as WorktreeAction);
}

function eventStatus(action: WorktreeAction): WorktreeStatus {
  // Each audit action corresponds to only one target status.
  if (action === WorktreeAction.RESERVE) return WorktreeStatus.RESERVED;
  if (action === WorktreeAction.CREATE) return WorktreeStatus.ACTIVE;
  if (action === WorktreeAction.KEEP) return WorktreeStatus.KEPT;
  if (action === WorktreeAction.NEEDS_REVIEW) return WorktreeStatus.NEEDS_REVIEW;
  return WorktreeStatus.REMOVED;
}

function normalizeReason(value: string | null): string | null {
  // needs_review must retain a non-empty reason; other statuses must be null.
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorktreeStateError("reviewReason must not be empty");
  }
  return value.trim();
}

// Worktree transition times uniformly use valid Dates, returning copies to prevent external modifications.
function validUtcDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new WorktreeStateError(`${label} must be a valid Date`);
  }
  return new Date(value.getTime());
}

function contextForWorkspace(context: ToolContext, workspace: string): ToolContext {
  // Creates new frozen object without modifying context shared by permissions, Hooks, and handlers in-place.
  const {
    taskId: _taskId,
    claimToken: _claimToken,
    worktreeName: _worktreeName,
    ...base
  } = context;
  return Object.freeze({ ...base, workspace });
}

function worktreeToolError(error: unknown): ToolResult {
  // Demotes only domain errors to tool results; re-throws unknown programming errors.
  if (error instanceof TaskError) return toolError(error.code, error.message);
  throw error;
}

function encodeBinding(binding: WorktreeBinding): string {
  // Tool outputs use snake_case; dates are fixed to UTC ISO strings.
  return JSON.stringify({
    baseline_commit: binding.baselineCommit,
    branch: binding.branch,
    branch_tip: binding.branchTip,
    created_at_utc: binding.createdAtUtc.toISOString(),
    integration_ref: binding.integrationRef,
    name: binding.name,
    relative_path: binding.relativePath,
    review_reason: binding.reviewReason,
    status: binding.status,
    task_id: binding.taskId,
    updated_at_utc: binding.updatedAtUtc.toISOString(),
  });
}

// Use relative paths to check if candidate paths remain within the root directory, preventing false matches from string prefixes.
function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

// Reads code from fs error object to distinguish handleable errors such as ENOENT.
function isNodeError(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "code") === code;
}
