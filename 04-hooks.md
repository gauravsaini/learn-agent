Last week I helped a friend look at an Agent he had written. The initial code was simple: call the model, execute the tool calls it returns, put the results back into messages, and call the model again.

Later, the same loop had swollen to more than two hundred lines. PowerShell logs, write-file confirmations, result notifications, and automatic backups were all stuffed directly into the loop. Each requirement looked reasonable on its own. Put together, they turned the core flow into a pile of if-else that nobody dared to change.

The problem was not that there were too many requirements. The problem was that extension behavior and core orchestration were not separated.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaEF9OfxccmqxNmg2ibzlIt2sAs4Qibxicucibibk3UsEMjz8gaaMIJVmdy17tFTJapdBPXCXuTInXxnXDodIic7Ktf89WGy0nsibjjYOU/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

Chapter 4 has a clear job: add four structured Hook mount points to the existing Agent Loop, without breaking the message pairing, tool validation, and permission boundaries that chapters 1–3 built.

Claude Code currently defines more than 14 Hook event classes officially, such as `PermissionRequest`, `SessionStart`, `SubagentStart`, `PreCompact`, and `Elicitation`. See the complete list at https://code.claude.com/docs/en/hooks.md.

For teaching needs, chapter 4 first selects the four core events that cover one complete tool interaction.

---

## Chapter guide

### What you can do after this chapter

1. State which step of the pipeline each of the four Hook events triggers at, and why these four positions.
2. Explain why a Hook's return value must be a structured object, not a string such as `"stop"`.
3. Explain the difference between "the Hook says allow" and "the permission system says allow" — the former is only a suggestion.
4. State what happens to the other tool calls in the same turn when one Post Hook asks to stop, and why you cannot just `return`.
5. Explain why a Stop Hook can force a continuation at most once.
6. Judge which error code a Hook gets when it throws, and whether the handler ran.

### What you need first

| Need | Explanation |
| --- | --- |
| Read chapters 1–3 | This chapter adds no new tool or permission rule; it only opens holes in the existing pipeline |
| Remember `prepare → permission → invoke` | All four mount points are placed around this order |
| Remember `deny > ask > allow > passthrough` | This chapter's Hook suggestions plug into this merge logic |
| Remember `validateToolPairing()` | Half of this chapter's design constraints come from "every call must pair" |

### Quick term reference (terms that first appear in this chapter)

| Term | One-line explanation |
| --- | --- |
| **Hook** | A callback registered at a fixed position. Registered by the application; not a plugin sandbox |
| **Mount point** | A fixed position in the Loop that publishes structured context. This chapter has four |
| **HookEvent** | One of the four event names: `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` |
| **HookContext** | The data an event publishes to the callbacks. **Different events have different available fields** |
| **HookResult** | The callback's return value. Each field has only one meaning, and it is legal only in a specific event |
| **HookRegistry** | Stores the callback lists by event; **registration order = execution order** |
| `permissionBehavior` | The permission **suggestion** a Pre Hook proposes; not a decision |
| `updatedInput` | The arguments after a Pre Hook rewrites them. They are Zod-validated again and deeply frozen |
| `blockingError` | A Pre Hook blocks directly; neither the permission nor the handler runs |
| `updatedOutput` | The tool result after a Post Hook rewrites it |
| `additionalContext` | An appended system message. **It can only be system**, and it is written late |
| `preventContinuation` | A Post Hook says this turn requests the model no more |
| `forceContinue` | A Stop Hook appends one user message and asks the model once more |
| `stopHookActive` | Marks "a continuation was already forced once"; it prevents an infinite loop |
| **Short circuit** | When a `blockingError` or `forceContinue` appears, later callbacks of the same kind no longer run |
| **HookContractError** | A callback violates the contract (wrong return type, an illegal field, or a changed tool identity) |

### Suggested reading route

```text
Chapter guide (you are here)
  ↓
① Look at the real execution order first   ← The complete log of one run; each of the four events prints one line
  ↓
② Acceptance results + why extension points are needed   ← What this chapter proves, and why the loop should not keep growing
  ↓
③ Four events + HookContext   ← Fixed positions, data trimmed per event
  ↓
④ HookResult   ← The core of this chapter's design: why not strings
  ↓
⑤ HookRegistry   ← Order, merge rules, short circuit
  ↓
⑥ The four events one by one   ← What Submit / Pre / Post / Stop can each do
  ↓
⑦ Two hard constraints   ← A Hook allow is only a suggestion; stopping must also keep pairing
  ↓
⑧ Fault mapping + P03/P04 differences   ← Stable error codes when a Hook fails, and a comparison with chapter 3 item by item
  ↓
⑨ Composition root, CLI, boundaries, code map   ← How Hooks connect to the real entry, and what is deliberately not done
  ↓
⑩ Run, verify, and summary   ← Hands-on + troubleshooting + four experiments + self-test
```

---

## Look at the real execution order first

Do not look at code yet. P04's real CLI registers four Hooks that only print logs. Run a read-only task:

```powershell
npm run ch04 -- --prompt 'Read README.md and summarise how to run it'
```

You will see this sequence on stderr (the `[Permission]` line is chapter 3's audit; the `[Hook]` lines are new in this chapter):

```text
[Hook] UserPromptSubmit                ← ① The prompt is submitted; the model has not received the request yet
[Hook] PreToolUse: read_file           ← ② The tool is found and the arguments passed Zod; the permission is not judged yet
[Permission] read_file: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: read_file -> ok    ← ③ The handler has run; the result is not in the history yet
[Hook] Stop                            ← ④ The model gave an answer with no tool calls; the run is about to end
```

Put the positions of these four lines on chapter 3's pipeline:

```text
The user submits a prompt
        │
        ├─── ① UserPromptSubmit ────── Can add system context; cannot change or delete the prompt
        ↓
   The model returns tool_calls
        ↓
   ToolRegistry.prepare (find the tool + parse JSON + Zod validation)
        │
        ├─── ② PreToolUse ──────────── Can rewrite arguments, propose a permission suggestion, or block directly
        ↓
   PermissionPolicy / approval
        ↓
   handler (the real side effects are here)
        │
        ├─── ③ PostToolUse ─────────── Can rewrite the result, or ask this turn to end
        ↓
   Write the paired tool result
        ↓
   The model returns an answer with no tool calls
        │
        └─── ④ Stop ────────────────── Can force one more model request (at most once)
        ↓
      End
```

The reason for each of the four positions, in one sentence:

| Event | Why here |
| --- | --- |
| `UserPromptSubmit` | The model has not seen anything yet. It is the **only** time that can affect this turn's input |
| `PreToolUse` | The arguments are already trusted (they passed Zod), but the side effect has not happened — the **only** time that can block without loss |
| `PostToolUse` | The result already exists, but it is not in the history yet — the **only** time that can rewrite the result |
| `Stop` | The loop is about to end. It is the **only** time that can judge "is the task really done" |

Note the "only" in every row. **A mount point is not a position picked at random. It is the position where the information is just complete and the action is still in time.** One step earlier, the information is incomplete. One step later, it cannot be recovered.

### A more useful example

Logging alone does not show the value of Hooks. Assume you have three real requirements:

| Requirement | Without a Hook | With a Hook, mounted where |
| --- | --- | --- |
| Remind the model to check the acceptance criteria on every run | Change the system prompt — but that is a static prefix, and changing it breaks the KV Cache | `UserPromptSubmit` returns `additionalContext` |
| Forbid writing a file that a build script generates | Add an `if` in the `write_file` handler; the tool implementation is polluted by a business rule | `PreToolUse` returns `blockingError` |
| Truncate tool output when it is too long | Write the truncation logic once in every tool's handler | `PostToolUse` returns `updatedOutput` |

Three requirements, three different positions, **and not one line of the Agent Loop changes, and not one line of tool implementation changes.** This is what this chapter buys.

---

## Define the acceptance results first

P04 must produce these observable behaviors:

| No. | Acceptance criterion | Main event | Matching test |
| --- | --- | --- | --- |
| 1 | Only the four event classes `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` are supported | All | `hooks.test.ts` |
| 2 | Synchronous and asynchronous callbacks of the same event all run strictly in registration order | All | `hooks.test.ts` |
| 3 | A Pre Hook can add context, rewrite legal input, propose a permission suggestion, or return a structured blocking error | Pre | `hooks.test.ts`, `ch04-hooks.test.ts` |
| 4 | A Post Hook can observe in order and rewrite the previous Hook's output | Post | `hooks.test.ts` |
| 5 | The system's `deny` priority is always higher than a Hook `allow` | Pre | `ch04-hooks.test.ts` |
| 6 | A Pre block, a Hook exception, and an illegal Hook update must all keep the original `tool_call_id` pairing | Pre | `ch04-hooks.test.ts` |
| 7 | After a Post Hook requests a stop, calls in the same assistant message that have not executed yet must also get a clear error result | Post | `ch04-hooks.test.ts` |
| 8 | A Stop Hook can force a continuation the first time; the second time the callback still runs, but it cannot continue again | Stop | `hooks.test.ts`, `ch04-hooks.test.ts` |

| 9 | P04 adds only the `hooks` capability over P03; the behavior of the first 3 chapters stays unchanged | All | `ch04-hooks.test.ts` |

The direct tests live in `code/chapters/ch04/tests/hooks.test.ts` and `code/chapters/ch04/tests/ch04-hooks.test.ts`.

---

## Why the Agent Loop needs extension points

Chapter 3's loop already contains the model call, tool preparation, permission, and execution. With the details compressed, the structure is roughly:

```typescript
for (let turn = 1; turn <= maxTurns; turn += 1) {
  const reply = await model.complete(request);
  history.push(reply.message);

  if (reply.message.toolCalls.length === 0) {
    return reply.message.content;
  }

  for (const call of reply.message.toolCalls) {
    const prepared = tools.prepare(call);
    let result: ToolResult;
    if (prepared.error !== undefined) {
      result = prepared.error;
    } else {
      const decision = await permissionPolicy.decide(
        new PermissionRequest({ prepared, context }),
      );
      result = decision.isAllowed
        ? await tools.invoke(prepared, context)
        : decision.toToolResult();
    }
    history.push(toolMessage(result.content, call.id));
  }
}
```

This loop should keep being responsible only for deterministic orchestration. Logs, notifications, extra context, and completion checks are not new core flows. They need fixed mount points.

The role of a Hook is: publish structured context at a fixed position, and let the registered callbacks respond in order.

---

## Four events cover one complete interaction

`code/chapters/ch04/src/core/hooks.ts` uses one frozen tuple to define both the runtime event set and the TypeScript union type:

```typescript
export const HOOK_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const);

export type HookEvent = (typeof HOOK_EVENTS)[number];
```

The positions of the four events are fixed:

```text
The user submits a prompt
        ↓
UserPromptSubmit
        ↓
The model returns tool_calls
        ↓
ToolRegistry.prepare
        ↓
PreToolUse
        ↓
PermissionPolicy / approval
        ↓
handler
        ↓
PostToolUse
        ↓
The model returns an answer with no tools
        ↓
Stop
```

They are not four callbacks named at random. Each event has its own context and its own allowed return fields.

---

## HookContext: different events get only the data they need

`HookContext` is a frozen object. Its core fields are:

```typescript
export interface HookContextOptions {
  readonly event: HookEvent;
  readonly message?: ChatMessage;
  readonly prepared?: PreparedToolCall;
  readonly result?: ToolResult;
  readonly history?: readonly ChatMessage[];
  readonly stopHookActive?: boolean;
}
```

Fields correspond to events one by one:

| Event | Available fields | Fields that must not appear |
| --- | --- | --- |
| `UserPromptSubmit` | One user `message` | prepared, result, history, stop state |
| `PreToolUse` | The validated `prepared` | message, result, history, stop state |
| `PostToolUse` | `prepared` and `result` | message, history, stop state |
| `Stop` | `history`, `stopHookActive` | message, prepared, result |

The runtime validates these rules. For example, if you stuff a user message into a Pre Hook context, you get a `HookContractError` at once, instead of letting the callback guess which field to use.

Pre and Post receive only a `PreparedToolCall` that has passed the tool lookup, JSON parsing, and Zod validation. Unknown tools and illegal arguments do not enter a Hook.

---

## HookResult: do not express control flow with string codes

A Hook may only observe, or it may rewrite or block. Using a bare string return value quickly gets out of control: does `"stop"` mean reject the tool, end the current turn, or ask the model to answer once more?

Unfold the problem: one `"stop"` has at least four possible meanings:

```text
"stop" =? Do not execute this tool call        (maps to blockingError)
      =? Execute it, but do not ask the model again this turn  (maps to preventContinuation)
      =? Fail the whole run() at once
      =? Do not let the Stop Hook continue the run
```

The four meanings have completely different side effects, and the string itself has nowhere to express "which one am I". Worse, it cannot be validated: spell it `"stpo"` and the runtime treats it as an "unknown return value" and ignores it — **a Hook that should have blocked a dangerous write has failed silently**, and you see nothing.

This chapter uses an explicit `HookResult`:

```typescript
export interface HookResultOptions {
  readonly permissionBehavior?: PermissionBehavior;
  readonly updatedInput?: PreparedToolCall;
  readonly updatedOutput?: ToolResult;
  readonly additionalContext?: readonly ChatMessage[];
  readonly blockingError?: ToolResult;
  readonly preventContinuation?: boolean;
  readonly forceContinue?: ChatMessage;
}
```

Each field has only one meaning:

| Field | Meaning | Allowed event |
| --- | --- | --- |
| `permissionBehavior` | Submit a suggestion to the permission policy | Pre |
| `updatedInput` | Replace the validated input of the current call | Pre |
| `blockingError` | Block before the permission and the handler | Pre |
| `updatedOutput` | Replace the tool result | Post |
| `preventContinuation` | End the current tool turn normally | Post |
| `forceContinue` | Append one user message and request the model again | Stop |
| `additionalContext` | Write system context late | All four events |

When an error event uses a field that does not belong to it, `validateFor()` lists the illegal fields and refuses to execute.

This validation deserves one more sentence. Assume someone returns a `blockingError` in `PostToolUse` — literally, it means "block this call", but the handler has already run and the side effect has already happened. **At this point, "block" is an impossible request.** Instead of ignoring it quietly (the Hook author would keep believing he had blocked it), report an error at once and let him move it to `PreToolUse`.

`additionalContext` accepts only system messages. That way, a Hook cannot inject an orphan tool result, and it cannot forge an assistant message with `toolCalls` to break the OpenAI message pairing.

What the three forbidden injections would each cause:

| If a Hook were allowed to inject | Consequence |
| --- | --- |
| A `tool` message | `validateToolPairing()` throws `orphan tool result id: ...`, and the session is ruined directly |
| An `assistant` message with `toolCalls` | The model believes it requested these tools, but it never gets the results |
| A `user` message | The model cannot tell "the real user said it" from "a Hook stuffed it in"; the instruction source is forged |

**Allowing only system is the smallest intersection of these three risks**: a system message does not take part in tool pairing, and it is not mistaken for user intent.

Also note the words "written late". An `additionalContext` produced in the tool phase is not pushed at once. It is collected in `deferredContext`, and appended only after **all** tool results are written. The reason is pairing again:

```text
❌ Write at once
   assistant(tool_calls: call-1, call-2)
   tool(call-1, ...)
   system("context a Hook added")     ← Inserted between two tool results
   tool(call-2, ...)
   → The structure is broken

✅ Write late
   assistant(tool_calls: call-1, call-2)
   tool(call-1, ...)
   tool(call-2, ...)
   system("context a Hook added")     ← Appended only after pairing completes
```

After validation passes, `HookResult` copies `updatedOutput` and `blockingError` into new objects through `copyToolResult()`. It rebuilds and freezes `additionalContext` with `systemMessage()`, and rebuilds `forceContinue` with `userMessage()`.

Pre's `updatedInput` does not enter the registry directly. `normalizeUpdatedInput()` first runs `safeParse` again with the original `StoredToolDefinition.inputSchema`. Then `freezePreparedToolCall()` uses `structuredClone` to create a copy of the arguments and freezes it recursively.

So even if the callback keeps the original object reference and modifies that reference later, it cannot pollute the registry result or the Agent history. The approval and the handler can see only the same immutable copy.

---

## HookRegistry: registration order is execution order

The registry keeps an independent callback list for each event:

```typescript
const hooks = new HookRegistry();

hooks.register("UserPromptSubmit", (context) => {
  console.error(`[Hook] ${context.event}`);
  return new HookResult();
});
```

A callback can return synchronously, or it can return a `Promise<HookResult>`. `run()` uses `await` on each callback, so both forms keep the registration order:

```typescript
for (const callback of callbacks) {
  const outcome: unknown = await callback(current);
  if (!(outcome instanceof HookResult)) {
    throw new HookContractError(
      `${context.event} hook callback must return HookResult`,
    );
  }
  outcome.validateFor(context.event);
  // Merge the result, and pass the rewritten input or output to the next Hook.
}
```

Returning a plain object does not count as a legal `HookResult`. This runtime check matters, because a callback may come from a configuration or plugin boundary; you cannot rely on compile-time types alone.

Merging uses these rules:

- A later `updatedInput` or `updatedOutput` overwrites the earlier one, and becomes the value the next Hook sees.
- `additionalContext` connects in registration order.
- `preventContinuation` uses a boolean OR.
- Permission suggestions keep using `deny > ask > allow > passthrough`.
- When Pre meets a `blockingError`, it stops the later Pre callbacks at once.
- After Stop meets a `forceContinue` for the first time, it stops the later Stop callbacks.

One judgement sits behind the six rules: **does the "later opinion" or the "more conservative opinion" win?** The answer splits by field:

| Field | Merge method | Why |
| --- | --- | --- |
| `updatedInput` / `updatedOutput` | Later overwrites earlier | This is **pipeline processing**. The next Hook sees the previous one's product, so overwriting matches intuition |
| `additionalContext` | Concatenate in order | Every piece of context has value; they should not cancel each other |
| `preventContinuation` | Boolean OR | If any one asks to stop, stop. **The more conservative one wins** |
| `permissionBehavior` | `deny > ask > allow > passthrough` | Same as above, **the more conservative one wins**. A later `allow` cannot overwrite an earlier `deny` |

Use a concrete example to see "later overwrites earlier" clearly. Three Post Hooks register in order:

```text
The handler produces            "original"
  ↓
Post Hook 1  context.result.content === "original"
             Returns updatedOutput: "rewritten once"
  ↓
Post Hook 2  context.result.content === "rewritten once"   ← Sees the previous one's product
             Returns an empty HookResult (observes only)
  ↓
Post Hook 3  context.result.content === "rewritten once"
             Returns updatedOutput: "rewritten twice"
  ↓
Finally written to history      "rewritten twice"
```

So the registration order affects more than the log order. **It decides the order of the processing chain.** Whether you want "desensitise first, then truncate" or "truncate first, then desensitise" depends on the registration order.

Beyond field merging, `run()` also does three fixed things after each callback round: when Pre returns an `updatedInput`, `normalizeUpdatedInput()` parses and freezes the new arguments again; when `stopHookActive` is true, the `forceContinue` a Stop returns is removed before merging; once a `blockingError` or `forceContinue` is produced, the remaining callbacks are short-circuited.

`mergeResults()` uses `strongerPermission()` to merge permission suggestions by `deny > ask > allow > passthrough`. So a later `allow` does not overwrite an earlier `deny`.

---

## UserPromptSubmit: add this turn's context

This event triggers when the user prompt has just been submitted and the model has not received the request yet:

```typescript
hooks.register("UserPromptSubmit", (context) => {
  if (context.message?.role !== "user") {
    throw new Error("UserPromptSubmit context is incomplete");
  }
  console.error(`[Hook] prompt: ${context.message.content}`);
  return new HookResult({
    additionalContext: [systemMessage("This turn needs a special check of the acceptance results.")],
  });
});
```

`AgentRunner.run()` runs the Hook first, then writes the history in a fixed order:

```typescript
const submitted = userMessage(prompt);
const promptHook = await hooks.runUserPrompt(submitted);
history.push(submitted, ...promptHook.additionalContext);
```

A Hook can record the input or add system context. But P04 does not allow it to replace, delete, or block the original user message.

---

## PreToolUse: the extension point before side effects

When a Pre Hook runs, the tool already exists, the arguments have passed Zod, but the permission is not judged yet and the handler has not run.

The Hook below blocks a write to a managed file:

```typescript
hooks.register("PreToolUse", (context) => {
  const argumentsValue = context.prepared?.arguments;
  if (
    typeof argumentsValue === "object" &&
    argumentsValue !== null &&
    Reflect.get(argumentsValue, "path") === "generated.txt"
  ) {
    return new HookResult({
      blockingError: toolError(
        "hook_blocked",
        "generated.txt is managed elsewhere",
      ),
    });
  }
  return new HookResult();
});
```

After a `blockingError` hits, the later Pre Hooks, the permission, the handler, and the Post Hook do not run. The Loop still fills this error back to the original call:

```text
Error [hook_blocked]: generated.txt is managed elsewhere
```

A Pre Hook can also return an `updatedInput`. But it can change only the arguments, not the tool identity. The registry validates:

- The `tool_call_id` does not change.
- The tool name does not change.
- The `StoredToolDefinition` must be the same object.
- The new arguments still pass the original Zod schema.
- The prepared call cannot carry an error, and cannot lack a definition or arguments.

Locking the definition object locks the effect, the handler, and the schema at the same time. Otherwise, a malicious or buggy Hook could disguise a write tool as a read, and bypass the permission.

This attack path is worth walking through concretely:

```text
① The model requests write_file{"path":"a.txt","content":"..."}
② prepare completes, definition.effect === "write"
③ A malicious Pre Hook returns an updatedInput whose definition was swapped for read_file's definition
   (effect: "read")
④ If the registry does not check the definition identity:
      The workspace hard boundary sees effect !== "write" → takes no position
      The confirm-file-write rule sees name !== "write_file" → no match
      → The final result is allow (default), and one write operation passes with zero approval
```

So the check "the `StoredToolDefinition` must be the same object" uses **reference equality**, not name equality — a name can be forged; an object reference cannot.

The registry also freezes the prepared definition, arguments, and prepared shell. A Hook cannot modify the original arguments in place. When it needs to rewrite, it must return a new `updatedInput` explicitly. The registry then parses again with the original Zod schema, copies the arguments, and deeply freezes the normalised copy. The approval and the handler read only this copy.

This step removes a race in asynchronous approval: even if a Hook keeps the original object reference and changes "value A" to "value B" while the user is approving, the permission request and the handler still see the same frozen A. There is no "approved A, executed B".

The race timeline looks like this:

```text
Time →
Hook:  Returns updatedInput{path:"safe.txt"}, and keeps a reference ref itself
       │                                              │
Loop:  ├─ structuredClone + deep freeze → copy A       │
       ├─ The approval box shows A: {"path":"safe.txt"} ───────────┤
       │  (Waits for the user to press y; may wait several seconds) │
       │                                    The Hook secretly changes ref.path = "C:/system-file" now
       ├─ The user presses y; what was approved is A   │
       └─ The handler still reads copy A ✅

Without structuredClone:
       └─ The handler reads ref → executes "C:/system-file" ❌ Approved A, executed B
```

**"What the approval saw" and "what the execution used" must be the same immutable value.** As long as asynchronous approval has a waiting window, this guarantee cannot rest on convention. It can rest only on copy plus freeze.

---

## A Hook allow is only a suggestion, not an authorisation

A Pre Hook can return:

```typescript
return new HookResult({ permissionBehavior: "allow" });
```

The Loop does not execute the tool directly because of this. It converts it into a structured suggestion:

```typescript
const recommendations = [
  new PermissionDecision(
    hook.permissionBehavior,
    `PreToolUse hook requested ${hook.permissionBehavior}`,
    "pre-tool-hook",
  ),
];

const decision = await permissionPolicy.decide(
  new PermissionRequest({
    prepared: effective,
    context,
    recommendations,
  }),
);
```

Chapter 3's workspace hard boundary, Shell default approval, and fixed rules still take part in the merge together. As long as any system participant gives a `deny`, the Hook's `allow` triggers neither an approval nor a handler.

This order cannot be swapped:

```text
Pre Hook → hard permission policy → approval → handler
```

A Hook is an extension mechanism, not a second permission system.

Claude Code's official documentation stresses the same point (https://code.claude.com/docs/en/hooks-guide.md): a Hook can reject a tool call, but staying silent does not automatically approve a call. When it returns no decision, the call still goes through the normal permission flow.

P04's `passthrough` is exactly this semantics: the Hook produces no suggestion, and whether the tool executes is decided entirely by the `PermissionPolicy`.

---

## PostToolUse: chained observation and result rewriting

A Post Hook runs after the handler completes and before the tool message is written into the history:

```typescript
hooks.register("PostToolUse", (context) => {
  const result = context.result;
  if (result === undefined || result.isError || result.content.length <= 100_000) {
    return new HookResult();
  }
  return new HookResult({
    updatedOutput: toolSuccess(`${result.content.slice(0, 100_000)}\n[truncated]`),
  });
});
```

If the first Post Hook changes `original` to `rewritten once`, the second Hook's `context.result` sees `rewritten once`. The registration order is therefore also the rewrite order.

When the handler or the permission refuses, the Post Hook does not run by mistake:

- The handler succeeds or returns a structured tool error: Post runs.
- A Pre block: Post does not run.
- A permission deny: Post does not run.
- A Pre Hook exception: Post does not run.

---

## preventContinuation must also keep message pairing

A Post Hook can use `preventContinuation: true` to say the current result is enough and this turn requests the model no more:

```typescript
return new HookResult({ preventContinuation: true });
```

The difficulty: one assistant message may contain several tool calls at the same time. Assume the first call's Post Hook asks to stop. The Loop cannot return directly, or the remaining calls become orphans.

What an "orphan" looks like concretely:

```text
❌ Return directly
   assistant(tool_calls: call-1, call-2, call-3)
   tool(call-1, "result")
   ← It returned here; call-2 and call-3 have no results
   → If this history is sent to the model again, OpenAI refuses it;
     validateToolPairing() also throws missing tool results for ids: ["call-2","call-3"]
```

The correct handling is:

```text
call-1 → Executes normally and triggers the stop
call-2 → Error [hook_stopped_continuation]
call-3 → Error [hook_stopped_continuation]
Write all three tool results first
Then end normally with call-1's result
```

The pairing error text is fixed as:

```text
Error [hook_stopped_continuation]: Skipped after PostToolUse requested a stop
```

Note that call-2 and call-3 were **not executed and failed**; they were **never executed at all**. Once the `stoppedResultIndex` in the source is set, later calls skip `#executeTool()` directly:

```typescript
if (stoppedResultIndex !== undefined) {
  result = toolError("hook_stopped_continuation", "Skipped after PostToolUse requested a stop");
} else {
  const execution = await this.#executeTool(call, context, tools);
  // ...
}
```

So two guarantees hold at the same time: **the later tools' side effects did not happen**, and **the message structure is still complete**.

The stop flow cannot be paid for by breaking the protocol.

Remember this section in one sentence: **"end early" is a business requirement; "message pairing" is a protocol constraint. A business requirement must be implemented inside the protocol constraint, not the other way round.**

---

## Stop: force a continuation at most once

When the model returns an assistant message with no tool calls, the Loop is about to end. The Stop Hook runs now:

```typescript
hooks.register("Stop", (context) => {
  const toolCount = context.history.filter(
    (message) => message.role === "tool",
  ).length;
  console.error(`[Hook] This session executed ${toolCount} tool calls in total`);
  if (toolCount === 0) {
    return new HookResult({
      forceContinue: userMessage("Please use a tool to check the result first."),
    });
  }
  return new HookResult();
});
```

The first `forceContinue` appends the explicit user message to the history, then requests the model again:

```typescript
const stopHook = await hooks.runStop(history, stopHookActive);
if (stopHook.forceContinue !== undefined) {
  history.push(...stopHook.additionalContext, stopHook.forceContinue);
  stopHookActive = true;
  continue;
}
```

When the model stops the second time, the Hook still executes, and it sees `stopHookActive === true`. Even if the callback returns a `forceContinue` again, the registry removes this request. The Loop ends with the second answer.

So one `run()` adds at most one model turn. It does not form a Stop Hook infinite loop. The lifecycle log still records both Stops completely.

### Why it must be limited to once

The example Hook above has the logic "if the tool call count is 0, ask the model to use a tool first". Without a limit on the count, what happens with a stubborn model:

```text
turn 1  Model: "I think no tool is needed. The answer is X"
        Stop Hook: toolCount === 0 → forceContinue("Please use a tool to check the result first.")
turn 2  Model: "I still think no tool is needed. The answer is X"
        Stop Hook: toolCount is still 0 → forceContinue(...)
turn 3  Same as above
...
turn 20 AgentLimitError (stops only when it hits maxTurns)
```

This path has no syntax error. Every step is "reasonable". The result is burning 20 model calls for one `AgentLimitError`. `maxTurns` does catch it, but the price is too high — **a fallback mechanism should not be treated as a normal exit path.**

`stopHookActive` presses it down to at most two turns:

```text
turn N    The model stops → Stop Hook (stopHookActive: false) → forceContinue → continue the run
turn N+1  The model stops → Stop Hook (stopHookActive: true) → the forceContinue is removed → end
```

Two details are easy to get wrong:

| Detail | Actual behavior |
| --- | --- |
| Is the Stop callback called the second time | **Yes.** Only its `forceContinue` is discarded |
| Can the callback see that it was limited | **Yes.** `context.stopHookActive === true` |

Running the callback the second time is deliberate: side effects such as logs, metrics, and cleanup should not be skipped just because "it cannot continue any more". **What is limited is control, not execution.**

---

## How Hook faults are returned

Extension code can also fail. The tool phase cannot leave an unpaired call behind because a Hook threw an exception.

This chapter fixes the mapping as follows:

| Fault | Tool result | Did the handler execute |
| --- | --- | --- |
| `prepare()` itself throws | `tool_preparation_error` | No |
| Pre returns an illegal input update | `hook_contract_error` | No |
| Pre throws another exception | `hook_execution_error` | No |
| Permission evaluation or audit exception | `permission_evaluation_error` | No |
| Post throws an exception | `hook_execution_error` | **Yes** |

The "Yes" in the last row is this table's key point. Post happens after the handler, so when it fails it cannot claim the side effect did not happen. Returning a stable error and keeping the pairing lets the model and the caller see this lifecycle failure.

Compare the two ends and it becomes clear:

```text
A Pre Hook throws
  → The handler did not run, the disk did not change, hook_execution_error is returned
  → The model can retry with confidence (the retry is safe)

A Post Hook throws
  → The handler ran, the file is already written, hook_execution_error is returned
  → The model should not retry blindly (it may write twice)
```

The two cases share an error code, but **the retry semantics are completely different**. P04 does not split the error code for this — a deliberate teaching simplification. The price is that the model cannot judge from the error code whether the side effect happened. What really needs this distinction is idempotency design, which chapter 11 handles head-on when it discusses recovery strategies.

One more asymmetry is worth noting: `hook_contract_error` appears only in Pre, not in Post. The reason is in the source — only Pre's `updatedInput` goes through the strict validation of `normalizeUpdatedInput()` (tool identity, Zod re-parse). Post's `updatedOutput` only needs to be a legal `ToolResult`. **Pre changes "what is about to execute"; Post changes "how what already happened is described". The former must be stricter.**

UserPromptSubmit and Stop happen outside tool pairing. Their illegal results make the current `run()` fail explicitly; the extension error is not silently ignored.

This is also a deliberate difference:

| Phase | How a Hook fault is handled | Why |
| --- | --- | --- |
| Tool phase (Pre / Post) | Convert to a paired tool error; the loop continues | Without conversion, the message structure breaks — too high a price |
| Non-tool phase (Submit / Stop) | Let `run()` throw directly | There is no pairing constraint here; a failure should fail explicitly |

---

## The exact differences between P03 and P04

P04 adds `hooks` on top of P03's fixed capabilities:

```typescript
export const P04: ChapterProfile = Object.freeze({
  chapter: 4,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
  ]),
});
```

The composition root allows only P04 or a later profile to inject a `HookRegistry`:

```typescript
if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
  throw new Error("hooks require chapter 4 or later");
}
```

The real P04 CLI registers four default Hooks that only record the lifecycle:

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: read_file
[Hook] PostToolUse: read_file -> ok
[Hook] Stop
```

They do not modify arguments, do not overwrite output, and do not grant permission. If the model chooses `shell` or a file write, chapter 3's explicit approval still executes.

The question a beginner asks most easily is: "With Hooks added, does chapter 3's permission system still count?" The table below answers it item by item.

| Dimension | P03 | P04 | Did it change |
| --- | --- | --- | --- |
| The Agent Loop's loop structure | Request → tools → append → request again | Completely the same | **No** |
| Tool lookup, Zod validation, prepare | The same | The same | **No** |
| The four permission states and merge priority | `deny > ask > allow > passthrough` | Completely the same | **No** |
| Workspace hard boundary | Runs before the rules | Position unchanged | **No** |
| Approval and audit | After merging, before execution | Position unchanged | **No** |
| `validateToolPairing()` | Validated every turn | Validated every turn | **No** |
| Fixed mount points in the loop | None | Four | **Added** |
| Permission candidate sources | Rules + hard boundary + approval | One more route: Hook suggestions | **Added** |
| Argument rewrite capability | None | `updatedInput` (must be revalidated) | **Added** |
| Result rewrite capability | None | `updatedOutput` | **Added** |
| End-early capability | None | `preventContinuation` | **Added** |
| Force-continuation capability | None | `forceContinue` (at most once) | **Added** |

The one-sentence conclusion: **P04 only opened four holes in the loop. It did not move any decision order inside the loop.** This is the concrete meaning of "decoupling" — the extension points increased, and the thing being extended did not change by one line.

If you want to confirm this with your own eyes, run the two commands side by side:

```powershell
npm run ch03 -- --prompt 'Read README.md and summarise how to run it'
npm run ch04 -- --prompt 'Read README.md and summarise how to run it'
```

The `[Permission]` lines of the two runs should be exactly the same. The only difference is that P04 has four more `[Hook]` lines.

---

## Composition root and CLI: how Hooks connect at the real entry

`code/chapters/ch04/src/bootstrap.ts` is the composition root. It assembles the model, the tools, the permission policy, and the Hooks by `ChapterProfile`. P04 uses the same `buildAgent`, with only the `hooks` capability added:

```typescript
export function buildAgent(
  profile: ChapterProfile,
  dependencies: BuildDependencies,
): AgentRunner {
  // Forbid forging a profile with the same chapter number but different capabilities; keep the teaching snapshot fixed.
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    throw new Error("hooks require chapter 4 or later");
  }
  // ...
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    workspace: dependencies.workspace,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(dependencies.hooks === undefined ? {} : { hooks: dependencies.hooks }),
  });
}
```

This code turns "chapter capability" into a runtime constraint: even if someone passes a `HookRegistry` into P01–P03 by mistake, it fails directly before the Agent is created.

Two more lines in the `AgentRunner` constructor deserve a separate explanation. They decide what happens in the two cases "no Hooks passed" and "only Hooks passed":

```typescript
this.#permissionPolicy =
  options.permissionPolicy === undefined && options.hooks !== undefined
    ? new PermissionPolicy()
    : options.permissionPolicy;
this.#hooks = options.hooks === undefined ? new HookRegistry() : options.hooks;
```

Once you understand these two lines, you understand why Hooks can connect with "zero configuration":

| What you passed | `#hooks` | `#permissionPolicy` | Consequence |
| --- | --- | --- | --- |
| Neither (the P01/P02 shape) | An empty `HookRegistry` | `undefined` | Every Hook call in the loop hits an empty queue, equal to none; the permission phase is skipped as a whole |
| Only a `permissionPolicy` (P03) | An empty `HookRegistry` | The one you passed | Chapter 3's behavior |
| Both (P04) | The one you passed | The one you passed | This chapter's complete behavior |
| **Only `hooks`, no policy** | The one you passed | **An empty `PermissionPolicy` is added automatically** | The `permissionBehavior` a Hook returns still goes through one real permission evaluation |

Row four is the key. Assume there were no such fallback line. What happens to an Agent that registered only Hooks and configured no permission policy? When a Hook returns `permissionBehavior: "deny"`, there is no policy object, so this suggestion **has nowhere to be handled**, and the tool executes directly — the Hook's rejection is silently dropped.

After an empty `PermissionPolicy()` is added, the semantics become definite:

```text
An empty PermissionPolicy = no rules, no approver, no hard boundary
  ↓
The default candidate is allow ("No permission rule blocked the request")
  ↓
The Hook's deny joins the merge → deny > allow → the rejection takes effect
The Hook's ask joins the merge → no approver → fail closed → rejected
```

**An extension point must not lose effect because "another module was not configured".** In chapter 3, this principle appeared as fail-closed. Here it appears as "rather add an empty policy automatically than let a Hook's suggestion land nowhere".

The real CLI's `liveHooks()` lives in `code/chapters/ch04/src/cli.ts`. It registers four observational callbacks that only output to `stderr`:

```typescript
function liveHooks(): HookRegistry {
  const hooks = new HookRegistry();
  hooks.register("UserPromptSubmit", () => {
    stderr.write("[Hook] UserPromptSubmit\n");
    return new HookResult();
  });
  hooks.register("PreToolUse", (context: HookContext) => {
    stderr.write(`[Hook] PreToolUse: ${hookToolName(context)}\n`);
    return new HookResult();
  });
  hooks.register("PostToolUse", (context: HookContext) => {
    if (context.result === undefined) {
      throw new Error("PostToolUse context is incomplete");
    }
    const outcome = context.result.isError ? "error" : "ok";
    stderr.write(`[Hook] PostToolUse: ${hookToolName(context)} -> ${outcome}\n`);
    return new HookResult();
  });
  hooks.register("Stop", () => {
    stderr.write("[Hook] Stop\n");
    return new HookResult();
  });
  return hooks;
}
```

Every callback returns an empty `HookResult`, so a default run adds only lifecycle logs. It does not change arguments, results, or permission suggestions. The real CLI uniformly uses `stderr.write` for Hook log output; `stdout` carries only the final answer. The `console.error` in the teaching snippets only makes the examples shorter; it does not mean the real entry mixes output streams.

---

## Current boundaries and what is deliberately not done

This chapter implements only the four events that are really used now: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. It does not add subagent, compaction, task, or MCP-specific events early.

Claude Code currently defines more than 14 Hook event classes officially, such as `PermissionRequest`, `SessionStart`, `SubagentStart`, `PreCompact`, and `Elicitation`. See the complete list at https://code.claude.com/docs/en/hooks.md. Chapter 4's event set is a teaching subset.

Hook callbacks execute in order inside the current process. P04 provides no plugin isolation, no independent timeout, and no parallel Hooks. Parallel execution would make the rewrite order and the short-circuit semantics ambiguous.

One difference from Claude Code's official implementation: the official version executes all matching Hooks of the same class, then merges the results (merge priority `deny > defer > ask > allow`). P04 short-circuits on a `blockingError` or a Stop `forceContinue`, and stops the later callbacks early.

This is a teaching simplification: a blocking error means the later callbacks are meaningless for this tool, and the short-circuit position is explicit. In a concurrency scenario, if you need the aggregate result of all callbacks, you can extend it yourself.

A Hook is also not a sandbox. It is trusted extension code registered by the application. It can throw exceptions or execute its own side effects. The structured contract protects the Agent Loop's state and permission order. It provides no operating-system isolation.

This sentence is easy to read lightly, so state its exact meaning clearly:

```text
What the Hook contract can control:
  ✅ It cannot swap write_file for read_file and execute it (definition reference equality)
  ✅ It cannot make the arguments differ from what was approved (revalidation + deep freeze)
  ✅ It cannot bypass a deny (merge priority)
  ✅ It cannot break tool_call_id pairing (a block also fills in a result)
  ✅ It cannot continue forever (stopHookActive)

What the Hook contract cannot control:
  ❌ A Hook callback calling fs.writeFileSync('C:/anything', ...) itself
  ❌ A Hook callback sending an HTTP request itself
  ❌ A Hook callback reading environment variables or secrets
```

The reason is direct: a Hook is an ordinary function that you wrote yourself, running in the same process as the Loop. **The contract protects "the Loop's state and decision order are not broken by extension code", not "the extension code itself is limited in what it can do".** The former is this chapter's goal. The latter needs process isolation or an operating-system-level sandbox, which is outside the teaching scope.

In other words: the model is untrusted, so tool calls go through permission. A Hook is trusted, so it only needs to go through the contract. Mixing the two up leads to the dangerous conclusion "with Hooks added, we have a sandbox".

---

## Companion code map

To let the reader locate the source code directly, this chapter lists all files of `code/chapters/ch04/src/` in one coverage table:

| File | Responsibility | Where it is explained |
| --- | --- | --- |
| `core/hooks.ts` | Hook events, context, results, and registry | This chapter's core implementation |
| `core/loop.ts` | The Agent Loop and the four Hook mount points | This chapter's core implementation |
| `core/profiles.ts` | The P01–P04 fixed capability snapshots | "The exact differences between P03 and P04" above |
| `bootstrap.ts` | Assembles infrastructure, permission, and Hooks by profile | "Composition root and CLI" above |
| `cli.ts` | Terminal entry, human approval, and the default observational Hooks | "Composition root and CLI" above |
| `config.ts` | `.env` model configuration validation | "Run chapter 4" below |

| `chapters/ch01.ts` to `ch04.ts` | Fixed chapter entries; capability switching is forbidden | "The exact differences between P03 and P04" above |
| `core/messages.ts` | The message model, the `tool_call_id` pairing contract | HookResult and preventContinuation earlier |
| `core/tools.ts` | Tool registration, prepare, invoke, frozen arguments | "PreToolUse" above |
| `core/permissions.ts` | Permission rules, approval, audit, and merging | "A Hook allow is only a suggestion" above |
| `core/filesystem.ts`, `core/commands.ts`, `core/model.ts` | The minimal interfaces for files, commands, and the model | Inherited contracts from chapters 2–3 |
| `adapters/powershell.ts`, `adapters/openai-chat.ts`, `adapters/filesystem.ts` | PowerShell, OpenAI, and file system implementations | Inherited implementations from chapters 2–3 |
| `features/builtin-tools.ts` | The `shell` and file tool sets | Inherited implementation from chapter 2 |

This map also shows the Hook boundary: this chapter did not add a callback to every adapter. It concentrates the extension points at the Loop's four fixed positions. External implementation differences are still converged by their own adapters.

---

## What we learn from ai-agent-book

Chapter 4 of *ai-agent-book* takes another, complementary route: tool classification, the MCP protocol, and event-driven asynchronous Agents. It defines an "event-triggered tool" as a class of tool that the Agent registers and an external source triggers — for example, a timer, a background command monitor, or an external message channel. These tools wake the Agent when the user has not asked a question.

P04's Hooks are not that mechanism. A Hook is an interception point in the Agent's internal lifecycle: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` all happen inside the same `run()`. They append logs, rewrite tool inputs and outputs, suggest permission, or control whether the run continues. The two can combine:

```text
An external event (timer, Webhook, IM)
        ↓
An event-triggered tool → generates a new prompt
        ↓
UserPromptSubmit → PreToolUse → handler → PostToolUse → Stop
```

---

## Run chapter 4

### Step 0: Prepare the environment

Exactly the same as the first three chapters: `npm ci` in `code/`, and fill in the three variables in `.env`.

```powershell
Set-Location 'F:\笔记\Agent实操\code'
```

### Step 1: Run the offline tests first

```powershell
npm run test:ch04
```

Expect the last two lines:

```text
 Test Files  12 passed (12)
      Tests  94 passed (94)
```

From chapter 3's 61 to 94, the 33 new ones are almost all in `hooks.test.ts` and `ch04-hooks.test.ts`. The line `Configuration Error: Missing required settings: ...` in the output is still the asserted expected output, not a failure.

### Step 2: Watch the four Hooks each print one log line

```powershell
npm run ch04 -- --prompt 'Read README.md and summarise how to run it'
```

Expect to see this order on stderr (`[Hook]` is new in this chapter, `[Permission]` is chapter 3's):

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: read_file
[Permission] read_file: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: read_file -> ok
[Hook] Stop
```

Please confirm in particular that `[Hook] PreToolUse` is **before** `[Permission]`. This line order is this chapter's most core design conclusion: the Hook speaks first, the permission system decides after.

### Step 3: Let a Hook and an approval appear together

```powershell
npm run ch04 -- --prompt 'Write one sentence into hook-demo.txt'
```

Expected order:

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: write_file

Tool call requires approval: write_file
Reason: File writes require explicit approval from chapter 3 onward
Arguments: {"path":"hook-demo.txt","content":"..."}
Allow this call? [y/N] y

[Permission] write_file: allow (terminal-approval) - User approved this tool call
[Hook] PostToolUse: write_file -> ok
[Hook] Stop
```

This step shows two things at the same time: the Pre Hook finishes before the approval box, and the Post Hook runs only after the write completes. **The four default Hooks only print logs. They do not approve anything for you** — the approval box still pops up.

### Step 4: The unified entry

```powershell
npm run agent-tutorial -- run --chapter 4 --prompt 'Read README.md and summarise how to run it'
```

### Step 5 (optional): The complete offline gates

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

The tests verify behavior through a `ScriptedModelClient`, structured permission doubles, and in-memory Hooks. They read no real API Key and access no network.

### Troubleshooting common errors

| Symptom | Cause | How to handle it |
| --- | --- | --- |
| No `[Hook]` line is visible | The Hook logs go to stderr; you may have redirected stderr away | Do not add `2>$null`; or confirm you ran `ch04`, not `ch03` |
| `[Hook] PostToolUse: xxx -> error` | The tool itself returned an error result | This is a normal observation log. **A Post Hook also runs when the tool fails** |
| Only `PreToolUse`, no `PostToolUse` | The call was blocked by Pre, or refused by the permission | Normal behavior. See the four items at the end of "PostToolUse" |
| `Error [hook_contract_error]` | The `updatedInput` your Pre Hook returned is illegal | Check: did the `tool_call_id` change? Did the tool name change? Was the definition swapped for another object? Did the new arguments fail Zod? |
| `Error [hook_execution_error]` | A Hook you wrote threw an exception | Look for your own logs on stderr. Note that Pre and Post share this code; judge which end yourself |
| `Error [hook_stopped_continuation]` | An earlier call in the same turn triggered `preventContinuation` | Normal behavior. These calls **were not executed** |
| Startup reports `hooks require chapter 4 or later` | A `HookRegistry` was passed to P01–P03 | Switch to P04, or do not pass hooks |
| A Hook you wrote returned a plain object and reports `must return HookResult` | You returned a `{}` or `{ blockingError: ... }` literal | You must `return new HookResult({...})`. The runtime checks with `instanceof` |
| A Stop Hook's `forceContinue` did not take effect the second time | `stopHookActive === true` | Normal behavior. One `run()` continues at most once |

---

## Verification and experiments

`npm run test:ch04` executes 12 test files and 94 tests. The two new files in this chapter are:

| Test file | What it verifies |
| --- | --- |
| `hooks.test.ts` | Unit level: `HookContext` field trimming, `HookResult.validateFor()`, registration order, merge rules, `updatedInput` revalidation and freezing, short-circuit behavior |
| `ch04-hooks.test.ts` | End to end: Hook vs permission priority, the handler did not execute after a block, `preventContinuation` pairing, Stop continues only once, P01–P03 behavior unchanged |

The other 10 are the accumulated tests of the first three chapters. They keep guaranteeing "adding Hooks did not break the old behavior" — the direct expression of acceptance criterion 9.

Worth a separate look is the test writing for **acceptance criterion 5** (the system `deny` has priority over a Hook `allow`). What it must prove is not "a rejection was returned", but "the Hook's allow was correctly demoted to a suggestion":

```text
Setup: A Pre Hook returns permissionBehavior: "allow"
      + an out-of-bounds write that hits the workspace hard boundary
Assert: The final result is Error [permission_denied]: Writing outside the workspace is forbidden
      Not the Hook's allow taking effect
      And the file really was not created
```

This test is the seam between this chapter and chapter 3. **As long as it is green, "a Hook is not a second permission system" is not just a design slogan.**

### Four small experiments to try yourself

**Experiment 1: Register two Post Hooks and observe the processing chain**

Append two rewriting Post Hooks in `liveHooks()` in `cli.ts`:

```typescript
hooks.register("PostToolUse", (context) => {
  if (context.result === undefined) throw new Error("incomplete");
  stderr.write(`[Hook A] saw: ${context.result.content.slice(0, 20)}\n`);
  return new HookResult({ updatedOutput: toolSuccess("AAA") });
});
hooks.register("PostToolUse", (context) => {
  if (context.result === undefined) throw new Error("incomplete");
  stderr.write(`[Hook B] saw: ${context.result.content.slice(0, 20)}\n`);
  return new HookResult({ updatedOutput: toolSuccess("BBB") });
});
```

Expected: `[Hook B] saw: AAA`, and what is finally written to the history is `BBB`.
Learned: a Post Hook is a pipeline, not parallel observers. **Remember to change it back after the experiment.**

**Experiment 2: Let a Pre Hook block a write**

```typescript
hooks.register("PreToolUse", (context) => {
  const args = context.prepared?.arguments;
  if (typeof args === "object" && args !== null && Reflect.get(args, "path") === "blocked.txt") {
    return new HookResult({
      blockingError: toolError("hook_blocked", "blocked.txt is managed elsewhere"),
    });
  }
  return new HookResult();
});
```

Then run `npm run ch04 -- --prompt 'Write hello into blocked.txt'`.

Expected: **the approval box does not pop up**, no `[Hook] PostToolUse` is visible, and there is no `[Permission]` line. The model receives `Error [hook_blocked]: blocked.txt is managed elsewhere`.
Learned: `blockingError` short-circuits the three phases of permission, handler, and Post.

**Experiment 3: Let a Pre Hook's allow challenge the hard boundary**

Change the Hook above to `return new HookResult({ permissionBehavior: "allow" })`, then run an out-of-bounds write:

```powershell
npm run ch04 -- --prompt 'Write hello into ../outside.txt'
```

Expected: it is still `[Permission] write_file: deny (workspace-boundary) - ...`.
Learned: this is acceptance criterion 5. A Hook's `allow` is only one candidate decision; `deny` still wins.

**Experiment 4: Modify the arguments in place in a Pre Hook**

```typescript
hooks.register("PreToolUse", (context) => {
  const args = context.prepared?.arguments;
  Reflect.set(args as object, "path", "hacked.txt");   // Modify in place
  return new HookResult();                              // Do not return an updatedInput
});
```

Expected: it throws a `TypeError` (the arguments were already deeply frozen), or in non-strict mode it fails silently but **the arguments do not change**. Either way, the original path is what gets written.
Learned: to change arguments, you must return an `updatedInput` explicitly, and go through the revalidation and re-freezing path.

---

## Chapter summary

### The three-sentence version

1. A Hook publishes structured context at four fixed positions, moving extension logic out of the core orchestration.
2. The return value uses a structured `HookResult` instead of a string, because control-flow semantics must be validatable.
3. A Hook can suggest, rewrite, and block, but it **cannot authorise** — a system `deny` always has priority.

### Seven points to remember

| # | Conclusion | Which section it appears in |
| ---: | --- | --- |
| 1 | A mount point is chosen at the position where "the information is just complete and the action is still in time" | Look at the real execution order first |
| 2 | `additionalContext` can only be system, and it is written late, after pairing completes | HookResult |
| 3 | An `updatedInput` must pass Zod again and be deeply frozen, or you get "approved A, executed B" | PreToolUse |
| 4 | The definition is locked by **reference equality**, to stop a write disguising itself as a read | PreToolUse |
| 5 | Registration order = execution order = processing order; conservative fields are the exception (take the stricter one) | HookRegistry |
| 6 | Ending early must also fill the same turn's remaining calls in as paired errors | preventContinuation |
| 7 | Stop continues at most once; the second callback still executes, only its control is taken back | Stop |

### This chapter's code boundary (explicitly "what is not done yet")

| Already there | Not yet | Explanation |
| --- | --- | --- |
| Four lifecycle events | The official 14+ event classes (`SessionStart`, `PreCompact`, `SubagentStart`, etc.) | A teaching subset; added in later chapters as needed |
| In-process callbacks that execute in order | Plugin isolation, independent timeouts, parallel execution | **Not done.** Parallel execution would make the rewrite order and short-circuit semantics ambiguous |
| `blockingError` / `forceContinue` short circuit | The official "run them all, then merge" | A deliberate simplification; the short-circuit position is explicit |
| A structured contract protects the Loop state | An operating-system-level sandbox | **Not done.** A Hook is trusted application code |
| Pre's `hook_contract_error` | Post's equivalent strict validation | A deliberate asymmetry; see "How Hook faults are returned" |
| A unified `hook_execution_error` | Distinguishing "side effect happened / did not happen" | Handled in chapter 11, when recovery and idempotency are discussed |
| `UserPromptSubmit` appends context | Replacing, deleting, or blocking the original prompt | **Not done.** User input should not be rewritten by extension code |

### Check whether you really understood

1. Which appears first, `[Hook] PreToolUse` or `[Permission]`? Why can it not be reversed? (Look at the real execution order first)
2. Why does `additionalContext` allow only system messages? What happens if tool messages are allowed? (HookResult)
3. A malicious Pre Hook wants to disguise `write_file` as `read_file`. Which check stops it? (PreToolUse)
4. Three Post Hooks rewrite the result in order. Which version does the third one see? (HookRegistry)
5. One turn has three calls. The first triggers `preventContinuation`. What is the tool result content of the other two? Were they executed? (preventContinuation)
6. When a Stop Hook is called the second time, does its `forceContinue` take effect? Does the callback still execute? (Stop)
7. A Post Hook throws and a Pre Hook throws. The error codes are the same, but where is the semantic difference? (How Hook faults are returned)

---

Chapter 4 finally keeps one verifiable fixed pipeline:

```text
UserPromptSubmit
        ↓
model
        ↓
prepare
        ↓
PreToolUse
        ↓
permission / approval
        ↓
handler
        ↓
PostToolUse
        ↓
paired tool results
        ↓
Stop
```

When logs, notifications, or result checks are added later, you only register a new callback. The permission priority, the tool identity, and the OpenAI message pairing are still maintained by the same Agent Loop.
