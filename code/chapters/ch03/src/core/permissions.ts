import type { WorkspaceWriteBoundary } from "./filesystem.js";
import type { PreparedToolCall, ToolContext, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// Permission policy adjudicates centrally before tool execution and writes final decisions to the audit boundary.
// Frozen set of all valid decision actions, serving as the single source of truth for runtime validation and type unions.
export const PERMISSION_BEHAVIORS = Object.freeze(["allow", "deny", "ask", "passthrough"] as const);
// Behaviors that permission participants can return: ask must resolve through approval; passthrough defaults to allow.
export type PermissionBehavior = (typeof PERMISSION_BEHAVIORS)[number];

// Stable error type thrown when permission requests, rules, or decisions violate domain contracts.
export class PermissionContractError extends Error {}

// Validate whether unknown values are supported permission actions at the construction boundary.
function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  // Explicit enums ensure all validation sites must update when adding new behavior.
  return PERMISSION_BEHAVIORS.some((behavior) => behavior === value);
}

// An immutable permission decision that records the action, explanatory reason, and source of the decision.
export class PermissionDecision {
  // Final or intermediate decision behavior.
  readonly behavior: PermissionBehavior;
  // Non-empty description for audits and the model.
  readonly reason: string;
  // Stable source name of a rule, authorizer, or default policy.
  readonly source: string;

  // Validate three decision fields and freeze instances to prevent tampering with decisions between audit and execution.
  constructor(behavior: PermissionBehavior, reason: string, source: string) {
    if (!isPermissionBehavior(behavior)) {
      throw new PermissionContractError("behavior must be a PermissionBehavior");
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new PermissionContractError("permission decision reason must not be empty");
    }
    if (typeof source !== "string" || source.trim().length === 0) {
      throw new PermissionContractError("permission decision source must not be empty");
    }
    this.behavior = behavior;
    this.reason = reason;
    this.source = source;
    Object.freeze(this);
  }

  // Only allow means handler can actually execute; ask/passthrough cannot permit execution directly.
  get isAllowed(): boolean {
    return this.behavior === "allow";
  }

  // Convert final deny into tool messages; other intermediate actions must be resolved by PermissionPolicy first.
  toToolResult(): ToolResult {
    // Backfill only final rejections as tool results; policy must resolve ask and passthrough first.
    if (this.behavior !== "deny") {
      throw new PermissionContractError("only a final deny decision can become a tool result");
    }
    return toolError("permission_denied", this.reason);
  }
}

// Prepared call, controlled context, and optional upstream advice needed to create PermissionRequest.
export interface PermissionRequestOptions {
  // Calls validated against tool names and parameter schemas.
  readonly prepared: PreparedToolCall;
  // Workspace and identity boundaries for this call.
  readonly context: ToolContext;
  // Immutable candidate decisions provided by previous participants.
  readonly recommendations?: readonly PermissionDecision[];
  // Ask decision passed to manual approver, cannot disguise as allow or deny.
  readonly proposedDecision?: PermissionDecision;
}

// Input value object for permission policy; accepts only valid tool calls to avoid making the permission layer fix parameters.
export class PermissionRequest {
  // Accepts only calls that passed schema validation; permission layer does not fix invalid tool parameters.
  readonly prepared: PreparedToolCall;
  readonly context: ToolContext;
  readonly recommendations: readonly PermissionDecision[];
  readonly proposedDecision: PermissionDecision | undefined;

  // Validates request state, copies suggestions, and freezes object, ensuring approval and audit see the same snapshot.
  constructor(options: PermissionRequestOptions) {
    if (
      options.prepared.error !== undefined ||
      options.prepared.definition === undefined ||
      options.prepared.arguments === undefined
    ) {
      throw new PermissionContractError("permission request requires a valid prepared tool call");
    }
    const recommendations = options.recommendations === undefined ? [] : options.recommendations;
    if (
      !Array.isArray(recommendations) ||
      !recommendations.every((decision) => decision instanceof PermissionDecision)
    ) {
      throw new PermissionContractError("recommendations must contain PermissionDecision values");
    }
    if (
      options.proposedDecision !== undefined &&
      (!(options.proposedDecision instanceof PermissionDecision) ||
        options.proposedDecision.behavior !== "ask")
    ) {
      throw new PermissionContractError("proposedDecision must be an ask PermissionDecision");
    }
    this.prepared = options.prepared;
    this.context = options.context;
    this.recommendations = Object.freeze([...recommendations]);
    this.proposedDecision = options.proposedDecision;
    Object.freeze(this);
  }
}

// Pure matching predicate of the rule; exceptions are treated by the policy as deny rather than allow.
export type PermissionMatcher = (request: PermissionRequest) => boolean;

// Static metadata and matcher function required to create a policy rule.
export interface PermissionRuleOptions {
  // Stable rule names used by audit and decision sources.
  readonly name: string;
  // Proposed action after a rule matches.
  readonly behavior: PermissionBehavior;
  // Explainable reason for a rule decision.
  readonly reason: string;
  // Matching conditions for PermissionRequest.
  readonly matches: PermissionMatcher;
}

// Immutable single permission rule; proposes candidate decisions only, while policy centrally controls merge priority.
export class PermissionRule {
  readonly name: string;
  readonly behavior: PermissionBehavior;
  readonly reason: string;
  readonly matches: PermissionMatcher;

  // Validate rule metadata and callback callability, then freeze rules for long-term policy reuse.
  constructor(options: PermissionRuleOptions) {
    // Rule name, action, and reason are type-protected during construction; match functions accept arbitrary runtime checks.
    if (typeof options.name !== "string" || options.name.trim().length === 0) {
      throw new PermissionContractError("permission rule name must not be empty");
    }
    if (!isPermissionBehavior(options.behavior)) {
      throw new PermissionContractError("permission rule behavior must be a PermissionBehavior");
    }
    if (typeof options.reason !== "string" || options.reason.trim().length === 0) {
      throw new PermissionContractError("permission rule reason must not be empty");
    }
    if (typeof options.matches !== "function") {
      throw new PermissionContractError("permission rule matcher must be callable");
    }
    this.name = options.name;
    this.behavior = options.behavior;
    this.reason = options.reason;
    this.matches = options.matches;
    Object.freeze(this);
  }

  // Return a decision with rule origin on match; return undefined on mismatch so subsequent participants continue evaluation.
  evaluate(request: PermissionRequest): PermissionDecision | undefined {
    // Do not make a decision when matching fails; delegate to subsequent participants or default values.
    if (!this.matches(request)) {
      return undefined;
    }
    return new PermissionDecision(this.behavior, this.reason, this.name);
  }
}

export interface ApprovalProvider {
  // Asynchronous boundary; exceptions, illegal returns, and absent terminal inputs are all fail-closed rejection reasons.
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface AuditSink {
  // Audit records are invoked after final decisions are made; failures block handler execution.
  record(request: PermissionRequest, decision: PermissionDecision): Promise<void>;
}

// Optional participants for creating PermissionPolicy; omitted participants are filled in by default fail-closed rules.
export interface PermissionPolicyOptions {
  // A static rule collection evaluated in order.
  readonly rules?: readonly PermissionRule[];
  // Handle human or external approval boundaries for ask decisions.
  readonly approval?: ApprovalProvider;
  // Required audit boundary for final decisions.
  readonly audit?: AuditSink;
  // Infrastructure boundary for executing real path security checks on write paths.
  readonly writeBoundary?: WorkspaceWriteBoundary;
}

// Uniformly merge system boundaries, rules, and manual approvals to produce a single final decision before execution.
export class PermissionPolicy {
  // Decision order is fixed: workspace boundaries, matching rules, default policy, and manual approval.
  readonly #rules: readonly PermissionRule[];
  readonly #approval: ApprovalProvider | undefined;
  readonly #audit: AuditSink | undefined;
  readonly #writeBoundary: WorkspaceWriteBoundary | undefined;

  // Validates rule list and fixes all participant references; runtime decisions do not allow changing policy composition.
  constructor(options: PermissionPolicyOptions = {}) {
    const rules = options.rules === undefined ? [] : options.rules;
    if (!Array.isArray(rules) || !rules.every((rule) => rule instanceof PermissionRule)) {
      throw new PermissionContractError("rules must contain PermissionRule values");
    }
    this.#rules = Object.freeze([...rules]);
    this.#approval = options.approval;
    this.#audit = options.audit;
    this.#writeBoundary = options.writeBoundary;
  }

  // Calculate final allow or deny by fixed priority. Audit failure propagates to callers and blocks tool execution.
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    if (!(request instanceof PermissionRequest)) {
      throw new PermissionContractError("request must be a PermissionRequest");
    }
    // System hard boundaries participate in merging first; subsequent allows cannot override denys produced by them.
    const candidates: PermissionDecision[] = [];
    const workspaceBoundary = await this.#workspaceBoundaryDecision(request);
    if (workspaceBoundary !== undefined) {
      candidates.push(workspaceBoundary);
    }
    const shellDefault = shellDefaultDecision(request);
    if (shellDefault !== undefined) {
      candidates.push(shellDefault);
    }
    candidates.push(...request.recommendations, ...this.#evaluateRules(request));

    const proposed = strongestDecision(candidates);
    let final: PermissionDecision;
    if (proposed.behavior === "ask") {
      // Manual approval can only resolve ask into allow or deny; it cannot reintroduce intermediate states.
      final = await this.#resolveApproval(request, proposed);
    } else if (proposed.behavior === "passthrough") {
      final = new PermissionDecision("allow", "No permission rule blocked the request", "default");
    } else {
      final = proposed;
    }
    if (this.#audit !== undefined) {
      await this.#audit.record(request, final);
    }
    return final;
  }

  // Evaluate all rules; convert single-rule exceptions to deny to prevent policy flaws from expanding tool permissions.
  #evaluateRules(request: PermissionRequest): readonly PermissionDecision[] {
    return this.#rules
      .map((rule) => {
        try {
          return rule.evaluate(request);
        } catch {
          // Treat failures in a single rule as deny, preventing policy exceptions from causing unreviewed side effects.
          return new PermissionDecision("deny", `Permission rule failed: ${rule.name}`, rule.name);
        }
      })
      .filter((decision): decision is PermissionDecision => decision !== undefined);
  }

  async #resolveApproval(
    request: PermissionRequest,
    proposed: PermissionDecision,
  ): Promise<PermissionDecision> {
    if (this.#approval === undefined) {
      return implicitApprovalDenial(proposed);
    }
    const approvalRequest = new PermissionRequest({
      prepared: request.prepared,
      context: request.context,
      recommendations: request.recommendations,
      proposedDecision: proposed,
    });
    let decision: unknown;
    try {
      decision = await this.#approval.decide(approvalRequest);
    } catch {
      return new PermissionDecision("deny", "Approval provider failed; request denied", "approval");
    }
    if (!(decision instanceof PermissionDecision)) {
      return new PermissionDecision(
        "deny",
        "Approval provider returned an invalid decision",
        "approval",
      );
    }
    if (decision.behavior === "allow" || decision.behavior === "deny") {
      return decision;
    }
    return implicitApprovalDenial(proposed);
  }

  async #workspaceBoundaryDecision(
    request: PermissionRequest,
  ): Promise<PermissionDecision | undefined> {
    const definition = request.prepared.definition;
    const argumentsValue = request.prepared.arguments;
    if (definition === undefined || argumentsValue === undefined) {
      throw new PermissionContractError("permission request lost validated tool data");
    }
    if (definition.effect !== "write") {
      return undefined;
    }
    const rawPath = Reflect.get(argumentsValue as object, "path");
    if (rawPath === undefined) {
      return undefined;
    }
    if (typeof rawPath !== "string") {
      return new PermissionDecision("deny", "Write path is invalid", "workspace-boundary");
    }
    if (this.#writeBoundary === undefined) {
      return undefined;
    }
    try {
      // Real path resolution is performed by the file system boundary injected by the composition root; core does not depend on specific adapters.
      const allowed = await this.#writeBoundary.isPathWithinWorkspace(
        request.context.workspace,
        rawPath,
      );
      if (typeof allowed !== "boolean") {
        throw new PermissionContractError("write boundary must return a boolean");
      }
      return allowed
        ? undefined
        : new PermissionDecision(
            "deny",
            "Writing outside the workspace is forbidden",
            "workspace-boundary",
          );
    } catch {
      return new PermissionDecision(
        "deny",
        "Write path could not be resolved safely",
        "workspace-boundary",
      );
    }
  }
}

// Select the most conservative among conflicting candidates (deny, ask, allow); return passthrough when no candidates exist.
function strongestDecision(decisions: readonly PermissionDecision[]): PermissionDecision {
  // Select the most conservative behavior when multiple suggestions conflict, preventing loose rules from overriding explicit denies.
  for (const behavior of ["deny", "ask", "allow"] as const) {
    const decision = decisions.find((candidate) => candidate.behavior === behavior);
    if (decision !== undefined) {
      return decision;
    }
  }
  return new PermissionDecision(
    "passthrough",
    "No permission participant made a decision",
    "default",
  );
}

// Convert missing, exceptional, or invalid approval responses to deny, ensuring ask never allows silently.
function implicitApprovalDenial(proposed: PermissionDecision): PermissionDecision {
  // Approval provider exceptions or invalid decision returns fail closed.
  return new PermissionDecision(
    "deny",
    `Approval was not explicitly granted: ${proposed.reason}`,
    "approval",
  );
}

// Default candidate for all execute tools is ask; human approval is required even without explicit matching rules.
function shellDefaultDecision(request: PermissionRequest): PermissionDecision | undefined {
  // Execute tools not matched by rules still require approval by default.
  const definition = request.prepared.definition;
  if (definition === undefined) {
    throw new PermissionContractError("permission request lost its tool definition");
  }
  if (definition.effect !== "execute") {
    return undefined;
  }
  return new PermissionDecision("ask", "Shell execution requires approval", "shell-default");
}
