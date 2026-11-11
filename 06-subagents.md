When one Agent chases a bug through a deep call chain, the loss of control usually looks like this: it reads files, searches for symbols, and runs commands, and a few dozen tool results soon fill the history. Even if the TODO list from Chapter 5 is still there, the parent task must remember the original goal, the current plan, and a long exploration trail at the same time. Every extra tool call makes the context that the model must process longer.

At that point, you should not press all the work into one conversation. The better approach is this: give one self-contained subtask to a one-shot Subagent, and let it explore from a fresh history. The parent Agent receives only one conclusion with evidence at the end. It does not receive the intermediate search and file-reading records.

Chapter 6 adds exactly this capability: `task`.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaElNML5X1yY2KNZfJl8XyLRDoq2QhYoEAPMHMu02Lkc2LrhZv3OupQUeptQSdExwhKO5ibQ9lkca43Wc93MdEouuxBr080ZRhvM/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

1. State clearly what problem the TODO list in Chapter 5 solves and what problem `task` in Chapter 6 solves, and why the first one cannot replace the second one.
2. Explain the **exact scope** of "isolation" in this chapter — it isolates message history, not permission, not files, and not processes.
3. State which messages the parent history gains after the parent Agent calls `task` once.
4. Explain why recursive delegation is forbidden, and why this rule needs two layers of defence.
5. Explain why, when a subagent uses all 30 turns, the runtime must not return the last tool output as the conclusion.
6. State why the `try/catch` in `task` does not count as "swallowing an exception inside business logic".

### What you need first

| What you need | Where it comes from | How to check |
| --- | --- | --- |
| The accumulated capabilities of Chapters 1–5 | The first five chapters | `npm run test:ch05` gives 14 files / 109 tests |
| An understanding of the four permission states and the merge priority | Chapter 3 | You can state why the order is `deny > ask > allow > passthrough` |
| An understanding that the workspace hard boundary runs before the rules | Chapter 3 | You can state why an out-of-bounds write never opens an approval dialog |
| An understanding that `AgentRunner` is a reusable class | Chapter 1 | You know which parameters `new AgentRunner({...})` needs |

### Glossary (terms that appear for the first time in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| **`task`** | The only new tool in this chapter. It starts a subagent and returns **only** its final conclusion |
| **Subagent** | A new `AgentRunner` instance with a fresh history. The runtime discards it after the run |
| **Self-contained task** | A task description that a reader can understand without the parent history, because the subagent cannot see the parent history |
| **`SubagentTool`** | The class that registers the `task` tool. It is **not** a second Agent Loop |
| **`effect: "external"`** | A declaration that "this tool starts an independent execution". It is neither a read nor a write |
| **`modelFactory` / `toolsFactory`** | The code passes a function, not an instance, so each delegation gets an independent Tool Registry |
| **`DEFAULT_SUBAGENT_MAX_TURNS`** | The constant `30`. You can lower it. You **cannot** raise it |
| **`subagent_turn_limit`** | The structured error code for the case where the subagent uses all turns and still has no final text |
| **`subagent_execution_error`** | The masked error code for all other internal exceptions |
| **`subagent_configuration_error`** | The factory returned the wrong thing (not a `ToolRegistry`, contains `task`, or not a `ModelClient`) |
| **Masking** | The code replaces internal exception text with a fixed string, so no API key, path, or stack data flows back to the model |
| **Execution boundary** | A place where the code may write `try/catch`: a task entry point, an API boundary, or a process boundary |

### Suggested reading route

```text
Chapter Guide (you are here)
  ↓
① Look at one real delegation first   ← What the parent sees, what the child sees, how many audit records exist
  ↓
② What problem this chapter solves + acceptance contract ← The exact scope of isolation
  ↓
③ Sections 1–2: input contract and execution boundary  ← Why "self-contained" matters
  ↓
④ Sections 3–4: what is isolated, what is shared  ← The most important pair of concepts in this chapter
  ↓
⑤ Sections 5–6: two hard constraints         ← No recursion, a turn limit
  ↓
⑥ Section 7: composition root wiring            ← Why the factory returns a function
  ↓
⑦ Sections 8–9: verification, running, troubleshooting    ← Hands-on work + experiments
  ↓
⑧ Sections 10–11 + summary            ← What this chapter deliberately does not do + differences from the official design + self-test
```

---

## Look at One Real Delegation First

Do not look at code yet. Every data item below comes from an assertion in `ch06-subagents.test.ts`. Each item is a deterministic fact about the runtime.

The parent Agent receives the task "delegate the write". It calls `task` once. The delegated content is `" write child.txt with evidence "` (note the spaces at the start and the end).

**The parent model sees 7 tools in its first request:**

```text
shell  read_file  write_file  edit_file  glob  todo_write  task
```

**The child model sees 6 tools in its first request (the second request overall). The `task` tool is not in the list:**

```text
shell  read_file  write_file  edit_file  glob  todo_write
```

**The child model sees a complete message array with only two messages:**

```text
[
  { role: "system", content: "You are a focused coding subagent working in the current workspace. ..." },
  { role: "user",   content: "write child.txt with evidence" }
]
```

Three details: the schema `trim()` removes the spaces at the start and the end; **no message from the parent Agent is present**; the system prompt is not the parent Agent's prompt either, but a dedicated prompt for the subagent.

**The subagent writes the file, and then it gives its conclusion. The parent history ends with only 4 messages:**

```text
user:      delegate the write
assistant: tool_calls=[task(parent-task)]
tool:      "child conclusion"          toolCallId=parent-task
assistant: parent final
```

The subagent's `write_file` call, its tool result, and the assembly of its final text — **none of them appears in the parent history**. The parent Agent knows only this: "I delegated the work, and I received one conclusion."

**But the audit log has two records, and the approval log has one:**

```text
Audit: [["task", "allow"], ["write_file", "allow"]]
Approval: ["write_file"]
```

This is the point that this chapter most needs you to understand. The parent history is clean, but **governance did not become weaker**: the subagent's `write_file` still opens an approval dialog, and it still enters the audit log.

### What if the subagent tries to write outside the boundary?

The second case in the same test file makes the subagent write `../outside.txt`. The test gives it an approver that **always approves**:

```text
The child model's tool result:
  Error [permission_denied]: Writing outside the workspace is forbidden

Audit: [["task", "allow"], ["write_file", "deny"]]
Approval: []                              ← The approver was never called
File: outside.txt still contains "sentinel"  ← Not changed
```

The approver says "approve everything", but the runtime never asks it once. This is the effect of the Chapter 3 rule that the workspace hard boundary runs before the rules — **inside a subagent, not one character of that behavior changes.**

---

## What Problem This Chapter Solves

The `todo_write` tool in Chapter 5 solves the problem "how does one session keep a plan over time". It lets the newest complete plan snapshot flow back into the message stream, but it does not reduce the context that the exploration process itself creates.

Chapter 6 solves the problem "how do you isolate one independent exploration". After the parent Agent calls `task`, the runtime creates a new `AgentRunner`:

```text
Parent Agent
  assistant: task(description=...)
        │
        ▼
One-shot Subagent
  system: Focus on the delegated task, do not delegate again
  user: description
  history: Fresh
  tools: shell/read_file/write_file/edit_file/glob/todo_write
        │
        ▼
Parent Agent
  tool: The subagent's finalText
```

Here, "isolation" means message history isolation only:

- The subagent cannot see the parent Agent's history;
- The parent Agent cannot see the subagent's intermediate tool trail;
- Files that the subagent writes inside the current workspace remain in place;
- Parent and child still run in the same Node.js process. They use the same set of hooks, the same permission policy, the same workspace, and the same identity.

So a Subagent is not an operating system sandbox. The `shell` still executes PowerShell, and the file path boundary is not system-level isolation either. A Subagent solves context pollution. It does not automatically receive fewer or more permissions.

You must state "what is isolated and what is shared" clearly in one pass. If you do not, you will misread every later section. The table lists each item:

| Item | Parent–child relation | Consequence |
| --- | --- | --- |
| Message history | **Isolated** | The child cannot see the parent's goal and exploration; the parent cannot see the child's intermediate trail |
| System prompt | **Isolated** | The child uses `DEFAULT_SUBAGENT_SYSTEM_PROMPT`, not the parent's prompt |
| Tool Registry | **Isolated** (each side creates its own with `new`) | The child's TODO snapshot and the parent's TODO snapshot do not affect each other |
| `HookRegistry` | **Shared, the same instance** | A child tool call also prints `[Hook] PreToolUse` |
| `PermissionPolicy` | **Shared, the same instance** | The child's `write_file` still opens an approval dialog and still enters the audit log |
| Workspace path | **Shared** | The parent can read a file that the child wrote. The file is not a temporary copy |
| Identity | **Shared** | The audit log cannot show "the subagent did this" |
| Node.js process | **Shared** | No child process, no container |
| Model client | Shared (in the real wiring, the same instance) | See Section 7 |

One sentence to remember it by: **context is isolated, governance is shared.** Delegation is not a permission increase, and it is not a permission decrease.

How does this relate to the TODO list in Chapter 5? The two features solve different sides of the same large problem:

| | Chapter 5 `todo_write` | Chapter 6 `task` |
| --- | --- | --- |
| What it fights | Progress gets lost in a long context | The exploration process itself inflates the context |
| Method | It makes progress explicit and puts it back into the message stream | It moves the exploration out and brings back only the conclusion |
| Total context | **Does not decrease** (it increases slightly) | **Decreases significantly** |
| Who can see it | The parent Agent itself | The parent Agent sees only the conclusion |
| Suitable scenario | A ten-step refactoring, where the steps depend on each other | A self-contained sub-problem such as "Find out which test framework this project uses" |

The two features do not conflict. People usually use them together: the parent Agent uses a TODO list to remember a ten-step plan, and it delegates step 3 with `task`.

This chapter also does not introduce concurrency, a background queue, notifications, a long-lived worker, or a recursive Agent tree. One `task` call waits synchronously for one subagent, and the subagent runs at most 30 turns.

---

## Chapter 6 Acceptance Contract

This chapter adds only `subagent` to the capability set of `P05`:

```typescript
export const P06: ChapterProfile = Object.freeze({
  chapter: 6,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
  ]),
});
```

There are five observable results:

1. Every `task` call starts from a new model request, a new Tool Registry, and a new message history;
2. The parent history receives only the final tool result that pairs with the original `task` call;
3. The subagent uses the parent Agent's hooks, permission policy, workspace, and identity;
4. The child's tool set contains no `task`. A recursive call becomes an `unknown_tool`;
5. If the subagent still has no final text after 30 turns, the runtime returns a structured `subagent_turn_limit`. It never presents the last tool result as the answer.

In addition, when the delegation description is empty, is all whitespace, or contains an unknown field, `task` returns `invalid_arguments` before it enters the handler, like every other tool.

---

## 1. A Strict `task` Input

The implementation is in `code/chapters/ch06/src/features/subagents.ts`. The `task` input has only one field, but the code still defines it with a strict Zod schema:

```typescript
const taskInputSchema = z
  .object({
    description: z
      .string()
      .transform((description) => description.trim())
      .pipe(z.string().min(1))
      .describe("A self-contained task for the subagent to complete."),
  })
  .strict();

export type TaskInput = Readonly<z.output<typeof taskInputSchema>>;
```

It expresses three constraints:

- The description must be a JSON string;
- The code removes whitespace at the start and the end, and `"   "` is still invalid input;
- `.strict()` rejects extra fields.

The model sees a JSON Schema that the same schema exports:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["description"],
  "properties": {
    "description": {
      "type": "string",
      "minLength": 1,
      "description": "A self-contained task for the subagent to complete."
    }
  }
}
```

Why does this chapter stress "self-contained"? Because the subagent does not inherit the parent history. A delegation like the one below does not carry enough information:

```json
{ "description": "Continue with the problem from just now" }
```

A better description states the object, the goal, and the evidence requirement:

```json
{
  "description": "Check package.json and the test directory, and confirm which test framework the project uses; return only conclusions that the file contents support."
}
```

"Self-contained" is not just a principle. It has an operational checklist. **Copy the description down, and hand it to a person who has just opened this project and knows nothing — can that person start working?**

| Description | Self-contained? | Where the problem is |
| --- | --- | --- |
| `Continue with the problem from just now` | ❌ | "Just now" refers to the parent history, which the subagent cannot see |
| `Fix this bug` | ❌ | Which bug? In which file? What is the symptom? |
| `Refactor it according to the convention we agreed earlier` | ❌ | The convention is in the parent history. The description does not pass it |
| `Read login.ts` | ⚠️ | Syntactically self-contained, but it does not state **which conclusion to reach**. The subagent reads the file and then says "I read it" |
| `Check package.json and the test directory, and confirm which test framework the project uses; return only conclusions that the file contents support.` | ✅ | The object is clear, the goal is clear, and the evidence requirement is clear |

Row 4 deserves a separate look. It raises no error, but it wastes a whole delegation — **the subagent's final text is the only thing the parent Agent can receive**, so the description must state "what shape of conclusion I want".

This also explains why `DEFAULT_SUBAGENT_SYSTEM_PROMPT` has these three sentences:

```typescript
"You are a focused coding subagent working in the current workspace. " +
"Complete only the delegated task, then return a concise, evidence-based final conclusion. " +
"Do not delegate further.";
```

The three sentences map to three things: **where you are** (the current workspace), **what you must deliver** (a concise, evidence-based final conclusion), and **what you must not do** (do not delegate further). The third sentence is a constraint at the prompt level. Section 5 explains the two hard constraints at the runtime level — because the model can ignore a prompt.

---

## 2. `SubagentTool` Owns Only the Execution Boundary

`SubagentTool` itself is not a second Agent Loop. It registers a normal `ToolDefinition`, and its handler constructs the existing `AgentRunner`:

```typescript
export const TASK_TOOL_NAME = "task";
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  "You are a focused coding subagent working in the current workspace. " +
  "Complete only the delegated task, then return a concise, evidence-based final conclusion. " +
  "Do not delegate further.";

export class SubagentTool {
  readonly toolDefinition: ToolDefinition<TaskInput>;

  constructor(options: SubagentToolOptions) {
    // Parameter and runtime boundary validation omitted
    this.toolDefinition = Object.freeze({
      name: TASK_TOOL_NAME,
      description: "Launch an isolated subagent and return only its final conclusion.",
      inputSchema: taskInputSchema,
      effect: "external",
      handler: (input, context) => this.#runTask(input, context),
    });
  }
}
```

The value `effect: "external"` means that this tool starts an independent execution. It does not read a file directly, and it does not write a file directly. The Chapter 3 approval policy still uses the tool name and the hard boundaries to decide. The policy does not misclassify every child tool as a disk write because `task` has the mark `external`; whether a child tool may write to disk still depends on its own tool name and permission boundary.

The key part of the execution looks like this:

```typescript
const tools: unknown = this.#toolsFactory();
if (!(tools instanceof ToolRegistry)) {
  return toolError(
    "subagent_configuration_error",
    "Subagent tools factory must return ToolRegistry",
  );
}
if (tools.names.includes(TASK_TOOL_NAME)) {
  return toolError(
    "subagent_configuration_error",
    "Subagent tools must not include task",
  );
}

const runner = new AgentRunner({
  model,
  tools,
  systemPrompt: this.#systemPrompt,
  workspace: context.workspace,
  identity: context.identity,
  maxTurns: this.#maxTurns,
  hooks: this.#hooks,
  permissionPolicy: this.#permissionPolicy,
});
const result = await runner.run(input.description);
return toolSuccess(result.finalText);
```

No code here copies the message loop. The parent Agent and the subagent use the same `AgentRunner`. Message pairing, tool dispatch, permission, hooks, and Stop behavior all go through the same implementation.

---

## 3. Why the Parent History Stays Clean

Assume that the parent model calls:

```typescript
toolCall(
  "parent-task",
  "task",
  '{"description":"Trace the call chain of login() and give file evidence"}',
);
```

The subagent can run many turns of `read_file`, `glob`, or `shell`, but `SubagentTool` returns only its final text:

```typescript
return toolSuccess(result.finalText);
```

So the parent history stores only four kinds of message:

```text
user:      Parent task
assistant: tool_calls=[task(parent-task)]
tool:      The subagent's finalText, toolCallId=parent-task
assistant: The parent Agent's final answer
```

The code does not append the subagent's internal history to the parent Agent. The parent Loop still writes the return value of `task` as a tool message with the same ID as `parent-task`, so the OpenAI tool pairing contract has no exception.

This is also where this chapter is more valuable than "let the parent Agent keep reading files itself": the subagent can have a very long exploration trail, but the parent context keeps only the delegated action and a conclusion that later reasoning can use.

Put the message counts of the two approaches side by side, and the gap is obvious. Assume that this exploration needs 8 tool calls:

```text
❌ The parent Agent does it itself
   user + assistant + (8 × [assistant tool_calls, tool result]) + assistant
   = 18 messages in the parent history, and 16 of them are exploration waste

✅ Delegate to a subagent
   user + assistant(task) + tool(conclusion) + assistant
   = 4 messages in the parent history. The 16 exploration messages stay in the subagent and disappear with it
```

**Note the word "disappear".** The runtime does not persist the subagent's history, does not write it to disk, and does not send it back. After `task` returns, the garbage collector collects it. This is a double-edged sword:

| Benefit | Cost |
| --- | --- |
| The parent context is very clean | You **cannot audit** the subagent's reasoning process |
| The parent Agent is not led astray by intermediate errors | If the subagent takes a wrong path, the parent Agent sees only one wrong conclusion |
| The exploration length does not affect the parent's token budget | Problems are hard to reproduce — unless you record the process separately |

Row 2 is the most realistic risk of this capability. This is why `DEFAULT_SUBAGENT_SYSTEM_PROMPT` contains the words `evidence-based`, and why this chapter recommends that the description state the requirement explicitly: "return only conclusions that the file contents support" — **the parent Agent's only quality handle is whether that one conclusion carries verifiable evidence** (file names, line numbers, command output).

The artifact persistence in Chapter 8 and the file memory in Chapter 9 will provide another path for the requirement "the subagent's process must leave a trace". This chapter deliberately does not build it.

---

## 4. History Is Isolated, the Runtime Boundary Is Shared

The subagent uses a new `AgentRunner`, but it does not use a new permission system. The constructor receives the same instances that the parent session's composition root created:

```typescript
hooks: this.#hooks,
permissionPolicy: this.#permissionPolicy,
workspace: context.workspace,
identity: context.identity,
```

This means that a child tool call still runs in this order:

```text
PreToolUse Hook
-> PermissionPolicy
-> handler
-> PostToolUse Hook
```

For example, the subagent tries to write outside the workspace:

```json
{
  "path": "../outside.txt",
  "content": "changed"
}
```

The Chapter 3 workspace hard boundary produces a deny first. Even if the terminal approval provider would allow the write, the runtime does not call it, and the handler does not run. The child model receives only the matching error result:

```text
Error [permission_denied]: Writing outside the workspace is forbidden
```

In the opposite direction, a legal child `write_file` still requests approval under the original policy and writes into the same workspace. A file that the subagent writes is not a temporary copy. The parent Agent can read it, edit it, or verify it later.

---

## 5. Why Recursive Delegation Must Be Forbidden

The parent in P06 has 7 tools:

```text
shell
read_file
write_file
edit_file
glob
todo_write
task
```

The child tools factory creates an independent standard tool set, and it keeps only the first six tools. It does not register `task`.

The runtime also performs a second-layer check:

```typescript
if (tools.names.includes(TASK_TOOL_NAME)) {
  return toolError(
    "subagent_configuration_error",
    "Subagent tools must not include task",
  );
}
```

Why do the two layers "the factory does not register it" and "the runtime rejects it" exist at the same time? The first layer is the normal assembly path. The second layer protects the configuration boundary when someone rewrites the factory incorrectly. The code returns a configuration error before any model call, and it does not start a child session that could nest without limit.

The table lists what each of the three lines of defence can stop:

| Line of defence | Where it is | What it stops | What happens if it is the only line |
| ---: | --- | --- | --- |
| ① Prompt | `Do not delegate further.` | The model's **intent** | The model can ignore the prompt directly |
| ② Factory | `createStandardTools()` does not register `task` | The child tool set **has no** `task` | It breaks when someone changes the factory |
| ③ Runtime | `tools.names.includes(TASK_TOOL_NAME)` | The case where the factory **was changed incorrectly** | —— |

Note the return timing of the third line of defence: it runs **before** `new AgentRunner(...)`. That is, when the configuration is wrong, the model request count is **0**:

```text
The task handler starts
  ↓
toolsFactory() → returns a registry that contains task
  ↓
❌ Return at once: Error [subagent_configuration_error]: Subagent tools must not include task
  ↓
(AgentRunner was not created, the model was never called)
```

This "zero model calls" property has a test assertion (see Section 8). Its meaning is this: **a configuration error must not cost money, and it must not produce any side effect.**

If the child model still generates a `task(...)` call, the Registry returns a result like it does for any other unknown tool:

```text
Error [unknown_tool]: Unknown tool: task
```

On the next turn, the child model can continue its own work from this result, or it can give a conclusion. But it cannot create a grandchild Agent.

---

## 6. The 30-Turn Limit and Masked Errors

The code defines the default limit as:

```typescript
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
```

When you construct a `SubagentTool`, you may lower the limit for a test, but you may not raise it above 30:

```typescript
if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
  throw new Error("maxTurns must be a positive integer");
}
if (maxTurns > DEFAULT_SUBAGENT_MAX_TURNS) {
  throw new Error("maxTurns must be at most 30");
}
```

Validation in the constructor exposes a configuration error early, in the composition root. It does not wait until the first `task` call fails. Because the limit is fixed at construction time, a test can use a smaller `maxTurns` value to verify the boundary, and a production run still has a uniform cap of 30 turns.

When the child model returns tool calls for 30 turns in a row, the shared Loop throws an `AgentLimitError`. The `task` handler converts it into a stable error at its own execution boundary:

```typescript
if (error instanceof AgentLimitError) {
  return toolError(
    "subagent_turn_limit",
    `Subagent exceeded max_turns=${this.#maxTurns} without a final answer`,
  );
}
```

The parent model receives:

```text
Error [subagent_turn_limit]: Subagent exceeded max_turns=30 without a final answer
```

It does not receive the last tool output of turn 30, and it cannot mistake that output for the subtask conclusion.

This rule deserves an expansion, because "return the last result as a fallback" looks friendlier, but it is in fact more dangerous:

```text
❌ If the runtime returns the tool output of turn 30 as the conclusion
   The subagent ran 30 turns, and the last turn happens to be a glob that lists 40 file names
   → The parent Agent receives: a list of file names
   → The parent Agent treats it as "the subtask conclusion" and keeps reasoning
   → The parent Agent does not know that the subtask is in fact not finished

✅ The current approach
   → The parent Agent receives: Error [subagent_turn_limit]: Subagent exceeded max_turns=30 without a final answer
   → The parent Agent knows clearly: the delegation failed, and it must split the task into smaller tasks and retry, or change strategy
```

The difference is that **"no conclusion" and "an unreliable conclusion" are two completely different kinds of information**. The parent Agent can handle the first kind correctly. The second kind silently pollutes all later reasoning. This is the same principle as the Chapter 3 rule "a rejection must also return one clear error".


Other exceptions are also masked at the `task` boundary:

```typescript
return toolError("subagent_execution_error", "Subagent execution failed");
```

This chapter produces four structured errors in total. The `task` boundary produces all of them, and the parent model can route on the error code:

| Error code | When it appears | What the parent Agent should do |
| --- | --- | --- |
| `invalid_arguments` | `description` is empty, all whitespace, or has an unknown field | Fix the description and retry (the handler never ran) |
| `subagent_configuration_error` | The factory returned something that is not a `ToolRegistry`, contains `task`, or is not a `ModelClient` | This is a **code bug**. A retry is useless |
| `subagent_turn_limit` | The subagent used all turns and still has no final text | Split the task into smaller tasks and delegate again |
| `subagent_execution_error` | All other internal exceptions | Information is insufficient. The parent should usually report failure |

So the model never sees an API key, a file path, or adapter details that an internal exception may contain. The `try/catch` here is controlled output at a task execution boundary. It is not failure-swallowing inside business logic. The parent Agent can use the structured error code to decide whether to retry, rewrite the task, or report failure directly.

How do "do not `try/catch` in business logic" and "you may `try/catch` here" fit together? Look at what this `catch` does:

```text
It does not: swallow the exception and keep running
             use ?? to give a missing field a default value
             pretend that the operation succeeded

It does: translate the exception into a failure result with an error code that the parent model can recognise
         and clearly separate "it exceeded the turns" from "something else went wrong"
```

The test standard is **whether the caller can still know that the operation failed after this `catch`**. Here the caller can know — the parent Agent receives a tool result with `isError: true`. So this `catch` is "controlled output at an execution boundary". It is the same class of code as the `catch` at the outermost layer of an API handler. It is not failure-hiding inside business logic.

---

## 7. How the Composition Root Wires P06

`buildAgent()` is still the only composition root. It first creates the standard tools of the first five chapters, and then it creates a `SubagentTool` for P06:

```typescript
const standardTools = createStandardTools(profile, commandRunner, fileSystem);
const tools = standardTools.tools;
const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);

const hooks =
  dependencies.hooks === undefined && profile.capabilities.has("hooks")
    ? new HookRegistry()
    : dependencies.hooks;

if (profile.capabilities.has("subagent")) {
  if (hooks === undefined || permissionPolicy === undefined) {
    throw new Error("subagent capability requires hooks and permission policy");
  }

  const subagent = new SubagentTool({
    modelFactory: () => dependencies.model,
    toolsFactory: () => createStandardTools(profile, commandRunner, fileSystem).tools,
    hooks,
    permissionPolicy,
  });
  tools.register(subagent.toolDefinition);
}
```

`createStandardTools()` is the only exit point for the tool assembly of the first five chapters. It creates the shell and file tool sets by chapter, and on P05/P06 it registers a `TodoTracker` as both a tool and a per-turn observer. The parent Agent and the subagent both create independent registries through the same factory. So the parent TODO state is not read or written by the child, and the child still reuses the same standard tool contracts.

Two points deserve attention:

- Every `toolsFactory()` call creates a new `ToolRegistry`. So different subtasks do not share a Tool Registry, and they do not share a TODO snapshot.
- `modelFactory()` returns the model boundary that the composition root injected. So the real CLI still has only one OpenAI configuration path, and an offline test can still inject a `ScriptedModelClient`.

The second point is easy to misread, so let me state it clearly: `modelFactory: () => dependencies.model` returns **the same instance** on every call. The factory exists not to "create a new model client each time", but to leave the decision about "when to fetch it" with `SubagentTool`. Only the Tool Registry is genuinely new on each call.

```text
modelFactory()  → returns the same dependencies.model every time
toolsFactory()  → creates a new ToolRegistry every time (with a new TodoTracker)
```

This also explains a phenomenon in the offline tests that looks strange at first sight: parent and child share one `ScriptedModelClient`, so that scripted reply queue is **shared by parent and child in time order**. The four replies in the test are, in order, "the parent calls task" → "the child calls write_file" → "the child gives a conclusion" → "the parent gives a conclusion". This is the reason.

There is also one **deliberate asymmetry** worth remembering. It sits on the `toolsFactory` line:

```typescript
toolsFactory: () => createStandardTools(profile, commandRunner, fileSystem).tools,
//                                                                        ^^^^^^
//                                                    Take only tools, discard the todoTracker
```

The consequences are:

| | Parent Agent | Subagent |
| --- | --- | --- |
| The tool list contains `todo_write` | ✅ | ✅ |
| The system prompt mentions the TODO convention | ✅ (it appends `TODO_SYSTEM_PROMPT`) | ❌ (it uses the dedicated subagent prompt) |
| A `toolRoundObserver` is attached | ✅ | ❌ |
| It receives a "plan is stale" reminder | ✅ | ❌ |

That is, **the subagent can call `todo_write`, but nobody reminds it, and nobody reads its snapshot.** This is reasonable: the subagent does only one self-contained small task, with at most 30 turns, and it does not need the plan-tracking mechanism for long tasks in the first place.

But this is indeed an asymmetry of "the tool exists, the mechanism is absent". Writing it out explicitly is better than letting the reader discover it in the source code — **it is a trade-off, not an omission.**

The fixed entry point of Chapter 6 does not copy the runtime either:

```typescript
import { runProfile } from "../cli.js";
import { P06 } from "../core/profiles.js";

process.exitCode = await runProfile(P06, process.argv.slice(2));
```

---

## 8. Prove the Behavior with Offline Tests

`npm run test:ch06` runs **16 test files and 118 tests**. Compared with Chapter 5's 14 files / 109 tests, this chapter adds two files:

| Test file | What it verifies |
| --- | --- |
| `subagents.test.ts` | The unit layer: schema, limit, isolation, sharing, recursion interception, error masking (the largest test file in this chapter, 14 KB) |
| `ch06-subagents.test.ts` | End to end: from `buildAgent(P06, ...)`, it verifies tool visibility in the real wiring, side-effect retention, and the hard boundary |

The Chapter 6 domain test `subagents.test.ts` covers:

- The strict argument schema and the 30-turn limit;
- The parent history contains only the `task` result, and the child history starts again from system + user;
- Parent and child share hooks, permission, workspace, and identity;
- Every call executes the model/tools factories again, and gets a new Tool Registry, a new Runner, and a new child history;
- A recursive `task` becomes an `unknown_tool`;
- A write outside the workspace is rejected before the child handler;
- Turn exhaustion and unexpected exceptions both return masked structured errors;
- When the child tools factory registers `task` again by mistake, the model receives zero calls.

The composition root test `ch06-subagents.test.ts` has only two `test` blocks, but every assertion maps to one design conclusion of this chapter. **All the data in the section "Look at One Real Delegation First" comes from here.**

The key assertions of the first test, `P06 isolates child trajectory while preserving an approved file side effect`:

```typescript
// ① The subagent's write really reached the disk, and parent and child share one workspace
expect(await readFile(join(workspace, "child.txt"), "utf8")).toBe("child evidence");
// ② The parent sees 7 tools
expect(model.requests[0]?.tools.map((t) => t.function.name)).toEqual([
  "shell", "read_file", "write_file", "edit_file", "glob", "todo_write", "task",
]);
// ③ The child sees 6 tools, and task is not among them
expect(model.requests[1]?.tools.map((t) => t.function.name)).toEqual([
  "shell", "read_file", "write_file", "edit_file", "glob", "todo_write",
]);
// ④ The child's message array is "exactly" these two — with toEqual, not toContain
expect(model.requests[1]?.messages).toEqual([
  { role: "system", content: DEFAULT_SUBAGENT_SYSTEM_PROMPT },
  { role: "user", content: "write child.txt with evidence" },
]);
// ⑤ The parent history is "exactly" these four
expect(result.history).toEqual([
  { role: "user", content: "delegate the write" },
  assistantMessage(null, [parentCall]),
  { role: "tool", content: "child conclusion", toolCallId: "parent-task" },
  assistantMessage("parent final"),
]);
// ⑥ Only write_file requested approval; task itself did not
expect(approval.requests.map((r) => r.prepared.call.name)).toEqual(["write_file"]);
// ⑦ The audit log has two records: task and the subagent's write_file
expect(audit.records.map((r) => [r.tool, r.decision.behavior])).toEqual([
  ["task", "allow"], ["write_file", "allow"],
]);
validateToolPairing(result.history);
model.assertExhausted();
```

Assertions ④ and ⑤ use `toEqual`, not `toContain`/`toMatchObject`. This is not a style question:

| Assertion | Conclusion it pins down |
| --- | --- |
| ④ The child's messages are **exactly** 2 | Not one parent history message leaked in. `toContain` cannot prove this |
| The `user` content in ④ has no leading or trailing spaces | The schema `trim()` took effect before the delegation |
| ⑤ The parent history is **exactly** 4 | Neither the subagent's `write_file` call nor its tool result flowed back |
| ⑥ | `task` itself needs no approval (its effect is `external`, and it does not match a write rule) |
| ⑦ | But `task` still passed a permission evaluation and left an audit record. **No dialog ≠ no governance** |
| `model.assertExhausted()` | The four scripted replies are used up. Parent and child together made not one extra model request |

The second test, `child cannot turn approval into a workspace escape`, is the most important security assertion in this chapter. It configures an approver that **always returns allow**, and then it makes the subagent write `../outside.txt`:

```typescript
expect(await readFile(outside, "utf8")).toBe("sentinel");     // The file was not changed
expect(approval.requests).toEqual([]);                        // The approver was never asked
expect(audit.records.map((r) => [r.tool, r.decision.behavior])).toEqual([
  ["task", "allow"], ["write_file", "deny"],                  // The audit log records the deny explicitly
]);
expect(model.requests[2]?.messages.at(-1)).toEqual({
  role: "tool",
  content: "Error [permission_denied]: Writing outside the workspace is forbidden",
  toolCallId: "outside-write",
});
```

Line 2 is the assertion you should remember most in this whole chapter. **The approver says "approve everything", but the runtime never calls it once** — because the workspace hard boundary runs before the rules, and an out-of-bounds write never reaches the approval step. What this assertion proves is not "it was rejected", but **"the delegation created no new path around governance"**.

Run the smallest Chapter 6 acceptance first:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run typecheck
npm run test:ch06
```

This chapter changed the composition root, the profile, and the way the shared Loop is called, so you should also run the complete gates before you commit:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm test
npm run lint
npm run format:check
npm run build
```

These tests do not read `.env` and do not access the network. They use scriptable model replies to prove the runtime contract. They do not treat one real model call as coverage.

---

## 9. Run Chapter 6

### Step 0: Prepare the environment

Exactly as in the first five chapters: run `npm ci` in `code/`, and fill in the three variables in `.env`.

```powershell
Set-Location 'F:\笔记\Agent实操\code'
```

### Step 1: Run the offline tests first

```powershell
npm run test:ch06
```

Expected last two lines:

```text
 Test Files  16 passed (16)
      Tests  118 passed (118)
```

### Step 2: Observe one real delegation

```powershell
npm run ch06 -- --prompt "Use task to independently check which test framework this project uses, and return only conclusions with file evidence"
```

You should see interleaved parent and child logs on stderr. **The Hook registry is a shared instance, so the subagent's `run()` also prints `UserPromptSubmit` and `Stop`**:

```text
[Hook] UserPromptSubmit                  ← The parent Agent's run()
[Hook] PreToolUse: task                  ← The parent Agent's delegation
[Permission] task: allow (default) - No permission rule blocked the request
[Hook] UserPromptSubmit                  ← ★ The subagent's run() starts
[Hook] PreToolUse: read_file             ← The subagent is working
[Permission] read_file: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: read_file -> ok
[Hook] PreToolUse: glob                  ← The subagent continues
[Permission] glob: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: glob -> ok
[Hook] Stop                              ← ★ The subagent gives its final text, and its run() ends
[Hook] PostToolUse: task -> ok            ← The subagent has ended, so task returns now
[Hook] Stop                              ← The parent Agent's run() ends
```

Please note three things in particular:

1. **The subagent's tool calls also print `[Hook]` and `[Permission]` logs** — the Hook registry and the permission policy are shared instances, and the subagent has no exemption.
2. **The log prints `UserPromptSubmit` twice and `Stop` twice.** Parent and child each called `run()` once, and the Hook registry is the same one. The log has no "this is the subagent" mark; you must judge from the position.
3. **`PostToolUse: task -> ok` appears after the subagent's `Stop`**, and it wraps all of the subagent's logs. This is the visible form of "`task` waits synchronously until the subagent finishes".

Point 2 is a real observation limit of this chapter: **the cost of a shared `HookRegistry` is that the logs cannot distinguish parent from child.** If you want to distinguish them, a Hook callback can maintain a nesting depth counter itself — but that is a reader extension. This chapter does not build it.

### Step 3: Observe whether approval stops a delegation

```powershell
npm run ch06 -- --prompt "Use task to make the subagent write one sentence into sub-demo.txt"
```

Expected order:

```text
[Hook] PreToolUse: task
[Permission] task: allow (default) - ...      ← task itself needs no approval
[Hook] PreToolUse: write_file

Tool call requires approval: write_file                  ← The subagent triggered approval
Reason: File writes require explicit approval from chapter 3 onward
Allow this call? [y/N] y

[Permission] write_file: allow (terminal-approval) - User approved this tool call
[Hook] PostToolUse: write_file -> ok
[Hook] PostToolUse: task -> ok
```

This step shows two things at the same time: `task` itself is `allow`; **the subagent's write still pops up in front of you**. The approval dialog does not state "the subagent started this" — because parent and child share identity. See the table in Section 4.

### Step 4: The unified entry point

```powershell
npm run agent-tutorial -- run --chapter 6 --prompt "Use task to summarise the responsibilities of the chapters/ch06/src/core directory, then let the parent Agent give the conclusion"
```

### Step 5 (optional): The complete offline gates

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

Whether a real model actively uses `task` in a given job still has randomness, so the more reliable verification is to observe the run logs and the offline tests. In one run, you should see the parent model call `task` first, and then the child model receive a new history. The subagent's intermediate reads and writes do not flow back into the parent history. The parent model receives only the final conclusion or a structured error.

### Troubleshooting common errors

| Symptom | Cause | What to do |
| --- | --- | --- |
| The model never calls `task` at all | The tool description and the system prompt only guide the model | State "use task to complete X independently" in the prompt; or accept this result |
| `Error [invalid_arguments]` | `description` is an empty string, all whitespace, or carries an unknown field | Correct behavior. The handler never ran |
| `Error [subagent_turn_limit]` | The subagent used all 30 turns and still gave no final text | Split the delegated task into smaller tasks. **Do not** raise the limit — the constructor rejects a value above 30 |
| `Error [subagent_execution_error]` | An internal exception was masked | This error code deliberately carries no details. To investigate, look at stderr or add logging |
| `Error [subagent_configuration_error]` | The factory returned the wrong thing | This is a code bug. Check whether `toolsFactory` registered `task` by mistake |
| `Error [unknown_tool]: Unknown tool: task` | The child model tried to delegate recursively | Correct behavior. The child tool set has no `task` |
| Startup reports `subagent capability requires hooks and permission policy` | P06 needs hooks and a policy at the same time | The composition root adds a `HookRegistry` automatically; check whether you passed `approvalProvider`/`auditSink` |
| You cannot find a file that the subagent wrote | You looked in the wrong directory | Parent and child share one workspace. The file is there; it is not a temporary copy |
| An out-of-bounds write by the subagent opened no approval dialog | This is **expected behavior** | The hard boundary runs before the rules. An out-of-bounds write gets a direct `deny` and never reaches approval |
| You want to see the subagent's intermediate reasoning | This chapter leaves no trace | By design. The child history disappears when `task` returns. See Section 3 |

### Four small experiments to try

**Experiment 1: Set `maxTurns` to 31 and watch the constructor fail**

Add one line, `maxTurns: 31`, inside the `new SubagentTool({...})` call in `bootstrap.ts`, and then run any `npm run ch06` command.

Expected: **startup throws at once**, with `maxTurns must be at most 30`, and the model is never called.
What you learn: the limit is a construction-time check, not a runtime check. A configuration error should explode in the composition root, not at the first `task` call. **Remember to change it back after the experiment.**

**Experiment 2: Make the child tool set contain `task` on purpose**

Change `toolsFactory` so that it also registers a `task` (the simplest way is to make it return the parent's `tools`):

```typescript
toolsFactory: () => tools,     // ❌ Deliberate mistake: return the parent registry, which contains task
```

Expected: the `task` call returns `Error [subagent_configuration_error]: Subagent tools must not include task`, and **the model request count is only the parent's one request** (the subagent was never created).
What you learn: line of defence ③ in Section 5. **Remember to change it back after the experiment.**

**Experiment 3: Verify that "the subagent cannot see the parent history"**

Add a test in `subagents.test.ts`. Make the parent Agent read a file first, and then delegate:

```text
Parent Agent: read_file note.txt  →  receives the content "SECRET"
Parent Agent: task("Tell me what note.txt says, based only on what you read yourself")
Does "SECRET" appear in the subagent's messages[1].content?
```

Expected: **no**. The subagent sees only the description sentence. It must read the file again itself.
What you learn: the isolation is real isolation. This is also why the description must be self-contained.

**Experiment 4: Observe whether the subagent's `todo_write` gets a reminder**

Make the subagent call `read_file` four times in a row (script it with a `ScriptedModelClient`), and then check whether `TODO_STALE_REMINDER` appears in the child model's fourth request.

Expected: **no**. The subagent has no `toolRoundObserver` attached.
What you learn: the last row of the "deliberate asymmetry" table in Section 7. The subagent has the tool, but not the mechanism.

---

## 10. What This Chapter Did Not Do

The most common misunderstanding after a beginner reads a chapter is "this capability is now complete". So this section lays the boundary out: the left column is what P06 really has, the middle column is what it does not have, and the right column states in which chapter the gap is filled (or why it is never filled).

| Already has | Does not have yet | When it is filled |
| --- | --- | --- |
| One layer of synchronous delegation | A recursive / nested Agent tree | **Never**. The runtime blocks it hard. See Section 5 |
| A fresh history (Normal mode) | Fork mode (share the parent prompt prefix to reuse the cache) | **Never**. It would blur the teaching boundary "the subtask context is independent" |
| Context isolation | Process / container isolation | **Never**. A Subagent was never a security sandbox |
| A shared `HookRegistry` | Distinguish parent from child in Hook logs | **Never**. If you want it, count the depth in the callback yourself |
| Serial execution of one subtask | Run multiple subtasks in parallel | Chapter 13 (background tasks) |
| Child history is discarded after use | Persist the child history to disk, auditable | Chapters 8 and 9 (compaction artifacts and file memory) |
| Wait synchronously for the return | Background execution + completion notification | Chapters 13 and 15 |
| A hard limit of 30 turns | A dynamic budget, a limit billed by tokens | Chapter 11 (API recovery and a total time limit) |
| Four structured error codes | An intermediate state such as "the subagent finished part of the work" | Either there is a `finalText`, or there is an error. There is no third state |

This chapter adds only one controlled context split point: the parent Agent delegates independent work out, and it keeps the final conclusion and all existing runtime boundaries.

---

## 11. Differences from Claude Code

The `task` tool in this chapter is a teaching subset. Claude Code's built-in Subagent has the same design goal: it prevents searches, logs, and file contents from drowning the main context. See the official documentation: https://code.claude.com/docs/en/sub-agents. The main differences are:

- The way the message history is created differs. Claude Code has three Subagent modes: Normal uses a fresh history, Fork keeps a parent message prefix so it can share the prompt cache, and General-purpose can read and write and supports background and asynchronous tasks. This chapter implements only the simplest Normal mode. It deliberately does not introduce a shared history, so it does not break the teaching boundary "the subtask context is independent".
- Recursive delegation differs. The real Claude Code allows nested Subagents, but a depth limit and the Agent tool manage them. For teaching safety, this chapter forbids the subagent from calling `task` again, and it keeps only one layer of delegation.
- Background work and notifications differ. Claude Code supports background Subagents, permission bubbling, and completion notifications. The `task` tool in this chapter waits synchronously until the subagent finishes. It introduces no concurrent Job, no event queue, and no persisted result.
- The permission semantics agree. In the real Claude Code, when the parent uses `bypassPermissions` or `acceptEdits`, the subagent cannot override it. In this chapter, parent and child share the same `PermissionPolicy` and `HookRegistry`, and context isolation does not automatically lower or raise permission.
- The stop conditions agree. In "Building Effective Agents", Anthropic describes an Agent as "LLM + tool loop", and it requires clear stop conditions (https://www.anthropic.com/engineering/building-effective-agents). The `maxTurns` and `finalText` in P06 are the testable landing point of this principle: the subagent either gives a final text, or it returns a structured `subagent_turn_limit`.

---

## Chapter Summary

### The three-sentence version

1. `task` moves one self-contained exploration into a fresh history and runs it there. The parent Agent receives only one conclusion back.
2. The **only** isolated things are the message history and the Tool Registry; hooks, permission, workspace, identity, and process are all shared.
3. Delegation creates no new path: a subagent approval that must pop up still pops up, and an out-of-bounds write that must be blocked is still blocked.

### Eight points you must remember

| # | Conclusion | Where it appears |
| ---: | --- | --- |
| 1 | "Isolation" = context isolation. It is **not** a sandbox, not a permission increase, and not a permission decrease | What Problem This Chapter Solves |
| 2 | The subagent cannot see the parent history, so the description must be self-contained | 1 |
| 3 | `SubagentTool` is not a second Loop. It reuses the same `AgentRunner` | 2 |
| 4 | The parent history gains only three messages: `assistant(task)`, `tool(conclusion)`, `assistant(final answer)` | 3 |
| 5 | The cost is that you cannot audit the subagent's reasoning — so the conclusion must be evidence-based | 3 |
| 6 | The ban on recursion has three layers of defence: prompt, factory, runtime. The third layer guarantees "zero model calls" | 5 |
| 7 | When the subagent uses all turns, the runtime returns a structured error. It **never** presents the last tool output as the conclusion | 6 |
| 8 | The subagent has `todo_write` but no `toolRoundObserver` — a deliberate asymmetry | 7 |

### The code boundary of this chapter

One sentence: **P06 adds only "one layer of synchronous delegation". It adds no parallelism, no persistence, and no sandbox.** The complete comparison table of "what it has / what it does not have / which chapter fills it" is in Section 10. After you read the summary, go back and scan that table.

### Check whether you really understood it

1. After `task` returns, does a file that the subagent wrote in the workspace still exist? Why? (What Problem This Chapter Solves)
2. The parent Agent calls `task` once. How many messages does the parent history gain, and what are they? (3)
3. Is the system prompt that the subagent sees the parent Agent's prompt? (Look at One Real Delegation First / 8)
4. Does the subagent's `write_file` open an approval dialog? Can you tell from the approval dialog that this is a subagent? (What Problem This Chapter Solves / 9)
5. Give the subagent an approver that "always approves". Can it write outside the workspace? How many times was the approver called? (8)
6. The child model generates a `task(...)` call itself. What does it receive? (5)
7. The subagent uses all 30 turns. Does the parent Agent receive the tool output of turn 30, or something else? Why is this design better? (6)
8. Why does the `try/catch` inside the `task` handler not violate the rule "do not catch in business logic"? (6)
9. The subagent's tool list contains `todo_write`. Will it receive a "plan is stale" reminder? (7)

---

The next chapter will handle another kind of context growth: different tasks need different conventions and background knowledge, but not all knowledge should live permanently in the system prompt. Chapter 7 will introduce the Skill, which loads on demand.
