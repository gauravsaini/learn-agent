Once teammates can do work, the next problem that surfaces is usually not capability. It is coordination.

In the previous chapter, the Lead could create long-lived teammates, send them messages, and collect their results. Messages persist and survive a restart. But a plain `task / message / result` expresses only **content**. It does not express "which request this reply is resolving".

On the smooth path, that causes no trouble. As soon as approval, concurrency and retries enter the picture, guessing context from free text is no longer enough.

Two scenarios show the problem best.

**Scenario one is shutdown.** The Lead wants Alice to stop. But Alice may be writing a file at that moment, and killing her directly would leave half a file behind. The correct order is: let the current message finish its work first, then handle the shutdown request, send back one clear response, and then end the worker.

**Scenario two is plan approval.** Bob wants to refactor the authentication module. Bob submits a plan first, and the Lead decides to approve or reject it. While the plan is still pending, or after it is rejected, effectful tools such as writing files and running commands must be refused **before they really execute** — the design cannot just write "please wait for approval" in the prompt and hope the model complies on its own.

The two scenarios share one structure:

```text
Register the request first -> The message carries a stable ID -> The response matches the request strictly -> The state migrates only once
```

On top of the persistent teammates and the persistent Mailbox from Chapter 15, Chapter 16 adds only two capabilities: `protocol` and `plan_gate`.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaHvxXExWYdxW7ib5PuJkjuyILxTPoLiaia0MttpWjrcP9NnOmhtH7Us1Ym8icMicFQa15ibW58F4jQqKtwF1eJXf7lyDk0hpXbnFb8k/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you will be able to do after this chapter

- Explain the difference between "message delivered" and "protocol completed", and why the first does not imply the second.
- Run one complete graceful shutdown yourself: from `request_shutdown` to the teammate in `shutdown` state, without one extra model call in the whole flow.
- Run one complete plan approval yourself: submission, approval, the teammate wakes and continues the work, and what happens after a rejection.
- Read every field in `.agent_tutorial/protocol/state.json`, and judge whether a given state is valid.
- Explain why the plan gate must be a `PermissionRule` and not a piece of prompt text.
- State how the runtime handles each of the five kinds of "protocol error": release, quarantine, or the teammate entering failed.
- Answer independently: why must the Lead write the event into the history first, and only then consume the protocol state?

### What you need first

| Prerequisite | Concrete requirement | What happens if you do not have it |
|---|---|---|
| The persistent Mailbox from Chapter 15 | You know what the four directories `ready -> processing -> done/quarantine` mean | You will not understand why protocol messages also travel through these directories |
| The persistent teammates from Chapter 15 | You know that after `spawn`, a teammate has its own Runner and its own history, and `idle` does not mean destroyed | You will think shutdown means deleting an object |
| The permission layer from Chapter 3 | You know that `PermissionPolicy` takes effect before the handler, and a deny means the tool does not execute at all | You will think the plan gate is only a hint |
| The events from Chapters 13 / 14 | You know `EventInbox` and `JobSupervisor`, and how events enter the canonical history | You will not understand why "history first, ack second" matters |
| Node.js 22+ | The tests in this article ran on `v25.7.0` | `npm run build` or `tsx` will report syntax errors |
| Windows PowerShell | Every command in this article uses PowerShell syntax | You must rewrite the commands as bash yourself |

You can keep reading without Chapter 15, if you accept one premise: **every message between teammates is a file, and the name of the directory that holds the file is its state**. Everything new in this chapter builds on that one sentence.

### Quick term reference (terms that first appear in this chapter)

| Term | One-line explanation |
|---|---|
| **protocol** | One request/response round trip with a start and an end. Both sides can verify whether it completed |
| **ProtocolRequest** | A request record persisted on disk. It is the single truth for "how far has this matter got" |
| **request_id** | The canonical UUID of a ProtocolRequest. A response uses it to find its own request |
| **pending / approved / rejected** | The three states of a request. A request can migrate out of pending only, and only once |
| **resolution** | The final-state record of a request. It records which message closed it, whether it was approved, and when |
| **TTL / expires_at_utc** | The response window. The default is 5 minutes. The runtime does not accept a response after the timeout |
| **typed envelope** | An envelope with a type. The `kind` of a protocol message is `protocol`, physically separate from a plain message |
| **deterministic router** | Routing by type **before** the model is called. A protocol message never enters the model |
| **plan gate** | One permission rule. While the plan is not approved, write/execute tools are denied directly |
| **release** | Return the message to `ready` and wait for the next retry. Used when "the message is good, only this attempt failed" |
| **quarantine** | Move the message to `quarantine` and do not retry it. Used when "the message itself is bad" |
| **effectful tool** | A tool that produces an effect (side-effect). Its `effect` is not `read` |
| **at-least-once** | The delivery guarantee. The same message may arrive more than once, and stable IDs remove the duplicates |

### Suggested reading route

Every mechanism in this chapter hangs on one chain. Read in chain order. Do not skip:

```text
[1] Look at one complete trace first          <- Build intuition; know what the end looks like
      |
[2] Two new tools + one new capability bit   <- Know that the public delta is only this much
      |
[3] What a ProtocolRequest looks like   <- The state truth lives on disk
      |
[4] Hard rule one: register first, send second     <- The order cannot be reversed
      |
[5] The typed Mailbox envelope         <- The protocol does not degrade into JSON inside content
      |
[6] Hard rule two: the response must match completely   <- Only when all six conditions hold does it count
      |
[7] The Lead side: history first, ack second  <- The section readers get wrong most easily in this chapter
      |
[8] The complete shutdown route         <- It does not enter the model
      |
[9] Plan approval: the state changes first, the Runner resumes after
      |
[10] The plan gate is a real gate, not a hint
      |
[11] Failure classes: release / quarantine / failed
      |
[12] Wire it into the composition root + run it + 14 hands-on experiments
```

If you have only 10 minutes, read sections [1], [7] and [10], then run the `shutdown` and `gate` experiments. These three sections hold the genuinely new material in this chapter.

---

## Look at the Trace of One Complete Shutdown First

Do not explain the principles yet. The output below is the real output of this chapter's `shutdown` experiment on my machine (the "14 Hands-On Experiments" section later teaches you how to run it). Look at the result first. The reading after it will feel much easier.

Scenario: the Lead creates the teammate alice. Alice finishes her first round of work. Then the Lead asks her to shut down.

```text
===== shutdown =====
[1] The teammate finished round one; the Lead received a result: "initial result"
    Model call count = 1
    Teammate state = idle

[2] request_shutdown registered the request:
    id=00000000-0000-4000-8000-000000000901
    kind=shutdown status=pending sender=lead target=alice

[3] The next event that the Lead received:
    isProtocolMailboxMessage = true
    payload = {
      "kind": "protocol",
      "message_id": "4ad3cdea-6f8e-4a16-aa05-1e75256da05d",
      "sender": "alice",
      "recipient": "lead",
      "protocol_kind": "shutdown_response",
      "content": "Ready to shut down.",
      "created_at_utc": "2026-08-30T12:04:11.304Z",
      "request_id": "00000000-0000-4000-8000-000000000901",
      "approved": true
    }
    Teammate state = shutdown
    Model call count = 1 (The shutdown spent no extra model call)
    Before the ack, the request state = pending

[4] After the ack:
    id=00000000-0000-4000-8000-000000000901
    kind=shutdown status=approved sender=lead target=alice
    resolution.messageId=4ad3cdea-6f8e-4a16-aa05-1e75256da05d approved=true
```

Five details in this output deserve your attention right now. They are the whole point of this chapter:

**First, in `[2]` the request already has an id and `status=pending`.** That means: before any message was sent, a record already existed on disk saying "someone asked alice to shut down, and there is no conclusion yet". This is "register first, send second".

**Second, in `[3]` the `kind` of the payload is `"protocol"`, not `"mailbox"`.** Protocol messages and plain messages are two different envelopes at the transport layer. This difference becomes very important in the section "The Typed Mailbox: the Protocol Does Not Degrade into JSON inside content".

**Third, the `request_id` is exactly equal to the id in `[2]`.** The response does not match the request by "I guess you are talking about the shutdown". It matches by one UUID.

**Fourth, the model call count is 1 from start to finish.** That one call happened when alice did her first round of work. The model took no part in the whole shutdown round trip. This is "deterministic routing": shutdown is a runtime matter. It does not need the model's opinion.

**Fifth, the request is still `pending` before the ack, and it becomes `approved` only after the ack.** The state migration happens after the Lead confirms receipt, not when the message is sent. The section "The Lead Side: Write the History First, Then Consume the State" explains why.

### Look at the Trace of One Plan Approval

The same script, the real output of the `plan` experiment:

```text
===== plan =====
[1] After round one, the model call count = 1

[2] The teammate submitted a plan:
    id=00000000-0000-4000-8000-000000000901
    kind=plan_approval status=pending sender=alice target=lead
    The Lead side received protocol_kind = plan_approval_request
    After the ack, the request state = pending (An ack in the request direction does not migrate the state)

[3] The Lead approved; the teammate woke; wait for it to hand back a result:
    result = "approved work result"
    Model call count = 2

[4] The prompt that the second model request received:
    "Plan approved (00000000-0000-4000-8000-000000000901). Proceed with the approved plan."
    system = "You are alice, serving as writer."
    Was round one kept in the history = true

[5] The final request state -> id=00000000-0000-4000-8000-000000000901
                 kind=plan_approval status=approved sender=alice target=lead
                 resolution.messageId=94820a84-7eee-422c-91e8-fc56fb9b5161 approved=true
```

Three details matter here too:

- `[2]` shows that **an ack in the request direction does not migrate the state**. The Lead receives the "I want to submit a plan" request and acknowledges it, and the request is still pending — because the Lead has not yet stated a position. Only a response migrates the state.
- `[4]` shows that after approval, the teammate receives a **deterministically generated prompt**, not free text from the Lead's model. `Plan approved (<id>). Proceed with the approved plan.` — the code assembles this sentence.
- The last line of `[4]`, "Was round one kept in the history = true", shows that the teammate uses the same Runner and the same history. The teammate was not rebuilt. It remembers what it did before.

### The key differences from the Chapter 15 trace

| Dimension | Chapter 15 (plain messages) | Chapter 16 (protocol messages) |
|---|---|---|
| What a message expresses | Content | Content + "which request this resolves" |
| Where the state lives | No independent state; the message itself is everything | `.agent_tutorial/protocol/state.json` |
| Who decides the next step | The model reads the message and decides itself | The runtime routes deterministically by type; shutdown never asks the model |
| What happens with a duplicate message | A stable event ID keeps it out of the history twice | The request_id + resolution also guarantee a single state migration |
| What happens on an error | A bad message enters quarantine | Five classes of handling: release / quarantine / worker failed |
| Can it block execution | No | Yes. The plan gate denies before the handler |

---

## The Essence of the Problem: Message Delivery Does Not Equal Protocol Completion

The Mailbox in Chapter 15 already made "delivery" solid: one file per message, one stable UUID, the flow `ready -> processing -> done/quarantine`, and recovery after a restart.

But it does not know these five things:

1. A `shutdown_response` arrives. Which shutdown request does it correspond to? Or is there no corresponding request at all?
2. Is the person who sent this response the person who was originally requested? Is the recipient the person who originally sent the request?
3. Is this request still waiting for a conclusion? Or has someone already replied? Could it have timed out already?
4. The same response was redelivered once because an ack failed. Does it count as a new statement of position?
5. A different message arrives, but it carries the same `request_id`. Does it count as a duplicate response?

The five questions share one point: **none of them asks "where is the message". All of them ask "how far has this matter got"**. The first is the duty of the transport. The second needs an independent state truth.

### Three ways to get it wrong

Before building the implementation, look at the traps that are easy to fall into. All three approaches can "run", but none of them holds up:

**Approach one: stuff the protocol into the content string.**

```typescript
// ❌ Do not do this
await mailbox.send("lead", "alice", "SHUTDOWN_REQUEST:req_a3f9", "message");
// Receiver: if (content.startsWith("SHUTDOWN_REQUEST:")) ...
```

Problem: `content` is a natural-language field for the model to read. One day the model quotes this prefix verbatim in its main text, and the runtime treats a piece of small talk as a shutdown instruction. A short ID such as `req_a3f9` can also collide, and it cannot verify the participants.

**Approach two: let the model parse a piece of free-text JSON.**

```typescript
// ❌ Do not do this either
// system prompt: "If you agree to shut down, reply {\"type\":\"shutdown_ok\"}"
```

Problem: the model might drop a quote, add a paragraph of explanation, or simply reply in Chinese, "Fine, I agree to shut down". You would be forced to write a pile of forgiving parsers, and every act of forgiveness is a gap that someone can bypass. The more fundamental problem: **shutdown should not be the model's decision at all**.

**Approach three: store the requests in an in-process dictionary.**

```typescript
// ❌ A restart wipes the memory
const pendingRequests = new Map<string, Request>();
```

Problem: the process crashes, or the CLI opens again, and the dictionary is empty. But that `shutdown_response` in the Mailbox still lies on disk, waiting to be consumed. At the next start, the runtime reads it and finds no corresponding request — should it throw the message away or process it? There is no basis for either choice.

### So this chapter splits the problem like this

What P16 adds is a **deterministic runtime** layer. It sits between the tools and the transport:

```text
Lead protocol tools                       Teammate protocol tools
request_shutdown / review_plan      submit_plan
        |                                 |
        +-------------+-------------------+
                      |
                      v
              ProtocolRuntime
        "Register the ProtocolRequest first, then send the typed message"
                      |
        +-------------+--------------------+
        |                                  |
        v                                  v
  JsonProtocolStore                 FileMailboxStore
  protocol/state.json               mailboxes/<name>/{ready,processing,
  ← The state truth is here                            done,quarantine}
        |                                  ← The delivery lives here
        |                                  |
        +-------------+--------------------+
                      |
                      v
              TeammateRuntime
      "Protocol messages take the deterministic router; only plain messages enter the model"
                      |
        +-------------+--------------------+
        |                                  |
        v                                  v
   kind === "protocol"                kind === "mailbox"
   Do not call the model               Call the model
```

Three sentences summarise this diagram:

1. **State and delivery are stored separately.** `state.json` manages "how far it has got", and `mailboxes/` manages "where the message is".
2. **The write order is fixed.** Always write state.json first, then write mailboxes.
3. **On read, split the flow first.** If the message is a protocol message, handle it yourself. Do not disturb the model.

One point needs emphasis: the protocol layer did **not** create a second message directory set, a second `EventInbox`, or a second Agent Loop. It reuses all the infrastructure from Chapter 15. It adds only one `state.json` and one type branch.

The implementation is concentrated in these files. You do not need to open them now; the "Companion Code Index" has the complete list:

- [Protocol domain model, tools and routing](code/chapters/ch16/src/features/protocol.ts)
- [Protocol single-snapshot store](code/chapters/ch16/src/adapters/protocol-json.ts)
- [Plain and protocol Mailbox model](code/chapters/ch16/src/features/mailbox.ts)
- [Joint message file adapter](code/chapters/ch16/src/adapters/mailbox-json.ts)
- [Persistent teammate protocol host](code/chapters/ch16/src/features/teammates.ts)


---

## The Public Delta: Only Three Tools

The whole chapter adds only this much public capability. The Lead gets two tools. A teammate gets one:

| Role | Tool | Input | What it does |
|---|---|---|---|
| Lead | `request_shutdown` | `teammate` | Register a pending shutdown request first, then deliver the typed request to the teammate |
| Lead | `review_plan` | `request_id`, `approve`, optional `feedback` | Deliver the approve/reject response to the original plan submitter |
| Teammate | `submit_plan` | `plan` | Register a pending plan request first, then deliver it to the Lead |

Every input schema is a `strictObject`. One extra field causes an error:

```typescript
const shutdownInput = z.strictObject({ teammate: z.string() });

const reviewPlanInput = z.strictObject({
  request_id: z.string(),
  approve: z.boolean(),
  feedback: z.string().optional(),
});

const submitPlanInput = z.strictObject({ plan: z.string().min(1) });
```

Three points deserve attention:

- The `approve` field of `review_plan` is a **boolean, not a string**. The schema accepts no fuzzy input such as `"yes"`, `"approved"` or `"ok"`.
- `feedback` is optional, but a rejection should strongly prefer to carry it — the prompt that the teammate receives after a rejection includes the feedback unchanged.
- The `plan` field of `submit_plan` has `.min(1)`. An empty plan cannot be submitted.

### The Tool Surfaces, Measured: Lead Has 20, a Teammate Has 5

This is not invented. The `tools` experiment produced it:

```text
[3] The tool surface the Lead sees (20 tools in total), the last four:
     ["spawn_teammate","send_message","request_shutdown","review_plan"]
    Does the Lead have submit_plan = false

[4] The tool surface a teammate sees (5 tools in total):
     ["shell","read_file","write_file","send_message","submit_plan"]
    Does a teammate have request_shutdown = false
    Does a teammate have review_plan = false
```

The Lead keeps the complete Chapter 15 prefix and appends only two tools at the **end**. A test asserts this order (see `ch16-bootstrap.test.ts`):

```text
..., spawn_teammate, send_message, request_shutdown, review_plan
```

A teammate has exactly these five:

```text
shell, read_file, write_file, send_message, submit_plan
```

### Why Split It This Way

This split is not arbitrary. Every line has a reason:

**A teammate has no `spawn_teammate`.** Otherwise a teammate could create teammates. The team size would run out of control, and nobody could say who reports to whom.

**A teammate has no `request_shutdown`.** Otherwise alice could ask bob to shut down. Who may terminate whom is a governance decision. It cannot be delegated.

**A teammate has no `review_plan`.** This one is the most important: **if a teammate could approve plans, it could approve its own plan**, and the plan gate would immediately become a formality. The approval power must sit outside the party that the gate constrains.

**The Lead has no `submit_plan`.** The Lead does not need to submit a plan to anyone. Giving it this tool would only make the model use it at the wrong time.

The principle shown here is the same as for the subagents in Chapter 6: **the tool surface is the permission boundary**. Not giving a tool is far more reliable than giving it and then using a prompt to persuade the model not to use it.

### One Piece of History, Made Clear

An early design draft listed a separate `request_plan` in the Lead's tool table. The current implementation **does not have** this tool, and it keeps no compatibility alias.

The reason is simple: the main text never defined what `request_plan` takes as input, what state it registers, or who responds to it. A "protocol" tool with no state migration and no responding party would only make readers believe in a chain that does not exist.

A teammate starts a plan request itself with `submit_plan`. If the Lead wants a teammate to propose a plan, one plain `send_message` sentence is enough — that is exactly what a plain message is for.

---

## ProtocolRequest: The Persistent Request Is the State Truth

Look at the domain object first. It has nine fields. None of them is optional:

```typescript
interface ProtocolRequest {
  readonly id: string;                       // Canonical UUID
  readonly kind: "shutdown" | "plan_approval";
  readonly sender: string;                   // The initiating party
  readonly target: string;                   // The requested party
  readonly status: "pending" | "approved" | "rejected";
  readonly content: string;                  // The request body
  readonly createdAtUtc: Date;
  readonly expiresAtUtc: Date;
  readonly resolution: ProtocolResolution | null;
}
```

Two closed sets. The first line of the `kinds` experiment output shows them:

```text
ProtocolRequestKind   = {"Shutdown":"shutdown","PlanApproval":"plan_approval"}
ProtocolRequestStatus = {"Pending":"pending","Approved":"approved","Rejected":"rejected"}
```

There are only two kinds of request and three states. There is no `cancelled`, no `expired` state, and no `in_review`. Expiry of a request is not a state. It is the fact that "the current time has passed `expires_at_utc`" — the state itself stays at `pending`. The "Expiry" subsection in "Hard Rule Two: The Response Must Match Completely" returns to this point.

### Six Invariants

| Invariant | Why |
|---|---|
| `sender !== target` | A request to shut yourself down is meaningless. It only creates an endless wait |
| Names must be safe lowercase slugs | A name becomes a directory name. Chapter 15 already validates this once |
| The id must be a canonical UUID | The runtime accepts no short ID such as `req_a3f9`, and no case variants |
| pending must not carry a resolution | That would contradict itself: still waiting for a conclusion, yet already holding one |
| approved / rejected must carry a matching resolution | A final state must be able to state "who, when, and approved or not" |
| The resolution time lies in `[createdAtUtc, expiresAtUtc)` | It cannot be earlier than the request creation, and it cannot equal or pass the expiry moment |

The interval notation in the last row deserves attention: **closed on the left, open on the right**. A response that arrives exactly at `expires_at_utc` counts as expired. The boundary is not included. This avoids any dispute about "does it count as a timeout or not".

### The State Machine Has Only Two Edges

```text
                    ┌─────────────┐
                    │   pending   │  ← The only start point; this is the state at creation
                    └──────┬──────┘
                           │
          consumeResponse  │  consumeResponse
          approved = true  │  approved = false
              ┌────────────┴────────────┐
              ▼                         ▼
      ┌───────────────┐         ┌───────────────┐
      │   approved    │         │   rejected    │
      │  (final state) │         │  (final state) │
      └───────────────┘         └───────────────┘
```

There are no return edges. After approved, the state cannot change to rejected. After rejected, the decision cannot be reversed either. To change your mind, submit a new request — the history of the old request stays complete.

### What It Looks Like on Disk

`JsonProtocolStore` stores **all** requests in one file:

```text
.agent_tutorial/
  protocol/
    state.json          ← The single snapshot of all requests
  .protocol.lock        ← Cross-process lock (created by proper-lockfile)
```

The real content that the `state` experiment produced:

```json
{
  "version": 1,
  "requests": [
    {
      "id": "00000000-0000-4000-8000-000000000901",
      "kind": "plan_approval",
      "sender": "alice",
      "target": "lead",
      "status": "pending",
      "content": "write the config",
      "created_at_utc": "2026-07-30T08:00:00.000Z",
      "expires_at_utc": "2026-07-30T08:05:00.000Z",
      "resolution": null
    }
  ]
}
```

Compare the two forms, point by point:

- On disk, the names are **snake_case** (`created_at_utc`). In memory, they are **camelCase** (`createdAtUtc`). This is the standing convention in this tutorial: the disk format is an external contract, and changing it must consider compatibility; the in-memory fields are an implementation detail.
- `version: 1` sits at the outermost level. If the schema changes later, this field decides whether the file can be read.
- The times are ISO strings with a `Z`, not Unix timestamps. A human can read them directly, and no timezone ambiguity appears.
- The default TTL is 300000 milliseconds. The request is created at `08:00:00` and expires at `08:05:00` — exactly 5 minutes.

### Why One Snapshot, Not One File per Request

The Chapter 15 Mailbox uses "one file per message". Here, all requests go into one `state.json`. It looks inconsistent. In fact, the two designs serve two different needs:

| | Mailbox message | Protocol request |
|---|---|---|
| Main operations | Single delivery, single consumption | It often must ask "which plan from this teammate is the latest" |
| Scale | Grows continuously | Few requests are pending at the same time |
| Needs cross-item comparison? | No | Yes (to judge "latest") |
| How the state is expressed | Directory name | Field |

Every call to `planAllowsEffectful` must find "the latest plan that this teammate submitted". With one file per request, the code would have to list the directory, read each file, and sort — and that process would also have to be atomic, or a write in the middle would produce an inconsistent view. A single snapshot turns this into one read.

### Two Locks Solve Two Different Problems

```text
Two JsonProtocolStore instances in the same process
        |
        v
  #tails: Map<realpath, Promise>   ← In-process mutex (a Promise tail chain)
        |
        v
  .agent_tutorial/.protocol.lock   ← Cross-process lock (proper-lockfile)
        |
        v
  Temporary file -> fsync -> atomic rename
```

**The in-process mutex** solves this case: in one Node process, you create two `JsonProtocolStore` instances (for example, one for the Lead and another in a test), and they read, modify and write `state.json` at the same time. The lock key is the realpath of the workspace — so `F:\proj` and `F:\proj\` count as the same workspace.

**The cross-process lock** solves this case: two CLI processes point at the same workspace. The in-process mutex cannot govern that. A file lock must do it.

The two locks cannot replace each other. With only the file lock, two instances in one process would fight over the lock and might wait forever (re-entering a file lock inside one process behaves unreliably). With only the in-process mutex, another process can still overwrite your write.

**The write discipline** is the same as in the earlier chapters: write a temporary file first, `fsync` it to disk, then `rename` it atomically over the target. A power loss has only two outcomes — the old file is complete, or the new file is complete. Half a JSON file never appears.

### The Array Order Is "Who Is Newer"

The `requests` value in the snapshot is an array. It **keeps the creation order inside the lock**. The code judges "the latest plan" by array position. It does not use UUID size, and it does not compare timestamps:

```typescript
// Find the latest plan: scan backwards and take the first match; do not sort
latestPlanRequest(target: string) { /* Scan requests in reverse order */ }
```

Why not timestamps? Two requests can easily share the same UTC millisecond — with a fixed clock injected in tests, this is guaranteed. If the code sorted by time, "which one is newer" would become undefined behavior. The array order has no such problem.

Why not UUIDs? A UUID v4 is random. Its lexicographic order has no relation to the generation order. Sorting by it is no better than drawing lots.

One more defence exists: if an injected clock really runs backwards (the `createdAtUtc` of a new request is earlier than a request already in the snapshot), `createRequest` **fails explicitly**. It does not quietly place the new request at the front.

---

## Hard Rule One: Register First, Send Second

For shutdown and for plan approval alike, the order is fixed:

```typescript
const request = await protocol.requestShutdown("alice");
// At this line, state.json already holds the pending record.
// Only then does TeammateRuntime deliver the typed message into alice's mailbox.
```

### What Happens If the Order Is Reversed

Suppose the code sends the message first and registers the request second. One very realistic timing then breaks:

```text
Time T1  The Lead writes the shutdown_request into alice's ready/
Time T2  alice's worker happens to wake and claims this message
Time T3  alice validates the request_id -> state.json has no such record
         -> ProtocolNotFoundError -> the message enters quarantine
Time T4  Only now does the Lead register the request in state.json
```

The result: the disk keeps one pending request that will never receive a response, and one valid message lying in quarantine. And this bug appears only when "the teammate happens to wake between the two steps" — you may not hit it in ten local runs, but in production it starts to appear at random.

Registering first leaves no such window. Before the message appears, the request is already on disk. At any moment a message arrives, the code can find its corresponding request.

### What If the Send Fails: Keep the pending Record

What about the reverse? The request registers successfully, but the message cannot go out (the disk is full, or the teammate has already failed)?

The current implementation throws `ProtocolDeliveryError`, and it **keeps the pending request that was already persisted**. The real output of the `order` experiment:

```text
===== order =====
requestShutdown threw: ProtocolDeliveryError(protocol_delivery_error): Protocol message could not be delivered

After the delivery failed, the request still stays on disk:
   id=00000000-0000-4000-8000-000000000901
   kind=shutdown status=pending sender=lead target=alice
```

Why not roll that request back? Three reasons:

**First, the rollback itself can fail.** You plan to delete the record in a catch block, but the deletion also writes to disk — if a full disk made the send fail, why would the deletion succeed? So you need a branch for "the rollback failed", and then a "rollback of the failed rollback". This road has no bottom.

**Second, the pending record is diagnostic information.** When something breaks in production, a record that says "at 08:00 someone asked alice to shut down; still pending now" is worth far more than nothing at all.

**Third, it is a recoverable starting point.** The request still exists. A human can decide to redeliver it once, or mark it abandoned by hand. A quiet deletion leaves nothing behind.

This section also states two things that P16 does **not** do: it does not create another request automatically to cover up the failure, and it does not retry forever in the background. A failure is a failure. The code throws it explicitly, so the caller knows.

---

## The Typed Mailbox: The Protocol Does Not Degrade into JSON inside content

The plain message kinds from Chapter 15 did not change by one character:

```text
MailboxMessageKind = task, message, result
```

What P16 adds is a **separate** enumeration:

```text
ProtocolMessageKind = shutdown_request
                      shutdown_response
                      plan_approval_request
                      plan_approval_response
```

The measured output of the `kinds` experiment:

```text
ProtocolMessageKind   = {"ShutdownRequest":"shutdown_request","ShutdownResponse":"shutdown_response","PlanApprovalRequest":"plan_approval_request","PlanApprovalResponse":"plan_approval_response"}
```

Note that these four names form **pairs**: `xxx_request` and `xxx_response`. The validation in "Hard Rule Two: The Response Must Match Completely" uses this pairing.

### Envelope Fields

Beyond the shared transport fields, `ProtocolMailboxMessage` adds two more:

| Field | Constraint |
|---|---|
| `id` | The transport's own canonical UUID. It is also the event ID and the idempotency key |
| `sender` / `recipient` | Safe Agent names. The two must differ |
| `kind` | Must come from `ProtocolMessageKind`. A plain message kind is not accepted |
| `content` | Non-empty. The request body or the feedback |
| `created_at_utc` | UTC with a timezone |
| **`request_id`** | The canonical UUID of the corresponding ProtocolRequest |
| **`approved`** | A request must carry `null`. A response must carry an explicit boolean |

The runtime enforces that last `approved` rule **at construction time**. It does not wait until the value is used. The `kinds` experiment tried all six combinations:

```text
The approved validation in createProtocolMailboxMessage:
  shutdown_request + approved=null  -> accepted kind=shutdown_request
  shutdown_request + approved=true  -> rejected TypeError: Protocol response approved must be a boolean and request approved must be null
  shutdown_response + approved=true -> accepted kind=shutdown_response
  shutdown_response + approved=null -> rejected TypeError: Protocol response approved must be a boolean and request approved must be null
  plan_approval_response + false    -> accepted kind=plan_approval_response
  message (not a protocol kind)     -> rejected TypeError: ProtocolMailboxMessage kind must be a protocol kind
```

The meaning of this constraint is: **a request cannot carry its own conclusion, and a response must carry one**. A `shutdown_request` that carries `approved: true` is meaningless — on what basis would the requesting side state a position for the requested side? Conversely, a `shutdown_response` that carries `approved: null` is also meaningless — then why did you send this reply at all?

### The `kind` Is `"protocol"`, Not `"mailbox"`

This detail is the easiest to overlook in the whole chapter, and it has the largest effect. Look at the two payload functions:

```typescript
// Plain message
function mailboxPayload(message: MailboxMessage) {
  return { kind: "mailbox", message_id: ..., sender: ..., /* ... */ };
}

// Protocol message
function protocolMailboxPayload(message: ProtocolMailboxMessage) {
  return { kind: "protocol", message_id: ..., protocol_kind: ...,
           request_id: ..., approved: ... };
}
```

The complete payload that the `kinds` experiment printed:

```json
{
  "kind": "protocol",
  "message_id": "00000000-0000-4000-8000-000000000801",
  "sender": "lead",
  "recipient": "alice",
  "protocol_kind": "shutdown_request",
  "content": "Graceful shutdown requested.",
  "created_at_utc": "2026-07-30T08:00:00.000Z",
  "request_id": "00000000-0000-4000-8000-000000000901",
  "approved": null
}
```

```text
isProtocolMailboxMessage = true
eventId === id            = true
idempotencyKey === id     = true
```

Three points:

- The outer `kind` is `"protocol"` (this is the **event type**). The inner `protocol_kind` is `"shutdown_request"` (this is the **protocol action**). Do not confuse the two layers.
- `eventId` and `idempotencyKey` both equal the message's own `id`. As in Chapter 15: **one object, two identities**. It is a Mailbox message, and it is also a runtime event.
- The judgement function requires three things to hold at the same time:

```typescript
function isProtocolMailboxMessage(payload) {
  return payload.kind === "protocol"
      && "request_id" in payload
      && "protocol_kind" in payload;
}
```

The plain message schema gained **no** new optional protocol fields. This point matters: if the design had chosen "add two optional fields, `request_id?` and `approved?`, to the plain message", then every place that handles a plain message would have to consider "what if these two fields carry values". Physical separation into two envelopes lets the type system guard the branches for you.

The file adapter parses these two envelopes with a strict union type. Protocol messages keep reusing the original atomic migration through `ready/processing/done/quarantine` — **there is no second directory set**.

---

## Hard Rule Two: The Response Must Match Completely

For one response to change the state of a request, six conditions must hold **at the same time**:

| # | Condition | What it blocks |
|---|---|---|
| 1 | `request_id` points to a request that really exists | A forged request, or one that was already cleaned up |
| 2 | The response kind pairs with the request kind | Using a `plan_approval_response` to close a shutdown request |
| 3 | The sender of the response == the target of the request | Someone else stating a position for the requested party |
| 4 | The recipient of the response == the sender of the request | Sending the response to an unrelated third party |
| 5 | The request is still pending | A repeated statement of position, an attempt to overturn the result |
| 6 | The current time is strictly earlier than `expires_at_utc` | A late response |

Conditions 3 and 4 combine into one sentence: **the response must be the exact reverse of the original request**. The request is `lead -> alice`, so the response must be `alice -> lead`. No other combination is allowed.

### Five Rejections, Measured

The `match` experiment tried each of the five wrong forms once:

```text
===== match =====
A fully matching shutdown_response  -> passed, status=pending
Direction reversed (sender=lead)       -> rejected, ProtocolMismatchError(protocol_mismatch): Protocol message does not match request
Wrong recipient (recipient=bob)   -> rejected, ProtocolMismatchError(protocol_mismatch): Protocol message does not match request
Request id does not exist                -> rejected, ProtocolNotFoundError(protocol_not_found): Protocol request does not exist: 00000000-0000-4000-8000-000000000999
Response kind not paired                -> rejected, ProtocolMismatchError(protocol_mismatch): Protocol message does not match request
id is not a canonical UUID              -> rejected, Error: Mailbox message id must be a canonical UUID

validateResponse is read-only; the request is still pending: pending
```

The last line is the key point: **`validateResponse` is read-only**. It only answers "is this response valid". It changes no state. After the "fully matching" response in the first line passes validation, the request is still `pending`.

Why split validation and migration apart? The Lead side must do these two things at two different times — validation happens in the drain phase, and migration happens in the ack phase. The next section covers exactly this.

### The Only Writer: consumeResponse

`consumeResponse` is the **only** function that can change pending into a final state. Its behavior has three cases. The `consume` experiment covers all of them:

```text
===== consume =====
First consume -> id=00000000-0000-4000-8000-000000000901
                  kind=shutdown status=approved sender=lead target=alice
                  resolution.messageId=00000000-0000-4000-8000-000000000801 approved=true
The same response retried   -> id=00000000-0000-4000-8000-000000000901
                kind=shutdown status=approved sender=lead target=alice
                resolution.messageId=00000000-0000-4000-8000-000000000801 approved=true
Another response -> ProtocolStateError(protocol_state_error): Protocol request is already resolved: 00000000-0000-4000-8000-000000000901
Same id, changed content -> ProtocolStateError(protocol_state_error): Protocol request is already resolved: 00000000-0000-4000-8000-000000000901
```

Explanation, line by line:

**The first consume** — a normal migration. `pending -> approved`, and the code writes the resolution.

**The same response retried** — the function returns the same result idempotently, with no error. This case is the key to an ack-failure redelivery: when the same message ID arrives again, the code treats the first attempt as already successful. The judgement uses the internal `sameResponse` — the message ID, the approved value and the content must all agree before two messages count as "the same one".

**Another response** (a different message ID) — the function reports `ProtocolStateError`. This is not a retry. It is a second statement of position, and the code must reject it.

**Same id, changed content** — also an error. The message ID is the same but the content changed. That means this is not a redelivery. Someone is forging. `sameResponse` checks the content, so this case is blocked here.

The final state looks like this on disk:

```json
{
  "version": 1,
  "requests": [
    {
      "id": "00000000-0000-4000-8000-000000000901",
      "kind": "shutdown",
      "sender": "lead",
      "target": "alice",
      "status": "approved",
      "content": "Graceful shutdown requested.",
      "created_at_utc": "2026-07-30T08:00:00.000Z",
      "expires_at_utc": "2026-07-30T08:05:00.000Z",
      "resolution": {
        "message_id": "00000000-0000-4000-8000-000000000801",
        "approved": true,
        "content": "Ready to shut down.",
        "resolved_at_utc": "2026-07-30T08:00:00.000Z"
      }
    }
  ]
}
```

Each of the four fields in `resolution` has a use: `message_id` judges retry idempotency, `approved` is the conclusion itself, `content` keeps the original feedback (on a rejection, it is the feedback), and `resolved_at_utc` is the audit time point.

### Two Kinds of "Duplicate", Handled Differently

This distinction is easy to blur. It deserves separate emphasis:

```text
Case A: the same message ID arrives once more
   Cause: the Mailbox ack failed, and the message was redelivered
   Handling: return the completed result idempotently
   Reason: this is the same statement of position, a duplication at the transport layer

Case B: a different message ID, carrying the same request_id
   Cause: someone stated a position a second time, or a forgery
   Handling: reject it and report protocol_state_error
   Reason: these are two statements of position, a conflict at the semantic layer
```

The judgement basis is the message ID. This also explains why every protocol message must have its own canonical UUID: **it is the anchor of idempotency**.

### Who Wins under Concurrency

What happens when two threads, or two store instances, consume the same request at the same time, each with a different response?

Inside the `proper-lockfile` lock, only one of them can complete the migration. The other one **re-reads the snapshot after it enters the lock**, sees that the state is already approved, and takes the "already resolved" branch, which reports an error.

The key is "re-read after entering the lock". If the implementation were "read the snapshot before the lock, write directly after the lock", the second writer would overwrite the first result with a stale view. This is the most classic trap in concurrent code. The lock position must enclose the whole "read — judge — write" unit.

### Expiry: The State Does Not Change, but Responses Stop Being Accepted

The `expire` experiment injects the TTL as 1000 milliseconds, then moves the clock:

```text
===== expire =====
createdAtUtc = 2026-07-30T08:00:00.000Z
expiresAtUtc = 2026-07-30T08:00:01.000Z (TTL injected as 1000ms)

Clock +500ms (not expired):
  consume -> id=00000000-0000-4000-8000-000000000901
             kind=shutdown status=approved sender=lead target=alice
             resolution.messageId=00000000-0000-4000-8000-000000000801 approved=true

The second request responds only after the TTL:
  consume -> ProtocolExpiredError(protocol_expired): Protocol request has expired: 00000000-0000-4000-8000-000000000902
  The state on disk is still = pending
  getPendingRequest ->
    ProtocolExpiredError(protocol_expired): Protocol request has expired: 00000000-0000-4000-8000-000000000902
```

Three observations:

- At `+500ms`, the response is still inside the window, and the consume is normal.
- After the TTL, `consume` reports `protocol_expired`.
- **The state on disk is still `pending`**. Expiry is not a state migration.

That last point is a deliberate design. If expiry had to write to disk once, someone would have to scan all requests regularly and change the timed-out ones — that means a background task, a scan period, and a whole set of "what happens when the scanner dies" problems.

Making expiry a **judgement at read time** removes all of these problems. Every call to `getPendingRequest` compares the current time with `expires_at_utc`, and it reports an error when the request has expired. The state field stays `pending`. It records the truth: "this request never received a conclusion".

### Bad State Is Always Rejected

`state.json` is a file on disk. A human can edit it by hand, and another program can corrupt it. The `storage` experiment tried six ways to break it:

```text
===== storage =====
One extra top-level field          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
version is not 1          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
A request missing one field          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
A request with one extra field          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
pending but carrying a resolution -> ProtocolStorageError(protocol_storage_error): Pending protocol request cannot have a resolution
requests is not an array       -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid

After restoring the original snapshot, listRequests = 1 entry

The id generator returns a bad value:
  ProtocolStorageError(protocol_storage_error): Protocol id generator returned an invalid UUID

getRequest queried with a non-UUID:
  ProtocolNotFoundError(protocol_not_found): Protocol request id must be a canonical UUID
```

Note that "one extra field" is also rejected. This is the effect of `strictObject`: the code recognises no field that the schema does not define. Forgiving parsing (ignoring unknown fields) is dangerous here — a spelling error such as `"status": "pending", "statuz": "approved"` would be swallowed silently.

The second-to-last line is especially interesting: even **an injected ID generator** is validated. If a test injects a generator that returns `"not-a-uuid"`, `createRequest` fails explicitly. It does not write a request with an illegal ID to disk. Invariants must be guarded at the write boundary. The code cannot rely on the caller to follow the rules.

The last line shows that queries are validated too: pass `"nope"` to `getRequest`, and the code reports `protocol_not_found` at once, with the reason "not a canonical UUID". It does not scan everything first and then say "not found".

---

## The Lead Side: Write the History First, Then Consume the State

This section is the most winding part of this chapter, and also the part most worth reading slowly. Read it together with the output of the `shutdown` experiment.

### Two Phases, and What Each One Does

When the Lead receives a protocol message, `TeammateRuntime` processes it in two steps:

```text
Phase one: drain (take the message out and publish it as an event)
  claim the protocol response (ready -> processing)
  validateLeadMessage      ← Read-only validation! It changes no state
  Publish it as a runtime event, into the EventInbox

Phase two: acknowledge (after the Loop confirms)
  Write the event into the Lead's canonical history first
  acknowledgeLeadMessage -> consumeResponse   ← The state migrates only here
  Ack the Mailbox (processing -> done)
```

A vertical line shows the time:

```text
Time ──────────────────────────────────────────────────>

drain                          acknowledge
  │                                │
  ├─ claim                         ├─ history.push(event)
  ├─ validate (read-only)               ├─ consumeResponse (pending -> final state)
  └─ publish event                 └─ ack the transport (-> done)
                                        ▲
                                        └─ Only from here does "protocol completed" count
```

These two lines from the `shutdown` experiment are the evidence for this order:

```text
    Before the ack, the request state = pending
...
[4] After the ack:
    ... status=approved ...
```

### Why the State Must Not Migrate during the Drain Phase

Suppose the drain phase changed the request to approved at once. This timing then appears:

```text
T1  drain: consumeResponse -> the request becomes approved  ✅ The disk has changed
T2  Publish the event to the EventInbox
T3  The process crashes as the Loop prepares to write the history  ❌ The history does not have this entry
T4  Restart: state.json says approved
        The Mailbox says this message is still in processing
        The Lead's history holds no record of the shutdown at all
```

The result: **the state says this matter completed, but the Lead's conversation history does not contain it at all**. In the next turn, the model cannot see "alice has confirmed the shutdown", and it may send `request_shutdown` once more. And when that processing message is recovered and redelivered, it errors because the request is already resolved.

Writing the history first avoids this inconsistency: what the model can see (the history) is never later than the state truth.

### The Reverse Case: the Ack Fails

What if the history is written and the state has changed, but the last step, the transport ack, fails?

A "half-completed" state now exists: the request is already approved, but the message in the Mailbox is still in `processing`. The recovery mechanism returns it to `ready`, so the same message **arrives once more**.

This redelivery creates no duplication:

| Layer | What deduplicates it |
|---|---|
| The Loop history | `#seenEventIds` has recorded this event ID. It does not push twice |
| ProtocolStore | The same message ID. `consumeResponse` returns idempotently |
| Mailbox | Ack once more: `processing -> done` |

Each of the three layers is idempotent on its own. So any number of redeliveries gives the same result.

### One Key Difference: A Protocol Event Is Not a Mailbox Event

One detail here is very easy to misread in the code. Three places in `loop.ts` branch on the event type. All of them check `kind === "mailbox"`:

```typescript
// loop.ts:646 —— In a plain user turn, a mailbox event is only deferred
if (event.toPayload().kind === "mailbox" && !allowContextEvents) {
  this.#deferredRuntimeEvents.push(event);
  events = this.#eventPump.drainEvents(1);
  continue;
}

// loop.ts:668/673 —— When the ack fails, a mailbox event keeps its "already in history" half-state
} catch (error) {
  if (event.toPayload().kind !== "mailbox" && isNewEvent) {
    this.#history.pop();                        // Full rollback
    this.#seenEventIds.delete(event.eventId);
  }
  if (event.toPayload().kind === "mailbox") this.#pendingEventAcks.add(event.eventId);
  throw error;
}
```

The payload `kind` of a protocol event is `"protocol"`. So none of these three branches holds for a protocol event. The behavior is:

| Behavior | Plain mailbox event | Protocol event |
|---|---|---|
| Deferred in a plain user turn? | Yes. It waits for an explicit `runEvents()` | **No.** It joins the current turn directly |
| How is the history handled when the ack fails | Kept (half-state). Only a pending ack is registered | **Full rollback**: `history.pop()` + delete the seen id |
| After a redelivery | Only the ack is completed. It does not re-enter the history | It runs again from the start, as a new event |

The "full rollback" in the second row, together with the republication on the teammate side, gives a consistent effect: the Lead's history keeps no trace of this event, the message returns to ready, and the whole thing runs again next time. It is not a half-state. It is a **whole retry**.

This difference is not a design defect, and it is not an omission. Its premise is that protocol consumption is itself idempotent — `consumeResponse` is idempotent for the same message ID, so a "whole retry" and a "completed ack" finally converge to the same result.

As an aside: the deferral branch at `loop.ts:640`, the one with `contextIdentity !== undefined`, is hit only by Cron events (`contextIdentity` is set only at `cron.ts:417,422`). A protocol event does not set this field, so it does not take that path either.

### This Is Not "Exactly Once"

The accurate description of this mechanism is: **at-least-once delivery + idempotency by stable ID**.

What it guarantees: the state of one persistent request migrates only once.

What it does **not** guarantee: that an arbitrary external effect (side-effect) happens only once. For example — if a teammate sends an email while it processes a message, and then the ack fails and the message is redelivered, the email goes out a second time. The ProtocolStore has no authority over the mail server.

To make an external effect happen only once too, you must build idempotency at that effect's own boundary (for example, give the email an idempotency key and let the mail service deduplicate). The protocol layer cannot solve this problem for you. Read the premises of any claim about "distributed exactly-once" with care.

---

## shutdown: Finish the Work in Hand First, Then Route Deterministically

### Why You Cannot Just Kill It

The most naive implementation looks like this:

```typescript
// ❌ Do not do this
teammates.kill("alice");   // Abort the worker directly and destroy the Runner
```

The problem is that you do not know what alice is doing at this moment. She might be:

- In the middle of a `write_file` — leaving half a file behind;
- She just started a background task — that task becomes an orphan, and nobody claims its result;
- Waiting for the model to return — the money for that API call is already spent, and the result is lost.

The definition of a graceful shutdown is exactly this: **let the party being shut down choose its own safe point**.

### The Shutdown Request Travels through the Same Mailbox

A shutdown request takes no special channel. It is a plain file written into alice's `ready/` directory. And a worker processes only **one** processing message at a time.

These two facts together implement "finish the work in hand first" automatically:

```text
alice's ready/ directory (in FIFO order)
  ┌────────────────────────────┐
  │ 1. message: "Fix the README" │  ← The worker is processing this one
  │ 2. shutdown_request        │  ← Queued behind it, not yet claimed
  └────────────────────────────┘

The worker loop:
  Claim item 1 -> call the model -> write the file -> return the result -> ack
  Claim item 2 -> find a protocol message -> take the router, do not call the model
```

No special case for "check whether a shutdown request exists" is needed. No "should I stop" checkpoint needs insertion before every tool call. FIFO order + one message at a time is the safe point.

### The Protocol Split Happens before the Model Call

After the worker claims a message, the first thing it does is judge the type:

```text
The current task/message completes and is acked
  |
  v
Claim the next one -> it is a shutdown_request
  |
  ├─ Validate the request id, the kind and both parties (validateRequest)
  ├─ Teammate status = shutdown (beginShutdown)
  ├─ Send shutdown_response(approved=true), content = "Ready to shut down."
  ├─ ack the shutdown_request (processing -> done)
  |
  └─ Do not call the model  ←←← The key point
```

The line "Model call count = 1 (The shutdown spent no extra model call)" in the `shutdown` experiment verifies exactly this.

Why not ask the model? Because **shutdown is not the model's decision**. The Lead has already decided. The teammate's task is to exit safely, not to state an opinion. Letting the model take part brings only three harms: one extra API call, one extra chance of failure, and the model might reply "I want to work a bit longer", an answer that nobody can handle.

The body of the response is hard-coded in the code: `"Ready to shut down."` — it is not prose for a human to read. It is a protocol signal.

### The shutdown State Does Not Mean Object Destruction

Chapter 15 covered this point. Confirm it once more here:

```text
status = shutdown means "this worker accepts no new messages"

It does not mean:
  ❌ The Runner object was destroyed
  ❌ The history was cleared
  ❌ The memory was released
```

The composition root handles the real resource release in one place. The order is the **reverse** of the dependency order:

```text
Teammate -> Cron -> JobSupervisor
```

Why reverse? A teammate depends on the JobSupervisor to run its worker. Close the supervisor first, and the running worker is interrupted hard — that is not a graceful shutdown. It only moves the problem to another place.

### Five Failures, Five Handlings

This is this chapter's failure classification table. It is also the table most worth remembering:

| Case | Handling | Teammate state | Why |
|---|---|---|---|
| close / cancel interrupted a worker that was sending a response | `release` back to ready | Unchanged | The message is good. Only this attempt was interrupted |
| The protocol state store failed (a disk fault) | `release` back to ready | `failed` | The message is good, but this worker is no longer trustworthy |
| The response delivery failed | `release` back to ready | `failed` | Same as above |
| `protocol_mismatch` / `not_found` | `quarantine` | Unchanged | **The message itself** is invalid. Ten thousand retries give the same result |
| `protocol_expired` / `state_error` | `quarantine` | Unchanged | Same as above |

The judgement standard is one sentence:

> **The message is good, only this attempt did not succeed → release (retryable)**
> **The message itself is bad → quarantine (a retry is meaningless)**

The branch in the code looks like this:

```typescript
// The worker branch in teammates.ts (simplified)
if (isProtocolMailboxMessage(message) && !isProtocolQuarantineError(error)) {
  await store.release(message);      // Return it to ready
  this.#setStatus(worker, Failed);   // Mark the worker as failed
  throw error;
}
// ... Only a quarantine-class error reaches this point
await store.quarantine(message);
if (isProtocolMailboxMessage(message)) continue;   // The teammate stays alive
```

### Measured Case One: A Bad Message Enters Quarantine, and the Teammate Does Not Die

The `quarantine` experiment manually placed a response into alice's ready directory. Its `request_id` does not exist at all:

```text
===== quarantine =====
[1] The file count in alice/quarantine = 1
    Teammate state = running (not marked failed)

[2] After the bad envelope was quarantined, a plain message still ran to completion -> "second result"
    Model call count = 2 (The bad envelope did not enter the model)

[3] The envelope in quarantine looks like this:
     {"id":"89f4d60b-952a-408f-8c67-9e3560e4ba97","sender":"lead","recipient":"alice","kind":"plan_approval_response","content":"approved","created_at_utc":"2026-08-30T12:09:45.945Z","request_id":"00000000...
```

Three conclusions:

- The bad message entered `quarantine`. It does not retry forever in ready.
- The teammate state is `running`. It was **not** marked failed — one bad message must not poison a whole teammate.
- The bad message never entered the model. The router judged it dead before the model call.
- The quarantine keeps the complete original envelope, for later diagnosis.

### Measured Case Two: A Delivery Failure Must Release. It Must Not Be Swallowed

The `release` experiment wrapped the store in one layer. It forces the delivery of "the shutdown_response that the teammate sends back to the Lead" to fail:

```text
===== release =====
[1] After the response delivery failed:
    Teammate state = failed
    Request state = pending (not misjudged as approved)
    alice/ready:      1 file
    alice/processing: 0 files
    alice/quarantine: 0 files

[2] Conclusion: the request envelope returns to ready (release) and waits for the next redelivery;
    The state machine stays at pending. It would rather retry once than falsely report a completed shutdown.
```

Compare this with the table above: this case is "the message is good, but the worker is not trustworthy", so the handling is the `release` + `failed` combination.

The most important line is "Request state = pending". The response did not arrive, so the request cannot count as completed. If the code took a shortcut here and changed the state to approved, the Lead would believe that alice had shut down safely — while in fact alice only failed, and she may still hold a pile of things that were never cleaned up.

**Let the Lead retry once. Never falsely report completion.** Every protocol implementation should hold this bottom line.

---

## Plan Approval: The State Changes First, the Runner Resumes After

### A Trace in Three Segments

The **teammate starts** the plan flow. It has three segments in total:

```text
[Segment one] The teammate side
Teammate submit_plan(plan)
  -> createRequest: register a pending plan_approval request
  -> Send plan_approval_request to the lead

[Segment two] The Lead side (one event turn)
  -> The typed request enters the history, then ack the transport
  -> Note: an ack in the request direction does not migrate the state. The request is still pending
  -> The Lead decides: review_plan(request_id, approve, feedback?)
  -> Send plan_approval_response to the original submitter

[Segment three] The teammate worker
  -> claim the typed response
  -> consumeResponse: pending -> approved / rejected   ←←← Change the state first
  -> The permission layer can now see the new state
  -> Reuse the same Runner and feed it one deterministic prompt  ←←← Resume execution after
```

The "first" and the "after" in segment three cannot be swapped. The next subsection covers exactly this.

### Why the State Must Change First

Suppose the order is reversed: wake the Runner first, then change the state.

```text
T1  The teammate worker claims the plan_approval_response
T2  Wake the Runner and feed the prompt "Plan approved. Proceed."
T3  The model immediately returns a tool_call: write_file
T4  The permission layer checks planAllowsEffectful -> the state is still pending -> DENY
T5  Only now change the state
```

At T3, the model did exactly the right thing — it was told that the plan was approved, so it started to execute. Its own permission layer then refused it. And this failure enters the history. In the next turn, the model sees "write_file was rejected", and it may start to guess the reason wildly, or try to find a way around.

Changing the state first leaves no such window. When the model wakes, the permission layer already sees the final state.

### The Teammate Receives a Deterministic Prompt

The code assembles both the approval prompt and the rejection prompt. The Lead's model does not generate them freely:

```typescript
// Approval
`Plan approved (${id}). Proceed with the approved plan.`

// Rejection (message.content is the feedback that the Lead filled in)
`Plan rejected (${id}). Feedback: ${message.content}`
```

The `plan` and `reject` experiments verified these two sentences separately:

```text
[4] The prompt that the second model request received:
    "Plan approved (00000000-0000-4000-8000-000000000901). Proceed with the approved plan."
```

```text
===== reject =====
result = "revised plan result"
The prompt the teammate received after the rejection = "Plan rejected (00000000-0000-4000-8000-000000000901). Feedback: Too dangerous, use a different plan"
The final request state -> id=00000000-0000-4000-8000-000000000901
            kind=plan_approval status=rejected sender=alice target=lead
            resolution.messageId=29e738f5-526d-46b7-bbd8-0b4e67cc96d5 approved=false

After the rejection, planAllowsEffectful = false (A rejection does not mean a pass)
```

The prompt carries the request id on purpose: the teammate's history may hold several plans, and this id lets it match which one this is.

The last line of the `reject` experiment deserves separate emphasis: **after a rejection, the effectful tools are still closed**. Someone might think "the approval flow has ended, so the tools should open" — no. The meaning of rejected is "this plan must not execute", not "the approval is over, do anything you like". To do work, the teammate must `submit_plan` again.

### Three Constraints on review_plan

```text
1. It accepts only a plan request that is still pending
   -> A request that was already approved or rejected cannot be overturned

2. A shutdown request id cannot be used for a plan approval
   -> The kinds must pair

3. The response goes only to the sender of the original request
   -> The approval of alice's plan cannot be sent to bob
```

These three constraints are not implemented by `review_plan` itself — they are the natural result of the six conditions in "Hard Rule Two: The Response Must Match Completely". One validation logic covers both protocols. No special check needs writing for plan approval.

---

## plan_gate: A Prompt Cannot Grant Execution Permission

### Why a Prompt Alone Cannot Do It

First, make clear why this road does not work:

```text
❌ system prompt: "You must submit a plan first and wait for approval before you can modify files."
```

The force of this sentence depends entirely on the model's willingness to cooperate. It fails in three situations:

1. **The model forgets.** After the context grows long and gets compacted, this constraint may fall outside the effective attention range.
2. **The model misjudges.** It may think "reading a file is not a modification", and then run `Remove-Item` inside `shell`.
3. **Someone bypasses it.** If external content (a file it read, a web page) mixes into the teammate's prompt, that content can try to override this constraint.

A security boundary cannot stand on "hoping the other side cooperates".

### The Plan Gate Is a Real PermissionRule

```typescript
this.#planGateRule = new PermissionRule({
  name: "plan-approval-gate",
  behavior: "deny",
  reason: "Effectful teammate tools require the latest submitted plan to be approved",
  matches: (request) => this.#requiresPlanApproval(request),
});
```

Through the public composition entry point, it is appended **only** to the teammate policy:

```typescript
// bootstrap.ts:166-169
const teammatePermissionPolicy =
  dependencies.protocolRuntime === undefined || basePermissionPolicy === undefined
    ? basePermissionPolicy
    : basePermissionPolicy.withRules([dependencies.protocolRuntime.planGateRule]);
```

Note that `withRules()` **returns a new object**. It does not modify the original policy. The first line of the `gate` experiment verifies exactly this:

```text
withRules returns a new object = true
```

Why care about this? The Lead uses `basePermissionPolicy`. If `withRules` modified the object in place, the Lead's policy would be polluted along the way — the Lead never submits a plan, so its `latestPlanRequest` is always undefined, and that would instead let all the Lead's tools pass... until one day the logic changes, and the Lead's tools are collectively blocked by its own teammates' plan states. An immutable policy object removes this kind of coupling at the root.

`withRules()` keeps the original policy's `ApprovalProvider` and `AuditSink`. The final decision order is still:

```text
Argument validation -> PreToolUse -> PermissionPolicy -> dispatcher/handler -> PostToolUse
                              ▲
                              └─ The plan gate is here, at the same level as the workspace boundary
```

That is: the deny of the plan gate and the deny for "a path outside the workspace" happen at the same position: **before the handler and before the background submission**. The tool does not execute at all.

### Six Gating Rules

```typescript
// The #requiresPlanApproval at protocol.ts:382-393, split into three lines so the three exemptions are clear
if (definition.effect === "read") return false;          // Exemption 1
if (definition.name === "send_message") return false;    // Exemption 2
if (definition.name === "submit_plan") return false;     // Exemption 3
return !(await this.planAllowsEffectful(request.context.identity));
```

```typescript
// The planAllowsEffectful at protocol.ts:222-226 (the canonicalAgentName normalisation is omitted)
const latest = await latestPlanRequest(identity);
return latest === undefined || latest.status === Approved;
```

Translated into rules:

| # | Rule | Reason |
|---|---|---|
| 1 | Never submitted a plan → everything passes | The runtime cannot demand an approval flow for every task out of thin air. Some work needs no plan at all |
| 2 | The latest plan is pending or rejected → effectful tools are denied | This is the core of the gate |
| 3 | `read`-class tools always pass | A teammate must see the code before it can write a plan |
| 4 | `send_message` always passes | Otherwise a teammate cannot say "I am stuck" |
| 5 | `submit_plan` always passes | Otherwise, after a rejection, it can never submit a new plan — a deadlock |
| 6 | The latest plan is approved → execute under the original permissions | Approval lets it work, but it only restores the original permissions |

Rules 4 and 5 **prevent a deadlock**. Remove either one, and a rejected teammate cannot move at all.

Some readers may find rule 1 too loose. Its alternative is "without a submitted plan, nothing may run". But then a teammate could not even read files (although read is exempted). More importantly — the first task given at `spawn` time may be only "look at the README and tell me what it says". Forcing such a task through an approval flow only adds round trips.

### Measured: Four Tools, Three States

The `gate` experiment built four representative tools (their effects match the real teammate tool surface) and measured once at each of three time points:

```text
===== gate =====
withRules returns a new object = true

(1) The teammate never submitted a plan: latestPlanRequest = undefined
    planAllowsEffectful = true
    read_file     -> allow source=default
    write_file    -> allow source=default
    send_message  -> allow source=default
    submit_plan   -> allow source=default

(2) The plan was just submitted, not yet approved: status = pending
    planAllowsEffectful = false
    read_file     -> allow source=default
    write_file    -> deny  source=plan-approval-gate
    send_message  -> allow source=default
    submit_plan   -> allow source=default

(3) When reviewPlan returns, the state has not changed yet: status = pending

(3') After the teammate worker consumed the response: status = approved
    planAllowsEffectful = true
    read_file     -> allow source=default
    write_file    -> allow source=default
    send_message  -> allow source=default
    submit_plan   -> allow source=default
```

Look at group (2): only `write_file` was denied, and its `source` clearly says `plan-approval-gate`. The other three pass as usual. They correspond exactly to exemptions 1, 2 and 3.

The difference between (3) and (3') also confirms the mechanism in "The Lead Side: Write the History First, Then Consume the State": when `reviewPlan` returns, the state is still pending, because it is responsible only for **delivering the response**. The real migration happens when the teammate worker consumes that response.

### Approval Does Not Mean a Privilege Escalation

This point must be stated clearly:

```text
The plan gate only adds restrictions. It relaxes no boundary.
```

Take a concrete example. Suppose `write_file` needs a terminal ASK (human confirmation) in the original policy. After the plan is approved:

- The plan gate no longer denies it ✅
- But the terminal ASK **still pops up** ✅
- The audit records as usual ✅

The effect of approval is "remove the plan gate layer" and return to the original permission state. It is not "unobstructed from now on".

### A New Plan Submitted after an Approval

```text
Plan A approved -> effectful tools pass
       |
       v
The teammate submits plan B -> B becomes the latest plan, status = pending
       |
       v
Effectful tools are denied again  ←←← Note this
```

Why? Because the "latest plan" is B, and B is not approved yet. The teammate itself said "I want to change the approach", so it must go through the approval flow again.

This behavior occasionally surprises people, but it is correct. The reverse design (one approval valid forever) would mean a teammate could first submit a harmless plan, trick its way to an approval, and then submit what it really wants to do — the approval would become decoration.

---

## idle Does Not Mean Polling

In many multi-Agent tutorials, the teammate main loop looks like this:

```python
# ❌ A common but poor form
while True:
    msg = inbox.check()
    if msg: handle(msg)
    time.sleep(1)
```

Three problems:

1. **It occupies a thread/task for a long time.** Ten teammates mean ten idling loops.
2. **Shutdown is hard to manage.** You must give every loop an exit flag, and you must wait for it to wake before it can exit — one second slower in the worst case.
3. **It pulls the next chapter's material forward.** Actively "looking for work" is the self-driven scheduling content of Chapter 17. Stuffing it in here blurs the boundary between the two chapters.

P16 takes the event-driven approach:

```text
The teammate finishes processing a batch of messages
  -> status = idle, the worker task ends
  -> But the Runner and the history stay in memory
  -> No daemon, no idling task, no real sleep

After a new message (plain or protocol) is persisted
  -> TeammateRuntime finds status === idle
  -> setStatus(running) + start a managed worker through the shared JobSupervisor
  -> Reuse the original Runner and continue from the original history
```

In the code, these are the two branches (one copy in `send` and one in `deliverProtocol`):

```typescript
// teammates.ts:344-348
if (worker !== undefined && worker.teammate.status === TeammateStatus.Idle) {
  // idle only indicates the worker finished this cycle; on new messages, reuse the existing Runner and re-fetch mailbox.
  this.#setStatus(worker, TeammateStatus.Running);
  this.#startWorker(worker);
}
```

One practical note: **writing to the store directly does not wake an idle worker**. The wake logic lives in the runtime's `send` / `deliverProtocol`, not in the store. The `quarantine` experiment hit exactly this — it bypassed the runtime and placed a bad message into ready, and it had to send one more normal message before the worker woke up.

This is not a bug. The store is a pure persistence layer. It should not know that workers exist. In a real scenario, every write passes through the runtime, so no problem appears.

### The Lead Side Still Uses the Chapter 15 Boundaries

```text
The Lead's plain Mailbox events -> the explicit run_events() boundary (already in P15)
Cron wakeups           -> already in P14; a different matter from the Mailbox protocol
What P16 adds               -> No "an idle Lead looks for work by itself"
```

A Cron wakeup and the Mailbox protocol are easy to confuse, but they solve different problems: Cron says "the time has come, do the work". The Mailbox says "someone sent you a message". The first is time-driven. The second is message-driven.

---

## The Composition Root: One Mailbox, Two Persistent States

### They Must Share the Same Store Object

The CLI constructs only **one** `FileMailboxStore`. TeammateRuntime and ProtocolRuntime share it:

```typescript
const mailbox = new FileMailboxStore(workspace);

const teammates = new TeammateRuntime({
  store: mailbox,              // ← The same object
  inbox: eventInbox,
  supervisor,
  cronRuntime,
});

const protocol = new ProtocolRuntime({
  store: new JsonProtocolStore(workspace),   // The protocol state is another store
  team: teammates,
});

teammates.configureProtocol(protocol);       // Two-way binding
```

What happens without sharing? Two store instances each hold their own in-process lock, and they point at the same files. One instance may write a protocol message and the other may read it, and the atomicity guarantee in between breaks.

So the bootstrap has one explicit check:

```typescript
// bootstrap.ts:125-133
// The protocol and teammates must share the same TeammateRuntime and MailboxStore, or requests and deliveries write to different states.
if (
  dependencies.protocolRuntime !== undefined &&
  (dependencies.teammateRuntime === undefined ||
    dependencies.protocolRuntime.teamRuntime !== dependencies.teammateRuntime ||
    dependencies.protocolRuntime.mailboxStore !== dependencies.teammateRuntime.mailboxStore)
) {
  throw new Error("protocolRuntime must share the teammate runtime and mailbox store");
}
```

Note that it uses `!==` (reference inequality). It does not compare path strings. Two different instances that point at the same directory are also rejected.

### Four Pairing Checks

| Check | Trigger condition | Error |
|---|---|---|
| P16 must have a protocolRuntime | `capabilities.has("protocol")` and none was passed | `protocolRuntime is required for chapter 16 or later` |
| P15 must not receive a protocolRuntime | It was passed without the protocol capability | `protocolRuntime requires chapter 16 or later` |
| Must share the TeammateRuntime | The references differ | `must share the teammate runtime` |
| Must share the MailboxStore | The references differ | Same as above |

The first two checks are **two-way**: passing too little reports an error, and passing too much also reports an error. This pattern appears again and again in the earlier chapters — a capability bit and its dependency must pair strictly, and "passed but unused" is not allowed. Because "passed but unused" means someone believes a feature is in effect, while in fact it is not.

The `tools` experiment verified the first check:

```text
[2] What happens when protocolRuntime is missing:
    Error: protocolRuntime is required for chapter 16 or later
```

### P16 = P15 + Two Capability Bits

```typescript
// profiles.ts:245-249
// P16 appends protocol capability to P15 without altering schema or tool set of normal P15 Mailbox.
export const P16: ChapterProfile = Object.freeze({
  chapter: 16,
  capabilities: new CapabilitySet([...P15.capabilities, "protocol", "plan_gate"]),
});
```

The first segment of the `tools` experiment verifies exactly this delta:

```text
[1] The capability bit difference:
    Does P15 have protocol = false / plan_gate = false
    Does P16 have protocol = true / plan_gate = true
```

`Object.freeze` + spreading the P15 capabilities means P16 cannot "miss" any P15 capability. Everything from the previous chapter is inherited. The set only grows. It never shrinks.

### The Assembly Order

Only after all the construction checks pass does the bootstrap do three things:

```typescript
// 1. Register the two protocol tools for the Lead (the order is fixed; append at the end)
const [requestShutdownTool, reviewPlanTool] = protocolRuntime.leadToolDefinitions;
tools.register(requestShutdownTool);
tools.register(reviewPlanTool);

// 2. Bind in both directions and validate the shared dependencies
teammateRuntime.configureProtocol(protocolRuntime);

// 3. In the teammate factory, append submit_plan + attach the plan gate policy
teammateRuntime.configureRunnerFactory((name, role, sendDefinition) => {
  const teammateTools = standardTools.tools.subset(["shell", "read_file", "write_file"]);
  teammateTools.register(sendDefinition);
  teammateTools.register(protocolRuntime.submitPlanToolDefinition);
  return new AgentRunner({
    /* ... */
    permissionPolicy: teammatePermissionPolicy,   // ← The copy with the plan gate
    identity: name,                               // ← The plan gate uses it to distinguish teammates
  });
});
```

In step 3, `identity: name` is a detail that is easy to overlook, but it is required. The plan gate's `#requiresPlanApproval` uses `request.context.identity` to look up "the latest plan of this teammate". If the identity is unset or set wrongly, alice's plan state would gate bob's tools.

`subset(["shell", "read_file", "write_file"])` is an **allowlist** cut, not a blocklist. When a new tool is added for the Lead later, a teammate does not receive it automatically — this direction is correct. A new tool is not delegated by default.

---

## Run Chapter 16

This section starts from zero and runs step by step. **Steps 0 to 3 need no API key**. Get the baseline running first, then configure the credentials.

### Step 0: Confirm the Environment

```powershell
node --version
npm --version
```

Node must be 22 or later. Measured in this article:

```text
v25.7.0
```

If the version is below 22, `npm run build` or `tsx` fails because the syntax is not supported.

### Step 1: Enter the Code Directory

```powershell
Set-Location 'F:\笔记\Agent实操\code'
```

Run every later command in this directory. Confirm that the position is right:

```powershell
Test-Path package.json
```

It should print `True`.

### Step 2: Install the Dependencies

```powershell
npm install
```

You need to do this only once. If you ran the earlier chapters before, skip this step.

### Step 3: Run the Tests First and Confirm that the Baseline Is Good

```powershell
npm run test:ch16
```

Expected output (measured in this article):

```text
 Test Files  49 passed (49)
      Tests  349 passed (349)
   Duration  5.45s
```

These two lines will appear inside the output. **This is normal**:

```text
Runtime Failure: CLI execution or cleanup failed
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

The entry test deliberately verifies "with no credentials configured, the CLI reports a clear error". This is expected behavior under assertion. Your environment has no problem.

One more known occasional failure exists: on the first run on Windows, `ch16-runtime.test.ts` may report this once:

```text
Error: ENOENT: no such file or directory, lstat '...\.agent_tutorial\.mailboxes.lock'
```

This is a race between temporary-directory cleanup and file-lock release. Run it once more and it passes. In my measurement, the first run failed and the second run passed all 349 tests. It does not stop you from continuing, but it is a known rough edge of this test suite on Windows.

### Step 4: Configure the Model Credentials

Create a `.env` file under `F:\笔记\Agent实操\code`:

```powershell
New-Item -ItemType File -Path .env -Force
```

Write three lines (replace them with your own):

```text
OPENAI_BASE_URL=https://your-endpoint/v1
OPENAI_API_KEY=sk-xxxxxxxx
OPENAI_MODEL=your-model-name
```

All three are required. If one is missing, you get the error line that Step 3 showed.

### Step 5: Run It for Real

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch16 -- --prompt "Create a writer teammate, let her first submit a plan to modify the README, execute after approval, and shut down gracefully"
```

This prompt is designed on purpose. It triggers all four protocol message kinds in this chapter, in order:

```text
spawn_teammate       -> Create the teammate
(teammate) submit_plan   -> plan_approval_request
review_plan          -> plan_approval_response
request_shutdown     -> shutdown_request
(teammate) automatic response       -> shutdown_response
```

### What You Should See

The exact wording depends on the model, but these events should all appear:

- The Lead calls `spawn_teammate` and receives a "created, does not wait for completion" return;
- The teammate's plan returns to the Lead in the form of a `plan_approval_request`;
- The Lead calls `review_plan`, and `approve` is `true`;
- The teammate continues to execute and hands back a result;
- The Lead calls `request_shutdown`, and then receives a response with `approved: true`.

If the model skips `review_plan` and lets the teammate work directly, you will see the teammate's `write_file` denied, with `plan-approval-gate` in the reason — **this proves that the gate really works**.

### Step 6: Look at What the Disk Kept

```powershell
Get-ChildItem -Recurse .agent_tutorial | Select-Object FullName
```

The two key places:

```text
.agent_tutorial\protocol\state.json          ← The protocol state truth
.agent_tutorial\mailboxes\<name>\{ready,processing,done,quarantine}\  ← The message transport
```

Look at the state file directly:

```powershell
Get-Content .agent_tutorial\protocol\state.json | ConvertFrom-Json | ConvertTo-Json -Depth 5
```

Compare it with the JSON in "ProtocolRequest: The Persistent Request Is the State Truth". You should recognise every field. Look closely at two places:

- The `status` of every request, and in the `resolution` of a final-state request, who resolved it and whether it was approved;
- The order of the `requests` array — it is the creation order.

### Step 7: Run It Once More and Watch the Recovery

```powershell
npm run ch16 -- --prompt "Look at which requests the protocol state holds"
```

Because `state.json` is persistent, the requests from the previous run are still there. This step lets you feel directly that "the protocol state does not disappear with the process".

To start again from a clean state:

```powershell
Remove-Item -Recurse -Force .agent_tutorial
```

⚠️ This command deletes all teammate messages, protocol state, background tasks and Cron records. Confirm that the directory holds nothing you need before you run it.

### The Generic Entry Point

Besides the fixed chapter entry point `npm run ch16`, a generic entry point exists:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 16 --prompt "Create a writer teammate, let her first submit a plan to modify the README, execute after approval, and shut down gracefully"
```

The two entry points share the same assembly and the same transport. Only the command-line form differs. `ch16-entry.test.ts` asserts this.

### The Wakeup Loop: Protocol Messages and Cron Both Connect to the Runner

After it constructs the Runner, the current CLI binds both `teammateRuntime.bindWakeup(...)` and `cronRuntime.bindWakeup(...)`. After a teammate protocol message reaches the Lead, it requests a separate event turn. Cron still triggers by time. The run lock of the same Runner serialises both.

If you assemble the runtime by hand in your own host, you must also keep the Teammate wakeup binding. Otherwise a message persists, but it can only wait for the next `run_events()` or a restart recovery.

### Troubleshooting Common Errors

| Error | Cause | How to solve it |
|---|---|---|
| `Missing required settings: OPENAI_BASE_URL, ...` | No `.env` was created, or a field is missing | Return to Step 4. All three lines must exist |
| `protocolRuntime is required for chapter 16 or later` | You built a runtime yourself and forgot to pass `protocolRuntime` | Follow the form in "The Composition Root: One Mailbox, Two Persistent States" |
| `protocolRuntime must share the teammate runtime and mailbox store` | You created two `FileMailboxStore` instances | Create only one. Pass the same object in both places |
| `ProtocolStateError: Unknown or unavailable teammate: alice` | `submit_plan` was called before the teammate was spawned | Spawn first. Submit the plan after the first result returns |
| `ProtocolDeliveryError: Protocol message could not be delivered` | The target teammate already failed / shut down, or a disk fault | Check the teammate state. The pending request is kept, and you can diagnose it |
| `ProtocolNotFoundError: Protocol request does not exist` | A wrong `request_id` was used | Take the exact id from `state.json` |
| `ProtocolExpiredError: Protocol request has expired` | The response came after more than 5 minutes | Submit a new request. The old request stays pending |
| `ProtocolStorageError: Protocol state is invalid` | You broke `state.json` by editing it by hand | Fix it against the fields in "ProtocolRequest: The Persistent Request Is the State Truth", or delete the whole `protocol/` directory and start again |
| `write_file` denied, with `plan-approval-gate` in the reason | The latest plan is pending or rejected | This is **normal behavior**. Approve it with `review_plan` first |
| `ENOENT: ... .mailboxes.lock` (occasional, in tests) | A Windows temporary-directory cleanup race | Run `npm run test:ch16` again |
| `AgentRunner is closed` | A run was called after `close()` | Check the close order: Teammate -> Cron -> JobSupervisor |

---

## 14 Hands-On Experiments

You do not need to take my word for any earlier conclusion. This section turns all of them into output that you can produce on your own machine.

**No experiment needs an API key**, because they use a scripted fake model.

### Preparation: Build a Probe Script First

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType File -Path scripts\probe-ch16.mts
```

Write the block below into `scripts/probe-ch16.mts`. This is the shared header for all experiments. Write it only once:

```typescript
// scripts/probe-ch16.mts —— Chapter 16 probe script (temporary; delete it after the run)
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMailboxStore } from "../chapters/ch16/src/adapters/mailbox-json.ts";
import { JsonProtocolStore } from "../chapters/ch16/src/adapters/protocol-json.ts";
import { JsonBackgroundJobStore } from "../chapters/ch16/src/adapters/background-json.ts";
import { JsonCronStore } from "../chapters/ch16/src/adapters/cron-json.ts";
import { EventInbox } from "../chapters/ch16/src/core/events.ts";
import { AgentRunner } from "../chapters/ch16/src/core/loop.ts";
import { assistantMessage } from "../chapters/ch16/src/core/messages.ts";
import {
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from "../chapters/ch16/src/core/permissions.ts";
import { ToolRegistry, toolSuccess } from "../chapters/ch16/src/core/tools.ts";
import { JobSupervisor } from "../chapters/ch16/src/features/background.ts";
import { CronRuntime } from "../chapters/ch16/src/features/cron.ts";
import {
  MailboxMessageKind,
  ProtocolMessageKind,
  createProtocolMailboxMessage,
  isProtocolMailboxMessage,
} from "../chapters/ch16/src/features/mailbox.ts";
import {
  ProtocolRequestKind,
  ProtocolRequestStatus,
  ProtocolRuntime,
} from "../chapters/ch16/src/features/protocol.ts";
import { TeammateRuntime, TeammateStatus } from "../chapters/ch16/src/features/teammates.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ch16-probe-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Poll until a condition holds, at most 5 seconds; required for the async experiments
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Make the UUIDs predictable, so the output can be compared
function seqId(start = 0x801): () => string {
  let next = start;
  return () => {
    const hex = (next++).toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${hex}`;
  };
}

const EXPERIMENT = process.argv[2] ?? "all";
function section(name: string): boolean {
  const hit = EXPERIMENT === "all" || EXPERIMENT === name;
  if (hit) console.log(`\n===== ${name} =====`);
  return hit;
}

// A scripted fake model: returns preset replies in order and records every request it receives
class ScriptModel {
  requests: any[] = [];
  #replies: string[];
  constructor(...replies: string[]) { this.#replies = [...replies]; }
  async complete(request: any) {
    this.requests.push(request);
    const text = this.#replies.shift();
    if (text === undefined) throw new Error("unexpected model request");
    return Object.freeze({ message: assistantMessage(text), finishReason: "stop" });
  }
}

// Print the directory tree; mark an empty directory with (empty)
async function tree(dir: string, prefix = ""): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) { console.log(`${prefix}(empty)`); return; }
  for (const entry of entries) {
    console.log(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory()) await tree(join(dir, entry.name), `${prefix}  `);
  }
}

// Complete assembly: one EventInbox, one Mailbox; Cron/Teammate/Protocol all share
function makeRuntime(root: string, model: ScriptModel, options: {
  readonly protocolStore?: any;
  readonly mailboxStore?: any;
} = {}) {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root), inbox, supervisor,
    clock: { now: () => new Date("2026-07-30T08:00:00.000Z") },
  });
  const mailbox = options.mailboxStore ?? new FileMailboxStore(root);
  const teammates = new TeammateRuntime({ store: mailbox, inbox, supervisor, cronRuntime: cron });
  const protocol = new ProtocolRuntime({
    store: options.protocolStore ?? new JsonProtocolStore(root),
    team: teammates,
  });
  // The protocol layer and the teammate layer must be the same host object; configureProtocol validates this
  teammates.configureProtocol(protocol);
  // The teammate Runner receives only send_message + submit_plan, matching the composition root cut
  teammates.configureRunnerFactory((name, role, send) => {
    const tools = new ToolRegistry();
    tools.register(send);
    tools.register(protocol.submitPlanToolDefinition);
    return new AgentRunner({
      model, tools, systemPrompt: `You are ${name}, serving as ${role}.`,
      workspace: root, identity: name,
    });
  });
  return { inbox, supervisor, cron, mailbox, teammates, protocol };
}

async function closeRuntime(runtime: any): Promise<void> {
  await runtime.teammates.close();
  await runtime.cron.close();
  await runtime.supervisor.close();
}

// Read the raw text of state.json
async function readState(root: string): Promise<string> {
  return await readFile(join(root, ".agent_tutorial", "protocol", "state.json"), "utf8");
}

// Chinese characters occupy two columns; pad with spaces by display width so the output aligns
function width(text: string): number {
  let total = 0;
  for (const char of text) total += /[　-鿿＀-｠]/.test(char) ? 2 : 1;
  return total;
}
function pad(text: string, columns: number): string {
  return text + " ".repeat(Math.max(1, columns - width(text)));
}

// Print the key fields of a request, so a whole JSON block does not drown the point
function showRequest(label: string, request: any): void {
  const indent = " ".repeat(width(label));
  console.log(`${label} id=${request.id}`);
  console.log(`${indent} kind=${request.kind} status=${request.status}` +
    ` sender=${request.sender} target=${request.target}`);
  if (request.resolution !== null) {
    console.log(`${indent} resolution.messageId=${request.resolution.messageId}` +
      ` approved=${request.resolution.approved}`);
  }
}

function errorLine(error: unknown): string {
  const code = error instanceof Error ? Reflect.get(error, "errorCode") : undefined;
  const name = error instanceof Error ? error.name : "unknown";
  return `${name}${code === undefined ? "" : `(${code})`}: ${
    error instanceof Error ? error.message : String(error)}`;
}
```

Four places in the header deserve an explanation:

**`makeRuntime`** is a minimal replica of this chapter's composition root. It shows the sharing relation from "The Composition Root: One Mailbox, Two Persistent States": one `EventInbox`, one `FileMailboxStore`, `configureProtocol` binds in both directions, and the teammate factory gives only `send_message + submit_plan`.

**`seqId`** turns the UUIDs into a predictable sequence such as `...0801`, `...0802`. A real runtime uses random UUIDs, and the output cannot be compared. After injection, the ids you see match this article exactly.

**`ScriptModel`** is the fake model. It returns preset replies in order, and it stores every request it receives in the `requests` array — many experiments count the length of this array to prove "the model was not called".

**`width` / `pad`** handle Chinese alignment. `padEnd` counts UTF-16 code units, so one Chinese character counts as 1. In a terminal, a Chinese character occupies two columns. Without this fix, the tables come out crooked.

**How to run**: `npx tsx scripts/probe-ch16.mts <experiment name>`. Each of the 14 experiments below appends one block to the script. Every block carries a `section("name")` switch. They do not interfere with each other.

### Experiment 1 (kinds): Closed Sets and Envelope Validation

Append:

```typescript
// ---------- Experiment 1 (kinds): the closed sets of the protocol and envelope validation ----------
if (section("kinds")) {
  console.log("ProtocolRequestKind   =", JSON.stringify(ProtocolRequestKind));
  console.log("ProtocolRequestStatus =", JSON.stringify(ProtocolRequestStatus));
  console.log("ProtocolMessageKind   =", JSON.stringify(ProtocolMessageKind));
  console.log("\nThe approved validation in createProtocolMailboxMessage:");
  const base = {
    id: "00000000-0000-4000-8000-000000000801",
    sender: "lead", recipient: "alice",
    content: "Graceful shutdown requested.",
    createdAtUtc: new Date("2026-07-30T08:00:00.000Z"),
    requestId: "00000000-0000-4000-8000-000000000901",
  };
  const cases: Array<[string, any, any]> = [
    ["shutdown_request + approved=null", ProtocolMessageKind.ShutdownRequest, null],
    ["shutdown_request + approved=true", ProtocolMessageKind.ShutdownRequest, true],
    ["shutdown_response + approved=true", ProtocolMessageKind.ShutdownResponse, true],
    ["shutdown_response + approved=null", ProtocolMessageKind.ShutdownResponse, null],
    ["plan_approval_response + false", ProtocolMessageKind.PlanApprovalResponse, false],
    ["message (not a protocol kind)", MailboxMessageKind.Message, null],
  ];
  for (const [label, kind, approved] of cases) {
    try {
      const message = createProtocolMailboxMessage({ ...base, kind, approved });
      console.log(`  ${pad(label, 34)}-> accepted kind=${message.kind}`);
    } catch (error) {
      console.log(`  ${pad(label, 34)}-> rejected ${errorLine(error)}`);
    }
  }
  const message = createProtocolMailboxMessage({
    ...base, kind: ProtocolMessageKind.ShutdownRequest, approved: null,
  });
  console.log("\nThe protocol payload (note that kind is protocol, not mailbox):");
  console.log(JSON.stringify(message.toPayload(), null, 2));
  console.log("isProtocolMailboxMessage =", isProtocolMailboxMessage(message));
  console.log("eventId === id            =", message.eventId === message.id);
  console.log("idempotencyKey === id     =", message.idempotencyKey === message.id);
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts kinds
```

The real output:

```text
===== kinds =====
ProtocolRequestKind   = {"Shutdown":"shutdown","PlanApproval":"plan_approval"}
ProtocolRequestStatus = {"Pending":"pending","Approved":"approved","Rejected":"rejected"}
ProtocolMessageKind   = {"ShutdownRequest":"shutdown_request","ShutdownResponse":"shutdown_response","PlanApprovalRequest":"plan_approval_request","PlanApprovalResponse":"plan_approval_response"}

The approved validation in createProtocolMailboxMessage:
  shutdown_request + approved=null  -> accepted kind=shutdown_request
  shutdown_request + approved=true  -> rejected TypeError: Protocol response approved must be a boolean and request approved must be null
  shutdown_response + approved=true -> accepted kind=shutdown_response
  shutdown_response + approved=null -> rejected TypeError: Protocol response approved must be a boolean and request approved must be null
  plan_approval_response + false    -> accepted kind=plan_approval_response
  message (not a protocol kind)     -> rejected TypeError: ProtocolMailboxMessage kind must be a protocol kind

The protocol payload (note that kind is protocol, not mailbox):
{
  "kind": "protocol",
  "message_id": "00000000-0000-4000-8000-000000000801",
  "sender": "lead",
  "recipient": "alice",
  "protocol_kind": "shutdown_request",
  "content": "Graceful shutdown requested.",
  "created_at_utc": "2026-07-30T08:00:00.000Z",
  "request_id": "00000000-0000-4000-8000-000000000901",
  "approved": null
}
isProtocolMailboxMessage = true
eventId === id            = true
idempotencyKey === id     = true
```

**What this verifies:** all three enumerations are closed sets; the `approved` rule is enforced at construction time (a request must carry null, and a response must carry a boolean); a plain message kind cannot serve as a protocol kind; the outer `kind` of the payload is `protocol`, and `protocol_kind` is the concrete action; one object is a message, an event and an idempotency key at the same time.

### Experiment 2 (state): What a Request Looks Like on Disk

Append:

```typescript
// ---------- Experiment 2 (state): what a request looks like on disk ----------
if (section("state")) {
  await withTempDir(async (root) => {
    const store = new JsonProtocolStore(root, {
      idGenerator: seqId(0x901),
      clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const request = await store.createRequest({
      kind: ProtocolRequestKind.PlanApproval,
      sender: "alice", target: "lead", content: "write the config",
    });
    showRequest("createRequest ->", request);
    console.log("createdAtUtc =", request.createdAtUtc.toISOString());
    console.log("expiresAtUtc =", request.expiresAtUtc.toISOString(),
      "(The default TTL is 300000ms = 5 minutes)");
    console.log("\nDisk layout:");
    await tree(join(root, ".agent_tutorial"), "  ");
    console.log("\nThe content of state.json:");
    console.log(await readState(root));
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts state
```

The real output:

```text
===== state =====
createRequest -> id=00000000-0000-4000-8000-000000000901
                 kind=plan_approval status=pending sender=alice target=lead
createdAtUtc = 2026-07-30T08:00:00.000Z
expiresAtUtc = 2026-07-30T08:05:00.000Z (The default TTL is 300000ms = 5 minutes)

Disk layout:
  protocol/
    state.json

The content of state.json:
{
  "version": 1,
  "requests": [
    {
      "id": "00000000-0000-4000-8000-000000000901",
      "kind": "plan_approval",
      "sender": "alice",
      "target": "lead",
      "status": "pending",
      "content": "write the config",
      "created_at_utc": "2026-07-30T08:00:00.000Z",
      "expires_at_utc": "2026-07-30T08:05:00.000Z",
      "resolution": null
    }
  ]
}
```

**What this verifies:** a newly created request is always `pending` with `resolution: null`; `expiresAtUtc - createdAtUtc` is exactly 5 minutes; the disk holds a single `state.json` (not one file per request); the field names are snake_case and the times carry a `Z`; the outermost level has `version: 1`.

A quick variation: change `clock` to `() => new Date()` and run it again. Check whether the TTL is still exactly 5 minutes.

### Experiment 3 (order): Register First, Send Second

Append:

```typescript
// ---------- Experiment 3 (order): register first, send second ----------
if (section("order")) {
  await withTempDir(async (root) => {
    const model = new ScriptModel("initial result");
    const runtime = makeRuntime(root, model, {
      protocolStore: new JsonProtocolStore(root, {
        idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
      }),
    });
    try {
      await runtime.teammates.start();
      await runtime.teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      // Break the delivery: the request is registered, but the message cannot go out
      const original = runtime.teammates.deliverProtocol.bind(runtime.teammates);
      (runtime.teammates as any).deliverProtocol = async () => {
        throw new Error("disk on fire");
      };
      try {
        await runtime.protocol.requestShutdown("alice");
      } catch (error) {
        console.log("requestShutdown threw:", errorLine(error));
      }
      console.log("\nAfter the delivery failed, the request still stays on disk:");
      const all = await runtime.protocol.store.listRequests();
      for (const item of all) showRequest("  ", item);
      console.log("\nstate.json:");
      console.log(await readState(root));
      (runtime.teammates as any).deliverProtocol = original;
    } finally {
      await closeRuntime(runtime);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts order
```

The real output:

```text
===== order =====
requestShutdown threw: ProtocolDeliveryError(protocol_delivery_error): Protocol message could not be delivered

After the delivery failed, the request still stays on disk:
   id=00000000-0000-4000-8000-000000000901
   kind=shutdown status=pending sender=lead target=alice

state.json:
{
  "version": 1,
  "requests": [
    {
      "id": "00000000-0000-4000-8000-000000000901",
      "kind": "shutdown",
      "sender": "lead",
      "target": "alice",
      "status": "pending",
      "content": "Graceful shutdown requested.",
      "created_at_utc": "2026-07-30T08:00:00.000Z",
      "expires_at_utc": "2026-07-30T08:05:00.000Z",
      "resolution": null
    }
  ]
}
```

**What this verifies:** on a delivery failure, the code throws a `ProtocolDeliveryError` with an `errorCode`, not a bare `Error`; the request is **not** rolled back, and the pending record stays complete on disk; `listRequests` can find it. This is the "on a send failure, keep the pending record" rule from "Hard Rule One: Register First, Send Second".

### Experiment 4 (match): All Five Wrong Forms Are Blocked

Append:

```typescript
// ---------- Experiment 4 (match): the response must match completely ----------
if (section("match")) {
  await withTempDir(async (root) => {
    const store = new JsonProtocolStore(root, {
      idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const request = await store.createRequest({
      kind: ProtocolRequestKind.Shutdown,
      sender: "lead", target: "alice", content: "Graceful shutdown requested.",
    });
    const good = {
      id: "00000000-0000-4000-8000-000000000801",
      sender: "alice", recipient: "lead",
      kind: ProtocolMessageKind.ShutdownResponse,
      content: "Ready to shut down.",
      createdAtUtc: new Date("2026-07-30T08:00:01.000Z"),
      requestId: request.id, approved: true,
    };
    const cases: Array<[string, any]> = [
      ["A fully matching shutdown_response", good],
      ["Direction reversed (sender=lead)", { ...good, sender: "lead", recipient: "alice" }],
      ["Wrong recipient (recipient=bob)", { ...good, recipient: "bob" }],
      ["Request id does not exist", { ...good, requestId: "00000000-0000-4000-8000-000000000999" }],
      ["Response kind not paired", { ...good, kind: ProtocolMessageKind.PlanApprovalResponse }],
      ["id is not a canonical UUID", { ...good, requestId: "not-a-uuid" }],
    ];
    for (const [label, input] of cases) {
      try {
        const message = createProtocolMailboxMessage(input);
        const validated = await store.validateResponse(message);
        console.log(`${pad(label, 30)}-> passed status=${validated.status}`);
      } catch (error) {
        console.log(`${pad(label, 30)}-> rejected ${errorLine(error)}`);
      }
    }
    console.log("\nvalidateResponse is read-only; the request is still pending:",
      (await store.getRequest(request.id)).status);
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts match
```

The real output:

```text
===== match =====
A fully matching shutdown_response  -> passed status=pending
Direction reversed (sender=lead)       -> rejected ProtocolMismatchError(protocol_mismatch): Protocol message does not match request
Wrong recipient (recipient=bob)   -> rejected ProtocolMismatchError(protocol_mismatch): Protocol message does not match request
Request id does not exist                -> rejected ProtocolNotFoundError(protocol_not_found): Protocol request does not exist: 00000000-0000-4000-8000-000000000999
Response kind not paired                -> rejected ProtocolMismatchError(protocol_mismatch): Protocol message does not match request
id is not a canonical UUID              -> rejected Error: Mailbox message id must be a canonical UUID
```

```text
validateResponse is read-only; the request is still pending: pending
```

**What this verifies:** the first line "passes" but shows `status=pending` — passing validation does not mean the state changed; a wrong direction, a wrong recipient and a wrong kind all report `protocol_mismatch`; a nonexistent id reports `protocol_not_found` (the error codes differ because the handlings differ: mismatch and not_found both enter quarantine, but the diagnostic information should stay distinct); a non-UUID is blocked by `createProtocolMailboxMessage` at the **construction** stage, and it never reaches the store.

Try it yourself: change `approved` in `good` to `null` and run it again. Check whether it fails at the construction stage.

### Experiment 5 (consume): Migrate Only Once; the Same Response Is Idempotent

Append:

```typescript
// ---------- Experiment 5 (consume): migrate only once; the same response is idempotent ----------
if (section("consume")) {
  await withTempDir(async (root) => {
    const store = new JsonProtocolStore(root, {
      idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const request = await store.createRequest({
      kind: ProtocolRequestKind.Shutdown,
      sender: "lead", target: "alice", content: "Graceful shutdown requested.",
    });
    const response = createProtocolMailboxMessage({
      id: "00000000-0000-4000-8000-000000000801",
      sender: "alice", recipient: "lead",
      kind: ProtocolMessageKind.ShutdownResponse,
      content: "Ready to shut down.",
      createdAtUtc: new Date("2026-07-30T08:00:01.000Z"),
      requestId: request.id, approved: true,
    });
    showRequest("First consume ->", await store.consumeResponse(response));
    showRequest("The same response retried   ->", await store.consumeResponse(response));
    // A different message id: it represents "another response" trying to decide once more
    const other = createProtocolMailboxMessage({
      ...{ id: "00000000-0000-4000-8000-000000000802",
        sender: "alice", recipient: "lead",
        kind: ProtocolMessageKind.ShutdownResponse,
        content: "Ready to shut down.",
        createdAtUtc: new Date("2026-07-30T08:00:02.000Z"),
        requestId: request.id, approved: true },
    });
    try {
      await store.consumeResponse(other);
    } catch (error) {
      console.log("Another response ->", errorLine(error));
    }
    // The body was changed, so it does not count as the same response either
    const tampered = createProtocolMailboxMessage({
      ...response, id: response.id, content: "Ready to shut down!!!",
    });
    try {
      await store.consumeResponse(tampered);
    } catch (error) {
      console.log("Same id, changed content ->", errorLine(error));
    }
    console.log("\nstate.json (the final state carries one single resolution):");
    console.log(await readState(root));
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts consume
```

The real output:

```text
===== consume =====
First consume -> id=00000000-0000-4000-8000-000000000901
                  kind=shutdown status=approved sender=lead target=alice
                  resolution.messageId=00000000-0000-4000-8000-000000000801 approved=true
The same response retried   -> id=00000000-0000-4000-8000-000000000901
                kind=shutdown status=approved sender=lead target=alice
                resolution.messageId=00000000-0000-4000-8000-000000000801 approved=true
Another response -> ProtocolStateError(protocol_state_error): Protocol request is already resolved: 00000000-0000-4000-8000-000000000901
Same id, changed content -> ProtocolStateError(protocol_state_error): Protocol request is already resolved: 00000000-0000-4000-8000-000000000901

state.json (the final state carries one single resolution):
{
  "version": 1,
  "requests": [
    {
      "id": "00000000-0000-4000-8000-000000000901",
      "kind": "shutdown",
      "sender": "lead",
      "target": "alice",
      "status": "approved",
      "content": "Graceful shutdown requested.",
      "created_at_utc": "2026-07-30T08:00:00.000Z",
      "expires_at_utc": "2026-07-30T08:05:00.000Z",
      "resolution": {
        "message_id": "00000000-0000-4000-8000-000000000801",
        "approved": true,
        "content": "Ready to shut down.",
        "resolved_at_utc": "2026-07-30T08:00:00.000Z"
      }
    }
  ]
}
```

**What this verifies:** the same response is consumed twice, and the second consume returns the same result idempotently, with no error; a different message ID is rejected (`protocol_state_error`); the same message ID with a changed body is also rejected — `sameResponse` checks three things: the message ID + approved + content; the disk holds only one `resolution`, and its `message_id` points at the first response.

This experiment, together with experiment 4, explains the statement in "The Lead Side: Write the History First, Then Consume the State": a redelivery after an ack failure is safe, because the idempotency judgement rests on the message ID, not on "whether this request was processed before".

### Experiment 6 (expire): After Expiry, the State Is Still pending

Append:

```typescript
// ---------- Experiment 6 (expire): an expired request cannot advance ----------
if (section("expire")) {
  await withTempDir(async (root) => {
    let now = new Date("2026-07-30T08:00:00.000Z");
    const store = new JsonProtocolStore(root, {
      idGenerator: seqId(0x901), clock: () => now, requestTtlMs: 1_000,
    });
    const request = await store.createRequest({
      kind: ProtocolRequestKind.Shutdown,
      sender: "lead", target: "alice", content: "Graceful shutdown requested.",
    });
    console.log("createdAtUtc =", request.createdAtUtc.toISOString());
    console.log("expiresAtUtc =", request.expiresAtUtc.toISOString(), "(TTL injected as 1000ms)");
    const response = createProtocolMailboxMessage({
      id: "00000000-0000-4000-8000-000000000801",
      sender: "alice", recipient: "lead",
      kind: ProtocolMessageKind.ShutdownResponse,
      content: "Ready to shut down.",
      createdAtUtc: new Date("2026-07-30T08:00:00.500Z"),
      requestId: request.id, approved: true,
    });
    now = new Date("2026-07-30T08:00:00.500Z");
    console.log("\nClock +500ms (not expired):");
    showRequest("  consume ->", await store.consumeResponse(response));
    // Use a new request and let it really expire
    now = new Date("2026-07-30T08:00:01.000Z");
    const second = await store.createRequest({
      kind: ProtocolRequestKind.Shutdown,
      sender: "lead", target: "bob", content: "Graceful shutdown requested.",
    });
    now = new Date("2026-07-30T08:00:02.000Z");
    const late = createProtocolMailboxMessage({
      id: "00000000-0000-4000-8000-000000000802",
      sender: "bob", recipient: "lead",
      kind: ProtocolMessageKind.ShutdownResponse,
      content: "Ready to shut down.",
      createdAtUtc: new Date("2026-07-30T08:00:02.000Z"),
      requestId: second.id, approved: true,
    });
    console.log("\nThe second request responds only after the TTL:");
    try {
      await store.consumeResponse(late);
    } catch (error) {
      console.log("  consume ->", errorLine(error));
    }
    console.log("  The state on disk is still =", (await store.getRequest(second.id)).status);
    console.log("  getPendingRequest ->");
    try {
      await store.getPendingRequest(second.id);
    } catch (error) {
      console.log("   ", errorLine(error));
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts expire
```

The real output:

```text
===== expire =====
createdAtUtc = 2026-07-30T08:00:00.000Z
expiresAtUtc = 2026-07-30T08:00:01.000Z (TTL injected as 1000ms)

Clock +500ms (not expired):
  consume -> id=00000000-0000-4000-8000-000000000901
             kind=shutdown status=approved sender=lead target=alice
             resolution.messageId=00000000-0000-4000-8000-000000000801 approved=true

The second request responds only after the TTL:
  consume -> ProtocolExpiredError(protocol_expired): Protocol request has expired: 00000000-0000-4000-8000-000000000902
  The state on disk is still = pending
  getPendingRequest ->
    ProtocolExpiredError(protocol_expired): Protocol request has expired: 00000000-0000-4000-8000-000000000902
```

**What this verifies:** the TTL can be injected (a test does not need to really wait 5 minutes); inside the window, the consume is normal; after the timeout, the code reports `protocol_expired`; **the state on disk is still `pending`** — expiry is a judgement at read time, and it writes nothing to disk; `getPendingRequest` also fails because of the expiry, so every later path that depends on it cannot obtain this request.

Try it yourself: change the response time of the second request to `08:00:00.999Z` (the last millisecond inside the window) and check whether the consume succeeds. Then change it to `08:00:01.000Z` (exactly the expiry moment) and verify the "closed on the left, open on the right" rule from "ProtocolRequest: The Persistent Request Is the State Truth".

### Experiment 7 (storage): A Bad Snapshot Is Always Rejected

Append:

```typescript
// ---------- Experiment 7 (storage): a bad snapshot and a bad id generator ----------
if (section("storage")) {
  await withTempDir(async (root) => {
    const store = new JsonProtocolStore(root, {
      idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    await store.createRequest({
      kind: ProtocolRequestKind.Shutdown,
      sender: "lead", target: "alice", content: "Graceful shutdown requested.",
    });
    const statePath = join(root, ".agent_tutorial", "protocol", "state.json");
    const original = JSON.parse(await readFile(statePath, "utf8"));
    const broken: Array<[string, unknown]> = [
      ["One extra top-level field", { ...original, extra: true }],
      ["version is not 1", { ...original, version: 2 }],
      ["A request missing one field", { version: 1, requests: [{ id: original.requests[0].id }] }],
      ["A request with one extra field", { version: 1,
        requests: [{ ...original.requests[0], note: "hi" }] }],
      ["pending but carrying a resolution", { version: 1, requests: [{ ...original.requests[0],
        resolution: { message_id: original.requests[0].id, approved: true,
          content: "x", resolved_at_utc: "2026-07-30T08:00:01.000Z" } }] }],
      ["requests is not an array", { version: 1, requests: {} }],
    ];
    for (const [label, content] of broken) {
      await writeFile(statePath, JSON.stringify(content), "utf8");
      try {
        await store.listRequests();
        console.log(`${pad(label, 24)}-> loaded successfully (this should not happen)`);
      } catch (error) {
        console.log(`${pad(label, 24)}-> ${errorLine(error)}`);
      }
    }
    await writeFile(statePath, JSON.stringify(original), "utf8");
    console.log("\nAfter restoring the original snapshot, listRequests =", (await store.listRequests()).length, "in total");
    console.log("\nThe id generator returns a bad value:");
    const badStore = new JsonProtocolStore(root, { idGenerator: () => "nope" });
    try {
      await badStore.createRequest({
        kind: ProtocolRequestKind.Shutdown,
        sender: "lead", target: "alice", content: "Graceful shutdown requested.",
      });
    } catch (error) {
      console.log(" ", errorLine(error));
    }
    console.log("\ngetRequest queried with a non-UUID:");
    try {
      await store.getRequest("not-a-uuid");
    } catch (error) {
      console.log(" ", errorLine(error));
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts storage
```

The real output:

```text
===== storage =====
One extra top-level field          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
version is not 1          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
A request missing one field          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
A request with one extra field          -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid
pending but carrying a resolution -> ProtocolStorageError(protocol_storage_error): Pending protocol request cannot have a resolution
requests is not an array       -> ProtocolStorageError(protocol_storage_error): Protocol state is invalid

After restoring the original snapshot, listRequests = 1 in total

The id generator returns a bad value:
  ProtocolStorageError(protocol_storage_error): Protocol id generator returned an invalid UUID

getRequest queried with a non-UUID:
  ProtocolNotFoundError(protocol_not_found): Protocol request id must be a canonical UUID
```

**What this verifies:** all six bad forms are rejected, including "one extra field" (the effect of `strictObject`); "pending but carrying a resolution" reports a **dedicated** error message, not the generic "state is invalid" — which shows that the invariant checks are written explicitly; after a bad snapshot is rejected, restoring the original file still loads normally (no in-memory cache was polluted); even an injected ID generator is validated; a query with a non-UUID states the reason clearly.

### Experiment 8 (gate): The Plan Gate Really Denies

This experiment is the one most worth running by hand in this chapter. Append:

```typescript
// ---------- Experiment 8 (gate): the plan gate is a real gate, not a hint ----------
if (section("gate")) {
  await withTempDir(async (root) => {
    const model = new ScriptModel("initial result", "plan noted");
    const runtime = makeRuntime(root, model, {
      protocolStore: new JsonProtocolStore(root, {
        idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
      }),
    });
    try {
      await runtime.teammates.start();
      await runtime.teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      // This is how the composition root adds it: append the plan gate only to the teammate policy
      const base = new PermissionPolicy();
      const policy = base.withRules([runtime.protocol.planGateRule]);
      console.log("withRules returns a new object =", policy !== base);
      // Build four representative tools; their effects match the teammate tool surface after the composition root cut
      const tools = new ToolRegistry();
      for (const [name, effect] of [
        ["read_file", "read"], ["write_file", "write"],
        ["send_message", "external"], ["submit_plan", "external"],
      ] as const) {
        tools.register({
          name, description: name, inputSchema: (await import("zod")).z.strictObject({}),
          effect, handler: async () => toolSuccess("ok"),
        });
      }
      async function decide(name: string): Promise<string> {
        const prepared = tools.prepare({ id: "call-1", name, arguments: "{}" });
        const decision = await policy.decide(new PermissionRequest({
          prepared, context: Object.freeze({ workspace: root, identity: "alice" }),
        }));
        return `${decision.behavior.padEnd(5)} source=${decision.source}`;
      }
      const names = ["read_file", "write_file", "send_message", "submit_plan"];
      console.log("\n(1) The teammate never submitted a plan: latestPlanRequest = undefined");
      console.log("    planAllowsEffectful =", await runtime.protocol.planAllowsEffectful("alice"));
      for (const name of names) console.log(`    ${pad(name, 14)}-> ${await decide(name)}`);

      const request = await runtime.protocol.submitPlan("alice", "write the config");
      console.log("\n(2) The plan was just submitted, not yet approved: status =", request.status);
      console.log("    planAllowsEffectful =", await runtime.protocol.planAllowsEffectful("alice"));
      for (const name of names) console.log(`    ${pad(name, 14)}-> ${await decide(name)}`);

      // reviewPlan is responsible only for "delivering the response envelope". The pending -> approved migration happens
      // inside the teammate worker (routeTeammateMessage -> consumeResponse), so wait for it
      await runtime.protocol.reviewPlan(request.id, true);
      console.log("\n(3) When reviewPlan returns, the state has not changed yet: status =",
        (await runtime.protocol.store.getRequest(request.id)).status);
      await waitFor(
        async () =>
          (await runtime.protocol.store.getRequest(request.id)).status !==
          ProtocolRequestStatus.Pending,
        "the worker consumes plan_approval_response",
      );
      console.log("\n(3') After the teammate worker consumed the response: status =",
        (await runtime.protocol.store.getRequest(request.id)).status);
      console.log("    planAllowsEffectful =", await runtime.protocol.planAllowsEffectful("alice"));
      for (const name of names) console.log(`    ${pad(name, 14)}-> ${await decide(name)}`);
    } finally {
      await closeRuntime(runtime);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts gate
```

The real output:

```text
===== gate =====
withRules returns a new object = true

(1) The teammate never submitted a plan: latestPlanRequest = undefined
    planAllowsEffectful = true
    read_file     -> allow source=default
    write_file    -> allow source=default
    send_message  -> allow source=default
    submit_plan   -> allow source=default

(2) The plan was just submitted, not yet approved: status = pending
    planAllowsEffectful = false
    read_file     -> allow source=default
    write_file    -> deny  source=plan-approval-gate
    send_message  -> allow source=default
    submit_plan   -> allow source=default

(3) When reviewPlan returns, the state has not changed yet: status = pending

(3') After the teammate worker consumed the response: status = approved
    planAllowsEffectful = true
    read_file     -> allow source=default
    write_file    -> allow source=default
    send_message  -> allow source=default
    submit_plan   -> allow source=default
```

**What this verifies:**

- `withRules` returns a new object. The original policy is not modified;
- (1) When no plan was ever submitted, everything passes — rule 1;
- (2) While pending, only `write_file` is denied, and its `source` is clearly `plan-approval-gate`;
- (2) `read_file` / `send_message` / `submit_plan` still allow — the three exemptions;
- Between (3) and (3') a `waitFor` is needed, because `reviewPlan` only delivers the response. The migration happens in the teammate worker;
- (3') After approval, `write_file` allows again, and its `source` returns to `default`.

If you delete the `waitFor` in this experiment, you will see (3') print `pending` / `false` / `deny` — that is exactly the other side of "Plan Approval: The State Changes First, the Runner Resumes After": the state that a caller sees does not update out of thin air. It waits until the consumer has really finished processing.

**A common trap:** this experiment must spawn alice first. Otherwise `submitPlan` reports:

```text
ProtocolStateError: Unknown or unavailable teammate: alice
```

Because inside `submitPlan`, the code must deliver the request to a participant that is **registered and able to receive**. The troubleshooting table in "Run Chapter 16" carries this line too.

Try it yourself: change `reviewPlan(request.id, true)` to `false`. Check whether (3') shows `rejected` and `write_file` still `deny`.

### Experiment 9 (shutdown): The Trace of One Complete Graceful Shutdown

This experiment runs the trace from "shutdown: Finish the Work in Hand First, Then Route Deterministically" once more, and it **counts the model calls**. Append:

```typescript
// ---------- Experiment 9 (shutdown): the trace of one complete graceful shutdown ----------
if (section("shutdown")) {
  await withTempDir(async (root) => {
    const model = new ScriptModel("initial result");
    const runtime = makeRuntime(root, model, {
      protocolStore: new JsonProtocolStore(root, {
        idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
      }),
    });
    try {
      await runtime.teammates.start();
      await runtime.teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      const initial = await runtime.teammates.waitForEvents(1);
      console.log("[1] The teammate finished round one; the Lead received a result:",
        JSON.stringify(initial[0]?.toPayload().content));
      console.log("    Model call count =", model.requests.length);
      await runtime.teammates.acknowledgeEvents(initial);
      console.log("    Teammate state =", runtime.teammates.state("alice").status);

      const request = await runtime.protocol.requestShutdown("alice");
      console.log("\n[2] request_shutdown registered the request:");
      showRequest("   ", request);

      const responseEvents = await runtime.teammates.waitForEvents(1);
      const response = responseEvents[0];
      console.log("\n[3] The next event that the Lead received:");
      console.log("    isProtocolMailboxMessage =", isProtocolMailboxMessage(response as any));
      console.log("    payload =", JSON.stringify((response as any).toPayload(), null, 2)
        .split("\n").join("\n    "));
      console.log("    Teammate state =", runtime.teammates.state("alice").status);
      console.log("    Model call count =", model.requests.length, "(The shutdown spent no extra model call)");
      console.log("    Before the ack, the request state =",
        (await runtime.protocol.store.getRequest(request.id)).status);

      await runtime.teammates.acknowledgeEvents(responseEvents);
      console.log("\n[4] After the ack:");
      showRequest("   ", await runtime.protocol.store.getRequest(request.id));
      console.log("\n[5] The Mailbox directory:");
      await tree(join(root, ".agent_tutorial", "mailboxes"), "    ");
    } finally {
      await closeRuntime(runtime);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts shutdown
```

The real output:

```text
===== shutdown =====
[1] The teammate finished round one; the Lead received a result: "initial result"
    Model call count = 1
    Teammate state = idle

[2] request_shutdown registered the request:
    id=00000000-0000-4000-8000-000000000901
    kind=shutdown status=pending sender=lead target=alice

[3] The next event that the Lead received:
    isProtocolMailboxMessage = true
    payload = {
      "kind": "protocol",
      "message_id": "e52a0630-9594-489b-ac26-a6fca66102f9",
      "sender": "alice",
      "recipient": "lead",
      "protocol_kind": "shutdown_response",
      "content": "Ready to shut down.",
      "created_at_utc": "2026-08-30T13:08:20.697Z",
      "request_id": "00000000-0000-4000-8000-000000000901",
      "approved": true
    }
    Teammate state = shutdown
    Model call count = 1 (The shutdown spent no extra model call)
    Before the ack, the request state = pending

[4] After the ack:
    id=00000000-0000-4000-8000-000000000901
    kind=shutdown status=approved sender=lead target=alice
    resolution.messageId=e52a0630-9594-489b-ac26-a6fca66102f9 approved=true

[5] The Mailbox directory:
    alice/
      done/
        51ca6220-cbfe-4867-bd7c-8f192932cf61.json
        f7881f8b-6351-46ab-849d-18bb413f25a7.json
      processing/
        (empty)
      quarantine/
        (empty)
      ready/
        (empty)
    lead/
      done/
        94b62c85-90f3-4b3f-a50d-c243eb747480.json
        e52a0630-9594-489b-ac26-a6fca66102f9.json
      processing/
        (empty)
      quarantine/
        (empty)
      ready/
        (empty)
```

**What this verifies:**

- From [1] to [3], **the model call count is always 1**. The shutdown request takes the deterministic route and does not enter the model — this is the measured evidence for the most important sentence in "shutdown: Finish the Work in Hand First, Then Route Deterministically";
- `payload.kind` is `"protocol"`, not `"mailbox"`. `protocol_kind` is `shutdown_response`, and `approved: true`;
- The `content` is the fixed text that the runtime generates: `"Ready to shut down."`. The model did not write it;
- In [3], before the ack the request is still `pending`. In [4], after the ack it is `approved` — history-before-ack;
- `resolution.messageId` is exactly equal to the `message_id` of the envelope in [3];
- In [5], the `ready` / `processing` / `quarantine` directories on both sides are all empty. All four messages are in `done` — no letter was lost and none is stuck.

`created_at_utc` is the real clock (`2026-08-30T13:08:20.697Z`), so the line you produce will differ from the one above. That is normal. And `id=...0901` is fixed by our `seqId(0x901)`, so that item should match exactly.

Try it yourself: delete the `waitForEvents(1)` after the `spawn` and its `acknowledgeEvents`, and call `requestShutdown` directly. You will see that in [3], the **first** event the Lead receives is still the `result`, and the `shutdown_response` queues behind it — that is "finish the work in hand first".

### Experiment 10 (plan): After Approval, Reuse the Same Runner

Append:

```typescript
// ---------- Experiment 10 (plan): after approval, reuse the same Runner ----------
if (section("plan")) {
  await withTempDir(async (root) => {
    const model = new ScriptModel("initial result", "approved work result");
    const runtime = makeRuntime(root, model, {
      protocolStore: new JsonProtocolStore(root, {
        idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
      }),
    });
    try {
      await runtime.teammates.start();
      await runtime.teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      console.log("[1] After round one, the model call count =", model.requests.length);

      const request = await runtime.protocol.submitPlan("alice", "write the config");
      console.log("\n[2] The teammate submitted a plan:");
      showRequest("   ", request);
      const planEvents = await runtime.teammates.waitForEvents(1);
      console.log("    The Lead side received protocol_kind =",
        (planEvents[0] as any).toPayload().protocol_kind);
      await runtime.teammates.acknowledgeEvents(planEvents);
      console.log("    After the ack, the request state =",
        (await runtime.protocol.store.getRequest(request.id)).status,
        "(An ack in the request direction does not migrate the state)");

      await runtime.protocol.reviewPlan(request.id, true);
      console.log("\n[3] The Lead approved; the teammate woke; wait for it to hand back a result:");
      const resultEvents = await runtime.teammates.waitForEvents(1);
      console.log("    result =", JSON.stringify(resultEvents[0]?.toPayload().content));
      console.log("    Model call count =", model.requests.length);
      console.log("\n[4] The prompt that the second model request received:");
      const last = model.requests.at(-1);
      const lastUser = [...last.messages].reverse().find((m: any) => m.role === "user");
      console.log("   ", JSON.stringify(lastUser?.content));
      console.log("    system =", JSON.stringify(last.messages[0]?.content));
      console.log("    Was round one kept in the history =",
        last.messages.some((m: any) => m.content === "draft"));
      showRequest("\n[5] The final request state ->", await runtime.protocol.store.getRequest(request.id));
      await runtime.teammates.acknowledgeEvents(resultEvents);
    } finally {
      await closeRuntime(runtime);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts plan
```

The real output:

```text
===== plan =====
[1] After round one, the model call count = 1

[2] The teammate submitted a plan:
    id=00000000-0000-4000-8000-000000000901
    kind=plan_approval status=pending sender=alice target=lead
    The Lead side received protocol_kind = plan_approval_request
    After the ack, the request state = pending (An ack in the request direction does not migrate the state)

[3] The Lead approved; the teammate woke; wait for it to hand back a result:
    result = "approved work result"
    Model call count = 2

[4] The prompt that the second model request received:
    "Plan approved (00000000-0000-4000-8000-000000000901). Proceed with the approved plan."
    system = "You are alice, serving as writer."
    Was round one kept in the history = true

[5] The final request state -> id=00000000-0000-4000-8000-000000000901
                 kind=plan_approval status=approved sender=alice target=lead
                 resolution.messageId=0a1073b2-64fc-494f-bca0-cf28f96256b3 approved=true
```

**What this verifies:**

- In [2], `sender=alice target=lead` — the direction of plan approval is **exactly opposite** to shutdown;
- The last line of [2]: after the Lead acks the `plan_approval_request`, the state is **still `pending`**. Acking a request is not responding to it. Only a `plan_approval_response` can migrate the state;
- In [3], the model call count changes from 1 to 2: an approval **really does** spend one more model call (unlike shutdown, which is 1→1);
- The prompt in [4] is deterministic text that the runtime assembles. It carries the request id;
- In [4], `system` is still `"You are alice, serving as writer."`, and "Was round one kept in the history = true" — **the same `AgentRunner`**, not a new one. This is the meaning of "reuse" in "Plan Approval: The State Changes First, the Runner Resumes After";
- In [5], the final state is `approved`, and the `resolution` points at that response envelope.

### Experiment 11 (reject): A Rejection Is Also One Deterministic Migration

Append:

```typescript
// ---------- Experiment 11 (reject): a rejection is also one deterministic migration ----------
if (section("reject")) {
  await withTempDir(async (root) => {
    const model = new ScriptModel("initial result", "revised plan result");
    const runtime = makeRuntime(root, model, {
      protocolStore: new JsonProtocolStore(root, {
        idGenerator: seqId(0x901), clock: () => new Date("2026-07-30T08:00:00.000Z"),
      }),
    });
    try {
      await runtime.teammates.start();
      await runtime.teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      const request = await runtime.protocol.submitPlan("alice", "delete the database");
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      await runtime.protocol.reviewPlan(request.id, false, "Too dangerous, use a different plan");
      const resultEvents = await runtime.teammates.waitForEvents(1);
      console.log("result =", JSON.stringify(resultEvents[0]?.toPayload().content));
      const last = model.requests.at(-1);
      const lastUser = [...last.messages].reverse().find((m: any) => m.role === "user");
      console.log("The prompt the teammate received after the rejection =", JSON.stringify(lastUser?.content));
      showRequest("The final request state ->", await runtime.protocol.store.getRequest(request.id));
      console.log("\nAfter the rejection, planAllowsEffectful =",
        await runtime.protocol.planAllowsEffectful("alice"), "(A rejection does not mean a pass)");
      await runtime.teammates.acknowledgeEvents(resultEvents);
    } finally {
      await closeRuntime(runtime);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts reject
```

The real output:

```text
===== reject =====
result = "revised plan result"
The prompt the teammate received after the rejection = "Plan rejected (00000000-0000-4000-8000-000000000901). Feedback: Too dangerous, use a different plan"
The final request state -> id=00000000-0000-4000-8000-000000000901
            kind=plan_approval status=rejected sender=alice target=lead
            resolution.messageId=daed8edd-f8fe-4e86-b045-c4550edf41b1 approved=false

After the rejection, planAllowsEffectful = false (A rejection does not mean a pass)
```

**What this verifies:**

- A rejection does **not** kill the teammate. It still wakes, still runs one round, and still hands back a result (`"revised plan result"`). The only difference is that sentence in the prompt: `Plan rejected ... Feedback: ...`;
- The third argument of `reviewPlan` (the feedback) enters the prompt exactly as written, with no escaping damage;
- The final state is `rejected`, with `approved=false`;
- **The last line is the most important**: `planAllowsEffectful = false`. After a rejection, the teammate still cannot write files. It can only revise the plan and submit `submit_plan` once more. In "plan_gate: A Prompt Cannot Grant Execution Permission", the judgement in `planAllowsEffectful` is `latest === undefined || latest.status === Approved` — `rejected` satisfies neither condition.

This also explains a design that may confuse you: why does "never submitted a plan" pass, while "submitted but rejected" is blocked? The first case shows that this teammate is not inside the plan approval workflow at all (for example, it is only a read-only retriever). The second case shows that it clearly entered the workflow but received no permission.

### Experiment 12 (quarantine): A Protocol Error Enters Quarantine, and the Teammate Does Not Die

This is the measured case for the "quarantine" row in the failure classification table in "shutdown: Finish the Work in Hand First, Then Route Deterministically". Append:

```typescript
// ---------- Experiment 12 (quarantine): a protocol error enters quarantine, and the teammate does not die ----------
if (section("quarantine")) {
  await withTempDir(async (root) => {
    const model = new ScriptModel("initial result", "second result");
    const mailbox = new FileMailboxStore(root);
    const runtime = makeRuntime(root, model, { mailboxStore: mailbox });
    try {
      await runtime.teammates.start();
      await runtime.teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));

      // Bypass the runtime and place a response directly into alice's ready. Its request_id does not exist at all.
      // This simulates "an external party corrupted the envelope". The protocol layer will judge protocol_not_found.
      await mailbox.sendProtocol(
        "lead", "alice", "approved", ProtocolMessageKind.PlanApprovalResponse,
        { requestId: "00000000-0000-4000-8000-0000000009ff", approved: true },
      );
      // Writing to the store directly does not wake an idle worker. Use a plain message to call it up.
      // The worker takes letters in time order, so it hits the bad envelope first.
      await runtime.teammates.send({ sender: "lead", to: "alice", content: "keep going" });
      const quarantineDir = join(root, ".agent_tutorial", "mailboxes", "alice", "quarantine");
      await waitFor(async () => (await readdir(quarantineDir)).length > 0, "the protocol error enters quarantine");
      console.log("[1] The file count in alice/quarantine =", (await readdir(quarantineDir)).length);
      console.log("    Teammate state =", runtime.teammates.state("alice").status, "(not marked failed)");

      // The teammate is still alive: that plain message is still processed to the end
      const events = await runtime.teammates.waitForEvents(1);
      console.log("\n[2] After the bad envelope was quarantined, a plain message still ran to completion ->",
        JSON.stringify(events[0]?.toPayload().content));
      console.log("    Model call count =", model.requests.length, "(The bad envelope did not enter the model)");
      await runtime.teammates.acknowledgeEvents(events);
      console.log("\n[3] The envelope in quarantine looks like this:");
      const [file] = await readdir(quarantineDir);
      const raw = JSON.parse(await readFile(join(quarantineDir, file!), "utf8"));
      console.log("    ", JSON.stringify(raw).slice(0, 200));
    } finally {
      await closeRuntime(runtime);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts quarantine
```

The real output:

```text
===== quarantine =====
[1] The file count in alice/quarantine = 1
    Teammate state = running (not marked failed)

[2] After the bad envelope was quarantined, a plain message still ran to completion -> "second result"
    Model call count = 2 (The bad envelope did not enter the model)

[3] The envelope in quarantine looks like this:
     {"id":"b933d509-8704-424b-b5c1-76a92eef3a0d","sender":"lead","recipient":"alice","kind":"plan_approval_response","content":"approved","created_at_utc":"2026-08-30T13:12:33.673Z","request_id":"00000000
```

**What this verifies:**

- A response with a nonexistent `request_id` triggers `protocol_not_found`, and the envelope **enters quarantine**;
- The teammate state is `running`, **not `failed`**. A protocol content error means "this letter has a problem", not "this teammate is broken";
- The plain message behind it in [2] still runs to completion and hands back `"second result"` — the bad envelope did not block the queue;
- The model call count is 2 (round one + that plain message). **The bad envelope did not enter the model.** This point matters: protocol validation happens before the model, so a bad protocol wastes no model call, and the model never sees a half protocol state and guesses wildly;
- Quarantine in [3] keeps the **complete original envelope**. The `request_id` string `...09ff` is still there. You can use it to trace who wrote the corruption.

One operational detail here deserves a separate note, because it trips many people: **calling `mailbox.sendProtocol` to write into the store directly does not wake an idle teammate.** The wake logic lives in `TeammateRuntime.send` / `deliverProtocol` (the code in "idle Does Not Mean Polling"). The store layer does not know who is waiting for a letter at all. So this experiment must add one `runtime.teammates.send(...)` to call the worker up. The first time I wrote this experiment, I timed out for 5 seconds at exactly this point.

Try it yourself: change `requestId` to a request id that **really exists**, but change `approved` from `true` to `false`. Check whether it still enters quarantine (it does — `sameResponse` cannot match, so the judgement is `protocol_mismatch`; the quarantine is the same, and the teammate still does not die).

### Experiment 13 (release): A Delivery Failure Must Release. It Must Not Be Swallowed

The "release + mark failed" row in the same table. Append:

```typescript
// ---------- Experiment 13 (release): a delivery failure must release; it must not be swallowed ----------
if (section("release")) {
  await withTempDir(async (root) => {
    const model = new ScriptModel("initial result");
    // Wrap the store in one layer: let only the delivery of "the shutdown_response that the teammate sends back to the Lead" fail,
    // simulating a disk or transport fault. Every other call is forwarded unchanged.
    const real = new FileMailboxStore(root);
    const flaky = {
      send: (...a: any[]) => (real as any).send(...a),
      claim: (...a: any[]) => (real as any).claim(...a),
      ack: (...a: any[]) => (real as any).ack(...a),
      release: (...a: any[]) => (real as any).release(...a),
      quarantine: (...a: any[]) => (real as any).quarantine(...a),
      recoverProcessing: (...a: any[]) => (real as any).recoverProcessing(...a),
      sendProtocol: (...a: any[]) => {
        if (a[3] === ProtocolMessageKind.ShutdownResponse) {
          throw new Error("disk is on fire");
        }
        return (real as any).sendProtocol(...a);
      },
    } as any;
    const runtime = makeRuntime(root, model, { mailboxStore: flaky });
    try {
      await runtime.teammates.start();
      await runtime.teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      await runtime.teammates.acknowledgeEvents(await runtime.teammates.waitForEvents(1));
      const request = await runtime.protocol.requestShutdown("alice");
      await waitFor(
        () => runtime.teammates.state("alice").status === TeammateStatus.Failed,
        "the teammate is marked failed",
      );
      console.log("[1] After the response delivery failed:");
      console.log("    Teammate state =", runtime.teammates.state("alice").status);
      console.log("    Request state =", (await runtime.protocol.store.getRequest(request.id)).status,
        "(not misjudged as approved)");
      const dirs = ["ready", "processing", "quarantine"] as const;
      for (const name of dirs) {
        const files = await readdir(join(root, ".agent_tutorial", "mailboxes", "alice", name));
        console.log(`    alice/${pad(name + ":", 12)}${files.length} files`);
      }
      console.log("\n[2] Conclusion: the request envelope returns to ready (release) and waits for the next redelivery;");
      console.log("    The state machine stays at pending. It would rather retry once than falsely report a completed shutdown.");
    } finally {
      await closeRuntime(runtime);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts release
```

The real output:

```text
===== release =====
[1] After the response delivery failed:
    Teammate state = failed
    Request state = pending (not misjudged as approved)
    alice/ready:      1 file
    alice/processing: 0 files
    alice/quarantine: 0 files

[2] Conclusion: the request envelope returns to ready (release) and waits for the next redelivery;
    The state machine stays at pending. It would rather retry once than falsely report a completed shutdown.
```

**What this verifies:**

- Compare it with experiment 12: **the same teammate, two failures, two handlings**. A protocol content error → quarantine + alive; a delivery/storage fault → release + `failed`;
- The request state stays at `pending`. This is the line this chapter must hold most firmly: **a delivery failure must never let the state machine become `approved`**. Otherwise the Lead would believe the teammate had confirmed the shutdown, while the teammate knows nothing at all;
- `ready` holds 1 file and `processing` holds 0 — that `shutdown_request` was put back by `release`, waiting for the next claim and redelivery. This is the concrete form of "at-least-once";
- `quarantine` holds 0: a fault is not a content error, and it must not enter quarantine. Quarantine should hold only "bad data that a human can go and inspect".

The `flaky` wrapper in this experiment is written as an object literal with explicit forwarding, not as `Object.create(real)`. The reason: `FileMailboxStore` uses `#` private fields internally, and an object created by prototype inheritance does not pass the brand check (it throws `TypeError: Cannot read private member`). I hit this once. Writing it here saves you the same hit.

### Experiment 14 (tools): Where the Tool Surfaces of the Lead and a Teammate Differ

The last experiment returns to the tool-surface comparison in "The Public Delta: Only Three Tools". This time it uses the real composition root, `buildAgent`, directly. Append:

```typescript
// ---------- Experiment 14 (tools): where the tool surfaces of the Lead and a teammate differ ----------
if (section("tools")) {
  await withTempDir(async (root) => {
    const { buildAgent } = await import("../chapters/ch16/src/bootstrap.ts");
    const { P15, P16 } = await import("../chapters/ch16/src/core/profiles.ts");
    const { RecoveryConfig } = await import("../chapters/ch16/src/features/recovery.ts");
    const { JsonTaskStore } = await import("../chapters/ch16/src/adapters/task-json.ts");

    console.log("[1] The capability bit difference:");
    console.log("    Does P15 have protocol =", P15.capabilities.has("protocol"),
      "/ plan_gate =", P15.capabilities.has("plan_gate"));
    console.log("    Does P16 have protocol =", P16.capabilities.has("protocol"),
      "/ plan_gate =", P16.capabilities.has("plan_gate"));

    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root), inbox, supervisor,
      clock: { now: () => new Date("2026-07-30T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root), inbox, supervisor, cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const model = new ScriptModel("lead done", "teammate done");
    const common = {
      workspace: root,
      recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
      taskStore: new JsonTaskStore(root),
      teammateRuntime: teammates,
      model: model as any,
      approvalProvider: { decide: async () => new PermissionDecision("allow", "probe", "probe") },
      auditSink: { record: async () => {} },
    };
    try {
      console.log("\n[2] What happens when protocolRuntime is missing:");
      try { buildAgent(P16, { ...common }); }
      catch (error) { console.log("   ", errorLine(error)); }

      const runner = buildAgent(P16, { ...common, protocolRuntime: protocol });
      await teammates.start();
      await runner.run("inspect");
      const leadTools: string[] = model.requests[0].tools.map((t: any) => t.function.name);
      console.log("\n[3] The tool surface the Lead sees (", leadTools.length, "in total), the last four:");
      console.log("    ", JSON.stringify(leadTools.slice(-4)));
      console.log("    Does the Lead have submit_plan =", leadTools.includes("submit_plan"));

      await teammates.spawn({ name: "alice", role: "writer", prompt: "draft", sender: "lead" });
      const events = await teammates.waitForEvents(1);
      console.log("    The model received", model.requests.length, "requests in total; the tool count of each =",
        JSON.stringify(model.requests.map((r: any) => r.tools?.length ?? 0)),
        "(The 0 one is the compaction summary; it carries no tools)");
      const mateRequest = model.requests.find((r: any) =>
        r.tools?.some((t: any) => t.function.name === "submit_plan"));
      const mateTools: string[] = mateRequest.tools.map((t: any) => t.function.name);
      console.log("\n[4] The tool surface a teammate sees (", mateTools.length, "in total):");
      console.log("    ", JSON.stringify(mateTools));
      console.log("    Does a teammate have request_shutdown =", mateTools.includes("request_shutdown"));
      console.log("    Does a teammate have review_plan =", mateTools.includes("review_plan"));
      await teammates.acknowledgeEvents(events);
      await runner.close();
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch16.mts tools
```

The real output:

```text
===== tools =====
[1] The capability bit difference:
    Does P15 have protocol = false / plan_gate = false
    Does P16 have protocol = true / plan_gate = true

[2] What happens when protocolRuntime is missing:
    Error: protocolRuntime is required for chapter 16 or later

[3] The tool surface the Lead sees (20 in total), the last four:
     ["spawn_teammate","send_message","request_shutdown","review_plan"]
    Does the Lead have submit_plan = false
    The model received 3 requests in total; the tool count of each = [20,0,5] (The 0 one is the compaction summary; it carries no tools)

[4] The tool surface a teammate sees (5 in total):
     ["shell","read_file","write_file","send_message","submit_plan"]
    Does a teammate have request_shutdown = false
    Does a teammate have review_plan = false
```

**What this verifies:**

- [1] P16 is P15 plus two capability bits. Nothing else moved;
- [2] The composition root blocks the half-assembled state "the capability bit is on but the dependency was not given" with an explicit check, and the error text states directly what is missing;
- [3] The Lead has 20 tools. The last four are `spawn_teammate` / `send_message` / `request_shutdown` / `review_plan`. **The Lead has no `submit_plan`** — the Lead applies for a plan to nobody;
- [4] A teammate has 5 tools, **with no `request_shutdown` and no `review_plan`**. A teammate cannot order someone else to shut down, and it cannot approve its own plan. This is what "The Public Delta: Only Three Tools" means by "capabilities are cut by role, not constrained by a prompt";
- Both sides **have `send_message`**: plain collaboration messages are two-way. Only the protocol actions are one-way.

That `[20,0,5]` in [3] deserves a closer look. The middle request has a tool count of 0, because it is the compaction summary request (Chapter 8 content), and it carries no tools. This is also why the script cannot write `model.requests[1].tools`. It must use `find` to locate "the request that contains `submit_plan`". The first time, I hard-coded the index, printed 0 tools, and wasted several minutes on a false investigation.

### Cleanup after the Experiments

This probe script is only a temporary learning file. It is not repository content. Delete it after the run:

```powershell
Remove-Item scripts\probe-ch16.mts
```

Confirm that the workspace is clean:

```powershell
git status --short
```

There should be no output at all. If you changed files under `chapters/ch16/` during the experiments, they will appear here — restore them in the manner of the troubleshooting table in "Run Chapter 16", then run the Step 3 tests once more.

---

## What This Chapter Deliberately Did Not Do

By this point, you can probably guess what could be added next "while we are here". But this chapter stops deliberately at this line, because one more step forward touches the problems that the next chapter solves. The list is stated clearly, so you will not search the code everywhere for these things:

**There is no `request_plan` tool.** The original textbook's Lead tool table listed three tools together: `request_shutdown`, `request_plan` and `review_plan`. We removed `request_plan`, because it has no state migration and no responding party — the Lead says one sentence, "please submit a plan", and whether the teammate complies depends entirely on the model's willingness. That is not a protocol. It is a prompt. What is really needed is the teammate's own `submit_plan` and the Lead's `review_plan`, with both ends landing on the same `ProtocolRequest`. This is the complete reason in the "One Piece of History, Made Clear" passage in "The Public Delta: Only Three Tools".

**There is no polling thread, no daemon, and no `sleep`.** A teammate ends its worker task when the round finishes, and a new message wakes it. "idle Does Not Mean Polling" and experiment 12 both verified this.

**There is no task-board scan, no task stealing, no claim token and no lease.** At present the Lead assigns work point to point, and a teammate does not look for work by itself. This is Chapter 17 content.

**A send failure is not quietly turned into another request.** Experiment 13 verified this: a delivery failure is a failure. The request stays at `pending`, and it is released back to wait for a redelivery. The code does not "help you" by creating a new request to cover it up.

**There is no worktree isolation and no MCP dynamic tool pool.** Teammates share one working directory, and the tool surface is fixed in the composition root.

**There is no promise of global exactly-once.** This point is the easiest to misread, so say it once more: the Mailbox delivers **at-least-once**, and the protocol layer uses the response message ID to make "the state of one request migrates only once". But if a teammate already performed an external effect (side-effect) once before the shutdown response went out (for example, it sent an email), a redelivery will not deduplicate that email for you. Deduplication of an effect (side-effect) is a business-layer matter.

These non-items are not a TODO for "add later". They are part of this chapter's boundary. The smallest closed loop that Chapter 16 must hold has only four phrases: **a fixed team, persistent requests, strict matching, hard gating**.

---

## Differences from Claude Code

With reference to the analysis of the CC source in `s16_team_protocols/README.md` in the external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code), this chapter's implementation differs from the real Claude Code in several places. Separating the two classes of difference — "we simplified" and "we are stricter than the teaching edition" — helps greatly in understanding the design trade-offs.

### Where We Simplified

**The shutdown response has only one message kind.** We complete the handshake with one unified `shutdown_response` carrying `approved: true/false`. The real CC source splits it into two separate messages, `shutdown_approved` and `shutdown_rejected`. After confirmation, it also broadcasts `teammate_terminated` to notify the related parties, cleans up the tmux/iTerm2 panes, releases task claims, and removes the member from the team configuration. Our shutdown only ends the teammate's message loop. The composition root closes the Runner resources in one place.

**The plan approval trigger point is plainer.** We let the teammate call `submit_plan` explicitly. In CC, an approval request is mainly produced automatically by `ExitPlanModeV2Tool` "when a teammate that was asked to use plan mode exits plan mode". `useInboxPoller` writes the approval back automatically and hands the request to the Lead as plain context, while the explicit approve/reject capability stays. A CC approval can also carry a `permissionMode`, for example "approve, but keep running in plan mode". We implement only the three elements: approve / reject / feedback.

**At idle, the Lead is not notified.** In the real CC source, a teammate sends an `idle_notification` when it becomes idle, so the Lead perceives "this person is free". Our teammate enters idle silently. The Lead does not know, until the next assignment.

**The field naming is unified.** Our `ProtocolMailboxMessage` always uses `request_id`. The protocol messages in the real CC source are also structured JSON, validated with Zod, but the naming is not unified: permission messages use `request_id`, while shutdown and plan approval use `requestId`. We trade unified naming for readability. CC kept the real evolution traces of different modules.

### Where We Are Stricter than the Teaching Edition

These lines run in the opposite direction — the CC **teaching edition s16** did not do them. We did:

**The plan gate is a real gate.** The teaching edition s16 only demonstrates the message flow of plan approval. It does not block `shell` or `write_file` while a plan is unapproved. We implemented it as a `PermissionRule`: while a plan is `pending` / `rejected`, an effectful tool is denied before the handler executes (measured in experiment 8). The teammates in the real CC source have complete permission gating, so here we move toward production semantics. We do not exceed CC.

**The protocol state is persistent.** The `ProtocolState` in the teaching edition s16 is an in-process `pending_requests` dictionary. It uses short `req_xxx` IDs and float timestamps, and a process restart loses everything. We write to `.agent_tutorial/protocol/state.json`, with canonical UUIDs, aware UTC, and a `.protocol.lock` that guards cross-process concurrency.

**The delivery semantics are clearer.** The teaching edition keeps the "unlink after reading" consumption form. If the process crashes "after reading, before processing", the message is lost. That is **at-most-once**. We use at-least-once delivery plus protocol-layer idempotency: register first, then send, and keep the `pending` record on a send failure.

One sentence summarises this comparison: **the real CC source is more complete than ours, and the CC teaching edition is looser than ours.** We chose "the smallest strict set that offline tests can assert".

---

## What We Learned from ai-agent-book: The Control Plane and Graceful Termination

Chapter 10 of ai-agent-book faces this chapter's topic almost directly: it splits "multi-Agent collaboration without a shared context" into a **data plane** and a **control plane**. It uses structured envelopes, state acquisition, graceful termination and a task lifecycle to solve the sentence we stated at the opening — the message has been delivered, but the collaboration has not completed. For the description of the companion experiment 10-4, see `chapter10/parallel-web-research/README.md` in the external repository [`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book). For the bus implementation, see `message_bus.py` in the same directory.

### How It Is Designed

First, its two planes:

| Plane | What it carries | What implements it |
|---|---|---|
| Data plane | Product exchange (who wrote which file) | A shared file system |
| Control plane | Message passing, state queries, execution termination, resource scheduling | A message bus |

It emphasises two points in particular. Both are worth copying:

First, **state acquisition should be active reporting, not unbounded polling.** The more natural approach is that a subagent sends a `status_update` itself, or writes into an agreed progress file. The Manager does not ask "are you done yet" once per second.

Second, **execution termination should prefer graceful termination.** The order is `terminate` → the subagent cleans up its resources at a safe point → `ack` → exit. A forced termination serves only as a fallback. You will find that this has the same shape as this chapter's shutdown trace.

Its `message_bus.py` seals every message into an `Envelope`, carrying `sender_id`, `target`, `type`, `payload`, `seq` and `ts`. The message types are `task_assigned`, `status_update`, `result`, `terminate` and `ack`. The `MessageBus` forwards by subscription relation. It supports point-to-point delivery, and it also supports a `BROADCAST="*"` broadcast. `history` keeps the complete message flow, and `short()` prints a compact log with timestamps and global sequence numbers — so the experiment can "see" every collaboration event. This "observability first" orientation follows the same line of thought as our 14 experiments.

Experiment 10-4 lands the control plane on a real parallel search: the Manager starts several homogeneous workers dynamically, and every worker uses a separate Playwright browser context. The first `target_found` settles under an `asyncio.Lock`. **Only one terminate broadcast is allowed.** A later hit is only recorded. It does not settle again. After a loser receives the terminate, it cancels at a safe point, sends an ack, and closes its own browser context. The README uses three things as acceptance evidence: the context creation/close counts, a wall-clock comparison against a serial baseline, and the provenance event flow.

It has one more sentence that I think deserves a separate quotation: **a model may propose "complete", but it cannot approve its own "complete".** A completion conclusion must pass an independent verification or a harness gate. This is exactly the core of our plan gate — a teammate may `submit_plan`, but the approval power sits in the Lead's hands. And it does not rely on a prompt request. It relies on a `PermissionRule` that blocks hard.

The manager-pattern part also warns about two things: the Manager is a single-point bottleneck, and **the plan quality is the ceiling of the whole system**. The A2A protocol further standardises the task lifecycle as submitted / working / needs input / completed / failed, so the two collaborating sides do not guess the task state from free text.

### Our Comparison and Trade-Offs

This chapter did not copy the centralised Message Bus. It landed its control-plane principles on "a fixed topology + a persistent Mailbox + a request/response state machine". Compare them one by one:

| Its approach | This chapter's approach | Why this choice |
|---|---|---|
| A central `MessageBus`, with subscriptions and broadcast | A persistent Mailbox, point to point | Our topology is fixed as the Lead + several peer teammates. It needs no dynamic peer set, so it needs no subscriptions and no `BROADCAST` |
| `Envelope`: `sender_id/target/type/payload` | `ProtocolMailboxMessage`: plus `request_id` and `approved` | The model does not need to guess from free text "which request this reply corresponds to, and whether it was approved" |
| A generic `terminate` / `ack` cancellation | A structured `request_shutdown` close | Finish the current message first, then route deterministically before the model call, return a structured response, and then end the worker |
| `status_update` or a progress file instead of polling | The request itself is persisted as the state truth | We introduce no polling and no reporting. `pending/approved/rejected` is the queryable, recoverable state |
| The Manager plan quality decides the ceiling | The plan gate is a `PermissionRule` | The plan state is not left to the model's memory alone. The gate blocks hard at the real execution boundary |
| The A2A five-state lifecycle | Only two request kinds and three states | Ours is a closed protocol inside one team. It needs no Agent Card, no streaming progress and no cross-organisation discovery |
| A real browser + a real wall-clock as evidence | Injected UUIDs / a UTC clock / a model stand-in; offline and repeatable | We want assertions where "every run gives the same result", not performance numbers |

**What it does and we explicitly do not do:** a central `MessageBus`, subscription filtering, `BROADCAST`, `status_update`, cross-organisation A2A, dynamic peer discovery.

Broadcast and open protocols suit the scenario "the Agent count is not fixed, and autonomous discovery and interoperation are needed". This chapter first holds those four phrases — a fixed team, persistent requests, strict matching, hard gating. In the next chapter, teammates will actively discover and claim work from a shared task board. Only then must we handle "several people want to claim the same thing at the same time".

---

## Companion Code Index

All the code for this chapter lives under `code/chapters/ch16/`. The line counts help you estimate the work — do not panic at 715 lines. More than half of `protocol-json.ts` is error classification and JSON schema validation.

**Files that are new or changed with a focus in this chapter:**

| File | Lines | What this chapter is responsible for |
|---|---|---|
| [src/features/protocol.ts](code/chapters/ch16/src/features/protocol.ts) | 463 | The `ProtocolRequest` domain model, `ProtocolRuntime` (`requestShutdown` / `submitPlan` / `reviewPlan` / `planAllowsEffectful`), `planGateRule` |
| [src/adapters/protocol-json.ts](code/chapters/ch16/src/adapters/protocol-json.ts) | 715 | `JsonProtocolStore`: single-snapshot read/write, two locks, atomic replacement, the strict matching and idempotency of `consumeResponse` |
| [src/features/mailbox.ts](code/chapters/ch16/src/features/mailbox.ts) | 461 | The typed protocol envelope `ProtocolMailboxMessage`, `ProtocolMessageKind`, `isProtocolMailboxMessage` |
| [src/adapters/mailbox-json.ts](code/chapters/ch16/src/adapters/mailbox-json.ts) | 635 | `FileMailboxStore` gains `sendProtocol`; the four-directory semantics of `ready/processing/done/quarantine` |
| [src/features/teammates.ts](code/chapters/ch16/src/features/teammates.ts) | 768 | `deliverProtocol`, the protocol routing (before the model call), the idle wakeup, the failure classification (release / quarantine / failed) |
| [src/core/permissions.ts](code/chapters/ch16/src/core/permissions.ts) | 415 | `PermissionPolicy.withRules()`, `PermissionRule`, the `behavior/reason/source` of `PermissionDecision` |
| [src/bootstrap.ts](code/chapters/ch16/src/bootstrap.ts) | 410 | The composition root: the shared-store validation, the Lead / teammate tool surface cut, the plan gate attached only to the teammate policy |
| [src/core/loop.ts](code/chapters/ch16/src/core/loop.ts) | 714 | The event consumption boundary; why a protocol event does not take the mailbox deferral and half-state branches |
| [src/core/profiles.ts](code/chapters/ch16/src/core/profiles.ts) | 304 | `P16 = P15 + protocol + plan_gate` |
| [src/core/events.ts](code/chapters/ch16/src/core/events.ts) | 77 | The event base class. Reading `toPayload()` is enough |
| [src/cli.ts](code/chapters/ch16/src/cli.ts) | 331 | The argument parsing of the two entry points, the two wakeup bindings and the resource close |
| [src/chapters/ch16.ts](code/chapters/ch16/src/chapters/ch16.ts) | 5 | The fixed chapter entry point. Only 5 lines |

**Tests:**

| File | Lines | What it asserts |
|---|---|---|
| [tests/ch16-protocol.test.ts](code/chapters/ch16/tests/ch16-protocol.test.ts) | 162 | Register before send, strict matching, migrate only once, the expiry judgement, failure on a backwards clock, atomic replacement |
| [tests/ch16-plan-gate.test.ts](code/chapters/ch16/tests/ch16-plan-gate.test.ts) | 63 | While `pending/rejected`, the effectful handler is called zero times. After approval, it recovers |
| [tests/ch16-runtime.test.ts](code/chapters/ch16/tests/ch16-runtime.test.ts) | 264 | The protocol routing does not enter the model, a busy teammate finishes its work first, the three failure classification paths |
| [tests/ch16-bootstrap.test.ts](code/chapters/ch16/tests/ch16-bootstrap.test.ts) | 137 | The P15/P16 capability delta, the shared-store validation, the tool surfaces on both sides exactly equal |
| [tests/ch16-entry.test.ts](code/chapters/ch16/tests/ch16-entry.test.ts) | 28 | The two entry points share the same transport and close all resources |

### The Suggested Order for Reading the Code

Do not start from the 715-line `protocol-json.ts`. Read in this order. Every step can follow the questions from the previous step:

1. **`src/core/profiles.ts`** — First confirm that the delta really is only two capability bits. A dozen lines, one minute.
2. **`src/features/protocol.ts`, the `ProtocolRequest` part** — Nine fields, two state edges. This is the foundation of the whole chapter. Read it thoroughly and everything after it becomes easier.
3. **`src/features/mailbox.ts`, the `ProtocolMailboxMessage`** — Look at `kind: "protocol"` and the construction-time constraint "a request must carry `approved: null`, and a response must carry a boolean".
4. **`src/features/protocol.ts`, `requestShutdown`** — Only a dozen lines, but it demonstrates the hard rule "register first, send second" completely.
5. **`src/adapters/protocol-json.ts`, `consumeResponse`** — Only now look at the five strict-matching conditions and the idempotency judgement. You already know what every condition defends against.
6. **`src/features/teammates.ts`, `deliverProtocol` and the protocol routing** — Focus on two things: the protocol judgement happens **before** the model call; and the three failure classification branches.
7. **`src/features/protocol.ts`, `planGateRule`** — Read it together with `withRules` in `src/core/permissions.ts`. Twenty lines of code.
8. **`src/bootstrap.ts`, lines 119-132 and lines 160-270** — The validation comes first, the assembly after. See clearly why the plan gate hangs only on the teammate side.
9. **`src/core/loop.ts`, lines 636-690** — Read this part last. It explains "why a protocol event does not enjoy the mailbox deferral and half-state treatment". It is a closing detail. Reading it at the start only scatters your attention.

Skip most of `mailbox-json.ts` and `cli.ts` — the first is Chapter 15 content plus one `sendProtocol`. The second is argument parsing.

---

## Run and Verify

Five gates, passed in order. Run all of them under `F:\笔记\Agent实操\code`:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch16
npm run typecheck
npm run lint
npm run format:check
npm run build
```

The results measured on my side:

```text
Test Files  49 passed (49)
      Tests  349 passed (349)
```

`test:ch16` also runs the tests of all earlier chapters, so it is 49 files and 349 tests, not only the 5 ch16 files. This is deliberate — one requirement of Chapter 16 is that it must not break the behavior of P15 and earlier. The rule "the enumeration and serialisation schema of a P15 plain message do not change at all" matters most.

All tests in this chapter inject a fixed UUID, a UTC clock, a model stand-in and fault boundaries. **They do not depend on the real OpenAI, they do not depend on the network, and they contain no real sleep.** So they run fast, and every run gives the same result. If one test fails occasionally on your machine, look first at the `.mailboxes.lock` line in the troubleshooting table in "Run Chapter 16".

The key assertions are all concrete business results, not filler assertions such as "no exception was thrown":

- The P16 capability set is strictly equal to P15 plus `protocol` and `plan_gate` — one more or one fewer counts as a failure;
- The enumeration and serialisation schema of a P15 plain message do not change at all;
- A request is persisted and registered first. On a send failure, the `pending` record is kept;
- An ID collision, a bad state and a failed atomic replacement never overwrite the old bytes;
- The request ID, the kind, both parties, `pending` and the validity period must **all** match;
- At the deadline moment, the request is already expired; several requests on the same clock are judged latest by creation order; a backwards clock fails explicitly;
- With concurrent different responses, only one completes the migration. A retry on the same transport is idempotent, and another message ID is rejected;
- A `pending` / `rejected` plan makes the effectful handler run **zero times**. After approval, the original approval and audit behavior is kept;
- A busy teammate shuts down only after it completes the current message. A protocol request does not enter the model;
- Four faults — ack, cancel, delivery and protocol storage — all keep a recoverable transport. Only an invalid protocol message enters quarantine;
- The tool sets of the P16 Lead and a teammate are exactly equal (20 / 5). The two CLI entry points share the same transport and close all resources.

---

## Chapter Summary

### The Three-Sentence Version

First, the whole value of the protocol layer is that it turns an **implicit convention** into **verifiable state**. If "please shut down" and "the plan is approved" exist only in a chat record, they are only tone. After they are written into a `ProtocolRequest`, they become facts that can be queried, recovered and validated under concurrency.

Second, the state truth must land on disk **before the send**. Register first, then send. On a delivery failure, keep the `pending` record — rather redeliver once than falsely report completion.

Third, a permission must take effect at the **real execution boundary**. The plan gate is a `PermissionRule`, not a "please wait for approval first" sentence in a prompt.

### Seven Lines You Must Remember

1. **Register the request first, then send it.** A canonical UUID, aware UTC, one persistent single snapshot. On a send failure, the state is not rolled back (experiments 2 and 13).
2. **The protocol has its own typed envelope.** `kind: "protocol"`. It does not pollute the schema of a P15 plain message; a request carries `approved: null`, and a response must carry a boolean (experiments 1 and 4).
3. **A response counts only when all six conditions hold.** The request exists, the kinds pair, the sender, the recipient, still `pending`, not expired — if one item is missing, reject it (experiments 4 and 6).
4. **Migrate only once.** Of concurrent responses, only one succeeds. A retry on the same transport is idempotent, and another message ID is rejected (experiment 5).
5. **The Lead writes the history first, then consumes the state, and acks the transport last.** Reverse the order and you get "the state was consumed but the Lead does not know" (experiment 9, [3]/[4]).
6. **shutdown does not enter the model.** Finish the current message first, then route deterministically before the model call. The model call count is 1→1 (experiment 9).
7. **Failures have three classes, not one.** A content error → quarantine, and the teammate lives; a delivery/storage fault → release + `failed`; a cancel/close → release (experiments 12 and 13).

### One Diagram Reviews the Whole Chain

```text
  ① Register                      The Lead's tools                 A teammate's tools
  ────────                    request_shutdown            submit_plan
                              review_plan
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │     ProtocolRuntime    │
                        └────────────┬───────────┘
                                     │  Write the state first, then send the message
                                     ▼
              ┌──────────────────────────────────────────┐
              │  .agent_tutorial/protocol/state.json     │
              │  ProtocolRequest = the state truth       │
              │                                          │
              │      pending ──approve──▶ approved       │
              │            └──reject───▶ rejected        │
              └──────────────────────────────────────────┘
                                     │
  ② Send                             ▼
  ────────      ┌──────────────────────────────────────────┐
                │  .agent_tutorial/mailboxes/<name>/       │
                │  ready ──▶ processing ──▶ done           │
                │                    └────▶ quarantine     │
                │  The envelope kind = "protocol" (not "mailbox") │
                └──────────────────────────────────────────┘
                                     │
  ③ Route                             ▼
  ────────      ┌──────────────────────────────────────────┐
                │  The teammate worker: judge the kind first, then decide whether to ask the model │
                │                                          │
                │  shutdown   ──▶ Do not enter the model; return a structured response    │
                │  plan response  ──▶ The state changes first, then reuse the original Runner │
                │  A plain message   ──▶ Only then hand it to the model                │
                └──────────────────────────────────────────┘
                                     │
  ④ Gate                             ▼
  ────────      ┌──────────────────────────────────────────┐
                │  plan_gate (one PermissionRule)          │
                │                                          │
                │  Never submitted a plan       ──▶ allow  │
                │  The latest plan approved  ──▶ allow     │
                │  pending / rejected ──▶ deny (effectful) │
                │  Exemptions: read / send_message / submit_plan  │
                └──────────────────────────────────────────┘
                                     │
  ⑤ Consume                             ▼
  ────────      ┌──────────────────────────────────────────┐
                │  consumeResponse: migrate only when all six items hold, and only once  │
                │  The Lead-side order: history ──▶ consume ──▶ ack    │
                └──────────────────────────────────────────┘
```

The five numbers are the positions of this chapter's five hard rules: ① register first ② send second ③ route before the model ④ gate at the permission boundary ⑤ strict matching, consume only once.

### Check Whether You Really Understood It

Try to answer without looking at the earlier text. If you cannot answer one, the section is in brackets:

1. What are the nine persistent fields of a `ProtocolRequest`? Why must `resolution` be stored separately, instead of looking only at `status`? (ProtocolRequest)
2. Why is the protocol state **one** `state.json` single snapshot, and not one file per request? (ProtocolRequest)
3. Which two problems do the two locks solve separately? What goes wrong if you keep only one? (ProtocolRequest)
4. Is "the latest plan request" judged by UUID size, by timestamp, or by array order? (ProtocolRequest)
5. In the response window `[created_at_utc, expires_at_utc)`, why is the right side an open interval? (ProtocolRequest; experiment 6)
6. Why does an ack in the request direction not migrate the state, while only a response can migrate it? (Experiment 10, [2])
7. Which three exemptions does the plan gate have? What happens if `send_message` is not exempted? (plan_gate)
8. "Never submitted a plan" passes, and "submitted but rejected" is blocked — what is the reason for this difference? (Experiment 11)
9. Why does a protocol event on the Lead side **not** enjoy the deferral and half-state retention of a mailbox event? (The Lead Side)
10. Why does `shutdown` not enter the model, while a `plan_approval_response` spends one more model call? (shutdown; Plan Approval)
11. If you write a message directly into the store, can it wake an idle teammate? Why? (idle Does Not Mean Polling; experiment 12)
12. Does this chapter promise exactly-once or at-least-once? What is the difference between "a response is consumed only once" and "global exactly-once"? (The "This Is Not Exactly Once" passage in The Lead Side; What This Chapter Deliberately Did Not Do)

After you can do all of this, "please shut down" and "the plan is approved" are no longer chat that two Agents guess from tone. They are a runtime contract that supports persistent recovery, strict matching, concurrent validation and failure retry.

In the next chapter, we remove the crutch of the Lead assigning work by hand: teammates will **actively discover and claim** work from a shared task board. At that time, "two people want to claim the same thing at the same time" becomes the primary problem, and this chapter's persistent state machine is exactly the premise for solving it.
