An alarm clock does not need you to watch it before it rings.

You set it to 7:00, and you go to sleep, take a shower, and cook. When the time comes, it rings by itself. This is so obvious that you never ask: how does the alarm clock know that the time has come while you are not there?

But when you start to build an Agent system, this question is no longer obvious.

The Agent of Chapter 13 already supports background execution: `npm install` runs for two minutes, and the main loop can still go and read the README. But look back at the **start** of that chain — it is still one tool call from the model. And the model calls a tool because **you spoke first**.

You say one sentence, and the Agent moves once. Tasks like "run the tests every day at 9 in the morning" or "check CI every 30 minutes" have nobody to push them, so the Agent never moves.

Chapter 13 solved "a slow operation must not occupy the Loop". Chapter 14 solves **"the Agent can start work even when nobody speaks"**.

This chapter adds one capability only. It consists of four parts: **one new tool, one cron parsing boundary, one atomic snapshot with an outbox, and one managed scheduler**.

Fix the scope first. This chapter does **time-driven** triggers only: one `schedule_cron` tool, no list, no cancel, no file watching, no Webhook, no jitter, and no automatic expiry. The path by which an event returns to the Loop reuses the `EventInbox` of Chapter 13 completely — **this chapter builds no second event channel**.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaGgUlESgPjKmOwymibl8OkM0NTmiaianiaJ7FQiad5jblyQOeoUlPHDLkp8j9Aqy1nIwXFF5EZs0iaJwlr8ViamSd6w5nbyPD6a1Z4eXM/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you will be able to do after this chapter

1. State the four questions that must be answered after "the right to trigger moves from a human to a scheduler", and what each question is.
2. Explain why a `CronJob` (a time rule) and a `CronEvent` (one due work intention) must be two objects, and at which concrete crash point merging them loses work.
3. State that when DOM and DOW are both constrained in a five-field cron expression, the rule is **OR**, not AND, and give one expression that this rule traps.
4. Describe what a DST gap and a DST fold are, and why "compute on the local calendar + persist UTC instants" handles both cases.
5. State which problem `.cron.lock` solves and which problem `leader.lock` solves, and why one lock is not enough.
6. Explain why an event is **put into the history first and acked afterwards**, and in which window the reverse order loses work.
7. Judge how many events a "every minute" recurring job produces as catch-up events after the Agent was down for three days and restarts.
8. State whether a scheduled task still passes the permission check when it triggers, and which version of the permission rules applies when the rules changed after the job was created.

### What you need first

| Prerequisite | From which chapter | How this chapter uses it |
| --- | --- | --- |
| One turn of the Agent Loop: model -> tool -> result backfill | Chapter 1 | A scheduled trigger does not change this chain; it changes only the start point |
| `ToolDefinition` / Zod `.strict()` schema | Chapter 2 | The five required fields of `schedule_cron` rely on it for the boundary |
| The decision position of `PermissionPolicy` | Chapter 3 | **One focus of this chapter**: a scheduled task still passes this gate when it triggers |
| Pre/PostToolUse Hook order | Chapter 4 | An event-driven turn skips not one step |
| File lock + atomic replacement + fail closed | Chapter 12 | `state.json` follows the same discipline directly |
| `RuntimeEvent` / `EventInbox` / `RuntimeEventPump` | Chapter 13 | **The most critical prerequisite**; cron events travel exactly this path |
| `JobSupervisor.startManaged()` and the close order | Chapter 13 | The scheduler is a managed worker, not a wild `setInterval` |
| Profile capability bits and capability-based injection in the composition root | Chapters 5–13 | P14 connects the whole scheduling runtime through one `cron` capability bit |

If you have time to review one chapter only, review "how an event returns to the same Loop" in Chapter 13. The new material in this chapter concentrates on **where events come from**, while **how events return** is entirely the conclusion of the previous chapter.

### Quick glossary (terms that first appear in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| slot | One concrete due time; this chapter always expresses it as a UTC instant |
| `CronJob` | **A future time rule**. It can trigger countless times. It is a "definition" |
| `CronEvent` | **One work intention that is already due**. It corresponds to one slot only. It is a "fact" |
| `next_run_at_utc` | The next UTC time at which this job should trigger |
| `last_slot_at_utc` | The slot for which an event was last produced; duplicate prevention relies on it |
| outbox | A persistent event queue. An event does not disappear before it is confirmed |
| ack (acknowledgement) | "This event has entered the history"; the system then deletes it from the outbox |
| DOM / DOW | day of month / day of week |
| DST gap | At the spring forward jump, a local time **does not exist** (for example, 02:30 in New York) |
| DST fold | At the autumn fall back, a local time **appears twice** (for example, 01:30 in New York) |
| `durable` | `true` writes into `state.json` and recovers across process restarts; `false` lives in memory only |
| leader | The one session in the same workspace that has the right to produce events for durable jobs |
| event-only turn | One model turn with no user input, triggered by an event |
| misfire | A slot that was missed during downtime; how to handle it after a restart is a policy decision |

### Suggested reading route

```text
Chapter Guide (you are here)
  ↓
① Look at the complete trace of one scheduled trigger first   ← Look at the four messages directly; no abstraction first
  ↓
② Distinguish the three "times"            ← slot / now / next_run; if these mix, everything after becomes a knot
  ↓
③ Add one tool only               ← Five required fields, and why there are no default values
  ↓
④ Five-field expressions: do not rebuild fifty years of boundaries  ← The OR trap of DOM/DOW
  ↓
⑤ Time zones: compute on the local calendar, store UTC      ← The two abnormal cases, gap and fold
  ↓
⑥ Jobs and Events must be separate        ← The most important modelling decision of this chapter
  ↓
⑦ One atomic snapshot + outbox        ← What the state looks like, and how it is written
  ↓
⑧ durable and session-only      ← Two lifecycles
  ↓
⑨ What the two locks each control               ← Snapshot lock vs leader lock
  ↓
⑩ From the outbox to the Agent           ← Into the history first, then ack
  ↓
⑪ Re-authorise at trigger time               ← A scheduled task is not a permission ticket
  ↓
⑫ The managed scheduler and the close order    ← Who is responsible for stopping
  ↓
⑬ Connect it to the composition root                   ← The capability bit, 16 tools, two entry points
  ↓
⑭ Run + 12 experiments + troubleshooting      ← Verify every conclusion above with your own hands
```

---

## Look at the complete trace of one scheduled trigger first

Do not discuss the design yet. Look at the result directly.

The trace below comes from a real run (the output of experiment 9; you can run it yourself later). The scenario is: a one-shot job with the prompt "Check the CI status", creator identity `cron-owner`, time zone `Asia/Shanghai`. When the time comes, nobody speaks, and the Agent moves by itself:

```text
Model request count = 2

 1. user      {"runtime_event":{"event_id":"...0501","job_id":"...0401","kind":"cron",
              "identity":"cron-owner","prompt":"Check the CI status","timezone":"Asia/Shanghai",
              "durable":true,"slot_at_utc":"2026-06-01T12:01:00.000Z"}}
 2. assistant content=(null) toolCalls=[action({"value":"green"})#cron-action]
 3. tool      toolCallId=cron-action CI: green
 4. assistant content="CI is green; no action is needed." toolCalls=[]

Context that the tool saw = [{"identity":"cron-owner","idempotencyKey":"...0501"}]
Runner's own identity = interactive-user
Outbox remainder = 0
```

(The first item is actually one whole line of compact JSON. Line breaks were added here so that the structure is clear. The id suffixes are abbreviated.)

Four messages, two model requests. Look at them one by one. Each one answers a design question.

**Item 1 is all the new material of this chapter.** Note three things:

- Its `role` is **`user`**, not `tool`. This message is not the result of any `tool_call` — it has no corresponding `tool_call` at all, because **nobody called any tool**. Time arrived, and the system injected it from nothing.
- It is **structured JSON**, not the bare string `"Check the CI status"`. `kind`, `identity`, and `slot_at_utc` are all inside it. The model can see that this is a scheduled trigger and which slot it belongs to.
- The `identity` is `cron-owner`, that is, **the person who created this job at that time**.

**Items 2 and 3 show that this is an ordinary tool-call turn.** After it sees the event, the model decides to call the `action` tool. The tool executes normally and backfills normally. **Parameter validation, Hooks, and the permission decision skip not one step.**

**Item 4 is the final answer.** The model gives a conclusion from the real tool result.

The last three lines truly deserve your attention:

```text
Context that the tool saw = [{"identity":"cron-owner","idempotencyKey":"...0501"}]
Runner's own identity = interactive-user
```

The identity of the `AgentRunner` itself is `interactive-user`, but the `identity` that the tool sees during execution is **`cron-owner`**. This is not a bug. It is an explicit design of this chapter: **a scheduled task executes with the identity of its creator, not with the identity of the current interactive user.** In passing, the `idempotencyKey` is filled with the `event_id` of this event — a tool with external side effects can use it as an idempotency boundary.

### The key difference from the trace in Chapter 13

The background-event trace of Chapter 13 has seven messages. This chapter has four. The three missing messages state the difference exactly:

| | Chapter 13 (background completion event) | Chapter 14 (scheduled trigger event) |
| --- | --- | --- |
| Start point | A user spoke one sentence | **Nobody spoke** |
| Before the event | An `assistant` + `tool` placeholder result already exists | The history is **empty**; the event is the first message |
| What the event corresponds to | The late result of a `tool_call` that truly happened | The fulfilment of a **future time rule** |
| The identity in the event | The current interactive user | **The person at the time the job was created** |
| The `EventInbox` used | The same one | The same one |

The last row is the point: **the two chapters share one `EventInbox`**. This chapter builds no separate queue for cron. Where events come from changed; how events return did not change by one word.

### So "who watches the clock"

In the trace above, before message 1 appeared from nothing, these things actually happened:

```text
The scheduler (a managed worker) wakes once per second
  ↓
store.tick(now)  ← Take the current UTC time, and ask "has any job become due"
  ↓
Yes → In the same lock: create a CronEvent, put it into the outbox, advance the job
  ↓
Publish the pending event to the EventInbox
  ↓
Call AgentRunner.runEvents()  ← Wake the Agent
  ↓
The Runner is idle → drain one event → into the history → ack → run the model turn
```

These seven steps are the skeleton of this chapter. Each later section takes one of these steps apart.

---

## Distinguish the three "times"

Before you enter the implementation, you must separate three time concepts. In everyday speech, all three are called "time", but in code they are three different quantities. Mix them, and every later section becomes a knot.

```text
now          ← What time is it now. The input of every scheduler tick
slot         ← When this execution "should run". An attribute of the event
next_run     ← When this job "should run next time". An attribute of the job
```

Use one concrete example to fix the three. Assume a "every minute" job, created at `12:00:30`:

| Time | now | job.next_run | What happened |
| --- | --- | --- | --- |
| At creation | `12:00:30` | `12:01:00` | The first future slot is computed |
| First tick | `12:00:45` | `12:01:00` | `now < next_run`, so nothing happens |
| Second tick | `12:01:02` | `12:01:00` | **It is due**; an event with slot = `12:01:00` is produced |
| In the same migration | `12:01:02` | `12:02:00` | The `next_run` of the job is advanced |

Note line 3: the `slot` of the event is **`12:01:00`**, not `12:01:02`. **The slot is the time at which the execution should happen, not the time at which the system discovered that it was due.** This distinction saves you in two places:

- A "every day at 9:00" job is discovered 8 seconds late because the process was busy. The slot of the event is still `09:00:00`. The model sees "this is the 9 o'clock one", not "this is the 9:00:08 one".
- The judgement "has this slot already been published" compares `last_slot_at_utc`, and it records the slot. If it recorded the discovery time, the same slot could not be deduplicated reliably.

Also note: the first slot computed at creation is `12:01:00`, **not `12:00:30` itself**, and not `12:00:00` either. `next_run` is always the first match point that is **strictly greater than the current time**. "Trigger once at creation" is not the semantics of this chapter.

---

## The essence of the problem: the right to trigger changed

The manually triggered chain is: **Human -> Agent**. If the human is absent, the chain breaks.

The scheduled chain is: **Scheduler -> Agent**. The human has left this chain, and the scheduler is the new trigger.

This one arrow change forces four questions that must be answered. They are not "places that can be optimised". They are **places that will certainly go wrong if you do not answer them**:

| Question | What happens if you do not answer it | Where this chapter answers it |
| --- | --- | --- |
| Who interprets cron expressions and time zones? | "Every day at 9" has no definite answer for which 9 o'clock it is | The five-field expression section + the time zone section |
| After the time arrives, how do you persistently record "this execution is due"? | The process crashes once, and this work disappears forever | Job/Event separation + the outbox |
| What happens to an event while the Agent is busy? | Either the event is lost, or two turns write the history at the same time | From the outbox to the Agent |
| Does a scheduled task still pass the permission check when it calls a tool? | An old job becomes a back door that bypasses the current policy | Re-authorisation at trigger time |

Chapter 14 starts no new Agent Loop. It is strictly equal to the existing capability of Chapter 13, plus one `cron` capability bit, with the scheduler included in the existing asynchronous resource lifecycle. In the end, it forms four boundaries:

```text
schedule_cron tool
    |  Responsible only for argument validation, taking the current identity, and creating a job
    v
JsonCronStore
    |  Saves jobs, next slots, and the durable outbox; one lock wraps the read-modify-write
    v
CronRuntime
    |  The managed scheduler ticks at regular intervals and publishes pending events to the EventInbox
    v
AgentRunner.runEvents()
       Executes event-only turns when idle; tools still pass Hooks and permissions
```

The responsibility boundary of each layer deserves one sentence:

- **The Scheduler judges time and produces events only.** It executes no business tool, and it does not bypass the Agent Loop.
- **The persistent outbox is responsible only for "a work intention cannot disappear from nothing".** It is not responsible for "execute exactly once".
- **`EventInbox` is responsible only for the typed hand-off inside the current process.** It persists nothing.
- **`AgentRunner` is the only entry point for the model, Hooks, permissions, and tool execution.** This chapter changes not one word of that rule.

---

## Add one tool only

Relative to Chapter 13, Chapter 14 appends one tool only: `schedule_cron`.

```typescript
{
  name: "schedule_cron",
  description: "Schedule a recurring or one-shot prompt with a five-field Cron expression.",
  effect: "write",
}
```

There is no `schedule_job` alias, no `list_cron_jobs`, and no `cancel_cron_job`. The end of this chapter, in "What this chapter deliberately does not do", explains why these were not added while the opportunity was there.

The input schema has five fields, **all of them required**:

```typescript
const scheduleCronSchema = z
  .object({
    cron: z.string(),
    prompt: z.string(),
    timezone: z.string(),
    recurring: z.boolean(),
    durable: z.boolean(),
  })
  .strict();
```

| Field | Meaning | Why it cannot have a default value |
| --- | --- | --- |
| `cron` | A strict five-field cron expression | There is no such thing as a "reasonable default period" |
| `prompt` | The work description that the Agent receives when the job becomes due | A scheduled task with an empty prompt is meaningless |
| `timezone` | An IANA time zone name, such as `UTC` or `Asia/Shanghai` | **Defaulting to the host time zone is the trap that this chapter most wants to avoid** |
| `recurring` | `true` for periodic, `false` for one-shot | Guessing wrong in either direction has serious consequences |
| `durable` | `true` recovers across process restarts | "Believed it was saved when it was not" is far more dangerous than an explicit error |

The role of `.strict()` is that **an extra field fails directly**. If the model takes the liberty of adding an `enabled: true`, the system does not ignore it silently. It reports an argument error on the spot.

### Three fields are not filled by the model

The input of `schedule_cron` contains no `identity`, no `id`, and no `next_run_at_utc`. The runtime decides all three:

```text
identity        ← Taken from the current ToolContext.identity; the model cannot forge it
id              ← The runtime generates a UUID
next_run_at_utc ← Computed from the cron expression + the time zone + the current time
last_slot_at_utc ← Fixed to null at creation
```

The `identity` item is especially important. If it were an input field, the model could create a scheduled task that "runs with administrator identity" — and that would bypass the whole permission system. **The creator identity is an observed fact, not a declarable parameter.**

So a `CronJob` has four more fields than the tool input:

```typescript
interface CronJob {
  readonly id: string;               // Generated by the runtime
  readonly cron: string;             // From the input (normalised)
  readonly prompt: string;           // From the input
  readonly timezone: string;         // From the input (validated)
  readonly recurring: boolean;       // From the input
  readonly durable: boolean;         // From the input
  readonly identity: string;         // Observed from the ToolContext
  readonly nextRunAtUtc: Date;       // Computed by the runtime
  readonly lastSlotAtUtc: Date | null; // Advanced by the runtime
}
```

This field set gives a clear owner to "what the definition is", "who created it", "when it triggers next", and "what the previous slot is". It no longer depends on scattered dictionaries inside the process.

### Four typed errors

The error codes that the tool boundary returns are stable, and the model can decide from them:

| Error class | `errorCode` | When it appears |
| --- | --- | --- |
| `CronExpressionError` | `cron_expression_error` | The expression is not five fields, a field is out of range, a range is reversed, or the time zone is unknown |
| `CronStorageError` | `cron_storage_error` | The snapshot is corrupt, the version does not match, an atomic write fails, or the lock is abnormal |
| `CronJobNotFoundError` | `cron_job_not_found` | A referenced job or event does not exist |
| `CronClosedError` | `cron_closed` | schedule/start/tick is called after the runtime has closed |

Note the meaning of the existence of `CronClosedError`: after a close, continued scheduling **must fail explicitly**. It can neither succeed silently nor be ignored silently. Otherwise, an active worker would still exist after `close()` returns, and the close discipline of Chapter 13 would break.

---

## Five-field expressions: do not rebuild fifty years of boundaries

The order of the five cron fields is fixed:

```text
minute  hour  day  month  weekday
 │     │    │   │   └── 0-7 (both 0 and 7 are Sunday)
 │     │    │   └────── 1-12
 │     │    └────────── 1-31
 │     └─────────────── 0-23
 └───────────────────── 0-59
```

This chapter strictly limits expressions to five fields. The syntax and the "next occurrence time" are both given to the locked-version `cron-parser` (`5.6.2`). Lists, ranges, steps, and weekdays are all handled by the mature parser:

```text
* * * * *              Every minute
0 9 * * *              Every day at 09:00 local time
*/15 9-10 * * 1,3,5    Monday, Wednesday, Friday, 09:00-10:59, every 15 minutes
0 9 * * 1-5            Monday to Friday at 09:00 local time
```

Writing your own cron parser is a classic trap. It looks like only five numbers, but its boundary conditions have been stepped on again and again for fifty years: what to do with `*/0`, whether `8-2` crosses a month, whether both `0` and `7` are Sunday, and whether 30 February exists. **These are not what this chapter teaches.** Give them to a dependency.

### But close the validation yourself

The dependency is responsible for the syntax. This chapter is responsible for **failing before it writes state**. Measured rejection paths, all of them:

```text
* * * *          -> Cron expression must contain exactly five fields
* * * * * *      -> Cron expression must contain exactly five fields
61 * * * *       -> Invalid Cron expression: 61 * * * *
*/0 * * * *      -> Invalid Cron expression: */0 * * * *
0 9 8-2 * *      -> Invalid descending Cron range
0 9 * 13 *       -> Invalid Cron expression: 0 9 * 13 *
0 9 * * 8        -> Invalid Cron expression: 0 9 * * 8
```

Note that two of these are added by this chapter itself, not given by `cron-parser`:

- **Exactly five fields.** The six-field `* * * * * *` (with seconds) is legal in some cron implementations. This chapter rejects it explicitly. Allowing two field counts would turn "is the first field minutes or seconds" into a guessing game.
- **Descending ranges.** Some implementations interpret `8-2` as "8 to the end of the month + the start of the month to 2". This implicit boundary crossing is easy to write by mistake, and it produces no error. This chapter rejects it directly.

**Bad input must not write state first and wait for the scheduler to fail later.** This is a general discipline: a validation failure must happen before any persistence. Otherwise, the disk holds a zombie job that can never trigger.

### DOM and DOW are OR, not AND

This is the most famous trap of five-field cron, and it deserves its own section.

- DOM is day of month, that is, "which day of the month".
- DOW is day of week, that is, "which day of the week".

Standard cron uses **OR** when **both are constrained**. Look at this expression:

```text
0 9 1 * 1
     ↑   ↑
  day 1  Monday
```

Intuition reads it as "9 o'clock on the first Monday of every month". **It is not.** Its actual meaning is:

```text
09:00 on day 1 of every month  ✅
        or
09:00 on every Monday   ✅
```

Measured verification (2026-06-08 is a Monday):

```text
0 9 1 * 1  after 2026-06-02T00:00:00Z -> 2026-06-08T09:00:00.000Z
```

Searching forward from 2 June, the next occurrence is **8 June** (a Monday), not 1 July. With AND semantics, the answer would be "the first day in July that is both day 1 and a Monday" — and that would need a long wait.

The rule is:

| DOM | DOW | Semantics |
| --- | --- | --- |
| `*` | `1-5` | Look at DOW only |
| `15` | `*` | Look at DOM only |
| `1` | `1` | **Both count; take the union** |

OR takes effect only when **neither of the two fields is a wildcard**. This is also the judgement condition of `matchesCronFields` in the implementation.

### One corollary: five-field cron cannot express "the first working day of every month"

Because DOM/DOW is OR, it can only **enlarge** the match set. It can never express "satisfy both conditions at the same time". So five-field cron cannot do any of these requirements:

```text
The first working day of every month      ✗
The last Friday of every month      ✗
The first day of every quarter          ✗
```

A real business calendar also involves public holidays, adjusted holidays, and make-up working days. An **independent calendar rule** should handle those; they do not belong inside a cron expression. Forcing an approximation with cron gives you only a schedule that is "right most of the time" — and the price of one wrong scheduling is usually not small.

The correct method is: cron is responsible for a "frequent enough coarse filter", and the business logic is responsible for "does today truly count". For example, trigger with `0 9 1-5 * *`, and then let the Agent judge in the prompt whether today is the first working day of this month. **Put the calendar judgement into the prompt, not into the expression.**

---

## Time zones: compute on the local calendar, persist UTC

"Every day at 9" has no complete meaning without a time zone. 9 o'clock in Shanghai, 9 o'clock in London, and 9 o'clock in New York are three different instants.

So `timezone` is a required IANA time zone name. Measured results for the same `0 9 * * *` in four time zones:

```text
UTC                0 9 * * * -> 2026-06-01T09:00:00.000Z
Asia/Shanghai      0 9 * * * -> 2026-06-01T01:00:00.000Z
Europe/London      0 9 * * * -> 2026-06-01T08:00:00.000Z
America/New_York   0 9 * * * -> 2026-06-01T13:00:00.000Z
```

Four different UTC times, and all four are "9 in the local morning". Shanghai is 8 hours ahead of UTC, so 9 in Shanghai is 1 in UTC; the 9 of New York (in June it is daylight saving time, UTC-4) is 13 in UTC.

An unknown time zone fails on the spot:

```text
Mars/Olympus -> Unknown Cron timezone: Mars/Olympus
```

### Two steps: compute locally, store UTC

The core strategy is one sentence: **compute in the local calendar, and persist the result as a UTC instant.**

```typescript
function nextCronOccurrence(expression: string, timezone: string, afterUtc: Date): Date {
  const normalized = validateCronExpression(expression);
  const iterator = CronExpressionParser.parse(normalized, {
    currentDate: afterUtc,                        // The base is a UTC instant
    tz: validateCronTimezone(timezone),           // But advance in the calendar of this time zone
  });
  return adjustDstOccurrence(normalized, timezone, afterUtc, iterator.next().toDate());
}
```

Why not the reverse (convert to a local time string first, then compute)? Because **a local time string loses information**. `"2026-11-01 01:30"` in New York corresponds to two different UTC times, and one string cannot hold two answers.

All persistent fields — `next_run_at_utc`, `last_slot_at_utc`, `slot_at_utc` — must be UTC ISO strings. The runtime rejects an invalid `Date` (a `new Date("bad")` produces an error directly), and it never saves a local minute string that carries no time zone meaning.

### DST gap: the hour that does not exist

At the spring forward jump, the clock jumps directly from 02:00 to 03:00. **The local time 02:30 simply does not exist on that day.**

8 March 2026 in New York is such a day. What happens to a `30 2 * * *` job (every day at 02:30)?

```text
30 2 * * * @America/New_York
  after 2026-03-07T08:00:00Z -> 2026-03-08T07:00:00.000Z
```

Converted to New York local time, `2026-03-08T07:00:00Z` is **03:00** (that day is already UTC-4). The strategy of this chapter is: **advance to the first valid time**.

A comparison of the three available strategies:

| Strategy | Result | Problem |
| --- | --- | --- |
| Skip that day | No execution on 8 March | "Every day" becomes "every day except that day"; one execution is silently missed |
| Report an error | Throw an exception | A date that occurs twice a year crashes a normal job |
| **Advance to a valid time** | Execute at 03:00 | 30 minutes late that day — **the smallest cost** |

Choose the third. The reason is: the semantics of a scheduled task is usually "do it once at about that time". Half an hour late is far better than "not done that day" or "the whole job crashed".

### DST fold: the hour that appears twice

At the autumn fall back, the clock goes from 02:00 back to 01:00. **The local time 01:30 appears twice on that day.**

1 November 2026 in New York is such a day. Measured behavior of a `30 1 * * *` job:

```text
First  -> 2026-11-01T05:30:00.000Z   ← local 01:30 EDT (UTC-4)
Second -> 2026-11-01T06:30:00.000Z   ← local 01:30 EST (UTC-5)
```

**The same local clock face, two different UTC instants, and both are kept.**

This is exactly the value of "UTC persistence". If the state stored the local time string `"01:30"`, then at the second tick you would find "`last_slot` is 01:30, and now it is also 01:30; it looks like a duplicate, so skip it" — and **one execution would be silently missed**. Store a UTC instant, and the problem does not exist: `05:30Z` and `06:30Z` are two clearly different values.

But this also needs a clear statement: this chapter does **no** special "execute once only" handling for a fold. A "every day at 01:30" job executes twice on the fall-back day. This is the result of carrying the rule "the UTC instant is the only truth" through to the end. It is not an omission. If the business cannot tolerate it, the correct method is to make the job itself idempotent (deduplicate with the `idempotencyKey`), not to let the scheduler guess.

The tests fix these result sets, so **the local time zone of the host does not affect the assertions**. This matters especially on CI: the development machine is in Shanghai, CI is in UTC, and the test results must be identical.

---

## Jobs and Events must be separate

This is the most important modelling decision of this chapter.

A `CronJob` is **a future time rule**: it can trigger countless times, and it describes "when something should be done".
A `CronEvent` is **one work intention that is already due**: it corresponds to one slot only, and it is a fact that has already happened.

The two cannot share one state.

```typescript
interface CronEvent extends RuntimeEvent {
  readonly kind: "cron";
  readonly eventId: string;      // The unique id of this trigger
  readonly jobId: string;        // Which rule it comes from
  readonly identity: string;     // The creator
  readonly prompt: string;       // What to do
  readonly timezone: string;     // The time zone set at that time
  readonly durable: boolean;
  readonly slotAtUtc: Date;      // The time at which it should execute
}
```

### Why they cannot be merged into one

Assume that you take a shortcut and use one `CronJob` object only, with a `pending: true` field that means "due but not yet executed". Look at what happens to a one-shot task:

```text
Time arrives → mark pending=true
       → hand it to the Agent for execution
       → execution completes; the job is one-shot, so delete the definition
```

The problem is where to place the "delete the definition" step.

**Option A: delete the definition first, then execute.**

```text
Time arrives → delete the job → 💥 process crash → restart
                                 ↓
                        Nothing is on the disk anymore
                        This work disappears forever
```

**Option B: execute first, then delete the definition.**

```text
Time arrives → execute → 💥 crash before the deletion → restart
                                  ↓
                         The job still exists and looks unexecuted
                         This work executes twice
```

Both options are wrong, and **they are wrong however you order them**, because "the definition" and "this work intention" are bound to the same record. You have one atomic-write opportunity only, but you must express two things at the same time.

Separate them, and the problem is solved:

```text
Time arrives → In the same atomic write: { create an event into the outbox } + { delete the job definition }
       → crash → restart → the definition is gone (correct; a one-shot job must not trigger again)
                      the event is still in the outbox (correct; this work is not done yet)
       → continue execution → after execution, ack → only then is the event deleted from the outbox
```

**The lifecycle of a definition and the lifecycle of a work intention are different by nature, so they must be two objects.**

### One atomic migration at the due time

`store.tick(now)` completes these actions inside **the same lock and the same atomic write**:

```text
1. Find all jobs with next_run_at_utc <= now
2. Sort by next_run_at_utc (by id when equal), so the order is fixed
3. Create a CronEvent with a stable UUID for the earliest due slot
4. Put the event into the outbox
5a. recurring → update last_slot_at_utc, and advance next_run_at_utc to after now
5b. one-shot  → delete the job definition (but the event stays in the outbox)
6. Persist to disk only when a durable event was truly produced
```

The sorting in step 2 is not optional. When several jobs become due at the same time and the order is not fixed, "who gets squeezed out" when the outbox capacity fills becomes random, and tests cannot be written.

Step 6, "persist to disk only when a durable event was truly produced", is a small optimisation, and also a correctness requirement: with no change, do not write the file, and avoid a meaningless atomic replacement once per second.

### Repeated ticks do not rely on a string marker

A common wrong implementation uses a string like `"%H:%M"` to record "this time today was already published". This chapter does not need that, because **after the first migration, the state of the job has already changed**:

- The `next_run_at_utc` of a recurring job has advanced to after `now`. At the next tick, `next_run > now`, so it is not due.
- The definition of a one-shot job has been deleted. At the next tick, the system cannot find it at all.

Measured:

```text
One-shot creation: next=2026-06-01T12:01:00.000Z
tick -> produces 1 event, slot=2026-06-01T12:01:00.000Z
Does the definition still exist: deleted
outbox: 00000000-0000-4000-8000-000000000501
Tick once more -> 0 events
```

**Duplicate prevention is the natural result of the state migration, not an extra marker layer.** One marker layer fewer means one "marker and state disagree" failure mode fewer.

### Down for three days: catch up with one only

If the Agent restarts after three days of downtime, how many catch-up events does a "every minute" recurring job produce?

A naive implementation computes "three days = 4320 minutes", then **produces 4320 events at once** and bursts the outbox and the context completely.

The answer of this chapter is **1**. Measured:

```text
At creation, next = 2026-06-01T12:01:00.000Z
Power on after three days, now = 2026-06-04T12:01:00.000Z
1 catch-up event, slot = 2026-06-01T12:01:00.000Z
lastSlotAtUtc = 2026-06-01T12:01:00.000Z
nextRunAtUtc  = 2026-06-04T12:02:00.000Z  (> now: true)
```

Note three details:

- The slot of the event is **`06-01T12:01`**, that is, **the earliest missed slot**, not "now". The model can see that this is a late trigger.
- `last_slot_at_utc` also records that earliest slot.
- `next_run_at_utc` is advanced directly to **`06-04T12:02`**, that is, the first match point after `now`. The 4319 slots in between are **explicitly abandoned**.

This is a misfire policy choice. Its name is "catch up with the earliest one only, then catch up to the present". Its reason is: the value of a scheduled task usually lies in "what the state is now", not in "completing every minute of history". For a "check CI every minute" task, 4320 catch-up runs are meaningless — you need to know only what the CI state is now, plus one hint that "a period was missed just now".

Keeping the earliest one instead of "publishing one current one only" lets the model know **how long was missed**: the difference between `slot_at_utc` and the current time is the downtime length.

---

## One atomic snapshot: state.json plus the outbox

The durable state has one file only:

```text
workspace/.agent_tutorial/cron/state.json
```

It is the **single authoritative snapshot** of the durable jobs and the durable outbox. Note the difference from Chapter 13 here: Chapter 13 uses "one file per job"; this chapter uses "all state in one file". The reason comes later.

### What it looks like

The two blocks below are measured output (not illustrations). A recurring job for "every day at 09:00 UTC", just after creation:

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "00000000-0000-4000-8000-000000000401",
      "cron": "0 9 * * *",
      "prompt": "check CI",
      "timezone": "UTC",
      "recurring": true,
      "durable": true,
      "identity": "user",
      "next_run_at_utc": "2026-06-02T09:00:00.000Z",
      "last_slot_at_utc": null
    }
  ],
  "outbox": []
}
```

The `outbox` is empty (not due yet), and `last_slot_at_utc` is `null` (not triggered yet).

Push time forward to `2026-06-02T09:00:00Z`, and tick once:

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "00000000-0000-4000-8000-000000000401",
      "cron": "0 9 * * *",
      "prompt": "check CI",
      "timezone": "UTC",
      "recurring": true,
      "durable": true,
      "identity": "user",
      "next_run_at_utc": "2026-06-03T09:00:00.000Z",
      "last_slot_at_utc": "2026-06-02T09:00:00.000Z"
    }
  ],
  "outbox": [
    {
      "event_id": "00000000-0000-4000-8000-000000000501",
      "job_id": "00000000-0000-4000-8000-000000000401",
      "identity": "user",
      "prompt": "check CI",
      "timezone": "UTC",
      "durable": true,
      "slot_at_utc": "2026-06-02T09:00:00.000Z"
    }
  ]
}
```

Three changes, completed in one atomic write:

```text
next_run_at_utc:  06-02 → 06-03    ← advanced to the next day
last_slot_at_utc: null  → 06-02    ← remember that this slot was published
outbox:           []    → [event]  ← the work intention is on disk
```

**These three changes must take effect at the same time.** If `next_run` advances but the event is not persisted, this work is lost. If the event is persisted but `next_run` does not advance, the next tick publishes it again. This is exactly the answer to "why one file and not several files": **they must be committed together in one atomic replacement.**

Note in passing that the persistence format uses snake_case (`next_run_at_utc`), while the TypeScript interface uses camelCase (`nextRunAtUtc`). Each layer has its own naming convention, and the store converts between them.

### How it is written

`JsonCronStore` uses a `proper-lockfile` directory lock inside the workspace to wrap the whole "read → judge due → create event → advance job → persist" process. The write does not overwrite the target file directly:

```typescript
const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
handle = await open(temporary, "wx");   // wx: fail if the file already exists
await handle.writeFile(content);
await handle.sync();                    // Force a flush to storage
await handle.close();
await rename(temporary, path);          // A rename in the same directory is an atomic operation
```

All four details have meaning:

| Step | Why |
| --- | --- |
| A temporary file with a random name | Two processes writing at the same time do not collide on the same temporary file |
| The `"wx"` flag | Fail if the temporary file already exists; do not overwrite the intermediate state of another process |
| `handle.sync()` | The content truly reaches storage, instead of staying in the page cache |
| A `rename` in the same directory | A rename within one file system is atomic; no "half a file" appears |

Within the replacement failures that the current process can observe and the ordinary process-restart boundary, one write either commits the complete new snapshot or keeps the old bytes. The tests make the atomic replacement fail on the schedule, tick, and ack paths respectively, and they verify that the jobs, the outbox, and the **old file bytes** do not drift.

### Which layer the durable promise reaches

This must be stated clearly, to avoid an excessive promise.

`durable` does **not promise** host power-loss or kernel-crash level persistence. The implementation syncs the temporary file, but it does **not additionally sync the parent directory** — in an extreme case, the rename itself may not have reached the disk yet.

What it promises is: **after the Agent process exits normally, exits abnormally (`Ctrl+C`, killed), or restarts, it can recover from the committed snapshot.**

This boundary is sufficient for the scenario of this chapter. Power-loss level persistence needs an `fsync` of the parent directory, and its cost is one extra sync per write. The consequence of losing one scheduled trigger is usually far smaller than the cost of "one extra fsync per second". **This is an explicit trade-off, not an oversight.**

### Bad state is not silently ignored

A corrupt `state.json` always throws `CronStorageError`. The trigger conditions include:

```text
Unknown field        ← requireExactKeys; one extra key fails
Wrong version number      ← version is not 1
Duplicate id         ← two jobs or events share an id
Invalid job        ← next_run is not later than last_slot, or a time is not in UTC format
Non-UTF-8        ← TextDecoder in fatal mode
Bad JSON         ← parsing fails
Non-durable record  ← a durable:false record appears in the snapshot
```

"Silently skip bad state" looks more robust. In practice it is more dangerous: the caller **wrongly believes that the tasks were recovered**, while in fact a few are missing. This is the **fail closed** rule that Chapter 12 set: state is either completely trustworthy or completely unusable.

The `version` item deserves a special mention. If the snapshot format changes in the future, old code that reads `version: 2` will **report an error explicitly**, instead of interpreting v2 data by the v1 rules. A test covers exactly this: change `version` to `2` by hand, and the read throws `CronStorageError`.

### The outbox has a capacity limit

The default is 50 entries. The behavior at full capacity is the key:

```text
A later due job keeps its original next_run_at_utc and last_slot_at_utc
Retry after an event is acknowledged
```

**You must not advance the time first and then drop the work.** Measured (capacity set to 1, two jobs due at the same time):

```text
Capacity 1, two jobs due at the same time -> 1 event produced (first)
first  next: 2026-06-01T12:02:00.000Z (advanced)
second next: 2026-06-01T12:01:00.000Z (did not move: true)
Tick again after ack -> 1 event produced (second)
```

The `next_run_at_utc` of `second` does not move at all. After the event of `first` is acked and the outbox has room, the next tick adds the event of `second`.

If the implementation were "when the capacity is full, skip this job but still advance next_run", then this work would silently disappear — and **everything would look normal**, because the state of the job would be "already processed up to 12:02". Bugs of this kind are extremely hard to find.

---

## durable and session-only are two lifecycles

The `durable` boolean decides where a job and its events live.

`durable=true`: the job, the next slot, and the pending events are written into `state.json`. A new `JsonCronStore` can recover them.

`durable=false`: the job and the outbox **exist in the memory of the current store instance only**. They disappear when the process or the session ends, and they do not mix into the durable snapshot.

Measured comparison (two jobs created at the same time and due at the same time, then the store is rebuilt):

```text
durable job = 00000000-0000-4000-8000-000000000401
session job = 00000000-0000-4000-8000-000000000402
Outbox in the same instance = 0501:durable, 0502:session
Jobs after rebuild   = 0
Outbox after rebuild = 0501:durable
```

Line 3: in the same store instance, both events exist. Line 5: after the rebuild, **only the durable one remains**. The session-only event disappeared cleanly, with no residue and no error.

(The `jobs` count becomes 0 because both jobs are one-shot, and their definitions were deleted when they became due. The durable **event** stays in the outbox — that is exactly the Job/Event separation of the previous section.)

### durable does not mean "it still runs while the application is closed"

This is the point that is most easily misunderstood, and it must be stated clearly.

```text
❌ durable = I close the Agent, and at the set time it starts and executes by itself
✅ durable = The next time I start the Chapter 14 Agent, the rule and the unacknowledged events are still there
```

The scheduler belongs to the Agent process. **When the process stops, no code watches the clock.** A "every day at 9" durable job, if you close the Agent from Monday evening to Friday morning, executes nothing at 9 on Tuesday, Wednesday, or Thursday. At the Friday start, it publishes **one** catch-up event by the misfire strategy of the previous section.

True "trigger while powered off" needs operating-system level scheduling (Windows Task Scheduler, a systemd timer, a cron daemon). That is a different layer, and this chapter explicitly does not do it.

### When to use which

| Scenario | Which to choose | Reason |
| --- | --- | --- |
| "Check the dependency updates every morning" | `durable=true` | It is a long-term rule; it should continue after a restart |
| "Remind me in 20 minutes to look at this PR" | `durable=false` | It is meaningful for the current session only |
| "Poll this deployment every 5 minutes" | `durable=false` | When the session ends, no polling is needed |
| "Generate the weekly report every Monday" | `durable=true` | A long-term commitment across sessions |

One practical criterion: **does the meaning of this task depend on the current conversation context?** If it depends, use session-only. If it does not, use durable. The benefit of session-only is that the disk does not accumulate a pile of jobs that you forgot long ago.

---

## What the two locks each control

The same workspace can have several Agent sessions open at the same time. That brings two **completely different** problems, so two locks are needed.

| Lock | The thing on disk | What it is responsible for |
| --- | --- | --- |
| Snapshot lock | `.agent_tutorial/.cron.lock` | Protects the atomic read-modify-write of the durable snapshot |
| Leader lock | `.agent_tutorial/cron/leader.lock` | Limits one workspace to one durable scheduler |

The path that the code passes to `proper-lockfile` is `cron/leader` (an ordinary directory), and the library creates `leader.lock` right beside it as the lock body. So "leader lock" and `leader.lock` are the same thing, and the two names are used interchangeably below.

### Why one lock is not enough

Look first at what each one prevents.

**The snapshot lock prevents "writing a bad file at the same time".** Two sessions both modify `state.json`. Without serialisation, the write of one overwrites the write of the other. The hold time of this lock is **extremely short** — it covers one read-modify-write only.

**The leader lock prevents "the same slot is delivered twice".** Assume that two sessions both run a scheduler. At 9 o'clock, both discover that a job is due, and both create an event — **the same work executes twice**. The hold time of this lock is **very long** — the whole lifecycle of a session.

What if only the snapshot lock existed? The ticks of two sessions are serialised. The first executes first and advances `next_run` to tomorrow. The second takes the lock and finds `next_run > now`, so it is not due, and it does nothing.

**Wait — is that not also correct?**

In most cases, it is. But it depends on one assumption: that both sessions see the same state. Session-only jobs break that assumption — they live in memory, not in the snapshot. More importantly, **correctness that relies on the snapshot lock alone comes from "the order happened to be right", not from an explicit rule.** Once operations like "query the job list" and "cancel a job" are added later, deduplication that relies on state inference starts to show gaps.

The leader lock turns this into an explicit rule: **only the leader produces events for durable jobs.** Measured:

```text
Session A drain: 0501
Session B drain: (empty)
A closes, the leader is released
Session B ticks again: 0501
Outbox after ack: 0 entries
```

A took the leader role and produced and took the event; B took nothing. **After A closed, the leader was released**, and B took over on its next tick — and it took **the same event `0501`**, because A did not ack before it closed, so the work intention is still in the outbox.

The last line is the fulfilment of the whole persistence design: **the leader changes, and the work is not lost.**

Note that the sessions of B can still handle their own session-only jobs in every case — the leader lock controls durable jobs only. This is reasonable: a session-only job belongs to the session that created it by nature, so no duplicate-delivery problem exists.

### A third layer: in-process mutual exclusion

One process can also hold several `JsonCronStore` instances (for example, in tests, or when one process opens two workspaces). They serialise with `withMutex` first:

```text
withMutex (in-process)  ← Several store instances in one process compete for the same session Map and snapshot
    ↓
.cron.lock (cross-process) ← Different processes compete for the same file
```

Why is this layer needed? Because `proper-lockfile` is a **cross-process** lock. Two instances in the same process might both believe that they hold the lock. One layer of in-process mutual exclusion patches this gap.

### The concrete lock parameters

```text
stale:  30_000 ms   ← A lock with no update for more than 30 seconds is stale (the holder crashed)
update: 10_000 ms   ← Refresh "I am still alive" once every 10 seconds
retry:  10 ms × 100 ← If the lock is not acquired, retry at most 100 times, with a 10 ms interval each time
```

The `stale` mechanism is necessary: if a process is killed with `kill -9`, its lock file is not cleaned up. Without a stale mechanism, this workspace would be locked forever. 30 seconds with a 10-second refresh means that "three refreshes fail in a row" judges the lock stale — enough to tolerate one GC pause or one disk jitter.

100 times × 10 milliseconds = a wait of at most 1 second. Beyond that, the code throws `CronStorageError`. This limit is also deliberate: **if the lock is still not acquired after one second, a more serious problem exists**, and continuing to wait would only expose the error later.

The occasional `EBUSY` / `EPERM` on Windows (an antivirus program or an indexing service holding the file) is absorbed by exactly these 100 retries. That is the practical benefit of the retry mechanism.

---

## From the outbox to the Agent: into the history first, then ack

The responsibility of `CronRuntime.tick()` is narrow. It has four steps only:

```text
① Confirm that it is the leader (needed for durable jobs)
② store.tick(clock.now())        ← Judge due, create events, advance jobs
③ Publish the currently deliverable pending events to the shared EventInbox
④ If a wakeup is bound, call AgentRunner.runEvents()
```

Step ③ has an in-process deduplication: `#queued` is a `Set`, and an `eventId` that was already published does not enter the inbox again. This solves the case "the event is already queued in the inbox but not yet acked, and the next tick sees it still in the outbox".

`EventInbox` is the session-local typed FIFO that Chapter 13 introduced. **P14 creates no second cron queue.** Background events and cron events share the same narrow channel, and their state models stay independent.

### The order in which an event enters the Loop

```text
Drain one RuntimeEvent from the EventInbox
  ↓
Validate the event_id, the identity, and the idempotency key
  ↓
Serialise it as an ordinary user message, and append it to the canonical history   ← Do this first
  ↓
Notify the event pump to acknowledge                          ← Do this afterwards
  ↓
Execute an event-only model turn with the event context
```

**This order, "into the history first, then ack", is the core of this section.** What happens in reverse:

```text
Ack first (delete it from the outbox)
  ↓
💥 The process crashes here
  ↓
Restart: the outbox is empty, and the history does not contain this message either
      This work disappears forever, and it leaves no trace
```

At the same crash point, with the correct order:

```text
Into the history first
  ↓
💥 The process crashes here
  ↓
Restart: the event is still in the outbox → the next tick publishes it again → it executes again
```

The cost is that **it may execute once more**. This is an explicit trade-off: **prefer duplication over loss.** And the duplicated part of the risk is covered by the `idempotencyKey` — when the same event is delivered again, the key is the same, and a tool with external side effects can deduplicate by it.

### What an ack truly confirms

This word is easily over-interpreted, so state it precisely:

```text
The meaning of ack = "This event has entered the history, so it can be removed from the durable outbox"
ack does not include   = "All later external side effects have completed exactly once"
```

The second item cannot be done. After the event enters the history, the model still calls tools, and the tools still produce side effects. A crash can happen at any of these steps. **What the runtime can promise is only "the work intention is not lost", not "the work is done exactly once".**

A tool that truly needs "exactly once" (a transfer, sending an email, creating a resource) must design its own idempotency boundary with the `idempotencyKey`. The runtime hands the key to you. The rest is the responsibility of the tool.

### An ack failure must roll back

If the ack call returns a failure (for example, the atomic write fails), the Runner **rolls back this history acceptance**:

```typescript
this.#history.pop();                      // Remove the user message that was just appended
this.#seenEventIds.delete(event.eventId);  // Remove the deduplication record
```

Why must it roll back? Because this message **has not been given to the model yet**. If it stayed in the history:

- The event is still in the outbox (the ack failed), so it will be delivered again next time.
- But the history already contains one copy, and redelivery would be blocked by the `#seenEventIds` deduplication.
- Result: **the event can never leave the outbox, and the copy in the history is never processed.** A deadlock.

After the rollback, a later tick can publish the same event cleanly again. A test covers exactly this: when the ack fails, the code throws `Cron event is no longer pending`, the event is still pending, **zero** user messages with `'"kind":"cron"'` enter the history, the model request count is 0; a retry then succeeds, with **exactly one** such message.

### Take one event at a time

The Loop calls `drainEvents(1)`. It takes at most one event each time. Here is a **reverse change** from Chapter 13: Chapter 13 drained the whole batch at once and injected N terminal states together, each with a `batch: {index, total}` that told the model "this is item k of N". This chapter removes that mechanism as a whole. `RuntimeEventBatchPosition` and the second parameter of `runtimeEventMessage` no longer exist, and the injected JSON contains one key only, `runtime_event`.

**Note that this is not "cron one at a time, background still batched" — the two event kinds travel through the same injection point, and from this chapter on, background events are also one at a time.** The `batch` field that you can see in the experiments of Chapter 13 does not appear from this chapter on.

Why retire batching? Because **different events can have different identities**:

```text
Event A: identity=alice,  idempotencyKey=...0501
Event B: identity=bob,    idempotencyKey=...0502
```

One model turn has one `ToolContext` only. It cannot hold two identities. With batch injection, you either use the wrong identity (a security problem), or you use the identity of the last event only (the earlier events are silently downgraded). **Processing one by one is the necessary result of identity isolation.**

In passing, this also avoids the old problem that "in a batch of events, the model pays attention to the last one only" — give the model five tasks at once, and it will very likely do only the last one carefully.

### When the Agent is busy

`runEvents()` uses the Runner's own run lock. If the Agent is processing a user turn, it **returns `undefined` at once**. It does not enter the same history concurrently.

At that time, the event is still in the inbox, and the durable event is still in the outbox. A later idle turn can still accept them.

A more subtle case is: **during a user turn, the polling reaches a cron event.** It cannot be injected directly at that point — that would insert a scheduled-task message into the middle of a user conversation, and the identity would be wrong. The implementation stores it temporarily in the Runner-internal `#deferredRuntimeEvents`:

```text
A user turn is in progress → the polling reaches a cron event with an identity
                 → store it temporarily; do not append it to the history; do not ack
                 → the user turn ends normally
                 → a later runEvents() executes it with the saved event context
```

Measured (a manual tick inside a tool handler, simulating "a scheduled task becomes due during a user turn"):

```text
User turn ended: 2 model calls, the tool saw [{"identity":"interactive-user"}]
History entry count = 4
Has the cron event entered the history = false
Explicit runEvents() -> a result exists; model calls total 3
Has it entered the history now = true
Tool context = [{"identity":"interactive-user"}]
One more runEvents() -> undefined
```

Read it line by line:

- When the user turn ended, the cron event **did not** enter the history (line 3 is `false`). The conversation that the user sees is clean.
- The identity that the tool saw in the user turn is `interactive-user` — **not polluted by the identity of the cron event**.
- Only after an explicit `runEvents()` call did the event enter the history, and the model ran one more turn.
- **The last line is the key**: one more call returns `undefined`, which shows that the deferred event **was not published twice**. The temporary-storage mechanism created no duplicate.

### How the event context is constructed

After a successful acknowledgement, the identity and the idempotency key that the event carries enter the tool context:

```typescript
const context: ToolContext = Object.freeze({
  workspace: this.#workspace,
  identity: runtimeEvent?.contextIdentity ?? this.#identity,
  ...(runtimeEvent?.idempotencyKey === undefined
    ? {}
    : { idempotencyKey: runtimeEvent.idempotencyKey }),
});
```

Two details:

- `?? this.#identity`: a turn that a cron event did not trigger (an ordinary user turn) uses the Runner's own identity.
- The spread-operator part: `idempotencyKey` is an **optional field**. When it is absent, the code does not add the key at all, instead of adding an `undefined`. `Object.freeze` guarantees that the context a tool receives cannot be tampered with.

The mapping that `createCronEvent` performs is:

```text
job.identity  → event.contextIdentity   ← the creator identity
event.eventId → event.idempotencyKey    ← the unique id of this trigger
```

Using the `eventId` as the idempotency key is a natural choice: when the same event is delivered again, its id does not change; events of different slots have different ids. **"The same work intention" and "the same idempotency key" correspond naturally.**

---

## Re-authorisation at trigger time

Creating a cron job means "allow the system to save one future work intention". It does **not mean** that all future operations are permanently authorised.

If this boundary is wrong, a scheduled task becomes a back door that bypasses the permission system.

### The complete order, with not one step skipped

A `CronEvent` saves the creator identity. When an event-only turn executes, the Runner uses this identity to construct a **new** `ToolContext`. Every tool call that the model then proposes is still processed in the public order:

```text
Tool argument validation (Zod schema)
  ↓
PreToolUse Hook
  ↓
Decision of the current PermissionPolicy
  ↓
Handler execution
  ↓
PostToolUse Hook
  ↓
Backfill of the corresponding tool result
```

**No step is skipped because "this is a scheduled task".** If the current policy denies, the handler call count is zero.

### Which version of the permissions applies

Assume that on Monday you created a job: "run a deployment script with `shell` every day at 9". On Wednesday you tightened the permission policy, and it forbids `shell` from executing deployment commands. On Thursday at 9, this job triggers. What happens?

```text
❌ By the rules at creation time → the deployment still executes, and your Wednesday tightening has no effect
✅ By the rules at trigger time → it is denied, and the handler was never called
```

This chapter chooses the second. The reason is direct: **a permission policy expresses "what is allowed now", not "what was allowed once".** If a scheduled task could execute by old rules, then tightening permissions could never take effect — an attacker would only need to plant a job in advance.

So:

```text
A cron prompt is "input that will be given to the Agent again in the future"
A cron prompt is not "a permission ticket"
```

It cannot bypass the authorisation of files, Shell, or any other side-effect tool. **It is a piece of text only. When it becomes due, the system submits it to the Agent again.**

### Then why save the creator identity at all

Since re-authorisation happens anyway, why not simply use the identity of the current interactive user?

Because **both audit and permission decisions need to know "whose task this is"**. Consider a multi-user scenario:

```text
alice created "clean her temporary directory every day at 9"
bob is currently using this workspace
9 o'clock arrives
```

Executing with the identity of bob creates two problems: first, the audit log records alice's task as bob's action; second, if the permission policy divides directories by user, the task would operate on bob's directory.

Execute with the identity of alice, and then **judge by the current policy whether alice still has this permission now** — that is the correct combination. **The identity comes from the past; the permission comes from the present.**

Look back at the last two lines of the trace at the start. They should now be completely clear:

```text
Context that the tool saw = [{"identity":"cron-owner","idempotencyKey":"...0501"}]
Runner's own identity = interactive-user
```

---

## The managed scheduler and the close order

The scheduler is not a wild `setInterval`. It is a worker that the `JobSupervisor` of Chapter 13 manages:

```typescript
this.#worker = this.#supervisor.startManaged(
  async (signal) => await this.#runScheduler(signal),
  "cron-scheduler",
);
```

`startManaged` converts the cancellation signal of the supervisor into the scheduler's own `AbortSignal`. In this way, the scheduler and the background jobs **share one single task owner**. The case "the supervisor says it closed cleanly, but a timer still runs" cannot occur.

The scheduler loop itself is simple: wake up → tick → sleep for `pollMilliseconds` (the default is 1000 ms) → wake up again. The sleep receives the signal, so a close interrupts it at once, without waiting for a full second.

### Injectable time boundaries

The tests inject a `CronClock` and a `CronSleeper`. They do not depend on a real wall clock or a real sleep:

| Injection point | Role |
| --- | --- |
| `CronClock` | Controls "what time it is now"; it can jump to three days later at once |
| `CronSleeper` | Controls the sleep behavior; the tests do not truly wait one second |
| `BlockingSleeper` | A sleep that **never returns**; it verifies that a close can interrupt a blocked worker |
| `idGenerator` / `eventIdGenerator` | Produce predictable ids, so the output can be compared with the document |
| `atomicReplace` | Injects a write failure, and verifies that the state does not drift |
| `outboxCapacity` | Set it to 1, and the full-capacity behavior can be tested in one step |

These six injection points do not exist for a business need. They exist so that **tests and probes obtain deterministic output**. The whole ch14 test suite **needs no API Key, accesses no network, and sleeps no real time** — it runs in 4 seconds.

`BlockingSleeper` deserves a separate mention. It simulates "the worker is stuck inside a sleep", and it verifies that `close()` truly wakes it through the signal. Without this injection, you could test only "it closes in the normal case". You could not test "it closes while stuck" — and the latter is the problem that close logic truly must solve.

### Close order: reversed

The composition root hands the resources to the Runner in this order:

```typescript
const resources = Object.freeze([
  backgroundSupervisor,
  cronRuntime,
]);
```

`AgentRunner.close()` closes in **reverse order**, so it executes `cronRuntime.close()` first, and then closes the `backgroundSupervisor`.

The order cannot be swapped. Because the cron scheduler is a worker that the supervisor manages:

```text
✅ Close cron first → the scheduler stops → then close the supervisor → no active worker; a clean exit
❌ Close the supervisor first → it finds a cron-scheduler still running → either force-cancel it or report a timeout error
```

This is a general rule: **the one that depends on others closes first; the one that others depend on closes later.** It is exactly the reverse of the construction order.

Inside `cronRuntime.close()`, four things happen, and their order matters equally:

```text
① Set #closed = true          ← A new tick fails at once and does not enter
② Abort the scheduler + await the worker ← Stop the loop
③ await #tickTail               ← Wait for a tick that already entered to finish
④ releaseLeader()               ← Release the leader lock
```

Step ③ is easy to miss. `#tickTail` is a Promise chain that serialises all ticks. Without waiting for it, a tick might still be modifying the snapshot when `close()` returns — and the leader lock would already be released, so another session could write at the same time.

The cooperation of steps ① and ④ also has a point: the closed marker comes first, which means that **a later tick that waited for the lock sees the closed state when it wakes, and fails explicitly** (it throws `CronClosedError`). It does not reacquire the leader after `close()` returns.

Several failures are aggregated into one `AggregateError` and thrown together, instead of reporting the first one only. On a close path, "report all errors" matters more than "fail fast" — you need to know every place that did not close cleanly.

When a CLI build fails, it cleans up by the same discipline: `Cron → supervisor → OpenAI model`. **After a close returns, no active worker should remain.**

---

## Connect it to the composition root

### One capability bit

```typescript
const P13 = new CapabilitySet([...P12.capabilities, "background"]);
const P14 = new CapabilitySet([...P13.capabilities, "cron"]);
```

P14 = P13 + one `cron` capability bit, 17 capability bits in total. Measured:

```text
P12: background=false cron=false
P13: background=true cron=false
P14: background=true cron=true
P14 capability count = 17
```

`P13.capabilities.has("cron") === false` is a test assertion. **A new chapter must not pollute an old profile in reverse** — this is a rule that the whole series keeps.

### Four pairing checks

The `BuildDependencies` of P14 requires an explicit `cronRuntime`, and it has four two-way checks:

| Check | Error message | What it prevents |
| --- | --- | --- |
| P14 lacks a cronRuntime | `cronRuntime is required for chapter 14 or later` | Declaring a capability without a runtime |
| P13 receives a cronRuntime | `cronRuntime requires chapter 14 or later` | Constructing a resource without connecting it |
| The supervisor is not the same one | `cronRuntime must share the background supervisor and event inbox` | Two runtimes that look similar but do not communicate |
| The inbox is not the same one | Same as above | Events published into a queue that nobody listens to |

The third and fourth checks deserve the most discussion. Imagine this bug:

```text
The CLI built supervisor A and inbox A, and gave them to the Runner
CronRuntime built supervisor B and inbox B internally
```

The code runs, the types pass, and nothing reports an error. But all cron events go into inbox B, while the Runner listens to inbox A — **the scheduled tasks never trigger, and there is no error message at all**. Bugs of this kind are extremely painful to investigate, so the composition root turns them into an explicit failure at start time.

### 16 tools, with schedule_cron last

```text
 1. shell           9. create_task
 2. read_file      10. get_task
 3. write_file     11. list_tasks
 4. edit_file      12. claim_task
 5. glob           13. complete_task
 6. todo_write     14. query_background_job    ← from Chapter 13
 7. task           15. cancel_background_job   ← from Chapter 13
 8. load_skill     16. schedule_cron           ← added by this chapter
```

The test asserts the **exact order**, not "contains these tools". A stable order has two benefits: first, the prompt cache hit rate is high (the tool list is part of the system prompt); second, a new chapter that cuts into the queue is discovered by a test at once.

The `shell` schema of P13 and P14 is **completely identical**. This chapter does not change the capability of the previous chapter in reverse — this is also a test assertion.

### How the CLI wires it

```typescript
// One shared EventInbox, two consumers
const inbox = supervisor.eventInbox;

return new CronRuntime({
  store: new JsonCronStore(workspace),
  inbox,
  supervisor,
  clock: { now: () => new Date() },
});
```

Then bind the wakeup after `buildAgent`, and start it:

```typescript
cronRuntime.bindWakeup(async () => {
  await runner.runEvents();
});
cronRuntime.start();
```

Why must `bindWakeup` come after `buildAgent`? Because it needs the `runner`, and the `runner` needs the `cronRuntime` as its `eventPump`. This is a circular dependency, broken by "construct first, bind later":

```text
① Build the cronRuntime (no wakeup yet)
② Build the runner (takes the cronRuntime as the eventPump)
③ Bind runner.runEvents to the cronRuntime
④ cronRuntime.start()
```

What happens if the order is wrong? If `start()` runs before step ②, the scheduler can tick a due job before the runner exists. At that time there is no wakeup, so the event stays in the inbox and waits for the next tick — **it is not lost, but it is one second late**. So this order exists for deterministic behavior, not to avoid a crash.

### Two entry points

The fixed chapter entry point:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch14 -- --prompt "Check CI every day at 9 am Shanghai time, run it on a cycle and persist it"
```

The general entry point:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 14 --prompt "Check CI every day at 9 am Shanghai time, run it on a cycle and persist it"
```

Both entry points bind the same P14 Bootstrap, and their behavior is completely identical. After the model calls `schedule_cron`, the durable state is written to `.agent_tutorial/cron/state.json` in the current workspace.

---

## Run Chapter 14

Run all commands below in PowerShell. Follow the steps once, and you will see `state.json` appear on the disk with your own eyes.

### Step 0: Check the environment

```powershell
node --version
npm --version
```

Node must be ≥ 20.12.

### Step 1: Enter the code directory

```powershell
Set-Location 'F:\笔记\Agent实操\code'
```

All later commands run in this directory.

### Step 2: Install the dependencies

```powershell
npm install
```

You do this once only. The new runtime dependency of this chapter is `cron-parser@5.6.2` (a locked version).

### Step 3: Run the tests first, and confirm that the baseline is good

```powershell
npm run test:ch14
```

Expected output:

```text
 Test Files  39 passed (39)
      Tests  318 passed (318)
   Duration  4.06s
```

**Confirm the baseline first, then run a real model.** Otherwise, when a problem appears, you cannot tell whether it is an environment problem or a code problem.

In passing, you will see one line on stderr:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**This is normal.** `ch14-entry.test.ts` deliberately calls the entry point without configured credentials, and it asserts that the process exits with code `2` and reports all missing items at once. Seeing this line means that test is in effect.

### Step 4: Configure the model credentials

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_BASE_URL = "https://your-endpoint/v1"
$env:OPENAI_MODEL = "gpt-4o-mini"
$env:OPENAI_FALLBACK_MODEL = "gpt-4o"
```

Set all four. The Chapter 11 fallback mechanism requires the primary model and the fallback model to be specified explicitly. It does not guess.

### Step 5: Run for real

```powershell
npm run ch14 -- --prompt "Check which files exist in the current directory every 2 minutes, run it on a cycle and persist it"
```

This prompt deliberately chooses **2 minutes** instead of "every day at 9" — you cannot wait until tomorrow. It also deliberately makes the task itself light (list a directory), so you can concentrate on the scheduling behavior.

### What you should see

```text
1. The model calls schedule_cron; the arguments contain cron, prompt, timezone, recurring, durable
2. The tool returns success, with a job id and next_run_at_utc
3. The model gives one confirmation answer
4. The process stays running (the scheduler is running)
5. After about 2 minutes, a runtime_event appears, and the Agent starts work by itself
```

**The key observation point is step 5.** You did nothing, and the Agent moved by itself. That is the whole meaning of this chapter.

If 2 minutes pass and nothing happens, go to the troubleshooting table below.

### Step 6: See what the disk holds

```powershell
Get-Content .agent_tutorial\cron\state.json | ConvertFrom-Json | ConvertTo-Json -Depth 5
```

You will see the same structure as the "What it looks like" section earlier: a `jobs` array, an `outbox` array, and a `version: 1`.

See what else the directory holds:

```powershell
Get-ChildItem .agent_tutorial\ -Force
Get-ChildItem .agent_tutorial\cron\ -Force
```

While the Agent still runs, expect to see:

```text
.agent_tutorial\
  cron\
    state.json        ← the single authoritative snapshot
    leader\           ← the target directory that the leader lock watches (it stays after creation)
    leader.lock\      ← the leader lock body (it exists while the lease is held)
```

The lifecycles of these three things are completely different, and each deserves a clear statement:

| Name | When it appears | When it disappears |
| --- | --- | --- |
| `state.json` | When the first durable job is persisted | It does not disappear by itself; it is the authoritative state |
| `leader\` | When the store first prepares the paths and `mkdir` creates it | **It does not disappear**; it is only the target that the lock watches |
| `leader.lock\` | When the leader lease is acquired | When `close()` releases the lease |
| `.agent_tutorial\.cron.lock` | The **start** of one snapshot read-modify-write | The **end** of the same read-modify-write |

The tree above contains **no** `.cron.lock`, and that is not an omission in the writing. It sits under `.agent_tutorial\` and not under `cron\`, and its hold time covers one read-modify-write only — usually milliseconds — so **you can almost never catch it with `Get-ChildItem`**. To see it with your own eyes, you must intervene at the moment of the disk write. Experiment 12 does exactly this with an injected `atomicReplace`.

One more detail that is easy to misread: `leader` is the **target path** of the lock, and `proper-lockfile` actually creates `leader.lock` right beside it (also a directory). So when "leader lock" appears below, the two names are two faces of the same thing.

If the process is force-killed, `leader.lock` remains. Do not delete it by hand — `stale` is set to 30 seconds, and after 30 seconds the next session can take over.

### Step 7: Verify that durable truly works

Close the Agent (`Ctrl+C`), then start it again:

```powershell
npm run ch14 -- --prompt "Which scheduled tasks are waiting now"
```

The jobs in `state.json` are recovered. Note one experience limitation here: **this chapter has no `list_cron_jobs` tool**, so the model cannot truly look them up and tell you. You can only read the file yourself. This gap is deliberate; "What this chapter deliberately does not do" below explains it.

The way to truly verify recovery is: let the next trigger time of a job fall after the restart, then wait and see whether it triggers.

### Troubleshooting common errors

| Symptom | Cause | What to do |
| --- | --- | --- |
| `cronRuntime is required for chapter 14 or later` | A P14 profile without a cronRuntime | Check whether you assembled it yourself and bypassed `cli.ts` |
| `cronRuntime requires chapter 14 or later` | A cronRuntime passed to P13 or earlier | Remove that argument |
| `cronRuntime must share the background supervisor and event inbox` | The supervisor or the inbox is not the same instance | Look at `createCronRuntime`; the inbox must use `supervisor.eventInbox` |
| `Error [cron_expression_error]: ...exactly five fields` | The expression has the wrong field count | Five fields, without seconds |
| `Error [cron_expression_error]: Unknown Cron timezone` | The time zone name is misspelled | Use an IANA name, such as `Asia/Shanghai`, not `CST` or `+08:00` |
| `Error [cron_expression_error]: Invalid descending Cron range` | A descending range like `8-2` was written | Split it into two parts: `8-31,1-2` |
| `Error [cron_storage_error]` | The snapshot is corrupt or the version does not match | See "One bad field poisons the whole snapshot" below |
| `Error [cron_closed]` | schedule/tick is still called after a close | Check whether the runtime was used after `close()` |
| Waited a long time, and no trigger | The UTC time computed from the time zone has not arrived yet | Check `next_run_at_utc` with the script of experiment 2 |
| Due, but the Agent did not move | Another session took the leader role | Close the other sessions, or look at experiment 8 |
| An event triggered twice | This does not happen in normal operation | Check whether two processes each hold the leader (a lock judged stale) |
| Occasional `EBUSY` / `EPERM` on Windows | An antivirus program or an indexing service holds the file | Up to 100 retries are built in; if it persists, exclude the working directory from scanning |

### One bad field poisons the whole snapshot

This one gets its own section, because its behavior is counterintuitive.

Add an unrecognised field to `state.json` by hand:

```powershell
$state = Get-Content .agent_tutorial\cron\state.json | ConvertFrom-Json
$state | Add-Member -NotePropertyName "enabled" -NotePropertyValue $true
$state | ConvertTo-Json -Depth 5 | Set-Content .agent_tutorial\cron\state.json -Encoding utf8
```

Then start the Agent:

```text
Error [cron_storage_error]: ...
```

**One extra field makes the whole snapshot unusable.** Because `requireExactKeys` requires the key set to match exactly; one extra key fails.

This is the consistent fail closed practice. It looks excessively strict, but consider the alternative: if unknown fields were ignored, then a job whose key name was typed wrong by hand (for example, `next_run_at_utc` typed as `next_run_at_utf`) would be read as "a missing required field" or as "an extra unknown field"? Both interpretations are possible, and neither should pass silently.

**Either completely trustworthy, or completely unusable.** The cleanup method is to delete that field, or to delete the whole `state.json` and start again (the saved jobs are lost).

---

## 12 hands-on experiments

I produced every conclusion above by running scripts, not by reasoning. This section hands those scripts to you.

Each experiment is short. The purpose of each one is to **turn an abstract rule into one line of output that you see with your own eyes**. Do them in order; the later ones use the intuition that the earlier ones build.

### Preparation: create a probe script first

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType File -Path scripts\probe-ch14.mts
```

The shared header of the script (common to all experiments):

```ts
// scripts/probe-ch14.mts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonCronStore } from "../chapters/ch14/src/adapters/cron-json.ts";
import { JsonBackgroundJobStore } from "../chapters/ch14/src/adapters/background-json.ts";
import { EventInbox } from "../chapters/ch14/src/core/events.ts";
import { AgentRunner } from "../chapters/ch14/src/core/loop.ts";
import { assistantMessage, toolCall } from "../chapters/ch14/src/core/messages.ts";
import { PermissionPolicy, PermissionRule } from "../chapters/ch14/src/core/permissions.ts";
import { ToolRegistry, toolSuccess } from "../chapters/ch14/src/core/tools.ts";
import { JobSupervisor } from "../chapters/ch14/src/features/background.ts";
import {
  CronRuntime,
  nextCronOccurrence,
  validateCronExpression,
} from "../chapters/ch14/src/features/cron.ts";

// Each experiment runs in its own temporary directory, so they do not disturb each other
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ch14-probe-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Produce predictable ids like ...0401 and ...0501, so you can compare them with the document
function seqId(start = 0x401): () => string {
  let next = start;
  return () => {
    const tail = next.toString(16).padStart(12, "0");
    next += 1;
    return `00000000-0000-4000-8000-${tail}`;
  };
}

// Select which experiment to run with a command-line argument
const EXPERIMENT = process.argv[2] ?? "all";
function section(name: string): boolean {
  const hit = EXPERIMENT === "all" || EXPERIMENT === name;
  if (hit) console.log(`\n===== ${name} =====`);
  return hit;
}
```

`seqId` is the key convenience of this section: a real run uses `randomUUID`, so every output differs and comparison is hard. Replace the `idGenerator` / `eventIdGenerator` with an increasing sequence, and the ids that you see match the ones in this article exactly.

> This is also why `JsonCronStore` makes the two id generators injectable parameters — not for a business need, but to **let tests and probes obtain deterministic output**.

Run method:

```powershell
npx tsx scripts\probe-ch14.mts expr      # Run one experiment
npx tsx scripts\probe-ch14.mts all       # Run all of them
```

The name inside the `if (section("xxx"))` line at the start of each experiment is the command-line argument. The 12 experiments in order are: `expr`, `tz`, `state`, `tick`, `misfire`, `durable`, `capacity`, `leader`, `trace`, `defer`, `tools`, `locks`.

### Experiment 1: the acceptance and rejection boundary of expressions

**What to verify**: what error the five-field limit, an out-of-range field, and a descending range each report.

```ts
if (section("expr")) {
  const cases: Array<[string, string, string]> = [
    ["* * * * *", "UTC", "2026-06-01T09:00:00Z"],
    ["0 9 * * *", "UTC", "2026-06-01T09:00:00Z"],
    ["*/15 9-10 * * 1,3,5", "UTC", "2026-06-01T09:00:00Z"],
    ["0 9 * * 1-5", "UTC", "2026-06-05T09:00:00Z"],
    ["0 9 1 * 1", "UTC", "2026-06-02T00:00:00Z"],
  ];
  for (const [expr, tz, after] of cases) {
    const next = nextCronOccurrence(expr, tz, new Date(after));
    console.log(`${expr.padEnd(22)} after ${after} -> ${next.toISOString()}`);
  }
  const bad = ["* * * *", "* * * * * *", "61 * * * *", "*/0 * * * *",
               "0 9 8-2 * *", "0 9 * 13 *", "0 9 * * 8"];
  for (const expr of bad) {
    try {
      validateCronExpression(expr);
      console.log(`${expr.padEnd(16)} -> passed (this should not appear)`);
    } catch (error) {
      console.log(`${expr.padEnd(16)} -> ${(error as Error).message}`);
    }
  }
}
```

Measured output:

```text
* * * * *              after 2026-06-01T09:00:00Z -> 2026-06-01T09:01:00.000Z
0 9 * * *              after 2026-06-01T09:00:00Z -> 2026-06-02T09:00:00.000Z
*/15 9-10 * * 1,3,5    after 2026-06-01T09:00:00Z -> 2026-06-01T09:15:00.000Z
0 9 * * 1-5            after 2026-06-05T09:00:00Z -> 2026-06-08T09:00:00.000Z
0 9 1 * 1              after 2026-06-02T00:00:00Z -> 2026-06-08T09:00:00.000Z
* * * *          -> Cron expression must contain exactly five fields
* * * * * *      -> Cron expression must contain exactly five fields
61 * * * *       -> Invalid Cron expression: 61 * * * *
*/0 * * * *      -> Invalid Cron expression: */0 * * * *
0 9 8-2 * *      -> Invalid descending Cron range
0 9 * 13 *       -> Invalid Cron expression: 0 9 * 13 *
0 9 * * 8        -> Invalid Cron expression: 0 9 * * 8
```

Three places deserve a stop:

- **Line 2**: the base is exactly `09:00:00`, and the result is **the next day**. `next_run` is strictly greater than the current time; it never returns "right now".
- **Line 4**: the base, 5 June, is a Friday, and `1-5` is Monday to Friday, so the result jumps to 8 June (Monday) — the weekend was skipped correctly.
- **Line 5**: this is the OR of DOM/DOW. 8 June is a Monday, so it hits, with no wait until 1 July.

### Experiment 2: time zones and DST

**What to verify**: the same expression gives different UTC instants in different time zones; a gap advances, and a fold keeps two times.

```ts
if (section("tz")) {
  const rows: Array<[string, string, string]> = [
    ["0 9 * * *", "UTC", "2026-06-01T00:30:00Z"],
    ["0 9 * * *", "Asia/Shanghai", "2026-06-01T00:30:00Z"],
    ["0 9 * * *", "Europe/London", "2026-06-01T00:30:00Z"],
    ["0 9 * * *", "America/New_York", "2026-06-01T00:30:00Z"],
  ];
  for (const [expr, tz, after] of rows) {
    console.log(`${tz.padEnd(18)} ${expr} -> ${nextCronOccurrence(expr, tz, new Date(after)).toISOString()}`);
  }
  console.log("-- DST gap (the 02:30 that does not exist) --");
  console.log(`  ${nextCronOccurrence("30 2 * * *", "America/New_York", new Date("2026-03-07T08:00:00Z")).toISOString()}`);
  console.log("-- DST fold (the repeated 01:30) --");
  const first = nextCronOccurrence("30 1 * * *", "America/New_York", new Date("2026-11-01T04:59:00Z"));
  const second = nextCronOccurrence("30 1 * * *", "America/New_York", first);
  console.log(`  First -> ${first.toISOString()}`);
  console.log(`  Second -> ${second.toISOString()}`);
  try {
    nextCronOccurrence("0 9 * * *", "Mars/Olympus", new Date("2026-06-01T00:00:00Z"));
  } catch (error) {
    console.log(`  Mars/Olympus -> ${(error as Error).message}`);
  }
}
```

Measured output:

```text
UTC                0 9 * * * -> 2026-06-01T09:00:00.000Z
Asia/Shanghai      0 9 * * * -> 2026-06-01T01:00:00.000Z
Europe/London      0 9 * * * -> 2026-06-01T08:00:00.000Z
America/New_York   0 9 * * * -> 2026-06-01T13:00:00.000Z
-- DST gap (the 02:30 that does not exist) --
  2026-03-08T07:00:00.000Z
-- DST fold (the repeated 01:30) --
  First -> 2026-11-01T05:30:00.000Z
  Second -> 2026-11-01T06:30:00.000Z
  Mars/Olympus -> Unknown Cron timezone: Mars/Olympus
```

**Try a change yourself**: replace `America/New_York` with your local time zone, and see which UTC time `0 9 * * *` computes. If you are in Shanghai, you should get `01:00:00Z`. This exercise builds your intuition for "local time ↔ UTC".

### Experiment 3: what state.json truly looks like

**What to verify**: one tick changes three places at the same time.

```ts
if (section("state")) {
  await withTempDir(async (root) => {
    const store = new JsonCronStore(root, {
      idGenerator: seqId(0x401), eventIdGenerator: seqId(0x501),
    });
    const job = await store.scheduleCron({
      cron: "0 9 * * *", prompt: "check CI", timezone: "UTC",
      recurring: true, durable: true, identity: "user",
      nowUtc: new Date("2026-06-01T12:00:30Z"),
    });
    const statePath = join(root, ".agent_tutorial", "cron", "state.json");
    console.log("-- Just created --");
    console.log(await readFile(statePath, "utf8"));
    await store.tick(job.nextRunAtUtc);
    console.log("-- After the tick --");
    console.log(await readFile(statePath, "utf8"));
  });
}
```

The output is the two JSON blocks from the "What it looks like" section earlier. **Compare the three changes**: `next_run_at_utc` advances, `last_slot_at_utc` changes from `null` to a concrete time, and the `outbox` changes from an empty array to one event.

**Try a change yourself**: change `recurring` to `false`, and run it again. After the tick, you will see that `jobs` becomes an empty array, but the event in the `outbox` is still there — that is the Job/Event separation.

### Experiment 4: the complete lifecycle of a one-shot job

**What to verify**: the definition is deleted, the event is kept, a repeated tick produces no second event, and an ack succeeds once only.

```ts
if (section("tick")) {
  await withTempDir(async (root) => {
    const store = new JsonCronStore(root, {
      idGenerator: seqId(0x401), eventIdGenerator: seqId(0x501),
    });
    const once = await store.scheduleCron({
      cron: "* * * * *", prompt: "one shot", timezone: "UTC",
      recurring: false, durable: true, identity: "user",
      nowUtc: new Date("2026-06-01T12:00:30Z"),
    });
    console.log(`One-shot created: next=${once.nextRunAtUtc.toISOString()}`);
    const created = await store.tick(once.nextRunAtUtc);
    console.log(`tick -> produced ${created.length} event, slot=${created[0]?.slotAtUtc.toISOString()}`);
    console.log(`Does the definition still exist: ${(await store.listJobs()).length === 0 ? "deleted" : "still there"}`);
    console.log(`outbox: ${(await store.pendingEvents()).map((e) => e.eventId).join(",")}`);
    console.log(`Tick once more -> ${(await store.tick(once.nextRunAtUtc)).length} events`);
    console.log(`Ack the first time -> ${await store.ackEvent(created[0]!.eventId)}`);
    console.log(`Ack the second time -> ${await store.ackEvent(created[0]!.eventId)}`);
  });
}
```

Measured output:

```text
One-shot created: next=2026-06-01T12:01:00.000Z
tick -> produced 1 event, slot=2026-06-01T12:01:00.000Z
Does the definition still exist: deleted
outbox: 00000000-0000-4000-8000-000000000501
Tick once more -> 0 events
Ack the first time -> true
Ack the second time -> false
```

The last two lines are the point: `ackEvent` returns a boolean, and **the second call is `false`, not an error**. This design turns a repeated ack into a judgeable result — the caller can distinguish "I just acknowledged successfully" from "someone else already acknowledged this one".

### Experiment 5: down for three days, catch up with one only

**What to verify**: the misfire strategy is "catch up with the earliest one, then catch up to the present", not "complete all of them".

```ts
if (section("misfire")) {
  await withTempDir(async (root) => {
    const store = new JsonCronStore(root, {
      idGenerator: seqId(0x401), eventIdGenerator: seqId(0x501),
    });
    const job = await store.scheduleCron({
      cron: "* * * * *", prompt: "every minute", timezone: "UTC",
      recurring: true, durable: true, identity: "user",
      nowUtc: new Date("2026-06-01T12:00:30Z"),
    });
    console.log(`At creation, next = ${job.nextRunAtUtc.toISOString()}`);
    const later = new Date(job.nextRunAtUtc.valueOf() + 3 * 86_400_000);
    console.log(`Power on after three days, now = ${later.toISOString()}`);
    const created = await store.tick(later);
    console.log(`Produced ${created.length} catch-up event, slot = ${created.map((e) => e.slotAtUtc.toISOString()).join(",")}`);
    const updated = await store.getJob(job.id);
    console.log(`lastSlotAtUtc = ${updated.lastSlotAtUtc?.toISOString()}`);
    console.log(`nextRunAtUtc  = ${updated.nextRunAtUtc.toISOString()}  (> now: ${updated.nextRunAtUtc > later})`);
  });
}
```

Measured output:

```text
At creation, next = 2026-06-01T12:01:00.000Z
Power on after three days, now = 2026-06-04T12:01:00.000Z
Produced 1 catch-up event, slot = 2026-06-01T12:01:00.000Z
lastSlotAtUtc = 2026-06-01T12:01:00.000Z
nextRunAtUtc  = 2026-06-04T12:02:00.000Z  (> now: true)
```

**A "every minute" job stopped for three days, and it caught up with 1 event only.** With a naive implementation, this would be 4320.

And it catches up with **the earliest one** (`06-01T12:01`), not the newest one. In this way, the model can see "three days were missed" from the difference between `slot_at_utc` and the current time.

**Try a change yourself**: change `3 * 86_400_000` to `30 * 86_400_000` (thirty days), and look at the result. Still 1 event — the strategy does not change with the downtime length.

### Experiment 6: durable vs session-only

**What to verify**: after the store is rebuilt, the durable records remain, and the session-only records disappear cleanly.

```ts
if (section("durable")) {
  await withTempDir(async (root) => {
    const store = new JsonCronStore(root, {
      idGenerator: seqId(0x401), eventIdGenerator: seqId(0x501),
    });
    const now = new Date("2026-06-01T12:00:30Z");
    const durable = await store.scheduleCron({
      cron: "* * * * *", prompt: "durable", timezone: "UTC",
      recurring: false, durable: true, identity: "user", nowUtc: now,
    });
    const session = await store.scheduleCron({
      cron: "* * * * *", prompt: "session", timezone: "UTC",
      recurring: false, durable: false, identity: "user", nowUtc: now,
    });
    console.log(`durable job = ${durable.id}`);
    console.log(`session job = ${session.id}`);
    await store.tick(durable.nextRunAtUtc);
    console.log(`Outbox in the same instance = ${(await store.pendingEvents()).map((e) => `${e.eventId.slice(-4)}:${e.prompt}`).join(", ")}`);
    const rebuilt = new JsonCronStore(root);   // Simulate a process restart
    console.log(`Jobs after rebuild   = ${(await rebuilt.listJobs()).length}`);
    console.log(`Outbox after rebuild = ${(await rebuilt.pendingEvents()).map((e) => `${e.eventId.slice(-4)}:${e.prompt}`).join(", ")}`);
  });
}
```

Measured output:

```text
durable job = 00000000-0000-4000-8000-000000000401
session job = 00000000-0000-4000-8000-000000000402
Outbox in the same instance = 0501:durable, 0502:session
Jobs after rebuild   = 0
Outbox after rebuild = 0501:durable
```

Both events exist in line 3; only the durable one remains in line 5. **The disappearance of the session-only records is silent and clean** — no error, and no half state left behind.

`new JsonCronStore(root)` is the smallest simulation of a "process restart": the memory Map of the new instance is empty, and it can read things from `state.json` only.

### Experiment 7: what happens when the outbox is full

**What to verify**: at full capacity, the `next_run_at_utc` of the squeezed-out job **does not move at all**.

```ts
if (section("capacity")) {
  await withTempDir(async (root) => {
    const store = new JsonCronStore(root, {
      outboxCapacity: 1,               // Set it to 1 on purpose
      idGenerator: seqId(0x401), eventIdGenerator: seqId(0x501),
    });
    const now = new Date("2026-06-01T12:00:30Z");
    const first = await store.scheduleCron({
      cron: "* * * * *", prompt: "first", timezone: "UTC",
      recurring: true, durable: true, identity: "user", nowUtc: now,
    });
    const second = await store.scheduleCron({
      cron: "* * * * *", prompt: "second", timezone: "UTC",
      recurring: true, durable: true, identity: "user", nowUtc: now,
    });
    const created = await store.tick(first.nextRunAtUtc);
    console.log(`Capacity 1, two jobs due at the same time -> produced ${created.length} event (${created[0]?.prompt})`);
    console.log(`first  next: ${(await store.getJob(first.id)).nextRunAtUtc.toISOString()} (advanced)`);
    const s = await store.getJob(second.id);
    console.log(`second next: ${s.nextRunAtUtc.toISOString()} (did not move: ${s.nextRunAtUtc.valueOf() === second.nextRunAtUtc.valueOf()})`);
    await store.ackEvent(created[0]!.eventId);
    const again = await store.tick(second.nextRunAtUtc);
    console.log(`Tick again after ack -> produced ${again.length} event (${again[0]?.prompt})`);
  });
}
```

Measured output:

```text
Capacity 1, two jobs due at the same time -> produced 1 event (first)
first  next: 2026-06-01T12:02:00.000Z (advanced)
second next: 2026-06-01T12:01:00.000Z (did not move: true)
Tick again after ack -> produced 1 event (second)
```

**`did not move: true` is the whole meaning of this experiment.** A full capacity does not make work disappear silently; it only makes it wait for the next round.

Compare what a wrong implementation would output:

```text
second next: 2026-06-01T12:02:00.000Z    ← It advanced, but no event was produced
Tick again after ack -> produced 0 events        ← This work is lost forever
```

And the wrong implementation **looks completely normal** — the job state shows "already processed up to 12:02". This kind of silent loss is the hardest class of bug to investigate.

### Experiment 8: two sessions compete for the leader

**What to verify**: only one session can produce events for durable jobs; when the leader changes, the work is not lost.

```ts
if (section("leader")) {
  await withTempDir(async (root) => {
    const inboxA = new EventInbox();
    const supA = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox: inboxA });
    const inboxB = new EventInbox();
    const supB = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox: inboxB });
    const creator = new JsonCronStore(root, { idGenerator: seqId(0x401) });
    const job = await creator.scheduleCron({
      cron: "* * * * *", prompt: "durable job", timezone: "UTC",
      recurring: false, durable: true, identity: "user",
      nowUtc: new Date("2026-06-01T12:00:30Z"),
    });
    const clock = { now: () => job.nextRunAtUtc };
    const first = new CronRuntime({
      store: new JsonCronStore(root, { eventIdGenerator: seqId(0x501) }),
      inbox: inboxA, supervisor: supA, clock,
    });
    const second = new CronRuntime({
      store: new JsonCronStore(root, { eventIdGenerator: seqId(0x501) }),
      inbox: inboxB, supervisor: supB, clock,
    });
    await first.tick();
    await second.tick();
    console.log(`session A drain: ${first.drainEvents().map((e) => e.eventId.slice(-4)).join(",") || "(empty)"}`);
    console.log(`session B drain: ${second.drainEvents().map((e) => e.eventId.slice(-4)).join(",") || "(empty)"}`);
    await first.close();
    console.log("A closed, the leader is released");
    await second.tick();
    const recovered = second.drainEvents();
    console.log(`session B ticks again: ${recovered.map((e) => e.eventId.slice(-4)).join(",") || "(empty)"}`);
    await second.acknowledgeEvents(recovered);
    console.log(`Outbox after ack: ${(await new JsonCronStore(root).pendingEvents()).length} entries`);
    await second.close();
    await supA.close();
    await supB.close();
  });
}
```

Measured output:

```text
session A drain: 0501
session B drain: (empty)
A closed, the leader is released
session B ticks again: 0501
Outbox after ack: 0 entries
```

Four conclusions, visible at once:

1. **A took the leader role**, and it produced and received the event.
2. **B received nothing** — the same slot was not delivered twice.
3. After A closed, the leader was released, and **B took over**.
4. B received **the same event `0501`** — A did not ack before it closed, so the work intention is still in the outbox.

Item 4 is the fulfilment of the whole persistence design. If A were force-killed (instead of a normal close), the lock would be judged stale after 30 seconds, and B could take over in the same way.

**Try a change yourself**: change `durable: true` to `false`, and run it again. The measured result is **three empty lines**:

```text
session A drain: (empty)
session B drain: (empty)
session B ticks again: (empty)
```

At first this may feel surprising, but this is exactly the definition of session-only at work: that job lives in the memory of the `creator` store instance only, while `first` and `second` are **two other instances**. They cannot read it from `state.json`, and they have no route to see the memory of another instance.

**The isolation boundary of session-only is the store instance, not the process.** This experiment also proves in passing that a session-only job never leaks into the durable snapshot — even another instance in the same process cannot see it.

### Experiment 9: the complete Agent trace

**What to verify**: the event enters the history as a `user` message; the identity that the tool sees is **the creator**, not the current interactive user.

This experiment is the source of the trace at the start. It needs a fake model and a tool that records the context:

```ts
if (section("trace")) {
  await withTempDir(async (root) => {
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const store = new JsonCronStore(root, {
      idGenerator: seqId(0x401), eventIdGenerator: seqId(0x501),
    });
    const job = await store.scheduleCron({
      cron: "* * * * *", prompt: "Check the CI status", timezone: "Asia/Shanghai",
      recurring: false, durable: true, identity: "cron-owner",
      nowUtc: new Date("2026-06-01T12:00:30Z"),
    });
    const runtime = new CronRuntime({
      store, inbox, supervisor, clock: { now: () => job.nextRunAtUtc },
    });

    // A tool that does one thing only: record the context that it sees
    const contexts: unknown[] = [];
    const { z } = await import("zod");
    const tools = new ToolRegistry();
    tools.register({
      name: "action", description: "Run the scheduled action.",
      inputSchema: z.object({ value: z.string() }).strict(), effect: "read",
      handler: async (input, context) => {
        contexts.push({ identity: context.identity, idempotencyKey: context.idempotencyKey });
        return toolSuccess(`CI: ${input.value}`);
      },
    });

    // Fake model: the first turn calls the tool, the second turn gives the conclusion
    let calls = 0;
    const model = {
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            message: assistantMessage(null, [toolCall("cron-action", "action", '{"value":"green"}')]),
            finishReason: "tool_calls" as const,
          };
        }
        return { message: assistantMessage("CI is green; no action is needed."), finishReason: "stop" as const };
      },
    };

    const runner = new AgentRunner({
      model, tools, systemPrompt: "system", workspace: root,
      identity: "interactive-user",           // Note: different from the identity of the job
      permissionPolicy: new PermissionPolicy({
        rules: [new PermissionRule({ name: "allow-all", behavior: "allow", reason: "ok", matches: () => true })],
      }),
      eventPump: runtime,
      resources: [supervisor, runtime],
    });
    runtime.bindWakeup(async () => { await runner.runEvents(); });

    await runtime.tick();                     // The time has come

    console.log(`Model request count = ${calls}`);
    runner.history.forEach((message, index) => {
      const head = `${String(index + 1).padStart(2)}. ${message.role.padEnd(9)}`;
      if (message.role === "assistant") {
        const named = message.toolCalls.map((c) => `${c.name}(${c.arguments})#${c.id}`).join(", ");
        console.log(`${head} content=${message.content === null ? "(null)" : JSON.stringify(message.content)} toolCalls=[${named}]`);
      } else if (message.role === "tool") {
        console.log(`${head} toolCallId=${message.toolCallId} ${message.content}`);
      } else {
        console.log(`${head} ${message.content}`);
      }
    });
    console.log(`Context that the tool saw = ${JSON.stringify(contexts)}`);
    console.log(`Outbox remainder = ${(await store.pendingEvents()).length}`);
    await runner.close();
  });
}
```

Measured output (the block from the start):

```text
Model request count = 2
 1. user      {"runtime_event":{"event_id":"...0501","job_id":"...0401","kind":"cron",
              "identity":"cron-owner","prompt":"Check the CI status","timezone":"Asia/Shanghai",
              "durable":true,"slot_at_utc":"2026-06-01T12:01:00.000Z"}}
 2. assistant content=(null) toolCalls=[action({"value":"green"})#cron-action]
 3. tool      toolCallId=cron-action CI: green
 4. assistant content="CI is green; no action is needed." toolCalls=[]
Context that the tool saw = [{"identity":"cron-owner","idempotencyKey":"...0501"}]
Outbox remainder = 0
```

Note that one sentence, `runtime.tick()`, triggered the **whole** flow after it: produce the event → publish it to the inbox → call the wakeup → `runEvents()` → enter the history → ack → run two model turns → execute the tool.

**Try a change yourself**: change the `behavior` of the `PermissionRule` to `"deny"`. You will see that `contexts` is an **empty array** — the handler was never called. This is the empirical proof of the "Re-authorisation at trigger time" section.

### Experiment 10: it becomes due during a user turn

**What to verify**: the cron event is deferred; it does not pollute the user conversation, and it is not published twice.

The key technique is to trigger one tick manually inside a tool handler, to simulate "a scheduled task becomes due while a user turn is in progress". Only the core lines are extracted below. The outer `if (section("defer")) { ... }` and the runner construction are the same as in experiment 9; copy them:

```ts
    tools.register({
      name: "probe", description: "Probe the context.",
      inputSchema: z.object({}).strict(), effect: "read",
      handler: async (_input, context) => {
        contexts.push({ identity: context.identity, idempotencyKey: context.idempotencyKey });
        await runtime.tick();          // ← a user turn is in progress, and a scheduled task becomes due
        return toolSuccess("ok");
      },
    });
    // ... runner construction omitted (the same as experiment 9)
    await runner.run("Help me take a look");     // One ordinary user turn
    console.log(`History entry count = ${runner.history.length}`);
    console.log(`Has the cron event entered the history = ${runner.history.some((m) => m.content?.includes('"kind":"cron"'))}`);
    const after = await runner.runEvents();
    console.log(`Explicit runEvents() -> ${after === undefined ? "undefined" : "a result exists"}`);
    console.log(`Has it entered the history now = ${runner.history.some((m) => m.content?.includes('"kind":"cron"'))}`);
    console.log(`One more runEvents() -> ${(await runner.runEvents()) === undefined ? "undefined" : "a result exists"}`);
```

Measured output:

```text
User turn ended: 2 model calls, the tool saw [{"identity":"interactive-user"}]
History entry count = 4
Has the cron event entered the history = false
Explicit runEvents() -> a result exists, model calls total 3
Has it entered the history now = true
Tool context = [{"identity":"interactive-user"}]
One more runEvents() -> undefined
```

Four conclusions:

1. **When the user turn ended, the cron event had not entered the history** (`false`) — the conversation that the user sees is clean.
2. **The identity that the tool saw in the user turn is `interactive-user`**, not polluted by the identity of the cron event.
3. Only after `runEvents()` did the event enter the history, and the model ran one more turn.
4. **One more call returns `undefined`** — the deferred event was not published twice.

Item 4 is the easiest place to write wrong. A naive deferral implementation keeps the event both in the Runner and in the inbox, and the result is processing it twice.

### Experiment 11: capability bits

**What to verify**: a new chapter does not pollute an old profile in reverse.

```ts
if (section("tools")) {
  const { P12, P13, P14 } = await import("../chapters/ch14/src/core/profiles.ts");
  for (const [name, set] of [["P12", P12], ["P13", P13], ["P14", P14]] as const) {
    console.log(`${name}: background=${set.capabilities.has("background")} cron=${set.capabilities.has("cron")}`);
  }
  console.log(`P14 capability count = ${P14.capabilities.size}`);
}
```

Measured output:

```text
P12: background=false cron=false
P13: background=true cron=false
P14: background=true cron=true
P14 capability count = 17
```

You can see at a glance that the capability bits are **strictly cumulative**. This experiment is the shortest, but the rule that it guards is the most important: **adding a chapter must not change the behavior of any previous chapter.**

### Experiment 12: catch the lock that lives for a few milliseconds only

**What to verify**: the lifetimes of the two locks differ by several orders of magnitude — the five output lines in step 6 of "Run Chapter 14" earlier are what this script produces.

`.cron.lock` exists during one snapshot read-modify-write only, and `Get-ChildItem` can essentially never catch it. To see it, you must intervene at the moment of the disk write — and `atomicReplace` is exactly such an injection point:

```ts
if (section("locks")) {
  const { readdir, writeFile } = await import("node:fs/promises");
  await withTempDir(async (dir) => {
    const stateDir = join(dir, ".agent_tutorial");
    const cronDir = join(stateDir, "cron");
    const ls = async (d: string) => (await readdir(d)).sort().join(" | ");

    const store = new JsonCronStore(dir, {
      // Print both directories before the disk write; at this moment, the snapshot lock is certainly still held
      atomicReplace: async (path, content) => {
        console.log("At the disk-write moment, .agent_tutorial/ :", await ls(stateDir));
        console.log("At the disk-write moment, cron/ :          ", await ls(cronDir));
        await writeFile(path, content);
      },
    });

    await store.tryAcquireLeader();
    await store.scheduleCron({
      cron: "*/1 * * * *",
      prompt: "p",
      timezone: "UTC",
      recurring: true,
      durable: true,
      identity: "cron-owner",
      nowUtc: new Date("2026-06-01T12:00:00.000Z"),
    });

    console.log("After the write,   .agent_tutorial/ :", await ls(stateDir));
    console.log("After the write,   cron/ :          ", await ls(cronDir));
    await store.releaseLeader();
    console.log("After the leader release, cron/ :     ", await ls(cronDir));
  });
}
```

Measured output:

```text
At the disk-write moment, .agent_tutorial/ : .cron.lock | cron
At the disk-write moment, cron/ :           leader | leader.lock
After the write,   .agent_tutorial/ : cron
After the write,   cron/ :           leader | leader.lock | state.json
After the leader release, cron/ :      leader | state.json
```

Read the five lines in comparison:

| Line | What to look at |
| --- | --- |
| 1 | `.cron.lock` appeared — **you can see it inside the critical section only** |
| 2 | `leader.lock` is already there, but `state.json` has not been written yet |
| 3 | The same call has not returned yet, and `.cron.lock` is already gone |
| 4 | `state.json` appears; `leader.lock` is still there |
| 5 | Only an explicit `releaseLeader()` makes `leader.lock` disappear |

**One is an instantaneous critical section; the other is a long-term identity.** Note in passing that the empty `leader` directory is present from start to finish — it is only the target path that the lock watches, not the lock itself, so it is not cleaned up.

**Try a change yourself**: comment out the `await store.releaseLeader()` line, and run it again. The last line becomes:

```text
After the leader release, cron/ :      leader | leader.lock | state.json
```

`leader.lock` did not leave. The process still ends with exit code 0 — **no error reminds you that you missed a step**. In a temporary directory, this has no consequence, because the whole directory is deleted afterwards. But in a real workspace, this is the reason why the next session must wait 30 seconds for the stale judgement before it can take over. This is also why that `releaseLeader()` line inside `CronRuntime.close()` cannot be omitted: **miss one step in the destruction order, and the lock lives longer than the thing it protects, silently.**

### Cleanup after the experiments

```powershell
Remove-Item scripts\probe-ch14.mts
```

All experiments run in the system temporary directory. They leave nothing in your workspace.

---

## What this chapter deliberately does not do

A capability list easily makes people believe that "scheduled triggers" are finished. In fact, P14 lays only the foundation. Several things are **explicitly decided against**. Distinguish "not done" from "cannot be done", because that distinction decides what you can still safely add on top of this code.

| Thing not done | Why it is not done | The current substitute |
| --- | --- | --- |
| `list_cron_jobs` / `cancel_cron_job` | Every new tool needs a whole set of schema + permissions + tests | Read `state.json` directly |
| Jitter | It needs an extra time-offset strategy and tests | Fixed UTC slots, no spreading |
| Automatic expiry | "How long counts as expired" is a product decision | A job stays valid until it is deleted |
| QoS / priority | It needs grading on the event path | All events queue equally |
| Operating-system level scheduling | It is outside the Agent process boundary | When the process stops, nobody watches the clock |
| File watching / Webhook | Diversification of event sources is another theme | Time-driven only |
| Batch event injection | It would break identity isolation | At most one event per turn |
| Complete all missed slots | The context would be eaten by historical events | Catch up with the earliest one only, then catch up to the present |
| Fold deduplication | It needs a layer of "local time semantics" judgement | The UTC instant is the only truth; it executes twice |
| Teammates and Mailboxes of P15 | The theme of the next chapter | —— |

### A special note on list and cancel

These are the two tools that most easily feel like "just add them while you are here". Why not add them?

Look first at what each one needs:

```text
list_cron_jobs   → Which fields does it return? Pagination? Filtering by identity?
                   Can one user see the jobs of another user? (a permission question)
cancel_cron_job  → Who may cancel? The creator only?
                   Does cancelling an event that is already waiting in the outbox count as a successful cancel?
                   What about the race between a cancel and a concurrent tick?
```

**Every question mark is a design decision, and every one needs a test.** Especially the three `cancel` questions: when "cancel" and "the event is already in the outbox" collide, the result is an arbitration problem of the same complexity as "publish exactly once".

What this chapter teaches is the **correctness skeleton of scheduling**: expressions, time zones, Job/Event separation, the atomic snapshot, leader arbitration, event feedback, and re-authorisation. Adding two CRUD tools would not make these principles clearer, but it would significantly increase the code size and the test size.

**They are not hard. They simply do not belong to this chapter.**

### "Not done" does not mean "not considered in the design"

Look at the `CronStore` interface: `getJob` and `listJobs` already exist — the experiments use them. What is missing is only the **tool-layer packaging**:

```text
Present: store.listJobs()  ← a domain capability
Missing: the list_cron_jobs tool ← schema, permissions, error codes, tests
```

Similarly, `ackEvent` returns a boolean instead of throwing. That is exactly so that an operation like "cancel a pending event" has a judgeable result.

**The path is open; it is simply not exposed as a tool.** And that is a different matter from "the architecture cannot do it at all".

### A special note on the fold executing twice

On the fall-back day, a "every day at 01:30" job executes twice. This looks like a bug, and it deserves an explanation of why it is not fixed.

To "fix" it, you must introduce a new concept: "the same occurrence in local time semantics". That is, besides the UTC instant, the state must also record "this local clock face has been used". And once you record local time, you reintroduce the thing that this chapter avoided from the start — **local time strings as state**.

Then the gap side breaks at once: a nonexistent `02:30` is advanced to `03:00` and executed, so does the "local clock face 02:30" count as used or not? If it counts, then the normal `02:30` of this day next year would be skipped.

**Use UTC instants consistently, and the cost is one duplicate execution per year. Introduce local semantics, and the cost is a whole new class of boundary cases.** The first can be resolved by the idempotency of the tool (the `idempotencyKey` is right there). The second can be handled only with more code and more tests. This exchange is clear in a teaching scenario.

---

## Differences from Claude Code

P14 is a teaching implementation. Claude Code is a product. Their differences on this capability show exactly where "the teaching version is sufficient" and where "the product version must do more".

| Dimension | P14 | Claude Code |
| --- | --- | --- |
| Tool count | 1: `schedule_cron` | 3: `CronCreate` / `CronDelete` / `CronList` |
| Feature switch | Registered unconditionally; decided by the Profile only | Triple control: compile time + a remote flag + a local environment variable |
| Storage | `.agent_tutorial/cron/state.json`, one snapshot for jobs + outbox | `.claude/scheduled_tasks.json`; unconsumed events are not saved |
| Lock | `.cron.lock` (snapshot) + `leader.lock` (leader election) | `.scheduled_tasks.lock` prevents duplicate triggers in the same project |
| Time zone | A required IANA name; UTC instant persistence | Interpreted by the local time zone; the model cannot pass a time zone explicitly |
| DST | A gap advances; a fold keeps two instants; tests exist | The reference implementation has no equivalent statement |
| Thundering-herd prevention | No jitter | Deterministic jitter for repeated tasks (≤ 10% of the period, capped at 15 minutes) |
| Expiry | None | Repeated tasks expire automatically after 7 days (configurable, capped at 30 days) |
| Task limit | No job limit; an outbox capacity limit only | `MAX_JOBS = 50`; over the limit, a prompt asks to cancel one first |
| Delivery | Into the `EventInbox`; executed one by one when idle | Into the command queue, with a `workload` tag and a lower QoS |
| Scheduler ownership | A managed worker of the `JobSupervisor` | A check every second + `chokidar` watching the state file for changes |

### Two root causes behind the differences

Eleven rows of differences. At the root, they are two things.

**First, a product must face the reality that "users will create a pile of jobs".**

```text
MAX_JOBS = 50    ← Someone will create 500
7-day automatic expiry      ← Someone creates one and forgets it
Jitter             ← Ten thousand users all set "every day at 9", and 9:00:00 would burst the API
```

None of these three is an architecture problem. They are **operations problems**. P14 is a single-person teaching environment, and it does not meet them. But note one point: **none of them needs an architecture change**. Jitter adds an offset after the slot is computed. Expiry adds one field and one check. A limit adds one judgement at creation. The skeleton of P14 carries all three as it is.

**Second, a product must face the reality that "users have many things open at the same time".**

```text
chokidar watches file changes  ← Another session changed a job, and I must know at once
workload tags + QoS   ← A scheduled task must not compete with the user's interactive requests for API quota
```

The second item deserves special thought. A scheduled task is **naturally lower in priority than a user request** — the user is waiting for an answer, and nobody minds if a scheduled task is five minutes late. P14 makes no such distinction; all events queue equally. In a single-person environment, that is fine. But in a product with a shared API quota, this distinction is mandatory.

### The time zone row is reversed

Interestingly, **P14 is more explicit about time zones than CC**: P14 requires an IANA time zone to be passed explicitly and persists UTC instants; CC interprets by the local time zone, and the model cannot pass a time zone.

This does not mean that P14 is better. The two face different problems. CC is a local CLI; the time zone of the user's machine is the user's time zone, and the probability of a correct guess is extremely high. "Letting the model pass a time zone" would instead increase the model's chance to err. P14 is a teaching implementation. It must state the principle "a time zone must be explicit" clearly, so it chooses the more verbose but more explicit method.

If this P14 code were connected to a **server-side** scenario (the user in Shanghai, the server in Virginia), an explicit time zone would change from "teaching rigour" into "the only correct method".

---

## What to learn from ai-agent-book: event streams and safety points

[`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book) (the companion repository of *Understanding AI Agents in Depth: Design Principles and Engineering Practice*) has two relevant experiments in Chapter 4: experiment 4-5, `agent-with-event-trigger`, uses `register -> trigger -> wake -> handle` to demonstrate the external world waking an Agent; experiment 4-6, `async-agent` (code name Flux), continues on this event queue with urgency classification, batch processing, and state checkpoints.

They introduce no new model reasoning primitive. They turn "when an event may enter the Agent" into an engineering boundary that the framework layer controls — which is exactly the problem that this chapter solves.

### The design of those two experiments

Experiment 4-5 divides trigger sources into three classes: one-shot timers, cyclic timers, and file watching. All three classes are unified into structured events of the form `{event_type, content, metadata}`. A background thread pushes them into a shared queue. Its offline demo calls no LLM, and you can still clearly see five stages: timer registration, trigger, the event loop taking an event, waking the Agent, and simulated handling.

Experiment 4-6 goes further. `classify_urgency()` divides events into three levels:

```text
INTERRUPT  → Cancel the current turn and all background tasks at once
IMMEDIATE  → Answer at once, but do not interrupt the background tasks
DEFERRED   → Enter a pending buffer; append in one batch when the asynchronous results arrive
```

The book states one key principle explicitly: **events are consumed at the boundary of each loop turn only; they are not inserted into model reasoning or tool execution midway.**

This principle is the same thing as this chapter's `runEvents()` sharing the run lock with user turns.

### The comparison and the trade-offs of P14

Six dimensions. Each one is an explicit trade-off:

| Dimension | ai-agent-book | P14 | Why P14 chooses this |
| --- | --- | --- | --- |
| Event structure | `event_type` + `content` + `metadata` | `eventId`, `jobId`, `identity`, `prompt`, `timezone`, `slotAtUtc` + `idempotencyKey` | A triggered turn does not guess the context from a bare string |
| Consumption time | Consumed at loop boundaries only | `runEvents()` shares the run lock with user turns | **The same principle**, a different implementation |
| Batching | Non-urgent events appended in a batch | At most one per turn | Different identities cannot share one `ToolContext` |
| Urgency | Three-level classification | None; uniform queueing until idle | Interrupting the current model request requires a change to the core timing of the Loop |
| Persistence | trajectory + task progress checkpoints | jobs + pending outbox | A narrower scope, which exactly covers "work is not lost after a restart" |
| Event source | Timers + file watching | Time-driven only | Multiple event sources are an independent theme |

### The difference that deserves the most attention: why P14 does not batch

Flux appends non-urgent events in a batch for efficiency — one LLM call processes several events, which saves tokens and time. This optimisation is correct in the Flux scenario, because its events all come from the same user.

P14 cannot do this. The reason is in the trace of experiment 9:

```text
Context that the tool saw = [{"identity":"cron-owner","idempotencyKey":"...0501"}]
```

One model turn has **one** `ToolContext` only. It holds one identity and one idempotencyKey. If events from two different creators were injected in a batch:

```text
Event A: identity=alice
Event B: identity=bob
     ↓ injected into the same turn in a batch
ToolContext.identity = ???
```

Whichever you choose is wrong. Choose alice, and bob's task executes with alice's permission; choose bob, and the reverse happens. **Identity isolation and batch efficiency conflict directly here, and P14 chooses identity isolation.**

One benefit in passing: processing one by one avoids the real problem that "give the model five tasks in a batch, and it does only the last one carefully".

### Another difference: the scope of a checkpoint

Flux saves the complete trajectory + task progress. At recovery, it marks running tasks as `suspended`, and it lets the upper layer decide whether to rerun or to resume.

P14 saves job definitions and the pending outbox only. **No trajectory, no progress.**

```text
Flux:  "This task is 60% done; do you want to continue it"
P14:   "This task has not started yet; do it again"
```

The scope of P14 is narrower, but it covers exactly the point that a scheduled task truly needs: **the time arrived, and the work intention must not be lost.** A "check the CI status" scheduled task needs no resume — query once more, and the result is even newer.

One general judgement applies here: **whether a task is worth saving progress for depends on the cost of redoing it.** Redoing a CI status check costs almost zero. Redoing `npm install` costs a few minutes. Redoing a data migration can be a disaster. All scheduled tasks of P14 belong to the first class, so saving no progress is reasonable.

---

## Companion code index

| File | Lines | Role in this chapter |
| --- | --- | --- |
| [features/cron.ts](code/chapters/ch14/src/features/cron.ts) | 684 | The core of the whole chapter. The four typed errors, the `CronJob`/`CronEvent` domain models, `CronRuntime`, the `schedule_cron` tool, `nextCronOccurrence`, `validateCronExpression`, DST adjustment |
| [adapters/cron-json.ts](code/chapters/ch14/src/adapters/cron-json.ts) | 669 | `JsonCronStore`: one atomic snapshot, the one-time migration of `tick()`, three lock layers, leader election, strict fail-closed parsing |
| [core/events.ts](code/chapters/ch14/src/core/events.ts) | 77 | The `RuntimeEvent` contract, the typed-only FIFO of `EventInbox`, `runtimeEventMessage` turns an event into a user message (introduced in Chapter 13; this chapter retires batch injection, and `RuntimeEventBatchPosition` and the `batch` field no longer exist) |
| [core/loop.ts](code/chapters/ch14/src/core/loop.ts) | 677 | The `RuntimeEventPump` contract, the event-only turn of `runEvents()`, the deferral mechanism of `#deferredRuntimeEvents`, history-before-ack and rollback, `ToolContext` construction |
| [features/background.ts](code/chapters/ch14/src/features/background.ts) | 813 | `JobSupervisor.startManaged()` makes the scheduler a managed worker (added by this chapter); the rest is the Supervisor, the Dispatcher, and the two background tools of Chapter 13 |
| [bootstrap.ts](code/chapters/ch14/src/bootstrap.ts) | 338 | The composition root. The four pairing checks, the registration order of the 16 tools, the resource array order |
| [cli.ts](code/chapters/ch14/src/cli.ts) | 284 | The real entry point. The shared-inbox wiring, the `bindWakeup` timing, the cleanup order on failure |
| [core/profiles.ts](code/chapters/ch14/src/core/profiles.ts) | 294 | The capability-bit definition `P14 = P13 + "cron"` |
| [tests/ch14-cron.test.ts](code/chapters/ch14/tests/ch14-cron.test.ts) | 70 | Expressions, time zones, DOM/DOW OR, seven rejection paths, DST gap/fold |
| [tests/ch14-cron-store.test.ts](code/chapters/ch14/tests/ch14-cron-store.test.ts) | 391 | 11 store behaviors: misfire, ack idempotency, atomic-write failures on three paths, event id conflicts, two-store competition, version mismatch, symlink rejection |
| [tests/ch14-runtime.test.ts](code/chapters/ch14/tests/ch14-runtime.test.ts) | 481 | event-only turn, ack-failure rollback, leader handover, deferral during a user turn, close order, blocking sleeper |
| [tests/ch14-bootstrap.test.ts](code/chapters/ch14/tests/ch14-bootstrap.test.ts) | 134 | The exact order of the 16 tools, P13 contains no `cron`, two pairing failure messages |
| [tests/ch14-entry.test.ts](code/chapters/ch14/tests/ch14-entry.test.ts) | 25 | The fixed entry point and all missing configuration reported at once |

### A suggested reading order for the code

Do not read `cron.ts` from line 1 downward. Follow this order; every step is understandable on its own:

```text
① core/events.ts in full (77 lines)
   → Build the concept of "what an event is" first; this is the smallest piece
   → Skip it if you read Chapter 13

② validateCronExpression + nextCronOccurrence in cron.ts
   → All the logic of expressions and time zones; the easiest part to verify

③ The CronJob / CronEvent interface definitions in cron.ts
   → See clearly which fields the two objects have, and why they cannot be merged

④ tick() in cron-json.ts
   → The most important function of the whole chapter: what one atomic migration does

⑤ atomicReplace + parseState in cron-json.ts
   → The write discipline and the fail-closed parsing

⑥ CronRuntime.tick() and close() in cron.ts
   → The four-step publish flow, the four-step close order

⑦ #acceptNextRuntimeEvent in loop.ts
   → history-before-ack, rollback, the deferral mechanism

⑧ tests/ch14-cron-store.test.ts
   → Use the 11 tests to check back whether you missed a branch
```

The first four steps are about 250 lines. After them, you understand roughly eighty percent of this chapter. The last four steps fill in the remaining details.

---

## Run and verification

Two entry points bind the same P14 Bootstrap:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch14 -- --prompt "Check CI every day at 9 am Shanghai time, run it on a cycle and persist it"
npm run agent-tutorial -- run --chapter 14 --prompt "Look at the current directory every 2 minutes, run it on a cycle"
```

Five verification gates:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch14
npm run typecheck
npm run lint
npm run format:check
npm run build
```

The tests of this chapter **do not depend on a real OpenAI, a real sleep, or the system time**. An injected `CronClock` controls "what time it is now". An injected `CronSleeper` removes the real wait. An injected `BlockingSleeper` verifies that a close can interrupt a blocked worker. An injected `atomicReplace` creates write failures. An injected `outboxCapacity: 1` makes the full-capacity behavior testable in one step. **318 tests run in 4 seconds, completely offline.**

The division of work between the five test files:

| Test file | Question it answers |
| --- | --- |
| `ch14-cron.test.ts` | Are the expressions computed correctly? Are the time zones and DST correct? Were bad inputs rejected? |
| `ch14-cron-store.test.ts` | Are the state migrations correct? Does a write failure drift? Do two competing stores publish twice? |
| `ch14-runtime.test.ts` | Do events return correctly? Did an ack failure roll back? Is the close clean? |
| `ch14-bootstrap.test.ts` | Is the wiring correct? Does a wrong capability-bit pairing produce an error? Did the tool order change? |
| `ch14-entry.test.ts` | When configuration is missing, is the error complete enough? |

The key assertions are not "the object exists". They are observable results:

- Five-field expressions, lists, ranges, steps, weekdays, and DOM/DOW OR produce fixed slots.
- A local time zone computation result converts to the expected UTC instant, and the DST gap/fold behavior is fixed.
- A recurring job does not repeat for the same slot; a one-shot job deletes its definition but keeps the outbox.
- After a three-day delay, the system catches up with the earliest slot only, and `next_run_at_utc` advances to after now.
- Durable state recovers after a rebuild; session-only state disappears after a rebuild.
- When the outbox is full and when persistence fails on the schedule, tick, and ack paths, the **old file bytes** stay unchanged.
- Two stores competing for the same slot commit one event only; on an event id conflict, the earlier event stays pending, and the `next_run_at_utc` of the later job does not change.
- When the Agent is busy, no ack happens; when it is idle, the event-only turn uses the **saved identity** and re-authorises.
- When an ack fails, zero cron user messages enter the history, and the model request count is 0; after a retry, exactly one.
- A close waits for in-flight ticks; after the close, neither the scheduler nor the supervisor has an active task, and neither reacquires the leader.
- When the `cron` directory of `state.json` is replaced by a symlink/junction, the system rejects it **before** it creates the external `leader` directory.

---

## Chapter summary

### The three-sentence version

Chapter 14 lets the Agent start work even when nobody speaks. The method is: compute the next UTC slot with a mature parser and an explicit time zone; split "a time rule" and "one due work intention" into two objects inside the same atomic snapshot; when the time arrives, produce a persistent event, return it through the `EventInbox` path of Chapter 13 as a `user` message into the same Agent Loop, and at trigger time walk the permission flow again with the creator identity. Every approach that "looks easier" — local time as state, Job and Event merged into one, ack before history, batch injection of several events, completing all missed slots — loses correctness in some concrete scenario.

### Seven rules that you must remember

1. **A slot is the time at which execution should happen, not the time at which the system discovered that it was due.** A 9:00 task discovered 8 seconds late because the process was busy still has the event slot `09:00:00`. Duplicate prevention compares slots; comparing discovery times fails.
2. **DOM and DOW are OR when both are constrained.** `0 9 1 * 1` is "day 1 of every month or every Monday", not "the first Monday of every month". Five-field cron cannot express "satisfy both conditions at the same time"; do not force it.
3. **Compute on the local calendar, store UTC instants.** This one rule solves the gap (advance to a valid time) and the fold (keep two different instants) at the same time. Storing a local time string silently misses one execution on the fold day.
4. **Job and Event must be two objects.** The lifecycle of a definition and the lifecycle of a work intention differ. Merge them, and a one-shot task that crashes between "delete the definition" and "execute" loses work or duplicates work, however you order the steps.
5. **Into the history first, then ack.** Reverse the order, and a crash in the middle loses work forever, with no trace. In the correct order, the worst case is one duplicate execution, and the duplicate is covered by the `idempotencyKey`. **Prefer duplication over loss.**
6. **A full capacity must not advance the time.** A squeezed-out job must keep its original `next_run_at_utc` and wait in place. Advancing first and then dropping work is a class of silent bug that looks completely normal.
7. **The identity comes from the past; the permission comes from the present.** A scheduled task executes with the creator identity, but the current policy at trigger time decides. A cron prompt is a text that waits for resubmission, not a permission ticket.

### One diagram to review the whole chain

```text
                    ┌─────────────────────────────────────┐
                    │  schedule_cron (five required fields)       │
                    │  identity observed from the ToolContext        │
                    └──────────────┬──────────────────────┘
                                   ↓
              ┌────────────────────────────────────────────┐
              │  state.json (version + jobs + outbox)      │
              │  .cron.lock protects the read-modify-write                      │
              └──────────────┬─────────────────────────────┘
                             ↓  the scheduler ticks every second; leader.lock elects the leader
              ┌────────────────────────────────────────────┐
              │  One atomic migration: create an event + advance/delete the job      │
              └──────────────┬─────────────────────────────┘
                             ↓
              ┌────────────────────────────────────────────┐
              │  EventInbox (shared with the background events of Chapter 13)        │
              └──────────────┬─────────────────────────────┘
                             ↓  when the Runner is idle, at most one per turn
              ┌────────────────────────────────────────────┐
              │  Into the history (role=user) → ack → model turn   │
              │  ToolContext.identity = the creator              │
              │  Tools still pass schema → Hook → permission → Hook        │
              └────────────────────────────────────────────┘
```

### Check whether you truly understood

Answer these eight questions without looking at the text above:

1. A "every minute" job is created at `12:00:30`. When is its first slot? Why is it not `12:00:30`?
2. What does `0 9 1 * 1` mean? Name one date on which it triggers that you may not have expected.
3. At what time does a New York "every day at 02:30" job execute on the spring forward day? Why not choose "skip that day"?
4. One snapshot lock is not enough. Why is a leader lock also needed?
5. If a one-shot task had no Job/Event separation, what problem would "delete the definition first, then execute" cause, and what problem would "execute first, then delete the definition" cause?
6. After a restart following three days of downtime, how many catch-up events does a "every minute" job produce? Which time is the slot?
7. When an ack fails, why must the history entry that was just appended be popped out? What happens if it is not popped?
8. Why was the batch injection of Chapter 13 (`batch: {index, total}`) retired as a whole in this chapter? After the retirement, are background events also one at a time?

If you cannot answer one, go back to the corresponding section:

| Question | Go back to |
| --- | --- |
| 1 | "Distinguish the three 'times'" |
| 2 | "DOM and DOW are OR, not AND" + Experiment 1 |
| 3 | "DST gap: the hour that does not exist" + Experiment 2 |
| 4 | "Why one lock is not enough" + Experiment 8 |
| 5 | "Why they cannot be merged into one" |
| 6 | "Down for three days: catch up with one only" + Experiment 5 |
| 7 | "An ack failure must roll back" |
| 8 | "Take one event at a time" + "Why P14 does not batch" |

---

The next article enters Agent Teams. Up to here, the Agent can be triggered by a human, can execute in the background, and can watch the clock by itself, but it is always **one** Agent. When a task is too large for one Agent — someone must write code, someone must review code, someone must run tests — the work needs a team. P15 discusses persistent teammates and an asynchronous inbox: how teammates exist for a long time, how messages are not lost, and how the whole team avoids a deadlock while someone waits for someone else. The event-boundary principle does not change. What changes is that the other end of the event changes from "time" to "another Agent".
