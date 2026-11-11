The context window is only so big.

That sentence sounds harmless. The feeling is completely different when you actually hit the boundary. A backend refactoring task touches authentication, the database, API routes and tests at the same time. A single Agent works through the second half, and the details from the first half have already left its context. It does not suddenly become stupid. It physically cannot see them any more.

The one-shot subagent in Chapter 6 can put an independent task into a clean context. It returns only the result to the Lead. But some work is not a single question and answer. A teammate must keep its own history, receive follow-up additions, report progress asynchronously, and continue to exist after it finishes one round of work.

Chapter 14 has just solved "the Agent can move even when nobody is speaking". The other end of that chain is **time**. This chapter replaces that end with **another Agent**: events no longer come from an alarm clock. They come from a teammate that has a name, has a history, and is still alive.

Chapter 15 implements exactly this minimal closed loop: **persistent teammates, a persistent Mailbox, and a typed event channel that sends Mailbox messages back into the shared Agent Loop**.

Fix the scope first. This chapter covers only **persistent, bidirectional delivery of text messages**. The Lead gains two tools. A teammate has only four tools. Messages live on disk, not in memory. There is no `check_inbox`, no structured request/response, no permission escalation, and no shutdown handshake. The path that returns events to the Loop reuses the `EventInbox` from Chapter 13 in full. **This chapter does not build a second event channel, and it does not build a second Loop.**

![image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaF6JPZn9D3GrBeTiaicLug7PnHnHPsN1zSSlCNkxAjMYkp8CanZYiad2Vao3lqd2XIfBrafSqdlFwrxnqva4GFEHdmWaic8TIoFA2U/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

1. You can explain that the difference between a one-shot subagent and a persistent teammate is not "whether there is concurrency". The difference is **who holds the identity, the history, the communication and the life cycle**.
2. You can explain why a "read the file, then delete the file" inbox gives **at-most-once** delivery, and at which exact window it loses a message forever.
3. You can state what the "one file per message, and the directory name is the state" design buys. You can state what fact each of the four directories `ready/processing/done/quarantine` represents.
4. You can judge why the authoritative FIFO key for a claim is `(created_at_utc, id)` and not file name order. You can give an example where file name order gives the wrong order.
5. You can explain why a mailbox event **enters the canonical history before the ack**. You can explain why it is the only event type in the chapter that keeps a "half state".
6. You can explain why an `idle` teammate that receives a new message can see the previous round of conversation. You can explain why the histories of Alice and Bob never cross.
7. You can state where the `sender` in a teammate's `send_message` comes from. You can explain why it cannot be a field in the tool input.
8. You can judge what happens to a teammate report after the Lead crashes. You can explain why this is "at least once" and not "exactly once".

### What you need first

| Prerequisite | From which chapter | How this chapter uses it |
| --- | --- | --- |
| One turn of the Agent Loop: model -> tools -> result backfill | Chapter 1 | A teammate is one independent Loop, not something else |
| `ToolDefinition` / the Zod `.strict()` schema | Chapter 2 | `spawn_teammate` and `send_message` use it to guard the boundary |
| `ToolContext.identity` shows who calls the tool | Chapter 3 | **One focus of this chapter**: the teammate's sender comes from it, not from the input |
| Delegation to and return from a one-shot subagent | Chapter 6 | The comparison case for this chapter; after you read it, you can state five differences |
| File lock + atomic replacement + fail-closed | Chapters 12, 14 | Every Mailbox state transition follows the same discipline |
| `RuntimeEvent` / `EventInbox` / `RuntimeEventPump` | Chapter 13 | **The most important prerequisite**: teammate messages use this exact path |
| `JobSupervisor.startManaged()` and the shutdown order | Chapter 13 | Every teammate worker is a managed job, not a wild Promise |
| `runEvents()` and history-before-ack | Chapter 14 | This chapter adds exactly one point on top of it: the mailbox half state |
| Profile capability bits and capability injection in the composition root | Chapters 5–14 | P15 connects to the runtime through the two capability bits `teammate` and `mailbox` |

If you can read only one chapter first, read the "how events return to the same Loop" part of Chapter 13. The new material in this chapter concentrates on **where events come from**. **How events return** was already fixed in Chapters 13 and 14.

### Quick term reference (terms that first appear in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| Lead | The Agent you talk to directly. Its name is fixed as `lead`. The name is reserved |
| Teammate | An Agent that has a name, has an independent history, and can exist for a long time |
| Mailbox (inbox) | A set of disk directories under each Agent's name. Messages are stored inside |
| `MailboxMessage` | The domain object for one message. It is also a `RuntimeEvent` |
| `kind` | The message kind. It has only three values: `task` / `message` / `result` |
| claim | The system moves a message atomically from `ready` to `processing`. This action takes the lease |
| lease | The state "this message now belongs to me for processing". No other consumer takes it before the ack |
| ack (acknowledgement) | "I have finished processing this message". The system moves the message from `processing` to `done` |
| release | The consumer gives up the lease. The system moves the message from `processing` back to `ready` and keeps the replay opportunity |
| quarantine (isolation) | The system moves a bad message, or input that failed processing, to one side as evidence. It does not block the queue |
| at-least-once delivery | A crash can replay the same message, but the system never drops it silently |
| `idempotencyKey` | In this chapter, the message UUID. The system passes it to every tool in this turn for deduplication |
| event-only turn | One model turn that has no user input and that an event triggers |
| half state | The intermediate state where the event is in the history but the ack has not yet succeeded. Only the mailbox has it |
| `wakeup` | The callback that asks the host to run `runEvents()` once when a new message arrives |

### Suggested reading route

```text
Chapter Guide (you are here)
  ↓
① Look at one complete collaboration trace first     ← Look at the real output directly, not at abstractions first
  ↓
② The essence of the problem                 ← Why a dict inside one process is not enough
  ↓
③ Add only two tools             ← And why there is no check_inbox
  ↓
④ Model the MailboxMessage        ← The message and the event are the same object
  ↓
⑤ One file per message             ← The directory name is the state; the most important storage decision in this chapter
  ↓
⑥ FIFO, recovery and bad-message isolation     ← Three correctness boundaries that readers easily ignore
  ↓
⑦ TeammateRuntime            ← One name, one persistent Runner
  ↓
⑧ Cut the teammate tools down to four         ← Fewer tools does not mean bypassing governance
  ↓
⑨ Inbox injection                 ← Enter the history first, then ack; the mailbox half state
  ↓
⑩ Share one runtime             ← One Inbox, one supervisor
  ↓
⑪ Failure and shutdown                 ← Who is responsible for putting in-flight work back
  ↓
⑫ Connect it into the composition root                 ← Capability bits, 18 tools, and the current state of the CLI wiring
  ↓
⑬ Run it + 15 experiments + troubleshooting    ← Verify every conclusion above with your own hands
```

---

## Look at One Complete Collaboration Trace First

Talking about "asynchronous communication" in the abstract is easy to misunderstand. So look at the output of one real run first. Every line below comes from Experiment 6 in this chapter. I did not derive it.

The Lead asks Alice to read the existing documentation first and list the gaps. After the Lead receives the gaps, it adds more content:

```text
1. spawn_teammate(alice)
   -> {"name":"alice","role":"writer","status":"running"}
2. alice finishes in the background -> writes the result into lead/ready -> publishes an event -> wakes the Lead
   [wakeup 1] Lead.runEvents() -> receives the gap list
   alice status = idle
3. The Lead's canonical history:
     1. user      {"runtime_event":{"kind":"mailbox","message_id":"00000000-0000-4000-8000-000
     2. assistant receives the gap list
```

The full content of that `user` message in step 3 is:

```json
{
  "runtime_event": {
    "kind": "mailbox",
    "message_id": "00000000-0000-4000-8000-000000000702",
    "sender": "alice",
    "recipient": "lead",
    "message_kind": "result",
    "content": "The README lacks recovery and failure-boundary documentation",
    "created_at_utc": "2026-07-30T08:00:00.000Z"
  }
}
```

**This is the core action of this chapter.** Alice's report is not a log line that a background thread prints to the terminal. It is a persistent message. In the end, it enters the Lead's conversation history as a structured event with `role: "user"`. Printing only lets a person see it. Entry into the history lets the model continue the collaboration.

Next, the Lead appends a second round:

```text
4. send_message(to=alice) appends the second round
   [wakeup 2] Lead.runEvents() -> receives the added result
   alice has been created as exactly 1 Runner
   alice's messages in round 2 (round 1 is still present):
     system    You are alice, serving as writer.
     user      Read the README and list the gaps
     assistant The README lacks recovery and failure-boundary documentation
     user      Add only the recovery and failure boundary
5. Wrap-up: alice status = idle, Lead history length = 4
   lead mailbox remaining ready = 0
   lead mailbox done = 2
   alice mailbox done = 2
```

Look closely at Alice's second-round request in step 4: **the user/assistant pair from round 1 is still there**. The Lead did not stitch this context together for her. The same `AgentRunner` held the same history from start to finish. The output line "created as exactly 1 Runner" is the evidence.

### The key differences from the one-shot subagent trace

If you do this with the `task` tool from Chapter 6, the trace looks like this:

```text
Lead -> task("Read the README and list the gaps")
        The subagent gets a brand-new context, runs to completion, and returns text
        The subagent disappears
Lead -> task("Add only the recovery and failure boundary")
        Another brand-new context; it knows nothing about what was said last time
```

On the second delegation, the Lead must repeat the first conclusion. Otherwise the subagent knows nothing. Alice in this chapter remembers it herself.

Three differences you can observe directly:

| Observation point | One-shot subagent | Chapter 15 Teammate |
| --- | --- | --- |
| Does round 2's request contain round 1? | No | Yes (the step 4 output above) |
| How does the result return to the Lead? | Tool return value, received synchronously in the same turn | Persistent message + event, enters the history asynchronously |
| What happens if the process crashes in the middle? | This whole delegation is lost | The message is still on disk; processing continues after a restart |

The third row deserves special attention. The second half of this chapter works on exactly this problem.

---

## The Essence of the Problem: Collaboration Is Not "Start More Model Calls"

The difference between a one-shot subagent and a persistent teammate does not lie in whether there is concurrency. It lies in **who holds the identity, the history, the communication and the life cycle**.

| Boundary | One-shot subagent | Chapter 15 Teammate |
|---|---|---|
| Life cycle | Returns after it completes one delegation | Enters `idle` after completion; it can receive follow-up messages |
| Conversation history | Independent for each delegation | Each name binds to one independent `AgentRunner`; later rounds keep reusing it |
| Communication | Returns the final result | Sends text messages in both directions through the persistent Mailbox |
| Public tools | The Lead's `task` | The Lead's `spawn_teammate`, `send_message` |
| State | Running or finished | `running`, `idle`, `failed`, `shutdown` |

### Why a dict inside one process is not enough

The easiest implementation to think of looks like this:

```typescript
// Looks sufficient, but it is not
const inbox = new Map<string, string[]>();
inbox.get("lead")?.push("alice said: the README lacks recovery documentation");
```

It fails in three places. None of them is a theoretical problem:

**First, process exit means total loss.** A teammate worked for three minutes to produce a result. The process closes, and the result is gone. In a single question-and-answer exchange this does not matter, because the exchange lives inside one call anyway. But the whole point of a persistent teammate is **existence across calls**.

**Second, a window exists between reading and processing.** Suppose you change it to "read the file, then delete the file":

```text
t0  the message content is read
t1  ← the process crashes here
t2  the message is written into the history (never executes)
```

At `t0` the message has already disappeared from disk. Before `t2` it has not entered the history. It **disappears forever, and it leaves no trace**. This is called at-most-once delivery.

**Third, multiple writers that append to the same file must solve three extra problems.** If everyone appends to the same `.jsonl` file: concurrent writes interleave, a crash in the middle of a line leaves an unparseable partial line, and multiple readers must each maintain a cursor. You can solve all three. After you solve them, you find that you have written a small message queue.

### The decomposition in this chapter

This chapter does not implement a `MessageBus` with `read_text()` / `unlink()`. It splits collaboration into four clear boundaries:

```text
Lead tools: spawn_teammate / send_message
    |
    v
FileMailboxStore
  one file per message, ready -> processing -> done/quarantine
    |
    v
TeammateRuntime
  holds the teammate Runners, state and workers, and combines Mailbox/Cron events
    |
    v
AgentRunner.runEvents()
  injects the typed message into the canonical history, then runs an event-only turn
```

You can state the responsibility of each layer in one sentence:

| Layer | Responsible for exactly one thing | Not responsible for |
| --- | --- | --- |
| Tool layer | Validates the input, injects the trusted sender | Does not know where messages are stored |
| `FileMailboxStore` | Message persistence and state transitions | Does not know what a teammate is |
| `TeammateRuntime` | The teammate life cycle and the worker loop | Does not know what the Loop looks like |
| `AgentRunner` | Events enter the history; it runs one model turn | Does not know where messages come from |

The relevant implementation is concentrated in these files:

- [Mailbox domain model](code/chapters/ch15/src/features/mailbox.ts)
- [The store with one file per message](code/chapters/ch15/src/adapters/mailbox-json.ts)
- [The persistent teammate runtime](code/chapters/ch15/src/features/teammates.ts)
- [The typed EventInbox](code/chapters/ch15/src/core/events.ts)
- [The shared Agent Loop](code/chapters/ch15/src/core/loop.ts)
- [The chapter composition root](code/chapters/ch15/src/bootstrap.ts)
- [The CLI composition entry](code/chapters/ch15/src/cli.ts)

Chapter 15 is strictly equal to all Chapter 14 capabilities, plus `teammate` and `mailbox`. Cron, background tasks, permissions, hooks, recovery and the tools from earlier chapters all continue to exist. The chapter does not start a separate Loop.

---

## Add Only Two Tools

Relative to Chapter 14, the Lead adds only two tools:

```typescript
export const spawnTeammateInputSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    prompt: z.string(),
  })
  .strict();

export const sendMessageInputSchema = z
  .object({
    to: z.string(),
    content: z.string(),
  })
  .strict();
```

| Tool | Required fields | Observable result |
|---|---|---|
| `spawn_teammate` | `name`, `role`, `prompt` | Creates an independent Runner, persists the first `task` message into the teammate's Mailbox, and starts the worker asynchronously |
| `send_message` | `to`, `content` | Persists a `message` into the Mailbox of the Lead or of an existing teammate |

`.strict()` means one extra field makes the whole input fail. The system does not "ignore unknown fields". This rule matches the discipline in Chapters 12 and 14: **either fully trusted, or fully unusable.**

### The name must be a safe lowercase slug

An Agent name is not an arbitrary string. It **becomes a directory name on disk directly**. The validation rule is one regular expression:

```typescript
const AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
```

The system adds one more layer of checks for Windows reserved names and path segments. The actual effect (real output from Experiment 1):

```text
alice          -> accepted alice
api-writer     -> accepted api-writer
writer-2       -> accepted writer-2
a              -> accepted a
x1-y2-z3       -> accepted x1-y2-z3
Lead           -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
../lead        -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
lead/other     -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
nul            -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
trailing.      -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
two_words      -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
-lead          -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
lead-          -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
```

The table explains why each name is rejected:

| Rejected name | What happens if you let it through |
| --- | --- |
| `Lead` | Mixed case is the same directory as `lead` on Windows. It is not the same directory on Linux. The same code behaves differently on the two platforms |
| `../lead` | Directory traversal. Messages are written outside the workspace |
| `lead/other` | It becomes two directory levels. The `recipient` and the path no longer correspond one to one |
| `nul` | A Windows reserved device name. Creating the directory fails, or behaves strangely |
| `trailing.` | Windows silently removes the trailing dot. `trailing.` and `trailing` point to the same directory |
| `two_words` | An underscore is harmless by itself. But if you allow it, you must answer "what about case" and "what about Chinese characters". The boundary keeps sliding outward |
| `-lead` / `lead-` | A leading or trailing hyphen does not affect the file system. But it produces ambiguous names such as `alice--bob` |

`lead` is a reserved name. A teammate cannot take it. It belongs permanently to the Agent you talk to directly.

**Validation happens before any work is done.** If the name is invalid, the system does not create a directory first and roll back later. It does not start a worker first and kill it later.

### 18 tools, and the two new ones come last

The P15 Lead tool sequence keeps the full P14 prefix. It only appends at the end (real output from Experiment 11):

```text
 1. shell
 2. read_file
 3. write_file
 4. edit_file
 5. glob
 6. todo_write
 7. task
 8. load_skill
 9. create_task
10. get_task
11. list_tasks
12. claim_task
13. complete_task
14. query_background_job
15. cancel_background_job
16. schedule_cron
17. spawn_teammate      ← new in this chapter
18. send_message        ← new in this chapter
```

Tests lock the order. It is not a coincidence. `ch15-bootstrap.test.ts` asserts that the last two tools are exactly these two. If a refactoring inserts a new tool in the middle, the test fails. This makes the sentence "P15 = P14 + 2" true in the code, not just pleasant in the documentation.

### There is no check_inbox here

This is the clearest point of disagreement between this chapter and most teaching implementations. It deserves its own discussion.

An intuitive design gives the Lead a `check_inbox` tool. The model then decides for itself when to check for messages. The problem is that **it hands a runtime responsibility to the model's judgement**:

```text
The model does not think of checking    -> the message lies on disk, and nobody processes it
The model checks once per turn  -> one extra tool call per turn, and most calls return empty
The model checks at the wrong time  -> the message is late, and no mechanism guarantees that the model checks it in the end
```

"When does a message arrive" is a fact that the runtime can know exactly. It does not need a guess. So this chapter takes a different approach: the Mailbox is **an event source**. `TeammateRuntime` publishes messages to the `EventInbox`. They travel the path that Chapter 13 already fixed. The Lead's tool table does not contain this action at all.

---

## MailboxMessage: Model the Message as an Event First

A message is not a dictionary that someone assembles by hand. It is a strict, immutable domain object:

```typescript
interface MailboxMessage extends RuntimeEvent {
  readonly id: string;
  readonly sender: string;
  readonly recipient: string;
  readonly kind: MailboxMessageKind;
  readonly content: string;
  readonly createdAtUtc: Date;
  readonly idempotencyKey: string;
}
```

Note the `extends RuntimeEvent`. **The message and the event are not two objects. They are two views of the same object.**

`kind` has only three values:

| kind | Who produces it | Purpose |
|---|---|---|
| `task` | `spawn_teammate` | The teammate's first task. The system writes it into its inbox at creation time |
| `message` | `send_message` | Follow-up text that the Lead or a teammate sends actively |
| `result` | The teammate worker | The final result after one Runner execution completes, or an observable failure result |

Three values are enough, because this chapter covers text delivery only. Structured request/response belongs to Chapter 16.

### Five validation rules, and none of them is waived

| Field | Requirement | What happens if it is not met |
| --- | --- | --- |
| `id` | Must be a canonical UUID (lowercase, with hyphens, version nibble 4) | Throws `Mailbox message id must be a canonical UUID` |
| `createdAtUtc` | Must be an ISO `Z` time that round-trips exactly | Parsing fails, and the message enters quarantine |
| `sender` / `recipient` | Pass the same Agent name validation | Throws the unsafe-name error |
| `content` | Must not be empty | Throws an error; and the system **keeps it as-is**, with no implicit `trim()` |
| Field set | Exactly six keys, no more and no fewer | Throws `Mailbox message payload contains unsupported fields` |

The "no implicit trim on `content`" rule is easy to dismiss as a small thing. But if the store quietly rewrites the message body, then "the persisted message" and "the sent message" are not the same message. Every later piece of logic that compares content (such as the idempotent ack) then stops working.

### One object, two identities

```typescript
eventId = message.id;
idempotencyKey = message.id;
```

These two lines let a `MailboxMessage` enter the `EventInbox` without any conversion. They bring three benefits:

1. **The Mailbox and Cron share one typed `EventInbox`**. The system needs no second event channel.
2. **The Loop deduplication logic does not change**: it already deduplicates by `eventId`.
3. **The message UUID naturally becomes the idempotency key**. Every tool in this turn receives the same stable key.

When a message enters the Loop, the system serialises it into one ordinary user message:

```typescript
export function runtimeEventMessage(event: RuntimeEvent): UserMessage {
  return userMessage(JSON.stringify({ runtime_event: event.toPayload() }));
}
```

`toPayload()` outputs this shape (real output from Experiment 2):

```json
{
  "kind": "mailbox",
  "message_id": "00000000-0000-4000-8000-000000000701",
  "sender": "lead",
  "recipient": "alice",
  "message_kind": "task",
  "content": "Read the README and list the gaps",
  "created_at_utc": "2026-07-30T08:00:00.000Z"
}
```

The outer `kind: "mailbox"` is the event type. The inner `message_kind` is the message kind. The Loop identifies a mailbox event by the outer field. **It does not guess from a text prefix**, and it does not rely on XML tag wrapping.

![image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaHeWzDxUkIcqQBlIHWwdssjCnRZUiaStgM0jEibTb005NrjmYVIkBIJK8zqUibEbalibjYPLF0wY7FOG3sYk8dHJ1evMyfeGvekD5A/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=2)

---

## One File per Message, and the Directory Expresses the State

This is the most important storage decision in this chapter. So look at what it looks like first.

### Disk layout

Mailbox data lives in the current workspace:

```text
.agent_tutorial/
  .mailboxes.lock
  mailboxes/
    lead/
      ready/
      processing/
      done/
      quarantine/
    alice/
      ready/
      processing/
      done/
      quarantine/
```

After one `send()` of a message, it actually looks like this (real output from Experiment 2):

```text
mailboxes/
  alice/
    done/   (empty)
    processing/   (empty)
    quarantine/   (empty)
    ready/
      00000000-0000-4000-8000-000000000701.json
```

The complete content of that file:

```json
{
  "id": "00000000-0000-4000-8000-000000000701",
  "sender": "lead",
  "recipient": "alice",
  "kind": "task",
  "content": "Read the README and list the gaps",
  "created_at_utc": "2026-07-30T08:00:00.000Z"
}
```

Six fields, no more and no fewer. The content is stored as-is in UTF-8. The system does not escape it into `\uXXXX`.

### The directory name is the state

Each message corresponds to one `{uuid}.json`. The directory it sits in is its state:

| State | Meaning | Who is responsible for moving it out of here |
|---|---|---|
| `ready` | Persisted, not yet claimed by a consumer | The consumer claims it |
| `processing` | Atomically claimed by one consumer, not yet acked | The consumer acks / releases / quarantines it |
| `done` | It has entered the consumer's completion boundary | Nobody; it is a terminal state |
| `quarantine` | The file or message is invalid, or the teammate's processing of this message failed | Nobody; it stays as evidence |

**The benefit of this design: a state query does not need to read file content.** Do you want to know how many messages Alice has pending? One `ls` of `alice/ready/` is enough. Do you want to know which message is stuck? Look at what remains in `processing/`. No parsing is needed, no index must be maintained, and no index can disagree with the actual content. **The directory structure itself is the index.**

### A measured run through the four states

One message travels the whole path. Each step lands where (real output from Experiment 3):

```text
send        -> ready
claim       -> processing   returns the same message
release     -> ready
claim again  -> processing
ack         -> done
idempotent duplicate ack -> returns true, location done
ack with different content -> throws Mailbox message does not match completed message: 00000000-0000-4000-8000-000000000701
claim on an empty mailbox -> undefined
```

Eight output lines correspond to eight rules. The last three lines deserve their own discussion. The "idempotent ack" section later expands on them.

### Write discipline: temporary file + fsync + rename

At send time, the system does not `writeFile` directly to the target path. It takes four steps:

```text
① Create a temporary file in the same directory, with the wx flag (fail if it exists, do not overwrite)
② Write the UTF-8 JSON
③ fsync (make sure the bytes really reach the disk, not only the page cache)
④ rename to commit it to ready/{id}.json
```

Why take this detour? Because `rename` is **atomic** within one file system: either the target file exists completely, or it does not exist at all. A direct write is not atomic. A crash halfway through writing leaves a half-written JSON file. The next reader reads unparseable content.

If step ④ fails, neither the target message nor the temporary file remains. **No half state may exist where "the source and the target both do not exist".**

### Claim is not "read it, then delete it"

This is the most fundamental difference from the dict design:

```text
ready/{id}.json
    -- rename -->
processing/{id}.json
```

The ack also completes through rename:

```text
processing/{id}.json
    -- rename -->
done/{id}.json
```

Across its whole life cycle, a message **never disappears from the disk**. It only changes directory. So at any crash moment, the message is still there. And you can tell from the directory name which state it was in at that moment.

Compare how the two designs behave at the same crash point:

| Crash moment | Read-then-delete | This chapter's rename |
| --- | --- | --- |
| After taking the message, before processing | The message is deleted, **lost forever** | In `processing/`; recovery runs after a restart |
| After processing, before the ack | The message is deleted; you cannot tell whether it was processed | In `processing/`; a restart replays it once |
| After the ack | Normal | In `done/`; normal |

The first column is at-most-once. The second column is at-least-once. **Prefer duplication over loss.** This trade-off is exactly the same as the one for cron events in Chapter 14.

### Idempotent ack: a real cross-runtime timing case

This is the correctness problem in the chapter that readers most easily ignore. But it really does happen.

Imagine two runtimes process the same message one after the other:

```text
runtime A: claims message X          -> X is in processing
runtime A: (stuck / crashed / slow network)
runtime B: starts, recoverProcessing -> X returns to ready
runtime B: claims X               -> X is in processing
runtime B: finishes processing, acks           -> X is in done
runtime A: recovers, and also wants to ack X   -> processing/X no longer exists
```

What should that last step do? Three options:

| Option | Consequence |
| --- | --- |
| Return failure | A thinks the message is unfinished. It may queue the message again — but the message is already in `done` |
| Return success unconditionally | If the entry in `done` is actually **a different message with the same id**, the conflict is silently swallowed |
| **Read it out and compare** (this chapter) | Identical content means idempotent success. Different content means an explicit failure |

The code implements it like this:

```typescript
if (!(await pathExists(processing))) {
  if (destination !== MailboxState.Done) return false;
  const completed = join(directories[MailboxState.Done], filename);
  if (!(await pathExists(completed))) return false;
  const stored = await this.#loadMessage(completed, message.recipient);
  if (!equalMailboxMessages(stored, message)) {
    throw new MailboxStorageError(`Mailbox message does not match completed message: ${message.id}`);
  }
  await this.#assertUniqueId(paths, message.id, completed);
  return true;
}
```

Experiment 13 runs this timing case end to end:

```text
first.claim -> 0701
second.recoverProcessing -> 1
second.claim -> 0701
second.ack -> true
first.ack (late ack from the old consumer) -> true
first.ack with conflicting content -> Mailbox message does not match completed message: 00000000-0000-4000-8000-000000000701
send again with the same UUID -> Mailbox message id already exists: 00000000-0000-4000-8000-000000000701
```

The second-to-last line is the key: identical content gives idempotent success. **Different content fails loudly.** The old consumer does not queue the completed message again. And a same-id conflict is not silently swallowed.

### UUIDs are globally unique

The last output line reveals one more rule: the same UUID must be unique across **all Agents and all state directories**. When the store finds a conflict, it fails explicitly. It does not let the second message overwrite the first.

This is stricter than "unique within each mailbox". Why? Because the message id is also the `eventId` and the `idempotencyKey`. If two different messages shared one id, the Loop deduplication would treat the second as a duplicate event. It would drop it directly.

### Two locks solve two different problems

```text
Across processes: .agent_tutorial/.mailboxes.lock (proper-lockfile)
Within a process: withProcessMutex (a Promise queue keyed by the workspace path)
```

They cannot replace each other, because they solve different problems:

| Lock | What it guards against | What happens without it |
| --- | --- | --- |
| `.mailboxes.lock` | Two **processes** reading and writing the same state directory at the same time | Two sessions can claim the same ready message at the same time |
| `withProcessMutex` | Multiple `FileMailboxStore` instances inside one process operating concurrently | The file lock still blocks them, but it degrades into heavy retries, and performance collapses |

The concrete file-lock parameters:

```typescript
const LOCK_STALE_MS = 30_000;   // After 30 seconds, the system treats the holder as dead
const LOCK_UPDATE_MS = 10_000;  // Renew the lease every 10 seconds
retries: { retries: 100, minTimeout: 10, maxTimeout: 10 }  // Retry at most 100 times, 10ms each time
```

`stale = 30s` prepares for a force kill: if a process dies by a route other than `Ctrl+C`, the lock file remains. After 30 seconds, the next session can take over. Nobody must delete it by hand.

The 100 × 10ms retries prepare for Windows: antivirus software and indexing services hold files briefly. They cause `EBUSY` / `EPERM`. The retry window is about 1 second. It covers this kind of transient hold.

### A measured concurrency run

12 writers send at the same time, and 12 claimers grab at the same time (real output from Experiment 14):

```text
12 concurrent sends -> 12 succeed
12 concurrent claims -> 12 messages taken, 12 after deduplication
one more claim -> undefined
```

The three lines verify three properties in order: **no message loss** (all 12 were written), **no duplicate claim** (12 claims took 12 mutually different messages), and **no false issue** (the 13th claim honestly returns empty).

---

## FIFO, Recovery and Bad-Message Isolation

Three correctness boundaries that readers easily ignore. I discuss them one by one.

### The FIFO key is not the file name

A file name is a UUID. UUIDs in lexicographic order have no relation to message order. The authoritative FIFO key for a claim is:

```text
(created_at_utc, id)
```

The system compares the UTC creation time first. When the times are equal, it breaks the tie in a stable way with the canonical UUID text. The comparison function is one line:

```typescript
createdAtUtc.valueOf() - other.createdAtUtc.valueOf() || id.localeCompare(other.id)
```

Experiment 4 constructs a case where file name order gives the wrong order: three messages, and the one with the smallest id has the latest creation time.

```text
Send order (write-to-disk order):
  0701  created=2026-07-30T08:00:01.000Z  1 second later, but the smallest id
  0703  created=2026-07-30T08:00:00.000Z  same time, larger id
  0702  created=2026-07-30T08:00:00.000Z  same time, smaller id
Claim order:
  1. 0702  created=2026-07-30T08:00:00.000Z  same time, smaller id
  2. 0703  created=2026-07-30T08:00:00.000Z  same time, larger id
  3. 0701  created=2026-07-30T08:00:01.000Z  1 second later, but the smallest id
Sorting by file name would give: 0701, 0702, 0703 (wrong)
```

The correct order is `0702 -> 0703 -> 0701`: group by time first (the two `08:00:00` messages come before `08:00:01`). Then order by id inside the group. Sorting by file name would put `0701`, the latest one created, at the very front.

**Why does the order need the id as a second sort key?** Because multiple messages can go out within the same millisecond (the `0702` and `0703` above are exactly that). If you sort by time only, the relative order of two same-time messages depends on the directory enumeration order. Directory enumeration order is **not guaranteed to be consistent** across file systems or across runs. After you add the id, the order is deterministic: **the order after a restart has nothing to do with the directory enumeration order.**

### processing does not mean "already completed"

When the runtime rebuilds, it must recover:

```text
processing -> ready -> claim again
```

Recovery happens at two moments:

| Moment | Whose mailbox it recovers |
| --- | --- |
| `TeammateRuntime.start()` | The Lead's mailbox |
| When `spawn()` creates a teammate | The processing messages left behind in that teammate's mailbox |

This is the concrete implementation of at-least-once delivery: a crash can replay the same message. But a process interruption must not drop it silently.

The last two lines of Experiment 5 verify this point:

```text
recoverProcessing -> 1 message returns to ready
claim again -> the valid message
```

### One bad message must not block the whole inbox

This is the classic failure mode of a queue system: one unparseable message sits at the head of the queue. Every normal message behind it is stuck.

Claim and recover validate strictly, one message at a time, under four rules:

- The file must be an ordinary `.json` file. The file name must be a canonical UUID.
- The JSON must be UTF-8. The field set, the message ID and the recipient must agree with the path.
- An unknown field, bad JSON, bad bytes or a path mismatch moves the file atomically into `quarantine`.
- **After it isolates one bad file, it continues to look for the next valid message.** It does not interrupt the whole claim.

Experiment 5 puts four kinds of bad files plus one normal message into Alice's inbox:

```text
The ready directory before the claim:
  00000000-0000-4000-8000-000000000701.json      ← valid message
  00000000-0000-4000-8000-0000000009fd.json      ← one extra priority field
  00000000-0000-4000-8000-0000000009fe.json      ← recipient written as bob
  00000000-0000-4000-8000-0000000009ff.json      ← incomplete JSON
  not-a-uuid.json                                 ← file name is not a UUID

Claim result -> the valid message (id 0701)

ready after the claim:
  (empty)
quarantine:
  00000000-0000-4000-8000-0000000009fd.json
  00000000-0000-4000-8000-0000000009fe.json
  00000000-0000-4000-8000-0000000009ff.json
  not-a-uuid.json
```

**One claim cleared all four bad files out of ready, and it took the valid message.** The inbox was not blocked.

Among the four bad files, the one with `recipient` written as `bob` deserves special attention: the file sits under `alice/ready/`, but the content says the recipient is `bob`. The system must treat this inconsistency as a bad message. Otherwise, one message's "ownership" has two accounts, and either account may be the tampered one.

If quarantine already contains a file with the same name, the store picks a new name that does not conflict (it appends `.quarantine-{index}.json`). **It keeps both pieces of evidence. It does not overwrite the earlier failure scene.** The thing you fear most when you debug a problem is later failures overwriting the evidence.

---

## TeammateRuntime: One Name, One Persistent Runner

The storage layer is done. Now look at who uses it.

### spawn does not wait for completion

When `spawn_teammate` returns, the teammate is still running. For each valid, unoccupied name, the runtime creates one internal `Worker` record:

```text
Worker
  ├─ Teammate snapshot (name / role / status, a frozen object)
  ├─ AgentRunner (exclusive to this teammate, holds the full history)
  ├─ The current managed Promise task (undefined means no loop is in flight)
  ├─ The current processing MailboxMessage (the lease; close must return it)
  ├─ AbortController (cancels the current loop)
  └─ closeComplete / cleanupFailure (supports close retries)
```

The state snapshot is a frozen object that the system **replaces as a whole**. The system does not modify it in place. So a `Teammate` reference that the outside holds does not quietly change in your hands.

### The first task also travels through the Mailbox

One tempting shortcut: at `spawn` time, put the prompt directly into the teammate Runner's `messages[]`. This chapter does not do that. It first writes the prompt into the teammate Mailbox as a `task` message. The worker then claims it from there.

**What does this detour buy?** Three things:

1. The first task and the follow-up messages travel **exactly the same** path. The system needs no two sets of logic.
2. If the process crashes immediately after `spawn`, the task is still on disk. A restart can continue it.
3. The first round and the later rounds give the teammate the same `idempotencyKey` semantics. Both are message UUIDs.

After the worker claims the message, it calls:

```typescript
const result = await worker.runner.run(message.content, {
  idempotencyKey: message.id,
  signal,
});
await this.#store.send(worker.teammate.name, this.#leadName, result.finalText, MailboxMessageKind.Result);
if (!(await this.#store.ack(message))) {
  throw new MailboxStorageError(`Mailbox message is not processing: ${message.id}`);
}
```

Three lines of code, and the order matters: **send the result first, then ack the input**. In the reverse order, a crash between the two steps leaves the input acked but the result unsent. That task then disappears without a sound. In the current order, the worst case is that the result goes out twice. Both sends carry the same `idempotencyKey`, so downstream code can deduplicate.

That stable UUID enters the `ToolContext.idempotencyKey` of every tool in this round. `AgentRunner.run()` rejects an empty key **before** the history, the hooks and the model call. A damaged idempotency context must not degrade into an ordinary execution.

### The state machine: completion is not destruction

```text
spawn                -> running
one round completes             -> idle
a new message arrives           -> running
it completes again             -> idle
an execution exception             -> failed
runtime close completes   -> shutdown
```

The key is `idle`: **the Runner is not destroyed.**

When the Lead later calls `send_message(to="alice", ...)`, and Alice is in `idle`, the runtime restarts that worker. But it keeps using the original Runner. So the second-round model request still sees the first round's user/assistant history. This is what step 4 of the trace at the start of this chapter showed.

### Histories never cross

Alice and Bob each hold a different Runner. Experiment 7 starts two teammates at the same time and prints each one's model request:

```text
The Lead receives: [ 'alice=alice done', 'bob=bob done' ]

alice's model request:
  system    You are alice, serving as writer.
  user      Write documentation
  tools = send_message

bob's model request:
  system    You are bob, serving as reviewer.
  user      Review code
  tools = send_message
```

The two requests are fully independent: different system prompts (different roles), different user messages, and each has its own history. Alice cannot see what Bob is doing. Bob cannot see Alice either.

**This is exactly the point of multiple teammates.** If two teammates shared one context, there would be no need to split them into two. One Agent could do both jobs, and you would save one model call. The value of the split is precisely that **each context holds only its own share of the work**.

### Three kinds of rejection

The second half of Experiment 7 verifies the rejection paths:

```text
Concurrent same-name spawn: [ 'success', 'failure Teammate already exists: carol' ]
lead     (reserved name) -> Teammate name lead is reserved for the lead
Alice    (uppercase) -> Invalid or unsafe Agent name; expected a safe lowercase slug
../x     (path) -> Invalid or unsafe Agent name; expected a safe lowercase slug
send to the non-existent zoe -> Unknown teammate: zoe
```

The first line is the evidence of concurrency safety: two `spawn("carol")` calls arrive at the same time. The registration lock lets only one succeed. The implementation relies on one serialised Promise chain (`#registryTail`). It queues the registry's "read-modify-write" operations.

What happens without this lock? Both calls read "carol does not exist". Both create a Worker. The second overwrites the first. The first Worker's Runner becomes an orphan. The messages it claimed are never acked.

A teammate in `failed` or `shutdown` also cannot keep receiving messages:

```text
Send a message to a failed teammate -> Teammate alice cannot receive messages while failed
```

### hasPendingWork deliberately does not count teammates

This rule runs against intuition, but it is important:

```typescript
get hasPendingWork(): boolean {
  return this.#cronRuntime.hasPendingWork;
}
```

`TeammateRuntime.hasPendingWork` **does not count "a persistent teammate still exists" as work that an ordinary turn must wait for**.

Why? Because an `idle` teammate exists forever. If you counted it as pending work, then as soon as you have created one teammate, a user turn that waits for "the system is idle" could **wait forever**. `idle` is a stable state, not a transitional state.

Distinguish two things:

| Concept | Does it end by itself | Does it count as pending work |
| --- | --- | --- |
| A background task that is running | Yes | Counts |
| One in-flight cron tick | Yes | Counts |
| An idle teammate | **No**, it just waits there | Does not count |

---

## Teammate Tools Are Strictly Cut Down to Four

The Lead inherits the full tool surface of the first 14 chapters (18 tools). A teammate does not. The teammate Runner registers only four tools (real output from Experiment 11):

```text
Teammate tools (4): read_file, send_message, shell, write_file
Teammate system prompt = "You are writer, serving as writer."
```

The assembly code is very short:

```typescript
const teammateTools = standardTools.tools.subset(["shell", "read_file", "write_file"]);
teammateTools.register(sendDefinition);
```

`subset` exposes only the tools that the code declares explicitly. It is not "hiding". The remaining definitions **do not exist at all** in this Runner's tool table. The model cannot see them, so it cannot call them.

### Each missing tool is missing for a reason

| Missing tool | Why it is not given |
| --- | --- |
| `spawn_teammate` | The team structure is fixed as one Lead plus multiple peer teammates. If teammates could spawn teammates, the topology becomes an uncontrolled tree |
| `edit_file`, `glob` | A teammate that can read and write can complete this chapter's collaboration scenarios. A smaller tool surface makes its behavior boundary easier to reason about |
| `todo_write` | A TODO is the Lead's means to organise its own work. It is not a shared team board |
| `load_skill` | A Skill brings in a large block of context. That conflicts with "a teammate's context holds only its own share of the work" |
| `task` | A one-shot subagent creates a second layer of delegation. It is a parallel collaboration model next to the persistent teammate |
| The five Task DAG tools | A teammate that finds its own work from a shared task graph belongs to Chapter 17 |
| `schedule_cron` | A teammate that can wake itself on a timer raises the life-cycle complexity by a magnitude |

### Fewer tools does not mean bypassing governance

This is the point that readers most easily misunderstand. The teammate's four tools **are not a special channel**. They follow exactly the same execution order as the Lead's tools:

```text
Parameter schema validation
  ↓
PreToolUse Hook
  ↓
PermissionPolicy decision
  ↓
handler execution
  ↓
PostToolUse Hook
```

Each teammate Runner uses its own name as `ToolContext.identity`. It reuses the current chapter's hooks, `PermissionPolicy`, recovery and compaction boundaries. When a teammate calls `shell`, the approval that should pop up still pops up. The audit that should be recorded is still recorded.

### The sender cannot be forged

A teammate's `send_message` input contains **only `to` and `content`**. It has no `from`:

```typescript
async #sendTool(input: SendMessageInput, context: ToolContext): Promise<ToolResult> {
  try {
    const message = await this.send({ ...input, sender: context.identity });
    return toolSuccess(JSON.stringify(message.toPayload()));
  } catch (error) {
    return toolError(errorCode(error, "mailbox_send_error"), errorMessage(error));
  }
}
```

The line `sender: context.identity` is one of the shortest but most important security boundaries in this chapter.

If `sender` were a field in the tool input, Alice could send a message that claims to come from Bob. The Lead could not tell the difference. **Identity must be observed by the runtime. The governed party must not declare it.** This principle has the same design motive as `ToolContext.identity` in Chapter 3.

---

## Inbox Injection: Enter the Canonical History First, Then Ack

Now send the message back into the Loop. This section is the seam between this chapter and Chapters 13 and 14.

### The complete order

A message that a teammate writes to the Lead is claimed from `ready` to `processing`. The system then publishes the original `MailboxMessage` object to the shared `EventInbox`. When the Loop is idle, it runs an explicit event-only turn:

```text
① EventInbox drains one typed RuntimeEvent (it takes only one each time)
② Check whether the eventId has been seen (deduplication)
③ Serialise it and append it to the Lead's canonical history
④ Call TeammateRuntime.acknowledgeEvents()
   -> Mailbox processing -> done
⑤ The model executes this one event turn
```

**Steps ③ and ④ must not change order.**

Suppose you ack first and append to the history second:

```text
t0  the ack succeeds, the message enters done
t1  ← the process crashes here
t2  append to the history (never executes)
```

The message is in `done`, and nobody will process it again. It is not in the history, so the model never knows that the teammate reported anything. **It is lost forever, and it leaves no trace.**

In the correct order, at the same crash point:

```text
t0  append to the history
t1  ← crash
t2  ack (not executed)
```

The message is still in `processing`. At a restart, `recoverProcessing` moves it back to `ready`. The system delivers it once more. The worst result is **one duplicate**. The `idempotencyKey` covers that duplicate.

The current contract requires this: at ack time, the canonical history **already contains exactly one copy** of the corresponding event.

### The mailbox is the only event that keeps a half state

This is the only substantive change that this chapter makes to the Chapter 14 Loop. The code is in `#acceptNextRuntimeEvent`:

```typescript
if (isNewEvent) {
  this.#history.push(runtimeEventMessage(event));
  this.#seenEventIds.add(event.eventId);
}
try {
  await this.#eventPump.acknowledgeEvents(events);
} catch (error) {
  if (event.toPayload().kind !== "mailbox" && isNewEvent) {
    this.#history.pop();
    this.#seenEventIds.delete(event.eventId);
  }
  if (event.toPayload().kind === "mailbox") this.#pendingEventAcks.add(event.eventId);
  throw error;
}
this.#pendingEventAcks.delete(event.eventId);
```

Compare how the two event types are handled when the ack fails:

| Event type | After an ack failure | Why |
| --- | --- | --- |
| cron event | **Roll back**: pop the history entry, delete the deduplication record | The event is still in the outbox. It will be produced again later, and it can walk the whole path from the start |
| mailbox event | **Keep**: the history stays, and the system records the event in `#pendingEventAcks` | After the message is resent, the system only needs to complete the ack. It must not enter the model again |

Why does the mailbox need special handling? Because `TeammateRuntime.acknowledgeEvents()` **publishes the same event back into the EventInbox** when it fails:

```typescript
} catch (error) {
  if (!this.#queuedMessageIds.has(event.id)) {
    this.#inbox.publish(event);
    this.#queuedMessageIds.add(event.id);
  }
  throw error;
}
```

The resent event has the same `eventId`. If the Loop had rolled the history back, the resend would be treated as a new event. **It would enter the history once more and run the model once more.** So the correct approach is: keep the history. Record only "this event still owes one ack". On the resend, skip the history and the model call, and complete the ack directly.

This intermediate state is the "half state": **in the history, but not yet acked**. It belongs to the mailbox alone.

### Measured: an ack failure does not duplicate

Experiment 10 injects an ack that must fail the first time:

```text
  ack attempt 1: at this moment, the number of mailbox events in the history = 1
runEvents() attempt 1 throws -> ack persist failed
  number of model requests = 0 (should be 0)
  number of messages in the history that contain this id = 1
  ack attempt 2: at this moment, the number of mailbox events in the history = 1
runEvents() attempt 2 -> processing completes
  total ack attempts = 2
  number of model requests = 1
  number of messages in the history that contain this id = 1
```

Three numbers carry the whole meaning of this experiment:

- **Model requests: 0 → 1.** The system called the model zero times before the ack succeeded. After the ack succeeded, it called it exactly once.
- **Messages with this id in the history: 1 → 1.** The retry produced no second copy.
- **Ack attempts: 2.** The first failed. The second succeeded.

"One observable ack persistence failure causes neither duplicate history nor a duplicate model turn." Three concrete numbers now support this sentence.

### This is not "exactly once"

State the boundary clearly: this is **at-least-once reception + stable-ID deduplication inside the Runner**. It is not a global exactly-once promise for arbitrary external side effects.

The mailbox message ID propagates as the idempotency key. But a tool with real external side effects (for example, one that sends a POST to a remote API) **must still implement idempotency at its own boundary**. The runtime can guarantee "when the same message replays, you receive the same key". It cannot guarantee "the thing you do with this key happens only once".

---

## Mailbox, Cron and Background Share One Runtime

P15 creates no second event queue. It creates no second task owner.

```text
EventInbox (one)
  <- background events from the JobSupervisor
  <- CronEvents from the CronRuntime
  <- MailboxMessages from the TeammateRuntime

JobSupervisor (one)
  <- background jobs
  <- the cron scheduler
  <- teammate workers
```

`TeammateRuntime` achieves this by **composing** the existing `CronRuntime`:

| Method | How it is implemented |
| --- | --- |
| `drainEvents` | Passes directly to `cronRuntime` (the same typed FIFO) |
| `waitForEvents` | Passes directly to `cronRuntime` |
| `hasPendingWork` | Passes directly to `cronRuntime` |
| `acknowledgeEvents` | **Lets Cron ack its own events first, then acks the mailbox messages one by one** |

The last row is the key: two event types are mixed in one shared queue. **Each event type is acked by its own owner.** Cron handles only events where `isCronEvent(event)` is true. The Mailbox handles only events where `isMailboxMessage(event)` is true. Neither crosses into the other's territory.

### The sharing relation is checked at construction time

Resources that look similar but are disconnected from each other are a hard class of bug to debug: the code runs, the tests pass, but events are written into an Inbox that nobody consumes. So the checks sit in the constructor:

```typescript
if (options.cronRuntime.supervisor !== options.supervisor) {
  throw new Error("cronRuntime must share the JobSupervisor");
}
if (options.cronRuntime.eventInbox !== options.inbox) {
  throw new Error("cronRuntime must share the EventInbox");
}
```

Note the `!==`. This is **reference equality**, not a structural comparison. Two EventInbox instances that "look the same" are two queues. Here it must be the same object.

Experiment 11 verifies that these two checks really do stop people:

```text
Cron with a different supervisor -> cronRuntime must share the JobSupervisor
Teammate not sharing the inbox -> teammateRuntime must share the background supervisor, EventInbox, and CronRuntime
```

### The Lead does not need to poll

Because it shares this path, the Lead needs neither to poll `.json` files nor a `check_inbox`.

But clarify one point that is easy to misunderstand: **P15 does not automatically start a new turn just because an idle Lead receives a message.**

After a message is published to the Inbox, the host calls `AgentRunner.runEvents()` explicitly. Three cases:

| Case | Behavior |
| --- | --- |
| The Lead is idle, and the host calls `runEvents()` | Consume one event, and run one event-only turn |
| The Lead is processing a user turn | The Runner's run lock makes `runEvents()` return `undefined` directly. The message stays in the inbox |
| The drain point of a user turn meets a mailbox event | **Defer it**. Do not mix it into the current turn |

The implementation of the third case is only four lines:

```typescript
if (event.toPayload().kind === "mailbox" && !allowContextEvents) {
  this.#deferredRuntimeEvents.push(event);
  events = this.#eventPump.drainEvents(1);
  continue;
}
```

`allowContextEvents` is `true` only inside `runEvents()`. When an ordinary `run()` calls in, it is `false`. So a mailbox event is pushed into `#deferredRuntimeEvents` to wait.

**Why does a user turn not handle it on the side?** Because the user asks about one thing, and the teammate reports about another thing. If you stuff it into the current turn, the model may veer off, in the middle of answering the user's question, to discuss the teammate's report. An event should have its own turn boundary.

Experiment 9 verifies this deferral behavior in full:

```text
user turn -> processed the user request
  number of model requests = 1
  does this request contain a mailbox event = false
  history length = 2
runEvents() -> processed the mailbox event
  number of model requests = 2
  history:
    1. user      ordinary user request
    2. assistant processed the user request
    3. user      {"runtime_event":{"kind":"mailbox","message_id":"00000000-0000-4000-8000-0000
    4. assistant processed the mailbox event
runEvents() again on an empty inbox -> undefined
runEvents() after publishing the same event again -> undefined, and the number of model requests is still = 2
```

Four output blocks, four conclusions: a user turn contains no mailbox event; `runEvents()` is what processes it; an empty inbox honestly returns `undefined`; **an already-acked event that is published again does not enter the model again** (deduplication works).

One final sentence to avoid confusion: **Cron keeps the automatic wakeup it already had in P14. This is not behavior that the Mailbox adds in P15.** The section "Connect It into the Composition Root" explains the actual wiring state of the mailbox wakeup in the CLI.

---

## Failure and Shutdown: Who Puts In-Flight Work Back

The hardest part of a distributed system is not the success path. It is the failure path. This section walks through three kinds of abnormal ending, one by one.

### A failure is also a message

What happens when a teammate's execution crashes? The answer: **the crash also travels through the Mailbox.**

```typescript
} catch (error) {
  await this.#store.quarantine(message, errorMessage(error));
  this.#setStatus(worker, TeammateStatus.Failed);
  try {
    await this.#store.send(
      { sender: worker.name, recipient: LEAD_NAME,
        kind: MailboxMessageKind.Result,
        content: `Teammate ${worker.name} failed: ${errorMessage(error)}` },
    );
  } catch { /* best-effort */ }
  await this.#notifyLead();
}
```

Three things happen in order: the input message enters `quarantine` (with the failure reason; it does not return to `ready`, so the same task cannot retry forever and crash the teammate repeatedly), the teammate state is set to `failed`, and the Lead receives a `result` that explains the failure.

The output of Experiment 8:

```text
The Lead receives:
  {"kind":"mailbox","message_id":"00000000-0000-4000-8000-000000000702",
   "sender":"alice","recipient":"lead","message_kind":"result",
   "content":"Teammate alice failed: model exploded",
   "created_at_utc":"2026-07-30T08:00:00.000Z"}
alice status = failed
alice/quarantine = 1 file
Send a message to a failed teammate -> Teammate alice cannot receive messages while failed
```

Note that the failure notification's `message_kind` is `result`, **not** some new `error` type. This is deliberate: the Lead does not need a separate handling branch for "failure". It simply receives a report whose content is a failure explanation. Then it decides the next step as usual — retry, reassign, or give up. **Express the exception in the information content, not in the protocol type.**

The last line also matters: a `failed` teammate receives no more messages. This boundary stops the Lead from sending new tasks to a teammate that is already broken. The messages would pile up in a `ready` directory that nobody ever claims.

That best-effort `try { … } catch {}` is the only empty catch that this chapter allows: **when the failure notification itself fails, it must not overwrite the original error**. The original error is already written into the quarantine file. That file is the authoritative record.

### Shutdown must put in-flight work back

At shutdown, a teammate message that is executing **must return to `ready`**. It must not stay in `processing`, and it must not be lost.

```typescript
if (this.#closed || signal.aborted) {
  await this.#store.release(message);
  return;
}
```

The output of Experiment 12:

```text
alice status before close = running
alice status after close = shutdown
The original task message returns to ready and can be claimed again = {"content":"long task","kind":"task"}
spawn after close -> TeammateRuntime is closed
```

The difference between `release` and `quarantine` reflects exactly the difference between the two failure kinds:

| Ending mode | Where the message goes | Semantics |
| --- | --- | --- |
| The teammate's execution throws | `quarantine` | This message itself has a problem, or it cannot be processed. Do not try again |
| An active shutdown / abort | `ready` | This message has no problem. It simply was not its turn to finish. Continue it next time |

The judgement basis for distinguishing the two is `this.#closed || signal.aborted`. **A shutdown is something we initiate actively. It is not the message's fault.**

After `close()`, `spawn_teammate` reports `TeammateRuntime is closed` explicitly. It does not silently create a teammate that will never execute.

### Shutdown order: reverse

The composition root registers resources in creation order. It closes them in **reverse** order:

```typescript
const resources = [backgroundSupervisor, cronRuntime, teammateRuntime];
// At shutdown, traverse in reverse: teammateRuntime -> cronRuntime -> backgroundSupervisor -> model
```

Why must the order be reverse? Because the dependency direction is one-way:

```text
TeammateRuntime  ──depends on──>  CronRuntime  ──depends on──>  JobSupervisor
```

If you close the `JobSupervisor` first, a teammate worker that is wrapping up finds that its executor is already gone. If you close the `TeammateRuntime` first, the teammate releases its in-flight messages back to `ready`. Then Cron wraps up. Finally, the supervisor confirms that no jobs remain. **When each layer closes, the things it depends on are still alive.**

This is the same principle as the nesting order of `try/finally`, the destructor order in C++, and the `defer` stack in Go.

---

## Connect It into the Composition Root, and the Two Entries

### P15 = P14 + two capability bits

```text
P14 capability bits = artifacts, background, compaction, cron, dynamic_prompt, files,
             hooks, loop, memory, policy, powershell, recovery, skills,
             subagent, task_dag_json, todo, tool_registry
P15 capability bits = the list above + mailbox, teammate
P15 - P14 = ["teammate","mailbox"]
```

(Output of Experiment 11.) No replacement, no deletion, no semantic change. The chapter only adds two bits.

### Four pairing checks

A capability bit and its instance must appear as a pair. Otherwise the composition root **refuses to start**:

| Case | Error |
| --- | --- |
| P15 but no `teammateRuntime` is passed | `teammateRuntime is required for chapter 15 or later` |
| P14 but a `teammateRuntime` is passed | `teammateRuntime requires chapter 15 or later` |
| The `cronRuntime` uses a different supervisor | `cronRuntime must share the JobSupervisor` |
| The teammate does not share the inbox / supervisor / cron | `teammateRuntime must share the background supervisor, EventInbox, and CronRuntime` |

(Also output of Experiment 11. All four really were thrown.)

This is **fail-closed**: prefer a crash at startup over discovering, after the system runs, that messages entered a queue that nobody reads. If it crashes at startup, the error message states directly which pair is missing. If the problem appears after startup, you must debug "why did the teammate report but the Lead not react". That is an order of magnitude harder.

### Two entries, one assembly

```powershell
# Entry 1: chapter-specific
npm run ch15 -- --prompt "Create a writer teammate, let her read the README and report the gaps"

# Entry 2: the unified CLI
npm run agent-tutorial -- run --chapter 15 --prompt "Create a writer teammate, let her read the README and report the gaps"
```

Both commands land in the same `execute` inside `cli.ts` in the end. **They share all assembly logic.** The only difference is where the profile comes from: entry 1's `runProfile` receives a hard-coded `P15` directly. Entry 2's `runCli` parses `--chapter` first, then looks the profile up with `profileForChapter`.

Following the convention of the earlier chapters, `chapters/ch15.ts` has only 5 lines:

```typescript
// chapters/ch15.ts —— the whole file
import { runProfile } from "../cli.js";
import { P15 } from "../core/profiles.js";

// The fixed entry enables P15 teammate collaboration and mailbox communication.
process.exitCode = await runProfile(P15, process.argv.slice(2));
```

### The wakeup loop: both Cron and Teammate connect to the Runner

The current CLI binds a wakeup for Teammate and Cron separately, at `code/chapters/ch15/src/cli.ts:170` and `:181`:

```typescript
teammateRuntime.bindWakeup(async () => { await runner.runEvents(); });
cronRuntime.bindWakeup(async () => { await runner.runEvents(); });
```

After a teammate delivers a result to the Lead, `#publishLeadMessages()` claims the message into `processing`, publishes it to the shared Inbox, and immediately requests an independent event turn. The Runner's run lock stops it from running concurrently with a user turn.

Experiment 14 is kept as a **regression comparison for an old defect**: it deliberately does not bind the Teammate wakeup. It proves that the persistent Mailbox still recovers across processes when the host misses the callback:

```text
Run 1: Lead's answer = I have already sent alice to look at the README
  alice status = idle
  Lead history length = 2 (only the user's round)
  After shutdown, lead/ready = 0, lead/processing = 1, lead/done = 0
  -> The teammate's result stays in processing. This session did not consume it

Run 2: after start(), lead/ready = 0, lead/processing = 1
  runEvents() -> reads alice's report from last time
  history entry 1 = {"runtime_event":{"kind":"mailbox","message_id":"00000000-0000-4000-8000-000000000702","sender":"ali
  lead/done = 1
```

Even if the host misses the callback, **not one message is silently lost**. This is exactly the value of all the disk discipline above:

```text
Process 1                       Process 2
────────────────                 ────────────────
The result is written into ready
claim -> processing
Published to the Inbox (nobody consumes it)
Process exits ──────────────────────>  start()
                                   recoverProcessing moves it back to ready
                                   #publishLeadMessages claims it again
                                   -> processing (so it still shows 1)
                                 runEvents()
                                   -> enters the history, runs a turn, acks
                                   -> done = 1
```

**At-least-once delivery fills this cross-process gap.** An in-memory dict would drop the message right here.

If you assemble the runtime by hand in your own host, you must keep the same binding:

```typescript
teammateRuntime.bindWakeup(async () => { await runner.runEvents(); });
```

The probe script in Experiment 6 does exactly this. That is why it can print an automatic collaboration trace over two consecutive rounds.

---

## Run Chapter 15

You can copy every step below as-is. All commands are PowerShell.

### Step 0: confirm the environment

```powershell
node --version
npm --version
```

Node must be ≥ 20.12. Below this version, `node:test`, native ESM resolution and some APIs that this chapter uses will have problems.

### Step 1: enter the code directory

```powershell
cd F:\笔记\Agent实操\code
```

All later commands run in this directory.

### Step 2: install the dependencies

```powershell
npm install
```

You only need to do this once. If you have already run the earlier chapters, you can skip it.

### Step 3: run the tests first, and confirm the baseline is good

Run the tests before you configure any credentials. The tests are fully offline. They need no API key:

```powershell
npm run test:ch15
```

Expect to see:

```text
Test Files  44 passed (44)
     Tests  336 passed (336)
  Duration  4.11s
```

The output contains one stderr line like this:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**This is normal.** `tests/ch15-entry.test.ts` deliberately calls the entry without credentials. It verifies that the entry exits politely instead of throwing a stack trace. When you see it, that assertion is working.

If this step is already red, do not continue. The problem is in the environment or the dependencies, not in what you are about to do.

### Step 4: configure the model credentials

Chapter 15 enables the `recovery` capability bit. So **all four variables must be present**. Without `OPENAI_FALLBACK_MODEL`, it will not start either:

```powershell
$env:OPENAI_BASE_URL  = "https://your-endpoint/v1"
$env:OPENAI_API_KEY   = "sk-..."
$env:OPENAI_MODEL     = "your-model"
$env:OPENAI_FALLBACK_MODEL = "your-fallback-model"
```

If any one is missing, the program tells you clearly which one:

```text
Configuration Error: Missing required settings: OPENAI_FALLBACK_MODEL
```

`$env:` is valid only for the current PowerShell window. If you change windows, set the variables again.

### Step 5: run it for real once

```powershell
npm run ch15 -- --prompt "Create a writer teammate, let her read the README and report the gaps"
```

### What you should see

The Lead roughly follows a path like this (the exact wording depends on the model):

```text
① Call spawn_teammate(name="writer", role="writer",
     initial_task="Read the README and report the gaps")
   -> {"name":"writer","role":"writer","status":"running"}

② Return immediately; the Lead continues its own turn
   (writer runs in the background, the Lead does not block)

③ This session ends
```

Note step ③: the current CLI has the Teammate wakeup connected. In a normal run, the writer's report automatically triggers the Lead's event turn. If the host does not bind that callback, the message still lands safely on disk. The next `start()` recovers it.

### Step 6: look at what remains on disk

```powershell
Get-ChildItem -Recurse .agent\mailboxes | Select-Object FullName
```

You will see a structure like this:

```text
.agent\mailboxes\lead\ready
.agent\mailboxes\lead\processing
.agent\mailboxes\lead\done
.agent\mailboxes\lead\quarantine
.agent\mailboxes\writer\ready
.agent\mailboxes\writer\processing
.agent\mailboxes\writer\done
.agent\mailboxes\writer\quarantine
```

To see what is inside one specific directory:

```powershell
Get-ChildItem .agent\mailboxes\lead\processing
Get-ChildItem .agent\mailboxes\writer\done
```

`writer\done` should contain that `initial_task` (the writer finished it and acked it). `lead\processing` should contain the writer's `result` (claimed, not yet consumed).

Read the content of one message:

```powershell
Get-Content .agent\mailboxes\lead\processing\*.json | ConvertFrom-Json | Format-List
```

The six fields are clear at a glance: `id`, `sender`, `recipient`, `kind`, `content`, `created_at_utc`.

### Step 7: run it once more, and watch the recovery

```powershell
npm run ch15 -- --prompt "Check whether there is a teammate report"
```

This time, `start()` first recovers the message that the previous run left in `processing`. After the run, look again:

```powershell
Get-ChildItem .agent\mailboxes\lead\done
```

The previous round's `result` should now be in `done`. **This is at-least-once delivery taking effect at a real process boundary.**

### Troubleshooting common errors

| Symptom | Cause | What to do |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` | A missing environment variable | Set all four as in step 4 |
| `Invalid or unsafe Agent name; expected a safe lowercase slug` | The name is not a safe slug (uppercase, contains `/`, contains `_`, a leading or trailing `-`, a Windows reserved name) | Use a name like `writer` or `api-writer` |
| `Teammate name lead is reserved for the lead` | You tried to create a teammate called `lead` | Pick another name |
| `Teammate already exists: xxx` | A teammate with the same name already exists | Send it a `send_message` directly; you do not need to spawn again |
| `Unknown teammate: xxx` | You sent a message to a teammate that was never created | `spawn_teammate` first |
| `Teammate alice cannot receive messages while failed` | The target teammate has failed | Look at the failure reason in `alice\quarantine` |
| `teammateRuntime is required for chapter 15 or later` | You assembled it yourself and missed the instance | Pass the `TeammateRuntime` in |
| `cronRuntime must share the JobSupervisor` | You installed two supervisors | Reuse the same instance (reference equality) |
| The teammate reported, but the Lead does not react | The host did not bind the Teammate wakeup, or the Runner is executing a user turn | Check `teammateRuntime.bindWakeup(...)`; for the concurrent case, wait until the current turn ends |
| A file is always present in `lead\processing` | The previous process did not finish | The next `start()` recovers it automatically. You do not need to move it by hand |
| `TeammateRuntime is closed` | You still spawn after shutdown | Check the life cycle. Do not call it after `close()` |
| `Mailbox message id already exists: ...` | The same UUID was sent twice | Check your custom `idGenerator` |

---

## 15 Hands-On Experiments

Do not take my word for any conclusion above. This section turns all of them into output that you can run on your own machine.

**No experiment needs an API key**, because they use a scripted fake model.

### Preparation: create a probe script first

```powershell
cd F:\笔记\Agent实操\code
New-Item -ItemType File -Path scripts\probe-ch15.mts
```

Write the block below into `scripts/probe-ch15.mts`. This is the shared header for all experiments. Write it only once:

```typescript
// scripts/probe-ch15.mts —— the Chapter 15 probe script (temporary; you can delete it after the run)
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMailboxStore } from "../chapters/ch15/src/adapters/mailbox-json.ts";
import { JsonBackgroundJobStore } from "../chapters/ch15/src/adapters/background-json.ts";
import { JsonCronStore } from "../chapters/ch15/src/adapters/cron-json.ts";
import { EventInbox } from "../chapters/ch15/src/core/events.ts";
import { AgentRunner } from "../chapters/ch15/src/core/loop.ts";
import { JobSupervisor } from "../chapters/ch15/src/features/background.ts";
import { CronRuntime } from "../chapters/ch15/src/features/cron.ts";
import { TeammateRuntime, TeammateStatus } from "../chapters/ch15/src/features/teammates.ts";
import {
  MailboxMessageKind, canonicalAgentName, createMailboxMessage,
} from "../chapters/ch15/src/features/mailbox.ts";
import { assistantMessage } from "../chapters/ch15/src/core/messages.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ch15-probe-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Poll until a condition holds, at most 5 seconds; essential for asynchronous experiments
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Make the UUIDs predictable, so the output can be compared
function seqId(start = 0x701): () => string {
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

// A scripted fake model: it returns preset replies in order, and records the requests it receives
class ScriptModel {
  requests: any[] = [];
  #replies: string[];
  constructor(replies: string[]) { this.#replies = [...replies]; }
  async complete(request: any) {
    this.requests.push(request);
    return assistantMessage(this.#replies.shift() ?? "done");
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

// Shared assembly: one inbox, one supervisor, and Cron and Teammate both attach to them
function makeRuntime(root: string, store?: any) {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({
    store: new JsonBackgroundJobStore(root), inbox,
  });
  const cron = new CronRuntime({
    store: new JsonCronStore(root), inbox, supervisor,
    clock: { now: () => new Date("2026-07-30T08:00:00.000Z") },
  });
  const runtime = new TeammateRuntime({
    store: store ?? new FileMailboxStore(root, {
      idGenerator: seqId(), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    }),
    inbox, supervisor, cronRuntime: cron,
  });
  return { inbox, supervisor, cron, runtime };
}
```

You run it as `npx tsx scripts/probe-ch15.mts <experiment name>`, for example:

```powershell
npx tsx scripts/probe-ch15.mts names
```

With no argument, it runs all experiments in sequence:

```powershell
npx tsx scripts/probe-ch15.mts
```

Each of the 15 experiments below appends one block to the script. Each block carries a `section("name")` switch. The blocks do not interfere with each other.

---

### Experiment 1 (names): which names are rejected

Append at the end of the script:

```typescript
if (section("names")) {
  const cases = ["alice", "api-writer", "writer-2", "a", "x1-y2-z3",
    "Lead", "../lead", "lead/other", "nul", "trailing.", "two_words", "-lead", "lead-"];
  for (const raw of cases) {
    try {
      console.log(`${raw.padEnd(14)} -> accepted ${canonicalAgentName(raw)}`);
    } catch (error) {
      console.log(`${raw.padEnd(14)} -> rejected ${(error as Error).message}`);
    }
  }
}
```

```powershell
npx tsx scripts/probe-ch15.mts names
```

Real output:

```text
alice          -> accepted alice
api-writer     -> accepted api-writer
writer-2       -> accepted writer-2
a              -> accepted a
x1-y2-z3       -> accepted x1-y2-z3
Lead           -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
../lead        -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
lead/other     -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
nul            -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
trailing.      -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
two_words      -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
-lead          -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
lead-          -> rejected Invalid or unsafe Agent name; expected a safe lowercase slug
```

**What to verify:**
- A name becomes a directory name directly. So validation must block path escape (`../lead`, `lead/other`).
- The Windows reserved name `nul` is rejected. On Windows, `nul` is a device name. You cannot create an ordinary directory with it.
- A trailing `.` is rejected. Windows silently removes it. The name and the directory name would then disagree.
- Uppercase letters, underscores and leading or trailing hyphens are all rejected. Only one canonical spelling remains. **One teammate has exactly one spelling.**

---

### Experiment 2 (disk): what one message looks like on disk

```typescript
if (section("disk")) {
  await withTempDir(async (root) => {
    const store = new FileMailboxStore(root, {
      idGenerator: seqId(), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const message = await store.send({
      sender: "lead", recipient: "alice",
      kind: MailboxMessageKind.Task, content: "Read the README and list the gaps",
    });
    console.log("send() returns:");
    console.log("  id             =", message.id);
    console.log("  sender         =", message.sender);
    console.log("  recipient      =", message.recipient);
    console.log("  kind           =", message.kind);
    console.log("  eventId        =", message.eventId);
    console.log("  idempotencyKey =", message.idempotencyKey);
    console.log("\nDisk layout:");
    await tree(join(root, "mailboxes"), "  ");
    const file = join(root, "mailboxes", "alice", "ready", `${message.id}.json`);
    console.log("\nFile content:");
    console.log(await readFile(file, "utf8"));
    console.log("toPayload():");
    console.log(JSON.stringify(message.toPayload(), null, 2));
  });
}
```

Real output (the key parts):

```text
send() returns:
  id             = 00000000-0000-4000-8000-000000000701
  sender         = lead
  recipient      = alice
  kind           = task
  eventId        = 00000000-0000-4000-8000-000000000701
  idempotencyKey = 00000000-0000-4000-8000-000000000701

Disk layout:
  alice/
    done/
      (empty)
    processing/
      (empty)
    quarantine/
      (empty)
    ready/
      00000000-0000-4000-8000-000000000701.json

File content:
{
  "id": "00000000-0000-4000-8000-000000000701",
  "sender": "lead",
  "recipient": "alice",
  "kind": "task",
  "content": "Read the README and list the gaps",
  "created_at_utc": "2026-07-30T08:00:00.000Z"
}
```

**What to verify:**
- `id`, `eventId` and `idempotencyKey` **are the same value**. One UUID serves as the message primary key, the event deduplication key and the idempotency key at the same time.
- The system creates all four state directories at once. It does not create them on demand.
- The file contains only six fields. There is no `status` and no `attempts`. **The state lives in the directory name, not in the file.**
- `toPayload()` turns `kind` into `"mailbox"` (the event type) and puts the message type into `message_kind`. The same object speaks with a different identity.

---

### Experiment 3 (states): the four-state transitions and the idempotent ack

```typescript
if (section("states")) {
  await withTempDir(async (root) => {
    const store = new FileMailboxStore(root, {
      idGenerator: seqId(), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const where = async (id: string) => {
      for (const state of ["ready", "processing", "done", "quarantine"]) {
        const files = await readdir(join(root, "mailboxes", "alice", state));
        if (files.includes(`${id}.json`)) return state;
      }
      return "(does not exist)";
    };
    const sent = await store.send({
      sender: "lead", recipient: "alice",
      kind: MailboxMessageKind.Task, content: "task one",
    });
    console.log("send        ->", await where(sent.id));
    const claimed = await store.claim("alice");
    console.log("claim       ->", await where(sent.id),
      " returns", claimed?.id === sent.id ? "the same message" : "a different message");
    await store.release(claimed!);
    console.log("release     ->", await where(sent.id));
    const again = await store.claim("alice");
    console.log("claim again  ->", await where(sent.id));
    await store.ack(again!);
    console.log("ack         ->", await where(sent.id));
    console.log("idempotent duplicate ack -> returns", await store.ack(again!), ", location", await where(sent.id));
    const tampered = createMailboxMessage({ ...again!.toJSON(), content: "tampered content" });
    try { await store.ack(tampered); }
    catch (error) { console.log("ack with different content -> throws", (error as Error).message); }
    console.log("claim on an empty mailbox ->", await store.claim("alice"));
  });
}
```

Real output:

```text
send        -> ready
claim       -> processing   returns the same message
release     -> ready
claim again  -> processing
ack         -> done
idempotent duplicate ack -> returns true, location done
ack with different content -> throws Mailbox message does not match completed message: 00000000-0000-4000-8000-000000000701
claim on an empty mailbox -> undefined
```

**What to verify:**
- Only four legal edges exist between the four states. Each edge is one `rename`.
- `release` really returns to `ready`. The message can be claimed again. **This is the mechanism that protects in-flight work at shutdown.**
- A duplicate ack of the same message returns `true` and does not throw. Replay is safe.
- But an ack of a same-ID message with **different content** **throws explicitly**. This is not leniency. It is the integrity check "the same ID must point to the same content". Leniency would hide data corruption.
- A claim on an empty mailbox returns `undefined`. It does not throw. Having no work is a normal state.

---

### Experiment 4 (fifo): what FIFO sorts by

```typescript
if (section("fifo")) {
  await withTempDir(async (root) => {
    const times = ["2026-07-30T08:00:01.000Z", "2026-07-30T08:00:00.000Z",
      "2026-07-30T08:00:00.000Z"];
    let index = 0;
    const store = new FileMailboxStore(root, {
      idGenerator: seqId(),
      clock: () => new Date(times[Math.min(index++, times.length - 1)]!),
    });
    for (const [i, label] of ["sent first", "sent second", "sent third"].entries()) {
      const m = await store.send({
        sender: "lead", recipient: "alice",
        kind: MailboxMessageKind.Task, content: label,
      });
      console.log(`Send ${i + 1}: id=...${m.id.slice(-4)} created_at=${m.createdAtUtc.toISOString()}`);
    }
    console.log("\nClaim order:");
    for (let i = 0; i < 3; i += 1) {
      const m = await store.claim("alice");
      console.log(`  ${i + 1}. ...${m!.id.slice(-4)}  ${m!.content}`);
    }
    console.log("\nSorting by file name would give: 0701, 0702, 0703 (wrong)");
  });
}
```

Real output (the key parts):

```text
Send 1: id=...0701 created_at=2026-07-30T08:00:01.000Z
Send 2: id=...0703 created_at=2026-07-30T08:00:00.000Z
Send 3: id=...0702 created_at=2026-07-30T08:00:00.000Z

Claim order:
  1. ...0702  sent third
  2. ...0703  sent second
  3. ...0701  sent first

Sorting by file name would give: 0701, 0702, 0703 (wrong)
```

**What to verify:**
- The sort key is `(created_at_utc, id)`, **not the file name**. The timestamp of `0701` is the latest, so the system takes it last.
- When the timestamps are equal, the `id` in lexicographic order breaks the tie: `0702` comes before `0703`.
- If you use the default `readdir` order directly (approximately file name order), you get `0701, 0702, 0703` — **a completely wrong order**.

One side note on why the second sort key must exist: the file system's `readdir` order is **not guaranteed** to be consistent across platforms. Without a deterministic tie-breaker, two messages that arrive in the same millisecond can swap order on different machines. Tests then go red at random.

---

### Experiment 5 (quarantine): one bad message must not block the whole inbox

```typescript
if (section("quarantine")) {
  await withTempDir(async (root) => {
    const dir = join(root, "mailboxes", "alice");
    for (const state of ["ready", "processing", "done", "quarantine"]) {
      await mkdir(join(dir, state), { recursive: true });
    }
    const base = {
      sender: "lead", recipient: "alice", kind: "task",
      created_at_utc: "2026-07-30T08:00:00.000Z",
    };
    const write = async (name: string, body: string) =>
      writeFile(join(dir, "ready", name), body, "utf8");
    await write("00000000-0000-4000-8000-000000000701.json", JSON.stringify(
      { ...base, id: "00000000-0000-4000-8000-000000000701", content: "valid message" }));
    await write("00000000-0000-4000-8000-0000000009fd.json", JSON.stringify(
      { ...base, id: "00000000-0000-4000-8000-0000000009fd", content: "extra field", priority: 3 }));
    await write("00000000-0000-4000-8000-0000000009fe.json", JSON.stringify(
      { ...base, id: "00000000-0000-4000-8000-0000000009fe", recipient: "bob", content: "sent to the wrong place" }));
    await write("00000000-0000-4000-8000-0000000009ff.json", "{ this is not JSON");
    await write("not-a-uuid.json", JSON.stringify(
      { ...base, id: "not-a-uuid", content: "the ID is not a UUID" }));

    const store = new FileMailboxStore(root);
    console.log("ready before claim =", (await readdir(join(dir, "ready"))).length, "files");
    const claimed = await store.claim("alice");
    console.log("claim got        =", claimed?.content);
    console.log("ready after claim  =", (await readdir(join(dir, "ready"))).length, "files");
    console.log("quarantine        =", (await readdir(join(dir, "quarantine"))).length, "files");
    console.log("recoverProcessing ->", await store.recoverProcessing("alice"), "messages back in ready");
    console.log("claim again       =", (await store.claim("alice"))?.content);
  });
}
```

Real output:

```text
ready before claim = 5 files
claim got        = valid message
ready after claim  = 0 files
quarantine        = 4 files
recoverProcessing -> 1 message back in ready
claim again       = valid message
```

**What to verify:**

Four bad files, four ways of being bad, all into `quarantine`:

| File | What is wrong | Why the system must reject it |
| --- | --- | --- |
| `...09fd.json` | It has an extra `priority` field | Zod `.strict()` rejects unknown fields. An extra field means that the code that wrote it and the code that reads it are at different versions |
| `...09fe.json` | `recipient` is `bob`, but the file sits in `alice/ready` | The directory location and the field content contradict each other. Trusting either side causes a delivery error |
| `...09ff.json` | It is not valid JSON | It cannot be parsed |
| `not-a-uuid.json` | `id` is not a UUID | The ID carries the idempotency key. A non-conforming format means no idempotency guarantee |

- **The valid message is still claimed.** A bad message does not block the queue. That is the whole point of this experiment.
- `recoverProcessing` returns 1. Only the valid message that was in `processing` returns to `ready`. The files in quarantine are not pulled back for a retry.
- The quarantined files are kept for human inspection. On write, the system uses a `.quarantine-{index}.json` suffix, so it does not overwrite an existing quarantine record. **Later failures must not wash the evidence away.**

---

### Experiment 6 (trace): the complete two-round collaboration trace

This experiment is the longest. But it reproduces the trace from the opening from start to finish.

```typescript
if (section("trace")) {
  await withTempDir(async (root) => {
    const { inbox, supervisor, cron, runtime } = makeRuntime(root);
    const leadModel = new ScriptModel(["received the gap list", "received the supplementary result"]);
    const lead = new AgentRunner({ /* …the Lead assembly; see the tests in the repo… */ } as any);
    // Key point: connect the mailbox wakeup, so you can see the automatic event turns
    const turns: Promise<unknown>[] = [];
    runtime.bindWakeup(async () => { turns.push(lead.runEvents()); });
    await runtime.start();

    console.log("1. spawn_teammate(alice)");
    const spawned = await runtime.spawn({ name: "alice", role: "writer",
      initialTask: "Read the README and list the gaps" });
    console.log("   ->", JSON.stringify(spawned));

    await waitFor(() => turns.length >= 1, "the first wakeup");
    await Promise.all(turns);
    console.log("2. alice finishes in the background -> the result is written into lead/ready -> an event is published -> the Lead wakes up");
    console.log("   [wakeup 1] Lead.runEvents() ->", leadModel.requests.length, "model requests");
    console.log("   alice status =", runtime.status("alice"));

    console.log("3. The Lead's canonical history:");
    lead.history.forEach((m: any, i: number) =>
      console.log(`     ${i + 1}. ${m.role.padEnd(9)} ${String(m.content).slice(0, 78)}`));

    console.log("4. send_message(to=alice) appends the second round");
    await runtime.send({ sender: "lead", recipient: "alice",
      kind: MailboxMessageKind.Task, content: "Add only the recovery and failure boundaries" });
    await waitFor(() => turns.length >= 2, "the second wakeup");
    await Promise.all(turns);
    console.log("   [wakeup 2] Lead.runEvents() -> receives the supplementary result");
    // …print the number of alice Runners and the round 2 messages…
  });
}
```

The repo's `tests/ch15-teammates.test.ts` contains the matching assertions for a complete runnable version. In the script, copy the test's assembly method.

Real output:

```text
1. spawn_teammate(alice)
   -> {"name":"alice","role":"writer","status":"running"}
2. alice finishes in the background -> the result is written into lead/ready -> an event is published -> the Lead wakes up
   [wakeup 1] Lead.runEvents() -> receives the gap list
   alice status = idle
3. The Lead's canonical history:
     1. user      {"runtime_event":{"kind":"mailbox","message_id":"00000000-0000-4000-8000-000…
     2. assistant receives the gap list
4. send_message(to=alice) appends the second round
   [wakeup 2] Lead.runEvents() -> receives the supplementary result
   Only 1 Runner was ever created for alice
   alice's round 2 messages (round 1 is still there):
     system    You are alice, serving as writer.
     user      Read the README and list the gaps
     assistant The README lacks recovery and failure-boundary documentation
     user      Add only the recovery and failure boundaries
5. Wrap-up: alice status = idle, Lead history length = 4
   lead mailbox, remaining ready = 0
   lead mailbox done = 2
   alice mailbox done = 2
```

The full content of that history entry in step 3 is:

```json
{"runtime_event":{"kind":"mailbox","message_id":"00000000-0000-4000-8000-000000000702","sender":"alice","recipient":"lead","message_kind":"result","content":"The README lacks recovery and failure-boundary documentation","created_at_utc":"2026-07-30T08:00:00.000Z"}}
```

**What to verify:**
- `spawn` returns `status: "running"` immediately. **It does not wait for the teammate to finish.**
- After the teammate finishes, its status becomes `idle`. **It is not destroyed.**
- The second-round `send_message` reuses the same Runner: `only 1 Runner was ever created for alice`.
- In alice's round 2 `messages`, **the three entries from round 1 are still there** (system / user / assistant). So she knows what she said last time. **This is the most essential difference between a persistent teammate and a one-off subagent.**
- In the Lead's history, the teammate's report enters as a `user` message in the form of a serialised `runtime_event`. It is not a conversation that appears from nowhere. It is a structured, traceable event record.
- At wrap-up, both mailboxes have 2 entries in `done`, and `ready` is empty. **The accounts balance: every message that went out was confirmed.**

---

### Experiment 7 (isolate): the contexts of two teammates do not cross

```typescript
if (section("isolate")) {
  await withTempDir(async (root) => {
    const { runtime } = makeRuntime(root);
    // …assemble one Lead, and a ScriptModel for each of the two teammates…
    await runtime.start();
    await runtime.spawn({ name: "alice", role: "writer", initialTask: "Write documentation" });
    await runtime.spawn({ name: "bob", role: "reviewer", initialTask: "Review code" });
    await waitFor(() => runtime.status("alice") === TeammateStatus.Idle
      && runtime.status("bob") === TeammateStatus.Idle, "both teammates finish");
    // …collect the events, print each model's requests…
    // Concurrent same-name spawn
    const results = await Promise.allSettled([
      runtime.spawn({ name: "carol", role: "r", initialTask: "t" }),
      runtime.spawn({ name: "carol", role: "r", initialTask: "t" }),
    ]);
    console.log("Concurrent same-name spawn:", results.map((r) =>
      r.status === "fulfilled" ? "succeeded" : `failed ${(r.reason as Error).message}`));
    for (const bad of ["lead", "Alice", "../x"]) {
      try { await runtime.spawn({ name: bad, role: "r", initialTask: "t" }); }
      catch (error) { console.log(`${bad.padEnd(8)} ->`, (error as Error).message); }
    }
    try { await runtime.send({ sender: "lead", recipient: "zoe",
      kind: MailboxMessageKind.Task, content: "x" }); }
    catch (error) { console.log("send to the non-existent zoe ->", (error as Error).message); }
  });
}
```

Real output:

```text
The Lead received: [ 'alice=alice done', 'bob=bob done' ]
alice's model requests: system You are alice, serving as writer.
                  user   Write documentation
                  tool = send_message
bob's model requests:   system You are bob, serving as reviewer.
                  user   Review code
                  tool = send_message
Concurrent same-name spawn: [ 'succeeded', 'failed Teammate already exists: carol' ]
lead     (reserved name) -> Teammate name lead is reserved for the lead
Alice    (uppercase)   -> Invalid or unsafe Agent name; expected a safe lowercase slug
../x     (path)   -> Invalid or unsafe Agent name; expected a safe lowercase slug
send to the non-existent zoe -> Unknown teammate: zoe
```

**What to verify:**
- alice's requests contain **nothing** of bob's content, and the reverse holds too. Each teammate has an independent `AgentRunner` and independent `messages`.
- Each teammate's `system prompt` carries its own name and role.
- **Of the concurrent same-name spawns, only one succeeds.** Registration is serialised through `#registryTail`. So there is no window between "check whether it exists" and "write it into the registry". This is the classic check-then-act race in concurrent programming. Here it is serialised away.
- `lead` is a reserved name. It reports a dedicated error message, not a generic "the name is invalid". **An error message should tell the person which specific mistake he made.**
- Sending a message to a non-existent teammate **errors immediately**. The system does not silently create a `zoe/ready` directory on disk and let the message rot there.

---

### Experiment 8 (failure): what happens when a teammate crashes

```typescript
if (section("failure")) {
  await withTempDir(async (root) => {
    const { runtime } = makeRuntime(root);
    // The teammate's model throws on its first call
    // …assemble a ScriptModel that throws "model exploded"…
    await runtime.start();
    await runtime.spawn({ name: "alice", role: "writer", initialTask: "a task that will crash" });
    await waitFor(() => runtime.status("alice") === TeammateStatus.Failed, "alice fails");
    // …print the event payload that the Lead received…
    console.log("alice status =", runtime.status("alice"));
    console.log("alice/quarantine =",
      (await readdir(join(root, "mailboxes", "alice", "quarantine"))).length, "files");
    try { await runtime.send({ sender: "lead", recipient: "alice",
      kind: MailboxMessageKind.Task, content: "try again" }); }
    catch (error) { console.log("Sending a message to a failed teammate ->", (error as Error).message); }
  });
}
```

Real output:

```text
The Lead received:
  {"kind":"mailbox","message_id":"00000000-0000-4000-8000-000000000702",
   "sender":"alice","recipient":"lead","message_kind":"result",
   "content":"Teammate alice failed: model exploded",
   "created_at_utc":"2026-07-30T08:00:00.000Z"}
alice status = failed
alice/quarantine = 1 file
Sending a message to a failed teammate -> Teammate alice cannot receive messages while failed
```

**What to verify:**
- The failure **is not silent**. The Lead receives an ordinary `result` message. Its content states the failure reason.
- `message_kind` is still `result`. It is not a new `error` type. The Lead does not need a separate branch for failure.
- The input message enters `quarantine` (with the failure reason). **It does not return to `ready`.** Otherwise, the same poison task would retry without limit and crash the teammate again and again.
- A `failed` teammate refuses new messages. This stops the Lead from piling tasks into a broken mailbox.

---

### Experiment 9 (defer): mailbox events do not mix into the user turn

```typescript
if (section("defer")) {
  await withTempDir(async (root) => {
    const { inbox, runtime } = makeRuntime(root);
    const model = new ScriptModel(["Handled the user request", "Handled the mailbox event"]);
    // …assemble the Lead…
    const message = await runtime.send({ sender: "alice", recipient: "lead",
      kind: MailboxMessageKind.Result, content: "the teammate's report" });
    inbox.publish(message);   // The event is already in the queue

    const first = await lead.run("an ordinary user request");
    console.log("user turn ->", first.finalText);
    console.log("  model request count =", model.requests.length);
    const hasMailbox = JSON.stringify(model.requests[0]).includes("mailbox");
    console.log("  does this request contain a mailbox event =", hasMailbox);
    console.log("  history length =", lead.history.length);

    const second = await lead.runEvents();
    console.log("runEvents() ->", second?.finalText);
    console.log("  model request count =", model.requests.length);
    // …print the history…
    console.log("runEvents() again on an empty inbox ->", await lead.runEvents());
    inbox.publish(message);   // Publish the same event again
    console.log("runEvents() after publishing the same event again ->", await lead.runEvents(),
      ", model request count still =", model.requests.length);
  });
}
```

Real output:

```text
user turn -> Handled the user request
  model request count = 1
  does this request contain a mailbox event = false
  history length = 2
runEvents() -> Handled the mailbox event
  model request count = 2
  history:
    1. user      an ordinary user request
    2. assistant Handled the user request
    3. user      {"runtime_event":{"kind":"mailbox",…
    4. assistant Handled the mailbox event
runEvents() again on an empty inbox -> undefined
runEvents() after publishing the same event again -> undefined, model request count still = 2
```

**What to verify:**
- The event was already in the inbox **before** the user turn. The user turn still did not touch it (`does this request contain a mailbox event = false`). This is not a coincidence of timing. It is the explicit behavior of `allowContextEvents === false`.
- Only `runEvents()` consumes it. And it has its own independent turn boundary (entries 3 and 4 of the history).
- On an empty inbox, `runEvents()` returns `undefined`. It does not throw, and it does not run the model for nothing.
- **Publishing the same event again does not put it into the model again**: `#seenEventIds` has already registered this `eventId`. The model request count stays at 2.

---

### Experiment 10 (ackfail): a failed ack causes no duplicate

```typescript
if (section("ackfail")) {
  await withTempDir(async (root) => {
    // Wrap the store in one layer, so the first ack must fail
    let ackAttempts = 0;
    const inner = new FileMailboxStore(root, {
      idGenerator: seqId(), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const flaky = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop !== "ack") return Reflect.get(target, prop, receiver);
        return async (message: any) => {
          ackAttempts += 1;
          const count = countMailboxInHistory();
          console.log(`  ack attempt ${ackAttempts}: mailbox event entries in the history right now = ${count}`);
          if (ackAttempts === 1) throw new Error("ack persist failed");
          return (target as any).ack(message);
        };
      },
    });
    const { runtime } = makeRuntime(root, flaky);
    // …assemble the Lead, send one teammate message and publish it…
    try { await lead.runEvents(); }
    catch (error) { console.log("The 1st runEvents() throws ->", (error as Error).message); }
    console.log("  model request count =", model.requests.length, "(should be 0)");
    console.log("  messages in the history that contain this id =", countMailboxInHistory());
    const result = await lead.runEvents();
    console.log("The 2nd runEvents() ->", result?.finalText);
    console.log("  total ack attempts =", ackAttempts);
    console.log("  model request count =", model.requests.length);
    console.log("  messages in the history that contain this id =", countMailboxInHistory());
  });
}
```

Real output:

```text
  ack attempt 1: mailbox event entries in the history right now = 1
The 1st runEvents() throws -> ack persist failed
  model request count = 0 (should be 0)
  messages in the history that contain this id = 1
  ack attempt 2: mailbox event entries in the history right now = 1
The 2nd runEvents() -> Processing complete
  total ack attempts = 2
  model request count = 1
  messages in the history that contain this id = 1
```

**What to verify:**

This is the most important experiment in this chapter. Four numbers each prove one thing:

| Observation | What it proves |
| --- | --- |
| At `ack attempt 1`, the history already has 1 entry | **The history comes before the ack**. When the ack is called, the event is already in the history |
| After the 1st throw, the model request count = 0 | Before the ack succeeds, **the model is not called even once**. There is no "the model processed it but it was not confirmed" |
| Between the two attempts, the history count stays at 1 | Re-delivering the same event **does not produce a second history entry** (`#pendingEventAcks` takes effect) |
| In the end, 2 ack attempts and 1 model call | **The retry lands on the ack, not on the model** |

One side note on why this experiment deserves to be written separately: almost all reliable-messaging bugs live on the "persistence failed" path. And normal tests never walk that path. You must **inject the failure actively** to verify it.

---

### Experiment 11 (tools): the tool surface and the pairing checks

```typescript
if (section("tools")) {
  // …build the P14 / P15 capability sets, print the difference set…
  // …build the Lead's and the teammate's ToolRegistry, print each one's tool names…
  // …four wrong assemblies; catch and print each one…
}
```

Real output:

```text
P14 capability bits = artifacts, background, compaction, cron, dynamic_prompt, files, hooks,
             loop, memory, policy, powershell, recovery, skills, subagent,
             task_dag_json, todo, tool_registry
P15 capability bits = the list above + mailbox, teammate
P15 - P14 = ["teammate","mailbox"]
Lead tools (18): shell, read_file, write_file, edit_file, glob, todo_write, task,
  load_skill, create_task, get_task, list_tasks, claim_task, complete_task,
  query_background_job, cancel_background_job, schedule_cron, spawn_teammate,
  send_message
Teammate tools (4): read_file, send_message, shell, write_file
Teammate system prompt = "You are writer, serving as writer."
P15 but teammateRuntime missing -> teammateRuntime is required for chapter 15 or later
P14 but teammateRuntime passed -> teammateRuntime requires chapter 15 or later
Cron with a different supervisor -> cronRuntime must share the JobSupervisor
Teammate not sharing the inbox -> teammateRuntime must share the background supervisor, EventInbox, and CronRuntime
```

**What to verify:**
- `P15 - P14` equals exactly the two new capability bits. **There is no deletion or change.**
- The two new tools sit at the **last two positions** of the Lead's tool table. The order of the first 16 does not change. The prompts and tests that the earlier chapters wrote are not affected.
- The teammate has only 4 tools. It has **no** `spawn_teammate` (it cannot spawn more teammates), **no** `task` (it cannot delegate again), and no Task DAG.
- The four pairing checks **all really throw**. Prefer a startup failure over discovering, after the system runs, that events entered a queue that nobody reads.

---

### Experiment 12 (close): where does in-flight work go at shutdown?

```typescript
if (section("close")) {
  await withTempDir(async (root) => {
    const { runtime } = makeRuntime(root);
    // The teammate's model hangs until we close
    await runtime.start();
    await runtime.spawn({ name: "alice", role: "writer", initialTask: "long task" });
    await waitFor(() => runtime.status("alice") === TeammateStatus.Running, "alice starts running");
    console.log("alice status before close =", runtime.status("alice"));
    await runtime.close();
    console.log("alice status after close =", runtime.status("alice"));
    const store = new FileMailboxStore(root);
    const again = await store.claim("alice");
    console.log("The original task message is back in ready and can be claimed again =",
      JSON.stringify({ content: again?.content, kind: again?.kind }));
    try { await runtime.spawn({ name: "bob", role: "r", initialTask: "t" }); }
    catch (error) { console.log("spawn after close ->", (error as Error).message); }
  });
}
```

Real output:

```text
alice status before close = running
alice status after close = shutdown
The original task message is back in ready and can be claimed again = {"content":"long task","kind":"task"}
spawn after close -> TeammateRuntime is closed
```

**What to verify:**
- The in-flight message **returns to `ready`** (it does not stay in `processing`, and it does not enter `quarantine`). Next time, it can be claimed again.
- The status is `shutdown`. The system distinguishes it from `failed`. **An active shutdown is not a failure.**
- After `close()`, `spawn` errors explicitly. The system does not create a teammate that will never execute.

Compare Experiment 8: the same "not finished" state goes to `quarantine` on a throw, and back to `ready` on shutdown. The decision basis is exactly `this.#closed || signal.aborted` — **shutdown is something we initiated actively. It is not the message's fault.**

---

### Experiment 13 (cross): a consumer in another process takes over

```typescript
if (section("cross")) {
  await withTempDir(async (root) => {
    // Two store instances, simulating two processes that access the same directory
    const first = new FileMailboxStore(root, {
      idGenerator: seqId(), clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const second = new FileMailboxStore(root);
    const sent = await first.send({ sender: "lead", recipient: "alice",
      kind: MailboxMessageKind.Task, content: "shared task" });
    const claimed = await first.claim("alice");
    console.log("first.claim ->", `...${claimed!.id.slice(-4)}`);
    console.log("second.recoverProcessing ->", await second.recoverProcessing("alice"));
    const retaken = await second.claim("alice");
    console.log("second.claim ->", `...${retaken!.id.slice(-4)}`);
    console.log("second.ack ->", await second.ack(retaken!));
    console.log("first.ack (the old consumer acks late) ->", await first.ack(claimed!));
    const tampered = createMailboxMessage({ ...claimed!.toJSON(), content: "different content" });
    try { await first.ack(tampered); }
    catch (error) { console.log("first.ack with a content conflict ->", (error as Error).message); }
    try { await first.send({ sender: "lead", recipient: "alice",
      kind: MailboxMessageKind.Task, content: "send the same ID again" }); }
    catch (error) { console.log("send with the same UUID again ->", (error as Error).message); }
  });
}
```

Real output:

```text
first.claim -> 0701
second.recoverProcessing -> 1
second.claim -> 0701
second.ack -> true
first.ack (the old consumer acks late) -> true
first.ack with a content conflict -> Mailbox message does not match completed message: 00000000-0000-4000-8000-000000000701
send with the same UUID again -> Mailbox message id already exists: 00000000-0000-4000-8000-000000000701
```

**What to verify:**
- Two "processes" share the same directory. `recoverProcessing` lets the second one take over the work that the first one did not finish. **This is the substance of crash recovery.**
- After the second ack succeeds, the first one acks **the same content** again and still gets `true`. A late confirmation from an old consumer does not break the state.
- But an ack of a same-ID message with **different content** throws. **Idempotency is not leniency**: leniency would silently hide the serious problem "two processes disagree about the content of the same message".
- A `send` with the same UUID again is explicitly rejected. The system checks all four directories: `ready`/`processing`/`done`/`quarantine`.

---

### Experiment 14 (restart): cross-process recovery when the host misses the wakeup

```typescript
if (section("restart")) {
  await withTempDir(async (root) => {
    // Run 1: deliberately connect only the cron wakeup, to reproduce the old defect or a host that misses the callback
    {
      const { cron, runtime } = makeRuntime(root);
      cron.bindWakeup(async () => { await lead.runEvents(); });
      // Note: runtime.bindWakeup is deliberately not called
      await runtime.start();
      const result = await lead.run("Send alice to look at the README");
      console.log("Run 1: Lead's answer =", result.finalText);
      await waitFor(() => runtime.status("alice") === TeammateStatus.Idle, "alice finishes");
      console.log("  alice status =", runtime.status("alice"));
      console.log("  Lead history length =", lead.history.length, "(only the user's round)");
      await runtime.close();
      // …print the file counts of the three directories…
    }
    // Run 2: a new runtime instance, the same directory
    {
      const { runtime } = makeRuntime(root);
      await runtime.start();
      // …print the directory state, runEvents(), history entry 1, the done count…
    }
  });
}
```

Real output:

```text
Run 1: Lead's answer = I have already sent alice to look at the README
  alice status = idle
  Lead history length = 2 (only the user's round)
  After shutdown, lead/ready = 0, lead/processing = 1, lead/done = 0
  -> The teammate's result stays in processing. This session did not consume it

Run 2: after start(), lead/ready = 0, lead/processing = 1
  runEvents() -> reads alice's report from last time
  history entry 1 = {"runtime_event":{"kind":"mailbox","message_id":"00000000-0000-4000-8000-000000000702","sender":"ali
  lead/done = 1
```

**What to verify:**
- This is the regression path for a host that misses the Teammate wakeup. The current `cli.ts` binds both kinds of wakeup by default. In the normal case, a teammate report triggers an event turn in the same session.
- **Not one message is lost.** It stops in `processing`. Of the four states, that is the semantically most accurate one: "somebody claimed it, and has not yet confirmed completion".
- `start()` in run 2 does two things: `recoverProcessing` moves it back to `ready`, and `#publishLeadMessages` immediately claims it again — so the printed value **is still `processing = 1`**. This is not "it was not recovered". It was recovered and then claimed again.
- After `runEvents()`, `done = 1`. The loop is closed.

**This cross-process gap is the reason at-least-once delivery exists.** An in-memory dict would drop all of the teammate's work results right here.

To keep the same-session loop closed in your own host, make sure you bind this line:

```typescript
teammateRuntime.bindWakeup(async () => { await runner.runEvents(); });
```

---

### Experiment 15 (concurrent): press it with concurrency

```typescript
if (section("concurrent")) {
  await withTempDir(async (root) => {
    const store = new FileMailboxStore(root, {
      clock: () => new Date("2026-07-30T08:00:00.000Z"),
    });
    const sends = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      store.send({ sender: "lead", recipient: "alice",
        kind: MailboxMessageKind.Task, content: `task ${i}` })));
    console.log("12 concurrent sends -> succeeded", sends.length);
    const claims = (await Promise.all(Array.from({ length: 12 }, () =>
      store.claim("alice")))).filter(Boolean);
    console.log("12 concurrent claims -> got", claims.length, ", after deduplication",
      new Set(claims.map((m) => m!.id)).size);
    console.log("claim once more ->", await store.claim("alice"));
  });
}
```

Real output:

```text
12 concurrent sends -> succeeded 12
12 concurrent claims -> got 12, after deduplication 12
claim once more -> undefined
```

**What to verify:**
- All 12 concurrent `send` calls succeed. None overwrites another.
- The 12 concurrent `claim` calls get 12 **mutually distinct** messages. This is the core guarantee of claim: **the same message is not claimed by two consumers at the same time.**
- After the queue is drained, the call returns `undefined`.

Without the two locks (the in-process promise queue + the cross-process `proper-lockfile`), the most typical failure shape of this experiment is this: two claims get the same message (fewer than 12 after deduplication). Or a `rename` throws `ENOENT` because the target was already moved away.

---

### Clean up after the experiments

The probe script is temporary. After you read the output, you can delete it:

```powershell
Remove-Item scripts\probe-ch15.mts
```

Deleting it does not affect any test in the repo. All conclusions have matching formal assertions under `code/chapters/ch15/tests/`.

---

## What This Chapter Deliberately Does Not Do

The easiest mistake in writing a tutorial is to state "not yet done" as "done". So this section lists the boundaries explicitly.

| Not done | Why | In which chapter |
| --- | --- | --- |
| The `check_inbox` tool | The mailbox is a runtime event source. The model should not guess when to pull | Not done |
| Tools to list / cancel teammates | This chapter verifies only the minimal loop: create, send a message, receive a report | As needed |
| A structured request/response protocol | There are only one-way `task` / `message` / `result` messages now. There is no "wait for an answer" semantics | Chapter 16 |
| Plan approval bubbling | When a teammate wants to do a dangerous operation, it asks the Lead for approval. This needs a two-way waiting channel | Chapter 16 |
| Cross-Agent permission request bubbling | Same as above. It needs a request/response foundation | Chapter 16 |
| The `shutdown_request` / `shutdown_approved` handshake | This chapter's `close()` is in-process resource release. It is not a cross-Agent protocol | Chapter 16 |
| Teammates finding work by themselves from a shared Task DAG | This needs claiming, contention resolution and idle self-drive | Chapter 17 |
| Broadcast / subscription / dynamic topology | This chapter's topology is fixed: one Lead plus several peer teammates | Not done |
| A persistent team registry | Teammate information is entirely inside the `TeammateRuntime` process | Not done |
| Teammates spawning teammates | This would turn the topology into an uncontrollable tree | Not done |

One concept is especially easy to misunderstand, so I state it separately:

> **`idle` only means "the Runner is still there, and waits for the next explicit message". It does not mean "it will go and find work by itself".**

An idle teammate that actively discovers and claims work is the subject of Chapter 17. This chapter's teammates are passive: if you do not send them a message, they stay where they are.

---

## Differences from Claude Code

With reference to the in-depth analysis of the CC source in `s15_agent_teams/README.md` of the external repo [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code), the Teammate/Mailbox of P15 differs from Claude Code's team collaboration mechanism in the following ways, for teaching simplification.

First a quick-reference table, then each item in detail:

| Dimension | CC teaching version | CC real source | P15 |
| --- | --- | --- | --- |
| Storage | One `.jsonl` per Agent | A JSON array + a file lock | One `.json` per message + the four-state directories |
| Reading | The `check_inbox` tool | `useInboxPoller` polls every 1s | Typed event injection + explicit `runEvents()` |
| Delivery semantics | At most once (read+unlink) | Protected by a file lock | At least once + a stable idempotency key |
| Teammate carrier | A daemon thread, ends after 10 rounds | A tmux pane or in-process | An independent `AgentRunner`, not destroyed |
| Message types | 2 kinds | 15 structured types | 3 kinds (`task`/`message`/`result`) |
| Permission bubbling | Omitted | Two-way polling | Reuses the same governance set; no cross-Agent bubbling |

**Storage model.** The CC teaching version uses one `.jsonl` file per Agent as the inbox. Its `read_inbox()` performs read file + `unlink()` consumptive reading. A read/unlink race exists. P15 uses one `.json` file per message. It expresses the message state through the directory name (`ready/processing/done/quarantine`). It protects the atomic `rename` transitions with a file lock. Concurrent writers and claimers are both protected by the lock.

**Public tools.** The CC teaching version exposes three new tools for the Lead: `spawn_teammate`, `send_message`, `check_inbox` (14 Lead tools in total). The P15 Lead tool sequence does not contain `check_inbox`. The mailbox is a runtime event source. Messages are published by the `TeammateRuntime` to the `EventInbox`. The Lead receives them in an explicit event turn. The model does not need to guess when to pull.

**Message reading method.** In the CC teaching version, the Lead pulls messages by calling `check_inbox` explicitly. In the real CC source, `useInboxPoller` checks the inbox once every second. When it detects a message, it automatically submits it as a new turn. No user input is needed. P15 puts mailbox events into the shared `EventInbox`. The host handles them by calling `AgentRunner.runEvents()` explicitly. A normal user turn's drain point only stages events that carry an `idempotencyKey`. A received message does not automatically start a new turn for the Lead.

**Teammate implementation.** A CC teaching-version teammate runs in a daemon thread. It holds a simplified system prompt, an independent messages list and 4 sub-tools. The teaching version limits it to at most 10 conversation rounds, after which it ends automatically. In the real CC source, a teammate is created by `spawnTeammate()`. It can run in a tmux pane or in-process. It waits for inbox messages with an idle loop. Each P15 teammate owns an independent `AgentRunner`. The Runner holds the full history, and the Hook and Recovery/Compaction boundaries. After it finishes a round, it enters the `idle` state instead of being destroyed. Later messages reuse the same Runner and the existing history.

**Message types.** CC teaching-version messages have only two `type` values: `"message"` and `"result"`. The real CC source has 15 structured message types (including `idle_notification`, `permission_request`, `permission_response`, `plan_approval_request`, `shutdown_request/approved/rejected`, `task_assignment`, and others). Text messages are wrapped in a `<teammate-message>` XML tag and delivered to the model. P15's `MailboxMessageKind` has only three kinds: `task`, `message`, `result`. A message also implements the `RuntimeEvent` interface. It is injected into the history through the typed event inbox, not through an XML tag.

**Delivery semantics.** The CC teaching version's `read_inbox` is read + unlink. If the process crashes after reading and before processing, the message is lost permanently (at-most-once delivery). The real CC source protects a JSON array inbox with a `proper-lockfile` file lock. P15 uses one independent file per message + a directory state machine. On restart, `processing` recovers to `ready`. Bad messages are isolated into `quarantine`. At-least-once delivery is achieved through a stable, consistent idempotency key. An idempotent ack of the same done message is allowed.

**Permission bubbling.** The CC teaching version omits permission bubbling. The real CC source uses two-way polling: a teammate sends a `permission_request` to the Lead's inbox. The Lead's `useInboxPoller` detects it and routes it to the approval queue. After the user approves, the Lead sends a `permission_response` back to the teammate. The teammate's `useSwarmPermissionPoller` (every 500ms) receives the reply and continues or rejects. The P15 teammates and Lead reuse the same set of Hook, `PermissionPolicy`, Recovery and Compaction. Cross-Agent permission bubbling is not implemented separately.

**Life cycle and shutdown.** A CC teaching-version teammate is a daemon thread. It ends automatically after 10 rounds. There is no graceful shutdown protocol. A real CC source teammate goes through spawn → work → idle (the Stop hook triggers `idle_notification`) → shutdown (the Lead sends `shutdown_request`; the teammate replies `shutdown_approved` and then cleans up). The P15 teammate state machine is `running → idle → failed/shutdown`. Shutdown is in-process resource release (cancel the in-flight task, release the processing messages). It is not a cross-Agent shutdown handshake protocol.

**Teammate tool surface.** The CC teaching-version teammate tools are bash, read_file, write_file, send_message. A real CC teammate also holds tools such as `TaskCreate` and `TaskUpdate`. The task system is shared by the team. The P15 teammate tools register `shell`, `read_file`, `write_file`, `send_message`. The system explicitly excludes `edit_file`, `glob`, TODO, Skill, subagents, the Task DAG, Cron and `spawn_teammate`. The `send_message` sender comes from the trusted identity, not from the tool input.

**Team registry.** The real CC source stores the team registry through `~/.claude/teams/{teamName}/config.json`. It includes member IDs, colours and activation states. P15 has no persistent team registry. Teammate information and state are managed entirely inside the `TeammateRuntime` process.

The CC implementation details above come from `s15_agent_teams/README.md` of the external repo [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code) and the CC source line numbers that it cites. Claude Code itself is not open source. These line numbers are only a reference snapshot. They do not represent the current implementation.

If you remember only one thing: **CC trades polling + consumptive reading for implementation simplicity. P15 trades event injection + the four-state directories for recoverability.** Both paths have a cost. This chapter chooses the second one, because "a message was lost and nobody knows" is the most expensive failure in a collaboration scenario.

---

## What We Learn from ai-agent-book: Message Envelopes and Observable Collaboration

Chapter 10 of the external repo [`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book), `book/chapter10.md`, is the closest to this chapter: it splits multi-Agent collaboration that does not share context into a data plane and a control plane. It solves asynchronous communication with structured envelopes and a Message Bus. For the description of the companion Experiment 10-4, see `chapter10/parallel-web-research/README.md` in that repo. For the bus implementation, see `message_bus.py` in the same directory.
### The experiment design in ai-agent-book

Chapter 10 of ai-agent-book stresses that a message must not be just a bare string. It must carry a structured envelope. The `Envelope` in `message_bus.py` contains `sender_id`, `target`, `type`, `payload`, `seq` and `ts`. The message types include `task_assigned`, `status_update`, `result`, `terminate` and `ack`. The `MessageBus` forwards messages by subscription relationship. It supports point-to-point delivery and `BROADCAST="*"` broadcast. The `history` keeps the complete message flow. The `short()` function outputs a compact log with timestamps and a global sequence number. This makes every collaboration event in the experiment "visible".

Experiment 10-4 applies this bus to real parallel search: the Manager starts several homogeneous workers dynamically. Each worker uses an independent Playwright browser context. A timeout or a parse failure on a single site does not block its peers. The first `target_found` settles under an `asyncio.Lock`. Only one terminate broadcast is allowed. A later hit is only recorded. It does not settle a second time. After a loser receives the terminate, it cancels at a safe point, sends an ack, and closes its browser context. The README also requires the serial path to access the same batch of real sites and to use the same extraction function. It uses real wall-clock time and resource create/close counts as acceptance evidence.

### P15's comparison and trade-offs

P15 does not copy the central Message Bus. Instead, it lands ai-agent-book's principles — structured messages, an observable history, and resource audit — on a persistent Mailbox:

- **Structured envelope.** ai-agent-book uses `Envelope` to carry sender/target/type/payload. P15's `MailboxMessage` carries `id`, `sender`, `recipient`, `kind`, `content`, `createdAtUtc` and `idempotencyKey`, and implements `RuntimeEvent` directly. `MailboxMessageKind` limits the message type to `task/message/result`. The system does not need to guess the type from a string prefix.
- **Point-to-point vs publish/subscribe.** ai-agent-book's central `MessageBus` supports subscription and broadcast. It suits a dynamic peer set. P15's current topology is fixed: a Lead and several peer teammates. So it uses persistent inboxes for point-to-point delivery. It does not implement `BROADCAST`. It does not let a new Agent subscribe by itself. And it does not let teammates create teammates dynamically.
- **Observability.** ai-agent-book's `history` and timestamped log make the message flow replayable. P15 does not treat the log as the persistent message. It expresses the same thing with the disk `ready/processing/done/quarantine` state directories and the `EventInbox`'s typed history. A test can assert the store state after send/claim/ack/release/quarantine, instead of only looking at printed text.
- **Graceful termination and resource audit.** Experiment 10-4 proves that resources do not leak, with terminate + ack + browser context create/close counts. P15's `TeammateRuntime.close()` cancels and awaits the in-flight workers, releases the processing messages, and tries to close each Runner. Tests assert the `shutdown` state and the retryable cleanup. P15 has no cross-Agent terminate/shutdown handshake. That is left to Chapter 16.
- **Failure isolation.** In ai-agent-book, a single site's failure does not block its peers. In P15, when a teammate's execution fails, the system moves the input into quarantine, sets the state to `failed`, and publishes an observable failure `result` to the Lead. The Lead can continue the collaboration. One teammate's model or tool error does not crash the whole chain.
- **Offline verification vs a real experiment.** ai-agent-book measures the speedup with a real browser and a real serial baseline. It keeps 114 bus events, resource counts and acceptance gates as provenance. P15 focuses on repeatable offline tests: it injects deterministic UUIDs, a UTC clock and a model stand-in. It asserts state transitions, the event flow, the idempotent ack, failure events and resource shutdown. **It does not claim real wall-clock speedup evidence.**

**What P15 explicitly does not do:** there is no central `MessageBus`, no subscription filter, no `BROADCAST`, no `status_update`, no `terminate/ack` bus protocol, and no cross-Agent shutdown handshake. ai-agent-book's broadcast and dynamic topology suit scenarios where the number of Agents is not fixed and the Agents must discover and subscribe by themselves. Chapter 15 first holds this minimal loop: "a fixed team, persistent inboxes, typed event injection into the single Loop".

---

## Companion Code Index

All files that this chapter touches are under `code/chapters/ch15/`. The line counts are the real values of the current snapshot.

| File | Lines | Role |
| --- | --- | --- |
| `src/features/mailbox.ts` | 242 | The `MailboxMessage` domain model, the Zod schema, `canonicalAgentName`, the `MailboxStore` interface |
| `src/adapters/mailbox-json.ts` | 586 | `FileMailboxStore`: the four-state directories, atomic transitions, the two locks, FIFO sorting, quarantine |
| `src/features/teammates.ts` | 598 | `TeammateRuntime`: the registry, the worker life cycle, the two tools, event forwarding |
| `src/core/events.ts` | 77 | The `RuntimeEvent` interface and `EventInbox` (not changed in this chapter, only reused) |
| `src/core/loop.ts` | 714 | `runEvents()`, mailbox deferral, history-before-ack, `#pendingEventAcks` |
| `src/bootstrap.ts` | 403 | The composition root: capability bits, tool assembly, the four pairing checks |
| `src/cli.ts` | 332 | The shared assembly of the two entries, wakeup binding, reverse-order shutdown |
| `src/core/profiles.ts` | 306 | The P15 capability set definition (P14 + `teammate` + `mailbox`) |
| `src/chapters/ch15.ts` | 5 | The chapter entry; only one forwarding line |
| `tests/ch15-mailbox.test.ts` | 181 | Store state transitions, FIFO, concurrency, idempotency, quarantine |
| `tests/ch15-teammates.test.ts` | 343 | Persistent teammates, isolation, concurrent spawn, failure, shutdown |
| `tests/ch15-loop.test.ts` | 170 | The mailbox event turn, deferral, ack failure retry |
| `tests/ch15-bootstrap.test.ts` | 104 | The P14/P15 delta, the tool surface, the four pairing checks |
| `tests/ch15-entry.test.ts` | 108 | The two entries, the polite exit when credentials are missing, and the wakeup wiring |

### Suggested reading order for the code

Read in this order. Each step builds on the previous one. You do not need to flip back:

```text
① src/features/mailbox.ts          First understand "what a message is"
     ↓                              The domain model + validation + the name rules
② src/adapters/mailbox-json.ts     Then look at "how a message is stored"
     ↓                              The four-state directories + atomic transitions + the two locks
③ tests/ch15-mailbox.test.ts       Use the tests to confirm that you understood it correctly
     ↓
④ src/features/teammates.ts        Then "who consumes the messages"
     ↓                              The worker life cycle + the two tools
⑤ src/core/loop.ts:617             Finally, look at the seam (#acceptNextRuntimeEvent)
     ↓                              Deferral + history-before-ack + the half state
⑥ src/bootstrap.ts + src/cli.ts    How it is assembled
```

Step ⑤ is the place in this chapter that most needs slow reading. I suggest that you read it against the output of Experiment 9 and Experiment 10 — **code together with real output is much faster than code alone.**

If you have only 10 minutes, reading the two methods `#transition` in `mailbox-json.ts` and `#acceptNextRuntimeEvent` at `loop.ts:617` is enough. They carry all the core decisions of this chapter.

---

## Run and Verify

This chapter's tests inject deterministic UUIDs, a UTC clock and a model stand-in. **They do not depend on a real OpenAI, a real sleep, or the network.**

All five gates run in the `code` directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch15
npm run typecheck
npm run lint
npm run format:check
npm run build
```

| Command | What it checks | Expected |
| --- | --- | --- |
| `npm run test:ch15` | Behavioral correctness | `44 passed (44)` / `336 passed (336)` |
| `npm run typecheck` | Type completeness | No output means pass |
| `npm run lint` | Biome rules | No errors |
| `npm run format:check` | Uniform formatting | No diff |
| `npm run build` | It compiles and produces output | No errors |

The key assertions are all observable results, not "it looks right":

- The P15 capability set strictly equals P14 plus `teammate` and `mailbox`.
- The Lead tools keep the complete P14 prefix. They only append `spawn_teammate` and `send_message`.
- The teammate tools are strictly `shell`, `read_file`, `write_file` and `send_message`.
- Two teammates execute in parallel. Their histories are isolated. A new message after `idle` reuses the original Runner.
- A concurrent same-name spawn succeeds only once. An invalid name and an unknown recipient fail before any work is created.
- FIFO uses `(created_at_utc, id)`. Concurrent writers do not lose messages. Concurrent claimers do not claim the same message twice.
- A failed replacement in send/claim/ack/release/quarantine/recover keeps the state from before the commit.
- A restart recovers `processing` to `ready`. A bad message enters `quarantine` and does not block valid messages.
- A teammate tool obtains the current Mailbox UUID as a stable idempotency key. An empty key fails before any turn side effect.
- A Mailbox event is accepted by an explicit event turn. It is acked only after it enters the canonical history. An ack failure retry does not duplicate the history or the model call. The same done message across runtimes can be acked idempotently. A content conflict fails explicitly.
- Cron and Mailbox events are confirmed by their own owners, but they share one typed EventInbox.
- A teammate failure isolates the input and publishes an observable failure result to the Lead. `close` cancels, awaits, and leaves the `shutdown` state. A single resource's shutdown failure does not skip the other resources. Multiple exceptions are observable, and shutdown is retryable.
- The CLI's two entries build a shared runtime. They shut down in the order Teammate → Cron → supervisor → model.

---

## Chapter Summary

### The three-sentence version

1. When you add teammates to an Agent, the hard part is not starting a few more model calls. The hard part is **how a teammate's output returns reliably into the Lead's context**.
2. This chapter's answer is: **one file per message, the directory name is the state, atomic `rename` transitions, at-least-once delivery**.
3. A message enters **the canonical history first as a typed event, and is acked after that**. It is processed at an explicit event turn boundary.

### Seven points you must remember

| # | Conclusion | The one-sentence reason |
| --- | --- | --- |
| 1 | The Lead adds only two tools: `spawn_teammate`, `send_message` | There is no `check_inbox`. The model should not guess when to pull messages |
| 2 | A teammate has an independent, reusable Runner and an explicit state machine | `idle` is not destruction. A second-round message reuses the existing history |
| 3 | One file per message, four-state directories, atomic transitions | The state is in the directory name, not in a file field. Changing the state is a `rename` |
| 4 | `processing` recovers on restart, bad messages are isolated, at-least-once delivery | One bad message must not block the whole inbox |
| 5 | Write the canonical history first, then ack | The reverse order causes "message loss without a trace" |
| 6 | Teammate, Cron and Background share one Inbox and one supervisor | Each kind of event is confirmed by its own owner |
| 7 | Shutdown follows the reverse order of the resource dependencies, and tries all resources | When each layer closes, the things it depends on are still alive |

### One diagram to review the whole chain

```text
                      ┌──────────────────────────────────────┐
                      │  Lead AgentRunner (the single Loop)   │
                      │  18 tools                             │
                      └───┬──────────────────────────▲────────┘
        spawn_teammate    │                          │  ⑤ event turn
        send_message      │                          │     (runEvents)
                          ▼                          │
                  ┌───────────────────┐              │
                  │ TeammateRuntime   │              │
                  │  name -> Worker    │              │
                  └───┬───────────▲───┘              │
             ① write   │           │ ④ claim + publish │
                      ▼           │                  │
        ┌─────────────────────────┴──────────────────┴────────┐
        │  Disk Mailbox    .agent/mailboxes/{name}/            │
        │                                                      │
        │   ready ──claim──> processing ──ack──> done          │
        │     ▲                  │                             │
        │     └──── release ─────┤                             │
        │                        └── quarantine (bad message / failure)  │
        └──────────────────────────────────────────────────────┘
                      ▲           │
             ③ write result        │ ② claim the task
                      │           ▼
                  ┌───┴───────────────────┐
                  │ Teammate AgentRunner   │
                  │  4 tools, independent history │
                  └────────────────────────┘

        Shared: EventInbox (one), JobSupervisor (one)
```

Walk through it by the numbers: ① the Lead dispatches work by writing into the teammate's `ready`; ② the teammate claims it and executes it; ③ the result is written into the Lead's `ready`; ④ the runtime claims it and publishes it to the shared Inbox; ⑤ the Lead consumes it in an independent event turn — history first, then ack.

### Check whether you really understood it

Answer the seven questions below without looking anything up. If you cannot answer one, the right column tells you where to look.

| Question | Go back to |
| --- | --- |
| Why must the `ack` come **after** the write into the canonical history? | The crash-timing derivation in "Inbox Injection" |
| Why is the mailbox the only event type that keeps a "half state"? | `#pendingEventAcks` and Experiment 10 |
| What is FIFO's sort key? Why does it need a second key? | "The FIFO Key Is Not the File Name" and Experiment 4 |
| In which cases do `release` and `quarantine` happen, respectively? | "Shutdown Must Put In-Flight Work Back" and Experiments 8 and 12 |
| Why does the `send_message` input have no `from` field? | "The Sender Cannot Be Forged" |
| Why does a normal user turn stage mailbox events? | "The Lead Does Not Need to Poll" and Experiment 9 |
| After a teammate reports, why might the Lead not respond in this session? | The Runner is executing a user turn, or the host missed the Teammate wakeup; see "The Wakeup Loop" and Experiment 14 |

If you can answer all seven, you have the core mechanism of this chapter.

---

After you do all this, a teammate's progress is no longer an easily lost log line. And the Lead does not need to guess, through `check_inbox`, when a message arrives. The host can process it at an explicit event turn boundary.

But the current channel is still **one-way**: a teammate can only report. It cannot ask a question. It cannot do "this operation is risky; I will wait for your approval before I act". The next chapter adds request/response, plan approval and the shutdown handshake on top of this persistent message channel. It turns the collaboration from "reporting" into "conversation".
