You ask the Agent to do a proper job: "Install the dependencies, then run the tests, and read the README while you are at it and tell me how to start it."

It obeys. Its first step calls `shell` to run `npm install`.

Then you stare at the screen for two minutes.

Nothing happens. The README is right there, a file that takes a few milliseconds to read, but nobody reads it. The Agent is stuck on an `await`. The whole Loop stops on that one line and waits for a subprocess that has nothing to do with reading the README to exit.

The problem is not "installing dependencies is slow" — installing dependencies is slow, that is a fact, and you cannot change it. The problem is that **the Agent did nothing at all during those two minutes**. It clearly had other work it could do, and that work had nothing to do with the thing it was waiting for.

The Task DAG in Chapter 12 can already answer "what can be done": which tasks are ready, who has claimed them, and whether their dependencies are satisfied. But it cannot answer "how it gets done" — claim a task and run a five-minute build, and those five minutes are still dead waiting. A DAG describes work; it does not execute work.

Chapter 13 adds exactly that layer. After a tool call passes argument validation, Hooks, permissions, and approval, the call can **return a placeholder result first**, so the current tool-call round closes immediately. The real result returns later to **the same Agent Loop** as a **typed runtime event**.

This chapter adds one capability only. The capability has four parts: **one three-state parameter, one managed Supervisor, one typed event queue, and one persisted job state store**.

First, fix the scope. This chapter moves only **the `shell` tool of the P13 lead Agent** into the background. Cron scheduling, resident teammates, background subagents, streaming output to files, and an interactive prompt watchdog are all outside this chapter.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaH4Zqoiaq4aic9xLYRuBgoXAhdFktyVoEb5CicLwQfv2ya5HBsZPfqsDfDyOGaGDNOcWyqj5iaF7rPcTwbZhn3yu8LM9YhDeWfK9BM/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you will be able to do after this chapter

1. Explain why `run_in_background` is **three-state** (`true` / `false` / `null`) and not a boolean, and who receives the decision right in each state.
2. Explain why a background submission must come after the permission decision, and name the specific race that an early submission leaves behind.
3. Describe the role of the placeholder result: what it closes, what it does not promise, and why it cannot be an error result.
4. Name the six states of a background job, and name the places that enforce the invariant "`running` has no result, and every terminal state must have a result".
5. Explain why a completion event is published exactly once — even when completion, timeout, and cancellation reach the finish line at the same time.
6. Explain why an event must be a typed object and not a plain dictionary, and name the line where inserting a dictionary fails.
7. Describe the full path of a background result back into the Loop, and state the `role` of that message in the history and why it is not `tool`.
8. Judge what happens when the user presses `Ctrl+C` halfway through a background command: what state the job on disk has at the next start, and whether it runs again.

### What you need first

| Prerequisite | From which chapter | How this chapter uses it |
| --- | --- | --- |
| One turn of the Agent Loop: model -> tool -> result backfill | Chapter 1 | Background execution changes only "who waits for the result"; this chain does not move |
| `ToolDefinition` / `ToolRegistry` / Zod schema | Chapter 2 | The three-state parameter and the two new tools rely on `.strictObject()` to guard the boundary |
| OpenAI tool messages must pair strictly | Chapters 1, 2 | **The most important prerequisite in this chapter**; the placeholder result exists because of it |
| The position of the `PermissionPolicy` decision | Chapter 3 | The background submission must come after it; one section covers this topic |
| The order of the Pre/PostToolUse Hooks | Chapter 4 | Background execution does not change the Hook order; it changes only the step in the middle |
| File lock + atomic replace + fail-closed | Chapter 12 | The background job persistence uses the same discipline directly |
| Profile capability bits and injection by the composition root | Chapters 5–12 | P13 connects the whole background runtime with one `background` capability bit |

If you have time to review one chapter only, review the part of Chapter 1 that says "a single assistant message must return one `tool` message for each entry in `tool_calls`". The whole reason for the placeholder result design is that protocol constraint.

### Quick glossary (terms that first appear in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| Background job | **One approved execution attempt**. It has an independent lifecycle and persists across processes |
| Three-state parameter | The three values `true` / `false` / `null` each represent one decision owner; the parameter is not a boolean |
| `concurrency` | A concurrency declaration on a tool definition. Only `background_eligible` can enter the background |
| Slow-command heuristic | A keyword table. It acts as a fallback only when the model does not state a choice (`null`). It does not predict the run time of an arbitrary command |
| Placeholder result | A normal successful `ToolResult` that the system returns immediately after a successful background submission. It carries only `job_id` and `running` |
| `BackgroundDispatcher` | The dispatcher. It decides whether this call runs synchronously or in the background. It makes no permission decision itself |
| `JobSupervisor` | The **single owner** of background workers. It manages capacity, timeout, cancellation, shutdown, and event publication |
| `RuntimeEvent` | The **only interface** through which an external asynchronous result enters the Loop. It must provide `eventId` and `toPayload()` |
| `EventInbox` | A FIFO queue for typed events. It accepts only objects that implement `RuntimeEvent` |
| Event pump (`RuntimeEventPump`) | The abstraction that the Loop side sees: drain a batch, wait if necessary, then acknowledge |
| Conditional transition | An atomic write with the rule "write the terminal state only if the disk state is still `running`". The losing side returns `undefined` |
| Terminal state | The five states `completed` / `failed` / `timed_out` / `cancelled` / `interrupted` |
| `interrupted` | A `running` state that a previous abnormal process exit left behind. The next start transitions it to this state |
| Batch position | The `{ index, total }` value attached when the system injects an event. It tells the model the position of this event in the batch |

### Suggested reading route

```text
Chapter Guide (you are here)
  ↓
① Look at the full trace of one background call first   ← Look at the seven messages directly, not at abstractions first
  ↓
② Separate the three kinds of "waiting"             ← Fix the concepts first, or every later section becomes confusion
  ↓
③ The three-state parameter and the two gates              ← Who decides whether a call enters the background
  ↓
④ Why the submission must come after permissions      ← The most important order constraint in this chapter
  ↓
⑤ The placeholder result: it closes the round without lying        ← How the protocol pairing survives
  ↓
⑥ Six states and one invariant          ← The job lifecycle and its enforcement points
  ↓
⑦ The Supervisor is the single owner       ← Capacity, timeout, cancellation, shutdown
  ↓
⑧ Publish exactly once: the conditional transition            ← What happens when three paths race to the finish line
  ↓
⑨ How an event returns to the same Loop       ← typed-only, batching, deduplication, role=user
  ↓
⑩ The two tools for query and cancellation            ← The means by which the model checks progress itself
  ↓
⑪ After a crash: interrupted         ← A restart does not replay
  ↓
⑫ Connect it to the composition root                    ← The capability bit, 15 tools, the subagent boundary
  ↓
⑬ Run it + seven experiments + troubleshooting        ← Verify every conclusion above by hand
```

---

## Look at the full trace of one background call first

Do not discuss the design yet. Look at the result directly.

The trace below comes from a real run. The model issued two tool calls in **one assistant message** — one background `npm install`, and one `read_file` that takes a few milliseconds. I printed every message in the canonical history:

```text
Model requests = 3

 1. user      Install dependencies in the background, and read the README at the same time
 2. assistant calls=[shell#slow-call, read_file#fast-call]  content=(null)
 3. tool      [tool_call_id=slow-call] {"job_id":"...0301","status":"running","tool_name":"shell"}
 4. tool      [tool_call_id=fast-call] # demo readme
 5. assistant calls=[] content="Background install submitted. README read. Waiting for the install result."
 6. user      {"runtime_event":{"event_id":"...0302","job_id":"...0301","kind":"background_job",
              "result":{"content":"404 passed","error_code":null,"is_error":false},
              "source_tool_call_id":"slow-call","status":"completed","tool_name":"shell"},
              "batch":{"index":0,"total":1}}
 7. assistant calls=[] content="Install complete: 404 passed."

finalText = Install complete: 404 passed.
turns     = 3
```

(Message 6 is actually one compact line of JSON. The line breaks here only make the structure easier to read.)

Seven messages, three model requests. Look at them one by one. Each message answers one design question.

> The "three" here is the request count of the Loop's main turns, that is, `RunResult.turns`. If you attach a counter to `ModelClient.complete()` and reproduce this trace yourself, you will count **4** requests. The extra request is the memory extraction side query from Chapter 9 (its `tools` list is empty, and its `system` prompt is "Extract new memories that deserve to persist across sessions from the conversation"). It has nothing to do with background tasks. P13 simply inherits the Chapter 9 capability as well.

**Message 3 is the core of this chapter.** The `tool_call_id` named `slow-call` receives a `tool` message immediately. The content is a placeholder JSON value. Note that its `status` is `running` — the command is still running at this moment. But this turn is **already closed** at the protocol level.

**Message 4 proves that background execution is useful.** `read_file` executes and completes right after it. If `shell` ran synchronously, message 4 would appear only after `npm install` completed in full. Now it does not wait.

**Message 5 is the model's intermediate answer.** In this turn the model calls no tool and only says one sentence. In Chapter 12, the Loop would `return` at this point — the model gives the final text and the turn ends. But the turn does not end here.

**Message 6 is the new part.** Its `role` is **`user`**, not `tool`. The background command has completed, and the system injects the result as a runtime event. The later section "How an event returns to the same Loop" explains why the role is `user` and not `tool` — this is a protocol boundary that allows no compromise.

**Message 7 is the real final answer.** The model sees the real output `404 passed` and only then gives its conclusion.

For comparison, if `shell` runs synchronously, the trace of the same four actions looks like this:

```text
 1. user      Install dependencies in the background, and read the README at the same time
 2. assistant calls=[shell#slow-call, read_file#fast-call]
    ⏳ Stuck here for two minutes —— nothing of fast-call executes before npm install completes
 3. tool      [tool_call_id=slow-call] 404 passed
 4. tool      [tool_call_id=fast-call] # demo readme
 5. assistant Install complete. The README says to start it with npm start.
```

The trace has two fewer messages and even looks simpler. **But the process idles during the two minutes between message 2 and message 3.** `fast-call` stands behind `slow-call`. It has no reason to wait, but it must wait — because `for (const call of assistant.toolCalls)` is a serial loop. The next call does not start until the previous `await` returns.

This is the whole problem that this chapter solves: **separate "who waits for the result" from "who occupies the Loop"**.

### The division of work across the three model requests

Look at the three requests again. Note the last message that the model sees in each request:

| Request | Last message the model sees | Model reaction |
| --- | --- | --- |
| 1 | `user`: Install dependencies in the background, and read the README at the same time | Issues two tool calls |
| 2 | `tool`: `{"status":"running",...}` | Knows the background submission succeeded, gives an intermediate answer first |
| 3 | `user`: `{"runtime_event":...,"status":"completed"}` | Receives the real output, gives the final answer |

What happened between request 2 and request 3? After the Loop received "an assistant message with no tool calls" in request 2, it **did not return immediately**. It asked one question first: is there any background job that has not yet closed? If yes, it waits for that job.

This "wait" is the only active blocking point in this chapter, and it happens only when **the model has nothing left to do**. This position is deliberate. A later section expands on it.

---

## Separate the three kinds of "waiting"

You must separate three concepts before you enter the implementation, or every later section ties itself in knots. In daily speech, all three are called a "task" or "waiting", but in code they are three completely different objects.

| | TODO (Chapter 5) | Project Task (Chapter 12) | Background job (this chapter) |
| --- | --- | --- | --- |
| What it is | A step list inside a session | A work unit that a user can claim across sessions | **One approved execution attempt** |
| How long it lives | One session; it disappears when the process exits | Across processes and sessions; it exists on disk | One execution, but the state persists |
| Who changes it | The model overwrites the whole table | The claimant advances the state in one direction | **Only the Supervisor** |
| States | `pending` / `in_progress` / `completed` | Same as the left column, three states | **Six**, see below |
| Who waits for it | Nobody waits; it is only a reminder | The claimant itself | **Nobody waits in a blocking way** |
| Where it is stored | In memory | `.agent_tutorial/.tasks/` | `.agent_tutorial/background/` |

The three do not connect to each other, and they must not connect. The easiest mistake is to treat a background job as "a fourth state of a Task" — for example, to add a `running` state to a Task that means "currently running in the background".

**Why must you not do that?** Because one Task can correspond to zero, one, or many execution attempts. You claim the task "run the tests". The first run times out. You change the configuration and run it again. That is two background jobs and one Task. If you press execution attempts into the Task state machine, you compress "how many times did we run it" into "what state is it in now", and the information disappears.

The reverse also holds: a completed background job does not mean a completed Task. `npm test` runs to completion and the exit code is 1, so the job state is `failed` — but the model must judge, after it sees the result, whether this Task deserves the `completed` mark. The Supervisor cannot make that decision for the model.

**Remember the division of work in one sentence**: the Task says "this work must be done", and the background job says "how did this execution go".

One finer distinction relates directly to the implementation in this chapter:

```text
Two meanings of "waiting"

Meaning A: Who needs this result?
  → The model. It must see the npm install output sooner or later.
     Nobody can remove this "wait". A result that does not exist does not exist.

Meaning B: Who occupies the execution flow?
  → This chapter removes exactly this one.
     await shell(...) occupies the Loop. That is an implementation choice, not a necessity.
```

Background execution changes meaning B only. It does not change meaning A at all. The model loses none of the results that it must see. Only **the time at which it sees them** changes, from "the `tool` message of the same turn" to "the runtime event of a later turn".

---

## The three-state parameter and the two gates

### Only the shell of the P13 lead Agent changed

First look at a fact that is easy to miss: the `run_in_background` parameter is **not added globally**.

The two schemas below come from real probes, placed side by side for comparison:

```json
// The shell of the P13 lead Agent
{
  "name": "shell",
  "description": "Run a PowerShell command in the current workspace.",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "minLength": 1 },
      "run_in_background": {
        "default": null,
        "anyOf": [{ "type": "boolean" }, { "type": "null" }]
      }
    },
    "required": ["command", "run_in_background"],
    "additionalProperties": false
  }
}
```

```json
// P12 (and P01-P12, and every one-shot subagent) shell
{
  "name": "shell",
  "description": "Run a PowerShell command in the current workspace.",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "minLength": 1 }
    },
    "required": ["command"],
    "additionalProperties": false
  }
}
```

Same tool name, same description, same handler, **but the model sees different parameters**. One constructor parameter implements this:

```ts
// Strict object rejects extraneous fields, ensuring tool contracts match the JSON Schema seen by the model.
const shellInputSchema = z.strictObject({ command: z.string().min(1) });
// Only the shell of the main Agent in P13 adds the tri-state parameter run_in_background; other chapters and subagents use single-field schema.
const backgroundShellInputSchema = z.strictObject({
  command: z.string().min(1),
  run_in_background: z.boolean().nullable().optional().default(null),
});

export function createShellTool(
  commandRunner: CommandRunner,
  background = false,
): ToolDefinition<{ command: string; run_in_background?: boolean | null }> {
  return {
    name: "shell",
    description: "Run a PowerShell command in the current workspace.",
    inputSchema: background ? backgroundShellInputSchema : shellInputSchema,
    effect: "execute",
    ...(background ? { concurrency: "background_eligible" as const } : {}),
    handler: async ({ command }, context) => {
      // The handler knows nothing about background execution. It only runs the command.
    },
  };
}
```

Note that the `handler` contains **no background logic at all**. It receives a `command` and runs it, then returns a `ToolResult`. Background execution happens outside the handler — this is the key that keeps this chapter simple: **the code that runs in the background does not itself need any change**.

The `additionalProperties: false` line appears on both sides, and measurements confirm its effect:

```text
P12 shell receives run_in_background   -> invalid_arguments
read_file receives run_in_background   -> invalid_arguments
P13 shell omits run_in_background   -> passes, normalises to {"command":"npm install","run_in_background":null}
```

The first line is capability isolation: even if the P12 model guesses this parameter name from memory, the call cannot enter. The second line is horizontal isolation: in P13, `read_file` does not accept this parameter either. The third line shows `.default(null)` at work — an omitted value equals an explicit `null`, so downstream code always receives one of the three states and never handles `undefined`.

### The three states: each state represents one decision owner

`run_in_background` has three values. Their difference is not "true / false / not filled in". Their difference is **who holds the decision right**:

| Value | Decision owner | Meaning |
| --- | --- | --- |
| `true` | The model | "I want it in the background" — even if the command returns instantly |
| `false` | The model | "I want to wait synchronously" — even if the command matches a slow-command keyword |
| `null` / omitted | The runtime | "I state no choice. You decide by the rules" |

The decision function must **distinguish an explicit boolean value first**, and only then consider the heuristic:

```ts
// Determine whether shell calls run in the background: explicit booleans take priority, fallback to keyword heuristics when omitted.
export function shouldRunInBackground(input: BackgroundShellInput): boolean {
  // Explicit booleans take precedence; use deterministic keyword heuristics only when omitted, without predicting arbitrary command durations.
  if (input.run_in_background !== undefined && input.run_in_background !== null) {
    return input.run_in_background;
  }
  const command = input.command.toLowerCase();
  return BACKGROUND_MARKERS.some((marker) => command.includes(marker));
}
```

That `!== undefined && !== null` looks verbose, but `if (input.run_in_background)` would be wrong: `false` would fall through into the heuristic as "no choice stated", so an `npm install` that the model explicitly asked to run synchronously would enter the background instead — **exactly the opposite of the intended semantics**.

The keyword table has seven entries only. The table is hard-coded and has no configuration item:

```ts
// Allowlist of keywords for long-running commands; when run_in_background is not explicitly specified, Dispatcher uses this to decide whether to run in background.
const BACKGROUND_MARKERS = Object.freeze([
  "cargo build",
  "compile",
  "deploy",
  "docker build",
  "npm install",
  "pip install",
  "pytest",
]);
```

### The real coverage of the heuristic (including what it misses)

This table comes from runs, not from reasoning:

```text
{"command":"npm install"}                              -> true
{"command":"NPM Install openai"}                       -> true    ← toLowerCase takes effect
{"command":"pytest -q"}                                -> true
{"command":"Get-ChildItem"}                            -> false
{"command":"npm ci"}                                   -> false   ← missed
{"command":"npm test"}                                 -> false   ← missed
{"command":"Write-Output hi","run_in_background":true}  -> true    ← explicit override
{"command":"npm install","run_in_background":false}     -> false   ← explicit override
{"command":"npm install","run_in_background":null}      -> true    ← only now does the heuristic apply
```

**The table misses both `npm ci` and `npm test`.** This is not a bug. It is the honest part of this design: **a keyword table cannot predict the run time of an arbitrary command**. `npm test` can take 0.5 seconds or 20 minutes. The command text does not reveal which.

Then why keep the table at all? Because it is a **deterministic fallback**. The same input always produces the same decision. The decision is testable and explainable, and it needs no cooperation from the model. For a slow command that truly belongs in the background, the correct action is an explicit `run_in_background: true` from the model — the heuristic only rescues the most typical few commands when the model forgets to state a choice.

State the trade-off clearly. The other path lets the runtime "judge intelligently", for example by running the command for 500 ms to see whether it ends, or by consulting historical run-time statistics. That path needs three new things: timing, sampling, and history storage. Its decisions are also unstable — the same command runs synchronously this time and in the background next time, so a problem cannot be reproduced. **This chapter chooses "simple but deterministic".**

### Two gates; a call needs both

For a call to truly enter the background, it must pass **both** gates at the same time:

```text
Gate 1: definition.concurrency === "background_eligible"
      ↓ not satisfied → tools.invoke(), synchronous execution, done
Gate 2: shouldRunInBackground(arguments) === true
      ↓ not satisfied → tools.invoke(), synchronous execution, done
      ↓ both satisfied
   supervisor.submit(...)
```

The code has exactly this shape:

```ts
async dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
  const definition = prepared.definition;
  const argumentsValue = prepared.arguments;
  if (definition === undefined || argumentsValue === undefined || prepared.error !== undefined) {
    throw new Error("BackgroundDispatcher received an invalid prepared call");
  }
  // Gate 1: a tool that does not explicitly declare background support always executes directly.
  if (definition.concurrency !== "background_eligible") {
    return await this.#tools.invoke(prepared, context);
  }
  if (!isBackgroundShellInput(argumentsValue)) {
    return toolError(
      "background_contract_error",
      "Background-eligible tool used an unsupported input model",
    );
  }
  // Gate 2: if the three-state decision says no background, the call also executes directly.
  if (!shouldRunInBackground(argumentsValue)) {
    return await this.#tools.invoke(prepared, context);
  }
  // Both gates passed. Only now does the dispatcher submit.
  ...
}
```

The value of gate 1 **freezes at registration time**. Runtime code cannot change it:

```ts
const stored: StoredToolDefinition = Object.freeze({
  ...
  // Undeclared tools execute synchronously to prevent silent diffusion of background capabilities.
  concurrency: definition.concurrency === undefined ? "inline" : definition.concurrency,
  ...
});
```

The default is `inline`. This default is a deliberate choice: **a new tool cannot run in the background by default**. A tool that wants the background capability must declare it explicitly. Measured `concurrency` values for three tools:

```text
P13 shell.concurrency     = background_eligible
P12 shell.concurrency     = inline
P13 read_file.concurrency = inline
```

Why can gate 1 not be omitted? If the dispatcher looked only at the parameter and not at the tool declaration, any tool could enter the background as long as its arguments carried `run_in_background: true`. But most tool handlers have no design for "return later" at all — after `write_file` ran in the background, the model would receive the placeholder result, believe the write had completed, and then read that file and get the old content. **Gate 1 keeps the decision "which tools may run in the background" in the code, not in a model parameter.**

---

## Why the submission must come after permissions

### The full order of one tool execution

Background dispatch sits inside `#executeTool`, so look at the full skeleton of that method first. This code is in `core/loop.ts:430`:

```ts
async #executeTool(call: ToolCall, context: ToolContext, tools: ToolRegistry): Promise<ToolExecution> {
  // 1. Parse and validate the arguments; on failure, return directly and enter no later stage
  let prepared: PreparedToolCall;
  try {
    prepared = tools.prepare(call);
  } catch {
    return execution(toolError("tool_preparation_error", "Tool preparation failed"));
  }
  if (prepared.error !== undefined) {
    return execution(prepared.error);
  }

  // 2. The PreToolUse hook can rewrite the input or block the call directly
  let preHook: HookResult;
  try {
    preHook = await this.#hooks.runPreTool(prepared);
  } catch (error) { ... }
  const effective = preHook.updatedInput === undefined ? prepared : preHook.updatedInput;
  if (preHook.blockingError !== undefined) {
    return execution(preHook.blockingError, preHook.additionalContext);
  }

  // 3. Permission decision
  if (this.#permissionPolicy !== undefined) {
    const decision = await this.#permissionPolicy.decide(
      new PermissionRequest({ prepared: effective, context, recommendations: hookRecommendations(preHook) }),
    );
    if (!decision.isAllowed) {
      return execution(decision.toToolResult(), preHook.additionalContext);
    }
  }

  // 4. Execution happens here —— background dispatch inserts at this step
  result =
    this.#toolDispatcher === undefined
      ? await tools.invoke(effective, context)
      : await this.#toolDispatcher.dispatch(effective, context);

  // 5. PostToolUse hook
  ...
}
```

Four checkpoints, and `dispatch` stands last. **This order is not arbitrary.**

Note that step 3 uses `effective` — if a PreToolUse hook rewrote the input, the permission decision and the actual execution both see the **rewritten** arguments. A hook cannot bypass permissions. It can only submit recommendations (`hookRecommendations`), and the final decision right always stays with `PermissionPolicy`.

### On a denial, the disk must be clean

Look at a measurement first. Use a `PermissionPolicy` that always denies, and let the model call an `npm install` that matches the heuristic:

```text
tool message   = Error [permission_denied]: probe deny
persisted jobs = 0
commandRunner  = 0 calls
```

All three zeros matter:

- **`persisted jobs = 0`**: the `.agent_tutorial/background/` directory contains no file. No `cancelled` job exists, and no "created then deleted" job exists either. **A denied call does not exist at all in the job history.**
- **`commandRunner = 0`**: not one character of `npm install` executed.
- **The tool message is a standard `permission_denied`**: it matches the synchronous path exactly. The model cannot tell that this call "originally planned to enter the background" — it only knows the call was denied.

In passing, that error text comes from `PermissionDecision.toToolResult()`:

```ts
toToolResult(): ToolResult {
  if (this.behavior !== "deny") {
    throw new PermissionContractError("only a final deny decision can become a tool result");
  }
  return toolError("permission_denied", this.reason);
}
```

Only `deny` can become a `ToolResult`. An `allow` that tries to become a tool result throws an error directly — this refuses, at the type level, to "disguise an approval as a result".

What happens if you reverse the order and submit first and judge permissions afterwards:

```text
Wrong order: submit() → permission decision → deny

t=0ms    Create the job record, state running, write it to disk
t=0ms    The Supervisor registers a worker, npm install starts to download
t=1ms    The permission decision returns deny
t=1ms    ??? What now
```

At `t=1ms` it is already too late. The command is running, the process is using the network, and the disk holds a `running` record. You now have three choices, and all of them are bad:

| Remedy | Problem |
| --- | --- |
| Call `cancel()` | Race: the command may already have completed, so `cancel` receives a `background_job_state` error; and `npm install` has already changed `node_modules` |
| Delete the job file directly | A hole appears in the job history and the audit breaks; the worker still runs, and at close time it writes back an id that was just deleted |
| Leave a `cancelled` record | An operation that permissions denied looks, in the history, like a normal operation that someone cancelled; the two events become confused |

**No remedy returns to "nothing happened".** This is why the order cannot rely on "fix it after an error" — it must be correct from the start.

### A more general rule

This rule applies to more than background tasks:

```text
For every operation that, once it starts, cannot be fully revoked,
its authorisation check must complete before it starts,
not as a remedy after it starts.
```

Starting a worker cannot be revoked (the network request has already left). Writing a `running` record can be half revoked (you can delete it, but the deletion leaves an inconsistency). The two together are fully irrevocable. So the order of the four checkpoints is: **every decision that can deny comes before every action that cannot be revoked.**

This also explains why `#executeTool` returns a `ToolExecution` and not a bare `ToolResult` — besides the result itself, it must carry the `additionalContext` that the hooks produced, and the Loop appends that content to the history separately.

---

## The placeholder result: it closes the round without lying

### A design that the protocol forces

The OpenAI message protocol has one hard rule:

```text
One assistant message contains N tool_calls
  ↓
Before the next request, exactly N tool messages must exist
  ↓
The tool_call_id of each tool message must match one of them
  ↓
One missing / one extra / an id mismatch → 400, the request cannot be sent at all
```

Now place background execution inside this rule: `shell` enters the background and the command runs for two minutes, but the next model request must go out now. **Where does that `tool` message come from?**

Three choices:

| Option | Result |
| --- | --- |
| Send no tool message | 400. The protocol does not allow it. |
| Wait for the command to complete, then send it | Then there is no background execution; the call is synchronous again. |
| **Send one now that states "submitted"** | The choice of this chapter. |

The implementation of the third option has one core part:

```ts
try {
  const jobId = await this.#supervisor.submit({
    sourceToolCallId: prepared.call.id,
    toolName: definition.name,
    operation: async () => await this.#tools.invoke(prepared, context),
  });
  // The placeholder result is a normal ToolResult that closes the current tool turn; EventInbox injects the real result later.
  return toolSuccess(
    JSON.stringify({
      job_id: jobId,
      status: BackgroundJobStatus.RUNNING,
      tool_name: definition.name,
    }),
  );
} catch (error) {
  if (error instanceof BackgroundError) {
    return toolError(error.errorCode, error.message);
  }
  throw error;
}
```

That `catch` handles a failure of the submission itself: the capacity is full, or the Supervisor is already closed. These failures are subclasses of `BackgroundError`, they carry a stable `errorCode`, and the code converts them directly into a `ToolResult` for the model. An exception that is not a `BackgroundError` continues to propagate upward — **that means a bug in the code, and a bug must not be disguised as a tool error.**

The model sees exactly that message:

```json
{"job_id":"00000000-0000-4000-8000-000000000301","status":"running","tool_name":"shell"}
```

### The difference between "closing" and "lying"

One point here is easy to get wrong. The placeholder result **must be honest**.

Compare the two styles:

```json
// ❌ Lying: the model believes the command completed and succeeded
{"stdout":"","exit_code":0}

// ❌ Another form of lying: an empty result that looks like success
""

// ✅ Honest: states clearly that this is running, and gives a job_id for queries
{"job_id":"...0301","status":"running","tool_name":"shell"}
```

The first two styles also close the protocol, but they tell the model "this work is done". The model continues on that assumption — for example, it goes and reads a file inside `node_modules`. The third style closes the protocol and tells the model clearly: **this work is running, the result has not arrived yet, and you can query it with this id.**

The `status: "running"` field is the most important part of this JSON value. It corresponds exactly to the **single active state** among the six states — a `running` record truly exists on disk at this moment, so the two statements say the same thing.

### Why it is `toolSuccess` and not `toolError`

The placeholder result uses `toolSuccess`, so `isError` is `false`. Someone may think `toolError` is correct — after all, nobody has the result yet.

That is wrong. `isError` answers the question "**did this tool call itself have a problem**", not "did the task succeed". The background submission itself succeeded: the system created the job, started the worker, and returned the id. The real execution result arrives separately later, and only then does an `isError` value exist to discuss.

This distinction appears again later: for a `failed` job (the command exit code is not 0), its `result.isError` is `true`; but the placeholder result that submitted it still has `isError` equal to `false`. **Two results, two meanings, no conflict.**

---

## Six states and one invariant

### One active state, five terminal states

The state machine of a background job has one level only. It has no nesting and no substates:

```text
                    ┌──────────────┐
     submit() ────► │   running    │  ← the only active state
                    └──────┬───────┘
                           │
     ┌─────────┬───────────┼───────────┬─────────────┐
     ▼         ▼           ▼           ▼             ▼
 completed  failed    timed_out   cancelled    interrupted
     │         │           │           │             │
     └─────────┴───────────┴───────────┴─────────────┘
                  Five terminal states. Once a job enters one, it never leaves.
```

```ts
// Six background job states: running is the only active state, and the rest are terminal states; Supervisor and store jointly guarantee state transitions.
export const BackgroundJobStatus = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
} as const);
```

Each of the five terminal states corresponds to one clear reason:

| State | When the job enters it | error_code |
| --- | --- | --- |
| `completed` | Execution returns a result with `isError === false` | `null` |
| `failed` | Execution returns a result with `isError === true` | Preserved as-is, for example `shell_failed` |
| `failed` | The execution function itself throws an exception | `background_execution_error` |
| `failed` | Execution returns something that is not a `ToolResult` | `background_contract_error` |
| `timed_out` | More than 120 seconds | `background_timeout` |
| `cancelled` | `cancel_background_job` arrives | `background_cancelled` |
| `interrupted` | The process crashed; the next start discovers it | `background_interrupted` |

Note that `failed` occupies three rows. **"The command ran and failed", "the code threw an exception", and "the contract was violated" all have state `failed`. The `error_code` distinguishes them.** This is a deliberate trade-off: the state machine stays at six values and does not grow; the error code carries the fine-grained reason.

Why divide the reasons this finely? Because **the model's next action depends on the reason**. `failed` means the command ran but its exit code was wrong, so the model should read stderr. `timed_out` means the command may be fine but slow, so the model should consider a split or a longer timeout. `cancelled` means someone stopped it on purpose, so the model must not retry it. `interrupted` is an environment problem, so a retry is reasonable. **If all five collapse into one `failed`, the model can only guess.**

### Eight invariants that the constructor validates

The `BackgroundJob` constructor accepts no inconsistent combination:

```ts
constructor(options: BackgroundJobOptions) {
  this.id = canonicalBackgroundId(options.id);
  if (typeof options.sourceToolCallId !== "string" || options.sourceToolCallId.trim().length === 0) {
    throw new BackgroundStorageError("background source tool call id must not be empty");
  }
  if (typeof options.toolName !== "string" || options.toolName.trim().length === 0) {
    throw new BackgroundStorageError("background tool name must not be empty");
  }
  if (!isBackgroundJobStatus(options.status)) {
    throw new BackgroundStorageError("background job status is invalid");
  }
  if (options.status === BackgroundJobStatus.RUNNING) {
    if (options.result !== null) {
      throw new BackgroundStorageError("running background job cannot have a result");
    }
  } else {
    if (!isToolResult(options.result)) {
      throw new BackgroundStorageError("terminal background job requires a result");
    }
    if (options.status === BackgroundJobStatus.COMPLETED && options.result.isError) {
      throw new BackgroundStorageError("completed background job requires a successful result");
    }
    if (options.status !== BackgroundJobStatus.COMPLETED && !options.result.isError) {
      throw new BackgroundStorageError("non-completed background job requires an error result");
    }
  }
  this.sourceToolCallId = options.sourceToolCallId;
  this.toolName = options.toolName;
  this.status = options.status;
  this.result = options.result;
  Object.freeze(this);
}
```

View the eight constraints as a table. The right side of each row is the original error message that a real constructor run produced:

| Invariant | Example violation | Message thrown |
| --- | --- | --- |
| The id must be a canonical lowercase UUID | `A1B2C3D4-...` | `background id must be a canonical UUID` |
| `sourceToolCallId` is not empty | `""` or `"   "` | `background source tool call id must not be empty` |
| `toolName` is not empty | `""` | `background tool name must not be empty` |
| `status` must be one of the six literals | `"pending"` | `background job status is invalid` |
| `running` ⇒ `result === null` | `{status:"running", result:{...}}` | `running background job cannot have a result` |
| Terminal state ⇒ `isToolResult(result)` | `{status:"failed", result:null}` | `terminal background job requires a result` |
| `completed` ⇒ `!result.isError` | `{status:"completed", result:{isError:true}}` | `completed background job requires a successful result` |
| Non-`completed` ⇒ `result.isError` | `{status:"failed", result:{isError:false}}` | `non-completed background job requires an error result` |

The last two rows form a pair. They guarantee that **state and result never contradict each other**: no "succeeded but carries an error" exists, and no "failed but the result is a success" exists either.

The `Object.freeze(this)` at the end makes the instance immutable. To change the state, the code constructs a new instance; it cannot modify a field in place. This follows the same idea as the Chapter 12 Task handling: **an immutable object has no "intermediate state"; what you read is always complete.**

---

## The Supervisor is the single owner

### No bare Promises

This chapter has one hard rule: **the code must not contain "start a Promise and then ignore it"**.

The negative example looks like this:

```ts
// ❌ Never write code like this
void runCommand(command);            // Who waits for it?
someAsyncThing().catch(() => {});    // The error is swallowed, and nobody manages the timeout
setTimeout(() => doWork(), 0);       // Where is it when the process exits?
```

All three lines "make the code run", but each creates an **orphan coroutine**: nobody knows it exists, nobody knows when it ends, nobody waits for it when the process exits, and nobody catches its exception. In tests this shows up as random failures. In production it shows up as "half of the execution records are in the logs".

The positive approach is `#track()`. Every worker passes through it:

```ts
// Add worker Promises to managed sets; cancellation signals do not leak as unhandled rejections.
#track(operation: Promise<void>): Promise<void> {
  const tracked = operation.then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof CancellationSignalError)) {
        throw error;
      }
    },
  );
  this.#managedTasks.add(tracked);
  void tracked.then(
    () => this.#managedTasks.delete(tracked),
    () => this.#managedTasks.delete(tracked),
  );
  return tracked;
}
```

Three things happen here, and each corresponds to one specific trap:

**① It swallows only `CancellationSignalError`; everything else still throws.** Cancellation is expected behavior, and it must not make Node print `UnhandledPromiseRejection`. But a real bug must surface. The code distinguishes by type instead of using `.catch(() => {})` for everything.

**② It adds the Promise to `#managedTasks`, so `close()` knows whom to wait for.** Without this step, `close()` can only guess.

**③ At the end it deletes the Promise from the set, on success and on failure.** That `void tracked.then(delete, delete)` writes the deletion in both branches — if deletion happened only in the success branch, a failed worker would stay in the set forever, and `close()` would wait for it every time and always time out.

Note that step ③ uses `void`. This is the only place that "deliberately does not wait". It is reasonable because this Promise only performs cleanup, produces no result, and step ① already handled its errors. **"Not waiting" needs a reason; it cannot be the default behavior.**

The `JobSupervisor` exists to take over this work. It is four roles at the same time:

```text
┌─────────────────────── JobSupervisor ───────────────────────┐
│                                                              │
│  ① The single submission entry     submit()                                │
│     Capacity limit 4; when full, it throws background_capacity                    │
│                                                              │
│  ② The single state writer   #finish() → store.finishRunning()       │
│     The Dispatcher, the tools, and the Loop never write the store directly                    │
│                                                              │
│  ③ The single coroutine holder   #track() records every in-flight promise      │
│     One AbortController + one 120s timer per job           │
│                                                              │
│  ④ RuntimeEventPump implementation  hasPendingWork / drainEvents / ...  │
│     The Loop talks to it through this interface and does not know the JobSupervisor class     │
└──────────────────────────────────────────────────────────────┘
```

The constructor gives defaults for all three numbers. Tests can override them; production code needs no configuration:

```ts
const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
const closeTimeoutMs = options.closeTimeoutMs === undefined ? 10_000 : options.closeTimeoutMs;
if (options.capacity !== undefined && (!Number.isInteger(options.capacity) || options.capacity <= 0)) {
  throw new Error("capacity must be a positive integer");
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) {
  throw new Error("timeouts must be positive finite numbers");
}
this.#capacity = options.capacity === undefined ? 4 : options.capacity;
```

| Parameter | Default | Meaning |
| --- | --- | --- |
| `capacity` | `4` | At most 4 running jobs at the same time |
| `timeoutMs` | `120_000` | One job runs for at most 120 seconds |
| `closeTimeoutMs` | `10_000` | `close()` waits for at most 10 seconds |

All three values receive range validation. `capacity` must be a positive integer, and both timeouts must be finite positive numbers — `Infinity` is not acceptable either, because "never times out" equals no timeout protection. **Parameter validation sits in the constructor, so a bad configuration explodes at startup, not when the first job gets stuck.**

### A full capacity is an error, not a queue

The first lines of `submit()` are three precondition checks, and their order is also deliberate:

```ts
async submit(input: {
  readonly sourceToolCallId: string;
  readonly toolName: string;
  readonly operation: BackgroundOperation;
}): Promise<string> {
  // Submission order is fixed: capacity check -> persist running to disk -> register worker. Reject starts no side effects.
  await this.#ready;
  if (this.#closed) {
    throw new BackgroundClosedError("JobSupervisor is closed");
  }
  if (this.#jobControls.size >= this.#capacity) {
    throw new BackgroundCapacityError(`Background job capacity ${this.#capacity} is full`);
  }
  const jobId = nextId(this.#idGenerator, "background job");
  await this.#store.createRunning({
    jobId,
    sourceToolCallId: input.sourceToolCallId,
    toolName: input.toolName,
  });
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new CancellationSignalError("background job cancelled"));
  });
  const task = this.#track(this.#runJob(jobId, input.operation, cancelled));
  this.#jobControls.set(jobId, { task, cancel });
  return jobId;
}
```

When the fifth job is submitted, it receives a `background_capacity` error, **not a place in a queue**.

Why not queue? A queue would need a waiting queue, a scheduler, and a set of semantics for "what state is a queued job in". And after the model receives a "queued" response, it does not know how long it must wait — it can only query repeatedly. **An immediate failure is more useful**: the model learns at once that it cannot run the command now. It can do other work first, cancel a running job, or simply execute synchronously.

`await this.#ready` stands first, for crash recovery. At construction time, the Supervisor starts one recovery flow (it marks the `running` records that the last run left behind as `interrupted`), and `#ready` is the promise of that flow. **Every operation waits for recovery to finish first.** Otherwise one flow could recover while another submits, and both flows would modify the same directory.

### A three-way race

The core of `#runJob` is a three-way `Promise.race`:

```ts
const result = await Promise.race([execution, cancelled, timeoutHandle.promise]);
```

```text
       ┌─── execution ────────► The command completes by itself   → completed / failed
race ──┼─── cancelled ────────► Someone calls cancel  → cancelled
       └─── timeout(120s) ────► The time is up       → timed_out
                  Whoever arrives first decides the terminal state
```

The winner decides the terminal state. Look at the normal return branch first:

```ts
const result = await Promise.race([execution, cancelled, timeoutHandle.promise]);
if (!isToolResult(result)) {
  await this.#finish(
    jobId,
    BackgroundJobStatus.FAILED,
    toolError("background_contract_error", "Background executor returned an invalid result"),
  );
} else {
  await this.#finish(
    jobId,
    result.isError ? BackgroundJobStatus.FAILED : BackgroundJobStatus.COMPLETED,
    result,
  );
}
```

**`isError` decides `completed` versus `failed` directly.** This matches the invariant exactly — `completed` must carry a successful result and `failed` must carry an error result, and this code satisfies both naturally.

The `!isToolResult` branch handles a contract violation: someone passed an `operation` with a wrong return signature to `submit`. It must not appear in a normal run; if it appears, the code is wrong. **Turning it into an explicit `background_contract_error` is far better than letting `undefined` flow downstream.**

Now look at the catch chain. The three branches have the same structure:

```ts
} catch (error) {
  if (error instanceof CancellationSignalError) {
    controller.abort();
    await execution.catch(() => undefined);
    await this.#finish(jobId, BackgroundJobStatus.CANCELLED,
      toolError("background_cancelled", "Background job was cancelled"));
  } else if (error instanceof TimeoutMarker) {
    controller.abort();
    await execution.catch(() => undefined);
    await this.#finish(jobId, BackgroundJobStatus.TIMED_OUT,
      toolError("background_timeout", "Background job timed out"));
  } else {
    controller.abort();
    await execution.catch(() => undefined);
    await this.#finish(jobId, BackgroundJobStatus.FAILED,
      toolError("background_execution_error", "Background job execution failed"));
  }
} finally {
  timeoutHandle.cancel();
  this.#jobControls.delete(jobId);
}
```

`CancellationSignalError` and `TimeoutMarker` are **private classes that only this file uses**. The code does not export them. Their only job is to let the catch distinguish "who won the race" — no string check and no flag is needed, the type is enough.

The two repeated lines in all three branches deserve a separate note:

```ts
controller.abort();                          // Tell the executor: do not continue
await execution.catch(() => undefined);      // But still wait until it truly ends
```

The second line is easy to omit. `abort()` only sends a signal. The executor may still have cleanup work (close files, delete temporary directories). If the code does not wait for it, a worker may still be active after `close()` returns — **the process believes it exited cleanly, but it did not.** The `.catch(() => undefined)` exists because at this point the code cares only about "it has ended", not about how it ended.

The `finally` block performs two cleanup actions:

```ts
timeoutHandle.cancel();            // Clear the timer, or the process does not exit
this.#jobControls.delete(jobId);   // Free the capacity
```

`timeoutHandle.cancel()` is critical. As long as a 120-second `setTimeout` stays alive, the Node event loop does not empty, and the process hangs instead of exiting — the command finished in 3 seconds, but the process would wait another 117 seconds.

### Cancellation: valid only for `running`

The `cancel()` implementation has only a few lines, but every line handles one boundary:

```ts
async cancel(jobId: string): Promise<void> {
  await this.#ready;
  const normalized = canonicalBackgroundId(jobId);
  const control = this.#jobControls.get(normalized);
  if (control === undefined) {
    const job = await this.#store.getJob(normalized);
    throw new BackgroundJobStateError(
      `Background job ${job.id} is ${job.status}; expected running`,
    );
  }
  control.cancel();
  await control.task;
}
```

Three cases, three responses:

| Case | Response |
| --- | --- |
| The job is running | It triggers cancel, waits for the worker to close, and takes the `cancelled` terminal state |
| The job has already closed | `background_job_state`, and the message carries its real current state |
| The job does not exist at all | `background_job_not_found` (thrown by `store.getJob`) |

The third case has a very economical implementation: if `#jobControls` has no entry, the code asks the store. **The store's `getJob` throws a `BackgroundJobNotFoundError` itself when it finds nothing**, so this code needs no `if (job === undefined)` — the exception propagates upward directly.

Distinguishing the last two cases matters. "It already completed" and "you typed the id wrong" are completely different problems. The first means the model's mental model is out of date (it believed the job was still running). The second means it remembered the id wrongly. Measured error text for the second case:

```text
Error [background_job_state]: Background job 00000000-0000-4000-8000-000000000301 is completed; expected running
```
`is completed; expected running` states both "what it is now" and "what it must be". When the model sees this message it knows: stop waiting and go and query the result.

The last line, `await control.task`, is a detail that is easy to miss: **`cancel()` returns only after the worker has truly closed.** So when the cancellation tool reads the job back after `cancel()` returns, it always reads a terminal state that has already been migrated. It never reads an intermediate snapshot that still says `running`.

### Cancellation is cooperative

`control.cancel()` triggers the rejection of the `cancelled` promise, and the catch in `#runJob` then calls `controller.abort()`. That `controller.signal` passes through the executor to the operation:

```ts
export type BackgroundOperation = (signal: AbortSignal) => Promise<ToolResult>;

export class AsyncJobExecutor implements JobExecutor {
  async execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult> {
    return await operation(signal);
  }
}
```

But note the operation that `BackgroundDispatcher` submits when it submits a job:

```ts
operation: async () => await this.#tools.invoke(prepared, context),
```

**It does not receive that signal, and it does not pass a signal downward.** And `ToolContext` has only the three fields `workspace`, `identity`, and `idempotencyKey`; it has no room for a signal anyway.

So the cancellation semantics of P13 are: **the Supervisor stops waiting for this job and the job state migrates to `cancelled`, but the underlying PowerShell process keeps running until it ends by itself.** State this limit clearly. Do not believe that `cancel_background_job` can kill a process.

Why keep this signal path? Because it is part of the **replaceable execution boundary**. `JobExecutor` is an interface. The `AbortAwareExecutor` that tests inject does listen to the signal and returns early. If someone later implements "truly kill the process", the change belongs in `ToolContext` and the shell handler. The mechanism on the Supervisor side is already in place.

### close has a timeout, and it reports clearly

```ts
async close(): Promise<void> {
  // Shutdown flow stops new submissions first and cancels running jobs, then waits for workers to terminate within the timeout.
  await this.#ready;
  if (this.#closed && this.#managedTasks.size === 0) {
    return;
  }
  this.#closed = true;
  for (const control of this.#jobControls.values()) {
    control.cancel();               // Actively cancel every job that still runs
  }
  const settled = Promise.allSettled([...this.#managedTasks]);
  await withTimeout(
    settled,
    this.#closeTimeoutMs,
    new BackgroundCloseTimeoutError("Managed tasks did not stop before close timeout"),
  );
}
```

Three details:

**It cancels actively; it does not wait passively.** That `for` loop sends a cancellation signal to every job that still runs. If the code only waited with `allSettled`, an `npm install` that runs for 10 minutes would make `close()` time out with certainty. Active cancellation moves them to the `cancelled` terminal state — **the disk keeps an explicit `cancelled`, not a dangling `running`.**

**The idempotence check carries the condition `#managedTasks.size === 0`.** Looking at `this.#closed` alone misses one case: the first `close()` timed out and threw, `#closed` is already `true`, but workers still run. A second `close()` call must continue to wait in that case, not return directly with "already closed".

**After 10 seconds it throws `background_close_timeout`; it does not give up silently.** A job that has not closed means the disk may hold a `running` record, and after the process exits that record becomes an object for the next startup to recover — this fact must be reported.

Measured behavior for a submission after `close()`:

```text
BackgroundClosedError | JobSupervisor is closed
```

---

## Publish exactly once: the conditional transition

### One job, two actors that want to close it

Suppose a job completes at exactly the moment of its timeout:

```text
t=119.998s   The command returns → execution resolves
t=120.000s   The timer fires → timeoutHandle rejects
```

`Promise.race` selects one winner, but **both paths have already started**. If each path writes the state and each path publishes an event, the model receives two completion notifications for the same job — one says `completed`, the other says `timed_out`. Which one should it believe?

The same race has other combinations:

```text
cancel meets completion   → cancelled vs completed
cancel is called twice     → two cancelled events
timeout meets cancel   → timed_out vs cancelled
```

### The solution: let the store arbitrate

The key is that the return type of `finishRunning` is `BackgroundJob | undefined`:

```ts
// Atomically migrate running to final states; publish events only on winning writes returned by the store.
async #finish(
  jobId: string,
  status: Exclude<BackgroundJobStatus, "running">,
  result: ToolResult,
): Promise<void> {
  const job = await this.#store.finishRunning(jobId, status, result);
  if (job !== undefined) {
    await this.#publishEvent(job);
  }
}
```

That `Exclude<BackgroundJobStatus, "running">` is protection at the type level: **at compile time, `#finish` can never receive `running`.** If you want to "change a job back to running", the code cannot be written at all.

The store side implements it like this:

```ts
return await this.#withLock(paths, async () => {
  const job = (await this.#loadJobs(paths)).get(id);
  if (job === undefined) {
    throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
  }
  if (job.status !== BackgroundJobStatus.RUNNING) {
    return undefined;                              // ← the writer that arrived later
  }
  const terminal = new BackgroundJob({ ...job, status, result });
  await this.#persistJob(paths, terminal);
  return terminal;                                 // ← the winning writer
});
```

The three steps "read the current state → judge whether it is `running` → write" all sit inside `#withLock`. The operation is atomic. **Two concurrent calls cannot both read `running`.**

Note that `job === undefined` throws `not_found`, while `status !== running` returns `undefined`. The difference between the two: the first means the id is wrong (a real error), and the second means "someone was faster than me" (a normal race). **Two "failures" of the same function have completely different semantics, so one throws an exception and the other returns a value.**

The result:

```text
     ┌──────────────┐
     │  Two paths    │
     │ want to close it at the same time   │
     └──────┬───────┘
            │
    ┌───────┴────────┐
    ▼                ▼
finishRunning    finishRunning
    │                │
  returns job       returns undefined
    │                │
    ▼                ▼
 publish the event      return directly
                (do nothing)
```

**Exactly one event.** The Supervisor needs no marker for "did I already publish an event for this job", and it needs no extra lock — the code pushes the decision down into the layer that already holds the lock.

Measurements confirm this behavior:

```text
First finishRunning  -> completed
Second finishRunning -> undefined
```

### Why not keep a Set in memory

An apparently simpler approach exists: put a `#published = new Set<string>()` in the Supervisor and record every published job.

It has two problems:

1. **After a process restart, the Set is empty.** During crash recovery, a `running` job becomes `interrupted`. The Set holds no record, so the code publishes an event again. But the job may already have published one during its previous run.
2. **The Set and the disk can disagree.** The event went out, but the state write to disk failed. The Set records "published", and the disk still says `running`. The next start recovers it as `interrupted` and publishes again.

Placing the decision in the store removes this problem: **the fact "has the state already migrated" itself exists on disk.** It is the only truth, and no second copy must track it.

This continues the Chapter 12 principle — **one problem has exactly one currently valid source of truth**.

---

## How an event returns to the same Loop

### Accept typed events only

`EventInbox` is a FIFO queue, but its `publish` has a type gate:

```ts
// Publish an event and wake waiters; accept only objects validated by RuntimeEvent.
publish(event: RuntimeEvent): void {
  if (!isRuntimeEvent(event)) {
    throw new TypeError("EventInbox only accepts RuntimeEvent values");
  }
  this.#events.push(event);
  for (const resolve of this.#waiters.splice(0)) {
    resolve();
  }
}
```

`for (const resolve of this.#waiters.splice(0))` **wakes all waiters**, not only one. `splice(0)` first clears the array and takes all callbacks, then resolves them one by one. Why wake all of them? Because `wait()` is written like this:

```ts
async wait(limit?: number): Promise<readonly RuntimeEvent[]> {
  while (this.#events.length === 0) {
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }
  return this.drain(limit);
}
```

After a waiter wakes, it **checks the queue again** (`while`, not `if`). So waking several waiters at the same time is safe: the first one to run drains the events, and the next one finds an empty queue again and returns to the `while` loop to keep waiting. **This is the standard condition-variable pattern. It prevents "woke up but has nothing to do" from becoming an error.**

`RuntimeEvent` requires four things:

```ts
export interface RuntimeEvent {
  // Event carries stable ID and optional idempotency key for Loop to deduplicate and safely inject external results into the next turn.
  readonly eventId: string;
  readonly contextIdentity?: string;
  readonly idempotencyKey?: string;
  // Serialize events into pure JSON data visible to the model; implementors are responsible for stable field names.
  toPayload(): Readonly<Record<string, unknown>>;
}
```

Why not allow any arbitrary object to enter? Run a measurement and you know:

```text
inbox.publish({ eventId: "x" })  -> TypeError: EventInbox only accepts RuntimeEvent values
inbox.publish("hello")           -> TypeError: EventInbox only accepts RuntimeEvent values
inbox.publish(null)              -> TypeError: EventInbox only accepts RuntimeEvent values
```

A bare object has no `toPayload()`. If it enters, it explodes only at the moment of injection — deep inside the Loop, where the stack does not show who sent it. **Exploding at the publish point puts the error closest to its cause.**

`eventId` is even more critical. It is the only basis for deduplication. Without it, the same event could be injected twice, and the model would see the same completion notification two times.

### An event is a user message, not a second tool result

This is the easiest place to make a mistake in this chapter, and it is also the place that allows no compromise.

The background command has completed and its result must reach the model. Intuitively, it should be a `tool` message — after all, it is the execution result of a tool. **But it cannot be.**

Return to the protocol rule: every `tool` message must carry a `tool_call_id`, and that id must correspond to a `tool_call` that has not yet received a reply. And that `slow-call` **already received its reply at submission time, from the placeholder result**.

```text
Message 2 assistant:  tool_calls = [slow-call, fast-call]
Message 3 tool:       tool_call_id = slow-call   ← already used
Message 4 tool:       tool_call_id = fast-call   ← already used

The background result arrives now. Which tool_call_id can it use?
  Use slow-call → the same id has two tool messages → 400
  Use a new id  → this id has no corresponding tool_call → 400
  Carry no id      → the tool message lacks tool_call_id → 400
```

**All three paths are dead.** So the background result can enter only as a `user` message:

```ts
// Events enter history as normal user messages without disguising as tool results or carrying tool_call_id.
export function runtimeEventMessage(
  event: RuntimeEvent,
  batch?: RuntimeEventBatchPosition,
): UserMessage {
  if (!isRuntimeEvent(event)) {
    throw new TypeError("event must be a RuntimeEvent");
  }
  const position = batch === undefined ? { index: 0, total: 1 } : batch;
  if (
    !Number.isInteger(position.index) ||
    position.index < 0 ||
    !Number.isInteger(position.total) ||
    position.total <= 0 ||
    position.index >= position.total
  ) {
    throw new TypeError("batch position must satisfy 0 <= index < total");
  }
  return userMessage(
    JSON.stringify({ runtime_event: event.toPayload(), batch: position }, (_key, value: unknown) => value),
  );
}
```

The return type is `UserMessage`, not the broader `ChatMessage` — **the type itself fixes the rule "an event can become a user message only"**.

The real injected content (formatted to show the structure):

```json
{
  "runtime_event": {
    "event_id": "00000000-0000-4000-8000-000000000302",
    "job_id": "00000000-0000-4000-8000-000000000301",
    "kind": "background_job",
    "result": {
      "content": "404 passed",
      "error_code": null,
      "is_error": false
    },
    "source_tool_call_id": "slow-call",
    "status": "completed",
    "tool_name": "shell"
  },
  "batch": { "index": 0, "total": 1 }
}
```

The `role` is `user`. The message has no `tool_call_id`, and the protocol is fully legal. The model sees a structured notification: the `job_id` matches the earlier placeholder result, the `source_tool_call_id` traces back to the original call, the `status` states the terminal state, and the three `result` fields state the result content.

Note that `result` is **nested**. The three fields `content` / `error_code` / `is_error` sit inside it. This shape is exactly the same as the return value of `query_background_job` and as the JSON stored on disk — **the same data has the same shape in three places, so the model does not learn three sets of field names.**

**This is not a compromise. It is the only correct mapping.** The semantics of a `tool` message are "the return value of this call of yours". It corresponds one-to-one with a `tool_call` and closes inside the same turn. The semantics of a background result are "that earlier work has made progress". It is naturally a notification across turns — and the `user` message is exactly the role that carries external input.

### Two injection points

The Loop calls `#acceptNextRuntimeEvent` in two places, with different arguments:

```ts
// core/loop.ts:273 —— before every model request
// Receive completed background events before each model request to prevent events from being visible only in the first turn.
await this.#acceptNextRuntimeEvent(false);
validateToolPairing(this.#history);
...

// core/loop.ts:340 —— after the model gives an answer with no tool calls
// No tool calls remain in the current turn; wait for background events with potential results, continuing to the next turn on arrival.
const injectedCount = await this.#acceptNextRuntimeEvent(true);
if (injectedCount > 0) {
  continue;
}
return await this.#complete(assistant.content, turn);
```

`#acceptNextRuntimeEvent` returns the **number of injected events** (`number`), not a boolean. Why? Because deduplication can filter out a whole batch of events — `events.length > 0` but `injected.length === 0`. In that case the code must not `continue`. Otherwise the Loop would ask the model again while the model sees no new information, and the request is wasted. **Returning a count lets the code judge "events were taken" and "new information was injected" as two separate things.**

That boolean parameter is `waitForPendingWork`:

| Position | Parameter | Behavior |
| --- | --- | --- |
| Before a request | `false` | Take events if the queue has them; if not, forget it. **Never block** |
| After an answer with no tool calls | `true` | The queue is empty but a running job still exists, so **wait** |

This design solves the question "when may the Loop truly end". Look at the two cases:

```text
Case A: The model is still calling tools
  The Loop turns to the next round anyway, so it needs no wait.
  At the start of the next round, waitForPendingWork=false picks up completed events on the way.
  → Background results ride along, with zero extra delay

Case B: The model has finished speaking and calls no more tools
  If the Loop returns directly here, the background jobs that still run were run for nothing.
  → It must wait until they close, and show their results to the model
```

`hasPendingWork` answers the question "is there anything left that is worth waiting for":

```ts
// Whether unfinished background jobs exist; the Loop uses this to decide whether to wait for events.
get hasPendingWork(): boolean {
  return this.#jobControls.size > 0;
}
```

It looks only at `#jobControls` — **whether a job still runs**. It does not look at whether the queue holds events, because `#acceptNextRuntimeEvent` has already called `drainEvents()` first: when execution reaches the `hasPendingWork` judgement, the queue is empty by definition.

This order is critical: take once without blocking first; use what you get; only when you get nothing do you ask "is there more work". If `hasPendingWork` also counted the queue, strange combinations beyond "queue empty + no running job" would appear — the judgement conditions would overlap, and the reasoning would become harder. **Each method answers one question only.**

### The complete injection flow

`#acceptNextRuntimeEvent` does five things, and their order matters:

```ts
async #acceptNextRuntimeEvent(waitForPendingWork: boolean): Promise<number> {
  if (this.#eventPump === undefined) {
    return 0;
  }
  // 1. Optional recovery barrier: ensure that construction-time recovery events are published before the first drain
  if (this.#eventPump.ready !== undefined) {
    await this.#eventPump.ready();
  }
  // 2. Take without blocking first
  let events = this.#eventPump.drainEvents();
  // 3. Consider waiting only when the queue is empty
  if (events.length === 0 && waitForPendingWork && this.#eventPump.hasPendingWork) {
    events = await this.#eventPump.waitForEvents();
  }
  if (events.length === 0) {
    return 0;
  }
  // 4. If any event in the batch is invalid, the whole batch fails explicitly
  if (!events.every((event) => isRuntimeEvent(event))) {
    throw new AgentRunError("Runtime event pump returned invalid events");
  }
  // 5. Filter duplicate ids first, then compute the batch positions
  const injected: RuntimeEvent[] = [];
  for (const event of events) {
    if (this.#seenEventIds.has(event.eventId)) {
      continue;
    }
    this.#seenEventIds.add(event.eventId);
    injected.push(event);
  }
  // 6. Acknowledge all events, however many deduplication removed
  this.#eventPump.acknowledgeEvents(events);
  // 7. Inject the batch with position metadata
  for (const [index, event] of injected.entries()) {
    this.#history.push(runtimeEventMessage(event, { index, total: injected.length }));
  }
  return injected.length;
}
```

The `ready?()` in step 1 is an optional method that exists for crash recovery. At construction time, the Supervisor starts to migrate leftover `running` records to `interrupted` and to publish events, but that is an asynchronous flow. If the Loop's first `drainEvents()` runs before recovery completes, it takes an empty queue and misses the recovery events. **The `ready()` barrier guarantees that "the events the last crash left behind" are visible in the very first turn.**

Step 4 validates the whole batch at once with `every`. **If any one event is invalid, the whole batch fails.** The code does not "skip the bad ones and keep the good ones" — that would drop events silently, which is far more dangerous than an explicit error.

The position of step 6 matters: **`acknowledgeEvents` receives `events` (all of them), not `injected` (the deduplicated set)**. A deduplicated event also needs an ack. Otherwise, in a future implementation where "ack means truly consumed", it would hang in the unacknowledged state forever.

The `{ index, total }` in step 7 is position information for the model. When three jobs complete at the same time, the model receives three consecutive `user` messages:

```json
{"runtime_event":{...,"job_id":"...0301"},"batch":{"index":0,"total":3}}
{"runtime_event":{...,"job_id":"...0303"},"batch":{"index":1,"total":3}}
{"runtime_event":{...,"job_id":"...0305"},"batch":{"index":2,"total":3}}
```

With `total: 3`, the model knows, when it reads the first message, that two more follow. It does not rush to a conclusion from incomplete information. Without this metadata, it would have to guess — and it would very likely start answering when it reads the first message.

When `batch` is omitted, the default is `{ index: 0, total: 1 }` — a single event is "the first of a batch of one". The semantics stay consistent, and no special-case branch is needed.

> **A warning in advance: this batch injection lives only until this chapter.** After Chapter 14 introduces cron events, different events carry different identities, and one model turn can hold only one `ToolContext`, so batch injection becomes an identity mix-up. Chapter 14 therefore changes the Loop to `drainEvents(1)`, one event at a time, and deletes `RuntimeEventBatchPosition` and the `batch` field together. The design in this section is not a design that later gets overturned — **"batching" is genuinely sufficient when only one event source exists. When the event sources become two, identity isolation outweighs the convenience of batching.** Chapter 14 will do that calculation for you.

### RuntimeEventPump: the Loop does not know the Supervisor

The Loop depends on a five-member interface, not on the `JobSupervisor` class:

```ts
// The event pump is a one-way channel from the external runtime to the Agent Loop.
export interface RuntimeEventPump {
  // Indicates external runtimes may still produce events, helping tool-free turns decide whether to block and wait.
  readonly hasPendingWork: boolean;
  // Drains the current batch of events non-blockingly.
  drainEvents(limit?: number): readonly RuntimeEvent[];
  // Wait for the next batch of events when pending work exists.
  waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]>;
  // Confirm this batch of events was received by the Loop; implementations can persist the consumption position accordingly.
  acknowledgeEvents(events: readonly RuntimeEvent[]): void;
  // Optional recovery barrier ensuring construction-phase recovery events publish before the first drain.
  ready?(): Promise<void>;
}
```

`JobSupervisor` implements it, and the implementation is thin — almost everything forwards to `EventInbox`:

```ts
get hasPendingWork(): boolean {
  return this.#jobControls.size > 0;
}
async ready(): Promise<void> {
  await this.#ready;
}
drainEvents(limit?: number): readonly RuntimeEvent[] {
  return this.#inbox.drain(limit);
}
async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
  return await this.#inbox.wait(limit);
}
// Confirm events are consumed by the Loop; the current implementation validates the contract, preserving boundaries for persistence acks.
acknowledgeEvents(events: readonly RuntimeEvent[]): void {
  if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
    throw new TypeError("events must contain RuntimeEvent values");
  }
}
```

`acknowledgeEvents` does no real work, but it is **not an empty function** — it still validates its arguments. This point is worth learning: an interface method that is "not implemented yet" can start with contract checks only. Then a caller that passes the wrong thing exposes itself immediately, instead of the error appearing only later, when the ack is truly implemented and everyone discovers that the call style was wrong all along.

It draws a **boundary that can grow in the future**: if one day the event source is an MCP notification or a webhook, then `drain` means only "taken locally", and `ack` means "told the upstream side that I processed it". Today, drain already removes the events from the queue, so ack has nothing to do — but the Loop's call order is correct, and a new implementation needs no Loop change.

At construction time, the Loop checks this contract:

```ts
if (
  options.eventPump !== undefined &&
  (typeof options.eventPump.drainEvents !== "function" ||
    typeof options.eventPump.waitForEvents !== "function" ||
    typeof options.eventPump.acknowledgeEvents !== "function" ||
    ...)
) {
  throw new TypeError("eventPump must implement the RuntimeEventPump contract");
}
```

This is a runtime duck-type check; it does not rely on TypeScript alone. Because the composition root may receive this object from configuration, a plugin, or a test double — **compile-time type annotations cannot control what truly arrives at runtime.**

The practical benefit of this abstraction layer is: **the Loop knows nothing about background tasks at all.** It knows only that "something produces RuntimeEvents, and I must inject them into the history at the right time". Chapter 13 connects background jobs. Chapter 14 connects Cron, and Chapter 15 connects the Inbox. This Loop code does not change by one line.

---

## Query and cancellation: two tools

A placeholder result alone is not enough for the model — it needs a way to actively ask "how is that job doing now", and it needs a way to say "stop running it". So this chapter registers two new tools, **for the lead Agent only**:

```ts
export function registerBackgroundJobTools(
  registry: ToolRegistry,
  supervisor: JobSupervisor,
): void {
  // The background exposes only query and cancel tools; shell Dispatcher automatically handles creation and execution.
  registry.register(queryBackgroundJobDefinition(supervisor));
  registry.register(cancelBackgroundJobDefinition(supervisor));
}
```

That comment states a design decision: **there is no `create_background_job` tool.** The model cannot say "create a background task for me" directly. It can trigger a background job only indirectly, through the `run_in_background` parameter of `shell`.

Why? Because a background job must bind to a real tool call — its `sourceToolCallId` must trace back, and its `operation` must be a `prepared` call that has passed the permission checks. Give the model a bare "create job" entry point, and neither of those two properties can be guaranteed.

### The two tools differ in effect

```ts
const backgroundJobIdSchema = z
  .string()
  .regex(CANONICAL_UUID, "job_id must be a canonical UUID");
const backgroundJobIdInputSchema = z.object({ job_id: backgroundJobIdSchema }).strict();
```

The two tools share one input schema, but their `effect` values differ:

| Tool | effect | What it does |
| --- | --- | --- |
| `query_background_job` | `read` | Reads one job record; it changes no state |
| `cancel_background_job` | `write` | Triggers cancellation, then reads the final state back |

`effect` decides how the permission policy treats the tool. A `read` can usually pass automatically; a `write` may need confirmation — that is the Chapter 7 permission mechanism at work, and this chapter only declares its own side-effect level correctly.

The query tool returns the complete job snapshot:

```ts
return {
  name: "query_background_job",
  description: "Read the persisted status and result of one background job.",
  inputSchema: backgroundJobIdInputSchema,
  effect: "read",
  handler: async (input) => {
    try {
      const job = await supervisor.getJob(input.job_id);
      return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
    } catch (error) {
      return backgroundJobToolError(error);
    }
  },
};
```

`getJob` **throws an exception when it finds nothing; it does not return `undefined`**. So this handler uses `try/catch`, not `if`. The function that converts exceptions is short, but its rule is hard:

```ts
function backgroundJobToolError(error: unknown) {
  // Known background domain errors retain stable error codes; throw unknown exceptions upward to avoid swallowing bugs.
  if (error instanceof BackgroundError) {
    return toolError(error.errorCode, error.message);
  }
  throw error;
}
```

**Only a `BackgroundError` becomes a `ToolResult`.** Other exceptions (a `TypeError`, a `RangeError`, any code bug) propagate unchanged. That `throw error` line is an attitude that recurs throughout this chapter: **domain errors are for the model; program defects are for the developer; the two must not mix.** If this handler were written as `catch { return toolError("unknown", ...) }`, a null-pointer bug would disguise itself as a "query failure" and nobody could ever find it.

One measured, complete query round trip:

```text
Query immediately after submission:
{"job_id":"...0301","status":"running","tool_name":"shell",
 "source_tool_call_id":"slow-call","result":null}

Query after completion:
{"job_id":"...0301","status":"completed","tool_name":"shell",
 "source_tool_call_id":"slow-call",
 "result":{"content":"404 passed","error_code":null,"is_error":false}}
```

Note three things:

1. **While `running`, `result` is `null`** — this is exactly what that invariant looks like on disk.
2. **The field name is `job_id`, not `id`**. It uses the same name as the placeholder result and the runtime event.
3. **`error_code` is `null` on success, not missing**. The field always exists, so the model never judges "does this key exist".

Point 3 comes from the `?? null` in `backgroundJobPayload`:

```ts
result:
  job.result === null
    ? null
    : {
        content: job.result.content,
        error_code: job.result.errorCode ?? null,
        is_error: job.result.isError,
      },
```

That `??` does not hide a missing field. It **normalises the TypeScript value `undefined` into the JSON value `null`**. `JSON.stringify` simply drops a key whose value is `undefined`, and then the JSON structure that the model sees would exist at some times and not at others.

This chapter has three `??` sites in total. All three do this same job, and they correspond exactly to the "same data, same shape in three places" rule from earlier:

| Position | Who sees it |
| --- | --- |
| `background.ts:250` (`BackgroundJobEvent.toPayload`) | The runtime event injected into the history |
| `background.ts:693` (`backgroundJobPayload`) | The return value of `query_background_job` / `cancel_background_job` |
| `background-json.ts:341` (`#persistJob`) | The JSON on disk |

All three sites write the same expression, so `error_code` is "null on success" in all three places instead of "this key does not exist on success". **If any one of the three sites is missed, that "consistent in three places" promise breaks.**

### Read back after a cancellation

The implementation of the cancellation tool has one detail that is easy to miss:

```ts
handler: async (input) => {
  try {
    await supervisor.cancel(input.job_id);
    const job = await supervisor.getJob(input.job_id);
    return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
  } catch (error) {
    return backgroundJobToolError(error);
  }
},
```

`cancel()` itself returns `void`. It does not tell you the final state. So this handler must read the job back once.

Someone will ask: `cancel()` already waits inside itself with `await control.task` until the worker closes, so why does it not simply return that job? Because **the single truth about state is on the disk**. `cancel()` is responsible only for "make it stop", and `getJob()` is responsible for "tell me what it is now". With the two responsibilities separate, `cancel()` needs no knowledge of what the payload looks like.

The value read back is the authoritative state, and **execution may never reach the read-back step at all**:

```text
The job is running when cancel is called     → cancel succeeds, and the read-back returns cancelled
The command completes just as cancel is called    → cancel throws background_job_state, and the read-back does not execute
The job_id of cancel does not exist      → cancel throws background_job_not_found
```

Measured error text for the second case:

```text
Error [background_job_state]: Background job 00000000-0000-4000-8000-000000000301 is completed; expected running
```

The tool returns the error instead of faking success. **This is better than returning a "cancellation succeeded" after which the model discovers that the job is `completed`** — the model needs to know that its cancellation arrived one step too late, and this message lets it read the real state directly, with no second query.

### The job_id format is stopped at the entry point

The `CANONICAL_UUID` regular expression appears in three places: the tool schema, the `BackgroundJob` constructor, and the file-name parsing in the persistence layer.

```ts
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
```

Note that the character class is `[0-9a-f]` — **lowercase only**. Three measured inputs through the `query_background_job` tool:

```text
{"job_id":"a1b2c3d4-1111-4222-8333-444455556666"}
  -> Error [background_job_not_found]: Background job does not exist: a1b2c3d4-...
     (The format is legal; the disk simply holds no such record)

{"job_id":"A1B2C3D4-1111-4222-8333-444455556666"}
  -> Error [invalid_arguments]: Tool arguments failed schema validation
{"job_id":"not-a-uuid"}
  -> Error [invalid_arguments]: Tool arguments failed schema validation
```

Uppercase input and garbage input receive **the same error code**, because the same gate stops both of them: Zod's `.regex(CANONICAL_UUID)`, that is, the `tools.prepare()` stage. **They never entered the handler at all.**

Why be this strict about case? Because the job id serves directly as a **file name**. The Windows file system is case-insensitive, and the Linux file system is case-sensitive — if both spellings were allowed, the same job would be one file on Windows and two files on Linux. **Allow one canonical spelling only, and the cross-platform behavior stays consistent.**

The same regular expression guards three layers. Bypass any one layer, and the next layer still stands:

```text
Layer 1  The z.regex() of the tool schema
         → a job_id from the model; an error gives invalid_arguments
Layer 2  canonicalBackgroundId()
         → an internal code call (for example, a direct supervisor.getJob call that bypasses the tool)
         → an error gives background_storage_error
Layer 3  File-name parsing in the persistence layer
         → a file that someone placed on the disk by hand; an error gives background_storage_error
```

Measured layer 2 behavior: call `supervisor.getJob("A1B2C3D4-...")` directly, bypass the tool schema, and the result is

```text
BackgroundStorageError | background id must be a canonical UUID
```

**All three layers use the same constant, `CANONICAL_UUID`. No drift of "one layer strict, one layer loose" exists.** This is the concrete form of "write the same rule once": do not check at the outermost layer only; let every entry point share the same validation function.

---

## After a crash: where interrupted comes from

### A gap that necessarily exists

The process is killed by `Ctrl+C`, killed by the OOM killer, or the machine loses power — what does the disk hold at that moment?

```text
t=0s     The job is persisted, status = running
t=5s     The command still runs
t=5s     💥 The process disappears
         On disk: status = running, but no worker exists anywhere in the world anymore
```

This `running` record **never becomes a terminal state by itself**. At the next start, a query returns `running`. The model believes it still runs, and waits forever.

Nobody can remove this gap: persistence and execution cannot be one atomic operation. Since the gap cannot be removed, **the next start cleans it up**.

### Recovery happens in the constructor

The last line of the `JobSupervisor` constructor starts recovery:

```ts
this.#ready = this.#recover();
```

Note that it has **no `await`** — a constructor cannot be asynchronous. It stores the promise in `#ready`, and the first line of every public method is `await this.#ready`:

```ts
async submit(...)  { await this.#ready; ... }
async cancel(...)  { await this.#ready; ... }
async getJob(...)  { await this.#ready; ... }
async close()      { await this.#ready; ... }
async ready()      { await this.#ready; }
```

**This is the standard pattern for "asynchronous initialisation".** The constructor starts the flow and takes the promise; every method waits for it on entry. The benefit is that a caller needs no memory of "initialise first, then use" — forgetting is harmless, because every entry point waits by itself.

Recovery itself is short:

```ts
// Recovery migrates all running jobs left from previous processes to interrupted, publishing events for each migration.
async #recover(): Promise<void> {
  const interrupted = await this.#store.interruptRunning();
  for (const job of interrupted) {
    await this.#publishEvent(job);
  }
}
```

### The store side: batch migration in a fixed order

```ts
async interruptRunning(): Promise<readonly BackgroundJob[]> {
  const paths = await this.#preparePaths(false);
  if (paths === undefined) {
    return [];                                  // The directory does not even exist; nothing needs recovery
  }
  return await this.#withLock(paths, async () => {
    const interrupted: BackgroundJob[] = [];
    for (const job of [...(await this.#loadJobs(paths)).values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      if (job.status !== BackgroundJobStatus.RUNNING) {
        continue;                               // Do not touch terminal states
      }
      const terminal = new BackgroundJob({
        ...job,
        status: BackgroundJobStatus.INTERRUPTED,
        result: toolError(
          "background_interrupted",
          "Background job was interrupted by a previous process exit",
        ),
      });
      await this.#persistJob(paths, terminal);
      interrupted.push(terminal);
    }
    return Object.freeze(interrupted);
  });
}
```

Four details:

**`.sort((left, right) => left.id.localeCompare(right.id))`** — sort by id. The file system does not guarantee the order of directory entries. Sort once, and the injection order of the recovery events is fixed. **The same disk state produces the same event sequence at every start**, so a problem can be reproduced.

**`if (job.status !== RUNNING) continue`** — do not touch any job that is already in a terminal state. So recovery is **idempotent**: start twice in a row, and the second start has no `running` job to migrate. It returns an empty array and publishes no event.

**The return value contains only the jobs that this run truly migrated.** This is "publish exactly once" on the recovery path — events are published from the returned array, so no migration means no event.

**The whole loop sits inside `#withLock`.** During recovery, no other process can modify this directory at the same time.

### The recovery event that the model sees

A job that the last crash left behind is injected in the first turn of this start:

```json
{
  "runtime_event": {
    "event_id": "...",
    "job_id": "...0301",
    "kind": "background_job",
    "result": {
      "content": "Error [background_interrupted]: Background job was interrupted by a previous process exit",
      "error_code": "background_interrupted",
      "is_error": true
    },
    "source_tool_call_id": "slow-call",
    "status": "interrupted",
    "tool_name": "shell"
  },
  "batch": { "index": 0, "total": 1 }
}
```

The `source_tool_call_id` points to **the tool call in the previous process**, which does not exist at all in the history of the current session. This is not a bug — it is audit information. It tells you "this job was originally triggered by that call". The model needs no pairing for it, because the event is a `user` message and needs no pairing.

**This also shows again why an event cannot be a `tool` message.** If it were a `tool` message, it would need a corresponding `tool_call`. And the `tool_call` of the previous process disappeared together with that session's history, so no pairing is possible at all.

### ready() guarantees that recovery events are not missed

The earlier section mentioned `RuntimeEventPump.ready?()`. It serves exactly here:

```ts
// core/loop.ts:568
if (this.#eventPump.ready !== undefined) {
  await this.#eventPump.ready();
}
let events = this.#eventPump.drainEvents();
```

Without this barrier, the timing could be:

```text
t=0ms   Supervisor construction; #recover() starts (asynchronous)
t=1ms   The Loop's first turn; drainEvents() → empty
t=1ms   The Loop sends the first model request (the model does not see the interrupted event)
t=8ms   #recover() completes; the event enters the queue only now
t=???   Injection waits until the next turn
```

The model's first answer would rest on incomplete information. With `ready()` in place, the first `drainEvents()` necessarily happens after recovery completes.

---

## Connect it to the composition root

### The capability bit pairs in both directions

`bootstrap.ts` contains checks in two directions. Neither can be missing:

```ts
if (profile.capabilities.has("background") && dependencies.backgroundSupervisor === undefined) {
  // Background capability cannot silently downgrade to synchronous shell; reject assembly directly when Supervisor is missing.
  throw new Error("backgroundSupervisor is required for chapter 13 or later");
}
if (!profile.capabilities.has("background") && dependencies.backgroundSupervisor !== undefined) {
  throw new Error("backgroundSupervisor requires chapter 13 or later");
}
```

| Case | Consequence (without the check) |
| --- | --- |
| Capability bit present, no Supervisor | The shell declares `background_eligible`, but no Dispatcher exists. **The background parameter is silently ignored.** The model believes the call entered the background, but it actually ran synchronously to completion |
| No capability bit, Supervisor present | P12 receives a Supervisor that it will never use. The recovery flow still runs and still takes the lock, but no job is ever submitted |

The first case is more dangerous: **silent degradation**. The model passes `run_in_background: true`, and the system returns a synchronous result. The model has no way to notice. Chapter 12 taught the same principle — **a capability is either complete or absent; it cannot be half open.**

### How the background switch of the shell travels down

From the capability bit to the schema, the value passes through three hops:

```text
profile.capabilities.has("background")
  ↓  bootstrap.ts:101
createStandardTools(profile, commandRunner, fileSystem, ← this boolean)
  ↓  bootstrap.ts:268
createChapterTwoTools(commandRunner, fileSystem, background)
  ↓  builtin-tools.ts:76
createShellTool(commandRunner, background)
  ↓  builtin-tools.ts:40
inputSchema: background ? backgroundShellInputSchema : shellInputSchema
```

One boolean value travels to the end. There is no global state, no environment variable, and no singleton. **To judge whether a shell instance has the background capability, you only need to see who created it and with which argument.**

### Subagents receive no background capability

This is an important boundary of this chapter that is easy to miss:

```ts
// bootstrap.ts:155 —— the tool factory of a subagent
const childTools = createStandardTools(profile, commandRunner, fileSystem, false).tools;
//                                                                            ^^^^^
```

**Hard-coded `false`.** Even if the profile has the `background` capability bit, the shell of a subagent is synchronous.

The registration step is also separated:

```ts
// bootstrap.ts:179 —— the lead Agent only
if (dependencies.backgroundSupervisor !== undefined) {
  // Primary Agent registers background query and cancellation tools; subagents receive no background Supervisor, so do not expose these capabilities.
  registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
}
```

The tool factory of a subagent contains no `registerBackgroundJobTools` line at all. So a subagent has:

| | Lead Agent | Subagent |
| --- | --- | --- |
| `shell` has `run_in_background` | Yes | **No** |
| `shell.concurrency` | `background_eligible` | `inline` |
| `query_background_job` | Yes | **No** |
| `cancel_background_job` | Yes | **No** |
| `toolDispatcher` | `BackgroundDispatcher` | None (direct `tools.invoke`) |
| Shared `taskStore` | Yes | **Yes** (the Chapter 12 capability is still shared) |

Compare the last row: **Tasks are shared; background jobs are not.** The two decisions become interesting only when you look at them together.

Why are Tasks shared? Because a Task says "this work must be done". Lead and subagents can collaborate only if they look at the same project map.

Why are background jobs not shared? Because a subagent is **one-shot**: it runs one task and is then destroyed. If it submitted a background job, into whose history should that job's completion event be injected? The subagent no longer exists, and the lead Agent never submitted it. **An event with no owner is an orphan event.** So subagents simply do not receive this capability.

### The complete tool list of P13

Print the tool names of P12 and P13 side by side, and you can see what this chapter truly adds:

```text
P12 tool count: 13
shell, read_file, write_file, edit_file, glob, todo_write, task,
load_skill, create_task, get_task, list_tasks, claim_task, complete_task

P13 tool count: 15
(the 13 above) + query_background_job, cancel_background_job
```

**Only two tools were added.** Most of the work in this chapter is not in "adding tools". It is in:

| Change | Can the model see it |
| --- | --- |
| `shell` gains the `run_in_background` parameter | It can see it (the schema changed) |
| 2 new job tools | It can see them |
| The `concurrency` of `shell` is marked `background_eligible` | **It cannot see it** (metadata of the tool definition; it does not enter the schema) |
| `BackgroundDispatcher` sits between the Loop and the registry | **It cannot see it** |
| The capacity, timeout, and recovery of `JobSupervisor` | **It cannot see them** |
| The event injection path | It cannot see the mechanism; it sees only the injected user messages |

This table states one fact: **the "model-visible surface" of a capability is usually far smaller than its implementation size.** The model needs to know only "I can ask for background execution" and "I can query and cancel". The state machine, the race arbitration, and the crash recovery all stay outside its view.

This is also why this chapter stresses persistence and invariants again and again — **when a part that the model cannot see goes wrong, the model cannot help you either.** It only receives an event that it cannot explain, and then it continues in confusion.

### The Supervisor is three things at the same time

When the code assembles the `AgentRunner`, it places the same object into two different slots:

```ts
// Supervisor serves as both the event pump and AsyncResource; the Loop closes background jobs together when closing resources.
...(dependencies.backgroundSupervisor === undefined
  ? {}
  : {
      eventPump: dependencies.backgroundSupervisor,
      resources: [dependencies.backgroundSupervisor] as readonly AsyncResource[],
    }),
```

Together with the reference that `BackgroundDispatcher` holds, the Supervisor has three roles in total:

```text
                  ┌─────────────────┐
                  │  JobSupervisor  │  one instance
                  └────────┬────────┘
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   Held by the Dispatcher     eventPump         resources[0]
   (submits jobs)      (takes events)        (closes at close time)
```

**It must be the same instance.** If the Dispatcher submitted to A and the Loop took events from B, the events would never reach the Loop. This style of "registering the same object in several places" looks slightly convoluted, but it guarantees that the three roles can never disagree.

The `resources` entry makes `AgentRunner.close()` close background tasks as well. The close order is **reverse order**:

```ts
// core/loop.ts —— inside close()
for (const resource of [...this.#resources].reverse()) { ... }
```

Later registrations close first. This matches the dependency direction: a later-registered object may depend on an earlier-registered one, so the code releases the later one first.

### The CLI constructs it only when needed

```ts
const backgroundSupervisor = profile.capabilities.has("background")
  ? new JobSupervisor({ store: new JsonBackgroundJobStore(workspace), inbox: new EventInbox() })
  : undefined;
```

When you run `npm run ch12`, this value is `undefined`. **The CLI creates no `.agent_tutorial/background/` directory, takes no lock, and runs no recovery flow.** The behavior of Chapter 12 is exactly what it was before Chapter 13 existed.

This is the practical benefit of the capability-bit design: **a new capability does not change the runtime behavior of old chapters.**

---

## Run Chapter 13

Run all commands below in PowerShell. Follow the steps once, and you will see the placeholder result and the runtime event with your own eyes.

### Step 0: Check the environment

```powershell
node --version
npm --version
```

Node must be ≥ 20.12. A lower version causes problems with ESM `import` or with `randomUUID` in `node:crypto`.

### Step 1: Enter the code directory

```powershell
cd F:\笔记\Agent实操\code
```

All later commands run in this directory.

### Step 2: Install the dependencies

```powershell
npm install
```

You do this once only. (A little ironic — this chapter is exactly about how to stop this command from blocking the Agent.)

### Step 3: Run the tests first, and confirm that the code is good

```powershell
npm run test:ch13
```

Expect all green. This step matters: **confirm that the baseline is good first, then run a real model.** Otherwise, when a problem appears, you cannot tell whether it is an environment problem or a code problem.

### Step 4: Configure the model credentials

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_BASE_URL = "https://your-endpoint/v1"
$env:OPENAI_MODEL = "gpt-4o-mini"
$env:OPENAI_FALLBACK_MODEL = "gpt-4o"
```

Set all four. A missing one produces an error at start time — the Chapter 11 fallback mechanism requires the primary model and the fallback model to be specified explicitly. It does not guess.

### Step 5: Run for real

```powershell
npm run ch13 -- --prompt "Run npm install in the background, and read README.md at the same time; summarise after you get the result"
```

This prompt is designed on purpose: one slow job + one fast job + a summary that needs both results. An equivalent alternative form:

```powershell
npm run agent-tutorial -- run --chapter 13 --prompt "Run npm install in the background, and read README.md at the same time; summarise after you get the result"
```

### What you should see

In time order:

```text
1. shell is called, and it returns {"job_id":"...","status":"running","tool_name":"shell"} almost immediately
2. read_file returns the README content right after    ← it did not wait for npm install
3. The model may give an intermediate answer first
4. A runtime_event appears, with status completed or failed
5. The model gives the final summary
```

**The key observation point is step 2.** If the `read_file` result appears only after `npm install` finishes, the background conversion did not take effect — go to the troubleshooting table in step 3.

### Step 6: See what the disk holds

```powershell
Get-ChildItem .agent_tutorial\background\
Get-Content .agent_tutorial\background\*.json | ConvertFrom-Json | Format-List
```

One file per job. The file name is the job id:

```json
{
  "id": "3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  "source_tool_call_id": "call_abc123",
  "tool_name": "shell",
  "status": "completed",
  "result": {
    "content": "added 404 packages in 12s",
    "error_code": null,
    "is_error": false
  }
}
```

Five keys, no more and no fewer. The key name on disk is `id` (not `job_id`) — that is the persistence format. The payload that the model sees uses `job_id`. **Each layer has its own field names, and `backgroundJobPayload()` converts between them.**

### Troubleshooting common errors

| Symptom | Cause | What to do |
| --- | --- | --- |
| `backgroundSupervisor is required for chapter 13 or later` | A P13 profile without a Supervisor | Check whether you assembled it yourself and bypassed `cli.ts` |
| `backgroundSupervisor requires chapter 13 or later` | A Supervisor passed to P12 or earlier | Remove that argument |
| The command truly entered the background, but `read_file` still waited a long time | The fast command is itself slow (for example, it reads a huge file) | Measure `read_file` alone with `Measure-Command` |
| The `shell` arguments contain no `run_in_background` | You are running ch12 or earlier | Confirm that the command is `npm run ch13` |
| `Error [invalid_arguments]` when you query a job | The `job_id` is uppercase or malformed | Use the id exactly as the placeholder result returned it |
| `Error [background_capacity]` | More than 4 running jobs at the same time | Wait for one to finish, or cancel one |
| `Error [background_close_timeout]` | Not all workers closed within 10 seconds | Check whether a command is stuck; this error itself is a normal alarm |
| `Error [background_storage_error]` | A bad JSON file sits in the directory | See "One bad file poisons the whole directory" below |
| An event appears twice | This does not happen in normal operation | If you truly meet it, check whether two Supervisor instances share one directory |
| Occasional `EBUSY` / `EPERM` on Windows | An antivirus program or an indexing service holds the file | The persistence layer already retries up to 100 times internally; if it persists, exclude the working directory from scanning |

### One bad file poisons the whole directory

This one gets its own section, because its behavior is counterintuitive.

Place a malformed file into `.agent_tutorial\background\` by hand:

```powershell
Set-Content -Path .agent_tutorial\background\00000000-0000-4000-8000-0000000000ff.json -Value "{ broken" -Encoding utf8
```

Then query a **completely normal** job:

```text
Error [background_storage_error]: Background job file is invalid: 00000000-0000-4000-8000-0000000000ff.json
```

**Reading the good file also fails**, and the error names the bad file, not the id that you queried. Because `#loadJobs` parses the whole directory, and any one bad file makes the whole operation throw. `listJobs` behaves the same way.

This is the **fail closed** principle that Chapter 12 set: a state directory is either completely trustworthy or completely unusable. Compared with "skip the bad file and continue", its benefit is that it never returns a result that silently misses a few records — **incomplete state is far more dangerous than an explicit failure.**

The cleanup method is to delete that file:

```powershell
Remove-Item .agent_tutorial\background\00000000-0000-4000-8000-0000000000ff.json
```

---

## 7 hands-on experiments

I produced every conclusion above by running scripts, not by reasoning. This section hands those scripts to you.

Each experiment is short. The purpose of each one is to **turn an abstract rule into one line of output that you see with your own eyes**. Do them in order, because the later ones use the intuition that the earlier ones build.

### Preparation: create a probe script first

First create a file under `code/scripts/`. All later experiments add code to it.

```powershell
cd F:\笔记\Agent实操\code
New-Item -ItemType File -Path scripts\probe-ch13.mts
```

The shared header of the script (common to all experiments):

```ts
// scripts/probe-ch13.mts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JobSupervisor,
  AsyncJobExecutor,
  shouldRunInBackground,
} from "../chapters/ch13/src/features/background.ts";
import { JsonBackgroundJobStore } from "../chapters/ch13/src/adapters/background-json.ts";
import { EventInbox } from "../chapters/ch13/src/core/events.ts";

// Each experiment runs in its own temporary directory, so they do not disturb each other
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ch13-probe-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Produce predictable ids like ...0301 and ...0302, so you can compare the output easily
function makeSequenceIdGenerator(start = 0x301): () => string {
  let next = start;
  return () => {
    const tail = next.toString(16).padStart(12, "0");
    next += 1;
    return `00000000-0000-4000-8000-${tail}`;
  };
}
```

`makeSequenceIdGenerator` is the key convenience of this section: a real run uses `randomUUID`, so every output differs and comparison is hard. Replace the `idGenerator` / `eventIdGenerator` with an increasing sequence, and the ids that you see match the ones in this article exactly.

> This is also why `JobSupervisor` makes the two id generators injectable parameters — not for a business need, but to **let tests and probes obtain deterministic output**.

Run everything in the same way:

```powershell
npx tsx scripts\probe-ch13.mts
```

### Experiment 1: which commands the heuristic truly recognises

**What to verify**: keyword matching is substring matching, not command parsing. It misses some commands that you expect it to hit.

```ts
const commands = [
  "npm install",
  "NPM Install openai",     // Case is normalised first
  "pytest -q",
  "cd frontend && npm install",  // Substring hit
  "npm ci",                 // Note this one
  "npm test",               // And this one
  "Get-ChildItem",
];

for (const command of commands) {
  const hit = shouldRunInBackground({ command, run_in_background: null });
  console.log(`${hit ? "background" : "synchronous"}  ${command}`);
}
```

Measured output:

```text
background  npm install
background  NPM Install openai
background  pytest -q
background  cd frontend && npm install
synchronous  npm ci
synchronous  npm test
synchronous  Get-ChildItem
```

**Look at lines 5 and 6.** `npm ci` and `npm test` are genuinely slow operations, but the keyword table contains only `npm install`, so they run synchronously.

This is not a bug. It is the **inherent cost of a heuristic**: it covers only the entries that you wrote into the table. The list is at `background.ts:19`:

```ts
const BACKGROUND_MARKERS = Object.freeze([
  "cargo build",
  "compile",
  "deploy",
  "docker build",
  "npm install",
  "pip install",
  "pytest",
]);
```

What would you do? Two choices, with different costs:

| Method | Cost |
| --- | --- |
| Add `npm ci` and `npm test` to the table | The table grows longer and longer, and it will always miss new build tools |
| Let the model pass `run_in_background: true` explicitly | It depends on the judgement of the model, but the coverage has no upper bound |

P13 chooses to **keep both** — the table catches the most common cases, and the explicit parameter catches the rest. That is the next experiment.

### Experiment 2: an explicit parameter always overrides the heuristic

**What to verify**: in the tri-state parameter, `true` and `false` are commands, not suggestions.

```ts
const cases = [
  { command: "npm install", run_in_background: false },  // It clearly hits a keyword
  { command: "Get-ChildItem", run_in_background: true }, // It clearly should not go to the background
  { command: "npm install", run_in_background: null },   // Leave it to the heuristic
];

for (const input of cases) {
  console.log(`${shouldRunInBackground(input)}\t${JSON.stringify(input)}`);
}
```

Measured output:

```text
false	{"command":"npm install","run_in_background":false}
true	{"command":"Get-ChildItem","run_in_background":true}
true	{"command":"npm install","run_in_background":null}
```

Line 1 is the key: `npm install` hits the keyword table, but because the model explicitly said `false`, it still runs synchronously.

The corresponding implementation is three lines (`background.ts:700`):

```ts
export function shouldRunInBackground(input: BackgroundShellInput): boolean {
  if (input.run_in_background !== undefined && input.run_in_background !== null) {
    return input.run_in_background;
  }
  const command = input.command.toLowerCase();
  return BACKGROUND_MARKERS.some((marker) => command.includes(marker));
}
```

Note that the first line excludes both `undefined` and `null` — **"not passed" and "passed as null" mean the same thing here**: both say "I make no decision; you judge". The `.default(null)` in the Zod schema normalises the former into the latter, so the downstream code checks one case only.

### Experiment 3: after a permission denial, the disk must hold nothing

**What to verify**: on the denial path, no job file exists, and no command truly executes.

This experiment runs the complete Loop, so the script is longer. The key is two accounting variables:

```ts
// Record whether the command truly executed
let commandCalls = 0;
const commandRunner = {
  async run(command: string) {
    commandCalls += 1;
    return { output: "You should not see this line", exitCode: 0, timedOut: false, truncated: false };
  },
};

// A permission policy that denies everything
const denyPolicy = {
  async decide() {
    return new PermissionDecision("deny", "probe deny", "probe");
  },
};
```

Then let the model request one background shell call. After the run, check two things:

```ts
console.log(`commandRunner call count: ${commandCalls}`);
console.log(`Job count on disk: ${(await store.listJobs()).length}`);
```

Measured output:

```text
Error [permission_denied]: probe deny
commandRunner call count: 0
Job count on disk: 0
```

All three lines matter:

1. The model receives an **ordinary error tool result**, not a crash.
2. **The command never ran even once** — zero side effects.
3. **No job record exists on disk** — no ghost state.

Point 3 is the easiest place to get wrong. If an implementation calls `submit()` first and checks the permission afterwards, a denied call also leaves a file in `.agent_tutorial\background\`. At the next process start, the recovery logic turns it into `interrupted` and publishes an event to the model — **a denied operation surfaces in the next session instead.**

The order is fixed in `#executeTool` at `loop.ts:430`:

```text
prepare → runPreTool → permissionPolicy.decide → dispatch
                              ↑
                        A denial returns here,
                        and the later dispatch is never called
```

### Experiment 4: a second closure is refused

**What to verify**: when "timeout" and "completion" arrive at the same time, the conditional migration lets only one of them write.

```ts
await withTempDir(async (dir) => {
  const store = new JsonBackgroundJobStore(dir);
  const jobId = "00000000-0000-4000-8000-000000000301";

  await store.createRunning({
    jobId,
    sourceToolCallId: "probe-call",
    toolName: "shell",
  });

  const first = await store.finishRunning(jobId, "completed", {
    content: "done",
    isError: false,
  });
  const second = await store.finishRunning(jobId, "timed_out", {
    content: "too slow",
    isError: true,
    errorCode: "background_timeout",
  });

  console.log(`First call returned: ${first === undefined ? "undefined" : first.status}`);
  console.log(`Second call returned: ${second === undefined ? "undefined" : second.status}`);
  console.log(`Final state on disk: ${(await store.getJob(jobId)).status}`);
});
```

Measured output:

```text
First call returned: completed
Second call returned: undefined
Final state on disk: completed
```

**The second call returns `undefined`, and it does not throw.**

This "quietly do nothing" behavior is deliberate. Recall the call site of `#publishEvent`:

```ts
const job = await this.#store.finishRunning(jobId, status, result);
if (job !== undefined) {
  this.#publishEvent(job);
}
```

The late side receives `undefined`, so it **skips event publication**. On the whole race path, the event is published exactly once — no more, no fewer.

If this site threw an exception instead, the `catch` branch of `#runJob` would need another `try/catch` layer to swallow it, and the code would become dirty at once. Expressing "you arrived too late" with a return value is more suitable than an exception, because **this is not an error; it is a normal race result**.

### Experiment 5: a full capacity fails at once

**What to verify**: the fifth job does not queue. It fails directly.

```ts
await withTempDir(async (dir) => {
  const supervisor = new JobSupervisor({
    store: new JsonBackgroundJobStore(dir),
    executor: new AsyncJobExecutor(),
    inbox: new EventInbox(),
    idGenerator: makeSequenceIdGenerator(),
    // Do not pass capacity; use the default value 4
  });

  // Submit 4 jobs that never end, and fill the capacity.
  // Note that it listens to the signal — see the "extra experiment" below for the reason
  const never = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  for (let i = 0; i < 4; i += 1) {
    await supervisor.submit({
      sourceToolCallId: `call-${i}`,
      toolName: "shell",
      operation: never,
    });
  }
  console.log(`activeCount: ${supervisor.activeCount}`);

  try {
    await supervisor.submit({
      sourceToolCallId: "call-5",
      toolName: "shell",
      operation: never,
    });
  } catch (error) {
    console.log(`${(error as Error).constructor.name}: ${(error as Error).message}`);
  }

  await supervisor.close();  // Cancel those 4
  console.log(`activeCount after close: ${supervisor.activeCount}`);
});
```

Measured output:

```text
activeCount: 4
BackgroundCapacityError: Background job capacity 4 is full
activeCount after close: 0
```

On the model side, the visible text is `Error [background_capacity]: Background job capacity 4 is full` — **an error that it can read and decide on by itself**. It can choose to wait a while, to query the existing jobs, or to run synchronously instead.

Compare the "queue" design: after submission, the model receives a job id and the submission looks successful, but that task may lie in the queue for 5 minutes. The model does not know, and the user does not know. **A queue that pretends to succeed is harder to debug than an honest failure.**

### Extra experiment: what if a task ignores the signal

Why does the `never` above listen to the `signal`? Remove the listener and try.

```ts
const supervisor = new JobSupervisor({
  store: new JsonBackgroundJobStore(dir),
  executor: new AsyncJobExecutor(),
  inbox: new EventInbox(),
  idGenerator: makeSequenceIdGenerator(),
  closeTimeoutMs: 1_000,  // Shorten the wait, so the behavior is easy to observe
});

await supervisor.submit({
  sourceToolCallId: "deaf-call",
  toolName: "shell",
  operation: () => new Promise<never>(() => {}),  // Completely ignores the signal
});

const started = Date.now();
try {
  await supervisor.close();
} catch (error) {
  console.log(`${(error as Error).constructor.name}: ${(error as Error).message}`);
  console.log(`Waited about ${Math.round((Date.now() - started) / 100) * 100}ms`);
}
console.log(`activeCount is still: ${supervisor.activeCount}`);
```

Measured output:

```text
BackgroundCloseTimeoutError: Managed tasks did not stop before close timeout
Waited about 1000ms
activeCount is still: 1
```

**This is the true meaning of "cooperative cancellation".** `close()` can do three things only:

```text
1. Call control.cancel() on every job   ← send the signal
2. Wait for all managedTasks to end            ← wait for them to stop voluntarily
3. Throw BackgroundCloseTimeoutError on timeout ← report honestly when the wait fails
```

It has **no** fourth thing — no force kill. JavaScript has no mechanism to "kill a Promise". An `await` that never checks the `signal` is simply beyond your control.

So P13 chooses: **say clearly that the wait failed, instead of pretending that everything closed cleanly.** When this error message appears, you should investigate which operation did not respond to the interruption, instead of increasing the timeout.

Also note `activeCount is still 1` — that worker truly still runs. The resource-close convention of Chapter 12 is "close on a best-effort basis + report honestly", not "guarantee the close". This distinction matters when you write close logic: **after your `close()` throws, the process may still need `process.exit()` to truly exit.**

**Run this experiment yourself, and you will see this with your own eyes.** The three output lines above print within 1 second, but the `npx tsx` process **hangs for another 119 seconds before it exits** — about 120 seconds in total. The script is not stuck. This is the reverse demonstration of the earlier sentence "the `timeoutHandle.cancel()` call is critical":

```text
control.cancel()  → cancelled reject → enter the cancellation branch of catch
controller.abort()                   → but this operation ignores the signal
await execution.catch(...)           → waits forever, stuck on this line
                                     → the finally block never runs
                                     → timeoutHandle.cancel() never executes
                                     → that 120s timer stays on the event loop
```

Measured: add `timeoutMs: 3_000` to the constructor arguments, and the process exits in 3.0 seconds instead — **how long the process outlives the work equals exactly how much of `timeoutMs` remains**. So if you want to run this experiment repeatedly and quickly, reduce `timeoutMs` as well.

This also explains why that `finally` block must exist: on the normal path (a command that finishes in 3 seconds), it clears the timer, so the process can exit at once. Only in the pathological case of "an operation that ignores even abort" does its turn never come.

### Experiment 6: cancel a job that already ended

**What to verify**: `cancel` works only on `running`. For a terminal state, it returns an error that carries the state.

```ts
const jobId = await supervisor.submit({
  sourceToolCallId: "probe-call",
  toolName: "shell",
  operation: async () => ({ content: "done in a second", isError: false }),
});

// Wait for it to end naturally
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`Current status: ${(await supervisor.getJob(jobId)).status}`);

try {
  await supervisor.cancel(jobId);
} catch (error) {
  console.log(`${(error as Error).message}`);
}
```

Measured output:

```text
Current status: completed
Background job 00000000-0000-4000-8000-000000000301 is completed; expected running
```

**The error message carries the actual state.** This is not casual writing; it is deliberate: when the model sees `is completed; expected running`, it knows "oh, it already finished; I should query the result instead of cancelling". If the message said only `cannot cancel`, the model could only guess.

The implementation uses the "check memory first, then check the disk" order (the `cancel` method in `background.ts`):

```ts
const control = this.#jobControls.get(normalized);
if (control === undefined) {
  const job = await this.#store.getJob(normalized);
  throw new BackgroundJobStateError(
    `Background job ${job.id} is ${job.status}; expected running`
  );
}
control.cancel();
await control.task;
```

`#jobControls` holds live jobs only, so a miss means the job already closed. The code then reads the disk once, and it can place the accurate state into the error message.

Note the last two lines in passing: after `cancel()`, the code still runs `await control.task`. **Cancellation is not "send the signal and return"; it is "wait until it truly stops"** — otherwise, after the caller's `await` ends, that job might still be writing to the disk.

### Experiment 7: crash recovery publishes one event only

**What to verify**: a leftover `running` job becomes `interrupted`, and the system publishes exactly one event.

This experiment has two parts. It simulates "the process crashed and then started again":

```ts
await withTempDir(async (dir) => {
  // ---- Part one: create a leftover running job ----
  const store = new JsonBackgroundJobStore(dir);
  await store.createRunning({
    jobId: "00000000-0000-4000-8000-000000000301",
    sourceToolCallId: "call-a",
    toolName: "shell",
  });
  // Do not call finishRunning here; simulate a killed process

  // ---- Part two: a new process starts ----
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({
    store: new JsonBackgroundJobStore(dir),
    executor: new AsyncJobExecutor(),
    inbox,
    eventIdGenerator: makeSequenceIdGenerator(0x302),
  });

  await supervisor.ready();          // Wait for recovery to finish
  const events = inbox.drain();
  console.log(`Recovery event count: ${events.length}`);
  console.log(JSON.stringify(events[0]?.toPayload(), null, 2));

  // Drain once more, and confirm that nothing repeats
  console.log(`Second drain: ${inbox.drain().length}`);
  await supervisor.close();
});
```

Measured output:

```text
Recovery event count: 1
{
  "event_id": "00000000-0000-4000-8000-000000000302",
  "job_id": "00000000-0000-4000-8000-000000000301",
  "kind": "background_job",
  "result": {
    "content": "Error [background_interrupted]: Background job was interrupted by a previous process exit",
    "error_code": "background_interrupted",
    "is_error": true
  },
  "source_tool_call_id": "call-a",
  "status": "interrupted",
  "tool_name": "shell"
}
Second drain: 0
```

Three details:

1. **`await supervisor.ready()`** — recovery is an asynchronous operation that starts in the constructor. Without this wait, a drain can return empty.
2. **The `status` is `interrupted`, and the `error_code` is `background_interrupted`** — the model can distinguish "I cancelled it" from "the last process crashed".
3. **The second drain is 0** — the event was consumed, and it is not injected again.

Try one more thing: run part two again (the same directory, a new Supervisor).

```ts
const inbox2 = new EventInbox();
const supervisor2 = new JobSupervisor({
  store: new JsonBackgroundJobStore(dir),
  executor: new AsyncJobExecutor(),
  inbox: inbox2,
  eventIdGenerator: makeSequenceIdGenerator(0x400),
});
await supervisor2.ready();
console.log(`Second-round recovery event count: ${inbox2.drain().length}`);
```

Measured output:

```text
Second-round recovery event count: 0
```

Because that job is already in the `interrupted` terminal state, `interruptRunning()` skips it. **Recovery is idempotent** — crash 5 times in a row and start again, and the model still receives one interruption notice, not 5.

This matters in practice: the recovery logic runs at every start. If it were not idempotent, the context of the model would fill up with historical garbage.

---

## What this chapter deliberately does not do

A capability list easily makes people believe that "background tasks" are finished. In fact, P13 lays only the foundation. Several things are **explicitly decided against**. Distinguish "not done" from "cannot be done", because that distinction decides what you can still safely add on top of this code.

| Thing not done | Why it is not done | The current substitute |
| --- | --- | --- |
| Preemptive cancellation | JavaScript has no mechanism to force-kill a Promise | Cooperative: send a signal + wait + report a timeout error |
| Pass the `signal` to a tool handler | Adding a field to `ToolContext` affects every tool | Race at the Supervisor layer only; the tool itself does not perceive it |
| Task queueing | Queueing turns "submission succeeded" into a lie | Report `background_capacity` when the capacity is full |
| Progress events (0%→100%) | They need a tool-side protocol, which is outside the scope of this chapter | One terminal-state event only |
| Cross-process job sharing | It needs real IPC or a daemon | One Supervisor per process, with recovery as the fallback |
| Background capability for subagents | It makes job ownership and lifecycle complex | Subagents run synchronous tools only |
| Automatic retry | A retry policy is a business decision, not a runtime responsibility | Report the terminal state truthfully; the model decides on a retry itself |

### A special note on "progress events"

The first reaction of many people is "a background task must of course report progress". But think about that event path:

```text
Every progress update → one RuntimeEvent → one user message → inserted into the history
```

A build task that runs for 3 minutes and reports progress once per second inserts 180 messages into the context. **The progress bar eats the context budget.**

If you truly need progress, the correct method is not "publish more events". It is "let the model query actively" — and that is exactly why `query_background_job` exists. The model queries once when it wants to know the progress, and it does not query when it does not. **Pulling costs less context than pushing.** This is a place where the Agent scenario differs greatly from an ordinary UI scenario.

### "Not done" does not mean "not considered in the design"

Note the signature of `BackgroundOperation`:

```ts
export type BackgroundOperation = (signal: AbortSignal) => Promise<ToolResult>;
```

The `signal` is always there. `JobExecutor.execute` also always receives it. **The path is open; `BackgroundDispatcher` simply does not connect it to `tools.invoke`**:

```ts
operation: async () => await this.#tools.invoke(prepared, context)
//                     ↑ the outer signal is not used here
```

So if a future version needs "tools that perceive interruption", the change points are exactly two: add a `signal` field to `ToolContext`, and fill it in `dispatch`. **Not done, but the position is reserved** — and that is a different matter from "the architecture cannot do it at all".

---

## Differences from Claude Code

P13 is a teaching implementation. Claude Code is a product. Their differences on this capability show exactly where "the teaching version is sufficient" and where "the product version must do more".

| Dimension | P13 | Claude Code |
| --- | --- | --- |
| Background decision | 7 keywords + a tri-state parameter | Mainly the autonomous judgement of the model, with no hard-coded table |
| Process model | Coroutines in the same process | Real child processes / shell sessions |
| Output retrieval | One return at the terminal state | Incremental reading of output while it runs |
| Cancellation | Cooperative; a timeout error when the wait fails | Can truly kill the process |
| Capacity | Fixed at 4; an error when full | Dynamic management |
| Across sessions | Disk recovery to `interrupted` | A background shell can persist across turns |
| Event injection | A terminal-state event as a user message | Output changes can be polled actively |

### One root cause behind the differences

The differences look numerous, but at the root they are one thing: **a background task in P13 is "a Promise", and a background task in Claude Code is "a process".**

```text
P13:          Promise ──── cooperative interruption only; it can only wait for the task to end by itself
Claude Code:  Child process ──── it has a pid, it can be killed, and its stdout stream can be read
```

Once it is a real process, cancellation becomes `kill(pid)`, incremental output becomes reading the stdout pipe, and cross-session persistence becomes "the process still exists; reconnect". **These three "product-level capabilities" are all by-products of the same decision.**

### Why P13 does not use child processes

Because the thing that this chapter teaches is not there. Child processes immediately introduce a pile of complexity that is unrelated to the theme:

- Cross-platform process management (killing a process tree on Windows is especially troublesome)
- Buffering, encoding, and truncation of stdout / stderr streams
- Orphan process cleanup
- Maintenance of the mapping between processes and job records

These are all real problems, but they are problems of **"how to manage processes"**, not problems of **"how the Agent continues to work while it waits"**. The latter is the theme of this chapter, and coroutines demonstrate it completely: the state machine, event feedback, conditional migration, and crash recovery — **switch to child processes, and not one of these rules changes.**

So the architecture that you learn from this chapter transfers directly to a child-process implementation. Only the internal implementation of `BackgroundOperation` needs replacement.

---

## What to learn from the Flux experiment in ai-agent-book

`ai-agent-book/chapter4/async-agent/README.md` is the event-driven asynchronous framework that accompanies experiment 4-5 of *Understanding AI Agents in Depth*. Its code name is Flux. It follows the same route as this chapter: **an asynchronous tool returns a placeholder `task_id` first, and after the task completes, the system injects the result into the trajectory as a new event.**

This section deserves its own look, because it shows you "the same problem, with a different reasonable solution". P13 directly adopted two ideas from it: query/cancel of background tasks by id, and one batch injection of several ready events.

### The experiment design of Flux

Flux adds one more layer than P13: **event urgency classification.**

```text
INTERRUPT  → Cancel the current turn and all background tasks at once
IMMEDIATE  → Answer at once, but do not interrupt the background tasks
DEFERRED   → Enter a pending buffer; append in one batch when the asynchronous results arrive
```

Its experiment design is also careful. **It first runs three offline demonstrations that need no API key**:

1. A wall-clock time comparison of parallel vs serial execution
2. Recovery after an interruption
3. Checkpoint recovery across sessions

Only then does it use four real LLM scenarios to verify asynchronous execution, event batching, interruption, and progress-based cancellation.

For persistence, Flux saves `trajectory + task progress`. At recovery, it marks running tasks as `suspended`, and **it lets the upper layer decide whether to rerun or to resume**.

### The comparison and the trade-offs of P13

Five dimensions of comparison. Each one is an explicit trade-off:

| Dimension | Flux | P13 | Why P13 chooses this |
| --- | --- | --- | --- |
| Query/cancel | `query_task` / `cancel_task`, with streaming progress queries | `query_background_job` / `cancel_background_job`; `result: null` while running | Without progress, no progress protocol needs maintenance |
| Batch events | A separate pending buffer + urgency classification | `drainEvents()` takes the whole batch, deduplicates by `eventId`, with `batch` positions | One buffer layer fewer; events become uniformly visible before the next model request |
| Interruption | The user can `INTERRUPT` to cancel the current LLM turn | An explicit cancel tool only + unified cancellation at close | Interrupting the current model request requires a change to the core timing of the Loop |
| Persistence | A complete trajectory + progress; recovery to `suspended` | One terminal-state JSON per job; leftover running → `interrupted` | A terminal-state snapshot is sufficient, and no intermediate progress needs recovery |
| Safety boundary | Whitelisted Python child processes only; no shell calls | A real PowerShell tool that already passed Hook, permission, and approval | Because it runs a real tool, capacity, timeout, and close boundaries are mandatory |

### The difference that deserves the most attention: suspended vs interrupted

These two words look like synonyms, but they represent **completely different divisions of responsibility**.

```text
Flux:  running → suspended  ← "not finished yet; the upper layer decides whether to rerun or to resume"
P13:   running → interrupted ← "already finished; the conclusion is failure"
```

`suspended` is an **intermediate state**. It means that the framework promises to keep enough information for the task to resume. That requires you to persist progress, arguments, and even partial output — the cost is a more complex persistence format, and "resume" does not even hold for many operations (what does it mean to resume an `npm install` that was killed in the middle?).

`interrupted` is a **terminal state**. It means that the framework promises only "to tell you that it did not finish". For a retry, the model calls the tool once more — **the retry strategy returns to the hands of the model, and the runtime does not guess.**

Recall the invariant from the six-states section: `running` is the only live state. Introduce `suspended`, and that invariant breaks. `hasPendingWork`, event publication, and the recovery logic all need rethinking. **P13 exchanges "one state fewer" for "no resume capability"**, and that exchange is worthwhile in a teaching scenario.

### Why the safety-boundary row is the easiest to overlook

Flux runs whitelisted Python child processes only, so it does not need to care much about "what a background task will do". P13 runs **a real shell tool** in the background: one `docker build` can run for 10 minutes, fill the CPU, and write a pile of files.

So P13 must have three things that Flux does not need:

```text
Capacity 4       ← prevents the model from submitting 50 builds in one breath
Timeout 120s    ← prevents a stuck command from holding a slot forever
Close timeout   ← prevents a process that cannot exit
```

This is a general rule: **the more dangerous the things that your background tasks can do, the more boundaries you need.** If one day you connect the background capability of P13 to a tool that can truly delete files or truly send network requests, all three numbers need a new evaluation.

This part does not copy Flux. It absorbs its three ideas — "slow background operations can be queried, cancelled, and returned in batches" — into the persistent job state machine of P13.

---

## Companion code index

| File | Lines | Role in this chapter |
| --- | --- | --- |
| [features/background.ts](code/chapters/ch13/src/features/background.ts) | 786 | The core of the whole chapter. The `BackgroundJob` domain model, the six states, the seven typed errors, `JobSupervisor`, `BackgroundDispatcher`, the two job tools, `shouldRunInBackground` |
| [adapters/background-json.ts](code/chapters/ch13/src/adapters/background-json.ts) | 520 | `JsonBackgroundJobStore`: the conditional migration of `finishRunning`, the batch recovery of `interruptRunning`, the four-layer lock of `#withLock`, atomic replacement |
| [core/events.ts](code/chapters/ch13/src/core/events.ts) | 100 | The `RuntimeEvent` contract, the typed-only FIFO of `EventInbox`, `runtimeEventMessage` turns an event into a user message |
| [core/loop.ts](code/chapters/ch13/src/core/loop.ts) | 629 | The `RuntimeEventPump` contract, the two injection points, the deduplication and batching of `#acceptNextRuntimeEvent`, the permission-first order of `#executeTool` |
| [features/builtin-tools.ts](code/chapters/ch13/src/features/builtin-tools.ts) | 231 | The dual-schema branch of `createShellTool(runner, background)` and the `concurrency` marker |
| [bootstrap.ts](code/chapters/ch13/src/bootstrap.ts) | 317 | The composition root. The two-way pairing of `background` ↔ `backgroundSupervisor`, one Supervisor instance in three roles, the hard-coded `false` for subagents |
| [cli.ts](code/chapters/ch13/src/cli.ts) | 251 | The real entry point. It decides from the capability bit whether to construct the Supervisor and the store |
| [core/profiles.ts](code/chapters/ch13/src/core/profiles.ts) | 282 | The capability-bit definition `P13 = P12 + "background"` |
| [tests/ch13-background.test.ts](code/chapters/ch13/tests/ch13-background.test.ts) | 599 | Tri-state judgement, typed-only inbox, success/exception/capacity/timeout/cancel/close, restart interruption, the two job tools, batch event positions (12 cases) |
| [tests/ch13-bootstrap.test.ts](code/chapters/ch13/tests/ch13-bootstrap.test.ts) | 84 | P13 dependency pairing, background tool registration, shell schema differences, resource wiring (1 case; one run asserts all four things) |
| [tests/ch13-entry.test.ts](code/chapters/ch13/tests/ch13-entry.test.ts) | 25 | The fixed entry point and all four missing-configuration items reported at once (1 case) |

The three new files of this chapter contain 14 cases in total. You can run them alone to check:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm exec vitest run chapters/ch13/tests/ch13-background.test.ts chapters/ch13/tests/ch13-bootstrap.test.ts chapters/ch13/tests/ch13-entry.test.ts
```

The whole-chapter `npm run test:ch13` run has 34 files and 285 cases — because the cumulative snapshot brings the tests of the first 12 chapters along.

### A suggested reading order for the code

Do not read `background.ts` from line 1 downward. 786 lines will bury you. Follow this order; every step is understandable on its own:

```text
① core/events.ts in full (100 lines)
   → Build the concept of "what an event is" first; this is the smallest piece

② The BackgroundJob constructor at background.ts:129
   → The eight invariants; see the legal shape of one job

③ shouldRunInBackground at background.ts:700
   → The tri-state judgement; the shortest piece of core logic in the chapter

④ submit at background.ts:375
   → The order "persist first, then start the worker"

⑤ #runJob at background.ts:479
   → The three-way race + the three catch branches

⑥ finishRunning at background-json.ts:109
   → Conditional migration; understand how "publish exactly once" is implemented

⑦ #acceptNextRuntimeEvent in loop.ts (line 564)
   → How an event returns to the history

⑧ tests/ch13-background.test.ts
   → Use the tests to check back whether you missed a branch
```

The first four steps are about 250 lines. After them, you understand roughly eighty percent of this chapter. The last four steps fill in the remaining details.

---

## Run and verification

Two entry points bind the same P13 Bootstrap:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch13 -- --prompt "Run npm install in the background, and read README.md at the same time; summarise after you get the result"
npm run agent-tutorial -- run --chapter 13 --prompt "Check which background tasks currently exist"
```

Five verification gates:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch13
npm run typecheck
npm run lint
npm run format:check
npm run build
```

The tests of this chapter cover asynchrony, races, and the real composition entry point: a `ManualExecutor` controls by hand when a task ends, and the tests assert the state-migration order; an `AbortAwareExecutor` verifies that the cancellation signal truly reaches the operation; a `CoordinatingModel` runs a complete three-turn conversation, and the tests assert the pairing relations of 7 messages; the tests inject atomic-write failures, bad JSON, non-canonical UUIDs, capacity exhaustion, and close timeouts. **No API Key is needed at any point, and no network access happens.**

The division of work between the three test files:

| Test file | Question it answers |
| --- | --- |
| `ch13-background.test.ts` | Is the state machine correct? Can a race write twice? How many times is an event published? |
| `ch13-bootstrap.test.ts` | Is the wiring correct? Does a wrong capability-bit pairing produce an error? Did a subagent receive the background capability? |
| `ch13-entry.test.ts` | When configuration is missing, is the error complete enough? |

---

## Chapter summary

### The three-sentence version

Chapter 13 lets the Agent continue to work while it waits for a slow operation. The method is: hand the slow operation to a managed `JobSupervisor`; the tool returns a placeholder result at once, so the protocol stays closed; after the task ends, wrap the terminal state as a typed event, and inject it as a user message into the same Loop before the next model request. Every approach that "looks more convenient" — queueing without an error, treating the event as a second tool result, submitting before the permission check, allowing an intermediate state `suspended` — loses correctness in some concrete scenario.

### Six rules that you must remember

1. **Permission comes before submission.** A denied call must have zero side effects and zero disk traces. With the wrong order, a denied operation surfaces as an `interrupted` event at the next start.
2. **The placeholder result closes the protocol, but it does not lie.** It says only "accepted; the id is X". It does not say "completed". The protocol requires one `tool` message for every `tool_call`, and this is the only form that satisfies both the protocol and the facts.
3. **One live state, five terminal states; terminal states are immutable.** `running` is the only live state. One intermediate state fewer means one whole class of "does this count as finished" judgements fewer.
4. **Conditional migration arbitrates races.** Whoever writes to the disk first fixes the terminal state. The late side receives `undefined` and quietly skips event publication. The event is published exactly once, and that rests not on an in-memory flag but on the state on disk.
5. **An event is a user message, not a tool result.** A background result no longer has a pairing relation with the original `tool_call`. Forcing it into a second `tool` message breaks the protocol directly.
6. **Cooperative cancellation; report honestly when the wait fails.** JavaScript has no mechanism to force-kill a Promise. `close()` can send a signal, wait, and report a timeout error. It does not guarantee a clean close; it guarantees only that it tells you the truth.

### Check whether you truly understood

Answer these eight questions without looking at the text above:

1. Why is `run_in_background` tri-state instead of a boolean? Is there a difference between `null` and not passing it?
2. Which two conditions must a tool satisfy at the same time to use the background path? What happens if it satisfies only one?
3. Why is the placeholder result a `toolSuccess` and not a `toolError`?
4. Why can a background job not become a fourth state of a Task?
5. "Timeout" and "completion" arrive in the same millisecond. Who wins? What happens to the losing side?
6. Why can the terminal state of a background task not be injected as a second `tool` message?
7. After the process is killed and restarted, what does a leftover `running` job become? What `error_code` does the model see?
8. When `close()` throws `background_close_timeout`, has that worker stopped?

If you cannot answer one, go back to the corresponding section:

| Question | Go back to |
| --- | --- |
| 1 | "Tri-state: each state represents one decision owner" |
| 2 | "Two gates; neither can be missing" |
| 3 | "Why it is a `toolSuccess` and not a `toolError`" |
| 4 | "Distinguish the three kinds of 'waiting'" |
| 5 | "The solution: let the store arbitrate" + Experiment 4 |
| 6 | "An event is a user message, not a second tool result" |
| 7 | "After a crash: where interrupted comes from" + Experiment 7 |
| 8 | "Extra experiment: what if a task ignores the signal" |

---

The next article enters Cron scheduling. Background tasks solve "a slow operation does not occupy the Loop", but the thing that triggers one is still a tool call from the model — **when nobody speaks, the Agent does nothing.** P14 adds a time-driven scheduler: expression parsing, time zones, and a persistent outbox. Then "check the dependency updates every day at nine in the morning" needs no human click. The event-boundary principle does not change. What changes is where the events come from.
