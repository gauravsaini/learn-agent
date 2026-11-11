The previous chapter turned tools from "compiled into the Agent" into "pluggable at runtime": which MCP servers the Agent can connect to comes from a local allowlist, what permission a remote tool has comes from a local policy, and a batch of tools is either published in full or not published at all.

By this point, the nineteen chapters have each solved one thing: Loop, permission, Hook, memory, compaction, recovery, Task, Cron, team collaboration, Worktree, MCP.

But they are still nineteen independent evolution steps.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaGka13EGOqz6T9u1QGbeaOMqFM5QaIAdFzuiaNYm8WgxKjpicrhJG3ICHWjkdEG7HyIGbGdqyYjZs0knaHv26ez0eQJT6o0mmOIU/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

Each chapter has its own entry point, its own tests, and its own "what this chapter adds". The Task DAG in Chapter 12 and the Cron feature in Chapter 14 have never run at the same time in the same process. The context compaction in Chapter 8 and the failure recovery in Chapter 11 each assume, in their own tests, that "the other one does not exist". The MCP dynamic tool pool that Chapter 19 has just built has never met a situation like "a teammate is stuck waiting for approval".

Looked at alone, every chapter is correct. Put together, the trouble is not in the features. It is in **order, sharing, and boundaries**:

```text
They compete for the same position —
Before one model request, who goes first: compaction, dynamic Prompt, event consumption, or the tool snapshot?
A background task finished, a Cron time arrived, a teammate sent a message. Do these three enter one inbox or three?
Is the JobSupervisor that Cron received the same object that the background tool received? What happens if it is not?
Can the model see "which MCP servers are currently connected"? After it sees that, can it use it as a reason for authorisation?
The process is about to close. In what order do the MCP child process, the teammates, Cron, and the background tasks shut down? What if one of them cannot close?
```

One sentence states the mechanism that this chapter must land:

```text
P20 adds no new runtime.
It declares only one thing: the capabilities of the first nineteen chapters must hold at the same time in one composition root.
All capabilities share one AgentRunner, one EventInbox, and one tool snapshot;
Whether dependencies are shared correctly is checked at startup by object identity, not left to fail halfway through a run;
Resources close in the reverse order of registration. If any one of them cannot close, the runtime collects and reports all failures. It must not swallow one silently.
```

Chapter 20 adds only one capability, `full_harness`, on top of all Chapter 19 capabilities. It is the 26th capability, and it is the only capability that "carries no code": no new module, no new tool, no new handler. What it asserts is **coexistence**.

---

## Chapter Guide

### What you can do after you read this chapter

- State why P20 still counts as a chapter although it has "no new code", and what exactly the `full_harness` capability asserts;
- Read the 7 dependency gates in the composition root, and explain why an object identity check must sit at startup, not wait for a runtime error;
- Recite the execution order of one turn of the single `AgentRunner`, and point at which line of `loop.ts` each step sits on;
- State the three invariants: one model reply shares one tool snapshot, one tool call corresponds to exactly one tool result, and neither Prompt nor Hook is an authorisation boundary;
- Explain why `runtime_status` is fixed as the last paragraph of the prompt, why it takes part in the cache key, and why it cannot be an authorisation source;
- State how the Lead's 25 tools were accumulated, and what the teammates were trimmed into;
- State why the three state lines (SQLite tasks, the protocol state machine, the Worktree binding) do not replace each other;
- Explain how a background completion, a Cron trigger, and a teammate message flow into the same `EventInbox`, and how "at-least-once delivery + eventId deduplication + ack" looks like exactly-once to the model;
- Read how the recovery matrix handles each of its four failure kinds, and why the recovery process does not write one entry into the canonical history;
- Find one **real behavior regression** between P19 and P20 yourself, and verify with an experiment that it really did regress;
- Run Chapter 20 yourself, and use 10 experiments that need no API key to verify each conclusion above, one by one.

### What you need first

| Prerequisite | Specific requirement | What happens if you do not have it |
| --- | --- | --- |
| The permission system in Chapter 3 | You know that `effect` is split into read/write/execute/external, that `ask` triggers terminal approval, and that `deny` rejects directly | You will not understand the "deny is stronger than ask" section, and you will misjudge how many times approval was asked |
| The compaction and recovery in Chapters 8 and 11 | You know that compaction rewrites the history, and that recovery retries a model request | The recovery matrix section has no comparison, and you cannot see "why recovery does not enter the history" |
| The state mechanisms in Chapters 12 to 18 | You know what Task DAG, background tasks, Cron, teammates, protocol, and Worktree each store | The three-state-lines section will not let you tell who manages whom |
| The MCP feature in Chapter 19 | You know the dynamic tool pool, the Registry Snapshot, and atomic registration | The prerequisites for Section 11 and for Experiments 4 and 5 do not hold |
| Node.js 22+ | This article was tested on v25.7.0. The repository requires `>=20.12` | The dependencies will not install, or `tsx` will not run |
| Windows PowerShell | Every command in this article uses PowerShell syntax | You must translate the commands into bash yourself |
| Model credentials (optional) | Only the "run it for real once" step needs them | The first 3 steps and all 10 experiments need none |

### Glossary (terms that appear for the first time in this chapter, or whose meaning changed in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| **Harness** | The layer of code that assembles everything outside the model: tools, permission, context, state, and resource lifecycle |
| **full_harness** | The marker capability of P20, the 26th one. It carries no new code. It only asserts that the capabilities of the first nineteen chapters take effect at the same time |
| **Composition root** | The one place in the whole program that is responsible for "creating objects and wiring them together". In this chapter it is `bootstrap.ts` |
| **Object identity** | Whether two variables point to **the same object** (`===`), not whether they "look the same" |
| **Dependency gate** | `validateBuildDependencies()`: at startup it checks, item by item, whether the dependencies are shared correctly. If they are not, it throws at once |
| **Registry Snapshot** | The one immutable tool set that one model request and its whole reply share |
| **Canonical history** | The message sequence that the runtime really feeds to the model, and that compaction and persistence also process. Intermediate recovery states are not in it |
| **runtime_status** | The fixed last paragraph of the dynamic Prompt. It summarises only "is there background work left" and "which MCP aliases are connected" |
| **EventInbox** | The typed inbox that background completions, Cron triggers, and teammate messages share |
| **At-least-once + deduplication** | An event may be delivered many times, but after deduplication by `eventId`, it looks like exactly-once to the model |
| **ack** | The confirmation after an event is consumed successfully. The runtime does not discard the event before the ack, and a failed ack must roll back |
| **Reverse-order close** | The close order is the registration order reversed. The last registered closes first, and the first registered closes last |
| **AggregateError** | When many resources fail to close at the same time, the runtime collects all failures into one error and throws it. It does not report only the first one |
| **The three state lines** | SQLite task state, the protocol state machine, and the Worktree Binding. Each is independent, and they do not replace each other |
| **Plan gate** | The permission rule from Chapter 16: before a teammate submits a plan and gets approval, its side-effect tools are blocked |

### Suggested reading route

```text
[1] Look at the trace of one complete turn first      | It gives you a picture: 25 tools, connect one MCP server, what result each of the three calls gets
      ↓
[2] full_harness is a marker, not a module  | The reason this chapter exists
      ↓
[3] The composition root's object identity gates        | The first core of this chapter: wrong sharing must explode at startup
      ↓
[4] The execution order of the single AgentRunner  | The second core of this chapter: who goes first
      ↓
[5] Three invariants                  | Snapshot / pairing / who the authorisation boundary really is
      ↓
[6] runtime_status is not a permission source   | The only new model-visible output in P20
      ↓
[7] The 25-tool surface and sub-executor trimming     | Who can see what
      ↓
[8] Three state lines + event convergence + recovery  | How state and signals coexist
      ↓
[9] The MCP boundary, and one real regression    | The section where you most need to confirm things with your own hands
      ↓
[10] Resource registration and reverse-order close          | How the process ends cleanly
      ↓
[11] Run Chapter 20 + 10 experiments     | All offline, verify the conclusions above one by one
```

If you have only 10 minutes, read sections `[3]`, `[4]`, and `[9]`, and then run Experiment 2 and Experiment 4.

---

## 1. Look at the Trace of One Complete Turn First

Do not talk about architecture yet. Look at what actually happened in one real P20 turn.

The output below comes from Experiment 4 in this chapter (the complete script is in the section "10 hands-on experiments". It is fully offline and needs no API key). It constructs a model stand-in, and it makes that stand-in emit three tool calls **in the same reply**: connect to an MCP server, call the remote tool that it has just connected, and write a file outside the workspace.

```text
[1] Main model request count: 2
[2] Tool count in request 1: 25
[3] Does request 1 contain mcp__fake__lookup: false
[4] Tool count in request 2: 26
[5] Does request 2 contain mcp__fake__lookup: true
[6] runtime_status in request 1: {"mcp_connections":[],"pending_work":false}
[7] runtime_status in request 2: {"mcp_connections":["fake"],"pending_work":false}
[8] The results of the three tool calls in the same reply:
      probe-connect → {"server_alias":"fake","status":"connected","tools":["mcp__fake__lookup"]}
      probe-mcp     → Error [unknown_tool]: Unknown tool: mcp__fake__lookup
      probe-escape  → Error [permission_denied]: Writing outside the workspace is forbidden
[9] Actual call count of the remote callTool: 0
[10] Tools that approval was asked about: [] (deny is stronger than ask; an out-of-bounds write does not enter approval)
[11] Final answer: probe done
[12] After close(), McpRuntime.isClosed=true
```

In one turn, six things hold at the same time. Read them one by one:

**The tool surface is 25 tools, not "a big pile".** The Lead tools that twenty chapters accumulated are exactly 25, from `shell` to `disconnect_mcp`. You can count this number (Experiment 10 lists them one by one).

**`connect_mcp` succeeded, but the new tool cannot be used in this turn.** Line 8 shows that `probe-connect` clearly returns `"status":"connected"`, and the tool list really does contain `mcp__fake__lookup`. But the `probe-mcp` call right after it, using the same name, receives `unknown_tool`. This is not a bug — lines 2 and 4 explain the reason: request 1 carries 25 tools, and request 2 is the first to carry 26. **All tool calls in one model reply share the one tool snapshot from the request that started the reply.** The connection changes the "live registry", not the snapshot in this reply's hand.

**The remote handler was never really called once.** Line 9: `Actual call count of the remote callTool: 0`. The `unknown_tool` result is a rejection in place, on the snapshot. The request never reached the transport layer.

**The out-of-bounds write was rejected, and it did not disturb approval.** Line 10 is the place in this chapter that is easiest to misread. Since P3 there has been a `confirm-file-write` rule, and `write_file` should normally go through `ask` approval. But the path in this write sits outside the workspace. The workspace boundary gives a `deny`, and `deny` is stronger than `ask` — the final decision is rejection, and the approval provider was not even asked. So "tools that approval was asked about" is an empty array.

**`runtime_status` changed, but it is only an observation result.** Lines 6 and 7: at request 1, `mcp_connections` is empty; at request 2 it has become `["fake"]`. The model can see what is currently connected, but seeing is not authorisation — the `unknown_tool` on line 8 is the evidence: the status bar says the tool exists, and the call is still rejected.

**Three tool calls, three results, not one fewer.** Even if two of them are errors, each one must return one result that pairs with its `tool call id`. One fewer, one more, or an ID that does not match makes the history illegal (Experiment 6 runs the six wrong forms one by one).

**The process closed cleanly.** Line 12: after `close()`, the MCP runtime really did close, and no child process stays in the background.

The rest of this chapter takes each line above apart and explains it clearly: why it must be this way, on which line the code sits, and how you can run it yourself to confirm it.

---

## 2. full_harness Is a Marker, Not a Module

### 2.1 Look at what it looks like in the code first

Open `code/chapters/ch20/src/core/profiles.ts`. The capability list is declared like this (lines 80 to 103):

```typescript
// Each chapter declares only new capabilities; subsequent chapters obtain complete profiles through cumulative PROFILE_DELTAS.
const PROFILE_DELTAS = [
  ["loop", "powershell"],
  ["tool_registry", "files"],
  ["policy"],
  ["hooks"],
  ["todo"],
  ["subagent"],
  ["skills"],
  ["artifacts", "compaction"],
  ["memory"],
  ["dynamic_prompt"],
  ["recovery"],
  ["task_dag_json"],
  ["background"],
  ["cron"],
  ["teammate", "mailbox"],
  ["protocol", "plan_gate"],
  ["task_dag_sqlite", "work_stealing"],
  ["worktree"],
  ["mcp"],
  // full_harness is the P20 marker capability: adds no specific runtime, only declares capabilities from the previous 19 chapters are active.
  ["full_harness"],
] as const satisfies readonly (readonly Capability[])[];
```

Each row is "what this chapter added", not "what this chapter has". The complete profile comes from accumulation (lines 105 to 113):

```typescript
// PROFILES is derived from incremental capability arrays, ensuring each chapter profile is a strict superset of the previous one.
const PROFILES: readonly ChapterProfile[] = Object.freeze(
  PROFILE_DELTAS.map((_, index) =>
    Object.freeze({
      chapter: index + 1,
      capabilities: new CapabilitySet(PROFILE_DELTAS.slice(0, index + 1).flat()),
    }),
  ),
);
```

The expression `slice(0, index + 1).flat()` means "flatten all the deltas from Chapter 1 to Chapter N". This one line of code guarantees one thing: **P(N) is always a strict superset of P(N-1)**. The case "Chapter 15 has it, Chapter 16 lost it" cannot occur.

### 2.2 The accumulated numbers

Experiment 1 prints the capability count of all twenty chapters directly:

```text
[1] Cumulative capability count per chapter: P01=2 P02=4 P03=5 P04=6 P05=7 P06=8 P07=9 P08=11 P09=12
    P10=13 P11=14 P12=15 P13=16 P14=17 P15=19 P16=21 P17=23 P18=24 P19=25 P20=26
[2] What P20 adds relative to P19: [full_harness]; what it removes: []
[3] Does P20 still hold every capability of P19: true
```

There are 26 capabilities. P20 has exactly one more than P19, `full_harness`, and it has lost none.

This "only one marker more" is the place in this chapter that is easiest to misunderstand, so let me state clearly what it is **not**:

| What it is not | Why |
| --- | --- |
| It is not a new module | There is no `full-harness.ts`. Relative to P19, P20 adds only one source file: the entry point `src/chapters/ch20.ts` (5 lines) |
| It is not a new tool | The Lead's tool surface is 25 tools in both P19 and P20. `full_harness` registers no tool |
| It is not a switch | There is no `if (capabilities.has("full_harness"))` that enables some feature branch |
| It is not an "ultimate framework" | There is no second Loop, no second Runner, and no second history |

So what does it do? It is **the name of the assembly contract**. The `bootstrap.ts` file requires that `mcpRuntime` exist because the profile's chapter number is ≥ 19. It installs the dynamic prompt because of the `dynamic_prompt` capability. It installs the `runtime_status` status bar because the profile is P20. The meaning of the `full_harness` marker is this: **when it appears, the previous 25 capabilities must all be able to work at the same time in one process, and a test must prove it.**

The place that proves it is `code/chapters/ch20/tests/ch20-full-harness.test.ts` (1212 lines, 7 tests). Not one of these 7 tests tests a "new feature". All of them test "will the old features step on each other when you put them together".

### 2.3 A profile must be a fixed object. You cannot assemble one yourself

`profileForChapter()` accepts only 1 to 20 (lines 137 to 143):

```typescript
export function profileForChapter(chapter: number): ChapterProfile {
  // Only fixed chapters 1 through 20 are queryable; fail immediately on out-of-bounds queries to prevent unknown profiles.
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > PROFILES.length) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  return profileAt(chapter);
}
```

The second half of Experiment 1 verifies this gate:

```text
[4] profileForChapter(20) === P20: true
[5] profileForChapter(21) → chapter must be an integer from 1 to 20
[6] profileForChapter(19.5) → chapter must be an integer from 1 to 20
[7] A hand-made {chapter:20, capabilities:...} passed to buildAgent → profile must be a fixed chapter profile
```

Line 7 is the key. Even if you hand-make a `{chapter: 20, capabilities: <a capability set exactly like P20's>}`, `buildAgent` rejects it. Its check method is **object identity**:

```typescript
if (profileForChapter(profile.chapter) !== profile) {
  throw new Error("profile must be a fixed chapter profile");
}
```

It uses `!==`, not an item-by-item capability comparison. Why so strict? Because as soon as you allow a caller to assemble a capability set freely, a "chapter" is no longer a contract — someone can assemble a combination with `mcp` but without `dynamic_prompt`, and run an Agent that no test has ever covered. Fixed objects converge the possible combinations from 2^26 down to 20, and each one has a corresponding test file.

---

## 3. The Composition Root: Wrong Sharing Must Explode at Startup

This section is the first core of this chapter.

### 3.1 State clearly what a "false complete implementation" looks like

Imagine an assembly error: the `CronRuntime` received `JobSupervisor` A, and the background tool received `JobSupervisor` B. Both supervisors work normally. The types are completely correct. TypeScript reports no error, and startup does not fail either.

Then you see a phenomenon like this:

```text
The Cron time arrives → the runtime submits the job to supervisor A → after completion, the event enters A's EventInbox
Before the model's next request, the Runner reads events from B's EventInbox → empty
So Cron clearly ran to completion, and the model never knows
```

All the features exist. A test of Cron alone passes, and a test of the background feature alone passes. But put together, it is broken, and it is broken quietly — no exception, no error message, only an event that never arrives.

A comment in `bootstrap.ts` writes this counter-example out directly (lines 331 to 332):

```typescript
// Reference identity checks here are assembly gates for Full Harness: Same store, EventInbox, Cron, teammates, and MCP resources
// Must be created by the same composition root, avoiding pseudo-complete implementations where "all features exist but each holds isolated state".
```

"All features exist but each holds isolated state" — that is a false complete implementation. The P20 method against it is not a documentation reminder. It is a check at startup, item by item, with `!==`.

### 3.2 Run through the seven gates, one by one

Experiment 2 triggers every item of `validateBuildDependencies()` once:

```text
[1] Complete dependencies → (no error)
[2] Replace cronRuntime (another supervisor/inbox) → cronRuntime must share the background supervisor and event inbox
[3] Replace only protocolRuntime → protocolRuntime must share the teammate runtime and mailbox store
[4] Replace teammateRuntime + protocolRuntime (the two match each other) → teammateRuntime must share the background supervisor, EventInbox, and CronRuntime
[5] Replace worktreeRuntime (not the claimService) → worktreeRuntime must be the WorkStealingRuntime claim service and share its store
[6] Delete mcpRuntime → mcpRuntime is required for chapter 19 or later
[7] Give P20 dependencies to P18 → mcpRuntime requires chapter 19 or later
```

There is a detail on line 4 that deserves a note: when you replace only `teammateRuntime`, the error that comes out is in fact the `protocolRuntime` one — because the protocol sharing check sits before the teammate sharing check, and `protocolRuntime` still references the old teammate, so it collides first. To see the teammate error, you must replace `teammateRuntime` and `protocolRuntime` together, **as a pair that matches each other**. This also shows that the gates have an order: when the first item is not satisfied, the check does not continue downward.

### 3.3 Three classes of check, with completely different roles

Group the twenty-plus `if` statements in `validateBuildDependencies()`, and there are in fact only three classes:

```text
Class 1: a capability requires a dependency to exist ("is required for")
    The profile has mcp, but mcpRuntime is undefined  →  explode
    Typical error string: mcpRuntime is required for chapter 19 or later

Class 2: a dependency requires the capability to be high enough ("requires chapter N or later")
    You passed an mcpRuntime, but the profile is P18  →  explode
    Typical error string: mcpRuntime requires chapter 19 or later

Class 3: dependencies must be the same object as each other ("must share" / "must be")
    You passed a cronRuntime, but its supervisor is not the one you passed  →  explode
    Typical error string: cronRuntime must share the background supervisor and event inbox
```

The first two classes check "is the count right". The third class is the one this chapter really cares about: "is the identity right". Look at the code and the difference is clear (lines 398 to 405):

```typescript
if (
  dependencies.cronRuntime !== undefined &&
  (dependencies.backgroundSupervisor === undefined ||
    dependencies.cronRuntime.supervisor !== dependencies.backgroundSupervisor ||
    dependencies.cronRuntime.eventInbox !== dependencies.backgroundSupervisor.eventInbox)
) {
  throw new Error("cronRuntime must share the background supervisor and event inbox");
}
```

`cronRuntime.supervisor !== dependencies.backgroundSupervisor`: it does not compare types, and it does not compare fields. It compares **whether these two variables refer to the same object**. This one line is the cure for the bug in Section 3.1.


### 3.4 Four groups of "must be the same object" relations

P20 guards four groups of identity relations in total. A diagram makes them clearer:

```text
                    ┌──────────────────────┐
                    │   JobSupervisor      │  ← The supervisor of background tasks
                    │   .eventInbox        │  ← The only event inbox
                    └──────────┬───────────┘
                               │ Must be the same object
              ┌────────────────┼────────────────┐
              │                │                │
      ┌───────▼──────┐  ┌──────▼───────┐        │
      │ CronRuntime  │  │ Teammate     │────────┘
      │ .supervisor  │  │ Runtime      │  .supervisor / .eventInbox
      │ .eventInbox  │  │ .cronRuntime │──┐
      └──────┬───────┘  │ .mailboxStore│  │ Must be the same CronRuntime
             └──────────┴──────┬───────┘◄─┘
                               │ Must be the same object
                       ┌───────▼────────────┐
                       │ ProtocolRuntime    │
                       │ .teamRuntime       │
                       │ .mailboxStore      │
                       └────────────────────┘

      ┌────────────────────┐        ┌─────────────────────┐
      │ WorkStealingRuntime│        │  WorktreeRuntime    │
      │ .store             │◄──────►│  .store             │  The same SQLite store
      │ .claimService      │◄───────│  (is itself)         │  claimService === worktreeRuntime
      └────────────────────┘        └─────────────────────┘
```

The table lists them again, so you can compare against an error message:

| This group | What it checks | Error string | What happens if you do not check it |
| --- | --- | --- | --- |
| Cron ↔ background | `cronRuntime.supervisor` and `.eventInbox` must both be the ones you passed | `cronRuntime must share the background supervisor and event inbox` | A Cron completion event enters another inbox, and the model never receives it |
| Teammate ↔ background/Cron | `teammateRuntime`'s supervisor, eventInbox, and cronRuntime must all agree | `teammateRuntime must share the background supervisor, EventInbox, and CronRuntime` | A teammate completion notification is lost, or a teammate's scheduled task is not managed by the main Cron |
| Protocol ↔ teammate | `protocolRuntime.teamRuntime` and `.mailboxStore` must agree | `protocolRuntime must share the teammate runtime and mailbox store` | Plan approval is written into one mailbox, the teammate reads another, and the plan gate never opens |
| Worktree ↔ work stealing | `worktreeRuntime` must **be** `workStealingRuntime.claimService`, and the two `store` values must be the same | `worktreeRuntime must be the WorkStealingRuntime claim service and share its store` | Task claiming and directory binding separate, and a teammate changes files in the wrong directory |

The fourth group is written in a special way, and it deserves a separate look (lines 376 to 385):

```typescript
if (
  dependencies.worktreeRuntime !== undefined &&
  (dependencies.workStealingRuntime === undefined ||
    dependencies.workStealingRuntime.store !== dependencies.worktreeRuntime.store ||
    dependencies.workStealingRuntime.claimService !== dependencies.worktreeRuntime)
) {
  throw new Error(
    "worktreeRuntime must be the WorkStealingRuntime claim service and share its store",
  );
}
```

Note the last condition: `claimService !== worktreeRuntime`. The requirement is not "claimService looks like worktreeRuntime". The requirement is that **it is the same object**. This line maps to the Chapter 18 conclusion: a Task Claim and the actual execution directory must be bound by the same chain. If `claimService` is another implementation, you can get "the claim succeeded but the directory was not created", or "the directory was created but the claim record is elsewhere".

### 3.5 Why it must explode at startup

This point deserves separate stress, because it is a design habit that you can move into your own projects.

```text
An assembly error explodes at startup:
  Error timing —— The process has just started, and the first line of business code has not run yet
  Error content —— "cronRuntime must share the background supervisor and event inbox"
  Investigation cost —— Read this one sentence and you know where to change the code
  Impact range   —— Zero. No half-assembled Agent, no dirty state written

An assembly error surfaces at runtime:
  Error timing —— It ran for 40 minutes, and it surfaces after one Cron completion
  Error content —— There is no error. The event simply never arrives, and the logs are as clean as if everything were normal
  Investigation cost —— You must suspect Cron, the EventInbox, the Runner's event consumption, and the deduplication logic at the same time
  Impact range   —— The task state, worktrees, and approval records produced in the meantime are already on disk
```

`validateBuildDependencies()` is the first statement of `buildAgent()` (line 95). It runs before the code creates any tool or any runtime:

```typescript
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // Construction order of Full Harness is fixed: "validate dependencies first, register tools next, then delegate resources to Runner";
  // This ensures any failure happens within a clear composition boundary without leaving a half-assembled Agent.
  validateBuildDependencies(profile, dependencies);
```

"No half-assembled Agent is left behind" is the whole reason for this order. If validation sits later, the code may first start an MCP child process and first create a worktree, and only then discover that a dependency is wired wrong — at that point there is much more to clean up.

---

## 4. One AgentRunner, One Fixed Execution Order

This section is the second core of this chapter. The capabilities of twenty chapters all hang on the same `AgentRunner`. Who executes before whom is not arbitrary.

### 4.1 The complete order diagram

Look at the whole diagram first, and then read the explanation paragraph by paragraph. All line numbers point to `code/chapters/ch20/src/core/loop.ts`.

```text
run(prompt)                                              L271
  │
  ├─ #ensureOpen()  Already closed → throw "AgentRunner is closed" at once   L754
  ├─ Run lock: already running → reject a concurrent turn
  │
  └─ #runUserTurn(prompt)                                L332
       │
       ├─ [1] userMessage + UserPromptSubmit hook          L342-344
       │        ↑ Can only add content, cannot authorise
       ├─ [2] turnLifecycle.beginTurn(prompt)              L348   ← Memory selection
       ├─ [3] modelRequestExecutor.beginTurn()             L351   ← Recovery counter resets to zero
       │
       └─ for turn = 1 .. maxTurns                         L366
            │
            ├─ [4] #acceptNextRuntimeEvent(false, false)    L369  ← Collect background events
            │
            ├─ [5] #prepareModelRequest()                   L372 → L478
            │        ├─ validateToolPairing(history)             L482
            │        ├─ historyProcessor.prepare()  Request-level compaction    L486
            │        ├─ validateToolPairing(requestHistory)      L494
            │        ├─ turnLifecycle.beforeModel()              L496
            │        ├─ toolRoundObserver.beforeModel()          L505
            │        ├─ systemMessage(#renderSystemPrompt())     L508  ← Dynamic Prompt
            │        ├─ validateToolPairing(requestMessages)      L513
            │        └─ tools = this.#tools.snapshot()            L516  ← The snapshot is right here
            │
            ├─ [6] model.complete() or RecoveryManager.complete()  L374-376
            │        ├─ finishReason === "length"       → IncompleteModelReplyError  L378
            │        └─ finishReason === "content_filter" → AgentRunError            L381
            │
            ├─ [7] history.push(assistant)                  L386
            │
            ├─ No toolCalls?
            │    ├─ [8] Stop hook (at most one forceContinue) L391-397
            │    ├─ [9] #acceptNextRuntimeEvent(true, false) L398 ← Wait once more before the wrap-up
            │    └─ [10] #complete(content, turn)            L403
            │
            └─ ToolCalls exist? Execute them one by one                        L410
                 │
                 ├─ [11] #executeTool(call, context, tools)  L418 → L537
                 │         ├─ tools.prepare(call)     Unknown tool → unknown_tool
                 │         ├─ Zod validates the arguments
                 │         ├─ #resolveToolContext()          L631  ← Trusted workspace
                 │         ├─ PreToolUse hook                      ← Can reject, cannot widen
                 │         ├─ PermissionPolicy.evaluate()          ← The real authorisation boundary
                 │         ├─ definition.invoke(args, ctx)
                 │         └─ PostToolUse hook
                 │
                 ├─ [12] #processToolResults()                L427
                 └─ [13] Push one by one: history.push(toolMessage(result.content, call.id))  L434
                          ↑ Exactly one per call, and the id must match
```

### 4.2 Why three positions must be in those positions

In the whole diagram, three orders break if you swap them.

**First position: `#acceptNextRuntimeEvent` sits before `#prepareModelRequest` (L369 before L372).**

Event consumption must be earlier than request assembly. The reason is in the comment:

```typescript
// In a user turn, receive only regular background events; delay Cron and mailbox context events to avoid interrupting the active user session.
// Receive completed background events before each model request to prevent events from being visible only in the first turn.
await this.#acceptNextRuntimeEvent(false, false);
```

"Avoid events being visible only in the first turn" is the key. If the code collects events only once, when it enters the turn, then a background task that finishes during turn 2 of a three-tool-turn run must wait until the next user input before the model can see it. If the code collects events on every turn inside the loop, a background result enters the context at the next model request at the latest.

**Second position: `snapshot()` is the last step of `#prepareModelRequest` (L516).**

```typescript
validateToolPairing(requestMessages);
const tools = this.#tools.snapshot();
return Object.freeze({
  request: Object.freeze({ messages: requestMessages, tools: tools.openAITools() }),
  tools,
});
```

The code uses the same `tools` object twice: once it converts it with `openAITools()` and sends it to the model, and once it returns it to `#executeTool`. This is the complete explanation of "connected but unusable" in Section 1 — the tool list that the model sees and the tool set that execution validates against **are the same immutable object**. Even if you connect ten MCP servers in between, this reply cannot use them.

**Third position: the system prompt renders on every turn. It is not fixed at build time (L508).**

```typescript
// The system prompt renders before each turn assembly request, making tool list and selected memory changes take effect next turn.
systemMessage(this.#renderSystemPrompt()),
```

Note the wording "take effect next turn". Rendering happens before every turn's request, so the previous turn's connection, the previous turn's selected memory, and the previous turn's background state all appear in this turn's prompt. But **within the same turn** nothing changes — rendering and the snapshot are two adjacent steps inside the same `#prepareModelRequest` call.

### 4.3 `validateToolPairing` is called three times. That is not redundancy

`#prepareModelRequest` validates pairing three times (L482, L494, L513). The positions are:

| Timing | Object validated | What it blocks |
| --- | --- | --- |
| Before the processor | `this.#history` (canonical history) | The previous turn wrote its own history badly |
| After the processor | `requestHistory` (the history after compaction) | **Compaction split one call/result pair apart** |
| After assembly | `requestMessages` (with the system prompt and guidance messages) | An injected guidance message was inserted between a call and its result |

The second validation is the most important. Compaction rewrites the history, and it is the mechanism in this chapter that is most likely to break pairing — it drops old messages, and an "old message" may hold exactly one tool result whose tool call was dropped earlier. This validation is the acceptance gate for compaction.


### 4.4 One turn allows at most one Stop continuation

The boolean `stopHookActive` controls "can the Stop hook keep demanding continuation" (L365, L390 to 396):

```typescript
const stopHook = await this.#hooks.runStop(this.#history, stopHookActive);
if (stopHook.forceContinue !== undefined) {
  // Stop Hook can force injection of a continuation prompt when the model makes no tool calls, overriding normal termination.
  this.#history.push(...stopHook.additionalContext, stopHook.forceContinue);
  stopHookActive = true;
  continue;
}
```

The first time the code enters the Stop hook, `stopHookActive` is `false`, and the hook can return a `forceContinue` that pulls the turn back into the loop. After the continuation, `stopHookActive` becomes `true`, and the code passes it to `runStop` again — when the implementation sees this mark, it should not demand continuation again. This constraint prevents one specific infinite loop: the Stop hook says "one more turn" every time, the model says "I am done" every time, and the turn runs until `maxTurns` every time.

---

## 5. Three Invariants

The previous section covered order. This section covers three things that "must hold no matter how the order runs". P20 uses them to judge "was the integration done right".

### 5.1 Invariant 1: one model reply shares one tool snapshot

The implementation of `ToolRegistry.snapshot()` has only two lines (`code/chapters/ch20/src/core/tools.ts`):

```typescript
snapshot(): ToolRegistry {
  // Returns an immutable snapshot so executing turns are not affected by subsequent MCP connect or disconnect operations.
  return new ToolRegistry(this.#definitions, false, this.#version);
}
```

The second argument, `false`, is `mutable`. The snapshot copies the definitions Map, reuses the current version number, and then marks itself immutable.

Experiment 5 runs its behavior in full:

```text
[1] Live registry v1: [alpha]
[2] Snapshot v1: [alpha]
[3] Live registry after an addition, v2: [alpha, beta]
[4] The same snapshot is still v1: [alpha]
[5] prepare("beta") on the snapshot → Error [unknown_tool]: Unknown tool: beta
[6] Try to register into the snapshot → tool registry snapshot is immutable
[7] Revoke by name (not by object identity) → tool definition was not registered by this registry
[8] Revoke by object identity → (no error)
[9] Live registry after revocation, v3: [beta]
```

Lines 3 and 4 are the core: the live registry has already grown to v2 and has `beta`, and the snapshot still stays at v1 with only `alpha`. Line 5 is this design's direct consequence for the model — a `beta` call on the snapshot receives `unknown_tool`, exactly like the `mcp__fake__lookup` in Experiment 4 in Section 1.

Lines 7 and 8 are another layer of protection. Revocation compares **object identity**, not the name:

```typescript
// unregisterMany uses #sourceDefinitions (WeakMap) to confirm that this definition was really registered by this registry
throw new Error("tool definition was not registered by this registry");
```

If you pass in a definition that "has the same name and the same shape but is not the same object", the revocation fails. The scenario this blocks is: an MCP connection drops and must revoke the 5 tools it published, but in the meantime another server has already republished a tool with the same name — revocation by name would delete the new connection's tool by mistake, and revocation by object identity revokes only its own batch.

### 5.2 Invariant 2: one tool call gets exactly one tool result

The rule is implemented in `code/chapters/ch20/src/core/messages.ts` (lines 117 to 149):

```typescript
export function validateToolPairing(messages: readonly ChatMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (pending.size > 0) {
      if (message.role !== "tool") {
        throw new MessageContractError(
          `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
        );
      }
      if (!pending.delete(message.toolCallId)) {
        throw new MessageContractError(`unexpected tool result id: ${message.toolCallId}`);
      }
      continue;
    }
    if (message.role === "tool") {
      throw new MessageContractError(`orphan tool result id: ${message.toolCallId}`);
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        pending.add(call.id);
      }
    }
  }
  if (pending.size > 0) {
    throw new MessageContractError(
      `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
    );
  }
}
```

The reading is simple: `pending` holds "call IDs that still owe a result". As long as `pending` is not empty, the next message **must** be a tool message, and its ID must be in `pending`.

Experiment 6 runs all six wrong forms:

```text
[1] A result with the same id follows the call at once → (no error)
[2] The turn ends after the call, with no result → missing tool results for ids: ["call-1"]
[3] A result with a different id follows the call → unexpected tool result id: call-2
[4] A user message is inserted after the call first → missing tool results for ids: ["call-1"]
[5] A result exists with no call → orphan tool result id: call-1
[6] The same id is filled back twice → orphan tool result id: call-1
```

Line 4 deserves attention: inserting a normal user message between a call and its result is also not allowed. This explains why Section 4.3 validates once more after request assembly — if an injected guidance message lands in the wrong position, it is exactly the line 4 error.

The error message on line 6 may look a little counter-intuitive: filling the same ID back twice reports `orphan` (an isolated result), not "duplicate". The reason is that the first result already deleted `call-1` from `pending`. When the second one arrives, `pending` is empty, and the code takes the "a result exists with no call" branch.

The place on the Loop side that guarantees this invariant is L427 to 434:

```typescript
for (const [index, call] of assistant.toolCalls.entries()) {
  const result = processedResults[index];
  if (result === undefined) {
    throw new AgentRunError("Tool execution did not produce a paired result");
  }
  // Every tool call must backfill a tool message; otherwise subsequent model requests break protocol pairing.
  this.#history.push(toolMessage(result.content, call.id));
}
```

The code iterates in the order of `assistant.toolCalls` and fills results back in pairs, one by one. Even if a tool is rejected by permission, stopped by a Hook, or fails argument validation, the code must fill back one error result — it cannot skip it. The three results in Experiment 4 in Section 1 (one success, two errors) are this rule made visible.


### 5.3 Invariant 3: neither Prompt nor Hook is an authorisation boundary

This invariant is the one of the three that is easiest to violate, because code that violates it usually looks very reasonable.

First, state clearly what each of the three mechanisms can do:

| Mechanism | Can do | Cannot do |
| --- | --- | --- |
| System prompt | Tell the model "do not write files outside the workspace" | Stop the model from really doing it |
| PreToolUse hook | Reject one call, append context | Change a system `deny` into an `allow` |
| PermissionPolicy | Really decide allow / ask / deny | —— |

The prompt point needs no long explanation: the model can ignore any instruction, so a prompt is always only advice.

The Hook point needs code. The order in which `PermissionPolicy.evaluate()` collects candidate decisions is (`permissions.ts` lines 257 to 265):

```typescript
const workspaceBoundary = await this.#workspaceBoundaryDecision(request);
if (workspaceBoundary !== undefined) {
  candidates.push(workspaceBoundary);
}
const shellDefault = shellDefaultDecision(request);
if (shellDefault !== undefined) {
  candidates.push(shellDefault);
}

candidates.push(...request.recommendations, ...(await this.#evaluateRules(request)));

const proposed = strongestDecision(candidates);
```

A Hook's opinion enters through `request.recommendations` — it is only **one of the candidates**. The code throws it into the same array, on equal footing with the workspace boundary, the shell default, and the explicit rules. The final decision comes from `strongestDecision()` (lines 302 to 314):

```typescript
function strongestDecision(decisions: readonly PermissionDecision[]): PermissionDecision {
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
```

The order of `["deny", "ask", "allow"]` is the strength order. As long as one `deny` exists among the candidates, nothing else counts — **a Hook's recommended `allow` cannot override the system's `deny`**, because the code finds `deny` first.

### 5.4 The practical consequence of "deny is stronger than ask"

In `strongestDecision`, `deny` ranks before `ask`. This produces one concrete phenomenon, and it is the confusing line of output in Section 1:

```text
[10] Tools the approval provider was asked about: [] (deny is stronger than ask, so an out-of-bounds write never reaches approval)
```

Work through the call "write a file outside the workspace" in full, once:

```text
Tool: write_file, effect = "write", path = <a path outside the workspace>

Candidate 1: #workspaceBoundaryDecision
        effect === "write" ✓, path is a string ✓
        isPathWithinWorkspace(...) → false
        → PermissionDecision("deny", "Writing outside the workspace is forbidden", "workspace-boundary")

Candidate 2: shellDefaultDecision
        effect !== "execute" → undefined, does not participate

Candidate 3: request.recommendations (Hook opinions)
        Empty in this example

Candidate 4: #evaluateRules → the confirm-file-write rule
        The tool name is write_file ✓
        → PermissionDecision("ask", "File writes require explicit approval from chapter 3 onward", ...)

strongestDecision([deny, ask])
        Find "deny" → hits candidate 1
        → The final decision is deny

proposed.behavior === "deny", not "ask"
        → The code does not enter #resolveApproval
        → The approval provider is never called, not even once
```

So "the tools the approval provider was asked about" is an empty array not because a rule is missing. The reason is that **the stronger refusal took effect first, and the call never reached the step where a person is asked**.

This behavior is correct: the meaning of approval is "let a person decide whether this risky operation should happen". A workspace violation is already a system hard boundary. It does not need, and should not get, a chance for a person to approve it. Think of it in reverse: if `ask` were stronger than `deny`, then any hard boundary could be bypassed by one mis-clicked approval.

Also remember a related rule: `shellDefaultDecision` makes every tool with `effect === "execute"` use `ask` by default (lines 324 to 333):

```typescript
if (definition.effect !== "execute") {
  return undefined;
}
return new PermissionDecision("ask", "Shell execution requires approval", "shell-default");
```

This is a default value. It needs no rule configuration. The `shell` tool therefore requires approval by nature.

### 5.5 There is one more boundary, further in front

Before the permission decision, `#executeTool` resolves the tool's workspace once (`loop.ts` L626, `#resolveToolContext`). Its failure message is:

```text
resolved tool workspace is outside the controlled workspace root
```

This boundary governs not "can you write this path", but "in which directory does this tool run". Chapter 18's worktrees assign different directories to different tasks, and this step confirms that the resolved directory is still under the controlled root. It throws an exception instead of returning a decision, because this is an assembly-error-level problem — if a tool's execution directory runs outside the controlled range, the binding chain itself is broken. It is not a question of whether one call should be approved.

One tool call therefore passes three gates, from outside to inside:

```text
[Gate 1] #resolveToolContext   The tool's run directory must be inside the controlled root     → Throws an exception
[Gate 2] PermissionPolicy      Is this operation allowed (including the workspace write boundary)  → allow/ask/deny
[Gate 3] The handler itself    Business validation                        → ToolResult
```

Hooks hang before and after Gate 2 (PreToolUse / PostToolUse). They can observe, they can reject, and they can add context. But they are not on the decision chain of these three gates.

---

## 6. runtime_status: The Only New Model-Visible Output of P20

`full_harness` brings no new runtime. But it does make the model see one more thing: the dynamic prompt gains one final section, `## runtime_status`.

### 6.1 What it looks like

It is one line of JSON:

```text
## runtime_status
{"mcp_connections":["fake"],"pending_work":false}
```

It has two fields. Both come from synchronous reads (`bootstrap.ts` lines 78 to 93):

```typescript
// P20 renders runtime state as runtime_status, the final section of the dynamic Prompt.
// Only synchronously readable facts are summarized here: Whether background work remains, and which aliases MCP currently connects to.
// The status bar does not replace EventInbox: events are still consumed before requests, and status only helps the model decide whether to wait in the next turn.
function fullHarnessRuntimeStatus(dependencies: BuildDependencies): JsonObject {
  // statusProvider only reads current snapshots without triggering connection, task, or event side effects; dynamic Prompts observe rather than schedule.
  const pendingWork =
    dependencies.backgroundSupervisor?.hasPendingWork === true ||
    dependencies.cronRuntime?.hasPendingWork === true ||
    dependencies.teammateRuntime?.hasPendingWork === true;
  const mcpConnections =
    dependencies.mcpRuntime === undefined ? [] : dependencies.mcpRuntime.connectedAliases;
  return Object.freeze({
    mcp_connections: Object.freeze([...mcpConnections]),
    pending_work: pendingWork,
  });
}
```

Each of the three comments denies one misuse:

- "Only synchronously readable facts are summarized" — it starts no asynchronous call. The status bar must not ping a remote server because it renders a prompt.
- "does not replace EventInbox" — `pending_work: true` only says "work is still running". The concrete result must still enter the history through the event channel.
- "observe rather than schedule" — reading `connectedAliases` does not reconnect as a side effect, and reading `hasPendingWork` does not advance a queue as a side effect.

### 6.2 It is installed only for P20

The assembly code is at lines 280 to 297:

```typescript
const systemPromptProvider = dynamicPrompt
  ? new DynamicPromptProvider({
      renderer: new DynamicPromptRenderer(),
      identity: systemPrompt,
      tools,
      workspace: dependencies.workspace,
      context: Object.freeze({ chapter: profile.chapter, identity }),
      ...(profile.capabilities.has("full_harness")
        ? {
            // State sections of P20 participate in DynamicPromptRenderer cache keys, so changes in connections or pending work trigger re-rendering on the next request.
            // P20 uses statusProvider so MCP connections and background states re-read on the current request and stay at prompt end.
            statusProvider: () => fullHarnessRuntimeStatus(dependencies),
          }
        : {}),
      ...(skillRegistry === undefined ? {} : { skills: skillRegistry }),
      ...(memorySession === undefined ? {} : { memory: memorySession }),
    })
  : undefined;
```

`profile.capabilities.has("full_harness")` is the only place in the whole codebase that reads this capability. P19 and the earlier chapters take the `{}` branch, and their prompts have no `runtime_status` section — this guarantees that the old chapters' prompts did not change by one byte, and that all old tests stay valid.

Note that `statusProvider` is a **function**, not a value. `DynamicPromptProvider.render()` calls it again every time:

```typescript
...(this.#statusProvider === undefined ? {} : { status: this.#statusProvider() }),
```

So the code re-reads the state on every turn's request. Passing a non-function fails at construction time:

```typescript
if (options.statusProvider !== undefined && typeof options.statusProvider !== "function") {
  throw new TypeError("statusProvider must be a function");
}
```

### 6.3 Fixed as the last section, and part of the cache key

These two things are all of P20's changes to `prompting.ts`. Together they are 26 lines.

Look at the position first. In `DynamicPromptRenderer.render()`, `runtime_status` is the last section pushed into sections:

```typescript
if (statusJson !== undefined) {
  // Runtime state is fixed at the end. State changes do not move or reorder preceding stable sections.
  sections.push(`## runtime_status\n${statusJson}`);
}
```

The section order is therefore fixed:

```text
## identity        ← Identity + context JSON
## tools           ← The current tool name list
## workspace       ← The resolved absolute path
## skills          ← Optional, appears only when a Skill exists
## memory          ← Optional, appears only when memory is selected
## runtime_status  ← Optional, only P20 has it; always last
```

The "append only, never cut in line" constraint is very practical for model caching: the state changes every turn (a background task started, MCP connected). If it sat in the middle, the positions of all stable content before it would move. Placed at the end, a change affects only the tail.

Now look at the cache key:

```typescript
const cacheInput: Record<string, JsonValue> = {
  context, identity, memory: memoryBody, skills: skillCatalog, tools: [...tools], workspace,
};
if (statusJson !== undefined) {
  cacheInput.status = statusJson;
}
const key = stableJson(cacheInput);
```

The state **must** take part in the cache key. The reason is direct: the renderer has a cache, and a hit returns the previous string at once. If `status` is not in the key, then when the state changes from `{"mcp_connections":[]}` to `{"mcp_connections":["fake"]}`, the key does not change, the cache hits, and the returned prompt is still the old one — the model never sees the state update.

Experiment 3 verifies both points:

```text
[1] Section order without status: ## identity ## tools ## workspace
[2] Section order with status: ## identity ## tools ## workspace ## runtime_status
[3] Content of the last section: {"mcp_connections":[],"pending_work":false}
[4] Render the same status again, cacheHits 0 → 1
[5] Change only the status, and cacheHits is still 1, which shows the cache was judged invalid
[6] The new last section: {"mcp_connections":["fake"],"pending_work":true}
[7] Is the body before runtime_status completely unchanged: true
[8] Pass a non-function as statusProvider → statusProvider must be a function
```

Read lines 4 and 5 together: the code renders the same input twice, and `cacheHits` rises from 0 to 1 (a hit). It then changes only `status` and renders again, and `cacheHits` **stays at** 1 (it did not rise, which shows this render missed and rendered again). Line 7 confirms that after the re-render, the body before it did not move by one character.

### 6.4 Why it cannot be a source of authorisation

This is the most important point in this section, and the one that real projects get wrong most easily.

`runtime_status` tells the model "the `fake` server is currently connected". The model naturally reasons: since it is connected, I can call its tools.

The output of Experiment 4 in Section 1 denies this reasoning directly:

```text
[7] runtime_status of the 2nd request: {"mcp_connections":["fake"],"pending_work":false}
[8] probe-mcp → Error [unknown_tool]: Unknown tool: mcp__fake__lookup
```

Line 7 says connected. Line 8 says it does not know this tool. Is that a contradiction? No — they answer two different questions:

```text
runtime_status answers: "At this moment, which connections exist in the live registry"
The tool snapshot answers:  "Which tools can this reply of yours call"

The two can disagree. They necessarily disagree on the turn when a connection was just established.
Authorisation looks only at the second one.
```

Generalise this into one transferable design principle: **any state information that you send to the model is "observation", not "permission".** What the model sees and what the model is allowed to do are two independent channels. The first one can be loose (tell it more, to help it judge the next step). The second one must be strict (only the permission system and the tool snapshot decide it).

---

## 7. The 25-Tool Surface: What the Lead Has, What a Sub-Executor Has

### 7.1 The Lead's complete tool surface

Experiment 10 prints it line by line:

```text
[1] The Lead tool surface has 25 tools in total:
       1. shell              8. load_skill          15. cancel_background_job  22. request_shutdown
       2. read_file          9. create_task         16. create_worktree        23. review_plan
       3. write_file        10. get_task            17. keep_worktree          24. connect_mcp
       4. edit_file         11. list_tasks          18. remove_worktree        25. disconnect_mcp
       5. glob              12. claim_task          19. schedule_cron
       6. todo_write        13. complete_task       20. spawn_teammate
       7. task              14. query_background_job 21. send_message
[2] The Lead has request_shutdown / review_plan: true
[3] The Lead has submit_plan: false
[4] The Lead has connect_mcp / disconnect_mcp: true
```

Grouped by chapter, you can see how these 25 were accumulated:

| Source chapter | Tools | Count |
| --- | --- | --- |
| P1 PowerShell | `shell` | 1 |
| P2 Files | `read_file` `write_file` `edit_file` `glob` | 4 |
| P5 TODO | `todo_write` | 1 |
| P6 Subagent | `task` | 1 |
| P7 Skill | `load_skill` | 1 |
| P17 SQLite tasks (with leases) | `create_task` `get_task` `list_tasks` `claim_task` `complete_task` | 5 |
| P13 Background tasks | `query_background_job` `cancel_background_job` | 2 |
| P18 Worktree | `create_worktree` `keep_worktree` `remove_worktree` | 3 |
| P14 Cron | `schedule_cron` | 1 |
| P15 Teammates | `spawn_teammate` `send_message` | 2 |
| P16 Protocol (Lead side) | `request_shutdown` `review_plan` | 2 |
| P19 MCP management | `connect_mcp` `disconnect_mcp` | 2 |
| | **Total** | **25** |

Line 3, "the Lead does not have `submit_plan`", is deliberate. The tools that the protocol runtime exposes split into two groups (`bootstrap.ts` lines 205 to 210):

```typescript
if (dependencies.protocolRuntime !== undefined) {
  // Lead receives request_shutdown/review_plan; submit_plan registers only to teammate factory.
  const [requestShutdownTool, reviewPlanTool] =
    dependencies.protocolRuntime.leadToolDefinitions;
  tools.register(requestShutdownTool);
  tools.register(reviewPlanTool);
```

The Lead is the approving party (`review_plan`) and the termination requesting party (`request_shutdown`). A teammate is the submitting party (`submit_plan`). The roles differ, so the tools differ — giving the Lead `submit_plan` would allow it to approve its own plans.

### 7.2 What a teammate is trimmed down to

A teammate's tool set is **listed explicitly**. It is not "the Lead's set minus a few" (lines 218 to 232):

```typescript
teammateRuntime.configureRunnerFactory((name, role, sendDefinition) => {
  // Persistent Teammates receive restricted file/message tools and protocol/task tools only, without exposing create_task.
  const teammateTools = standardTools.tools.subset(["shell", "read_file", "write_file"]);
  teammateTools.register(sendDefinition);
  if (dependencies.protocolRuntime !== undefined) {
    teammateTools.register(dependencies.protocolRuntime.submitPlanToolDefinition);
  }
  if (dependencies.workStealingRuntime !== undefined) {
    // Teammate task tools use a worker-specific registration entry point, staying separated from the Lead create_task boundary.
    registerTeammateLeasedTaskTools(
      teammateTools,
      dependencies.workStealingRuntime.store,
      dependencies.workStealingRuntime.claimService,
    );
  }
```

The last two lines of Experiment 10 verify the result:

```text
[5] Built-in tools a teammate is trimmed down to: [shell, read_file, write_file], plus send_message / submit_plan and the leased task tools
[6] Can a teammate see connect_mcp: false
```

`subset(["shell", "read_file", "write_file"])` is whitelist style. This choice is critical — if you write it as a blacklist that "excludes `connect_mcp` and so on", then every Lead tool added later leaks to teammates automatically. The whitelist default is "do not give". Adding a tool requires an explicit addition.

The implementation of `subset()` also spell-checks as a side effect:

```typescript
subset(names: readonly string[]): ToolRegistry {
  // subset exposes only explicitly declared tools; teammate runtimes use it to restrict model callable capabilities.
  const definitions = new Map<string, StoredToolDefinition>();
  for (const name of names) {
    const definition = this.#definitions.get(name);
    if (definition === undefined) throw new Error(`tool does not exist: ${name}`);
    definitions.set(name, definition);
  }
  return new ToolRegistry(definitions, true, this.#version);
}
```

A wrongly written name throws `tool does not exist: xxx`. It does not silently give one tool less.

### 7.3 Why a teammate cannot touch MCP

Against the `false` on line 6, there are three reasons:

```text
[1] An MCP connection is a process-level resource
      Connecting to a stdio server starts a child process, and the AgentRunner's resource lifecycle manages it.
      A teammate is a lower-level Runner under the Lead. Who is responsible for closing a server that it connects to?

[2] The allowlist is a local trust decision
      "Which servers may be connected" is a trust configuration at the Lead layer.
      Letting a teammate connect too delegates this decision to an executor with lower privilege.

[3] The tool surface must be predictable
      A teammate's tool set is a whitelist fixed at startup.
      If a teammate could connect, its tool surface would grow new tools by itself during the run —
      which conflicts directly with "a sub-executor's capability must be restricted and enumerable".
```

Add one more point: a teammate's permission policy has one more rule than the Lead's (lines 119 to 122):

```typescript
const teammatePermissionPolicy =
  dependencies.protocolRuntime === undefined || basePermissionPolicy === undefined
    ? basePermissionPolicy
    : basePermissionPolicy.withRules([dependencies.protocolRuntime.planGateRule]);
```

`withRules` **appends** on top of the base policy. It does not replace it. So a teammate carries all of the Lead's rules plus the plan gate — before its plan is approved, its side-effect tools are blocked.


---

## 8. Three State Lines: None Can Replace Another

By P20, the Agent holds three persistent states at the same time. People often mistake them for "three views of the same thing". They are actually three independent lines.

```text
State line 1: SQLite tasks                    State line 2: Protocol state machine
  ┌─────────────────────────┐            ┌──────────────────────────┐
  │ Task id / title / dependencies    │            │ Plan: draft → submitted   │
  │ status (DAG progress)      │            │        → approved/rejected│
  │ owner (who claimed it)        │            │ Shutdown: requested → agreed  │
  │ claim token (the claim credential)  │            │                          │
  │ lease (the lease expiry time)    │            │ Storage: JsonProtocolStore   │
  │ Storage: SqliteTaskStore   │            └──────────────────────────┘
  └─────────────────────────┘
                    State line 3: Worktree Binding
                      ┌──────────────────────────────┐
                      │ Task id ↔ Git worktree directory   │
                      │ Branch name / keep or delete          │
                      │ Storage: WorktreeRuntime        │
                      └──────────────────────────────┘
```

Why can they not be merged? One concrete scenario each:

| Scenario | With only task state | With only protocol state | With only worktree state |
| --- | --- | --- | --- |
| A teammate submits a plan and waits for approval | The task is still `claimed`. You cannot see that it waits for a person | You know it waits for approval, but not which task it waits for | The directory is created, but nobody knows whether work should start |
| A task is complete but its directory must stay for review | The task is `completed`, and the directory information is lost | The protocol has no such concept | The directory exists, but you do not know whether its task is complete |
| The Lead requests shutdown, and a teammate still has work | You see a `claimed` task, but not that someone wants to shut down | You know shutdown is under negotiation, but not how many tasks remain | You only know how many directories are still open |

Each of the three lines answers a different question: **how far has the task progressed** (SQLite), **what are the participants negotiating** (protocol), **in which directory do the code changes live** (worktree). Merging any two lines loses the answer to the third question.

This is also the reason the fourth identity check in Section 3.4 exists: task state and Worktree Binding are two lines, but the same chain must write them. Otherwise you get "claimed but no directory" or "a directory but no claim record".

---

## 9. Background, Cron, Teammates: Three Sources, One Inbox

### 9.1 Why it must be one inbox

Three kinds of asynchronous signal:

```text
A background task finished running          (P13 JobSupervisor)
Cron fired on schedule         (P14 CronRuntime)
A teammate sent a message         (P15 TeammateRuntime)
```

Their common point: **all three happen outside a model turn, and all three must enter the model context at some moment**.

If each one had its own channel, the Runner would have to ask three parties "anything new?" before every request. It would also have to rank priority itself, deduplicate itself, and handle "all three have something at once" itself. Order is even more trouble — in what order do events from three channels enter the history? Would two runs produce different orders?

One `EventInbox` solves these problems at once: events are already ordered at the entrance, and the Runner needs only one consumption point.

`bootstrap.ts` selects the event pump in a direct way (lines 290 to 292):

```typescript
const eventPump =
  dependencies.teammateRuntime ?? dependencies.cronRuntime ?? dependencies.backgroundSupervisor;
// Event pump prioritizes teammate > cron > background to ensure only one consumer per turn.
```

The `??` chain means "take the first one that exists". Because all three share the same `EventInbox` (the identity checks in Section 3.4 guarantee this), reading from any object reads the same queue. "Ensure only one consumer per turn" is the whole purpose of this line of code — two consumers would race each other for events.

### 9.2 The complete flow of consuming one event

The code is at `loop.ts` lines 693 to 751. Take it apart paragraph by paragraph:

**Step one: the deferred queue has priority (L704 to 707):**

```typescript
let events =
  this.#deferredRuntimeEvents.length > 0
    ? Object.freeze([this.#deferredRuntimeEvents.shift() as RuntimeEvent])
    : this.#eventPump.drainEvents(1);
```

An event that the previous turn postponed stands in front of a new event. It cannot starve forever.

**Step two: should it be collected now (L716 to 725):**

```typescript
if (event.contextIdentity !== undefined && !allowContextEvents) {
  this.#deferredRuntimeEvents.push(event);
  events = this.#eventPump.drainEvents(1);
  continue;
}
if (event.toPayload().kind === "mailbox" && !allowContextEvents) {
  this.#deferredRuntimeEvents.push(event);
  events = this.#eventPump.drainEvents(1);
  continue;
}
```

Two kinds of event are postponed inside a user turn: events with a `contextIdentity` (context events that belong to another identity) and `mailbox` events (teammate messages). The reason is the comment at L367:

```typescript
// In a user turn, receive only regular background events; delay Cron and mailbox context events to avoid interrupting the active user session.
```

The user is in a conversation. A teammate message that suddenly inserts itself into the history interrupts the current reasoning chain. These events are left for `runEvents()` — it is the dedicated entry point for Cron and mailbox wakeups, and it passes `allowContextEvents` as `true` when it calls (L318).

**Step three: deduplication (L726 to 732):**

```typescript
const isNewEvent = !this.#seenEventIds.has(event.eventId);
const retryingAcknowledgement = this.#pendingEventAcks.has(event.eventId);
if (!isNewEvent && !retryingAcknowledgement) {
  // Write history only for first-seen normal events; duplicate events only receive acks to avoid re-injecting background terminal states.
  events = this.#eventPump.drainEvents(1);
  continue;
}
```

`#seenEventIds` remembers the IDs it has seen. A duplicate event is skipped at once and is not written into the history. This is where "at-least-once delivery" becomes "exactly once for the model".

**Step four: write the history first, then ack (L733 to 738):**

```typescript
if (isNewEvent) {
  this.#history.push(runtimeEventMessage(event));
  this.#seenEventIds.add(event.eventId);
}
try {
  await this.#eventPump.acknowledgeEvents(events);
```

The order is "enter the history first, ack afterwards". The reverse loses events: if the ack succeeds and then the process crashes, the event is already deleted from the queue but never entered the history, and the model never knows.

**Step five: roll back when the ack fails (L739 to 746):**

```typescript
} catch (error) {
  if (event.toPayload().kind !== "mailbox" && isNewEvent) {
    this.#history.pop();
    this.#seenEventIds.delete(event.eventId);
  }
  if (event.toPayload().kind === "mailbox") this.#pendingEventAcks.add(event.eventId);
  throw error;
}
```

An ordinary event rolls back (pop the message just pushed, delete the ID from seen), and the next pass consumes it again. A mailbox event does not roll back. Instead, the code records it in `#pendingEventAcks` and waits to complete the ack — because a teammate message has already entered the history and the model has seen it. Withdrawing it would make the context contradict itself. Completing only the ack is safer.

### 9.3 What an event looks like

`runtimeEventMessage(event)` wraps an event into an **ordinary user message** whose content is `{"runtime_event": ...}`.

It is not a fake tool result. This point matters: an event has no pairing relation with any tool call. If you disguise it as a tool result and insert it into the history, `validateToolPairing` reports `orphan tool result id` at once. An event is "something that happened in the outside world", and the user role expresses that most naturally.

Experiment 8 verifies the whole chain:

```text
[1] 1st runEvents() → received 1 user message
[2] 2nd runEvents() (the same eventId delivered once more) → undefined
[3] Number of runtime_event entries in the canonical history: 1
[4] Ack records: [evt-1]
```

The code delivers the same `eventId` twice. The second call returns `undefined` (there is no new event to consume), and the history always holds only 1 entry.

---

## 10. The Recovery Matrix: Failures Are Digested Inside the Model Boundary

### 10.1 Four failures, four handlings

`RecoveryManager` recognises only four kinds of model boundary error. It rethrows everything else unchanged (`features/recovery.ts` lines 324 to 366):

| Failure | Basis for the judgement | Handling action | Side effect |
| --- | --- | --- | --- |
| 429 rate limit | `ModelRateLimitError` | Sleep per `Retry-After` or the backoff algorithm, then retry | `consecutive529` resets to zero |
| 529 overload | `ModelOverloadedError` | Count +1; at the threshold, switch to the fallback model; back off and retry | After the threshold, `consecutive529` resets to zero |
| Output truncation | `finishReason === "length"` | First time: raise the output budget and retry; second time: continue writing and join | The incomplete reply is discarded completely |
| Input too long | `ModelPromptTooLongError` | Keep the first system message, compact the request snapshot once, then retry | `hasAttemptedReactiveCompact = true` |
| Other | —— | `throw error`, rethrown unchanged | None |

The difference between 429 and 529 deserves attention (lines 326 to 342):

```typescript
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
```

A 429 says "you are requesting too fast". Wait a while and it passes. Switching models is useless — so it clears `consecutive529` to zero and does not push the fallback. A 529 says "this model cannot carry the load right now". Only after several in a row does switching models make sense. Both back off and retry, but only 529 accumulates.

Also, 529 goes through `#retryTransient(..., undefined, ...)` — the second argument is `retryAfter`, and passing `undefined` means a 529 does not read the retry interval that the server gives. It uses only the local backoff algorithm.

The two levels of output truncation handling (lines 345 to 373):

```typescript
if (!state.hasEscalated) {
  // On first length finish, escalate output budget, discard incomplete reply completely, and retry the same request.
  state.currentMaxTokens = this.#config.escalatedMaxTokens;
  state.hasEscalated = true;
  continue;
}
```

"Discard the incomplete reply completely" is level one. Level two is continuation writing: the code appends the fragment and a continuation prompt to the local `requestMessages`, and `mergeFragments` merges them at the end. Continuation writing has two limits: a fragment must be plain text (if it has a tool call, the code throws `RecoveryRetriesExhausted`), and the number of continuations is bound by `maxContinuations`.

### 10.2 One complete recovery, measured

Experiment 9 makes the model substitute throw six kinds of failure in a row, and then watches how the Runner digests them:

```text
[1] The real failure sequence on the model side: [429, 529, 529, 529, length, prompt-too-long]
[2] Main request count: 7
[3] Model used by each request: [primary, primary, primary, primary, fallback, fallback, fallback]
[4] maxTokens of each request: [8000, 8000, 8000, 8000, 8000, 64000, 64000]
[5] Final answer: recovered
[6] Canonical history length: 2
[7] History content: user:Verify the recovery boundary | assistant:recovered
[8] Does the history hold the discarded reply with finish_reason=length: false
```

Read against the matrix, and you can verify every cell of the recovery matrix:

```text
Request 1  primary  8000   → 429              Back off and retry, consecutive529 = 0
Request 2  primary  8000   → 529              consecutive529 = 1, threshold 3 not reached
Request 3  primary  8000   → 529              consecutive529 = 2, threshold not reached
Request 4  primary  8000   → 529              consecutive529 = 3, threshold reached → switch to fallback
Request 5  fallback 8000   → length           First length → budget raised from 8000 to 64000
Request 6  fallback 64000  → prompt-too-long  One reactive compaction
Request 7  fallback 64000  → Normal reply "recovered"
```

The model sequence on line 3 confirms the comment "only the next request explicitly carries the new model": request 4 **still** uses primary (it is the request that triggered the threshold), and the switch takes effect at request 5. The same holds for maxTokens on line 4: request 5 is still 8000 (it is the request that triggered length), and the raise takes effect at request 6.

### 10.3 Not one recovery step enters the canonical history

Lines 6, 7, and 8 are the most important conclusion of this section: **7 model requests, 6 failures, and the canonical history holds only 2 messages.**

```text
History content: user:Verify the recovery boundary | assistant:recovered
```

One user input, one final answer. The backoff in between, the model switch, the budget raise, the discarded truncated reply, and the compacted request snapshot — none of them is in there.

The implementation relies on "local variables". Look at the start of `complete()` (lines 279 to 283):

```typescript
let requestMessages = Object.freeze([...request.messages]);
const fragments: string[] = [];
let promptTooLongRetries = 0;
let transientFailures = 0;
state.hasAttemptedReactiveCompact = false;
```

`requestMessages` is a **copy** of `request.messages`. Every later retry changes this local variable:

```typescript
requestMessages = Object.freeze([...leadingSystem, ...outcome.history]);   // Compaction
requestMessages = Object.freeze([...requestMessages, reply.message, userMessage(CONTINUATION_PROMPT)]);  // Continuation writing
```

`this.#history` on the `AgentRunner` side knows nothing about any of this. It calls `modelRequestExecutor.complete(request)`, receives one successful `ModelReply`, pushes one assistant message, and ends.

Why must it be this way? Three reasons:

```text
[1] The input to compaction must be clean
      If the intermediate states of six failures were all in the history, the next compaction would have to summarise "we retried six times" —
      which carries no information about the task itself. It is pure noise.

[2] Recovery is an implementation detail, not conversation content
      The model does not need to know that it was just rate-limited. Knowing may change its behavior
      (for example, "since the last one was too long, I will say less").

[3] Replay must be deterministic
      The history can be persisted and replayed. If it contained retry traces, then the same session
      would produce different histories under different network conditions, and the replay result would not be deterministic.
```

In passing, the role of `beginTurn()` (`loop.ts` L351):

```typescript
this.#modelRequestExecutor?.beginTurn();
```

It resets the recovery state at the start of every turn (the comment at line 250: "State resets at the turn boundary to prevent fallbacks, length escalations, or retry counts from leaking into the next request"). The previous turn switched to the fallback model and raised the output budget. That must not affect the next turn's starting point.

---

## 11. The MCP Boundary, and One Real Behavior Regression

### 11.1 The MCP boundary that P20 inherits

P20 changed none of the four boundaries that Chapter 19 established:

```text
[1] Who can be connected —— The local allowlist
      connect_mcp accepts only an alias string. It does not accept command/args.
      The CLI hardcodes two: demo_alpha, demo_beta.

[2] What counts as which permission —— The local policy
      Nothing written in a remote description affects effect.
      The CLI hardcodes four: lookup/fail/delay are read, terminate is external.

[3] What name it is called by —— Local normalisation
      mcp__{alias}__{tool}. Two servers both publishing lookup do not collide.

[4] Which arguments are accepted —— Ajv validates the remote schema
      The schema is deep-cloned and frozen, and it is compiled into a synchronous predicate before publishing.
```

The policy declaration in `cli.ts` is the physical form of the second boundary (lines 311 to 317):

```typescript
// Local demos allow an allowlist declaring four remote tools and their effects; production should supply this by configuration.
const policies = Object.freeze([
  new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
  new McpToolPolicy({ remoteName: "fail", effect: "read" }),
  new McpToolPolicy({ remoteName: "delay", effect: "read" }),
  new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
]);
```

`terminate` is marked `external`. The other three are `read`. Note the comment "production should supply this by configuration" — the demo hardcodes them for teaching. A real project should read them from a configuration file.

The management tools themselves also carry `effect` and `source` (`features/mcp-tools.ts` lines 296 to 325):

```typescript
this.#leadToolDefinitions = Object.freeze([
  { name: "connect_mcp", description: "Connect one locally allowlisted MCP server alias.",
    inputSchema: aliasInputSchema, effect: "external", source: "mcp:management", handler: connect },
  { name: "disconnect_mcp", description: "Disconnect one MCP server alias and withdraw its tools.",
    inputSchema: aliasInputSchema, effect: "external", source: "mcp:management", handler: disconnect },
]);
```

Both are `effect: "external"` and `source: "mcp:management"`. Remember these two fields. The next section uses them.

### 11.2 P19 has one approval rule. P20 does not

This is the only place in this chapter where you must confirm something with your own hands, because it is a **real behavior regression**, not a design intention.

Open the two files and compare `permissionPolicyForProfile()`:

`code/chapters/ch19/src/bootstrap.ts` builds a mutable array, and then appends a second rule per capability:

```typescript
const rules: PermissionRule[] = [
  new PermissionRule({
    name: "confirm-file-write",
    behavior: "ask",
    reason: "File writes require explicit approval from chapter 3 onward",
    matches: (request) => {
      const name = request.prepared.definition?.name;
      return name === "write_file" || name === "edit_file";
    },
  }),
];
if (profile.capabilities.has("mcp")) {
  // MCP management tools and remote external tools require terminal approval; rules read only source and effect.
  rules.push(
    new PermissionRule({
      name: "mcp-external-approval",
      behavior: "ask",
      reason: "MCP external tools require terminal approval",
      matches: (request) => {
        const definition = request.prepared.definition;
        return definition?.source.startsWith("mcp:") === true && definition.effect === "external";
      },
    }),
  );
}
```

`code/chapters/ch20/src/bootstrap.ts` has only one rule. `rules` is written directly as an inline literal:

```typescript
return new PermissionPolicy({
  rules: [
    new PermissionRule({
      name: "confirm-file-write",
      behavior: "ask",
      reason: "File writes require explicit approval from chapter 3 onward",
      matches: (request) => {
        const name = request.prepared.definition?.name;
        return name === "write_file" || name === "edit_file";
      },
    }),
  ],
  approval: dependencies.approvalProvider,
  audit: dependencies.auditSink,
  writeBoundary: fileSystem,
});
```

The whole `mcp-external-approval` rule is gone.

### 11.3 Three independent pieces of evidence

One difference could be my misreading. Three mutually independent pieces of evidence settle the character of the thing.

**Evidence one: the code difference** (listed above). There is no rule in ch20's `permissionPolicyForProfile` that reads `source.startsWith("mcp:")`.

**Evidence two: tests were deleted.** ch20 inherited ch19's bootstrap test file (`tests/ch19-bootstrap.test.ts`), but it has three fewer tests:

```text
ch19/tests/ch19-bootstrap.test.ts  469 lines, 6 MCP-related tests
ch20/tests/ch19-bootstrap.test.ts  286 lines, 3 MCP-related tests

The three that ch20 does not have:
  - "asks before connecting MCP and keeps the transport closed when denied"
  - "asks before invoking an MCP external tool and keeps the remote handler zero-call when denied"
  - "asks before disconnecting MCP and keeps the connection open when denied"

Helper classes deleted along with them: ExternalToolModel, DisconnectToolModel, SelectableApproval,
and the two call counters Connection.callCalls / Factory.openCalls.
```

The three deleted tests test exactly the deleted rule.

**Evidence three: runtime behavior.** The output of Experiment 4 in Section 1:

```text
[8] probe-connect → {"server_alias":"fake","status":"connected","tools":["mcp__fake__lookup"]}
[10] Tools the approval provider was asked about: [] (deny is stronger than ask, so an out-of-bounds write never reaches approval)
```

`connect_mcp` executed successfully, and the approval provider was never asked, not even once. In P19, this call would first raise a terminal approval.

### 11.4 Impact range and conclusion

First, state clearly what was **not** affected:

| Boundary that still holds | Why it is not affected |
| --- | --- |
| The allowlist | Fixed at `McpRuntime` construction time, unrelated to permission rules |
| The local policy decides effect | Implemented in `mcp-tools.ts`, unrelated to permission rules |
| Name isolation and schema validation | Same as above |
| Lead-only | `install()` is called only on the Lead registry, unrelated to permission rules |
| The workspace write boundary | `#workspaceBoundaryDecision` is hardcoded, not a rule |
| The shell default approval | `shellDefaultDecision` is hardcoded, not a rule |

Only one thing is affected: **MCP tools with `effect: "external"` no longer trigger terminal approval.** Concretely, these are `connect_mcp`, `disconnect_mcp`, and remote tools that the policy marks `external` (the `terminate` tool in the demo).

Judged by this chapter's three invariants, this is a defect: `cli.ts` still declares `terminate` as `external`, which shows that the intention "this operation has side effects and needs a person's confirmation" is still there. But P20's policy no longer has a rule that turns this intention into an approval. Declaration and execution have come apart.

The fix is direct — move ch19's `if (profile.capabilities.has("mcp"))` block back into ch20's `permissionPolicyForProfile` unchanged, and move the three deleted tests back with it. This chapter does not make that change, because this chapter's task is to explain P20's current state clearly. But when you read the code and see that `terminate` is `external` yet no approval appears, you have not misunderstood.

You can confirm it yourself with two commands. First run the deleted test in ch19. It passes there:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx vitest run chapters/ch19/tests/ch19-bootstrap.test.ts -t "asks before connecting MCP"
```

```text
 Test Files  1 passed (1)
      Tests  1 passed | 5 skipped (6)
```

Then search for this test in ch20's file of the same name. You will not find a single one:

```powershell
Select-String -Path 'chapters\ch20\tests\ch19-bootstrap.test.ts' -Pattern 'asks before'
```

There is no output. You can also count the number of `test(` calls in the two files directly: ch19 has 6 (469 lines), and ch20 has 3 (286 lines).

### 11.5 Remember this investigation method while you are here

The value of this section is not only this one concrete rule. It demonstrates a reusable investigation pattern:

```text
[1] Start from the "declaration"
      cli.ts says terminate is external → the intention is "approval is required"

[2] Find the "execution"
      Who turns external into an approval? → Search the permission rules → not found

[3] Find the "history"
      Did the previous chapter have it? → diff bootstrap.ts → ch19 has it, ch20 does not

[4] Find the "tests"
      Did this behavior have a test before? → diff the test files → three tests were deleted

[5] Run it once
      Measure the approval count → 0 times → confirmed
```

"Declaration separated from execution" is the common shape of this class of defect. Whenever a system has a place where "intent is expressed as data" (here, the `effect` field), you must be able to point to the code that "turns intent into behavior". If you cannot point to it, the intent is a comment.

---

## 12. Resource Registration and Reverse-Order Close

### 12.1 Registration order

`bootstrap.ts` lines 302 to 308:

```typescript
// Event pump prioritizes teammate > cron > background to ensure only one consumer per turn.
// Full Harness delegates all asynchronous runtimes to AgentRunner for unified management, releasing in reverse registration order on shutdown.
const resources: readonly AsyncResource[] = Object.freeze([
  ...(dependencies.backgroundSupervisor === undefined ? [] : [dependencies.backgroundSupervisor]),
  ...(dependencies.cronRuntime === undefined ? [] : [dependencies.cronRuntime]),
  ...(dependencies.teammateRuntime === undefined ? [] : [dependencies.teammateRuntime]),
  ...(dependencies.mcpRuntime === undefined ? [] : [dependencies.mcpRuntime]),
]);
```

The order is `JobSupervisor → CronRuntime → TeammateRuntime → McpRuntime`. This order follows the dependency direction: later entries depend on earlier ones. Cron must submit tasks to the supervisor. Teammates must use the supervisor and Cron. MCP is the most independent, so it comes last.

### 12.2 Close goes in reverse

`loop.ts` lines 672 to 699: the whole `close()`:

```typescript
// Repeated closing is idempotent; concurrent calls are rejected during closing to prevent disorder in resource release.
async close(): Promise<void> {
  if (this.#closed) {
    return;
  }
  if (this.#closing) {
    throw new AgentRunError("AgentRunner close is already in progress");
  }
  this.#closing = true;
  const failures: unknown[] = [];
  try {
    for (const resource of [...this.#resources].reverse()) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    this.#closing = false;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "AgentRunner close failed");
  }
  this.#closed = true;
}
```

29 lines of code, five decisions:

**`[...this.#resources].reverse()` — reverse order, and copy first.**

`reverse()` modifies the array in place, so the code must copy it with `[...]` first. Otherwise `#resources` itself is changed. The reason for reverse order matches the registration order: MCP closes first (nothing depends on it), and the supervisor closes last (everyone may still be using it).

What happens in the other order? If you close the supervisor first, a teammate runtime that is still closing may still submit a cleanup task to it, and it receives a "supervisor is closed" error.

**Each resource's `close()` has its own try/catch — a failure does not interrupt the rest.**

If one resource cannot close, the rest must still close. This is a general principle of resource cleanup: you cannot leak everything behind it because the first one failed.

**One failure is thrown unchanged. Multiple failures use `AggregateError`.**

```typescript
if (failures.length === 1) {
  throw failures[0];
}
if (failures.length > 1) {
  throw new AggregateError(failures, "AgentRunner close failed");
}
```

A single failure keeps its original error type and stack, which makes it easy to locate. Multiple failures must be aggregated — throwing only the first one makes the person investigating think only one thing broke. They fix it, and the next one breaks.

**`#closed = true` is set only after everything succeeds.**

It is on the last line. Any `throw` before it skips it. This allows a retry: after a failed close, you can call `close()` again. The MCP runtime has a `pendingCloses` set that cooperates with exactly this: connections that were revoked from the registry but whose `connection.close()` has not yet succeeded stay in it, and they wait for the next `close()` to retry.

**`#closing` blocks concurrency.**

Call `close()` twice at the same time, and the second call throws `AgentRunner close is already in progress`. Its difference from `#closed` is: `#closed` means "closing is finished, another call is a no-op", and `#closing` means "closing is in progress, do not cut in line". Both states make `#ensureOpen()` reject a new turn (L754):

```typescript
#ensureOpen(): void {
  if (this.#closed || this.#closing) {
    throw new AgentRunError("AgentRunner is closed");
  }
}
```

### 12.3 Measured run

Experiment 7 uses a fake resource that records its close trace, and it verifies all of this behavior:

```text
[1] Registration order supervisor → cron → teammate → mcp, close order: mcp → teammate → cron → supervisor
[2] Call close() once more, and the close trace is still 4 entries: true
[3] Can you still run() after close → AgentRunner is closed
[4] Two resources fail to close → AggregateError: AgentRunner close failed
[5] Each entry in the aggregate: [teammate close failed | supervisor close failed]
[6] Even with failures, all resources were walked: mcp → teammate → cron → supervisor
```

Line 2 verifies idempotence: the second `close()` did not close everything again, and the trace is still 4 entries. Line 6 verifies "a failure does not interrupt": two resources failed to close (teammate and supervisor), but all 4 resources were attempted.

The order on line 5 deserves a look: `[teammate close failed | supervisor close failed]`. Teammate comes first because, in reverse-order closing, it is processed before the supervisor. The order inside `AggregateError` is the order in which the failures happened.

### 12.4 Who is responsible for calling close()

The CLI side calls it in the `finally` of `runProfile()` (in `cli.ts`). The entry file has only 5 lines, and it touches no cleanup logic:

```typescript
import { runProfile } from "../cli.js";
import { P20 } from "../core/profiles.js";

// Fixed entrypoint runs P20 Full Harness; CLI handles resource cleanup and error code returns upon exit.
process.exitCode = await runProfile(P20, process.argv.slice(2));
```

This is also the benefit of twenty chapters sharing one runtime: when any chapter fixes the close logic, every chapter that uses the capability benefits together. You do not change it in 20 entry files, one by one.

---

## Run Chapter 20 Yourself

The six steps below are the order in which I actually ran it. Each step gives the real output, so you can compare and confirm where you are.

### Step 1: Confirm the environment

```powershell
node --version
npm --version
```

On my machine:

```text
v25.7.0
11.19.0
```

`package.json` requires `"node": ">=20.12"`. If your version is lower, upgrade first. Do not rush ahead.

### Step 2: Install the dependencies

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm install
```

Chapter 20 **adds no new dependency**. This is itself side evidence that "P20 introduces no new runtime". The whole repository's dependencies are:

| Dependency | Version | Introduced by |
| --- | --- | --- |
| `openai` | `7.0.0` | P1 |
| `zod` | `4.4.3` | P2 |
| `yaml` | `2.9.0` | P7 |
| `dotenv` | `17.2.3` | P1 |
| `proper-lockfile` | `4.1.2` | P12 |
| `cron-parser` | `5.6.2` | P14 |
| `sql.js` | `1.14.1` | P17 |
| `@modelcontextprotocol/sdk` | `^1.30.0` | P19 |
| `ajv` | `^8.20.0` | P19 |

### Step 3: Run the tests and confirm the code is good

```powershell
npm run test:ch20
```

```text
 Test Files  65 passed (65)
      Tests  429 passed (429)
   Duration  18.11s
```

`npm test` runs the same command (`vitest run chapters/ch20/tests`), because P20 is the repository's default acceptance target.

These 65 files are not "Chapter 20's 65 tests". They are the **cumulative full test suite** — the `chapters/ch20/tests/` directory holds all the test files from ch01 to ch20 at the same time. Chapter 20 itself adds only two:

```powershell
npx vitest run chapters/ch20/tests/ch20-full-harness.test.ts chapters/ch20/tests/ch20-entry.test.ts
```

```text
 Test Files  2 passed (2)
      Tests  11 passed (11)
```

11 tests = the 7 cross-feature scenarios in `ch20-full-harness.test.ts` + the 4 profile tests in `ch20-entry.test.ts`.

**A few lines in the output look like errors. That is normal.** The tests print them when they deliberately trigger a failure path:

```text
Runtime Failure: workspace is not a Git repository root
Runtime Failure: workspace is not a Git repository root
Runtime Failure: workspace is not a Git repository root
Runtime Failure: CLI execution or cleanup failed
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

Judge only by the final `Test Files ... passed` and `Tests ... passed`.

### Step 4: Prepare a Git repository as the working directory

This step sticks most easily. P20 inherits P18's worktree capability, and a worktree requires **the run directory to be a Git repository root** (`cli.ts` lines 163 to 164):

```typescript
// Verify cwd is the Git repository root before creating any runtime state to avoid leaving task stores in the wrong directory.
if (worktreeRuntime !== undefined) await worktreeRuntime.validateRepository();
```

Running directly in `code/` fails, because `code/` is not the repository root:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch20 -- --prompt "test"
```

```text
Runtime Failure: workspace is not a Git repository root
```

So open a separate directory:

```powershell
New-Item -ItemType Directory -Path 'C:\tmp\ch20-demo' -Force
Set-Location 'C:\tmp\ch20-demo'
git init
```

Then put the configuration in it. `cli.ts` reads `.env` from under `process.cwd()` (lines 222 to 226):

```typescript
const envPath = resolve(workspace, ".env");
const requiresFallback = profile.capabilities.has("recovery");
const settings = existsSync(envPath)
  ? settingsFromEnvFile(envPath, requiresFallback)
  : settingsFromMapping({}, requiresFallback);
```

P20 has the `recovery` capability, so `OPENAI_FALLBACK_MODEL` is also required. Four keys:

```text
OPENAI_BASE_URL=...
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_FALLBACK_MODEL=...
```

A missing key lists everything that is missing:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

Note that `.env` holds a real secret key. Do not commit it into Git. `C:\tmp\ch20-demo` is a temporary directory. Delete it after the run.

### Step 5: Call the chapter entry from the new directory

`npm run ch20` sets the cwd to `code/`, so you cannot use it. Use `npm exec --prefix` to point at the dependencies, and keep the cwd in your repository:

```powershell
Set-Location 'C:\tmp\ch20-demo'
npm exec --prefix 'F:\笔记\Agent实操\code' -- tsx 'F:\笔记\Agent实操\code\chapters\ch20\src\chapters\ch20.ts' --prompt "First connect demo_alpha, then in the next step use lookup to query needle"
```

The phrase "in the next step" in the prompt is necessary. Section 5.1 covered the snapshot boundary: connect and then call within the same reply, and you certainly receive `unknown_tool`. State the two steps clearly, and the model connects first, waits for the result, and calls in the next turn.

The parameters accept only `--chapter` and `--prompt`. Anything else is an error (the comment at line 110):

```typescript
// Only accept --chapter/--prompt; fixed chapter entrypoints automatically supply chapter, failing immediately on other arguments.
```

A fixed entry point adds the chapter automatically, so you only need to give `--prompt`.

### Step 6: Confirm the child processes really were cleaned up

After the run, check whether any demo server is left over:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime
```

In the normal case, you should not see a demo process still running. This chain is `runProfile`'s finally → `runner.close()` → `resources` in reverse order → `mcpRuntime.close()` → each connection's `close()`. Experiment 7 verified it step by step.

`cli.ts` also has a fallback path that is worth a look (lines 197 to 207):

```typescript
} else {
  // When buildAgent fails, no unified resources exist; close them in creation order as a fallback.
  for (const resource of [mcpRuntime, teammateRuntime, cronRuntime, backgroundSupervisor]) {
    if (resource === undefined) continue;
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }
}
```

When `buildAgent` fails (for example, the seven dependency errors in Section 3.2), the Runner has not been built yet, and `resources` does not exist. The CLI then closes the runtimes that were already created, in reverse order, itself. Note that this array's order, `[mcpRuntime, teammateRuntime, cronRuntime, backgroundSupervisor]`, is the reverse of the registration order in Section 12.1, and it stays consistent with the `close()` logic.

---

## Common Error Troubleshooting Table

Ordered by when you will meet them.

### Startup stage: assembly errors

This whole group comes from `validateBuildDependencies()`. When the error appears, the process has just started, and nothing has been written.

| Error | Cause | What to do |
| --- | --- | --- |
| `profile must be a fixed chapter profile` | You passed a profile object you built yourself | Use `P20` or `profileForChapter(20)`. Do not assemble a capability set by hand |
| `chapter must be an integer from 1 to 20` | `profileForChapter()` received an out-of-bounds value or a fraction | Only 1 to 20 are valid chapters |
| `cronRuntime must share the background supervisor and event inbox` | Cron's supervisor / inbox is not the object you passed | Build one `JobSupervisor` once, and construct `CronRuntime` with it |
| `teammateRuntime must share the background supervisor, EventInbox, and CronRuntime` | At least one of the teammate's three dependencies is not the same object | The teammate runtime must be constructed with the same supervisor and the same CronRuntime |
| `protocolRuntime must share the teammate runtime and mailbox store` | The protocol runtime references another teammate runtime or another mailbox | Build `TeammateRuntime` first, then build `ProtocolRuntime` with it |
| `worktreeRuntime must be the WorkStealingRuntime claim service and share its store` | The worktree is not work stealing's claimService, or the two stores differ | Pass the `WorktreeRuntime` itself as `claimService` to `WorkStealingRuntime` |
| `mcpRuntime is required for chapter 19 or later` | The profile has the `mcp` capability but no runtime was passed | Add `mcpRuntime` |
| `mcpRuntime requires chapter 19 or later` | You passed `mcpRuntime` to P18 or below | Switch to P19/P20, or do not pass it |
| `recoveryConfig is required for chapter 11 or later` | From P11 on, a recovery configuration is required | Add `recoveryConfig` |
| `recovery capability requires compaction` | `recovery` exists but `compaction` does not | This is a capability combination error. Use a fixed profile and it will not appear |
| `approvalProvider is required for chapter 3 or later` | From P3 on, the permission policy must have an approval provider | Add `approvalProvider` |
| `auditSink is required for chapter 3 or later` | Same as above, the audit sink is also required | Add `auditSink` |
| `MCP runtime is already installed` | One `McpRuntime` was installed into two registries | One runtime can bind to only one registry |
| `tool does not exist: xxx` | A tool name in `subset()` is written wrong | Check the spelling against the 25 names in Section 7.1 |

### Startup stage: environment errors

| Error | Cause | What to do |
| --- | --- | --- |
| `Runtime Failure: workspace is not a Git repository root` | The cwd is not a Git repository root (the P18 worktree requirement) | Run in a directory where you ran `git init` |
| `Configuration Error: Missing required settings: ...` | The `.env` under the cwd is missing keys | Add the listed keys. P20 also needs `OPENAI_FALLBACK_MODEL` |
| `Both --chapter and --prompt are required` | You called `cli.ts` directly without arguments | Use the `chapters/ch20.ts` entry. It adds the chapter automatically |
| `--prompt must not be empty` | An empty string followed `--prompt` | Give a real prompt |

### Run stage: tools and permissions

| Error | Cause | What to do |
| --- | --- | --- |
| `Error [unknown_tool]: Unknown tool: mcp__xxx__yyy` | You called it in the same turn in which you connected (the snapshot boundary) | State the two steps clearly in the prompt, and let the model call in the next turn |
| `Error [permission_denied]: Writing outside the workspace is forbidden` | The write path is outside the workspace | This is a hard boundary. Approval cannot release it. Change to a path inside the workspace |
| `tool registry snapshot is immutable` | You registered a tool into a snapshot | A snapshot is read-only. To change something, change the live registry |
| `tool definition was not registered by this registry` | The object you passed at revocation is not the one registered at the time | Revocation uses object identity. Keep the original definition reference |
| `resolved tool workspace is outside the controlled workspace root` | A tool's resolved execution directory ran outside the controlled root | Check the worktree binding chain. This is assembly-error level |
| `Approval was not explicitly granted: ...` | The approval provider did not explicitly give allow/deny | In a non-interactive environment the default is denial. This is deliberate |
| `mcp_timeout` | It exceeded `toolTimeoutSeconds` | The connection is discarded. Reconnect. To change the timeout, change the spec |
| `mcp_connection_lost` | The child process died, or the transport broke | The connection is discarded. Reconnect |
| `mcp_remote_error` | The remote side itself reported `isError: true` | **The connection is still there.** Look at the remote server's problem. The local side cannot get the details (they are redacted) |

### Run stage: history and messages

| Error | Cause | What to do |
| --- | --- | --- |
| `missing tool results for ids: ["xxx"]` | A tool call has no result filled back, or another message was inserted in between | Every call must be followed closely by a result with the same id |
| `unexpected tool result id: xxx` | The filled-back id is not in the set waiting to be filled | Check whether the id is written wrong |
| `orphan tool result id: xxx` | A result has no matching call, or the same id was filled back twice | Check whether you filled a result back twice |
| `Tool execution did not produce a paired result` | The result processor returned a count that differs from the call count | The processor must be one-in, one-out |
| `Model stopped without final text or tool calls` | The model gave neither text nor a tool call | A model-side problem. Check whether the request is valid |
| `Model output reached the token limit` | `finishReason === "length"` and there is no recovery manager | From P11 on, install `RecoveryManager` and it handles this automatically |
| `Model response was blocked by the content filter` | The content filter blocked it | Change the prompt |
| `Agent exceeded maxTurns=N` | The turn count exceeded the limit | Raise `maxTurns`, or check whether you are stuck in a tool loop |

### Close stage

| Error | Cause | What to do |
| --- | --- | --- |
| `AgentRunner is closed` | You still want to `run()` after close, or during closing | You cannot reuse it after close. Build a new one |
| `AgentRunner close is already in progress` | You called `close()` twice concurrently | Call serially. Wait for the first await to finish |
| `AggregateError: AgentRunner close failed` | Two or more resources failed to close | Look at each entry in the `error.errors` array |
| `AggregateError: CLI execution or cleanup failed` | Both the run and the cleanup failed | Same as above, look at them one by one |
| `MCP connection validation failed and cleanup is pending: xxx` | Validation failed **and** a child process cannot close | Check for leftover node processes. This error code exists specifically to warn "something leaked" |

---

## 10 Hands-On Experiments

All the output quoted in the earlier sections comes from one script. This section walks you through building it and running it, one item at a time.

Three things first:

- **No API key is needed.** All models are substitute classes. They return preset replies directly, or throw preset errors.
- **No Git repository is needed.** Experiments that use a workspace build one in the system temporary directory, and they delete it automatically after the run.
- **No child process is started.** Chapter 19's experiments really `spawn` a demo server. Here, `FakeConnection` replaces it, because this chapter cares about "how does the tool surface change", not "how does stdio communicate".

### Preparation: build a probe script

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType File -Path scripts\probe-ch20.mts -Force
```

`scripts/` is not in the `include` of `tsconfig.json`, so this file does not affect `npm run typecheck`. Delete it after the run.

The script is pasted in six segments. Segment 1 is the imports. They all point to `chapters/ch20/` — this long list itself shows "how much a composition root must obtain":

```typescript
// scripts/probe-ch20.mts —— The Chapter 20 probe script (temporary, delete after the run)
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { JsonBackgroundJobStore } from "../chapters/ch20/src/adapters/background-json.js";
import { JsonCronStore } from "../chapters/ch20/src/adapters/cron-json.js";
import { SubprocessGitRunner } from "../chapters/ch20/src/adapters/git.js";
import { FileMailboxStore } from "../chapters/ch20/src/adapters/mailbox-json.js";
import { AjvMcpSchemaValidator } from "../chapters/ch20/src/adapters/mcp-schema.js";
import { JsonProtocolStore } from "../chapters/ch20/src/adapters/protocol-json.js";
import { SqliteTaskStore } from "../chapters/ch20/src/adapters/task-sqlite.js";
import { buildAgent } from "../chapters/ch20/src/bootstrap.js";
import type { BuildDependencies } from "../chapters/ch20/src/bootstrap.js";
import { EventInbox } from "../chapters/ch20/src/core/events.js";
import type { RuntimeEvent } from "../chapters/ch20/src/core/events.js";
import { HookRegistry } from "../chapters/ch20/src/core/hooks.js";
import { AgentRunner } from "../chapters/ch20/src/core/loop.js";
import type { AsyncResource } from "../chapters/ch20/src/core/loop.js";
```

Then comes the second half of the imports:

```typescript
import {
  assistantMessage,
  toolCall,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "../chapters/ch20/src/core/messages.js";
import type { ChatMessage } from "../chapters/ch20/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch20/src/core/model.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../chapters/ch20/src/core/model.js";
import { PermissionDecision } from "../chapters/ch20/src/core/permissions.js";
import type {
  ApprovalProvider,
  AuditSink,
  PermissionRequest,
} from "../chapters/ch20/src/core/permissions.js";
import { P19, P20, profileForChapter } from "../chapters/ch20/src/core/profiles.js";
import type { Capability, ChapterProfile } from "../chapters/ch20/src/core/profiles.js";
import { ToolRegistry, toolSuccess } from "../chapters/ch20/src/core/tools.js";
import type { ToolResult } from "../chapters/ch20/src/core/tools.js";
import { JobSupervisor } from "../chapters/ch20/src/features/background.js";
import { CronRuntime } from "../chapters/ch20/src/features/cron.js";
import {
  DynamicPromptProvider,
  DynamicPromptRenderer,
} from "../chapters/ch20/src/features/prompting.js";
import {
  McpCallResult,
  McpPublishedTool,
  McpRuntime,
  McpServerSpec,
  McpToolPolicy,
} from "../chapters/ch20/src/features/mcp-tools.js";
import type {
  McpConnection,
  McpConnectionFactory,
} from "../chapters/ch20/src/features/mcp-tools.js";
import { ProtocolRuntime } from "../chapters/ch20/src/features/protocol.js";
import { RecoveryConfig } from "../chapters/ch20/src/features/recovery.js";
import { TeammateRuntime } from "../chapters/ch20/src/features/teammates.js";
import { WorkStealingRuntime } from "../chapters/ch20/src/features/work-stealing.js";
import type { WorkStealingSleeper } from "../chapters/ch20/src/features/work-stealing.js";
import { WorktreeRuntime } from "../chapters/ch20/src/features/worktrees.js";
```

Segment 2 holds five small utilities. `section()` lets you run only one of the experiments. `reason()` is the one this chapter uses most — **it turns "which error was thrown" into a printable string**, because half of this chapter's conclusions are "it should explode here, and it should explode with this sentence":

```typescript
const EXPERIMENT = process.argv[2] ?? "all";

function section(name: string): boolean {
  const selected = EXPERIMENT === "all" || EXPERIMENT === name;
  if (selected) console.log(`\n===== ${name} =====`);
  return selected;
}

function step(index: number, text: string): void {
  console.log(`[${index}] ${text}`);
}

async function withTempDir<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "probe-ch20-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Capture only the error message; the sentence itself is what the experiments print.
async function reason(operation: () => unknown): Promise<string> {
  try {
    await operation();
    return "(no error)";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function statusLine(prompt: string): string {
  return /^## runtime_status\n(.+)$/mu.exec(prompt)?.[1] ?? "(no runtime_status)";
}
```

The regular expression in `statusLine()` deserves a second look: it captures the whole line under `## runtime_status`. It can be written this way precisely because of what Section 6.3 said: "this section is always last, and its format is fixed". If the section order could change, this regular expression would not hold.

Segment 3 holds four substitutes. `AllowApproval` is an approval provider that "always agrees", **but it records the names of the tools it was asked about** — Experiment 4 relies on this array to prove "the out-of-bounds write never reached approval at all":

```typescript
class AllowApproval implements ApprovalProvider {
  readonly asked: string[] = [];

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.asked.push(request.prepared.definition?.name ?? "(unknown)");
    return new PermissionDecision("allow", "probe approval", "probe");
  }
}

class NoopAudit implements AuditSink {
  readonly records: string[] = [];

  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.records.push(`${request.prepared.definition?.name ?? "?"} -> ${decision.behavior}`);
  }
}

class ImmediateSleeper implements WorkStealingSleeper {
  async sleep(_seconds: number, _wakeup: AbortSignal): Promise<void> {}
}

class ProbeClock {
  #value = new Date("2026-08-01T00:00:00.000Z");

  now(): Date {
    return new Date(this.#value);
  }
}
```

`ImmediateSleeper` and `ProbeClock` exist so that an experiment **does not really wait**: work stealing's polling sleep returns at once, and Cron's clock stops at a fixed moment. These two substitutes are seams that P17 and P14 left behind — injecting sleep and injecting the clock both serve testability, not function.

Segment 4 is the fake MCP connection. It declares only one `lookup` tool, and `callTool` adds +1 to a call counter — Experiment 4 uses this counter to prove "the call that raced ahead never went out on the network":

```typescript
// Fake MCP connection: starts no child process, declares only one lookup tool, so the dynamic tool boundary is easy to observe offline.
class FakeConnection implements McpConnection {
  closeCalls = 0;
  callCalls = 0;
  #resolveFailure: (() => void) | undefined;
  readonly #failure: Promise<void>;

  constructor() {
    this.#failure = new Promise<void>((resolve) => {
      this.#resolveFailure = resolve;
    });
  }

  async listTools(): Promise<readonly McpPublishedTool[]> {
    return [
      new McpPublishedTool({
        name: "lookup",
        description: "Look up local fixture data.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
    ];
  }

  async callTool(): Promise<McpCallResult> {
    this.callCalls += 1;
    return new McpCallResult({ content: [], structuredContent: {}, isError: false });
  }

  async waitForFailure(): Promise<void> {
    await this.#failure;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#resolveFailure?.();
    this.#resolveFailure = undefined;
  }
}
```

The Promise in `waitForFailure()` cooperates with P19's Watchdog: a real connection uses it to sense a child process's death. Here it is fulfilled at `close()` time, so the Watchdog does not hang when `McpRuntime` closes.

A factory and an `McpRuntime` constructor follow at once:

```typescript
class FakeFactory implements McpConnectionFactory {
  constructor(readonly connection: FakeConnection) {}

  async open(): Promise<McpConnection> {
    return this.connection;
  }
}

function createRuntime(connection: FakeConnection): McpRuntime {
  return new McpRuntime({
    servers: [
      new McpServerSpec({
        alias: "fake",
        command: "unused",
        args: [],
        toolPolicies: [new McpToolPolicy({ remoteName: "lookup", effect: "read" })],
        startupTimeoutSeconds: 1,
        toolTimeoutSeconds: 1,
      }),
    ],
    connectionFactory: new FakeFactory(connection),
    schemaValidator: new AjvMcpSchemaValidator(),
  });
}
```

Note `command: "unused"`: the factory has been replaced, so the command string is never executed. But **`toolPolicies` must be exact** — the local policy declares `lookup` as `read`, and it must match the remotely declared name exactly. Otherwise the connection is rejected (Chapter 19's rule; P20 changed not one character of it). The `effect: "read"` here also explains why `mcp__fake__lookup` in Experiment 4 needs no approval.

`schemaValidator` uses the **real** `AjvMcpSchemaValidator`, not a substitute. Remote schema validation is an execution boundary. Replace it, and the experiment means nothing.

Segment 5 is the most important segment in the chapter: `createHarness()`. It is the composition root from Section 3, condensed into one function. **One `EventInbox` runs through three runtimes, and one `SqliteTaskStore` runs through two runtimes** — these two sharing relations are exactly what Experiment 2 breaks, one by one:

```typescript
interface Harness {
  readonly dependencies: BuildDependencies;
  readonly supervisor: JobSupervisor;
  readonly cron: CronRuntime;
  readonly teammates: TeammateRuntime;
  readonly protocol: ProtocolRuntime;
  readonly worktrees: WorktreeRuntime;
  readonly workStealing: WorkStealingRuntime;
  readonly inbox: EventInbox;
  readonly approval: AllowApproval;
}

// Isomorphic to createDependencies in tests/ch20-full-harness.test.ts: one EventInbox runs through three runtimes.
function createHarness(root: string, model: ModelClient, mcpRuntime: McpRuntime): Harness {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root),
    inbox,
    supervisor,
    clock: new ProbeClock(),
  });
  const teammates = new TeammateRuntime({
    store: new FileMailboxStore(root),
    inbox,
    supervisor,
    cronRuntime: cron,
  });
  const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
  const taskStore = new SqliteTaskStore(root);
  const worktrees = new WorktreeRuntime({
    workspace: root,
    store: taskStore,
    gitRunner: new SubprocessGitRunner(),
  });
  const workStealing = new WorkStealingRuntime({
    store: taskStore,
    claimService: worktrees,
    sleeper: new ImmediateSleeper(),
    maxIdlePolls: 1,
  });
  const approval = new AllowApproval();
```

The second half of the function assembles them into a `BuildDependencies`:

```typescript
  return {
    dependencies: {
      model,
      workspace: root,
      hooks: new HookRegistry(),
      approvalProvider: approval,
      auditSink: new NoopAudit(),
      recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
      teammateRuntime: teammates,
      protocolRuntime: protocol,
      workStealingRuntime: workStealing,
      worktreeRuntime: worktrees,
      mcpRuntime,
    },
    supervisor,
    cron,
    teammates,
    protocol,
    worktrees,
    workStealing,
    inbox,
    approval,
  };
}
```

Read this code against the four relation groups in Section 3.4, and you find that the construction order **is not arranged at random**:

```text
inbox ──────────┐
                ├─→ supervisor ──┐
                │                ├─→ cron ──┐
                └────────────────┘          ├─→ teammates ──→ protocol
                                            │
taskStore ──→ worktrees ──(claimService)──→ workStealing
```

Every arrow means "the later one's constructor arguments must hold the earlier object". Who comes first and who comes later cannot be swapped, because a downstream component must take an upstream instance. **This diagram is the whole meaning of the composition root** — not a "configuration object", but an "object graph".

Segment 6 holds two probe models and two value helpers:

```typescript
function systemPromptOf(request: ModelRequest): string {
  const message = request.messages.find((candidate) => candidate.role === "system");
  return message === undefined ? "" : message.content;
}

function toolNamesOf(request: ModelRequest): readonly string[] {
  return request.tools.map((tool) => tool.function.name);
}

// Main turn model: the first reply connects with connect_mcp and calls the just-connected tool at the same time, to observe the snapshot boundary.
class HarnessProbeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #started = false;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return { message: assistantMessage("[]"), finishReason: "stop" };
    }
    if (!this.#started) {
      this.#started = true;
      return {
        message: assistantMessage(null, [
          toolCall("probe-connect", "connect_mcp", '{"alias":"fake"}'),
          toolCall("probe-mcp", "mcp__fake__lookup", '{"query":"needle"}'),
          toolCall(
            "probe-escape",
            "write_file",
            JSON.stringify({ path: "../outside.txt", content: "must not be written" }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("probe done"), finishReason: "stop" };
  }
}
```

This model has three deliberate design points. Each deserves a word:

**The first line `validateToolPairing(request.messages)`.** The model validates the legality of the history it receives itself. This is the "outside observer" version of the invariant in Section 5.2: if any request's message sequence does not pair up, the experiment explodes on the spot. It does not quietly run to the end and give you a good-looking result.

**`if (request.tools.length === 0)` returns `"[]"`.** A request with 0 tools is not the main turn. It is an auxiliary request, such as compaction or memory selection (they carry no tools). Return a legal empty JSON array, so the auxiliary flow does not fail to parse. Later, when the code counts "main requests", it also uses `tools.length > 0` to filter these out.

**Three tool calls written in the same reply.** The order is deliberate: first `connect_mcp` (it succeeds), immediately followed by `mcp__fake__lookup` (it hits the snapshot boundary), and finally a `write_file` that escapes (it hits the workspace boundary). One reply strikes three walls at the same time.

The second model exists specifically to trigger the recovery matrix. It throws six kinds of failure in a fixed order, and succeeds only at the end:

```typescript
// Recovery experiment model: throws 429 / 529×3 / length / prompt-too-long in order, then succeeds.
class RecoveryProbeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly failures: string[] = [];
  #attempts = 0;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return {
        message: assistantMessage(
          JSON.stringify({
            current_goal: "Verify the recovery matrix",
            key_findings: ["prompt-too-long triggered one compaction"],
            files_read_or_changed: [],
            remaining_work: [],
            user_constraints: [],
          }),
        ),
        finishReason: "stop",
      };
    }
    const attempt = this.#attempts;
    this.#attempts += 1;
    if (attempt === 0) {
      this.failures.push("429");
      throw new ModelRateLimitError("rate limited", { retryAfter: "0" });
    }
    if (attempt < 4) {
      this.failures.push("529");
      throw new ModelOverloadedError("overloaded");
    }
    if (attempt === 4) {
      this.failures.push("length");
      return { message: assistantMessage("discarded"), finishReason: "length" };
    }
    if (attempt === 5) {
      this.failures.push("prompt-too-long");
      throw new ModelPromptTooLongError("prompt too long");
    }
    return { message: assistantMessage("recovered"), finishReason: "stop" };
  }
}
```

The branch with `tools.length === 0` returns a **compaction summary structure** (the five fields `current_goal` / `key_findings` and so on). The reason is that `ModelPromptTooLongError` triggers one real compaction, and compaction itself calls the model. If you do not give it a legal structure, the compaction fails to parse, and you never see the final success.

`retryAfter: "0"` makes the 429 wait zero, so the experiment finishes in seconds. In a real scenario, this value comes from a response header.

The common header ends here. Below are ten segments. Paste only the ones you want to run.

### Experiment 1 (profile): Cumulative capabilities and fixed profile identity

```typescript
// ---------- Experiment 1 (profile): The cumulative capability model and fixed profile identity ----------
if (section("profile")) {
  const counts: string[] = [];
  for (let chapter = 1; chapter <= 20; chapter += 1) {
    counts.push(`P${String(chapter).padStart(2, "0")}=${profileForChapter(chapter).capabilities.size}`);
  }
  step(1, `Cumulative capability count per chapter: ${counts.join(" ")}`);
  const p19 = new Set<Capability>(P19.capabilities);
  const added = [...P20.capabilities].filter((capability) => !p19.has(capability));
  const removed = [...P19.capabilities].filter((capability) => !P20.capabilities.has(capability));
  step(2, `P20 adds over P19: [${added.join(", ")}], removes: [${removed.join(", ")}]`);
  step(3, `Does P20 still hold every P19 capability: ${String(removed.length === 0)}`);
  step(4, `profileForChapter(20) === P20: ${String(profileForChapter(20) === P20)}`);
  step(5, `profileForChapter(21) → ${await reason(() => profileForChapter(21))}`);
  step(6, `profileForChapter(19.5) → ${await reason(() => profileForChapter(19.5))}`);
  // A self-made lookalike object cannot pass the composition root's identity gate even if its capability set matches completely.
  const lookalike: ChapterProfile = { chapter: 20, capabilities: new Set(P20.capabilities) };
  const model: ModelClient = {
    async complete() {
      return { message: assistantMessage("unused"), finishReason: "stop" as const };
    },
  };
  step(
    7,
    `Pass a self-made {chapter:20, capabilities:...} to buildAgent → ${await reason(() =>
      buildAgent(lookalike, { model, workspace: process.cwd() }),
    )}`,
  );
}
```

Run:

```powershell
npx tsx scripts\probe-ch20.mts profile
```

```text
===== profile =====
[1] Cumulative capability count per chapter: P01=2 P02=4 P03=5 P04=6 P05=7 P06=8 P07=9 P08=11 P09=12 P10=13 P11=14 P12=15 P13=16 P14=17 P15=19 P16=21 P17=23 P18=24 P19=25 P20=26
[2] P20 adds over P19: [full_harness], removes: []
[3] Does P20 still hold every P19 capability: true
[4] profileForChapter(20) === P20: true
[5] profileForChapter(21) → chapter must be an integer from 1 to 20
[6] profileForChapter(19.5) → chapter must be an integer from 1 to 20
[7] Pass a self-made {chapter:20, capabilities:...} to buildAgent → profile must be a fixed chapter profile
```

The string of numbers on line 1 is the complete trajectory of twenty chapters. A few steps are higher than the others:

| Chapter crossing | Increment | What was added |
| --- | --- | --- |
| P07 → P08 | +2 | Compaction needs two capability bits to go up together (`compaction` and the matching history processing) |
| P14 → P15 | +2 | The teammate mechanism brings a mailbox and event injection at the same time |
| P15 → P16 | +2 | The protocol brings a plan state machine and a shutdown handshake |
| P16 → P17 | +2 | Work stealing brings leases and polling |
| P19 → P20 | +1 | Only the `full_harness` marker is added |

Lines 2 and 3 together are this chapter's foundation: **only additions, never removals**. This is not "we try to stay compatible". It is the necessary result of the implementation `PROFILE_DELTAS.slice(0, index + 1).flat()` — a slice only grows longer as you cut more of it.

Lines 5 and 6 look trivial, but they actually block real errors: the pattern `profileForChapter(chapter + 1)` is common inside loops. When it goes out of bounds, you want it to explode on the spot. You do not want it to return `undefined` and let a later `.capabilities` report a `TypeError`. The fraction line blocks inputs from things like `parseFloat`.

Line 7 is this experiment's key point. That `lookalike` object's **capability set is completely identical to P20's**, and its `chapter` is also 20. But `buildAgent` rejected it. The reason is in Section 2.3: `profileForChapter(profile.chapter) !== profile` uses a reference comparison. This gate looks strict. Its effect is to shrink "possible capability combinations" from 2²⁶ down to 20 kinds — and every kind has test coverage.

### Experiment 2 (wiring): Seven assembly gates

This experiment builds **two** complete dependency sets (`harness` and `other`). Then it swaps `other`'s parts into `harness` one by one, and watches whether the composition root accepts them.

```typescript
// ---------- Experiment 2 (wiring): The composition root validates shared dependencies by object identity ----------
if (section("wiring")) {
  await withTempDir(async (root) => {
    const model = new HarnessProbeModel();
    const connection = new FakeConnection();
    const mcpRuntime = createRuntime(connection);
    const harness = createHarness(root, model, mcpRuntime);
    const other = createHarness(root, model, createRuntime(new FakeConnection()));

    step(1, `Complete dependencies → ${await reason(() => buildAgent(P20, harness.dependencies))}`);
    step(
      2,
      `Swap in another cronRuntime (another supervisor/inbox) → ${await reason(() =>
        buildAgent(P20, { ...harness.dependencies, cronRuntime: other.cron }),
      )}`,
    );
```

```typescript
    step(
      3,
      `Swap in only another protocolRuntime → ${await reason(() =>
        buildAgent(P20, { ...harness.dependencies, protocolRuntime: other.protocol }),
      )}`,
    );
    step(
      4,
      `Swap in teammateRuntime + protocolRuntime (the two match each other) → ${await reason(() =>
        buildAgent(P20, {
          ...harness.dependencies,
          teammateRuntime: other.teammates,
          protocolRuntime: other.protocol,
        }),
      )}`,
    );
    step(
      5,
      `Swap in another worktreeRuntime (not the claimService) → ${await reason(() =>
        buildAgent(P20, { ...harness.dependencies, worktreeRuntime: other.worktrees }),
      )}`,
    );
    const { mcpRuntime: _dropped, ...withoutMcp } = harness.dependencies;
    step(6, `Delete mcpRuntime → ${await reason(() => buildAgent(P20, withoutMcp))}`);
    step(
      7,
      `Give P20's dependencies to P18 → ${await reason(() =>
        buildAgent(profileForChapter(18), harness.dependencies),
      )}`,
    );
  });
}
```

```powershell
npx tsx scripts\probe-ch20.mts wiring
```

```text
===== wiring =====
[1] Complete dependencies → (no error)
[2] Swap in another cronRuntime (another supervisor/inbox) → cronRuntime must share the background supervisor and event inbox
[3] Swap in only another protocolRuntime → protocolRuntime must share the teammate runtime and mailbox store
[4] Swap in teammateRuntime + protocolRuntime (the two match each other) → teammateRuntime must share the background supervisor, EventInbox, and CronRuntime
[5] Swap in another worktreeRuntime (not the claimService) → worktreeRuntime must be the WorkStealingRuntime claim service and share its store
[6] Delete mcpRuntime → mcpRuntime is required for chapter 19 or later
[7] Give P20's dependencies to P18 → mcpRuntime requires chapter 19 or later
```

Line 1 is the baseline: complete dependencies produce no error. With this line, the "explosions" in the next six lines mean something — otherwise you cannot tell whether the assembly is wrong or the environment is broken.

Line 4 deserves the most thought. It swapped in **two** runtimes, and the two match each other (`other.protocol` was built with `other.teammates`). Group 3's "Protocol ↔ Teammate" check therefore passed. But it still exploded, and it exploded on group 2: `other.teammates` uses `other`'s supervisor and cron, which are not the same objects as `harness`'s.

This shows that the four check groups are not "pass any one group and you are fine". **All of them must pass.** You cannot bypass the identity validation by "replacing a whole matching set", unless you replace the whole object graph (that is `other.dependencies`, which is self-consistent on its own).

Lines 6 and 7 are a pair of reverse gates, and they are easy to miss:

```text
P20 + no mcpRuntime  → explodes (something is missing)
P18 + has mcpRuntime  → explodes (something is extra)
```

With only the "missing" direction, you could pass a pile of P20 things to P18, and it would silently ignore them. That means **the profile no longer decides behavior** — you think you are running P18, while the composition root actually holds an MCP runtime. Only two-way checks make the equation "profile = behavior" hold.

In passing: the `claimService` check on line 5 is the least intuitive of the four groups. It requires the `worktreeRuntime` object **itself to be** `WorkStealingRuntime`'s `claimService`. Why can they not be two objects? Because a leased task's claim binds a worktree, and the claim token lives in `SqliteTaskStore`. If A claims tasks and B creates worktrees, then the token in the task table and the worktree binding point at two sets of state — Section 3.5 covered the cost of this class of error: it surfaces only when a task really starts running.

### Experiment 3 (status): The position of runtime_status, and the cache

```typescript
// ---------- Experiment 3 (status): runtime_status is fixed as the last section and takes part in the cache key ----------
if (section("status")) {
  const renderer = new DynamicPromptRenderer();
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "read a file",
    inputSchema: z.object({ path: z.string() }),
    effect: "read",
    handler: () => toolSuccess("ok"),
  });
  const base = {
    identity: "lead",
    tools: registry,
    workspace: process.cwd(),
    context: { chapter: 20 },
  } as const;
```

```typescript
  const withoutStatus = renderer.render(base);
  step(1, `Section order without status: ${withoutStatus.match(/^## .+$/gmu)?.join(" ") ?? "(none)"}`);
  const first = renderer.render({
    ...base,
    status: { mcp_connections: [], pending_work: false },
  });
  step(2, `Section order with status: ${first.match(/^## .+$/gmu)?.join(" ") ?? "(none)"}`);
  step(3, `Content of the last section: ${statusLine(first)}`);
  const hitsBefore = renderer.cacheHits;
  renderer.render({ ...base, status: { mcp_connections: [], pending_work: false } });
  step(4, `Render the same status once more, cacheHits ${hitsBefore} → ${renderer.cacheHits}`);
  const second = renderer.render({
    ...base,
    status: { mcp_connections: ["fake"], pending_work: true },
  });
  step(5, `After changing only the status, cacheHits is still ${renderer.cacheHits}, which shows the cache was judged invalid`);
  step(6, `The new last section: ${statusLine(second)}`);
  const before = first.slice(0, first.indexOf("## runtime_status"));
  const after = second.slice(0, second.indexOf("## runtime_status"));
  step(7, `Is the body before runtime_status completely unchanged: ${String(before === after)}`);
  step(
    8,
    `Pass a non-function as statusProvider → ${await reason(
      () =>
        new DynamicPromptProvider({
          renderer,
          ...base,
          statusProvider: {} as unknown as () => never,
        }),
    )}`,
  );
}
```

```powershell
npx tsx scripts\probe-ch20.mts status
```

```text
===== status =====
[1] Section order without status: ## identity ## tools ## workspace
[2] Section order with status: ## identity ## tools ## workspace ## runtime_status
[3] Content of the last section: {"mcp_connections":[],"pending_work":false}
[4] Render the same status once more, cacheHits 0 → 1
[5] After changing only the status, cacheHits is still 1, which shows the cache was judged invalid
[6] The new last section: {"mcp_connections":["fake"],"pending_work":true}
[7] Is the body before runtime_status completely unchanged: true
[8] Pass a non-function as statusProvider → statusProvider must be a function
```

Lines 1 and 2 are two faces of one thing: **do not pass `status`, and this section does not exist**. Pass it, and it is appended at the end. This explains why the prompts of P1 to P19 do not deform because P20 exists — they never pass this field at all.

Lines 4 and 5 are this experiment's technical core, but the output is easy to read backwards. So lay the three calls side by side:

```text
Call 1  status = {[], false}   → Miss, renders once, cacheHits: 0
Call 2  status = {[], false}   → Hit!             cacheHits: 0 → 1
Call 3  status = {["fake"], true} → Miss, renders again   cacheHits: 1 (unchanged)
```

`cacheHits` increments only on a **hit**. Call 2's hit shows the cache really works (the same input does not rebuild the string). Call 3 leaves the count unmoved, which shows it did **not** hit — `status` changed, so the cache key changed.

This is exactly the effect Section 6.3 wants: `status` is model-visible input, so it must take part in the cache key. If it did not take part, call 3 would hit the cache, and the model would see **the previous turn's connection list** — a stale lie that looks completely normal. This class of bug is extremely hard to find, because the prompt is legal and its format is correct. Only its content is out of date.

Line 7 is the matching other half: `status` changed, but **the body before it did not change by one byte**. Together, the two lines form the complete property — change is confined inside the last section. That is the shape that is friendly to prompt caching: the prefix is stable, and all change sits at the tail.

Line 8 is a construction-time type gate. `statusProvider` must be a function, not an object. This line is short. It defends against a common slip: `statusProvider: { mcp_connections: [] }` (passing a value directly). Passing a value means the state froze at construction time and never updates. An error is much better than silently returning stale state.

### Experiment 4 (harness): Four boundaries take effect at the same time in one turn

This is the most critical experiment in the chapter. The output at the start of Section 1 is this one.

```typescript
// ---------- Experiment 4 (harness): Four boundaries take effect at the same time in one real turn ----------
if (section("harness")) {
  await withTempDir(async (root) => {
    const model = new HarnessProbeModel();
    const connection = new FakeConnection();
    const mcpRuntime = createRuntime(connection);
    const harness = createHarness(root, model, mcpRuntime);
    const runner = buildAgent(P20, harness.dependencies);
    try {
      const result = await runner.run("Connect to fake, then query once");
      const main = model.requests.filter((request) => request.tools.length > 0);
      const firstRequest = main[0];
      const secondRequest = main[1];
      if (firstRequest === undefined || secondRequest === undefined) {
        throw new Error("probe expected two main requests");
      }
```

```typescript
      step(1, `Main model request count: ${main.length}`);
      step(2, `Tool count of the 1st request: ${toolNamesOf(firstRequest).length}`);
      step(
        3,
        `Does the 1st request contain mcp__fake__lookup: ${String(
          toolNamesOf(firstRequest).includes("mcp__fake__lookup"),
        )}`,
      );
      step(4, `Tool count of the 2nd request: ${toolNamesOf(secondRequest).length}`);
      step(
        5,
        `Does the 2nd request contain mcp__fake__lookup: ${String(
          toolNamesOf(secondRequest).includes("mcp__fake__lookup"),
        )}`,
      );
      step(6, `runtime_status of the 1st request: ${statusLine(systemPromptOf(firstRequest))}`);
      step(7, `runtime_status of the 2nd request: ${statusLine(systemPromptOf(secondRequest))}`);
      step(8, "The result of each of the three tool calls in the same reply:");
      for (const message of result.history) {
        if (message.role !== "tool") continue;
        console.log(`      ${message.toolCallId} → ${message.content.split("\n")[0] ?? ""}`);
      }
      step(9, `Actual call count of the remote callTool: ${connection.callCalls}`);
      step(10, `Tools the approval provider was asked about: [${harness.approval.asked.join(", ")}] (deny is stronger than ask, so an out-of-bounds write never reaches approval)`);
      step(11, `Final answer: ${result.finalText}`);
    } finally {
      await runner.close();
      step(12, `After close(), McpRuntime.isClosed=${String(mcpRuntime.isClosed)}`);
    }
  });
}
```

```powershell
npx tsx scripts\probe-ch20.mts harness
```

```text
===== harness =====
[1] Main model request count: 2
[2] Tool count of the 1st request: 25
[3] Does the 1st request contain mcp__fake__lookup: false
[4] Tool count of the 2nd request: 26
[5] Does the 2nd request contain mcp__fake__lookup: true
[6] runtime_status of the 1st request: {"mcp_connections":[],"pending_work":false}
[7] runtime_status of the 2nd request: {"mcp_connections":["fake"],"pending_work":false}
[8] The result of each of the three tool calls in the same reply:
      probe-connect → {"server_alias":"fake","status":"connected","tools":["mcp__fake__lookup"]}
      probe-mcp → Error [unknown_tool]: Unknown tool: mcp__fake__lookup
      probe-escape → Error [permission_denied]: Writing outside the workspace is forbidden
[9] Actual call count of the remote callTool: 0
[10] Tools the approval provider was asked about: [] (deny is stronger than ask, so an out-of-bounds write never reaches approval)
[11] Final answer: probe done
[12] After close(), McpRuntime.isClosed=true
```

The 12 lines of output map to four boundaries. Match them one by one:

**Boundary one: the tool snapshot (lines 2 to 5).** The 23 → 24 change happens only **between** the two requests. When the 1st request was sent, the snapshot was already fixed. `connect_mcp` successfully registered a tool during this turn, but it registered it into the **live registry**, which has nothing to do with this turn's snapshot. So line 3 is `false`, and line 5 is `true`.

**Boundary two: the workspace (the third item on line 8).** `../outside.txt` is stopped by `permission_denied`. Note that this is not "approval refused it". It **never entered approval** — the empty array on line 10 is the evidence. Section 5.4 covered the reason: `deny` is stronger than `ask`.

**Boundary three: pairing (line 8 as a whole).** Three `tool call`s, three results. One success, two failures, but **all three exist**. If the two failures were skipped, the next request would carry an incomplete history, and `validateToolPairing` would explode on the spot on the model side (remember the first line of `HarnessProbeModel`?).

**Boundary four: close (line 12).** `close()` travels all the way to `McpRuntime`, and `isClosed` becomes `true`.

Line 9 separately. The remote `callTool` was called **0 times**, even though the model explicitly asked to call `mcp__fake__lookup`. This matters: the racing call **did not become a real remote request**. It was judged an `unknown_tool` at the `snapshot.prepare()` step. It never reached argument validation, let alone the network.

This is what "the boundary is at the correct layer" means — if the snapshot check sat **after** the network call, the model's race-ahead would become a real side effect, and only then would you tell it "oh, this tool does not actually exist yet". At that point, undoing it is too late.

Lines 6 and 7 are a side gain: `runtime_status` shows an empty connection list in the 1st request, and it becomes `["fake"]` in the 2nd. It honestly reflects the previous turn's result, and **it reflects the live registry's state, not the snapshot's state**. There is a subtle but important offset here:

```text
The 2nd request:
  runtime_status says   mcp_connections: ["fake"]    ← Live state
  The tools list also has     mcp__fake__lookup           ← This turn's snapshot
  The two agree ✓

If the model could see the status already in the 1st request (suppose we refreshed the status after the response):
  runtime_status would say  mcp_connections: ["fake"]
  But the tools list does not have  mcp__fake__lookup
  The two contradict each other ✗ → The model would call a tool that "the state says exists, and the tool surface says does not"
```

P20's method: `status` and `tools` take their values in **the same** `#prepareModelRequest` call (`loop.ts:508` renders the prompt, `loop.ts:516` takes the snapshot, eight lines apart). Two snapshots from the same moment cannot contradict each other.

### Experiment 5 (snapshot): A snapshot is an immutable copy

Experiment 4 views the snapshot boundary inside a complete Agent. This experiment looks directly at `ToolRegistry`, and peels the mechanism out on its own.

```typescript
// ---------- Experiment 5 (snapshot): A snapshot is an immutable copy and does not follow live registry changes ----------
if (section("snapshot")) {
  const registry = new ToolRegistry();
  const definition = {
    name: "alpha",
    description: "first tool",
    inputSchema: z.object({}),
    effect: "read" as const,
    handler: () => toolSuccess("alpha"),
  };
  registry.register(definition);
  const snapshot = registry.snapshot();
  step(1, `Live registry v${registry.version}: [${registry.names.join(", ")}]`);
  step(2, `Snapshot v${snapshot.version}: [${snapshot.names.join(", ")}]`);
  registry.register({
    name: "beta",
    description: "second tool",
    inputSchema: z.object({}),
    effect: "read" as const,
    handler: () => toolSuccess("beta"),
  });
  step(3, `Live registry after an addition, v${registry.version}: [${registry.names.join(", ")}]`);
  step(4, `The same snapshot is still v${snapshot.version}: [${snapshot.names.join(", ")}]`);
  step(
    5,
    `prepare("beta") on the snapshot → ${
      snapshot.prepare(toolCall("x", "beta", "{}")).error?.content ?? "(success)"
    }`,
  );
  step(
    6,
    `Try to register into the snapshot → ${await reason(() =>
      snapshot.register({
        name: "gamma",
        description: "third",
        inputSchema: z.object({}),
        effect: "read" as const,
        handler: () => toolSuccess("gamma"),
      }),
    )}`,
  );
  step(
    7,
    `Revoke by name (not by object identity) → ${await reason(() =>
      registry.unregisterMany([{ ...definition }]),
    )}`,
  );
  step(8, `Revoke by object identity → ${await reason(() => registry.unregisterMany([definition]))}`);
  step(9, `Live registry after revocation, v${registry.version}: [${registry.names.join(", ")}]`);
}
```

```powershell
npx tsx scripts\probe-ch20.mts snapshot
```

```text
===== snapshot =====
[1] Live registry v1: [alpha]
[2] Snapshot v1: [alpha]
[3] Live registry after an addition, v2: [alpha, beta]
[4] The same snapshot is still v1: [alpha]
[5] prepare("beta") on the snapshot → Error [unknown_tool]: Unknown tool: beta
[6] Try to register into the snapshot → tool registry snapshot is immutable
[7] Revoke by name (not by object identity) → tool definition was not registered by this registry
[8] Revoke by object identity → (no error)
[9] Live registry after revocation, v3: [beta]
```

Lines 3 and 4 are the core comparison: the live registry is already at v2 and has two tools. The same snapshot is still v1 and has one. A snapshot is not a "reference". It is a **copy**.

Line 5 translates this into a form the model can perceive: calling a tool that already exists in the live registry, on the snapshot, returns `unknown_tool`. This is **exactly the same** error as `mcp__fake__lookup` in Experiment 4 — because it is the same mechanism.

Line 6 defends the other direction: code that holds the snapshot cannot change the tool surface in return. `#executeTool` holds this snapshot. If it were writable, a tool handler could add a new tool for itself in the middle of execution.

Lines 7 and 8 are a pair to read together. The same definition: one is a spread copy `{ ...definition }`, and one is the original object. Every field of the copy is equal, but the revocation failed — **revocation recognises object identity, not names**.

Why be this strict? Think of a real scenario:

```text
Moment 1  Connection A registered mcp__x__query
Moment 2  Connection A dropped, and the Watchdog prepares to revoke
Moment 3  Connection A reconnected successfully, and registered a new mcp__x__query (a new object)
Moment 4  The revocation from moment 2 finally executes
```

If revocation works by name, moment 4 deletes **the tool that the new connection just registered**, while the snapshot in the model's hand still shows it exists. Revocation by object identity has no such problem: moment 2 holds the old object, the new object does not match, and the revocation fails naturally — and failure is exactly the wanted behavior here.

The `v3` on line 9 also deserves a glance: a revocation **also** advances the version number. The version number records "how many times the tool surface changed", not "how many tools there are".

### Experiment 6 (pairing): Six wrong pairings

This experiment builds no Agent. It pulls `validateToolPairing` out directly and feeds it six histories.

```typescript
// ---------- Experiment 6 (pairing): One tool call must have exactly one result with the same id ----------
if (section("pairing")) {
  const call = toolCall("call-1", "read_file", '{"path":"a.txt"}');
  const cases: readonly (readonly [string, readonly ChatMessage[]])[] = [
    ["A result with the same id follows the call at once", [assistantMessage(null, [call]), toolMessage("ok", "call-1")]],
    ["The turn ends after the call, with no result", [assistantMessage(null, [call])]],
    ["A result with a different id follows the call", [assistantMessage(null, [call]), toolMessage("ok", "call-2")]],
    ["A user message is inserted after the call first", [assistantMessage(null, [call]), userMessage("interjecting"), toolMessage("ok", "call-1")]],
    ["A result exists with no call", [toolMessage("ok", "call-1")]],
    [
      "The same id is filled back twice",
      [assistantMessage(null, [call]), toolMessage("ok", "call-1"), toolMessage("ok", "call-1")],
    ],
  ];
  let index = 1;
  for (const [label, history] of cases) {
    step(index, `${label} → ${await reason(() => validateToolPairing(history))}`);
    index += 1;
  }
}
```

```powershell
npx tsx scripts\probe-ch20.mts pairing
```

```text
===== pairing =====
[1] A result with the same id follows the call at once → (no error)
[2] The turn ends after the call, with no result → missing tool results for ids: ["call-1"]
[3] A result with a different id follows the call → unexpected tool result id: call-2
[4] A user message is inserted after the call first → missing tool results for ids: ["call-1"]
[5] A result exists with no call → orphan tool result id: call-1
[6] The same id is filled back twice → orphan tool result id: call-1
```

Six situations, four different errors. Each one in turn:

| Line | What is wrong | Error | Real cause |
| --- | --- | --- | --- |
| 2 | The result is missing | `missing tool results` | Tool execution threw an exception that was swallowed, and the fill-back was skipped |
| 3 | The id is wrong | `unexpected tool result id` | The result processor mismatched the pairing relation |
| 4 | A message was inserted in between | `missing tool results` | User input or an event was inserted before the tool result |
| 5 | A result is extra | `orphan tool result id` | Compaction cut the assistant message away and left an orphan result |
| 6 | A result was filled back twice | `orphan tool result id` | Retry logic filled a result back twice |

The comparison of lines 3 and 4 is the most interesting. In both situations, **"the result is not in the correct position"**, but the errors differ:

```text
Line 3  [assistant(call-1)] [tool(call-2)]
         → When it meets call-2, the set waiting to be filled holds only call-1
         → unexpected: I am not waiting for this id

Line 4  [assistant(call-1)] [user] [tool(call-1)]
         → When it meets the user message, the set still holds call-1, not yet cleared
         → missing: What should have been filled back has not been, and you changed the topic
```

The difference lies in **at which step the check triggers**. The key to line 4: the moment a `user` message appears, the validator judges that "the tool turn ended". At that moment, a non-empty set is illegal. So the `tool(call-1)` after it is never even checked.

This rule has a direct effect on P20: Section 9.2's "events must be deferred during a user turn" has its root cause right here. If a `runtime_event` user message is inserted into the history before the tool results, the history becomes illegal at once. An event must wait until a whole tool turn has been filled back before it can enter.

Lines 5 and 6 report the same error, because in the validator's eyes they are the same thing: **it meets a result, but its id is not in the set waiting to be filled**. On line 5, the id never entered the set. On line 6, the first result already consumed it.

### Experiment 7 (close): Reverse order, aggregation, idempotence

```typescript
// ---------- Experiment 7 (close): Reverse-order close, failure aggregation, idempotence, and concurrency rejection ----------
if (section("close")) {
  const trace: string[] = [];
  class TracedResource implements AsyncResource {
    constructor(
      readonly name: string,
      readonly fails = false,
    ) {}

    async close(): Promise<void> {
      trace.push(this.name);
      if (this.fails) throw new Error(`${this.name} close failed`);
    }
  }
```

```typescript
  const model: ModelClient = {
    async complete() {
      return { message: assistantMessage("ok"), finishReason: "stop" as const };
    },
  };
  const okRunner = new AgentRunner({
    model,
    tools: new ToolRegistry(),
    systemPrompt: "system",
    workspace: process.cwd(),
    resources: [
      new TracedResource("supervisor"),
      new TracedResource("cron"),
      new TracedResource("teammate"),
      new TracedResource("mcp"),
    ],
  });
  await okRunner.close();
  step(1, `Registration order supervisor → cron → teammate → mcp, close order: ${trace.join(" → ")}`);
  await okRunner.close();
  step(2, `Call close() once more, and the close trace is still ${trace.length} entries: ${String(trace.length === 4)}`);
  step(3, `Can you still run() after close → ${await reason(() => okRunner.run("One more time"))}`);

  trace.length = 0;
  const failRunner = new AgentRunner({
    model,
    tools: new ToolRegistry(),
    systemPrompt: "system",
    workspace: process.cwd(),
    resources: [
      new TracedResource("supervisor", true),
      new TracedResource("cron"),
      new TracedResource("teammate", true),
      new TracedResource("mcp"),
    ],
  });
  try {
    await failRunner.close();
  } catch (error) {
    const aggregate = error as AggregateError;
    step(4, `Two resources failed to close → ${aggregate.name}: ${aggregate.message}`);
    step(
      5,
      `Each entry in the aggregate: [${aggregate.errors.map((item: unknown) => (item as Error).message).join(" | ")}]`,
    );
  }
  step(6, `Even with failures, all resources were walked: ${trace.join(" → ")}`);
}
```

```powershell
npx tsx scripts\probe-ch20.mts close
```

```text
===== close =====
[1] Registration order supervisor → cron → teammate → mcp, close order: mcp → teammate → cron → supervisor
[2] Call close() once more, and the close trace is still 4 entries: true
[3] Can you still run() after close → AgentRunner is closed
[4] Two resources failed to close → AggregateError: AgentRunner close failed
[5] Each entry in the aggregate: [teammate close failed | supervisor close failed]
[6] Even with failures, all resources were walked: mcp → teammate → cron → supervisor
```

Line 1 is reverse order. At registration, `supervisor` is at the front. At close, it is last — because upstream components must wait until all downstream components have stopped before they can close.

Line 2 is idempotence. The second `close()` did not walk the resources again, and the trace is still 4 entries. This is very practical: calling `close()` inside `try/finally`, and calling it once more in an outer error handler, is a common pattern. Without idempotence, the second call would call `close()` again on an already-closed connection, and the behavior is unpredictable.

Line 3 is closedness after close. A closed Runner cannot be reused. It reports `AgentRunner is closed` directly. Why not let it reopen automatically? Because the things in `resources` are already dead — child processes killed, connections broken, file handles released. A "reopen" is actually a "rebuild", and the caller should do that explicitly.

Lines 4, 5, and 6 form the failure handling. Only the three together are complete:

```text
Four resources, of which supervisor and teammate throw errors

The behavior of close():
  mcp        → Success
  teammate   → Throws, recorded, continues
  cron       → Success
  supervisor → Throws, recorded
  → Two failures → AggregateError

trace = mcp → teammate → cron → supervisor    ← Not one was skipped
errors = [teammate's error, supervisor's error]      ← In the order they happened
```

**The key is line 6: a failure did not interrupt the loop.** If the first throw escaped at once, the three resources behind it would never close — child processes stay, file locks are not released. So each resource has its own `try/catch`, everything is walked, and only then does the code decide how to report.

The order of the `errors` array is `teammate` first and `supervisor` after. That matches the **close order**, not the registration order. Read an aggregate error in this order, and you know which layer broke first.

One detail: **a single failure is not wrapped into an `AggregateError`**. It is thrown unchanged. Wrapping it would add a layer, and a caller would have to expand `.errors` just to see one error. This is "error handling must not manufacture new noise".

### Experiment 8 (events): The same event enters the history only once

This experiment hand-writes an event pump. It puts **two events with the same `eventId`** into the queue, and then looks at how many entered the history.

```typescript
// ---------- Experiment 8 (events): The same event, delivered again, enters the history only once ----------
if (section("events")) {
  class ProbeEvent implements RuntimeEvent {
    constructor(readonly eventId: string) {}

    toPayload(): Readonly<Record<string, unknown>> {
      return Object.freeze({ kind: "background_job", prompt: `Event ${this.eventId} completed` });
    }
  }

  const acked: string[] = [];
  const queue: RuntimeEvent[] = [new ProbeEvent("evt-1"), new ProbeEvent("evt-1")];
  const pump = {
    get hasPendingWork(): boolean {
      return queue.length > 0;
    },
    drainEvents(limit = queue.length): readonly RuntimeEvent[] {
      return Object.freeze(queue.splice(0, limit));
    },
    async waitForEvents(limit = queue.length): Promise<readonly RuntimeEvent[]> {
      return this.drainEvents(limit);
    },
    acknowledgeEvents(events: readonly RuntimeEvent[]): void {
      for (const event of events) acked.push(event.eventId);
    },
  };
```

This `pump` is deliberately built to "deliver repeatedly": the two `ProbeEvent`s are **different objects**, but both `eventId`s are `"evt-1"`. In the real world, this maps to at-least-once delivery — an ack is lost, a process restarts, a network retry happens, and the same event arrives twice.

```typescript
  const model: ModelClient = {
    async complete(request: ModelRequest) {
      return {
        message: assistantMessage(`Received ${request.messages.filter((m) => m.role === "user").length} user messages`),
        finishReason: "stop" as const,
      };
    },
  };
  const runner = new AgentRunner({
    model,
    tools: new ToolRegistry(),
    systemPrompt: "system",
    workspace: process.cwd(),
    eventPump: pump,
  });
```

```typescript
  try {
    const first = await runner.runEvents();
    step(1, `1st runEvents() → ${first?.finalText ?? "(no event)"}`);
    const second = await runner.runEvents();
    step(2, `2nd runEvents() (the same eventId delivered once more) → ${second?.finalText ?? "undefined"}`);
    const events = runner.history.filter(
      (message) => message.role === "user" && message.content.includes("runtime_event"),
    );
    step(3, `Number of runtime_event entries in the canonical history: ${events.length}`);
    step(4, `Ack records: [${acked.join(", ")}]`);
  } finally {
    await runner.close();
  }
}
```

```powershell
npx tsx scripts\probe-ch20.mts events
```

```text
===== events =====
[1] 1st runEvents() → Received 1 user message
[2] 2nd runEvents() (the same eventId delivered once more) → undefined
[3] Number of runtime_event entries in the canonical history: 1
[4] Ack records: [evt-1]
```

The four lines of output map to one complete deduplication semantics:

**Line 1:** The first event is accepted. It is wrapped into a user message, it enters the history, and the model sees 1 message.

**Line 2:** The second event (same ID) is discarded, and `runEvents()` returns `undefined` — **the model is not even called**. This return value matters: `undefined` means "nothing happened in this round". The caller (for example, the CLI's event loop) decides from it whether to keep waiting.

**Line 3:** The history holds only 1 entry. This is the property that must be protected in the end.

**Line 4:** But `evt-1` was acked **once**. Note that it is not zero times — the ack comes after the first event successfully entered the history.

Line 4 deserves one more layer of thought. Why does the ack record hold only one entry, and not two? Because the second delivery's event was discarded by deduplication. It did not take the "accept → enter history → ack" path. It was stopped before it entered the history, so it is not acked.

This looks like a "missed ack", but it is not a problem: the same `eventId` means it is the same event. The first ack already represents that it was processed. In a real implementation, the event source sees "this ID has already been acked", and it does not redeliver forever.

**The order is also deliberate: the history is written first, and the ack is sent afterwards.** In the reverse order (ack first, then write the history), a failed history write loses the event forever — the event source believes it was delivered, and the Agent has nothing. In the current order, the worst case is "written in, but not acked". The event is delivered once more, and `eventId` deduplication stops it. **At-least-once delivery + idempotent consumption = an exactly-once effect.** This is the most common pair in distributed systems.

### Experiment 9 (recovery): Six failures, two messages

```typescript
// ---------- Experiment 9 (recovery): Recovery attempts do not enter the canonical history ----------
if (section("recovery")) {
  await withTempDir(async (root) => {
    const model = new RecoveryProbeModel();
    const connection = new FakeConnection();
    const harness = createHarness(root, model, createRuntime(connection));
    const runner = buildAgent(P20, {
      ...harness.dependencies,
      recoveryConfig: new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
        baseDelaySeconds: 0.001,
        maxDelaySeconds: 0.001,
        jitterRatio: 0,
      }),
    });
    try {
      const result = await runner.run("Verify recovery boundary");
      const main = model.requests.filter((request) => request.tools.length > 0);
      step(1, `The real failure sequence on the model side: [${model.failures.join(", ")}]`);
      step(2, `Main request count: ${main.length}`);
      step(3, `Model used by each request: [${main.map((request) => request.model).join(", ")}]`);
      step(4, `maxTokens of each request: [${main.map((request) => request.maxTokens).join(", ")}]`);
      step(5, `Final answer: ${result.finalText}`);
      step(6, `Canonical history length: ${result.history.length}`);
      step(
        7,
        `History content: ${result.history
          .map((message) => `${message.role}:${message.content ?? "(null)"}`)
          .join(" | ")}`,
      );
      step(
        8,
        `Does the history hold the discarded reply with finish_reason=length: ${String(
          result.history.some((message) => message.content?.includes("discarded") === true),
        )}`,
      );
    } finally {
      await runner.close();
    }
  });
}
```

The three `0.001` values and `jitterRatio: 0` exist so the experiment can finish in seconds. In a production configuration, the backoff really waits, and jitter is necessary too — otherwise a batch of Agents retries in the same millisecond, and an overload becomes an avalanche.

```powershell
npx tsx scripts\probe-ch20.mts recovery
```

```text
===== recovery =====
[1] The real failure sequence on the model side: [429, 529, 529, 529, length, prompt-too-long]
[2] Main request count: 7
[3] Model used by each request: [primary, primary, primary, primary, fallback, fallback, fallback]
[4] maxTokens of each request: [8000, 8000, 8000, 8000, 8000, 64000, 64000]
[5] Final answer: recovered
[6] Canonical history length: 2
[7] History content: user:Verify recovery boundary | assistant:recovered
[8] Does the history hold the discarded reply with finish_reason=length: false
```

Seven requests, six failures, final success. Align the three arrays on lines 1, 3, and 4 vertically, and the whole recovery trajectory is clear:

```text
        Failure          Model        maxTokens   What RecoveryManager did
1st      429          primary     8000        Waited per Retry-After, retried
2nd      529          primary     8000        Count 1/3, backoff retry
3rd      529          primary     8000        Count 2/3, backoff retry
4th      529          primary     8000        Count 3/3 → Threshold reached, switched to fallback
5th      length       fallback    8000        Limit 8000 → 64000, discarded the fragment and started over
6th      prompt-too-long fallback 64000       Triggered one compaction, started over
7th      (success)      fallback    64000       Returned recovered
```

A few places that are easy to misread:

**The model switch happens at the 5th request, not the 4th.** The 4th request **still uses primary**. The switch happens after it fails. `overloadFallbackThreshold = 3` counts "the number of consecutive 529s". It acts when the count reaches 3.

**The `maxTokens` raise also happens at the next request.** The 5th request still uses 8000. After it returns `length`, the 6th request is 64000.

**A 529 does not look at `Retry-After`. A 429 does.** The two status codes have different semantics: a 429 is "you are too fast, wait this long and come back", and the server tells you exactly how long to wait. A 529 is "I cannot carry the load here", and any wait length is a guess. So it uses exponential backoff, and it considers switching models.

Lines 6, 7, and 8 are what this experiment really proves. **Six failures, and the canonical history holds not one trace of them**: only one user message and one assistant message.

Line 8 looks specifically for the reply with `finishReason === "length"` (its content is `"discarded"`) — and does not find it. It was discarded. It never entered the history.

Why must it be this way? If the recovery process entered the history, two bad things would happen:

```text
Bad thing one: The model sees its own failure
  The history holds one truncated, incomplete reply
  → In the next turn, the model tries to "continue" from that incomplete content
  → But it was already discarded, and there is no context
  → The output breaks down

Bad thing two: The history is polluted, and compaction suffers with it
  6 failures = 6 garbage messages
  → Compaction must process them, and it may treat them as "key findings" and summarise them into the abstract
  → One network jitter is written into the Agent's long-term memory
```

The implementation relies on the thing Section 10.3 covered: the `requestMessages` that `#prepareModelRequest` returns is a **local frozen copy**. The recovery manager changes this copy. `this.#history` is pushed in only two places from start to finish — when user input is received, and when a **successful** model reply is received.

### Experiment 10 (surface): 25 tools, not one more

```typescript
// ---------- Experiment 10 (surface): The Lead tool surface and sub-executor trimming ----------
if (section("surface")) {
  await withTempDir(async (root) => {
    const model = new HarnessProbeModel();
    const connection = new FakeConnection();
    const mcpRuntime = createRuntime(connection);
    const harness = createHarness(root, model, mcpRuntime);
    const runner = buildAgent(P20, harness.dependencies);
    try {
      await runner.run("List the tools");
      const main = model.requests.filter((request) => request.tools.length > 0);
      const first = main[0];
      if (first === undefined) throw new Error("probe expected one main request");
      const names = toolNamesOf(first);
      step(1, `The Lead tool surface has ${names.length} tools in total:`);
      for (const [index, name] of names.entries()) {
        console.log(`      ${String(index + 1).padStart(2, " ")}. ${name}`);
      }
      step(2, `The Lead has request_shutdown / review_plan: ${String(
        names.includes("request_shutdown") && names.includes("review_plan"),
      )}`);
      step(3, `The Lead has submit_plan: ${String(names.includes("submit_plan"))}`);
      step(4, `The Lead has connect_mcp / disconnect_mcp: ${String(
        names.includes("connect_mcp") && names.includes("disconnect_mcp"),
      )}`);
      const teammateSurface = ["shell", "read_file", "write_file"];
      step(5, `Built-in tools a teammate is trimmed down to: [${teammateSurface.join(", ")}], plus send_message / submit_plan and the leased task tools`);
      step(6, `Can a teammate see connect_mcp: ${String(teammateSurface.includes("connect_mcp"))}`);
    } finally {
      await runner.close();
    }
  });
}
```

The `teammateSurface` on lines 5 and 6 is **copied verbatim** from the `subset()` arguments at `bootstrap.ts` line 212. It is not read at runtime — a teammate sends a request only after it really spawns. If you want to confirm yourself that this array exists in only one place, search for it:

```powershell
Select-String -Path 'chapters\ch20\src\bootstrap.ts' -Pattern 'subset\('
```

Only one line in the whole composition root matches. A subagent takes another path (`createStandardTools(profile, ..., false)`. The final `false` is "not the Lead"). Section 7.3 covered why neither path can obtain MCP.

```powershell
npx tsx scripts\probe-ch20.mts surface
```

```text
===== surface =====
[1] The Lead tool surface has 25 tools in total:
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
      16. create_worktree
      17. keep_worktree
      18. remove_worktree
      19. schedule_cron
      20. spawn_teammate
      21. send_message
      22. request_shutdown
      23. review_plan
      24. connect_mcp
      25. disconnect_mcp
[2] The Lead has request_shutdown / review_plan: true
[3] The Lead has submit_plan: false
[4] The Lead has connect_mcp / disconnect_mcp: true
[5] Built-in tools a teammate is trimmed down to: [shell, read_file, write_file], plus send_message / submit_plan and the leased task tools
[6] Can a teammate see connect_mcp: false
```

The **order** of this list is not alphabetical. It is the registration order, which is the order of the chapters that introduced the capabilities. Items 1 to 8 are the base tools from P1 to P7. Items 9 to 13 are P12's task system. Items 14 to 15 are P13's background query and cancel. Items 16 to 18 are P18's worktrees. Item 19 is P14's Cron. Items 20 to 21 are P15's teammates. Items 22 to 23 are P16's protocol. Items 24 to 25 are P19's MCP.

Line 3 is the line in this experiment that is easiest to overlook: **the Lead does not have `submit_plan`**. A plan is something a teammate submits to the Lead for review. The Lead does not submit plans itself. The three protocol tools are assigned like this:

```text
submit_plan      → Teammates only     (I will do these things, please approve)
review_plan      → Lead only    (I approved it / I sent it back)
request_shutdown → Lead only    (Can you wrap up now)
```

If the Lead also had `submit_plan`, it could submit a plan to itself and then approve it itself — a process that is formally complete and substantively empty. This kind of "role tool asymmetry" design is a standard technique in multi-Agent systems for preventing self-authorisation.

### Run all ten

```powershell
npx tsx scripts\probe-ch20.mts
```

No argument means `all`. The ten segments run in order, and they produce 119 lines of output in total. The whole process took about 1.7 seconds on my machine, because there is no real network, no child process, and every backoff time was tuned to 1 millisecond.

### Clean up after the experiments

```powershell
Remove-Item 'F:\笔记\Agent实操\code\scripts\probe-ch20.mts'
```

The experiments' temporary directories are deleted automatically by `withTempDir`'s `finally`. There is no child process to clean — this chapter's experiments all run inside the process.

---

## What This Chapter Deliberately Did Not Do

The easiest mistake for an integration chapter is to add a pile of things on the side while "wrapping up". P20 explicitly excludes the following:

| Not done | Why |
| --- | --- |
| A second Loop, a second Runner, a second history | `full_harness` is a marker, not a module. One Agent should have exactly one execution path |
| Runtime capability switches | A profile is a compile-time constant. `profileForChapter()` recognises only 20 fixed objects. A changeable combination is an error-prone combination |
| Letting `runtime_status` take part in authorisation | It is an observable shown to the model. Section 6.4: observable ≠ authorisable |
| Using `runtime_status` to replace the `EventInbox` | It can only say "whether there is pending work". It cannot say "what happened". An event must enter the history. The status bar does not |
| Restoring the `mcp-external-approval` rule | This chapter's task is to explain P20's current state clearly. Section 11.4 gave the complete fix and three pieces of evidence. Whether to change it is your decision |
| A cross-process / cross-machine Harness | Everything is inside one Node process. A teammate is a Runner in the same process, not an independent process |
| Calling a child process a sandbox | The `shell` and stdio MCP servers are both local processes **with the same privilege as the Agent**. Real isolation needs containers |
| Close timeouts and force kills | `close()` honestly waits for every resource. One stuck resource hangs the whole close. There is no timeout fallback |
| Persistence of the event deduplication table | `#seenEventIds` is a field of the Runner instance. A process restart empties it |
| New model capabilities | No new protocol beyond function calling, no streaming, no multimodal support |

Two items need expansion, because they are real boundaries, not "do it later".

**Close has no timeout.** Look at the code in Section 12.2 and you can see it: inside the `for` loop there is `await resource.close()`, with no `Promise.race` and no timer. If an MCP server's child process sticks inside `close()` and never returns, the whole process stops there. A production system usually adds "if it has not closed after N seconds, SIGKILL it". This chapter does not do that — because the semantics of a force kill (whether to wait for cleanup, whether to preserve state) depend on the concrete resource type. Making it generic logic would turn it into a pile of switches.

**The event deduplication table does not cross processes.** `#seenEventIds` is valid only within one Runner instance's lifetime. So after a process restart, will an already-processed event run again? No. But **the protection is not this table**. It is the ack state in each store:

```text
The complete lifecycle of one cron event

  cron.tick()          → The event is written into cronStore.pendingEvents()   [persistent]
  runEvents()          → The event enters the history
  acknowledgeEvents()  → It is deleted from pendingEvents()              [persistent]

  Process restart
  → It is already gone from pendingEvents()
  → The event pump cannot read it, so it naturally does not replay
```

Test 6 in `ch20-full-harness.test.ts` verifies exactly this: it consumes one cron event, leaves one unconsumed, then `close()`s the whole Runner and **rebuilds** a dependency set with the same working directory. It confirms that `pendingEvents()` holds only the unconsumed one. `#seenEventIds` played no part in this scenario — it defends against duplicate delivery inside one process (the Experiment 8 kind). Persistent deduplication is the store's responsibility.

**Remember this two-layer division of labour: the in-memory table prevents duplicates inside a process, and the persistent ack prevents replay across restarts.** Missing either layer leaks.

---

## Differences from Claude Code

Each of the first nineteen chapters compared one local difference. This chapter compares the **overall shape**: how does a real product's harness differ from a teaching harness?

### Where we simplified

| Dimension | Claude Code | This chapter |
| --- | --- | --- |
| Capability combination | Configurable at runtime: settings files, CLI arguments, plugins, and enterprise policies merge in multiple layers | 20 fixed profiles, compile-time constants, not composable |
| Process model | A main process + multiple child processes (MCP servers, shell, IDE extensions), with process management and restart | One Node process. Teammates and Subagents are Runners in the same process |
| Status bar | A rich status line: token usage, cost, model name, current branch, context share | `runtime_status` has only two fields: `mcp_connections` and `pending_work` |
| Close | Phased close + timeout + force kill, with a reclamation mechanism for orphan processes | Reverse-order `close()`, no timeout, no force kill |
| Event sources | Background tasks, Cron, teammates, IDE, remote sessions, MCP notifications | Three kinds: background tasks, Cron, teammates |
| Permission interaction | A visual approval panel, `/permissions` management, durable authorisation, mode switching (plan/acceptEdits/bypass) | Terminal y/n approval, no persistent authorisation, no modes |
| Recovery | A finer-grained retry strategy classification, multi-provider fallback, request-level budget control | Four classes: 429 / 529 / length / prompt-too-long, one fallback chain |
| Context | Automatic compaction + manual `/compact` + micro-compaction + cache breakpoint management | Request-level compaction + one reactive compaction |

### Where we are stricter than the product

These are not "the teaching version makes do". They are deliberately chosen harder constraints — because teaching code must be readable, not only runnable.

**Profile identity uses reference comparison.** If `profileForChapter(profile.chapter) !== profile`, the code reports an error. A real product must support user-defined configuration, so it cannot do this. But for teaching code, this gate shrinks "possible capability combinations" from 2²⁶ to 20 kinds, and every kind has tests.

**Dependency sharing uses object identity validation.** The four groups of "must be the same object" checks (Section 3.4) run at startup. A product usually relies on a dependency injection container to guarantee singletons. When something goes wrong, the error message is the container's internal error. Here, the error says "cronRuntime must share the background supervisor and event inbox" — it tells you **how to fix it**.

**The recovery process does not enter the history at all.** It is strict enough to discard even a truncated model reply (Experiment 9, line 8). A product often keeps some traces for debugging.

**A close failure is not swallowed.** Two or more failures are aggregated into an `AggregateError` and thrown. One failure is thrown unchanged. **A close failure is also a failure.** It cannot be treated as if nothing happened just because "we are exiting anyway" — a leaked child process and file lock affect the next startup.

**`runtime_status` has only two fields.** This is deliberate minimisation. Every added field must answer two questions: is it synchronously available? And can it be mistaken for a basis for authorisation? Section 6.4 covered why `pending_work` reports a boolean and not content.

---

## From ch19 to ch20: What Did the Code Actually Change?

This section lays the diff out flat. The reason it deserves its own section is that it proves one thing: **"complete" does not equal "more"**.

Look at the file level first. Relative to ch19, ch20 **added only three files**:

| Added file | Lines | Role |
| --- | --- | --- |
| `src/chapters/ch20.ts` | 5 | The fixed chapter entry |
| `tests/ch20-full-harness.test.ts` | 1212 | 7 cross-feature scenarios |
| `tests/ch20-entry.test.ts` | 65 | 4 entry and profile tests |

**It added no `src/features/` or `src/adapters/` file at all.** Not one new runtime.

Now look at the changed files. 8 files have a diff, but their natures differ completely. They fall into three classes:

**Class one: zero change (5 files, byte-identical after the fix).**

```text
src/features/mcp-tools.ts    806 → 806 lines
src/adapters/mcp-client.ts   347 → 347 lines
src/adapters/mcp-schema.ts    76 →  76 lines
src/core/tools.ts            380 → 380 lines
src/mcp-servers/demo.ts       63 →  63 lines
```

In the first draft, about 68 lines of explanatory comments had been stripped from these five files as a whole (zero logic change; byte-identical after the comments were stripped) — exactly the "the previous chapter has it, this chapter does not" class. During review, following the rule "a cumulative snapshot must not silently lose a previous chapter's comments", the ch19 versions were backfilled into the whole files. These five files are now byte-identical to ch19. You can verify it yourself:

```powershell
Set-Location 'F:\笔记\Agent实操\code\chapters'
$a = Get-Content ch19\src\features\mcp-tools.ts | Where-Object { $_ -notmatch '^\s*//' -and $_.Trim() -ne '' }
$b = Get-Content ch20\src\features\mcp-tools.ts | Where-Object { $_ -notmatch '^\s*//' -and $_.Trim() -ne '' }
Compare-Object $a $b
```

There is no output. P20 did not change one character of MCP's 756 lines of core logic — what it inherits is an **already verified** boundary, not a re-implementation.

**Class two: P20's real additions (2 files).**

| File | Lines | What changed |
| --- | --- | --- |
| `src/features/prompting.ts` | 252 → 274 | Added the `status?: JsonObject` field, the `DynamicPromptStatusProvider` type, `status` in the cache key, the `## runtime_status` section appended at the end, and a construction-time check that `statusProvider` must be a function |
| `src/bootstrap.ts` | 501 → 525 | Added `fullHarnessRuntimeStatus()` (12 lines) and the `statusProvider` installation for `full_harness` (5 lines); it also extracted the assembly validation into a separate function |

**22 lines + 24 lines. That is all of P20's new feature code.**

**Class three: structural reorganisation, behavior unchanged (3 files).**

| File | Lines | What was reorganised |
| --- | --- | --- |
| `src/core/profiles.ts` | 326 → **152** | 20 hand-written frozen objects → the `PROFILE_DELTAS` incremental array + derivation |
| `src/core/loop.ts` | 789 → 800 | The inline "assemble the request" code inside a turn was extracted into `#prepareModelRequest()` (+8 lines of extraction, and 3 more lines are snapshot/rendering comments) |
| `src/cli.ts` | 412 → 456 | Extracted `createLiveRuntime()` and the `LiveRuntime` interface, and connected the Teammate wakeup |

The **−174 lines** in `profiles.ts` is the most beautiful change in this chapter. The 326 lines in ch19 consisted of two boilerplate segments.

Segment one: **the first 11 profiles hand-write their complete capability sets**. P11 looks like this:

```typescript
export const P11: ChapterProfile = Object.freeze({
  chapter: 11,
  capabilities: new CapabilitySet([
    "loop", "powershell", "tool_registry", "files", "policy", "hooks", "todo",
    "subagent", "skills", "artifacts", "compaction", "memory", "dynamic_prompt",
    "recovery",
  ]),
});
```

14 strings, hand-written once. In P10, the first 13 are written again. In P09, the first 12 are written again… Only after P12 did it switch to spread:

```typescript
export const P19: ChapterProfile = Object.freeze({
  chapter: 19,
  capabilities: new CapabilitySet([...P18.capabilities, "mcp"]),
});
```

**Two writing styles coexist in the same file** — the first 11 are hand-copied, and the last 8 inherit. If one capability is missed in the 11 hand-copied ones, the code still compiles, and "P(N) ⊃ P(N-1)" is only a convention.

Segment two: **`profileForChapter` is a 19-branch if chain** (lines 264 to 326, a full 63 lines):

```typescript
export function profileForChapter(chapter: number): ChapterProfile {
  if (chapter === 1) { return P01; }
  if (chapter === 2) { return P02; }
  // ……all the way to 19
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
```

Adding a chapter requires changes in two places: write a new profile, and add one if branch. And note the last lines — the boundary says `chapter > 20`, but the if chain only reaches 19. So in ch19, `profileForChapter(20)` falls into the `has not been migrated` branch. **Two numbers must be kept consistent by hand. That is the typical cost of boilerplate code.**

ch20 removed both segments together (Section 2.1 covered `slice(0, index + 1).flat()`): the capability sets are derived from `PROFILE_DELTAS`, and the if chain became one array index plus a `PROFILES.length` boundary check. Writing 174 fewer lines is only a side product. The real gain is that **both inconsistencies can never happen again**.

Of the +11 lines in `loop.ts`, +8 lines are pure extraction (the other 3 lines are explanatory comments at the snapshot and rendering points). In ch19's turn loop, the 41 lines from `validateToolPairing(this.#history)` (line 369) to `tools: tools.openAITools()` (line 409) were **inlined in the `for` loop body**. ch20 moved them into `#prepareModelRequest()`. The loop holds only one call line:

```typescript
// #prepareModelRequest handles request-level compaction, dynamic prompt injection, and tool round observer guidance;
// turnGuidance/observerGuidance affects this model request only without writing to canonical history.
const { request, tools } = await this.#prepareModelRequest();
```

This extraction has direct value for this chapter: the order diagram in Section 4.1 can be drawn clearly precisely because "assemble the request" is now a named step. **`tools` and `request` are returned together by the same method.** The signature itself says "they must come from the same moment" — in Experiment 4, the tool counts (lines 2 and 4) and `runtime_status` (lines 6 and 7) must change in step, and the function signature pins that down.

### Changes to the tests

| File | Lines | Test count | Change |
| --- | --- | --- | --- |
| `tests/ch20-full-harness.test.ts` | 1212 | 7 | New |
| `tests/ch20-entry.test.ts` | 65 | 4 | New |
| `tests/prompting.test.ts` | 324 → 369 | 8 | Added the `runtime_status` position, the cache key, and the `statusProvider` check |
| `tests/profiles.test.ts` | 147 → 160 | 2 | Changed to verify the incremental model and fixed identity |
| `tests/ch19-bootstrap.test.ts` | 469 → **286** | 6 → 3 | **Deleted three MCP approval tests** (Section 11.3) |

The first four rows are normal evolution. The last row is this chapter's only **regression** — the tests disappeared together with the rule they protected. That is also why Sections 11.2 to 11.5 exist: the most important job of an integration chapter is to find this kind of "the previous chapter has it, this chapter does not" thing.

---

## Companion Code Index

All of this chapter's code is under `code/chapters/ch20/`. The chapter has 63 source files with 19655 lines in total, and 67 test files with 15546 lines in total — but **only the content in the tables below belongs to "Chapter 20"**. The rest accumulated over the first nineteen chapters.

**New files (3):**

| File | Lines | What this chapter is responsible for |
| --- | --- | --- |
| [src/chapters/ch20.ts](code/chapters/ch20/src/chapters/ch20.ts) | 5 | The fixed chapter entry, the same five lines as the first nineteen chapters |
| [tests/ch20-full-harness.test.ts](code/chapters/ch20/tests/ch20-full-harness.test.ts) | 1212 | 7 integration tests. The first 737 lines are shared assembly helpers. The test bodies start at line 738 |
| [tests/ch20-entry.test.ts](code/chapters/ch20/tests/ch20-entry.test.ts) | 65 | 4 entry tests: capability accumulation, the missing-configuration timing of the fixed entry, the unified entry parsing Chapter 20, and closing the model first when the workspace is not Git |

**Files with key changes in this chapter (5):**

| File | Lines | What this chapter changed |
| --- | --- | --- |
| [src/features/prompting.ts](code/chapters/ch20/src/features/prompting.ts) | 252 → 274 | `status?: JsonObject` (31), `DynamicPromptStatusProvider` (35), `status` in the cache key (89), `## runtime_status` appended at the end (111), `statusProvider` must be a function (142-143), the provider is called once per render (164) |
| [src/bootstrap.ts](code/chapters/ch20/src/bootstrap.ts) | 501 → 525 | `fullHarnessRuntimeStatus()` (81-93), `statusProvider` installed for `full_harness` (287-293), assembly validation extracted into `validateBuildDependencies()` (338), `usesJsonTaskStore()` (449) |
| [src/core/profiles.ts](code/chapters/ch20/src/core/profiles.ts) | 326 → 152 | `PROFILE_DELTAS` (81-103), the derived `PROFILES` (106-113), the `profileForChapter` boundary (137-143); the `"full_harness"` capability bit |
| [src/core/loop.ts](code/chapters/ch20/src/core/loop.ts) | 789 → 800 | Extracted `#prepareModelRequest()` (478-521). The turn loop holds only one call line (372) |
| [src/cli.ts](code/chapters/ch20/src/cli.ts) | 412 → 456 | Extracted the `LiveRuntime` interface (99) and `createLiveRuntime()` (220), and connected the Teammate wakeup |

**Files to read in this chapter but not changed** (almost all of P20's behavior is in these. They have not moved since their last appearance):

| File | Lines | Why this chapter reads it |
| --- | --- | --- |
| [src/core/loop.ts](code/chapters/ch20/src/core/loop.ts) `#prepareModelRequest` | 478-521 | The original text of the order diagram in Section 4.1. Line 508 renders the prompt, line 516 takes the snapshot |
| [src/core/loop.ts](code/chapters/ch20/src/core/loop.ts) `close` | 672-699 | Reverse-order close + failure aggregation. The whole basis of Section 12 |
| [src/core/messages.ts](code/chapters/ch20/src/core/messages.ts) `validateToolPairing` | 124-159 | The only implementation of Invariant 2. Experiment 6's six inputs all strike these 36 lines |
| [src/core/tools.ts](code/chapters/ch20/src/core/tools.ts) `snapshot` / `version` | A 380-line file | Invariant 1. The whole basis of Experiment 5 |
| [src/core/permissions.ts](code/chapters/ch20/src/core/permissions.ts) `#workspaceBoundaryDecision` / `strongestDecision` | 330 / 378 | "deny is stronger than ask". Why Experiment 4's line 10 is an empty array |
| [src/core/events.ts](code/chapters/ch20/src/core/events.ts) `EventInbox` | From line 34 | Three sources, one inbox. Section 9 and Experiment 8 |

### Recommended code reading order

This chapter has no new runtime to read. **What you read is the "joints".** Follow this order. Each step answers the question the previous step left:

1. **`src/core/profiles.ts` in full (152 lines)** — Start from `PROFILE_DELTAS`. This is the chapter's only "new concept", and it compresses 20 profiles into one array. Read it thoroughly in ten minutes, and everything after it benefits.
2. **`src/bootstrap.ts` lines 81-93** — `fullHarnessRuntimeStatus()`, 12 lines. All of P20's new function is here. Note that it reads only synchronous getters.
3. **`src/bootstrap.ts` lines 287-293** — The only place where `full_harness` is read.
4. **`src/features/prompting.ts` lines 96-113** — Why `## runtime_status` is necessarily last. Look at the initial value of the `sections` array and the order of the three `push` calls.
5. **`src/features/prompting.ts` lines 77-89** — The cache key. Why changing status necessarily misses.
6. **`src/core/loop.ts` lines 478-521** — `#prepareModelRequest()` in full. While you read, count how many lines separate 508 and 516.
7. **`src/core/messages.ts`'s `validateToolPairing`** — 36 lines of code, five kinds of refusal. Read it with Experiment 6's six lines of output (line 1 is the legal control group).
8. **`src/core/permissions.ts` lines 378-392** — The `["deny","ask","allow"]` order in `strongestDecision`. One for loop decided Experiment 4's line 10.
9. **`src/core/loop.ts` lines 672-699** — `close()`. The `[...].reverse()`, the per-resource try/catch, and the assignment position of `#closed`.
10. **`tests/ch20-full-harness.test.ts` lines 1037-1137** — Test 6. Cross-restart deduplication relies on the ack in the store, not on the in-memory table. This is the place in this chapter where it is easiest to think wrongly.
11. **`src/bootstrap.ts` lines 338-446** — `validateBuildDependencies()`. It opens with the sentence "profile must be a fixed chapter profile", and it ends with the four groups of object identity checks. Read it with Experiment 2's seven lines of output, one line against one check.

You can skip: the argument parsing in `src/cli.ts` and the inside of `createLiveRuntime()` (it only moved ch19's inline code to another place); and the first 735 lines of assembly helpers in `tests/ch20-full-harness.test.ts` — unless you want to write a new test yourself.

---

## Run and Verification

Five gates, passed in order. All run under `F:\笔记\Agent实操\code`:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch20
npm run typecheck
npm run lint
npm run format:check
npm run build
```

My measured results on this side:

```text
Test Files  65 passed (65)
      Tests  429 passed (429)
  Duration  18.65s
```

`test:ch20` also runs all the previous chapters' tests, so it is 65 files and 429 tests, not only ch20's 2 files. **For an integration chapter, this is the most important run** — Chapter 20 changed `profiles.ts` (the construction method of 20 profiles), `prompting.ts` (the dynamic prompt that every chapter uses), and `loop.ts` (the turn loop that every chapter uses). Move any of these three files, and a behavior change in any of the first nineteen chapters shows up in these 429 tests.

During the run, you will see these lines in the output:

```text
Runtime Failure: workspace is not a Git repository root
Runtime Failure: CLI execution or cleanup failed
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**These are not errors. They are the correct behavior being asserted.** From Chapter 11 on, every chapter has an entry test that verifies "when configuration is missing or the workspace is illegal, it must fail in exactly this way". So these lines are the entry tests of several chapters stacked together. Judge success or failure only by the final `Tests 429 passed`.

Run `ch20-entry.test.ts` alone, and you see only one line:

```powershell
npx vitest run chapters/ch20/tests/ch20-entry.test.ts
```

```text
Runtime Failure: workspace is not a Git repository root

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

There is only one line because, of those 4 tests, two "missing configuration" tests use `vi.spyOn(process.stderr, "write")` to capture the output and assert that the content contains `OPENAI_FALLBACK_MODEL`. So you cannot see them. Only the final "non-Git workspace" test's `Runtime Failure` really reaches the terminal.

To see only this chapter's 11 tests:

```powershell
npx vitest run chapters/ch20/tests/ch20-full-harness.test.ts chapters/ch20/tests/ch20-entry.test.ts
```

```text
Test Files  2 passed (2)
     Tests  11 passed (11)
  Duration  4.84s
```

`typecheck`, `lint`, `format:check`, and `build` all passed cleanly on my side — `biome lint` and `biome format` each check 1367 files, with `No fixes applied`.

This chapter's tests inject deterministic UUIDs, a UTC clock, and model substitutes. **They do not depend on the real OpenAI and do not depend on the network.** The key assertions of the 7 integration tests are all concrete business results, not "it did not throw":

- **Test 1** (`combines dynamic context, MCP policy, pairing, and resource ownership`): In one turn, the dynamic prompt's `runtime_status` reflects the current MCP connection. The three tool calls in the same reply each receive the result with their own ID. The out-of-bounds write is denied before it reaches approval. After `close()`, `McpRuntime.isClosed === true`.
- **Test 2** (`persists a large MCP result while retaining TODO and DAG state`): One oversized MCP result lands as an artifact (exactly 1 file under `.agent_tutorial/artifacts`, and its content contains the complete original text). At the same time, neither the TODO items' two `status` values nor the DAG's `taskB.blockedBy === [TASK_A]` is lost. The remote `callTool` is called only 1 time.
- **Test 3** (`delivers background and cron completions as typed events exactly once`): A background completion and a Cron firing each deliver once, and `runtime_event` appears exactly once each in the canonical history.
- **Test 4** (`keeps recovery attempts outside canonical history and compacts prompt-too-long once`): After all six model-side failures recover, the canonical history length is still 2. The fragment with `finishReason === "length"` is not inside it. `prompt-too-long` triggered only one compaction.
- **Test 5** (`forces one Stop continuation and then accepts the final model answer`): The Stop hook returns `forceContinue` the first time and continues one turn. The second time, it sees `stopHookActive === true` and lets it pass. The assistant texts are exactly `["intermediate", "final"]`, and `stopCalls === 2` — a forced continuation is not an infinite loop.
- **Test 6** (`rebuilds task, memory, cron outbox, and worktree state without replaying an acked event`): After a **cross-process restart**, the task, memory, cron outbox, and worktree states are all rebuilt from disk, and an already-acked event is not replayed. Note that this relies on the ack records in the store, not on the in-memory deduplication table (Section 9.2 covered this difference).
- **Test 7** (`gates teammate effects before approval and routes the approved claim into its worktree`): The `before-approval.txt` that a teammate wants to write before approval reads as `ENOENT` (the side effect really did not happen). After approval passes, the written `worker.txt` exists only under `binding.relativePath`. The `worker.txt` under the repository root is also `ENOENT` — the claim was routed into the teammate's own worktree, not into the Lead's working directory.

If you also ran the ten hands-on experiments, the 119 lines of output from `probe-ch20.mts` are another way to confirm the assertions above: the tests tell you "whether the result is right", and the probe tells you "what the process looks like".

---

## Chapter Summary

### The three-sentence version

First: putting nineteen chapters of mechanisms into one Agent needs not new function, but **one fixed order and a few invariants that must not be violated**. P20 added only 46 lines of feature code.

Second: **a wrong assembly must explode at startup. It must not wait until runtime.** All seven of `buildAgent`'s gates complete before any state is created, because an Agent in which "all features exist but each holds its own state" is much more dangerous than an Agent that fails to start.

Third: **neither Prompt nor Hook is an authorisation boundary.** `runtime_status` tells the model "what exists now". The permission pipeline decides "what may be done". In the code, these two things should have no intersection.

### Ten points you must remember

1. **Capabilities are accumulated, not copied.** `PROFILE_DELTAS` declares only each chapter's additions. `slice(0, index + 1).flat()` derives the complete profile — "P(N) ⊃ P(N-1)" is from then on a necessary result of the implementation (2.1, 2.2, Experiment 1).
2. **A profile must be a fixed object.** If `profileForChapter(profile.chapter) !== profile`, startup is refused. 26 capability bits theoretically allow 2²⁶ combinations. Only 20 kinds have been tested (2.3, Experiment 1).
3. **Sharing relations are checked by object identity, not by field comparison.** Four groups of "must be the same object" relations (Cron↔background, Teammate↔background/Cron, Protocol↔Teammate, Worktree↔WorkStealing). Get one wrong, and startup fails (3.4, Experiment 2).
4. **One model reply shares one tool snapshot.** In `#prepareModelRequest()`, line 508 renders the prompt and line 516 takes the snapshot, only eight lines apart. So state and tool surface cannot contradict each other. Racing ahead to a new tool in the same turn is necessarily `unknown_tool` (4.1, 5.1, Experiment 4, Experiment 5).
5. **One tool call gets exactly one tool result.** All five deviations are refused: a missing result, an ID mismatch, a message inserted in between, an orphan result, a duplicated fill-back. `validateToolPairing` is called three times in one request, with a different input each time (4.3, 5.2, Experiment 6).
6. **deny is stronger than ask.** `strongestDecision` finds the first hit in the order `["deny","ask","allow"]`, so an out-of-bounds write never reaches the approval step at all — the empty array on Experiment 4's line 10 means exactly this (5.4, 5.5, Experiment 4).
7. **`runtime_status` reads only synchronous getters, is always the last section, and takes part in the cache key.** It is an observation window. It is not a scheduler, and it is not a source of authorisation. When the state changes, the cache necessarily misses, but the stable sections before it do not move by one character (6.1-6.4, Experiment 3).
8. **Three sources, one inbox.** Background, Cron, and teammates all enter the history through the `EventInbox`. Deduplication has two layers: the in-memory `#seenEventIds` prevents redelivery inside a process, and the ack in the store prevents replay across restarts — do not confuse the two layers (9.1-9.3, Experiment 8, Test 6).
9. **The recovery process does not enter the canonical history at all.** 429 / 529 / `length` / `prompt-too-long` are all digested inside the model boundary. After six real failures, the history length is still 2, because `requestMessages` is a local frozen copy (10.1-10.3, Experiment 9).
10. **Close in reverse order. Do not swallow exceptions. Do not half-close.** `[...this.#resources].reverse()`, each resource with its own try/catch, one failure thrown unchanged, multiple failures aggregated into an `AggregateError`, and `#closed = true` set only when everything succeeded (12.1-12.4, Experiment 7).

### One diagram to review the whole chain

```text
  ① Assembly (at startup, before any state is created)    buildAgent(P20, dependencies)
  ────────────────────────────────    ┌──────────────────────────────────┐
                                      │ validateBuildDependencies()       │
                                      │  a. Profile identity                       │
                                      │     profileForChapter(20) === P20?│
                                      │  b. Capability gates × each dependency             │
                                      │     A dependency without its capability → explode               │
                                      │     A capability without its dependency → explode (two-way)        │
                                      │  c. Object identity × four groups of sharing relation          │
                                      │     Cron    ↔ background/inbox    │
                                      │     Teammate↔ background/Cron     │
                                      │     Protocol↔ Teammate            │
                                      │     Worktree↔ WorkStealing        │
                                      │                                   │
                                      │ All pass → install 25 tools + statusProvider│
                                      │ Any one fails → throw, zero side effects         │
                                      └────────────────┬─────────────────┘
                                                       │
  ② One turn (run / runEvents)                        ▼
  ────────────────────────────    ┌──────────────────────────────────────┐
                                  │ #prepareModelRequest()  loop.ts:478   │
                                  │   482  validateToolPairing(#history)  │
                                  │   486  historyProcessor.prepare()     │
                                  │   494  validateToolPairing(request..) │
                                  │   496  turnLifecycle.beforeModel()    │
                                  │   505  toolRoundObserver.beforeModel()│
                                  │   508  Render the system prompt ← runtime_status   │
                                  │   513  validateToolPairing(msgs)      │
                                  │   516  tools = #tools.snapshot()  ←┐  │
                                  │                                   │  │
                                  │   508 and 516 are eight lines apart: state and tool surface ──┘  │
                                  │   necessarily come from the same moment                    │
                                  └────────────────┬─────────────────────┘
                                                   │
  ③ The model boundary (failures are digested here)                      ▼  model.complete()
  ────────────────────────────    ┌──────────────────────────────────────┐
                                  │ 429  ModelRateLimitError             │
                                  │        → Wait per Retry-After and retry      │
                                  │ 529  ModelOverloadedError            │
                                  │        → Accumulate 3 times, then switch to the fallback model     │
                                  │ finishReason === "length"            │
                                  │        → Raise 8000 to 64000, discard the fragment    │
                                  │ ModelPromptTooLongError              │
                                  │        → One reactive compaction               │
                                  │                                      │
                                  │ All act on requestMessages (a local frozen copy) │
                                  │ → The canonical history gains not one entry        │
                                  └────────────────┬─────────────────────┘
                                                   │
  ④ Tool execution (every call passes one by one)                      ▼  tool_calls[]
  ────────────────────────────    ┌──────────────────────────────────────┐
                                  │ snapshot.prepare(name, args)          │
                                  │   Not in the snapshot → unknown_tool (the definition)    │
                                  │ ↓                                    │
                                  │ The permission pipeline strongestDecision            │
                                  │   ["deny", "ask", "allow"] takes the first    │
                                  │   ① Workspace boundary   → If deny, it stops here │
                                  │   ② Shell default                        │
                                  │   ③ request.recommendations           │
                                  │   ④ #evaluateRules                    │
                                  │   ⑤ Only ask asks a person                   │
                                  │ ↓                                    │
                                  │ invoke() → Results are filled back one-to-one by id        │
                                  │   An oversized result → artifact, keep the path         │
                                  └────────────────┬─────────────────────┘
                                                   │
  ⑤ Events (three sources, one inbox)                    ▼  runEvents()
  ────────────────────────────    ┌──────────────────────────────────────┐
                                  │ background ┐                          │
                                  │ Cron       ├→ EventInbox → a user message   │
                                  │ teammate   ┘                          │
                                  │                                      │
                                  │ Two deduplication layers:                             │
                                  │   #seenEventIds  prevents redelivery inside a process          │
                                  │   The ack in the store  prevents replay across restarts         │
                                  └────────────────┬─────────────────────┘
                                                   │
  ⑥ Close (reverse order, no swallowing, no half-close)                      ▼  runner.close()
  ────────────────────────────    ┌──────────────────────────────────────┐
                                  │ [...#resources].reverse()             │
                                  │   mcp → teammate → cron → supervisor │
                                  │                                      │
                                  │ Each resource has its own try/catch, and a failure continues to the end    │
                                  │   1 failure → thrown unchanged                   │
                                  │  >1 failures → AggregateError           │
                                  │                                      │
                                  │ #closed = true is set only when everything succeeded      │
                                  │ After that, run() → AgentRunner is closed    │
                                  └──────────────────────────────────────┘
```

The six numbers are the positions of this chapter's six matters: ① a wrong sharing explodes at startup ② state and tool surface are sampled at the same time ③ failures are digested inside the model boundary ④ deny is stronger than ask, and an out-of-bounds write never reaches approval ⑤ three sources, one inbox, two deduplication layers ⑥ close in reverse order, and do not half-close.

### Check whether you really understood

Do not look at the text above. Try to answer. When you cannot answer, the brackets hold the matching section or experiment:

1. In the whole codebase, how many places read the `full_harness` capability bit? After reading it, what does the code install? (2.1, 6.2)
2. P20 has 26 capability bits. Why does `buildAgent` not allow you to assemble a `{chapter: 20, capabilities: ...}` yourself and pass it in, even if the capability set is completely identical? (2.3, Experiment 1)
3. ch19's `profiles.ts` is 326 lines, and ch20's is 152 lines, with one more capability. Which two boilerplate segments make up the 174 lines that disappeared? After the change to incremental derivation, which error changed from "compiles fine" to "cannot happen"? (From ch19 to ch20)
4. `cronRuntime`'s supervisor and `backgroundSupervisor` are two different objects, but their field values are completely identical. Does startup succeed? Why does the check use identity, not value? (3.4, Experiment 2)
5. You swap in only another `protocolRuntime` (`teammateRuntime` untouched). Which error is reported? What if you swap both together, and they match each other? (3.4, Experiment 2)
6. In one model request, on which line is the system prompt rendered, and on which line is the tool snapshot taken? Why does the distance between these two numbers matter? (4.1, 4.2)
7. `validateToolPairing` is called three times inside `#prepareModelRequest()`. What are the three inputs, respectively? Why can it not be called only once? (4.3)
8. In the same reply, the model first calls `connect_mcp` and then immediately calls `mcp__fake__lookup`. What is the second call's result? What about the next turn? The tool count changes from what to what? (5.1, Experiment 4, Experiment 5)
9. What happens if you call `register()` on a snapshot? What happens if you revoke an MCP tool by name on the live registry? Why must revocation use object identity? (5.1, Experiment 5)
10. The model wants to write a file outside the workspace. The `external` effect and the approval rules are all configured. Will the approval provider be asked? Why? (5.4, 5.5, Experiment 4)
11. `runtime_status` contains `mcp_connections: ["fake"]`. Can the model take this as a basis for believing it has the right to call `mcp__fake__lookup`? Who is the real source of permission facts? (6.4, Experiment 3)
12. You change only `status`, keep every other input the same, and render once more. Does `cacheHits` increase by one? Does the body before `runtime_status` in the prompt change? (6.3, Experiment 3)
13. The Lead has 25 tools. How many built-in tools does a teammate have? Can a teammate see `connect_mcp`? Can the Lead see `submit_plan`? (7.1-7.3, Experiment 10)
14. The same `eventId` is delivered twice. What does `runEvents()` return the second time? How many of those `runtime_event` entries are in the canonical history? (9.2, Experiment 8)
15. After a process restart, what guarantees that an already-processed event is not replayed? Does the in-memory `#seenEventIds` help here? (9.2, Experiment 8, Test 6)
16. On the model side, the code throws six failures in a row: 429, 529×3, `length`, and `prompt-too-long`. How many main requests were sent? How many messages does the final canonical history hold? Is the `length` fragment inside it? (10.1-10.3, Experiment 9)
17. After how many consecutive 529s does it switch to the fallback? After the switch, what is `maxTokens`, and when did it change? (10.1, Experiment 9)
18. The registration order is supervisor → cron → teammate → mcp. What is the close order? Why must it be reversed? (12.1, 12.2, Experiment 7)
19. During `close()`, two resources both throw errors. Will the third resource still be closed? Which exception does the caller receive? What if only one fails? (12.2, Experiment 7)
20. After a `close()` failure, is `#closed` `true` or `false`? What happens if you call `close()` once more? What about `run()`? (12.2, Experiment 7)
21. ch19 has an `mcp-external-approval` rule, and ch20 does not. Is `connect_mcp` still approved now? Which two commands would you use to confirm this? (11.2-11.5)

### Twenty chapters are complete

This chapter taught nothing new. It did another thing: **it put the first nineteen chapters' mechanisms into the same process, and then confirmed that they do not fight each other**.

When each of the nineteen chapters solved one thing on its own, each thing could be explained clearly by itself. Put them together, and the problems change — should the dynamic prompt see the MCP connection state? Through which path does a background task completion notification enter the history? When one resource cannot close, do the remaining resources still close? These problems do not exist at all inside a single chapter.

P20's answer contains no new component. It contains only three things:

- **One fixed execution order**, so every mechanism knows when it is called;
- **Three invariants**, so the interactions between mechanisms have a clear legal/illegal boundary;
- **One set of startup gates**, so a wrong assembly does not live until runtime.

46 lines of new code, plus the 174 lines of boilerplate that `profiles.ts` deleted — the integration chapter's net result in source code is negative. That is not a coincidence. **In an architecture whose design is right, putting the parts together needs no newly written glue.** When a lot of glue is needed, it means the boundaries between the parts were not drawn correctly in the first place.

If you followed from Chapter 1 to here, what you now hold is: an Agent that can call tools, can read and write files, can be governed by permissions, can be intervened in by Hooks, has a TODO list, can dispatch subagents, can load Skills, can persist artifacts, can compact its context, can remember things, has a dynamic prompt, can recover by itself from model jitter, has a task DAG, can run in the background, can run on a schedule, can lead teammates, can go through protocol approval, can have its tasks stolen, can open worktrees, and can connect to MCP. Twenty chapters, one capability per step, and every step guarded by tests.

It is not Claude Code — the places where we simplified are listed clearly in "Differences from Claude Code". But it is an Agent that **you have read completely, and where you know why every line is there**. That will take you further than using a stronger framework whose insides you cannot see.
