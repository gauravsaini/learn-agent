The Agents of the first two chapters can already execute PowerShell, and can read, write, edit, and search files.

The capability is enough. The risk appears with it.

Assume the user only said "clean up the temporary files in the project", but the model generated:

```powershell
Remove-Item -LiteralPath 'C:\temp' -Recurse -Force
```

If the runtime has no permission boundary, the Agent Loop hands the command to PowerShell as usual. If the model writes one path wrong, the impact scope can be completely different.

The problem is not that the model is "bad". The model is only predicting the next step. The real problem is this: we delegated safety entirely to a probability model, and we set no deterministic boundary before the side effect happens.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaFZX46nUicBnzwhcj5A1LPCMCUrsiaiaI1N3NlnT57C5f2QrXzTAWHfRPvnib0Lzrnasmzsr5kw8jdNoAvqfibM8M5pf0PtH14ZLC0Q/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

This chapter inserts a structured permission policy between tool preparation and handler execution.

---

## Chapter guide

### What you can do after this chapter

1. Explain why a permission judgement cannot be written in the system prompt, and can be written only at a fixed position in the code.
2. Draw the order `prepare → permission → invoke` by hand, and explain what is lost if the order is reversed.
3. Explain the use of each of the four behaviors `allow` / `deny` / `ask` / `passthrough`, and why a boolean is not enough.
4. State the priority `deny > ask > allow > passthrough`, and give an example of "a rule says allow, but it is still denied".
5. List all cases that turn an `ask` into a `deny` (seven in total), and explain that this is called fail closed.
6. Judge which path a call takes: allowed directly, approval popup, or hard rejection.

### What you need first

| Need | Explanation |
| --- | --- |
| Read chapters 1 and 2 | This chapter builds directly on the separation of `ToolRegistry.prepare()` / `invoke()` |
| Understand the `effect` label | Chapter 2 labelled every tool `read` / `write` / `execute`; this chapter starts to **really use it** |
| Understand `safePath` | This chapter's workspace hard boundary reuses chapter 2's `safePath` |
| Can run `npm run ch02` | This chapter runs in exactly the same way, with only the approval interaction added |

No security or cryptography background is needed. Everything in this chapter is an engineering problem of the kind "on which line of code is the judgement made".

### Quick term reference (terms that first appear in this chapter)

| Term | One-line explanation |
| --- | --- |
| **PermissionDecision** | One immutable permission conclusion, with three parts: behavior + reason + source |
| **behavior** | The conclusion itself: `allow` / `deny` / `ask` / `passthrough` |
| **reason** | A reason a human can read. It enters the audit, and it enters the model's view |
| **source** | Who made the decision. A rule name, `shell-default`, `terminal-approval`, `workspace-boundary`, or `default` |
| **PermissionRequest** | The permission system's input. **It accepts only calls that passed Zod validation** |
| **PermissionRule** | One rule = name + behavior + reason + match function |
| **PermissionPolicy** | The place that merges all participants and produces the single final decision |
| **Participant** | A role that can propose a candidate decision: the hard boundary, the Shell default, rules, Hook suggestions |
| **ApprovalProvider** | The approval boundary. Only it can converge an `ask` into an `allow` or a `deny` |
| **AuditSink** | The audit boundary. It records the **final** decision; if it fails, nothing executes |
| **WorkspaceWriteBoundary** | The system hard boundary. It judges whether a write path is inside the workspace |
| **fail closed** | When a judgement dependency fails, choose rejection — do not treat "unknown" as "allowed" |
| **recommendations** | The candidate decision list passed in by an upstream participant (chapter 4's Hooks). Reserved in this chapter, not used |
| **permission_denied** | The stable error code for a permission rejection, filled back to the model |
| **permission_evaluation_error** | The stable error code for a fault in the permission system itself |

### Suggested reading route

```text
Chapter guide (you are here)
  ↓
① Look at a real decision process first   ← Three calls produce three results; build the picture first
  ↓
② Acceptance results + why not the Prompt   ← What this chapter proves, and why it must be in the code
  ↓
③ The four-state decision   ← Why not a boolean; the role of each of the three fields
  ↓
④ Requests and rules   ← The permission layer's input contract; what one rule looks like
  ↓
⑤ How the three gates merge   ← This chapter's most core section: priority
  ↓
⑥ Hard boundary / Shell / approval / audit   ← The four participants, one by one
  ↓
⑦ Insert into the Agent Loop + P02/P03 differences   ← Only a dozen or so lines added; how much did the capability boundary change
  ↓
⑧ Four scenarios + effect-driven   ← Apply all the earlier rules to concrete calls
  ↓
⑨ Boundaries, run, verification, and summary   ← What is deliberately not done + hands-on + troubleshooting + self-test
```

---

## Look at a real decision process first

Do not look at code yet. Assume the model proposes three calls in order in the same session, and watch which step each one reaches.

### Call A: `glob` (read)

```json
{"pattern":"chapters/ch03/src/**/*.ts"}
```

```text
① Workspace hard boundary   The effect is not write; it takes no position → no candidate
② Shell default             The effect is not execute; it takes no position → no candidate
③ Rules                     confirm-file-write does not match → no candidate
④ Merge                     No candidate at all → passthrough
⑤ Converge                  passthrough → allow (default)
⑥ Approval                  Not needed
⑦ Audit                     [Permission] glob: allow (default) - No permission rule blocked the request
⑧ Execute                   The handler runs
```

**Allowed by default, but a record is still left.**

### Call B: `write_file` (write, the path is inside the workspace)

```json
{"path":"chapter3-note.txt","content":"..."}
```

```text
① Workspace hard boundary   The effect is write, the path is inside the workspace → takes no position
② Shell default             Takes no position
③ Rules                     confirm-file-write matches → ask
④ Merge                     The strongest is ask
⑤ Converge                  Calls the ApprovalProvider
                 ↓
                 Tool call requires approval: write_file
                 Reason: File writes require explicit approval from chapter 3 onward
                 Arguments: {"path":"chapter3-note.txt","content":"..."}
                 Allow this call? [y/N] y
                 ↓
                 allow (terminal-approval)
⑥ Audit                     [Permission] write_file: allow (terminal-approval) - User approved this tool call
⑦ Execute                   The handler runs
```

**One key point here: the approval authorises only this once.** The next turn writes a file again, and it asks again.

### Call C: `write_file` (write, the path is outside the workspace)

```json
{"path":"../outside.txt","content":"x"}
```

```text
① Workspace hard boundary   The effect is write, safePath rejects → deny
② Shell default             Takes no position
③ Rules                     confirm-file-write matches → ask
④ Merge                     Both deny and ask are present → deny has priority
⑤ Converge                  A deny needs no approval; it is the final conclusion directly
⑥ Approval                  ❌ Never called; the user sees no prompt box at all
⑦ Audit                     [Permission] write_file: deny (workspace-boundary) - Writing outside the workspace is forbidden
⑧ Execute                   ❌ The handler never ran once
⑨ Fill back to the model    Error [permission_denied]: Writing outside the workspace is forbidden
```

Call C is this chapter's most important example. Note step ④: **the rule clearly said `ask` — "ask once and it can pass" — but the hard boundary's `deny` overrode it directly.** This is the meaning of `deny > ask` — it does not give the user the chance to "approve an operation that should not be approved".

### The three calls pressed into one table

| | Call A `glob` | Call B in-area write | Call C out-of-area write |
| --- | --- | --- | --- |
| Candidate decisions | None | `ask` (rule) | `deny` (hard boundary) + `ask` (rule) |
| Merge result | `passthrough` | `ask` | **`deny`** |
| Approval box pops up? | No | **Yes** | **No** |
| Handler executes? | Yes | Depends on the user input | **No** |
| Enters the audit? | Yes | Yes | Yes |

The last row deserves a separate look: **all three cases enter the audit.** The audit records not "dangerous operations" but "every final decision".

---

## Define the acceptance results first

P03 must satisfy these observable behaviors:

1. The priority of `deny` is higher than `ask`, `allow`, and `passthrough`.
2. When a `deny` hits, the user is not asked, and the handler does not execute.
3. An `ask` can execute only after it gets an explicit `allow` decision.
4. No approver, an approval exception, an illegal approval result, a direct Enter, and no interactive input — all default to rejection.
5. All `shell` calls enter approval by default; risk is not guessed from the command text.
6. Ordinary reads are allowed directly when no rule objects.
7. P02's file writes need no approval. Only P03's `write_file` and `edit_file` add approval.
8. A write outside the workspace is a system hard rejection. Rules, future Hook suggestions, and human approval cannot relax it.
9. A permission rejection and a permission evaluation exception must still generate a tool result paired with the original call ID.
10. Every final permission decision of P03 enters the audit.

The direct tests live in `code/chapters/ch03/tests/permissions.test.ts` and `code/chapters/ch03/tests/ch03-permissions.test.ts`.

---

## Why the Prompt is not a security boundary

You can write "do not delete system files" in the system prompt, but that is only a soft constraint:

- The model may understand it wrongly.
- The user input may conflict with the system instruction.
- A multi-turn context may weaken the early reminder.
- It is impossible to enumerate all dangerous command and path combinations.
- The Prompt cannot prove that a check executed before the side effect happened.

The permission policy must be in the code, and its position is fixed:

```text
The model returns tool_calls
        ↓
ToolRegistry.prepare: lookup + JSON parsing + Zod validation
        ↓
PermissionPolicy.decide: hard boundary + rules + approval + audit
        ↓
ToolRegistry.invoke: execute the handler
        ↓
Fill back the same tool_call_id
```

The model can only propose a call request. The Harness decides whether it executes.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaGKNqOlYiaBrungd4onbtrMkpGLMauRCnTNEMIf4Smm9EV6exPYialyhkS7uq4HL9MImmtXwwMCsdIqV5zAbwuicT0doia2uXcs0EU/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=2)

---

## Permission is not a boolean, but a four-state decision

If a permission function returns only `true` or `false`, the runtime does not know the difference between "the user must be asked" and "this rule has no opinion". It also cannot explain the decision source.

Use a concrete example to show why a boolean is not enough. Assume the permission function signature is `canRun(call): boolean`, and there are two rules now:

- Rule A: `write_file` needs human confirmation.
- Rule B: cares only about `shell`; it has no opinion on `write_file`.

When the model calls `write_file`, what does rule A return? Returning `false` becomes a direct rejection — but what it wants is "ask once". Returning `true` executes directly — the approval step disappears. **A boolean cannot express "defer".**

What does rule B return? Returning `true` says allowed, but it actually wants to say nothing. If the merge logic is "execute only when all rules return true", then a rule that takes no position becomes a yes vote — a semantic confusion that a permission system cannot accept.

This chapter defines four behaviors:

| behavior | Meaning |
| --- | --- |
| `allow` | Explicitly allow |
| `deny` | Explicitly reject |
| `ask` | One explicit approval must be obtained |
| `passthrough` | The current participant takes no position; leave it to other rules or the default value |

`passthrough` is the one of the four that is most easily ignored, but it is the most necessary by design. Its role is to **separate "abstain" from "agree"**. In the source, when a rule does not match, it returns `undefined` (it does not even produce a candidate). `passthrough` appears in another place: when no participant has an opinion, `strongestDecision()` returns it as the fallback, and the policy then converts it to the default `allow`. That way, "no rule objected" and "a rule explicitly allowed" are two different records in the audit.

`code/chapters/ch03/src/core/permissions.ts` uses a fixed tuple to provide both the runtime set and the TypeScript type:

```typescript
export const PERMISSION_BEHAVIORS = Object.freeze([
  "allow",
  "deny",
  "ask",
  "passthrough",
] as const);

export type PermissionBehavior =
  (typeof PERMISSION_BEHAVIORS)[number];
```

Every decision must also carry a reason and a source:

```typescript
const decision = new PermissionDecision(
  "ask",
  "File writes require explicit approval from chapter 3 onward",
  "confirm-file-write",
);
```

Each of the three fields has a clear consumer. Remove one, and someone cannot understand it:

| Field | Who uses it | What for |
| --- | --- | --- |
| `behavior` | The Agent Loop | Decides execute, reject, or pop up an approval |
| `reason` | The user + the model + the audit log | The "reason" shown in the approval box; the text filled back to the model when rejected |
| `source` | You (when troubleshooting) | Answers "who exactly rejected it" — the hard boundary? a rule? or the user? |

The value of `source` appears when something goes wrong. Imagine the approval box popped up, but you think it should not have — looking only at `behavior: "ask"` gives you nowhere to start. Seeing `source: "confirm-file-write"` tells you which rule to change. In the same way, seeing `source: "workspace-boundary"` says it is a path problem, and changing rules is useless.

`PermissionDecision` rejects an illegal behavior, an empty reason, and an empty source at construction, and freezes the instance. After construction, the outside cannot modify it. A final rejection can be converted directly to a stable tool result:

```typescript
toToolResult(): ToolResult {
  if (this.behavior !== "deny") {
    throw new PermissionContractError(
      "only a final deny decision can become a tool result",
    );
  }
  return toolError("permission_denied", this.reason);
}
```

So what the model sees is not a vague `Permission denied.`, but:

```text
Error [permission_denied]: Writing outside the workspace is forbidden
```

That `throw` deserves another look: `toToolResult()` **allows only a `deny` to call it**. Why limit it?

Because `ask` and `passthrough` are both **intermediate states**. If they appear in a final result, it must mean a bug. If an `ask` were allowed to convert to a tool result, the model would receive a "needs approval" message — but the approval step never ran, and nobody knows whether it should execute. Rather let the program crash here and expose the problem than produce a history with unclear semantics. This is one concrete application of "do not hide errors": **a contract violation must fail at once; do not pass an unclear value downstream.**

### ToolResult and the tool error code system

The return value of every tool call is not an ordinary string. It is a structured contract with semantics:

```typescript
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

export function toolError(errorCode: string, message: string): ToolResult {
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}
```

`isError` lets the Agent Loop know whether this call failed, without parsing text. `errorCode` is a stable error key, for example `permission_denied`, `unknown_tool`, `invalid_json`, `invalid_arguments`, `shell_timeout`, `path_escape`.

The model sees readable error text. Tests and upstream logic see structured fields.

A tool handler's return value is also treated as an untrusted boundary. `ToolRegistry.invoke()` validates the returned object with `isToolResult()`, to stop a custom handler's malformed structure from polluting the session history:

```typescript
if (!isToolResult(result)) {
  return toolError("invalid_tool_result", "Tool handler returned an invalid result");
}
```

So `PermissionDecision.toToolResult()` can fill back to the model stably: it uses `toolError("permission_denied", this.reason)` to generate an object that satisfies the `ToolResult` contract, then lets the Agent Loop complete the fill-back message paired with the original call ID.

---

## PermissionRequest accepts only prepared calls

A permission rule should not parse OpenAI arguments again, and it should not handle unknown tools.

`PermissionRequest` accepts only calls that passed `ToolRegistry.prepare()`:

```typescript
if (
  options.prepared.error !== undefined ||
  options.prepared.definition === undefined ||
  options.prepared.arguments === undefined
) {
  throw new PermissionContractError(
    "permission request requires a valid prepared tool call",
  );
}
```

At this point, the runtime already knows:

- The tool definition really exists.
- The arguments are a legal JSON object.
- The Zod schema passed.
- The tool's `effect` and handler come from a trusted local `ToolDefinition`.
- `ToolContext` has brought in the workspace and the identity.

Illegal JSON, extra fields, or wrong types fail before the permission system. This matters: the permission layer answers only "can a legal call execute". It does not repeat the Tool Registry's responsibility.

`recommendations` is a structured suggestion list. Chapter 3 does not produce it yet. Chapter 4's PreToolUse Hook will use this channel. A suggestion still joins the unified priority; it cannot bypass a system rejection.

### The ToolRegistry internal flow

The `prepared` the permission layer sees comes from `ToolRegistry.prepare()`. Before running, the registry has completed three things:

```typescript
const definition = this.#definitions.get(call.name);
if (definition === undefined) {
  return { call, error: toolError("unknown_tool", `Unknown tool: ${call.name}`) };
}
```

A tool name must be unique and contain only `A-Za-z0-9_`. At registration, the `ToolDefinition` is also converted to a `StoredToolDefinition`. The conversion wraps it in a fresh `parse()`, so even if a caller bypasses `prepare()` and calls `invoke()` directly, the handler cannot get unvalidated input.

Each Agent Loop turn uses `snapshot()` to take an immutable registry snapshot, preventing the registry from being tampered with between a model request and execution. `openAITools()` exposes only the name, description, and JSON Schema to the model. The handler, the effect, and the internal storage do not enter the tool definition the model can see.

A permission rejection does not break message pairing: `ToolRegistry.invoke()` also validates the handler return value with `isToolResult()`, and a malformed result is converted to `invalid_tool_result`.

---

## PermissionRule: condition, behavior, and reason in one place

One rule contains four items:

```typescript
const confirmFileWrite = new PermissionRule({
  name: "confirm-file-write",
  behavior: "ask",
  reason: "File writes require explicit approval from chapter 3 onward",
  matches: (request) => {
    const name = request.prepared.definition?.name;
    return name === "write_file" || name === "edit_file";
  },
});
```

The use of each of the four items:

| Field | Use | Where it appears |
| --- | --- | --- |
| `name` | The rule's stable identifier | The decision's `source`, the audit log |
| `behavior` | What it proposes when it matches | The decision's `behavior` |
| `reason` | Why | The approval box's "reason" line, the audit log, the text to the model when rejected |
| `matches` | When it applies | Called only inside the policy |

Putting these four items in the same object is deliberate. **If the `reason` and the judgement condition were written separately (for example, the condition in the rule and the text in the UI layer), the two would drift apart sooner or later** — someone changes the condition and forgets the text, and the explanation the user sees is wrong. When a rule matches, it automatically generates a `PermissionDecision` with the rule name as the source. When it does not match, it returns `undefined` — it does not join this merge.

This chapter installs only this one rule. Few rules does not mean a simple mechanism — the mechanism's value is that **adding a rule needs no change to `PermissionPolicy` and no change to the Agent Loop**. That is the same idea as chapter 2's "adding a tool needs only one line".

If a rule matcher throws an exception, the policy does not continue to assume it allows:

```typescript
try {
  return rule.evaluate(request);
} catch {
  return new PermissionDecision(
    "deny",
    `Permission rule failed: ${rule.name}`,
    rule.name,
  );
}
```

This is fail closed: when a permission dependency fails, reject. Do not interpret "cannot judge" as "can execute".

The OWASP AI Agent Security Cheat Sheet also lists "deny by default when a permission evaluation fails" as a basic tool security principle (https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html). P03's rule exceptions, approval exceptions, and audit exceptions are all handled by the same principle, instead of letting a policy fault degrade into a pass.

### PermissionContractError: a permission contract error

This chapter throws `PermissionContractError` in several places: an illegal behavior passed when constructing a `PermissionDecision`, an unprepared call passed when creating a `PermissionRequest`, `toToolResult()` called on a non-deny decision, and so on. Its design meaning: the permission system's caller violated the usage contract. It is not an external runtime fault.

```typescript
export class PermissionContractError extends Error {}
```

`PermissionContractError` follows the same execution path as an ordinary runtime error: the Agent Loop's boundary `try/catch` catches it, and converts it uniformly to a `permission_evaluation_error` filled back to the model. It does not propagate up to the bootstrap layer.

Its value is at the semantic level: it specifically means the permission system's caller violated the usage contract. Unit tests can use it to separate "the caller used the API wrongly" from "a permission evaluation fault".

---

## How the three gates merge

This section is this chapter's core. All earlier concepts converge here.

One permission judgement has three layers of input.

Layer one is the system hard boundary: a write outside the workspace gets a direct `deny`.

Layer two is the structured participants: the Shell default policy, the rules, and later chapters' Hook suggestions.

Layer three is explicit approval: called only when the merge result is `ask`.

### First, watch how the data flows

```text
                    ┌─────────────────────────────┐
                    │ candidates: PermissionDecision[] │
                    └─────────────────────────────┘
                                  ↑
    ① Workspace hard boundary ───────┤  effect=write and the path is out of bounds → push deny
    ② Shell default ────────────────┤  effect=execute → push ask
    ③ recommendations ─────────────┤  Chapter 4 Hook suggestions (empty in this chapter)
    ④ Rules evaluate one by one ────┘  On a match, push; on no match, return undefined and do not push
                                  ↓
                    strongestDecision(candidates)
                      Find the first deny → return it if there is one
                      Then find the first ask → return it if there is one
                      Then find the first allow → return it if there is one
                      None → passthrough
                                  ↓
                 ┌────────────────┼────────────────┐
              ask │            deny/allow │   passthrough │
                 ↓                ↓                ↓
        Call the ApprovalProvider   Used as the final conclusion as is   Convert to allow (default)
        Accepts only allow/deny
                 └────────────────┼────────────────┘
                                  ↓
                        audit.record(final conclusion)
                                  ↓
                     isAllowed ? invoke() : toToolResult()
```

Note that ①–④ **all run**. It is not "hit one and short-circuit". The four layers each produce candidates, and the comparison happens at the end. That way, the audit can show the complete conflict situation, not "whatever the rule that happened to match first said".

### Merge priority

The merge priority is fixed as:

```text
deny > ask > allow > passthrough
```

Remember it in one sentence: **the more conservative one wins.** More concretely:

| Candidate set | Final | Why |
| --- | --- | --- |
| `[]` | `allow` (default) | Nobody objected; read operations pass by default |
| `[allow]` | `allow` | The only opinion |
| `[ask]` | Go to approval | One human confirmation is needed |
| `[allow, ask]` | Go to approval | **`ask` wins.** One loose rule cannot cancel an approval |
| `[deny, ask]` | `deny` | **`deny` wins.** It does not even ask (call C is this case) |
| `[deny, allow]` | `deny` | `deny` wins. This is this chapter's most important invariant |

In reverse, this priority **guarantees one thing**: as long as any participant says `deny`, the result is rejection — no matter how many `allow` rules are added later, no matter what a Hook suggests, and no matter how many times the user presses `y`. When chapter 4 adds Hooks and chapter 19 connects MCP, this guarantee does not change by one word.

The core code finds the first decision in this order:

```typescript
function strongestDecision(
  decisions: readonly PermissionDecision[],
): PermissionDecision {
  for (const behavior of ["deny", "ask", "allow"] as const) {
    const decision = decisions.find(
      (candidate) => candidate.behavior === behavior,
    );
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

Only with a `passthrough`, or with no participant at all, does the final result use the default allow:

```typescript
final = new PermissionDecision(
  "allow",
  "No permission rule blocked the request",
  "default",
);
```

This is not "all operations are safe by default". `shell` produces an `ask` automatically. In P03, a write with a path first passes the workspace hard boundary, and the two file write tools also have an explicit `ask` rule. The default `allow` lands only on read operations that no rule objects to and no higher-priority decision covers.

Claude Code's official permission documentation uses the same evaluation order: deny, ask, allow are judged in sequence; a rule's specificity does not change the order; a deny at any level cannot be overwritten by an allow at another level (https://code.claude.com/docs/en/permissions).

---

## Why the workspace boundary must come before the rules

Consider this call:

```json
{"path":"../outside.txt","content":"x"}
```

A project rule may say writes are allowed. A future Hook may also suggest allow. The user may even enter `y`. But a write outside the workspace must still be rejected, and the approval box must not pop up first.

"Must not pop up the approval box first" is easy to treat as a user-experience optimisation. It is actually a security requirement. Imagine the box popping up first:

```text
Tool call requires approval: write_file
Reason: File writes require explicit approval from chapter 3 onward
Arguments: {"path":"../outside.txt","content":"x"}
Allow this call? [y/N]
```

The user is in a hurry and has pressed `y` several times in a row; this one gets pressed too. The system still rejects it afterwards — **so what was the point of this box?** It only teaches the user "approval may still not execute", and lowers the weight given to every later approval box. An approval box should appear only when "your answer really can decide the result".

`PermissionPolicy` therefore asks the trusted `WorkspaceWriteBoundary` first:

```typescript
const allowed = await this.#writeBoundary.isPathWithinWorkspace(
  request.context.workspace,
  rawPath,
);

return allowed
  ? undefined
  : new PermissionDecision(
      "deny",
      "Writing outside the workspace is forbidden",
      "workspace-boundary",
    );
```

The core depends only on the interface. It does not import a Node adapter. The `NodeWorkspaceFileSystem` injected by the composition root implements the real path judgement:

```typescript
async isPathWithinWorkspace(
  workspace: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await safePath(workspace, relativePath);
    return true;
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return false;
    }
    throw error;
  }
}
```

So this boundary inherits all of chapter 2's path guarantees: it rejects absolute paths, `..`, Windows reserved names, illegal characters, and junction or symbolic link escapes.

P03's composition root always injects the write boundary. If the real path resolution throws an exception, a write with a `path` gets:

```text
Write path could not be resolved safely
```

It does not degrade into an allow. The Shell-only policies of P01 and P02 do not install this participant; file paths are still validated by chapter 2's handler boundary. That keeps the old error semantics, and does not weaken P03.

---

## Why Shell is always ask

A keyword blacklist cannot judge whether PowerShell is safe.

`Get-Content` looks read-only, but its argument can point outside the workspace. An ordinary command can also call a script, start a child process, or access the network. Matching only words such as `Remove-Item` and `Format-Volume` is neither complete nor hard to bypass.

So as long as a tool's effect is `execute`, the system produces a default `ask`:

```typescript
if (definition.effect !== "execute") {
  return undefined;
}
return new PermissionDecision(
  "ask",
  "Shell execution requires approval",
  "shell-default",
);
```

The real CLIs of P01, P02, and P03 all keep this behavior. Offline tests can inject approval, audit, and file system doubles explicitly; they do not depend on a real terminal.

---

## An ask must get an explicit allow

`ApprovalProvider` is an asynchronous boundary:

```typescript
export interface ApprovalProvider {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}
```

Only a real `PermissionDecision("allow", ...)` can pass.

These cases all become a `deny`:

| Case | Final source | Why it cannot pass |
| --- | --- | --- |
| No approver | `approval` | Nobody can be asked, which means not approved |
| The approver throws an exception | `approval` | A fault is not consent |
| The approver returns a plain object or a boolean | `approval` | A wrong type means the implementation has a problem; do not guess its meaning |
| The approver returns `ask` again | `approval` | It did not converge, which means no answer |
| The approver returns `passthrough` | `approval` | Abstaining is not consent |
| The terminal has no interactive stdin | `terminal-approval` | There is no real human in a CI / pipe environment; do not pass by default |
| The user presses Enter directly or enters other content | `terminal-approval` | The prompt is `[y/N]`; the default is N |

The seven cases share one common point: **they are all "no explicit yes was obtained", not "an explicit no was obtained".** The system treats the two as equivalent — this is fail closed.

Think of it in reverse and it is clearer: if any one case were treated as a pass, then an attacker (or just a wrongly written automation script) would only need to make the approver fail to gain execution permission. **A security mechanism's failure must lead to a stricter result, not a looser one.**

In the code, this convergence happens in two layers. The first five are in `PermissionPolicy.#resolveApproval()`:

```typescript
let decision: unknown;
try {
  decision = await this.#approval.decide(approvalRequest);
} catch {
  return new PermissionDecision("deny", "Approval provider failed; request denied", "approval");
}
if (!(decision instanceof PermissionDecision)) {
  return new PermissionDecision("deny", "Approval provider returned an invalid decision", "approval");
}
if (decision.behavior === "allow" || decision.behavior === "deny") {
  return decision;
}
return implicitApprovalDenial(proposed);
```

Note that the type of `decision` is marked `unknown`, not `PermissionDecision`. This is deliberate: the approver is an external implementation, and **you cannot trust that it really returns the declared type just because the interface declares the return type**. The `instanceof` check is the real boundary.

The last two are in the CLI's terminal implementation. The real terminal implementation accepts only `y` and `yes`:

```typescript
const answer = await terminal.question("Allow this call? [y/N] ");
const normalized = answer.trim().toLowerCase();
const allowed = normalized === "y" || normalized === "yes";

return new PermissionDecision(
  allowed ? "allow" : "deny",
  allowed
    ? "User approved this tool call"
    : "User denied this tool call",
  "terminal-approval",
);
```

An approval authorises only the current single call. The policy does not save "always allow", and it does not secretly modify later rules.

This is annoying in real use: change three files in the same task, and you press `y` three times. This is this chapter's deliberate trade-off — "always allow" needs answers to a string of new questions (where is it recorded? how large is the scope? when does it expire? who can revoke it?), and not one of those questions is in P03's acceptance contract. In the teaching phase, choosing the strictest default value is clearer than choosing a half-finished memory mechanism.

---

## The audit records the final decision

The audit happens after the rule merge and the approval complete, so what it records is the final result:

```typescript
if (this.#audit !== undefined) {
  await this.#audit.record(request, final);
}
```

P03's terminal audit format is:

```text
[Permission] write_file: allow (terminal-approval) - User approved this tool call
```

It contains the tool name, the final behavior, the decision source, and the reason.

One easily ignored detail: **the audit goes to stderr, and the final answer goes to stdout.** That way, `npm run ch03 ... > answer.txt` gets only the model's answer, and the audit log stays on the screen. In reverse, log collection does not mix the answer in.

The audit position is also chosen deliberately. It sits **after the merge and approval, and before execution**:

```text
❌ Placed after the merge, before the approval
   → What is recorded is an ask; you never know whether the user approved in the end

❌ Placed after the handler executes
   → If the execution fails, there is no record; and "an execution was attempted" is itself the thing to leave a trace of

✅ Placed after the final conclusion is certain, before invoke
   → Every decision has a record, and the record always precedes the side effect
```

If the audit sink itself fails, the runtime cannot execute a side effect that left no required record. The exception is converted by the Agent Loop to:

```text
Error [permission_evaluation_error]: Permission evaluation failed
```

The handler call count stays at zero, and the messages still pair.

### Message contract: every tool call must pair

After the permission decision and the handler execution complete, the Agent Loop fills back with `toolMessage(result.content, call.id)`. The fill-back is not optional:

```typescript
validateToolPairing(this.#history);
```

`validateToolPairing()` checks the message history at the start of every turn: an assistant tool call must be followed immediately by the matching number of `tool` messages, the IDs must match strictly, and extra `tool` messages and orphan results are rejected. This guarantees that the session sent to the model always satisfies the Chat Completions protocol. It also guarantees that a call rejected by permission still returns to the model's view as a `permission_denied` result, so the model can see that the call it proposed really was rejected.

---

## Insert into the Agent Loop

Chapter 2 already separated tool preparation from execution. Chapter 3 only adds the permission step in the middle:

```typescript
if (prepared.error !== undefined) {
  result = prepared.error;
} else if (this.#permissionPolicy !== undefined) {
  try {
    const decision = await this.#permissionPolicy.decide(
      new PermissionRequest({ prepared, context }),
    );
    result = decision.isAllowed
      ? await tools.invoke(prepared, context)
      : decision.toToolResult();
  } catch {
    result = toolError(
      "permission_evaluation_error",
      "Permission evaluation failed",
    );
  }
} else {
  result = await tools.invoke(prepared, context);
}
this.#history.push(toolMessage(result.content, call.id));
```

The order cannot be reversed:

```text
prepare → permission → handler
```

If the handler executed first and the judgement came after, the approval would have only log value. It could not stop the side effect.

### Compared with chapter 2's loop, what exactly changed

This is this chapter's most satisfying part — **the change is surprisingly small**:

| | Chapter 2 | Chapter 3 |
| --- | --- | --- |
| The turn loop, `maxTurns`, the termination judgement | — | **Not one line changed** |
| The `validateToolPairing()` call position | — | **Not one line changed** |
| `snapshot()` / `prepare()` / `invoke()` | — | **Not one line changed** |
| The tool fill-back `toolMessage(result.content, call.id)` | — | **Not one line changed** |
| The tool handler implementations | — | **Not one line changed** |
| The `if / else if / else` in the middle | Only `prepared.error` and a direct `invoke` | One `permissionPolicy` branch inserted in the middle |

Only one branch was added, and the capability boundary changed completely. This is exactly the return on chapter 2 splitting `prepare()` and `invoke()` apart — **at the time, that split looked like mere "code tidiness". Only now does it show that it left room for this insertion point.**

Look at that `catch` again:

```typescript
} catch {
  result = toolError("permission_evaluation_error", "Permission evaluation failed");
}
```

This is a **boundary catch**, not a catch in business logic. It catches faults of the permission system itself (a bug in a rule implementation, an audit sink disk-write failure, a `PermissionContractError`), and converts it to a tool result with complete pairing.

The reason it must exist is the message contract: if the exception propagated up, this turn would be short one `tool` message, and `validateToolPairing()` would throw `missing tool results for ids: [...]` directly at the start of the next turn — the whole session would be ruined. **"The permission system failed" and "the session structure is damaged" should not be the same severity.**

Also note: this catch is fail closed. On an exception, `result` is an error result, the `invoke()` branch is never reached, and the handler call count stays at zero.

P03's composition root requires an explicit `approvalProvider` and `auditSink`, and the fixed profile assembles the rules and the workspace boundary itself. A caller cannot swap in a loose `PermissionPolicy` to skip "writes must be approved, decisions must be audited". If either boundary is missing, the Agent fails at the startup build phase. The offline unit tests of P01 and P02 can still inject no approver. The real CLI injects an approver, so Shell keeps its `ask`.

### The Agent Loop's three termination states

The Agent Runner is not an infinite loop. It has three deliverable termination states:

- `RunResult`: the model returns a non-empty `finalText` within `maxTurns`; `turns` records the actual turn count.
- `AgentLimitError`: `maxTurns` is reached and it still has not ended; the caller cannot treat the intermediate history as the final answer.
- `AgentRunError` / `IncompleteModelReplyError`: the model output was truncated, content-filtered, or at stop time there was neither text nor a tool call.

```typescript
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}
```

A permission error is not one of these three run errors: a permission rejection returns to the model as a tool result; a permission evaluation exception returns to the model as a `permission_evaluation_error`; the Loop can still continue.

---

## The exact differences between P02 and P03

P03 adds only one capability:

```typescript
export const P03: ChapterProfile = Object.freeze({
  chapter: 3,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
  ]),
});
```

The two profiles use the same five-tool registry and the same Agent Loop. The composition root builds the policy from the fixed capability. It does not accept a policy assembled by the caller:

```typescript
if (!profile.capabilities.has("policy")) {
  return dependencies.approvalProvider === undefined
    ? undefined
    : new PermissionPolicy({ approval: dependencies.approvalProvider });
}
if (dependencies.approvalProvider === undefined) {
  throw new Error("approvalProvider is required for chapter 3 or later");
}
if (dependencies.auditSink === undefined) {
  throw new Error("auditSink is required for chapter 3 or later");
}
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

Therefore:

| Operation | P02 | P03 |
| --- | --- | --- |
| `read_file` / `glob` | Allowed directly | Allowed directly, and audited |
| In-workspace `write_file` / `edit_file` | Allowed directly | `ask`; the final decision is audited |
| Out-of-workspace write | The file handler returns `path_escape` | The permission hard boundary rejects, and audits |
| `shell` | `ask` | `ask`, and audited |

"Allowed directly" still passes the file tool's own Zod and `safePath` boundary first. So P02 still rejects out-of-workspace paths; it just keeps chapter 2's observable `path_escape`. Only P03 moves such writes before the handler, and rejects them with a `permission_denied`.

### CapabilitySet: why the capability set cannot be a bare Set

The type of `P03.capabilities` is `ReadonlySet<Capability>`, but the composition root must also guarantee that it really is immutable. The source wraps a private `Set` in `CapabilitySet`:

```typescript
class CapabilitySet implements ReadonlySet<Capability> {
  readonly #values: Set<Capability>;
  // Only has / entries / keys / values / forEach / size are exposed
}
```

TypeScript's `ReadonlySet` is read-only only at the type level. At run time you can still get the `Set` and call `add`. `CapabilitySet` hides the underlying set, so once a profile's capabilities are constructed they cannot be modified from outside, and the composition root can trust the judgement of `capabilities.has("policy")`.

---

## Four concrete scenarios

### 1. List files

The model calls:

```json
{"pattern":"chapters/ch03/src/**/*.ts"}
```

`glob` is a read. With no rule objecting, it is allowed by default.

### 2. Execute PowerShell

The model calls:

```json
{"command":"Get-ChildItem -Force"}
```

Even though the command looks read-only, `shell` still enters approval:

```text
Tool call requires approval: shell
Reason: Shell execution requires approval
Arguments: {"command":"Get-ChildItem -Force"}
Allow this call? [y/N]
```

### 3. Modify a workspace file

In P03, `write_file` and `edit_file` hit `confirm-file-write`. After the user enters `y`, only this once executes. On a rejection or an Enter, the file does not change.

### 4. Write outside the workspace

```json
{"path":"../outside.txt","content":"x"}
```

The system returns the workspace hard rejection. It does not call the approver, and it does not create the external file.

---

## Tool implementation: how the effect drives the permission boundary

`features/builtin-tools.ts` is the five-tool implementation shared by P02 and P03; P01 registers only the `shell` among them. All five tools define their arguments with `z.strictObject()`, and carry an `effect` label at registration.

This label is not for the model to see: `openAITools()` serialises only the name, description, and JSON Schema. It is the semantic basis on which the permission policy judges the default behavior.

| Tool | effect | Permission path | Main stable error codes |
| --- | --- | --- | --- |
| `shell` | `execute` | Shell default `ask` | `shell_start_failed`, `shell_timeout`, `shell_failed` |
| `read_file` | `read` | Default `allow` | `path_escape`, `invalid_utf8`, `file_not_found`, `invalid_path`, `filesystem_error` |
| `write_file` | `write` | Workspace hard boundary, then `confirm-file-write` | `path_escape`, `invalid_path`, `filesystem_error` |
| `edit_file` | `write` | Workspace hard boundary, then `confirm-file-write` | `text_not_found`, `invalid_utf8`, `file_not_found`, `invalid_path`, `filesystem_error` |
| `glob` | `read` | Default `allow` | `path_escape`, `filesystem_error` |

Take `shell` as the example. The tool is responsible only for normalising a `CommandResult` into a `ToolResult`:

```typescript
effect: "execute",
handler: async ({ command }, context) => {
  let result: CommandResult;
  try {
    result = await commandRunner.run(command, context.workspace);
  } catch {
    return toolError("shell_start_failed", "PowerShell process could not be started");
  }

  let output = result.output.length === 0 ? "(no output)" : result.output;
  if (result.truncated) {
    output = `${output}\n[output truncated]`;
  }
  if (result.timedOut) {
    return toolError("shell_timeout", output);
  }
  if (result.exitCode !== 0) {
    return toolError(
      "shell_failed",
      `PowerShell exited with code ${result.exitCode}\n${output}`,
    );
  }
  return toolSuccess(output);
},
```

After `write_file` and `edit_file` are marked `write`, `PermissionPolicy` reads the `path` before the rules and calls `WorkspaceWriteBoundary`. Only an in-workspace path continues into the human approval of `confirm-file-write`.

`read_file` and `glob` are `read`. With no rule objecting, the default policy allows them, but they still pass `safePath` and error normalisation.

A tool handler returns stable error codes for known domain errors, and keeps throwing for unknown errors. The boundary `try/catch` of `ToolRegistry.invoke()` converts an unknown fault uniformly to `tool_execution_error`. That way, the model receives a failure reason it can keep planning with, not a runtime stack.

---

## Current boundaries and what is deliberately not done

This chapter does not implement configuration file layering, organisation roles, rule hot updates, or "always allow". None of those capabilities appears in P03's acceptance contract.

Claude Code's real product carries permission rules in multi-level Managed, Project, and User settings, and a deny at any level cannot be overwritten by an allow at another level. P03 does not implement this layering, but it keeps the most critical deny-first semantics.

This chapter also does not call another model to judge command risk. A probability classifier can assist with hints. It cannot replace hard permission semantics.

Shell is still not a sandbox. Approval lowers the mistaken execution risk; it provides no operating-system isolation. Real strong isolation needs a restricted account, a container, a virtual machine, or an operating-system sandbox, which is outside this tutorial's current scope.

Claude Code's documentation also separates a bare tool name deny from a scoped deny: `Bash` removes the tool from the tool list the model can see, while `Bash(rm *)` keeps the tool but blocks matching calls. All of P03's denies take effect before execution. P03 does not implement the "remove from the tool list the model can see" optimisation. For this chapter's acceptance goal, blocking the side effect is enough.

Chapter 4 adds Hooks. `recommendations` has a reserved structured channel, but P03 does not pretend it already has a Hook lifecycle. Claude Code's PreToolUse Hook also does not bypass deny and ask rules: even if a Hook returns `allow`, a matching deny still blocks the call.

### Composition root: where the permission policy is assembled

`bootstrap.ts` is the composition root. It assembles the model, the file system, Shell, the tools, and the permission policy into one `AgentRunner`:

```typescript
export interface BuildDependencies {
  readonly model: ModelClient;
  readonly workspace: string;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly approvalProvider?: ApprovalProvider;
  readonly auditSink?: AuditSink;
  readonly maxTurns?: number;
}
```

The key constraint: the composition root does not accept a `PermissionPolicy` assembled by the caller. It constructs the policy itself from the fixed `ChapterProfile` capability.

The reference-equality check `profileForChapter(profile.chapter) !== profile` rejects a same-numbered profile forged by a caller. When P03 lacks an `approvalProvider` or an `auditSink`, `buildAgent()` throws directly, instead of starting with a loose policy.

The CLI side also implements `TerminalApprovalProvider` and `TerminalAuditSink` in `cli.ts`. The approver first checks `stdin.isTTY`: with no interactive input, it rejects directly, avoiding a default pass in an automated environment.

The audit sink outputs `[Permission] tool name: behavior (source) - reason`. A configuration error returns exit code 2, a runtime error returns exit code 1. At the process boundary, both converge into predictable CLI behavior.

### What we learn from ai-agent-book

The "Tools" chapter of *ai-agent-book* discusses production-grade security in a dedicated "executing tools" section. The core is layered defence:

```text
Input validation
    ↓
Permission control
    ↓
Proposer-reviewer (pre-approval + post-verification)
    ↓
Sidecar parallel validation
    ↓
Sandbox isolation
```

In its "Experiment 4-2: an executing-tool MCP server", it also requires the security mechanisms to be runnable experiments: automatic lint after a file write, dangerous command detection, sandboxed Python execution, long output truncation and persistence.

That design approach is worth borrowing: every mechanism needs an observable input, behavior, and output; it must not stop at an architecture description.

This tutorial's P03 already covers the first two layers (input validation + permission control), and implements deny-first and fail closed within them. *ai-agent-book* adds the more complete production view:

1. **Risk grading, not one cut for all**: low-risk, reversible operations can pass automatically; high-risk, irreversible operations require human approval. P03 keeps Shell always `ask` — a stricter teaching default. A real product needs layering by risk level.
2. **Proposer-reviewer**: an independent model or a human approves the "plan" before the operation, and verifies the "result" after it. *ai-agent-book* also stresses the choice of model family and capability level: the reviewing model should come from a different family, with similar capability, to avoid same-source preferences producing the same blind spots. P03 does only human single-call approval; it has no independent model review.
3. **Execute-verify-feedback**: after a tool executes, run verification automatically (for example, run lint automatically after writing code), and return the structured error to the Agent, forming the closed loop for the next turn's correction. P03 has no automatic verifier; the permission system manages only "before execution".
4. **Sidecar**: a lightweight security check runs in parallel with the main model's streaming output. It reads only the structured tool fields, avoiding prompt injection through free text affecting the judgement. On continuous rejections, a circuit breaker should also engage, to stop the Agent from retrying forever. P03 is a synchronous decision; it has no parallel Sidecar.
5. **Long output truncation and persistence**: an overlong output keeps only the head and tail; the complete result is written to a temporary file, and `read_file` is guided to keep reading. P03's PowerShell adapter already limits the output ceiling, but it does not yet do "complete result to disk + file guidance".
6. **Observability**: the time, arguments, result, duration, performance metrics, and alerts of every call must be traceable. P03's audit covers the final permission decision, but it has no performance metrics or alerts yet.
7. **Idempotency and cancellation semantics**: after a timeout or a cancellation, you must know whether the side effect happened; a retry must not repeat an external operation. P03's `ToolContext` reserves an `idempotencyKey`, but it does not yet really implement idempotency deduplication.
8. **Sandbox isolation**: approval is not isolation. *ai-agent-book* states clearly that the sandbox is an independent defence line, and P03 also states clearly that Shell is not a sandbox.

### The companion code's file structure

`code/chapters/ch03/src/` is chapter 3's runnable snapshot. It keeps the layering of "core contracts + adapters boundaries + features tool sets + chapters entries". The responsibility of each file:

| Path | Responsibility |
| --- | --- |
| `chapters/ch01.ts` | The P01 fixed entry; keeps the old chapter independently runnable |
| `chapters/ch02.ts` | The P02 fixed entry; exposes the file tools but connects no permission policy |
| `chapters/ch03.ts` | The P03 fixed entry; selects the profile that contains `policy` |
| `bootstrap.ts` | Composition root: assembles the model, file system, tools, and permission policy by profile capability |
| `cli.ts` | CLI adapter: parses arguments, provides terminal approval and audit, maps errors to exit codes |
| `config.ts` | Configuration adapter: reads `.env` or a mapping, validates the `OPENAI_*` settings |
| `core/commands.ts` | Command contract: defines `CommandRunner` and `CommandResult` |
| `core/filesystem.ts` | File contract: defines the workspace file interface and stable domain errors |
| `core/loop.ts` | Agent Loop: the main loop of prepare, permission, execute, fill back |
| `core/messages.ts` | Message contract: guarantees the assistant tool calls and tool results pair strictly |
| `core/model.ts` | Model contract: defines `ModelClient`, `FinishReason`, `ModelReply`, and token usage |
| `core/permissions.ts` | Permission system: four-state decisions, rules, approval, audit, and the workspace hard boundary |
| `core/profiles.ts` | Chapter capability profiles: the fixed `P01/P02/P03` and the immutable `CapabilitySet` |
| `core/tools.ts` | Tool Registry: registration, parsing, validation, snapshots, and invocation |
| `features/builtin-tools.ts` | Tool implementations: `shell`, `read_file`, `write_file`, `edit_file`, `glob` |
| `adapters/filesystem.ts` | Node file system implementation: `safePath`, real path resolution, and glob |
| `adapters/openai-chat.ts` | OpenAI adapter: normalises a vendor response into the core contract |
| `adapters/powershell.ts` | PowerShell process executor: timeout, output ceiling, and stable results |

In it, `core/filesystem.ts` normalises platform errors such as `ENOENT` and `EISDIR` into stable domain errors such as `FileNotFoundError` and `InvalidFilePathError`. The tool layer then maps them to error codes such as `file_not_found` and `invalid_path`.

All input schemas in `features/builtin-tools.ts` use `z.strictObject()`. Extra fields are rejected by `ToolRegistry.prepare()` before the permission layer.

`adapters/openai-chat.ts` runs `validateToolPairing()` again before it sends a request, and narrows the `unknown` vendor response layer by layer into a `ModelReply`. `adapters/powershell.ts` starts PowerShell with `-NoLogo -NoProfile -NonInteractive`, limits it to a 120 second timeout and 50 KB output by default, and kills the child process after a timeout and returns `shell_timeout`.

The glob in `adapters/filesystem.ts` parses `*`, `**`, `?`, and character classes with a restricted regular expression. It does not hand an unvalidated pattern to the Shell. When it walks directories, it follows only real directories, not symbolic link directories, to avoid recursive out-of-bounds. These boundaries are independent defence lines outside the permission system.

---

## Run chapter 3

### Step 0: Prepare the environment

In PowerShell, enter `code/` and install the locked dependencies:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm ci
```

The three variables in `.env` are the same as chapter 1. If you never configured them, go back to chapter 1's "Run the chapter 1 agent".

### Step 1: Run the offline tests first (no API Key needed)

```powershell
npm run test:ch03
```

Expect the last two lines:

```text
 Test Files  10 passed (10)
      Tests  61 passed (61)
```

While the tests run, you will see one line in the output: `Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL`. **This is not a failure. It is the expected output asserted by a test** — one test verifies exactly that "when the configuration is missing, the CLI returns exit code 2 and prints this line".

### Step 2: Run one real task that pops up an approval

```powershell
npm run ch03 -- --prompt 'Read README.md, then write a one-sentence summary into chapter3-note.txt'
```

This prompt is chosen on purpose: it first does a `read_file` (default allow), then a `write_file` (must be approved). One run shows both paths.

Expect to see, in order:

```text
[Permission] read_file: allow (default) - No permission rule blocked the request

Tool call requires approval: write_file
Reason: File writes require explicit approval from chapter 3 onward
Arguments: {"path":"chapter3-note.txt","content":"..."}
Allow this call? [y/N]
```

Press `y` and Enter, and you will then see:

```text
[Permission] write_file: allow (terminal-approval) - User approved this tool call
```

Confirm the file really was written:

```powershell
Get-Content .\chapter3-note.txt
```

### Step 3: Refuse on purpose this time

Run the same command again, and at the approval box **press Enter directly** (enter nothing).

Expected:

```text
[Permission] write_file: deny (terminal-approval) - User denied this tool call
```

The model then receives `Error [permission_denied]: User denied this tool call`, and it usually tells you in the final answer that the write was rejected. **The file content does not change at all.**

This step is the verification most worth doing by hand in this chapter: the capital `N` in `[y/N]` is the default value; Enter equals rejection.

### Step 4: Watch the hard boundary stop an out-of-bounds write

```powershell
npm run ch03 -- --prompt 'Write hello into ../outside.txt'
```

Expected:

```text
[Permission] write_file: deny (workspace-boundary) - Writing outside the workspace is forbidden
```

**Note that this time no approval box popped up** — you never even got the chance to approve it. No `outside.txt` will appear in the parent directory of `code/`.

The unified entry also works:

```powershell
npm run agent-tutorial -- run --chapter 3 --prompt 'Read README.md, then write a one-sentence summary into chapter3-note.txt'
```

### Step 5 (optional): The complete offline gates

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

The tests read no real API Key and access no network. A real OpenAI run can serve only as extra smoke evidence.

### Troubleshooting common errors

| Symptom | Cause | How to handle it |
| --- | --- | --- |
| The approval box flashes past, and you see `No interactive input, rejecting by default.` directly | The current terminal is not interactive (in CI, a pipe, or some IDE's output panel) | Run it in a real PowerShell window. This is fail closed working correctly, not a bug |
| Can an uppercase `Y` pass | Yes. The code runs `toLowerCase()` | — |
| Can `yes` pass | Yes. Only `y` and `yes` are accepted | Entering `ok`, `sure`, or `是` is all judged as rejection |
| Every file write needs an approval | This chapter deliberately does not do "always allow" | Normal behavior. See the end of "An ask must get an explicit allow" |
| `read_file` also entered the audit; it looks noisy | The audit records **every** final decision | Normal behavior. The audit output is on stderr; `2>$null` can mask it temporarily |
| `Error [permission_evaluation_error]` | A fault in the permission system itself (a bug in a rule implementation, an audit write failure) | This is the fail-closed fallback. The handler did not execute; check the rule or audit implementation you added |
| Startup reports `approvalProvider is required for chapter 3 or later` | You called `buildAgent()` yourself without injecting an approver | Add the approver and the audit sink. P03 does not allow a boundary-less startup |
| The command is clearly read-only, but `shell` still needs approval | `effect === "execute"` is always `ask`; the command content is not examined | Normal behavior. See "Why Shell is always ask" |

---

## Verification and experiments

`npm run test:ch03` executes 10 test files and 61 tests. The two new files in this chapter are:

| Test file | What it verifies |
| --- | --- |
| `permissions.test.ts` | `PermissionDecision` construction validation, rule merge priority, all branches of approval fail closed, the workspace hard boundary, the audit call timing |
| `ch03-permissions.test.ts` | End to end: whether the approver was called, whether the side effect happened, whether the messages pair, whether the filled-back content is exact |

The other 8 are the accumulated tests of the first two chapters (`ch01-loop`, `ch02-files`, `shell-tool`, `filesystem`, `messages`, `profiles`, `config`, `openai-chat`). They keep guaranteeing that chapter 3's permission addition did not break the old behavior.

The most worth learning here is how the assertions are written. **Asserting only "an error was returned" is not enough** — an implementation could execute the side effect first and return the error after, and the test would still pass. So `ch03-permissions.test.ts` uses three harder classes of assertion:

```typescript
expect(approval.requests).toEqual([]);                      // The approver was never called once
await expect(readFile(outside, "utf8")).rejects.toThrow();  // The file really was not created
validateToolPairing(result.history);                        // The message structure is still complete
```

The first proves "no approval box pops up when the hard boundary rejects". The second proves "the side effect really did not happen". The third proves "a rejection does not damage the session". All three are indispensable — this is the concrete shape of "verify the real behavior, not that it looks done".

One more note: the filled-back content the tests assert is the complete string, **exact word for word** — for example, `"Error [permission_denied]: Writing outside the workspace is forbidden"`. So changing the text of any `reason` turns a test red — deliberately. The `reason` enters the model's context; changing it means changing the information the model sees.

### Four small experiments to try yourself

**Experiment 1: Make a rule's matcher throw**

In the `confirm-file-write` rule in `bootstrap.ts`, change `matches` to `() => { throw new Error("boom"); }`, then run one `write_file`.

Expected: you get a `deny`; the `source` is `confirm-file-write`; the `reason` is `Permission rule failed: confirm-file-write`.
Learned: a rule fault leads to rejection, not to "this rule does not count".

**Experiment 2: Add an `allow` rule and watch whether it can overturn the hard boundary**

Append one rule to the rules array:

```typescript
new PermissionRule({
  name: "allow-everything",
  behavior: "allow",
  reason: "Testing whether allow can override deny",
  matches: () => true,
}),
```

Then run `npm run ch03 -- --prompt 'Write hello into ../outside.txt'`.

Expected: it is still a `deny (workspace-boundary)`. No number of `allow` rules can beat a `deny`.
Learned: this is this chapter's most core invariant, worth confirming by hand once. **Remember to change it back after the experiment.**

**Experiment 3: Make the approver return `passthrough`**

Write a fake approver `{ async decide() { return new PermissionDecision("passthrough", "no opinion", "fake"); } }`.

Expected: the final result is a `deny`; the `source` is `approval`; the `reason` starts with `Approval was not explicitly granted:`.
Learned: an `ask` can be converged only by an `allow` or a `deny`. Abstaining counts as rejection.

**Experiment 4: Make the audit sink throw**

Change `TerminalAuditSink.record()` to `throw new Error("audit down")` directly, then run one `read_file`.

Expected: you get `Error [permission_evaluation_error]: Permission evaluation failed`, **and the file was not read** (even though this is only a read operation).
Learned: the audit is not "record it in passing". It is an execution precondition. If no record can be left, nothing executes.

---

## Chapter summary

### The three-sentence version

1. A permission judgement must be at a fixed position in the code — after `prepare`, before `invoke`. The Prompt cannot provide this guarantee.
2. A decision is not a boolean but four states, because both "ask once" and "I take no position" must be expressible.
3. `deny > ask > allow > passthrough`: no participant's rejection can be overturned by anyone else's allow.

### Seven points to remember

| # | Conclusion | Which section it appears in |
| ---: | --- | --- |
| 1 | The order is `prepare → permission → handler`; reversed, only log value remains | Insert into the Agent Loop |
| 2 | When the hard boundary's `deny` appears, the approval box does not pop up at all | Why the workspace boundary must come before the rules |
| 3 | "No explicit yes was obtained" and "an explicit no was obtained" are equivalent — all seven cases are a `deny` | An ask must get an explicit allow |
| 4 | The approver's return value is handled as `unknown` and validated with `instanceof` | An ask must get an explicit allow |
| 5 | An approval authorises only this once; there is no "always allow" | An ask must get an explicit allow |
| 6 | The audit records the **final** decision, and it happens before execution; if the audit fails, nothing executes | The audit records the final decision |
| 7 | `execute` is always `ask`; risk is not guessed from the command text | Why Shell is always ask |

### This chapter's code boundary (explicitly "what is not done yet")

| Already there | Not yet | Which chapter adds it |
| --- | --- | --- |
| Four-state decisions + priority merging | Hooks proposing suggestions (the `recommendations` channel is reserved) | Chapter 4 |
| One built-in rule | Configuration file layering (Managed / Project / User) | **Not done**; see "What is deliberately not done" |
| Single-call approval | Always allow, rule hot updates | **Not done** |
| Approval + audit | Independent model review, automatic post-execution verification | **Not done**; see the ai-agent-book comparison |
| `shell` always `ask` | Differentiated defaults by risk grading | **Not done** (the teaching choice takes the stricter default) |
| Final decisions enter the audit | Performance metrics, alerts, idempotency deduplication | Partly in chapter 11 |
| `execute` needs approval | Operating-system-level sandbox isolation | **Not done.** Approval is not isolation |
| Deny takes effect before execution | Removing a tool from the tool list the model can see | **Not done** (blocking the side effect is enough) |

### Check whether you really understood

1. For one `glob` call, what candidate does each of the four participants produce? What is the final source? (Look at a real decision process first)
2. Why can a boolean not express "ask once"? Give the rule B kind of "takes no position" problem. (Permission is not a boolean)
3. When the candidate set is `[deny, ask]`, does the user see an approval box? Why? (The three gates / The workspace boundary)
4. The approver throws an exception. What is the final behavior? If it were changed to "allow by default", what risk would there be? (An ask must get an explicit allow)
5. The audit sink throws an exception. Did the handler execute? What does the model receive? (The audit records the final decision)
6. How many changes does chapter 3's Agent Loop have compared with chapter 2's? (Insert into the Agent Loop)
7. Why does `toToolResult()` allow only a `deny` to call it? (The four-state decision)

---

This chapter built a side-effect boundary that a weak allow cannot override:

```text
ToolRegistry.prepare
        ↓
workspace hard boundary
        ↓
rules / recommendations
        ↓
deny > ask > allow > passthrough
        ↓
explicit approval when needed
        ↓
final audit
        ↓
ToolRegistry.invoke
```

The next chapter adds Hooks, splitting the extension logic around tool execution, user input, and the stop phase out of the loop. Whatever suggestion a Hook gives, the system `deny` still holds the final priority.
