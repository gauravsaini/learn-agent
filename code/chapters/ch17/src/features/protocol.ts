// Protocol runtime: orchestrate shutdown and plan_approval into a persistent request/response state machine, providing Lead approval and teammate plan submission tools.
import { z } from "zod";

import { PermissionRule } from "../core/permissions.js";
import type { PermissionRequest } from "../core/permissions.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import {
  canonicalAgentName,
  canonicalMailboxMessageId,
  isProtocolMailboxStore,
  type MailboxStore,
  type ProtocolMailboxMessage,
  ProtocolMessageKind,
} from "./mailbox.js";
import type { TeammateStatus } from "./teammates.js";

// The protocol only supports shutdown and plan_approval; isolated request_plan from the original text does not enter the state machine.
export const ProtocolRequestKind = Object.freeze({
  Shutdown: "shutdown",
  PlanApproval: "plan_approval",
});
export type ProtocolRequestKind = (typeof ProtocolRequestKind)[keyof typeof ProtocolRequestKind];
// Request states form a closed set; final state is uniquely decided by resolution without extra branches.
export const ProtocolRequestStatus = Object.freeze({
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
});
export type ProtocolRequestStatus =
  (typeof ProtocolRequestStatus)[keyof typeof ProtocolRequestStatus];

// Protocol errors carry errorCode so tool boundaries and Mailbox routing distinguish retryable and non-retryable errors.
export class ProtocolError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
    this.errorCode = errorCode;
  }
}
export class ProtocolStorageError extends ProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super("protocol_storage_error", message, options);
    this.name = "ProtocolStorageError";
  }
}
export class ProtocolMismatchError extends ProtocolError {
  constructor(message: string, errorCode = "protocol_mismatch") {
    super(errorCode, message);
    this.name = "ProtocolMismatchError";
  }
}
export class ProtocolNotFoundError extends ProtocolMismatchError {
  constructor(message: string) {
    super(message, "protocol_not_found");
    this.name = "ProtocolNotFoundError";
  }
}
export class ProtocolStateError extends ProtocolError {
  constructor(message: string, errorCode = "protocol_state_error") {
    super(errorCode, message);
    this.name = "ProtocolStateError";
  }
}
export class ProtocolExpiredError extends ProtocolStateError {
  constructor(message: string) {
    super(message, "protocol_expired");
    this.name = "ProtocolExpiredError";
  }
}
// Retain pending state when delivery fails after persisting requests; callers can diagnose instead of pretending the request did not happen.
export class ProtocolDeliveryError extends ProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super("protocol_delivery_error", message, options);
    this.name = "ProtocolDeliveryError";
  }
}

// resolution records "which message completed approval at what time", serving as proof for idempotent retries of the same message.
export interface ProtocolResolution {
  // The sole response message completing this request; retries must carry the same id to return idempotently.
  readonly messageId: string;
  // Structured approval conclusion; inferring allow or deny from natural language body is forbidden.
  readonly approved: boolean;
  // Preserves approval feedback or shutdown confirmation text for subsequent prompts and audit.
  readonly content: string;
  // The exact moment when the state transitions to the final state, rather than when the response was first created.
  readonly resolvedAtUtc: Date;
}
export interface ProtocolRequest {
  // Protocol requests persist approval state and unique resolution so restarts can recover consistent collaboration results.
  // Request UUID is written to both request and response Mailbox messages as their correlation key.
  readonly id: string;
  // Determines legal message directions, response types, and business semantics after consumption.
  readonly kind: ProtocolRequestKind;
  // The party initiating the request; shutdown is Lead, plan_approval is teammate.
  readonly sender: string;
  // Request recipient; responses can only return in the reverse direction.
  readonly target: string;
  // Only pending items can be consumed; approved/rejected are irreversible terminal states.
  readonly status: ProtocolRequestStatus;
  // Request body must match the request message verbatim to prevent drift between persistent state and transport content.
  readonly content: string;
  // Creation order determines the "latest plan" of a teammate; the storage layer forbids clock rollback.
  readonly createdAtUtc: Date;
  // Once expired, do not advance protocol state even if the message remains in the Mailbox.
  readonly expiresAtUtc: Date;
  // pending must be null; terminal states must carry a unique resolution.
  readonly resolution: ProtocolResolution | null;
}

// store is the state source of truth for protocol requests; Runtime registers requests first, then delivers typed messages to Mailbox.
export interface ProtocolStore {
  // Persists pending requests first; callers can only deliver corresponding Mailbox messages afterward.
  createRequest(input: {
    readonly kind: ProtocolRequestKind;
    readonly sender: string;
    readonly target: string;
    readonly content: string;
  }): Promise<ProtocolRequest>;
  // Returns requests in any state for diagnostics and final conclusion reading.
  getRequest(id: string): Promise<ProtocolRequest>;
  // Return a complete snapshot in creation order. Do not expose the mutable internal array to callers.
  listRequests(): Promise<readonly ProtocolRequest[]>;
  // Only allow fetching unresolved and unexpired requests for the Lead approval entrypoint.
  getPendingRequest(id: string): Promise<ProtocolRequest>;
  // The plan gate only relies on the latest plan state submitted by the specified teammate.
  latestPlanRequest(sender: string): Promise<ProtocolRequest | undefined>;
  // Validate that request messages pair completely with persistent requests as read-only, without migrating state.
  validateRequest(message: ProtocolMailboxMessage): Promise<ProtocolRequest>;
  // Validate responses as read-only to quarantine invalid messages before events enter history.
  validateResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest>;
  // Atomically write resolution; the same response can retry, but a different response cannot overwrite terminal state.
  consumeResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest>;
}

// TeamHost is the minimal collaboration host required by protocol runtime, avoiding dependency on full TeammateRuntime implementations.
export interface ProtocolTeamHost {
  // Validate that the underlying Store supports typed protocol messages during protocol construction.
  readonly mailboxStore: MailboxStore;
  // Used to reject creating new requests for failed or shutdown teammates.
  state(name: string): { readonly status: TeammateStatus };
  // Close the teammate entry point upon receiving a shutdown request, then send an acknowledgment response.
  beginShutdown(name: string): void;
  // The sole transmission outlet, reusing participant validation, registry serialization, and Lead wakeup logic.
  deliverProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: {
      readonly requestId: string;
      readonly approved: boolean | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<ProtocolMailboxMessage>;
}

const shutdownInput = z.strictObject({ teammate: z.string() });
const reviewPlanInput = z.strictObject({
  request_id: z.string(),
  approve: z.boolean(),
  feedback: z.string().optional(),
});
const submitPlanInput = z.strictObject({ plan: z.string().min(1) });

export class ProtocolRuntime {
  // Runtime orchestrates plan approval and graceful shutdown into verifiable mailbox request/response pairs.
  readonly #store: ProtocolStore;
  readonly #team: ProtocolTeamHost;
  readonly #leadName: string;
  readonly #planGateRule: PermissionRule;

  constructor(options: {
    readonly store: ProtocolStore;
    readonly team: ProtocolTeamHost;
    readonly leadName?: string;
  }) {
    this.#store = options.store;
    this.#team = options.team;
    this.#leadName = canonicalAgentName(options.leadName ?? "lead");
    if (this.#team.mailboxStore === undefined || !isProtocolMailboxStore(this.#team.mailboxStore)) {
      throw new TypeError("team mailboxStore must support protocol messages");
    }
    // plan gate appends to teammate permission policy as a deny rule, running before handlers and background submission.
    this.#planGateRule = new PermissionRule({
      name: "plan-approval-gate",
      behavior: "deny",
      reason: "Effectful teammate tools require the latest submitted plan to be approved",
      matches: (request) => this.#requiresPlanApproval(request),
    });
  }
  get teamRuntime(): ProtocolTeamHost {
    // The composition root uses object identity to verify that the protocol layer and teammate layer share the same host.
    return this.#team;
  }
  get store(): ProtocolStore {
    // Expose read-only protocol state boundaries to prevent the composition layer from creating parallel state sources.
    return this.#store;
  }
  get mailboxStore(): MailboxStore {
    // Protocol and ordinary teammate messages must land in the same MailboxStore.
    return this.#team.mailboxStore;
  }
  get planGateRule(): PermissionRule {
    // Appends this deny rule when constructing permission policy for teammate Runner.
    return this.#planGateRule;
  }
  get leadToolDefinitions(): readonly [
    ToolDefinition<z.infer<typeof shutdownInput>>,
    ToolDefinition<z.infer<typeof reviewPlanInput>>,
  ] {
    // Lead receives only two protocol tools: initiate shutdown and review plan.
    return Object.freeze([this.#requestShutdownTool(), this.#reviewPlanTool()]);
  }
  get submitPlanToolDefinition(): ToolDefinition<z.infer<typeof submitPlanInput>> {
    // Teammates only receive the submit plan tool, and cannot approve or shut down other teammates themselves.
    return this.#submitPlanTool();
  }

  async planAllowsEffectful(sender: string): Promise<boolean> {
    // Allow side effects only when the latest plan is approved; preserve existing collaboration behavior when no plan exists.
    const latest = await this.#store.latestPlanRequest(canonicalAgentName(sender));
    return latest === undefined || latest.status === ProtocolRequestStatus.Approved;
  }
  // shutdown registers and sends structured requests only, without destroying Runner directly.
  async requestShutdown(teammate: string): Promise<ProtocolRequest> {
    return await this.#createAndDeliver(
      ProtocolRequestKind.Shutdown,
      this.#leadName,
      canonicalAgentName(teammate),
      "Graceful shutdown requested.",
    );
  }
  // Plans are submitted actively by teammates, with target fixed to Lead, waiting for structured approve/reject responses.
  async submitPlan(sender: string, plan: string): Promise<ProtocolRequest> {
    return await this.#createAndDeliver(
      ProtocolRequestKind.PlanApproval,
      canonicalAgentName(sender),
      this.#leadName,
      requireText(plan, "Plan"),
    );
  }
  // Approval can only target pending plan requests, and responses can be sent only to the original submitter.
  async reviewPlan(
    requestId: string,
    approve: boolean,
    feedback = "",
  ): Promise<ProtocolMailboxMessage> {
    // Non-canonical UUIDs are treated uniformly as "request does not exist" to avoid exposing internal ID format differences to the model.
    let normalizedRequestId: string;
    try {
      normalizedRequestId = canonicalMailboxMessageId(requestId);
    } catch {
      throw new ProtocolNotFoundError("Protocol request id must be a canonical UUID");
    }
    const request = await this.#store.getPendingRequest(normalizedRequestId);
    if (request.kind !== ProtocolRequestKind.PlanApproval || request.target !== this.#leadName)
      throw new ProtocolMismatchError("Request is not a lead plan approval request");
    this.#assertAvailable(request.sender);
    return await this.#deliver(
      this.#leadName,
      request.sender,
      feedback.trim() || (approve ? "Approved" : "Rejected"),
      ProtocolMessageKind.PlanApprovalResponse,
      request.id,
      approve,
    );
  }
  // Teammate protocol messages are handled deterministically before model calls; shutdown does not enter model, and plan response reuses the same Runner.
  async routeTeammateMessage(
    teammate: string,
    message: ProtocolMailboxMessage,
    signal?: AbortSignal,
  ): Promise<{ readonly prompt?: string; readonly shutdown: boolean }> {
    const name = canonicalAgentName(teammate);
    if (message.recipient !== name)
      throw new ProtocolMismatchError("Protocol message recipient does not match teammate");
    if (message.kind === ProtocolMessageKind.ShutdownRequest) {
      const request = await this.#store.validateRequest(message);
      this.#team.beginShutdown(name);
      await this.#deliver(
        name,
        this.#leadName,
        "Ready to shut down.",
        ProtocolMessageKind.ShutdownResponse,
        request.id,
        true,
        signal,
      );
      return Object.freeze({ shutdown: true });
    }
    if (message.kind === ProtocolMessageKind.PlanApprovalResponse) {
      const request = await this.#store.consumeResponse(message);
      return Object.freeze({
        shutdown: false,
        prompt:
          request.status === ProtocolRequestStatus.Approved
            ? `Plan approved (${request.id}). Proceed with the approved plan.`
            : `Plan rejected (${request.id}). Feedback: ${message.content}`,
      });
    }
    throw new ProtocolMismatchError("Protocol message type is not routable to a teammate");
  }
  // Validate Lead protocol messages in read-only mode during drain to prevent invalid or expired messages entering canonical history.
  async validateLeadMessage(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    if (message.recipient !== this.#leadName)
      throw new ProtocolMismatchError("Protocol message recipient does not match the lead");
    if (message.kind === ProtocolMessageKind.PlanApprovalRequest)
      return await this.#store.validateRequest(message);
    if (message.kind === ProtocolMessageKind.ShutdownResponse)
      return await this.#store.validateResponse(message);
    throw new ProtocolMismatchError("Protocol message type is not routable to the lead");
  }
  // Atomically consume responses during the ack phase; the store returns retries for the same message idempotently and rejects a different message.
  async acknowledgeLeadMessage(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    if (message.recipient !== this.#leadName)
      throw new ProtocolMismatchError("Protocol message recipient does not match the lead");
    if (message.kind === ProtocolMessageKind.PlanApprovalRequest)
      return await this.#store.validateRequest(message);
    if (message.kind === ProtocolMessageKind.ShutdownResponse)
      return await this.#store.consumeResponse(message);
    throw new ProtocolMismatchError("Protocol message type is not acknowledgeable by the lead");
  }

  // Registers before sending: pending request remains on send failure for diagnosis and recovery.
  async #createAndDeliver(
    kind: ProtocolRequestKind,
    sender: string,
    target: string,
    content: string,
  ): Promise<ProtocolRequest> {
    this.#assertAvailable(sender === this.#leadName ? target : sender);
    const request = await this.#store.createRequest({ kind, sender, target, content });
    await this.#deliver(
      sender,
      target,
      content,
      kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownRequest
        : ProtocolMessageKind.PlanApprovalRequest,
      request.id,
      null,
    );
    return request;
  }
  // Wrap delivery failures as ProtocolDeliveryErrors, without rolling back registered request states.
  async #deliver(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    requestId: string,
    approved: boolean | null,
    signal?: AbortSignal,
  ): Promise<ProtocolMailboxMessage> {
    try {
      if (signal?.aborted) throw abortError();
      return await this.#team.deliverProtocol(sender, recipient, content, kind, {
        requestId,
        approved,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new ProtocolDeliveryError("Protocol message could not be delivered", { cause: error });
    }
  }
  // failed/shutdown teammates cannot receive new protocol requests, preventing delivery to unavailable workers.
  #assertAvailable(name: string): void {
    let status: string;
    try {
      status = this.#team.state(name).status;
    } catch {
      throw new ProtocolStateError(`Unknown or unavailable teammate: ${name}`);
    }
    if (status === "failed" || status === "shutdown")
      throw new ProtocolStateError(`Teammate ${name} is unavailable`);
  }
  // Intercept only effectful tools; read, send_message, and submit_plan must remain available.
  async #requiresPlanApproval(request: PermissionRequest): Promise<boolean> {
    const definition = request.prepared.definition;
    if (definition === undefined)
      throw new ProtocolStateError("Plan gate lost its tool definition");
    if (
      definition.effect === "read" ||
      definition.name === "send_message" ||
      definition.name === "submit_plan"
    )
      return false;
    return !(await this.planAllowsEffectful(request.context.identity));
  }
  #requestShutdownTool(): ToolDefinition<z.infer<typeof shutdownInput>> {
    // Definitions are ultimately solidified by ToolRegistry; handlers only orchestrate protocols and do not release resources directly.
    return {
      // Shutdown tool only registers and delivers protocol requests; composition root close() reclaims Runner resources.
      name: "request_shutdown",
      description: "Request a teammate to finish current work and shut down gracefully.",
      inputSchema: shutdownInput,
      effect: "external",
      handler: async (input) => {
        try {
          return toolSuccess(JSON.stringify(await this.requestShutdown(input.teammate)));
        } catch (error) {
          return protocolToolError(error);
        }
      },
    };
  }
  #reviewPlanTool(): ToolDefinition<z.infer<typeof reviewPlanInput>> {
    // request_id is the unique selector for the approval target; approve is the sole decision source.
    return {
      // The approval tool must locate pending requests based on request_id; cannot use model free text to guess targets.
      name: "review_plan",
      description: "Approve or reject a pending teammate plan request.",
      inputSchema: reviewPlanInput,
      effect: "external",
      handler: async (input) => {
        try {
          return toolSuccess(
            JSON.stringify(await this.reviewPlan(input.request_id, input.approve, input.feedback)),
          );
        } catch (error) {
          return protocolToolError(error);
        }
      },
    };
  }
  #submitPlanTool(): ToolDefinition<z.infer<typeof submitPlanInput>> {
    // plan gate explicitly allows this external tool to prevent deadlocks where unapproved tasks cannot request approval.
    return {
      // The submit plan tool gets sender from ToolContext.identity. Tool input cannot forge the sender.
      name: "submit_plan",
      description: "Submit a plan to the lead and wait for a structured approval response.",
      inputSchema: submitPlanInput,
      effect: "external",
      handler: async (input, context: ToolContext) => {
        try {
          return toolSuccess(JSON.stringify(await this.submitPlan(context.identity, input.plan)));
        } catch (error) {
          return protocolToolError(error);
        }
      },
    };
  }
}
// Tool results expose only stable errorCode/message, without leaking internal exception types to the model.
function protocolToolError(error: unknown): ToolResult {
  return error instanceof ProtocolError
    ? toolError(error.errorCode, error.message)
    : toolError("protocol_error", "Protocol operation failed");
}
function requireText(value: string, label: string): string {
  // Trim protocol body text and reject blanks so the persistence layer and transport layer share stable text.
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ProtocolStateError(`${label} must not be empty`);
  return value.trim();
}
function abortError(): DOMException {
  // Standard AbortError lets the transport boundary distinguish cancellation from actual delivery failures.
  return new DOMException("Protocol delivery was aborted", "AbortError");
}
