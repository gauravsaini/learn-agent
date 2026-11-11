Give an Agent a ten-step refactoring task.

It reads files, changes types, and runs tests first. At step three it hits a failure, and the error output takes over its attention. The test does get fixed in the end, but the other batch of files from the original request never gets touched, and the acceptance steps are forgotten too.

The task is still at the start of the conversation. It has not really disappeared. The problem is this: as tool results, file contents and error logs keep entering the context, the original plan appears only once, yet it must compete for the model's attention with a large amount of local detail.

This chapter adds one small but critical capability to the Agent: a session-level `todo_write`. It does not complete the task for the model. It only lets the model submit "the current complete plan snapshot" again and again, and it sends one reminder after three consecutive tool rounds pass without a plan update.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaFEj3lJzTL6GbS8x2FcoCjQXZ0M6IjrA7DtFIHpfWspialgtUOQA55WKqKHhtmsq2ia4DPV9M9SDjcKE3XxU6Gljd4icqV3Xa3gD8/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you will be able to do after this chapter

1. Explain why "write 'do not forget the plan' in the system prompt" does not work in long tasks, and what should replace it.
2. Explain why this chapter builds only one `todo_write` (full replacement) instead of a `todo_add` / `todo_update` / `todo_remove` set.
3. State why TODO state must belong to a session and not to a module, and what goes wrong if you make it a singleton.
4. Describe the full timing of the "stale reminder": which round triggers the count, which request receives the injection, and when the count resets after injection.
5. State why the reminder enters only the current request and never the formal history.
6. Explain why the `effect: "write"` of `todo_write` does not trigger a disk-write approval.

### What you need first

| What you need | Where it comes from | How to check |
| --- | --- | --- |
| The accumulated capabilities of Chapters 1–4 | The first four chapters | `npm run test:ch04` gives 12 files / 94 tests |
| Understand the `prepare → permission → handler` order | Chapter 3 | You can explain why validation must come before authorization |
| Understand that `tool_call_id` values must pair up | Chapter 2 | You can explain when `missing tool results for ids` appears |
| You can run the tests in `code/` | Chapter 1 | `npm ci` has been run |

### Quick term reference (terms that first appear in this chapter)

| Term | One-line explanation |
| --- | --- |
| **TODO snapshot** | A JSON document that shows "what the complete plan looks like at this moment". It is not "which items changed this time" |
| **`todo_write`** | The only new tool in this chapter. Its semantics are **full replacement** of the current plan |
| **`TodoTracker`** | A session-level object that holds the snapshot and the stale count. It acts as both the tool handler and the round observer |
| **`TodoStatus`** | Only three values: `pending` / `in_progress` / `completed` |
| **strict schema** | A Zod object with `.strict()`. An unknown field fails the validation at once |
| **`transform` then `pipe`** | The schema first runs `trim()` and then validates non-empty. The string `"   "` therefore fails in a stable way |
| **ASCII JSON** | Non-ASCII characters are written as `\uXXXX`. The same logical snapshot always produces the same text |
| **`effect: "write"`** | It declares "this tool changes state". **Which state it changes is the tool's own decision**. It does not mean a disk write |
| **`ToolRoundObserver`** | A small interface that the Loop knows. It has only two methods: `beforeModel()` and `recordToolRound()` |
| **tool round** | **All** tool calls in one assistant message count as one round, whether the message holds 1 call or 3 calls |
| **`STALE_TOOL_ROUNDS`** | The constant `3`. Three consecutive tool rounds without `todo_write` trigger a reminder |
| **Nag Reminder** | The system reminder with fixed wording. The runtime injects it only once |
| **request-level message** | A message that appears only in this one `ModelRequest`. It does not enter `#history` |
| **`invalid_arguments`** | The tool error code for a Zod validation failure. The handler never runs |

### Suggested reading route

```text
Chapter guide (you are here)
  ↓
① Look at one real run first     ← Submit a snapshot, what comes back, when the reminder appears
  ↓
② The real problem of long context        ← Why the system prompt fails
  ↓
③ Acceptance results + data flow          ← What this chapter must prove
  ↓
④ Sections 1–3: input contract and snapshot      ← Zod, full replacement, stable JSON
  ↓
⑤ Sections 4–5: state ownership and the system prompt   ← Why a singleton is wrong
  ↓
⑥ Sections 6–7: the reminder mechanism            ← Count by round, enter only the current request
  ↓
⑦ Sections 8–9: two boundaries that are easy to get wrong   ← write effect ≠ write approval; a failure does not break the old snapshot
  ↓
⑧ Sections 10–12: verify, run, observe   ← Hands-on work + troubleshooting + what to watch
  ↓
⑨ Sections 13–14 + summary           ← Differences from the official version and the reference book + self-test
```

---

## Look at One Real Run First

Do not look at code yet. Look at two concrete things first.

### One successful snapshot submission

The model sends this call:

```json
{
  "todos": [
    { "content": "  编写测试  ", "status": "in_progress" },
    { "content": "ship", "status": "completed" }
  ]
}
```

The tool result written into the history is this whole string (note: it is not "2 items updated"):

```text
{"todos":[{"content":"\u7f16\u5199\u6d4b\u8bd5","status":"in_progress"},{"content":"ship","status":"completed"}]}
```

Three details are worth remembering now. Each one maps to a later section:

| What you see | Reason | Where it is covered |
| --- | --- | --- |
| The spaces on both sides of `"  编写测试  "` are gone | The schema runs `trim()` first and validates after | Section 1 |
| The Chinese text became `\u7f16\u5199...` | The code keeps ASCII on purpose, so the text supports exact assertions | Section 3 |
| The result returns both items, not the difference | Full replacement semantics | Section 2 |

This call **did not open any approval dialog**, but it did produce one audit record:

```text
PermissionDecision("allow", "No permission rule blocked the request", "default")
```

"No dialog, but the request passes the policy and leaves an audit record" — Section 8 explains this difference between the `write` effect and a write approval.

### Which request actually receives the reminder

Assume the model reads files four times in a row and never updates the plan. The real timeline looks like this:

```text
Request 1  ← No reminder            (No tool round has run yet)
  ↓ The model calls read_file        Count 0 → 1
Request 2  ← No reminder
  ↓ The model calls read_file        Count 1 → 2
Request 3  ← No reminder
  ↓ The model calls read_file        Count 2 → 3   ← The threshold is reached
Request 4  ← ✅ One system reminder is injected, and the count resets to zero at once
  ↓ The model calls read_file        Count 0 → 1
Request 5  ← No reminder            (Even though the model still has not updated the plan)
```

Pay special attention to two points. Readers get these two points wrong most often in this chapter:

- **"The count reaches 3" and "the reminder is injected" do not happen in the same request.** The third stale tool round must finish before the count becomes 3. The reminder therefore appears in **request 4**.
- **The reminder appears only once.** The count resets to zero at the moment of injection, so request 5 is clean. To get another reminder, the model must collect three more stale tool rounds.

And you **cannot find this reminder in `result.history`**. It lives only in the message array of the fourth `ModelRequest`. A test asserts this directly; see Section 10.

---

## First, Be Clear: a Longer Context Does Not Mean "Later Means More Important"

The Transformer computes attention dynamically from content. You cannot simply read it as "later tokens are always more important than earlier tokens". But three very practical problems do appear in long tasks:

- Tool output keeps growing, so the early goal must compete with more content for attention;
- Similar logs and local errors appear again and again, so the model more easily keeps generating around the problem in front of it;
- The original plan only describes "what to do". It does not keep providing "how far the work has got".

So one line in the system prompt, "do not forget the plan", is not enough. It can only state a principle. It cannot store task state.

The approach in this chapter turns the plan into structured state. The tool result then puts the latest snapshot back into the message flow. In the next round, the model sees not only the original goal, but also the most recent progress that it submitted explicitly.

The capability boundary still needs a clear statement: a TODO can reduce the chance of drift. It cannot prove that the task is complete. Tests, static checks or other observable acceptance steps must still confirm the final result.

---

## What This Chapter Must Produce

Chapter 5 builds on the first four chapters. It keeps the file tools, the permission policy and the four Hooks, and it adds only the `TODO` capability.

There are four observable acceptance results:

1. `todo_write` returns the stable JSON snapshot of the whole TODO list every time. It does not return only the changes from this call;
2. An invalid update does not overwrite the old snapshot;
3. Each Agent session owns independent state;
4. After three consecutive rounds of other tools, the next model request receives only one temporary reminder.

The failure boundaries are equally explicit: `todos` is not an array, the content is empty, the status is unknown, the list has more than 50 items, an unknown field is present, or `arguments` is not valid JSON. In every case, the handler must not change the state.

The overall data flow looks like this:

```text
assistant tool_calls
        │
        ▼
ToolRegistry parses the JSON + Zod validation
        │
        ├── Failure ──> A paired tool error; the old snapshot does not change
        │
        ▼
Permission / Hook / handler
        │
        ▼
TodoTracker atomically replaces the complete snapshot
        │
        ▼
Stable JSON enters the formal history as the tool result
```

The reminder takes another path:

```text
One tool round completes
    │
    ├── This round has todo_write ──> The count resets to zero
    │
    └── This round has no todo_write ──> The count increases by one
                                  │
                                  └── The count reaches 3: the next model request temporarily receives a system reminder
```


---

## 1. Define the Single Input Contract with Zod

The implementation lives in `code/chapters/ch05/src/features/todos.ts`. First, define the allowed statuses and the count limit:

```typescript
export const MAX_TODOS = 50;
export const STALE_TOOL_ROUNDS = 3;
export const TODO_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
] as const);

export type TodoStatus = (typeof TODO_STATUSES)[number];
```

`as const` keeps the three string literals, so `TodoStatus` is:

```typescript
type TodoStatus = "pending" | "in_progress" | "completed";
```

Next, describe the tool parameters with a strict Zod schema:

```typescript
const todoItemSchema = z
  .object({
    content: z
      .string()
      .transform((content) => content.trim())
      .pipe(z.string().min(1, "todo content must not be empty")),
    status: z.enum(TODO_STATUSES),
  })
  .strict();

const todoWriteSchema = z
  .object({
    todos: z.array(todoItemSchema).max(MAX_TODOS),
  })
  .strict();

export type TodoItem = Readonly<z.output<typeof todoItemSchema>>;
type TodoWriteInput = z.output<typeof todoWriteSchema>;
```

This schema does several things at the same time:

- `content` must be a string;
- The schema runs `trim()` first and then checks that the result is not empty;
- `status` can only be one of the three known values;
- Each submission holds at most 50 items;
- Both `.strict()` layers reject unknown fields.

Why `transform` first and `pipe` second? If the code ran `min(1)` on the original string directly, `"   "` would pass the length check. The current order removes the whitespace first and validates after, so the string fails in a stable way.

More importantly, `ToolDefinition` holds this schema directly. `ToolRegistry` uses it to generate the JSON Schema sent to OpenAI, and it also uses it to validate input before dispatch. The code does not maintain a separate hand-written parameter type. The contract that the model sees and the contract that the handler receives come from the same source.

Invalid JSON fails earlier: the Registry parses `tool_call.arguments` first. A parse failure returns `invalid_json`. A value that parses but does not match the Zod schema returns `invalid_arguments`. Neither path calls the handler.

`ToolRegistry.openAITools()` reuses the same schema: the `parameters` that the model sees come from `z.toJSONSchema(definition.inputSchema)`, and the runtime passes them to `prepare()` for a `safeParse` at run time.

During development you maintain only one type contract. The model declaration, the permission policy and the parameters that the handler receives cannot drift apart through manual synchronisation.

---

## 2. One Submission Must Be a Complete Snapshot

This chapter does not design three incremental interfaces, `todo_add`, `todo_update` and `todo_remove`. It provides only one full replacement tool:

```typescript
export class TodoTracker {
  #todos: readonly TodoItem[] = Object.freeze([]);
  #nonTodoToolRounds = 0;
  readonly toolDefinition: ToolDefinition<TodoWriteInput>;

  constructor() {
    this.toolDefinition = Object.freeze({
      name: "todo_write",
      description: "Replace the current TODO list with a complete task snapshot.",
      inputSchema: todoWriteSchema,
      effect: "write",
      handler: (input: TodoWriteInput) => this.#writeTodos(input),
    });
  }

  get todos(): readonly TodoItem[] {
    return this.#todos;
  }

  #writeTodos(input: TodoWriteInput): ToolResult {
    // Validates completely with Zod first, then replaces snapshot in one step; failure paths do not touch old state.
    this.#todos = Object.freeze(
      input.todos.map((item) =>
        Object.freeze({ content: item.content, status: item.status }),
      ),
    );
    this.#nonTodoToolRounds = 0;
    return toolSuccess(serializeSnapshot(this.#todos));
  }
}
```

A complete snapshot suits model calls better than incremental commands. The reasons are practical:

- The last successful call alone decides the current state, which makes the state easy to explain and replay;
- The design needs no extra state machine for cases such as "update an index that no longer exists";
- The tool result itself contains the complete plan that later reasoning needs;
- After validation passes, the code performs exactly one assignment, so a failure cannot produce a half-updated state.

For example, the first submission:

```json
{
  "todos": [
    { "content": "Read the existing implementation", "status": "in_progress" },
    { "content": "Add a failing test", "status": "pending" },
    { "content": "Implement the fix and verify it", "status": "pending" }
  ]
}
```

After the first step completes, the model cannot submit only "the first item is completed". It must submit all three items again with their full state:

```json
{
  "todos": [
    { "content": "Read the existing implementation", "status": "completed" },
    { "content": "Add a failing test", "status": "in_progress" },
    { "content": "Implement the fix and verify it", "status": "pending" }
  ]
}
```

This is what `complete task snapshot` means in the tool description.

Beginners often ask: "The model repeats the whole task list every time. Does that not waste tokens?" Put the failure modes of the two designs side by side, and you can see what this small cost buys.

| Scenario | Incremental interface (`todo_update` and similar) | Full replacement (this chapter's approach) |
| --- | --- | --- |
| The model says "mark item 2 as completed", but it remembers the order wrongly | It changes the wrong item, and **nobody knows** | This operation does not exist; the model must submit the complete list as it understands it, and an error sits in plain view |
| The model references an index that was already deleted | An extra state machine must decide whether to report an error or ignore it | The index concept does not exist |
| In one submission, item 1 is valid and item 3 is invalid | The code may write item 1 first and then find the problem with item 3, which produces a half update | Zod validates the whole value first, and the code writes nothing at all |
| You want to know "how does the model currently understand this task" | You must replay every increment in the history | The last tool result is enough |
| The model leaves out one item | The old value stays silently, and you assume it still remembers | That item is deleted, with clear semantics |

The last row is the key point, and it is the only cost that the model must pay: **full replacement has no implicit merge**. Omitting an item means deleting an item. This semantics is better than "keep the old value when the model omits it", because it turns the model's forgetting into **visible** forgetting — you can see it at a glance in the tool result.

One more sentence on this point: this is also the real use of the "extra tokens". Every complete snapshot becomes the newest tool result in the message history. In the next round, the model does not need to scroll up past twenty messages to piece together its progress. It only needs the one result in front of it. **The cost is repeated tokens. What it buys is progress that needs no inference.**

### Why freeze the objects as well

The `readonly` marker in TypeScript only constrains callers at compile time. Code can still change the array at run time. The tracker therefore rebuilds each item when it stores the snapshot, and it freezes both the items and the outer array.

This does not exist to create a complex abstraction. It protects one direct contract: after a successful update, only the next valid `todo_write` can replace the snapshot. Other code that holds a reference cannot change the snapshot in secret.

---

## 3. Return Stable and Complete JSON

The handler does not return "updated 3 todos". It returns the complete snapshot:

```json
{"todos":[{"content":"ship","status":"completed"}]}
```

The implementation builds the data in a fixed field order first, and then it serialises the data:

```typescript
function serializeSnapshot(todos: readonly TodoItem[]): string {
  const json = JSON.stringify({
    todos: todos.map((item) => ({
      content: item.content,
      status: item.status,
    })),
  });
  const ascii: string[] = [];

  for (const character of json) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("todo snapshot contained an invalid Unicode value");
    }

    if (codePoint <= 0x7f) {
      ascii.push(character);
      continue;
    }

    if (codePoint <= 0xffff) {
      ascii.push(`\\u${codePoint.toString(16).padStart(4, "0")}`);
      continue;
    }

    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    ascii.push(`\\u${high.toString(16)}\\u${low.toString(16)}`);
  }

  return ascii.join("");
}
```

The code keeps ASCII JSON here so that the same logical snapshot always produces one definite text. Chinese text appears as a JSON Unicode escape. For example:

```text
编写测试
```

corresponds to:

```text
\u7f16\u5199\u6d4b\u8bd5
```

The two forms decode to the same content. Stable text lets tests assert exact values. It also keeps log encoding, platform encoding and serialisation differences across a migration from disturbing the comparison.


---

## 4. State Must Belong to the Session, Not to the Module

You cannot make `TodoTracker` a module-level singleton. If you do, and one Node.js process creates two Agents, the second session will see the first session's plan.

That error sounds abstract. Its concrete consequences look like this:

```text
❌ Assume the code says export const tracker = new TodoTracker();

User A's session: todo_write submits three items, "Refactor the auth module"
User B's session (same process): before B's first todo_write call,
                          #nonTodoToolRounds is already 2, left behind by A
  → B reads one file and gets the reminder "Keep the TODO list current"
  → B's first todo_write overwrites A's plan
  → In the next round, the snapshot that A sees is B's task
```

It is not just "cross-talk". Note the second line: **the stale count is also session state**. It must travel with the session, just like the snapshot. If it does not, the reminder timing becomes the sum of the tool calls of two sessions.

The composition root creates a tracker on every `buildAgent()` call:

```typescript
const todoTracker = profile.capabilities.has("todo")
  ? new TodoTracker()
  : undefined;

if (todoTracker !== undefined) {
  tools.register(todoTracker.toolDefinition);
}
```

After that, the same instance provides the tool handler and also goes to the Loop as the tool round observer:

```typescript
return new AgentRunner({
  model: dependencies.model,
  tools,
  systemPrompt:
    todoTracker === undefined
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`,
  workspace: dependencies.workspace,
  ...(todoTracker === undefined
    ? {}
    : { toolRoundObserver: todoTracker }),
});
```

The resulting lifecycle is clear:

- Inside one `AgentRunner` run, the tool and the reminder share one tracker;
- Two `buildAgent()` calls produce two trackers, and their states do not affect each other;
- The state disappears when the process exits. This chapter does not persist it to disk.

The Project Task design in Chapter 12 will solve cross-session persistence, dependencies and claiming. Its lifecycle differs from the session TODO lifecycle in this chapter. Do not force the two designs into one global state object in advance.

---

## 5. The System Prompt Only Tells the Model "When to Use It"

Chapter 5 appends one line after the base system prompt:

```typescript
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
```

The tool description explains "what the tool does". The system prompt explains "when to use it in a complex task". Neither one can force the model to call the tool. So you cannot treat "the first real run will certainly call `todo_write`" as a deterministic guarantee.

What you can verify offline is this:

- The P05 tool list contains `todo_write`, and it adds only `todo_write`;
- The system prompt contains the complete snapshot requirement;
- Once the model calls the tool correctly, the runtime can validate, store and return the snapshot;
- When the model forgets to update, the runtime injects a reminder by rule.

---

## 6. The Nag Reminder Counts Tool Rounds

One assistant message can hold several tool calls at the same time. If the model reads three files in one round, the reminder count must increase once, not three times.

`TodoTracker.recordToolRound()` receives all tool names from the round:

```typescript
recordToolRound(toolNames: readonly string[]): void {
  if (toolNames.length === 0) {
    return;
  }
  if (toolNames.includes(this.toolDefinition.name)) {
    this.#nonTodoToolRounds = 0;
    return;
  }
  this.#nonTodoToolRounds += 1;
}
```

The rules are only three:

1. If the round has no tool call, the code does not count it;
2. If `todo_write` appears anywhere in the round, the count resets to zero;
3. If the round has tools but no `todo_write`, the count increases by one.

Rule 1 is easy to skip, but it has a clear purpose: when the model gives a plain text reply (no tool call), `recordToolRound([])` returns at once. **"Chatting for two messages" must not count as "two rounds of work without a plan update".**

The three rules run like this. Note that round 2 in the table holds three calls:

| Tools in this round | Rule that applies | Count change |
| --- | --- | --- |
| `read_file` | 3 | 0 → 1 |
| `read_file` + `glob` + `read_file` (in the same assistant message) | 3 | 1 → **2** (not 4) |
| None (the model only replies with text) | 1 | 2 → 2 |
| `todo_write` | 2 | 2 → **0** |
| `shell` + `todo_write` | 2 | 0 → 0 (the count resets as long as the round **contains** `todo_write`) |

Rows 2 and 5 are the two key points of this design: **the count follows assistant messages, not the number of calls**; and **"contains" counts as an update — the round does not need to hold only `todo_write`**. The second point matches intuition: a model that runs tests and updates the plan at the same time clearly must not count as "not updating".

After the count reaches the threshold, `beforeModel()` returns one system guidance message and resets the count at once:

```typescript
export const TODO_STALE_REMINDER =
  "Keep the TODO list current. Call todo_write with the complete task snapshot when the plan changes.";

beforeModel(): readonly ChatMessage[] {
  if (this.#nonTodoToolRounds < STALE_TOOL_ROUNDS) {
    return [];
  }
  // Reminders are request-level context. Clearing them immediately avoids repeated injection in subsequent turns.
  this.#nonTodoToolRounds = 0;
  return Object.freeze([systemMessage(TODO_STALE_REMINDER)]);
}
```

Note that "the count reaches three rounds" and "the reminder is injected" do not happen in the same model request. The count becomes 3 only after the third stale tool round finishes. The reminder therefore appears in the next request, which is the fourth model request:

| Model request | Tools in the previous round | Reminder in this request | Count after the round |
| --- | --- | ---: | ---: |
| 1 | None | No | 0 |
| 2 | `read_file` | No | 1 |
| 3 | `glob` | No | 2 |
| 4 | `shell` | Yes | Counting restarts after the reset |

If request 4 then produces another non-TODO tool round, the count after that round moves from 0 to 1. The reminder does not repeat in request 5.

---

## 7. The Reminder Enters Only the Current Request and Does Not Pollute the Formal History

The Loop reads the guidance before it calls the model:

```typescript
const observerGuidance =
  this.#toolRoundObserver === undefined
    ? []
    : this.#toolRoundObserver.beforeModel();

const request: ModelRequest = Object.freeze({
  messages: Object.freeze([
    systemMessage(this.#systemPrompt),
    ...this.#history,
    ...observerGuidance,
  ]),
  tools: tools.openAITools(),
});
```

The key point: the code uses `observerGuidance` only to build the current `ModelRequest`. It does not `push` the guidance into `#history`.

This gives two direct benefits:

- The reminder sits close to the current generation position, so it can act as a prompt;
- It does not accumulate permanently, and later requests do not see a string of expired reminders.

After all tools in a round complete and all tool results are paired into the history, the Loop records the tool names:

```typescript
if (this.#toolRoundObserver !== undefined) {
  this.#toolRoundObserver.recordToolRound(
    assistant.toolCalls.map((call) => call.name),
  );
}
```

You cannot move this position at will. The tool result pairing must complete first. That order guarantees that the observer logic cannot break the OpenAI message protocol. The code records by whole assistant message, which guarantees that several calls count as one round.

Here is the real order of this part of the P05 loop, listed in full. It makes the meaning of "cannot move at will" clearer:

```text
① Run all tools in this round; collect the results in results[] first (do not write history)
② In assistant.toolCalls order, write each result as a toolMessage and push it into the history
③ recordToolRound(all tool names from this round)          ← Exactly here
④ Push the deferredContext (the additionalContext from the Chapter 4 Hooks)
⑤ If a preventContinuation exists, end early
```

Why must step ③ sit in this position, and not one step earlier or later:

| If you move it to | What happens |
| --- | --- |
| Before ② (record once per tool execution) | A round with three calls counts as three rounds, and the reminder fires early |
| Inside ② (record once per pushed tool message) | The same problem, and the observer also sees a history with "pairing half complete" |
| After ④ | This chapter shows no visible difference, but the semantics become "count only after the Hook's additional context is written too" — two unrelated mechanisms become coupled |

Row 1 is what this design really guards against. The same reason explains why `beforeModel()` and `recordToolRound()` form a `ToolRoundObserver` interface with only two methods, instead of letting the Loop know `TodoTracker` directly: **the Loop only needs to know "ask once before a round starts, report once after a round ends". It does not need to know what the other side is counting.**


---

## 8. The `write` Effect Does Not Mean a Disk Write Approval

The `effect` of `todo_write` is `"write"`, because the tool does change state inside the session:

```typescript
effect: "write"
```

But the file approval rule from Chapter 3 matches `write_file` and `edit_file` exactly. It does not block every `write` effect in a rough way:

```typescript
matches: (request) => {
  const name = request.prepared.definition?.name;
  return name === "write_file" || name === "edit_file";
}
```

So a TODO update does not open a disk write approval. It still passes through the unified permission decision and enters the audit record. This distinction matters: the effect (side-effect class) describes the nature of the behavior. The concrete policy decides which behaviors need human confirmation.

Chapter 5 keeps the existing boundaries:

- `write_file` and `edit_file` still require explicit approval;
- `shell` still follows the existing policy;
- A Hook or an approval cannot relax a write outside the workspace;
- The deny, output rewrite and Stop semantics of Hooks stay unchanged.

---

## 9. Why a Failure Does Not Break the Old Snapshot

Assume the current state is already:

```json
{
  "todos": [
    { "content": "Keep this item", "status": "in_progress" }
  ]
}
```

The model then submits an invalid status:

```json
{
  "todos": [
    { "content": "Wrong update", "status": "working" }
  ]
}
```

The call path is:

```text
JSON.parse
-> todoWriteSchema.safeParse
-> Failure; the code generates invalid_arguments
-> The handler is not called
-> The reference and the value of #todos both stay unchanged
```

This is much simpler than "enter the handler, check item by item, write item by item". It also has no rollback problem. The state assignment has exactly one entry point, and that entry point accepts only a `TodoWriteInput` that Zod has validated.

The tests do more than compare content. They also keep the array reference from before the update, and they confirm that the state is still the same snapshot object after the failure. This proves that the failure path does not secretly create or replace state.

A similar trust boundary exists on the handler output side. `ToolRegistry.invoke()` treats the handler's return value as untrusted input. Only an object that passes the `isToolResult()` check can enter the formal history. If the handler returns a malformed object, the Loop replaces it with an `invalid_tool_result` error, so an arbitrary structure cannot pollute the message protocol.

---

## 10. How the Offline Tests Prove These Contracts

`npm run test:ch05` runs **14 test files and 109 tests**. Chapter 4 had 12 files and 94 tests. This chapter adds two files:

| Test file | What it verifies |
| --- | --- |
| `todos.test.ts` | Unit level: the Zod contract, snapshot replacement, ASCII serialisation, failure boundaries, session isolation, reminder counting |
| `ch05-todos.test.ts` | End to end: the tests enter through the real composition root `buildAgent(P05, ...)`, and they verify the tool set, the system prompt, the audit, the pairing and the reminder timing |

The other 12 files are the accumulated tests from the first four chapters. They keep guaranteeing "adding the TODO did not break the old behavior". **Note that this chapter changed the shared `loop.ts`, so the green state of these 12 files matters more than in earlier chapters.**

The unit tests in `todos.test.ts` cover:

- The three statuses and `content.trim()`;
- A complete, stable, ASCII JSON snapshot;
- The upper boundary of exactly 50 items;
- A non-array value, empty content, an unknown status, an unknown field, 51 items and invalid JSON;
- The snapshot object and its value stay unchanged before and after a failure;
- Session isolation between two trackers;
- The reminder appears only once in three rounds;
- `todo_write` resets the stale round count.

The integration test file `ch05-todos.test.ts` holds only two `test` blocks, but their assertions deserve a close look, item by item. These two assertion sets are the executable form of this chapter's acceptance standard.

**The first test** proves "a tool was added and the permissions were not broken". Its four key assertions are:

```typescript
// ① The tool set is the five tools from the first four chapters + todo_write, in a fixed order too
expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
  "shell", "read_file", "write_file", "edit_file", "glob", "todo_write",
]);
// ② The TODO system prompt really entered the first system message
expect(model.requests[0]?.messages[0]?.content).toContain(
  "call todo_write with the complete task snapshot",
);
// ③ The approver was never called
expect(approval.requests).toEqual([]);
// ④ But the audit holds one default allow
expect(audit.decisions).toEqual([
  new PermissionDecision("allow", "No permission rule blocked the request", "default"),
]);
```

Assertions ③ and ④ together prove the sentence from Section 8: **no dialog does not mean no policy.** The approver implementation in this test is called `UnexpectedApproval`. It throws at once when something calls it — so if `todo_write` ever triggered an approval by accident, the test would not fail an assertion; it would simply blow up.

Right after that, the test asserts the **byte-exact content** of the tool result:

```typescript
expect(result.history[2]).toEqual({
  role: "tool",
  content:
    '{"todos":[{"content":"\\u7f16\\u5199\\u6d4b\\u8bd5","status":"in_progress"},{"content":"ship","status":"completed"}]}',
  toolCallId: "todo-1",
});
```

The input `"  编写测试  "` has become the trimmed `\u7f16\u5199\u6d4b\u8bd5` here, and the `toolCallId` pairs with the original call. **Section 3 insists on ASCII serialisation precisely so that this assertion line can be written.** If the snapshot printed UTF-8 Chinese text directly, this assertion would turn fragile because of platform encoding, a file BOM or Git line-ending handling.

**The second test** proves the reminder timing. It lets the model read files four times in a row, and then it asserts:

```typescript
expect(model.requests).toHaveLength(5);
// None of the first three requests has a reminder
for (const request of model.requests.slice(0, 3)) { /* ... false */ }
// In request 4: exactly one reminder, and it must have the system role
expect(model.requests[3]?.messages.filter(
  (message) => message.role === "system" && message.content === TODO_STALE_REMINDER,
)).toEqual([{ role: "system", content: TODO_STALE_REMINDER }]);
// Request 5 is clean again
expect(model.requests[4]?.messages.some(/* ... */)).toBe(false);
// The formal history does not contain this reminder at all
expect(result.history.some((message) => message.content === TODO_STALE_REMINDER)).toBe(false);
expect(result.history.filter((message) => message.role === "tool")).toHaveLength(4);
validateToolPairing(result.history);
```

This assertion set pins the timeline from "Look at One Real Run First" **cell by cell**:

| Assertion | Conclusion it pins down |
| --- | --- |
| Every entry in `slice(0, 3)` is false | The reminder does not appear early |
| `requests[3]` uses `filter(...).toEqual([...])` | Exactly one reminder, not "at least one" |
| The same assertion checks `role === "system"` | The reminder must be a system message; it cannot pretend to be user or tool |
| `requests[4]` is false | The count resets at once after injection |
| `history.some(...)` is false | A request-level message does not enter the formal history |
| The history holds exactly 4 tool messages | The reminder did not push out or replace any tool result |
| `validateToolPairing` | With this mechanism added, the message protocol stays complete |

**The second-to-last row is the easiest to overlook.** The reminder is one extra system message, inserted at the end of the message array. If an implementation carelessly `push`ed it into `#history`, `validateToolPairing` might well stay green — system messages do not take part in the pairing check — but the `history.some(...)` assertion would turn red at once. The two assertions work as a pair: one guards the protocol, the other guards against pollution.

Run the smallest verification for Chapter 5:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run typecheck
npm run test:ch05
```

This chapter changed the shared Loop, so a full regression and the static checks must also run before the review is complete:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm test
npm run lint
npm run format:check
npm run build
```

The tests use a `ScriptedModelClient` and a temporary workspace. They do not read `.env` and they do not access the network. They verify the deterministic contract of the runtime. They do not rely on the random behavior of a model for the demonstration.


---

## 11. Run Chapter 5

### Step 0: Prepare the environment

Exactly as in the first four chapters: run `npm ci` in `code/`, and fill in the three variables in `.env`.

```powershell
Set-Location 'F:\笔记\Agent实操\code'
```

### Step 1: Run the offline tests first

```powershell
npm run test:ch05
```

The expected last two lines:

```text
 Test Files  14 passed (14)
      Tests  109 passed (109)
```

One line in the output, `Configuration Error: Missing required settings: ...`, is still asserted expected output (the `config.test.ts` file verifies "the CLI returns exit code 2 when the configuration is missing"). It is not a failure.

### Step 2: Let the model plan first and execute second

```powershell
npm run ch05 -- --prompt "First build the complete TODO, then read README.md and summarise the run and verification steps"
```

You should see output like this on stderr (the `[Hook]` and `[Permission]` lines come from earlier chapters):

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: todo_write
[Permission] todo_write: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: todo_write -> ok
[Hook] PreToolUse: read_file
[Permission] read_file: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: read_file -> ok
[Hook] Stop
```

Confirm in particular that the `todo_write` line says `allow (default)`, **and that no approval dialog appeared**. Its `effect` is `"write"`, but the Chapter 3 rule matches only `write_file` and `edit_file`.

Whether the model really calls `todo_write` first depends on the model itself — the system prompt guides; it is not a hard gate. If the model starts reading files directly, write the prompt more explicitly and try again.

### Step 3: Observe the snapshot content

The tool result of `todo_write` does not appear on stdout (stdout carries only the final answer). The most direct way to see the snapshot is to let the model repeat it:

```powershell
npm run ch05 -- --prompt "First use todo_write to build a three-item plan, then tell me the complete text that todo_write returned, exactly as it is"
```

The model should repeat one whole `{"todos":[...]}` document, with the Chinese text in `\uXXXX` form.

### Step 4: The unified entry point

```powershell
npm run agent-tutorial -- run --chapter 5 --prompt "First build the complete TODO, then read README.md and summarise the run and verification steps"
```

Both entry points end at `P05` and the same `buildAgent()`. Neither copies a separate Chapter 5 Loop. The fixed chapter file has only three lines:

```typescript
import { runProfile } from "../cli.js";
import { P05 } from "../core/profiles.js";

process.exitCode = await runProfile(P05, process.argv.slice(2));
```

`runProfile(P05, ...)` hands the fixed profile to the unified CLI route: the route still parses only `--prompt`, and it fills in `--chapter 5` internally by force. So even if another chapter number appears in the command arguments, the capability set cannot switch by accident.

### Step 5 (optional): The complete offline gate

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

This chapter changed the shared `loop.ts`. Do not skip this step.

### Troubleshooting common errors

| Symptom | Cause | What to do |
| --- | --- | --- |
| `Error [invalid_arguments]` | The `status` is not one of the three values, the `content` is blank, an unknown field exists, or the list has more than 50 items | This is **correct behavior**. The old snapshot did not change. Let the model submit a valid snapshot again |
| `Error [invalid_json]` | The `arguments` that the model generated are not valid JSON | Same as above. The handler never ran |
| The model never calls `todo_write` | The system prompt only guides | State "first build the complete TODO" clearly in the prompt; or accept this result — this chapter does not force a gate |
| The model submits only the one changed item every time | It does not understand the "complete snapshot" semantics | Look at the tool result: the omitted item **really was deleted**. This is the designed semantics, not a bug |
| You wait a long time and never see `Keep the TODO list current` | The model has not yet collected three stale tool rounds | Count them: only rounds that "have tool calls and do not contain `todo_write`" count |
| The reminder appears in request 3 | You treated "the count reaches 3" and "injection" as the same request | Review the timeline in "Look at One Real Run First": the reminder is in request 4 |
| You search for the reminder in `result.history` and cannot find it | The reminder is a request-level message | This is the design. To observe it, look at `model.requests[i].messages` |
| `todo_write` opened an approval dialog | You changed the Chapter 3 rule yourself and used `effect === "write"` as the match condition | Go back to exact tool-name matching. See Section 8 |
| Two sessions see the same plan | `TodoTracker` was written as a module-level singleton | Every `buildAgent()` call must run `new TodoTracker()` |

### Four small experiments to try yourself

**Experiment 1: Hit `invalid_arguments` once by hand, and confirm that the old snapshot does not change**

Append one `test` at the end of `todos.test.ts`. Reuse the `invokeTodo` helper that already exists at the top of the file (it follows the real `prepare` → `invoke` path):

```typescript
test("Experiment 1: an invalid status does not change the old snapshot", async () => {
  const tracker = new TodoTracker();
  await invokeTodo(tracker, JSON.stringify({ todos: [{ content: "Keep this item", status: "in_progress" }] }));
  const before = tracker.todos;                     // Keep the reference, not only the value

  const failed = await invokeTodo(tracker, JSON.stringify({ todos: [{ content: "Wrong update", status: "working" }] }));

  expect(failed.isError).toBe(true);
  expect(failed.content).toContain("invalid_arguments");
  expect(tracker.todos).toBe(before);               // Use toBe: it must be the same object
});
```

What you learn: `toBe`, not `toEqual` — the failure path does not even **create a new object**. The `invalid_arguments` in `content` shows that Zod stopped the call in the `prepare()` stage. `#writeTodos` never ran.

**Experiment 2: Try to change a snapshot that is already stored**

```typescript
test("Experiment 2: the snapshot is frozen", async () => {
  const tracker = new TodoTracker();
  await invokeTodo(tracker, JSON.stringify({ todos: [{ content: "a", status: "pending" }] }));
  const snapshot = tracker.todos;

  expect(() => {
    // @ts-expect-error Deliberately violate readonly, to verify that the runtime also blocks it
    snapshot[0].status = "completed";
  }).toThrow(TypeError);
  expect(tracker.todos[0]?.status).toBe("pending");
});
```

Expected result: in strict mode (ESM modules are strict by default), the code throws a `TypeError`, and the snapshot value does not change.
What you learn: the practical effect of "Why freeze the objects as well" at the end of Section 2. The `readonly` marker of TypeScript only stops you at compile time (which is why the code needs `@ts-expect-error` to compile at all). `Object.freeze` is what stops you at run time.

**Experiment 3: Change `STALE_TOOL_ROUNDS` to 1 and watch the reminder frequency**

Change the constant in `features/todos.ts` to `1`. Then run `npm run ch05` and let the model read several files in a row.

Expected result: almost every request carries a reminder.
What you learn: why the threshold cannot be too small — the reminder itself occupies attention and becomes new noise. **Remember to change the value back to `3` afterwards, or `todos.test.ts` will turn red.**

**Experiment 4: Verify that "several calls in one round count as one round"**

```typescript
const tracker = new TodoTracker();
tracker.recordToolRound(["read_file", "glob", "read_file"]);   // Three calls in one round
tracker.recordToolRound(["shell"]);
expect(tracker.beforeModel()).toEqual([]);                      // The count is only 2, so no reminder
tracker.recordToolRound(["read_file"]);
expect(tracker.beforeModel()).toHaveLength(1);                  // The reminder comes only after round 3
```

What you learn: row 2 of the table in Section 6. If the code counted calls instead of rounds, the first `beforeModel()` would already return a reminder.

---

## 12. What to Watch in a Real Run

First, watch whether the model submits a complete TODO at the start of a complex task. The system prompt guides; it is not a hard gate. If the model executes directly, first check whether the prompt really asked for a plan, and only then judge the model's behavior.

Second, watch whether the state flows in a sensible way:

```text
pending -> in_progress -> completed
```

Changing every item from `pending` to `completed` in one step is legal, but it shows that no intermediate progress was recorded. If the task stops in the middle of the work, the last snapshot may already be out of date.

Third, watch whether every update still contains all tasks. The full replacement interface has no implicit merge. If an item is missing, the model has explicitly deleted it from the current plan.

Fourth, watch the timing of the reminder. It appears only once, after three consecutive rounds of other tools. If the model still does not update after that, it must pass through three new stale tool rounds before the runtime reminds it again.

Finally, do not treat a TODO in `completed` state as acceptance evidence. It is plan state that the model submitted. It is not a test result. Whether the code is correct still depends on the direct verification steps that this chapter lists.

---

## 13. Differences from Claude Code

The `todo_write` in this chapter is a teaching subset. Claude Code keeps two task systems side by side internally (the differences are organised from the external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code), in `s05_todo_write/README.md`):

- TodoWrite (V1): one `todo_write` tool. The list stays in session memory, and the system clears it on exit;
- Task System (V2): file persistence, a `blockedBy` dependency graph, concurrency locks, task ownership, and four separate tools: Create, Get, Update and List.

The fixed rule in P05, "remind after three consecutive rounds without an update", is a teaching mechanism. Claude Code has no identical fixed round count. Its closer behavior appends a verification reminder when 3 or more TODO items are complete but no verification item exists. Chapter 5 deliberately chooses a fixed round count, so that offline tests can prove deterministically that "the reminder appears only once and does not pollute the formal history".

In *Building Effective Agents*, Anthropic lists "explicitly showing the Agent's planning steps" as a core principle for implementation transparency (https://www.anthropic.com/engineering/building-effective-agents).

The complete snapshot tool result in P05 is the testable landing point of this principle: every TODO that the model submits enters the formal message history. Readers and the runtime can both see the complete plan that the model currently holds.

---

## 14. Comparison with *ai-agent-book*: Attention Retrieval, the Status Bar and Trajectory Boundaries

The implementation in this chapter maps directly onto several key concepts from Chapters 2, 3 and 5 of *ai-agent-book*. Reading them side by side makes it easier to understand why `todo_write` deserves this design.

**The status bar: put the computed conclusion directly into the context.** When Chapter 2 of *ai-agent-book* introduces the Agent status bar, it proposes this: do not let the model search passively through a mass of raw information. Refine the information into structured state, and place that state actively in front of the model. The complete TODO snapshot in P05 is exactly the testable landing point of this principle.

Every `todo_write` returns not "3 items updated", but "what the complete plan is at this moment". In the next round, the model does not need to flip through the system prompt or the early conversation from the start. It only needs the most recent tool result.

**Attention is good at retrieval. It is not good at statistics and reasoning.** Chapter 2 of *ai-agent-book* also points out that the attention mechanism of the Transformer is, in its nature, a kind of soft retrieval: it is good at locating the fragments that relate to the current query inside existing content, but it is not good at statistical induction across a large number of tokens.

This explains why a system prompt slowly fails in a long context: the initial plan appears only once. As tool output grows, the plan must compete for attention with more and more local information. The TODO snapshot turns "current progress" from a state that the model must infer itself into explicit JSON that it can retrieve directly.

**The trajectory stays append-only. A temporary reminder does not travel through the history.** Chapter 3 of *ai-agent-book* defines the trajectory as a complete event record that is appended in time order: it only grows, and it never changes. The P05 reminder does not enter `#history`. `beforeModel()` adds it temporarily only when it builds the current request, so expired reminders cannot accumulate in the trajectory.

This design and "the complete snapshot as the most recent tool result" together guarantee one thing: the formal history is always the paired record of real tool calls and results. A temporary prompt cannot pollute the audit or the replay.

**Explicit state is better than an implicit expectation.** Writing "do not forget the plan" in the system prompt gives the model a principle. It cannot store "current progress". P05 uses a structured tool to turn the state into a data contract that the code can validate, assert and replace: the model submits complete JSON, the runtime validates and replaces, and invalid input does not change the old state. This is exactly the engineering form of "actively provide refined, structured knowledge" from Chapter 2 of *ai-agent-book*.

This comparison does not claim that P05 implements every capability in the book. It shows that P05 chooses the most basic and most verifiable path: it takes the plan state that is easy to lose, pulls it out of the long context, and turns it into a tool result that the model can see in a stable way on every round.

---

## Complete Change List for This Chapter

Compared with Chapter 4, Chapter 5 adds only one implementation path:

- `code/chapters/ch05/src/features/todos.ts`: the Zod contract, the session snapshot and the reminder count;
- `code/chapters/ch05/src/core/loop.ts`: the Loop reads the guidance before a model call, and it records the tool names after a tool round;
- `code/chapters/ch05/src/bootstrap.ts`: every P05 session creates and registers one tracker;
- `code/chapters/ch05/src/core/profiles.ts`: the new fixed `P05` profile and the `todo` capability;
- `code/chapters/ch05/src/chapters/ch05.ts`: the fixed Chapter 5 entry point;
- `code/chapters/ch05/tests/todos.test.ts`: TODO domain behavior and failure boundaries;
- `code/chapters/ch05/tests/ch05-todos.test.ts`: verification of the permission, message and reminder seams from the composition root.

The chapter adds no database, no global state, no incremental update protocol and no second Loop. This implementation solves only the current problem: it gives one Agent session a task snapshot that the code can verify, that the model can submit repeatedly, and that invalid input cannot break.

---

## Chapter Summary

### The three-sentence version

1. What a long task loses is not "the goal". It loses "the progress" — the goal appeared once at the start, and the progress was never recorded explicitly.
2. So this chapter turns progress into structured state: the model submits a **complete snapshot** every time, and the snapshot returns to the message flow as the newest tool result.
3. When the model forgets to update, the runtime injects one reminder that **enters only the current request**, by the rule "three consecutive stale tool rounds".

### Seven points you must remember

| # | Conclusion | Section |
| ---: | --- | --- |
| 1 | Full replacement has no implicit merge: omitting an item = deleting an item | 2 |
| 2 | The code assigns once, only after all validation passes, so no half update exists and no rollback is needed | 2, 9 |
| 3 | `readonly` guards compile time only; the runtime needs `Object.freeze` | 2 |
| 4 | The snapshot and the stale count **are both** session state; a singleton makes sessions cross-talk | 4 |
| 5 | The count follows assistant messages: three calls in one round count as one round | 6 |
| 6 | "The count reaches 3" and "the reminder is injected" are not in the same request; the count resets at once after injection | 6 |
| 7 | The reminder enters the `ModelRequest`. It does not enter `#history` | 7 |

### Code boundary of this chapter (what it explicitly does not do yet)

| Already present | Not yet present | Note |
| --- | --- | --- |
| A TODO snapshot inside the session | Disk persistence, cross-session recovery | The state disappears when the process exits. Chapter 9 builds file memory |
| A single full replacement tool | Dependencies, `blockedBy`, concurrent claiming | Chapters 12 and 17 build the task DAG |
| A fixed "three rounds" threshold | The official style, "remind when 3 items are complete but no verification item exists" | The fixed round count is a deliberate choice, so offline tests can assert deterministically |
| One reminder with fixed wording | A reminder generated dynamically from the task content | **Not done.** Dynamic wording cannot support exact assertions |
| The reminder is injected only into the current request | The reminder enters the formal history | **Not done.** Expired prompts would accumulate in the trajectory |
| `effect: "write"` takes part in the permission decision | Rough matching of approval rules by effect | The rule matches tool names exactly; see Section 8 |
| A tracker for a single session | A tracker shared globally | **Not done.** See the cross-talk example in Section 4 |

### Check whether you really understood

1. The model submits a plan with 3 items. Next time it submits only 1 item. What happens to the other 2 items? (Section 2)
2. When `content` is `"   "` (three spaces), why does the submission fail? What if the schema were written as `z.string().min(1).transform(trim)`? (Section 1)
3. Why does the snapshot print `\u7f16\u5199` instead of printing the Chinese text directly? (Sections 3, 10)
4. What goes wrong if `TodoTracker` is written as `export const tracker = new TodoTracker()`? Name at least two problems. (Section 4)
5. One assistant message holds three calls: `read_file`, `glob` and `shell`. By how much does the count increase? (Section 6)
6. In which model request does the reminder appear? Why is it not request 3? (Section 6)
7. Can you find `Keep the TODO list current` in `result.history`? Why? (Section 7)
8. The effect of `todo_write` is `write`. Why does no approval dialog appear? But is there anything in the audit record? (Sections 8, 10)
9. The model submits `{"todos":[{"content":"a","status":"working"}]}`. Did the handler run? Did the old snapshot change? (Section 9)

---

The next chapter handles a larger task: hand one goal to an independent subagent, execute it in an isolated history, and bring only the final result back to the parent Agent. That solves context isolation, not the in-session plan tracking of this chapter.
