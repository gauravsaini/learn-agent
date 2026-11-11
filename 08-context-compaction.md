The previous chapter solved on-demand Skill loading: at startup, the Agent sees only the Skill catalog. When it needs a capability, it uses `load_skill` to put the body into the current session.

But a slim catalog solves only the initial context. Once a task starts, the Agent reads files, runs commands, and calls tools, and the history keeps growing. In particular, when one turn produces several large tool results, a few calls can bury the real target, the constraints, and the latest progress.

A larger context window only postpones the problem. The real work is to manage the life cycle of the information: where do large results go, how does old content degrade, which messages must never be split apart, and how do you trace the original record after compaction?

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaH86aBMHoZ6aXZCyZcvsAweBaia0icgfXUHOb6OPb8eJDMCs5Q6SsYQ2icxwjkUDwTVUeGZuiaOy1DvKRDQ31puo8IHpl2HTA6P1Kg/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

1. State the two costs of "context growth": it does not fit (a length constraint) and it is not clear (Context Rot), and why the second cost is harder to see.
2. Repeat the execution order and the trigger conditions of the four compaction levels, and explain why the order must be "cheap first, expensive later".
3. Distinguish the four objects — canonical history, request history, transcript, and artifact. Confusing them is the number one cause of compaction bugs.
4. Explain what a "message atomic group" is, and why trimming by message index breaks when one turn has 3 tool calls.
5. Calculate what a threshold such as "30,000 bytes" actually measures. It is not a character count, not a token count, and not a window size.
6. Point to the exact moment when compaction happens, and why that moment directly decides whether the KV Cache can be reused.
7. Judge which capabilities this chapter does **not** build (automatic prompt-too-long recovery, a `compact` tool, automatic file content restoration), so you do not claim behavior that does not exist.

### What you need first

| Prerequisite | From which chapter | How this chapter uses it |
| --- | --- | --- |
| The message history and tool pairing invariant of the Agent Loop | Chapter 1 | Every compaction trim action must keep this invariant |
| The workspace hard boundary and path validation | Chapter 2 | An artifact can land only in a fixed directory inside the workspace |
| The `isError` / `errorCode` structure of a tool result | Chapters 2 and 3 | Persistence must keep the error metadata unchanged |
| The `PostToolUse` timing of a Hook | Chapter 4 | Persistence happens **after** all Hooks of the whole turn finish |
| The history isolation of `task` and a subagent | Chapter 6 | A subagent has its own history. Compaction does not interfere across Agents |
| The body of `load_skill` stays in the history | Chapter 7 | This is exactly one class of large result that this chapter handles |

### Quick terminology (terms that appear for the first time in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| Context growth | The history messages keep growing as the task proceeds, and finally crowd out or even push out the key information |
| Context Rot | The window is not full, but a large amount of unrelated content dilutes the key information. The model "can see it but cannot find it" |
| canonical history | The single source of truth for the session facts. `AgentRunner` holds it. Compaction never rewrites it |
| request history | A snapshot copied from canonical before each model request. Compaction acts only on it |
| artifact | A complete content file written to disk. The message holds only the path and a preview |
| transcript | A snapshot of canonical history saved before the model summary, in JSONL format, for tracing |
| Message atomic group | One assistant message + all of its tool results. It is the smallest trim unit, and you cannot split it |
| Persist | Level 1 compaction: write an oversized tool result to a file, and replace it in the message with a reference |
| snip | Level 2 compaction: cut whole groups from the middle of the history, and insert one omission marker |
| micro | Level 3 compaction: replace the **result body** of an earlier tool group with a placeholder, and keep the call structure |
| Model summary | Level 4 compaction: call the model once, and replace a long history with 5-field structured JSON |
| Bounded preview | The head and tail fragment that stays in the message after persistence, truncated by UTF-8 bytes |
| Exclusive publish | When you write a file and the target already exists, fail explicitly. Never overwrite |
| prompt-too-long | The vendor rejects the request because the **input** is too long. Note that this is a different thing from output truncation |

### Suggested reading route

```text
Chapter guide (you are here)
  ↓
① Look at one real compaction first   ← a large file comes in; what actually stays in the message?
  ↓
② Why a larger window does not work   ← the two costs, and the real purpose of compaction
  ↓
③ The four-level pipeline and its timing   ← cheap first, expensive later, and its relation to the KV Cache
  ↓
④ Never confuse the four objects   ← the most important concept distinction in this chapter
  ↓
⑤ Message atomic groups   ← why you cannot trim by message index
  ↓
⑥ Level 1 → Level 4   ← take each level apart; every level has reproducible numbers
  ↓
⑦ transcript and the cache   ← how to trace after compaction, and how to avoid compacting twice
  ↓
⑧ Two APIs that are not wired yet   ← the real boundary of proactive compaction and reactive recovery
  ↓
⑨ Offline tests + run + experiments   ← verify by hand + five small experiments + troubleshooting
```

---

## Look at One Real Compaction First

Talking about "compaction" in the abstract is worse than looking at one run directly. Everything in this section comes from `code/chapters/ch08/tests/ch08-compaction.test.ts`. It is real data that the tests assert.

The workspace holds one large file:

```typescript
const content = "甲".repeat(10_001);          // 10001 Chinese characters
await writeFile(join(workspace, "large.txt"), content, "utf8");
```

One Chinese character takes 3 bytes in UTF-8, so this file is 30,003 bytes — just above the default single-item persist threshold of 30,000.

In the first turn, the model calls `read_file` to read it. The tool returns all 30,003 bytes normally. **But before these results enter the history, they pass through one processing step.** The test asserts that when the model is called the second time, the last message in the history looks like this:

```text
<persisted-tool-result>
path: .agent_tutorial/artifacts/tool-result-3f9a1c72e8b04d5f9c1e7a2b6d8f0e41.txt
original_bytes: 30003
head_preview:
甲甲甲甲甲…… (at most 2,000 bytes)
tail_preview:
……甲甲甲甲甲 (at most 2,000 bytes)
</persisted-tool-result>
```

The matching assertion is:

```typescript
expect(persisted.content).toContain("<persisted-tool-result>");
const relativePath = /^path: (.+)$/m.exec(persisted.content)?.[1];
expect(relativePath).toMatch(/^\.agent_tutorial\/artifacts\/tool-result-[a-z0-9]+\.txt$/);
expect(await readFile(join(workspace, ...relativePath.split("/")), "utf8")).toBe(content);
```

The last line is the point: **the complete 30,003 bytes lose not one byte.** They sit in that file on disk, and you can read them again at any time.

Compare the three numbers:

| | Content that enters the history | Size |
| --- | --- | ---: |
| No compaction | 30,003 bytes of body text | 30,003 bytes |
| After level 1 compaction in this chapter | Path + original size + head and tail previews of 2,000 bytes each | About 4,100 bytes |
| The artifact on disk | The complete body, byte for byte identical | 30,003 bytes |

The history lost 86%. The information lost nothing — it only changed its storage location.

### Is this message still a legal tool result?

Yes. The test pins this point specifically:

```typescript
expect(result.history[2]).toEqual(persisted);
validateToolPairing(result.history);
```

`result.history[2]` is the third message in canonical history, and it is identical to the one the model saw. `validateToolPairing()` confirms that the invariant from chapter 1 — "each `tool_call` pairs with exactly one `tool` result" — still holds.

In other words, persistence replaces only the **content of the message**, not the message itself. The `tool_call_id` did not change. The pairing relation did not change. The message count did not change. Every compaction action in this chapter obeys this bottom line.

### Does an approval dialog appear?

No. The approver that this test passes in is the one that throws an exception:

```typescript
class UnexpectedApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    throw new Error("read_file should not request approval");
  }
}
```

The test passes, which proves that `decide()` was never called. Persistence is a storage decision inside the Harness. It is not a write operation that needs user approval — it writes the runtime's own state directory, not the user's project files.

### Did the tool list change?

No. The same test asserts:

```typescript
expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
  "shell", "read_file", "write_file", "edit_file", "glob", "todo_write", "task", "load_skill",
]);
```

These are still the 8 tools from chapter 7. **There is no new `compact` tool.** This point matters a lot. Later, the section "The proactive compaction API is not a compact tool" expands on it: the compaction in this chapter is automatic Harness work, not a capability that the model can call.

---

## Why a Larger Window Does Not Solve the Problem

The most intuitive reaction of a beginner is: when the context is not enough, switch to a model with a larger window. But that only postpones the problem, because growth has two costs, and switching the model eases only the first one.

**Cost one: it does not fit.** This one is easy to understand. The history exceeds the window, and the vendor rejects the request directly.

**Cost two: it is not clear.** This one is much more hidden. The window is not full yet, but the key information is already diluted. `ai-agent-book` calls this phenomenon Context Rot: the model must "retrieve" the relevant fragments again and again from tens of thousands of tokens. When unrelated content takes the majority, the real target, the constraints, and the latest progress get buried.

Chapter 5 explained why this happens: the attention mechanism has no guarantee that "later means higher weight". An important constraint sits in message 3, and 40 tool results pile up behind it. Its probability of receiving attention really does fall.

So do not understand the goal of compaction as "saving money". Understand it as:

> Replace "the raw record that the model must summarise live" with "a structured conclusion that it can read directly".

This distinction decides the design direction. If you only want to save tokens, the cheapest method is to delete all the old messages. But then the model forgets what it is doing. Each of the four compaction levels in this chapter answers the same question: **does the model still need to "see" this information now, or does it only need to "find it again"?**

- It still needs to see it → keep it in the message.
- It only needs to find it again → persist it, and leave the path in the message.
- It may not even need to find it again, but the conclusion must survive → replace it with a placeholder or a structured summary.

---

## Core Principle: Cheap First, Expensive Later

Chapter 8 splits compaction into four levels. It executes them strictly in cost order, from low to high:

| Level | What it does | Cost | Trigger condition |
| ---: | --- | --- | --- |
| 1 | Persist a large tool result, and leave the path and a preview in the message | One disk write | A single item > 30,000 bytes, or a whole-turn total > 200,000 bytes |
| 2 | `snip`: cut whole groups from the middle of the history | A pure in-memory operation | Message group count > 50 |
| 3 | `micro`: replace the result of an earlier tool group with a placeholder | A pure in-memory operation | A tool group exists before group 4 |
| 4 | Model summary: replace with 5-field JSON | **One model request** | After the first three levels, still > 50,000 bytes |

The key is that three gates stand in front of level 4. The first three levels cost no model call. They block as much as they can. Only when they really cannot block enough do you pay the cost and the latency of that level 4 request.

If you reverse the order — call the model to summarise first in every turn — then every turn costs one extra request and one extra latency, and you also carry the risk that the summary is wrong. The four-level order is not arbitrary. It follows "cheap first".

![Image|809](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaGvRxd2otg2t41orry2wFymWIbict6smb3fWUrnW7b5oWwppgVSX1Ifia9Hic24ExSD6KicoHHxLLicw1DF8R7w9Xib1Gic3Hjx8WI7kE/640?from=appmsg&watermark=1#imgIndex=2)

### When does compaction happen (this decides whether the KV Cache can be reused)

This is the point that beginners ignore most easily, and it has the largest engineering impact. Compaction does **not** change the context inside one request. It preprocesses the request history **between** two model calls.

One complete timeline:

```text
Turn N
├─ ① The model returns tool_calls
├─ ② Execute the tools in order, and run PreToolUse / PostToolUse
├─ ③ ★ Give the whole batch of results to compactToolResults()  ← level 1 is here
├─ ④ Write the results into canonical history in the original tool_call_id order
│
Turn N+1
├─ ⑤ Copy a request history snapshot from canonical history
├─ ⑥ ★ prepare(): snip → micro → summarise only above the threshold  ← levels 2, 3, and 4 are here
└─ ⑦ Request the model with the compacted request history
```

Why does this moment matter? Because the model vendor's KV Cache hits by **prefix**:

```text
[System Prompt] [Tool definitions] [Message 1] [Message 2] ... [Message N]
 ↑───────────── static prefix, always hits ─────────────↑
                                    ↑ change from here, and everything after it fails
```

The System Prompt and the tool definitions are static in this chapter. They are always reusable. In the request history, from the changed message onward, all the later cache fails. But **the prefix before it stays valid**.

Two design choices follow:

1. **Persist the large results together at the end of the whole turn**, not while you execute. Then one turn produces only one history change.
2. **Postpone the model summary until after the byte threshold is exceeded**, and do not do it in every turn. A summary replaces a large history segment with one message. Its change point sits very early, and its cost is the largest.

Chapter 2 of `ai-agent-book` summarises this trade-off in one sentence: **batch compaction helps the KV Cache more than frequent compaction.**

### The two code connection points

The real implementation is concentrated in [`features/compaction.ts`](code/chapters/ch08/src/features/compaction.ts). The wiring sits in [`bootstrap.ts`](code/chapters/ch08/src/bootstrap.ts) and the shared [`core/loop.ts`](code/chapters/ch08/src/core/loop.ts). The chapter 8 entry [`chapters/ch08.ts`](code/chapters/ch08/src/chapters/ch08.ts) only selects the fixed `P08` Profile. It does not copy the Agent Loop.

The composition root creates **one** `CompactionManager`, and connects it to two explicit boundaries:

```typescript
historyProcessor: compactionManager,                    // Prepare the request history before a model request
toolResultProcessor: async (results) =>                 // Process the results after the whole turn of tool execution completes
  (await compactionManager.compactToolResults(results)).results,
```

One object, two boundaries. They match ③ and ⑥ in the timeline above. P08 does not copy the loop, and it registers no extra tool.

---

## Never Confuse the Four Objects

The place where compaction goes wrong most easily is treating every `messages` value as the same mutable list. The current implementation distinguishes four objects explicitly:

| Object | What it is | Does request-level compaction rewrite it? |
| --- | --- | --- |
| canonical history | The session facts that `AgentRunner.#history` holds. `RunResult.history` returns its immutable snapshot | **No** |
| request history | A snapshot copied from canonical history before each model call, and given to `prepare()` | Yes, but it affects only this request and the later reusable request snapshots |
| transcript | A canonical history JSONL snapshot saved before the model summary | No. The file publishes exclusively. A conflict does not overwrite |
| tool-result artifact | The complete UTF-8 content of a large tool result | No. Canonical history holds the path and a preview |

Use a diagram to see their relation clearly:

```text
                        ┌─────────────────────────────────────┐
   A whole turn of tool execution ends  →   │  compactToolResults()               │
                        │  Oversized result → write an artifact file         │
                        └──────────────┬──────────────────────┘
                                       │ Replace it in the message with <persisted-tool-result>
                                       ▼
                        ┌─────────────────────────────────────┐
                        │  canonical history (the single source of truth)   │  ← never rewritten by compaction
                        └──────────────┬──────────────────────┘
                                       │ Copy one immutable snapshot
                                       ▼
                        ┌─────────────────────────────────────┐
                        │  request history                    │
                        │  snip → micro → (above threshold) model summary   │
                        └──────────────┬──────────────────────┘
                                       │        ↑
                                       │        └── Before the summary, save canonical as a transcript first
                                       ▼
                                   Request the model
```

### A boundary that looks small but is actually key

**A large tool result is processed before it enters canonical history.** So canonical history never held that oversized body. It holds the `<persisted-tool-result>` reference. The complete body exists only in the independent artifact.

And `snip`, `micro`, and the model summary all happen on the **request snapshot**. They let the model see a shorter history next time. But they do not delete messages that already exist in `AgentRunner.#history`.

A test pins this distinction directly. This code comes from `compaction.test.ts`:

```typescript
const first = [userMessage("start"), ...exchange("old", "large old result")];
const prepared = await manager.prepare(first);

expect(prepared[2]).toEqual(toolMessage(COMPACTED_TOOL_RESULT, "old"));  // The request history was compacted
expect(first[2]).toEqual(toolMessage("large old result", "old"));        // The history passed in did not change
```

The same index, two different values. **This is the practical meaning of "compaction acts only on the request snapshot".**

Why must the design work this way? Because canonical history is the session facts. If compaction could rewrite it, these problems appear:

- The record that `RunResult.history` returns does not match what really happened, and troubleshooting has no starting point.
- Once compaction has a bug, the damage is irreversible — the original record is already gone.
- The cache judgement loses its basis: you do not know "has this history already been compacted".

### The complete request path

```text
One whole turn of ToolResult values
    → Persist the large results, and generate the paths and previews
    → Append them to canonical history as tool messages
    → Copy a request history snapshot
    → snip (cut whole groups from the middle)
    → micro (downgrade old results by whole group)
    → Are the UTF-8 bytes of the canonical JSONL > 50,000?
       ├─ No: request the model directly
       └─ Yes: save the canonical transcript first, then summarise the request history
```

---

## The Chapter 8 Acceptance Contract

List the conclusions that this chapter must pin down first. Each later section explains one of them. The section "Prove the behavior with offline tests" verifies them one by one.

| # | Contract | What the opposite looks like |
| ---: | --- | --- |
| 1 | A threshold is computed in real UTF-8 bytes. A value exactly equal to the threshold stays in the message | Use the string `length` and pretend it is a byte count |
| 2 | Every trim uses a complete message group as the unit. It never produces an orphan `tool` message | Slice by message index, and let the boundary fall between an assistant and its results |
| 3 | Request-level compaction does not rewrite canonical history | Modify `#history` in place, and pollute the source of truth |
| 4 | Write the transcript before the model summary. If the transcript write fails, do not call the summary model | Summarise first and archive later. When the summary fails, the scene is already lost |
| 5 | An artifact publishes exclusively. An ID conflict fails explicitly instead of overwriting | A later write silently covers an earlier one |
| 6 | When persistence fails, replace the whole batch of results with a controlled error uniformly. The pairing relation does not change | Mix part original text and part reference in one turn, or let the result count mismatch |
| 7 | An identical history reuses the cache. A purely appended history reuses the compacted prefix | Summarise again in every turn, and send the old long history into the model repeatedly |

---

## Message Atomic Groups: You Cannot Look at Only Two Adjacent Messages

This section is the foundation of the chapter. Understand it, and the later three compaction levels will not confuse you.

One OpenAI assistant message can contain **several** `tool_calls` at the same time. Then the legal history is not the simple "one call pairs with one result". It is an atomic group that you cannot split:

```text
assistant(tool_calls=[call_a, call_b])   ← one message, two calls
tool(tool_call_id=call_a)                ← result 1
tool(tool_call_id=call_b)                ← result 2
   3 messages in total, but only 1 message group
```

### What happens when you trim by message index

Assume the history has 7 messages, and you want to "keep only the last 5":

```text
[0] user      "start"
[1] assistant tool_calls=[a, b]     ← cut here; this one is dropped
─────────────────── keep line ───────────────────
[2] tool      result a                 ← orphan! Its assistant is gone
[3] tool      result b                 ← orphan!
[4] assistant tool_calls=[c]
[5] tool      result c
[6] assistant "done"
```

The result is two orphan `tool` messages. Sending them to OpenAI fails directly, because the protocol requires every `tool` message to map to the `tool_call_id` of an earlier assistant message.

Cutting in the other direction is equally bad: you keep the assistant's calls but drop part of the results, and the model sees "I issued two calls, and only one came back".

### How the implementation solves it

The internal `validatedGroups()` first calls `validateToolPairing()` to verify the pairing, then splits the history into two group classes:

- **An ordinary message** (user / system / an assistant with no tool calls) forms one group alone.
- **One assistant message with tool calls + all of its tool results** together form one "tool exchange group".

The grouping logic is direct — when it sees an assistant with calls, it consumes `toolCalls.length` more messages after it:

```typescript
if (message.role === "assistant" && message.toolCalls.length > 0) {
  const end = index + 1 + message.toolCalls.length;   // 1 assistant + N results
  groups.push(createMessageGroup(snapshot.slice(index, end)));
  index = end;
  continue;
}
groups.push(createMessageGroup([message]));           // An ordinary message forms a group alone
index += 1;
```

Look at the same history by group again:

```text
Group 0: [0] user "start"                                    ← 1 message
Group 1: [1] assistant tool_calls=[a,b] + [2] tool a + [3] tool b   ← 3 messages
Group 2: [4] assistant tool_calls=[c] + [5] tool c          ← 2 messages
Group 3: [6] assistant "done"                                ← 1 message
```

7 messages = 4 groups. The keep boundary of `snip`, the replacement unit of `micro`, and the tail that reactive compaction keeps all use **groups**, not message indexes. So when one turn contains two, three, or even more tool calls, the cut never produces an orphan.

A common approach in early examples is "check one message before and one message after the cut point to repair the boundary". That is unreliable for several tool calls in one turn — you do not know how many messages to look back. **Build the groups first, then slice.** The boundary then cannot land inside a group by construction.

This constraint is not a Prompt suggestion. It is a runtime contract: the code validates the pairing again before and after compaction, and an illegal history fails **before** it writes a transcript or calls the summary model. A test pins this order directly:

```typescript
await expect(manager.compactProactively([toolMessage("orphan", "missing")]))
  .rejects.toThrow(/orphan tool result/);

expect(summarizer.histories).toEqual([]);                       // The summary model was not called
await expect(readFile(join(workspace, ".agent_tutorial"), "utf8")).rejects.toThrow();  // The directory was not even created
```

When one orphan message comes in, it wastes no model request, and it leaves no garbage on disk.

---

## Level 1: Persist a Large Tool Result by UTF-8 Bytes

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaFiad3ybIEQfzZnd92OXibH5vvEsrTWABkTQMsHqibQet6qsibyOErd2dDueaRniajYD5bhyfqpI8dfQYfjDph84ViabB5bSnSwUSEHc/640?from=appmsg&watermark=1#imgIndex=4)

### The input is "one whole turn", not one result

`CompactionManager.compactToolResults()` receives an array of `ToolResult` values for one whole turn that already finished executing. The shared Loop waits until all handlers and `PostToolUse` Hooks of this turn finish, then gives the whole batch of results to it.

Why must it be a whole batch? Because there are two different rules:

- **Single-item rule**: this result is too large by itself → persist it.
- **Batch rule**: no single item is large, but the total is too large → persist the largest few, until the rest fits the budget.

The batch rule must see all the results before it can compute. A per-item independent judgement cannot do it.

### The threshold counts real UTF-8 bytes

```typescript
const contentBytes = Buffer.from(result.content, "utf8");
const sizeBytes = contentBytes.byteLength;
```

Not `result.content.length`. This distinction matters a lot for Chinese: one Chinese character takes 3 bytes in UTF-8, so the `.length` of 10,001 Chinese characters is 10,001, but the `byteLength` is 30,003. Judging with `.length` makes the threshold three times larger in practice.

Default rules:

| Rule | Default value | Explanation |
| --- | ---: | --- |
| Single-item persist threshold | 30,000 bytes | Persist only when **strictly greater**. A value exactly equal stays in the message |
| Batch budget | 200,000 bytes | If the total of the non-persisted results is still greater, keep persisting in original-byte order from large to small |
| Head preview | 2,000 bytes | The opening fragment that stays in the message after persistence |
| Tail preview | 2,000 bytes | The closing fragment that stays in the message after persistence |
| Persist location | `.agent_tutorial/artifacts/tool-result-<id>.txt` | The complete content, byte for byte identical |

A dedicated test covers the "strictly greater" boundary:

```typescript
const manager = new CompactionManager({ ..., persistThresholdBytes: 6 });
const outcome = await manager.compactToolResults([toolSuccess("abcdef")]);   // exactly 6 bytes

expect(outcome.results).toEqual([toolSuccess("abcdef")]);   // kept unchanged
expect(outcome.artifacts).toEqual([]);                      // no artifact was produced
```

### How the batch budget picks

Lower the threshold, and measure once with four results (you can run this script yourself in "Five hands-on experiments"):

```text
Four result byte counts = [ 10, 50, 30, 10 ]
Total = 100
Single-item threshold = 100 (none exceeds it)   Batch budget = 60 (the total exceeds it by 40)

Persisted index = [ 1 ]
  [0] Stays in the message "AAAAAAAAAA"
  [1] Persisted
  [2] Stays in the message "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
  [3] Stays in the message "DDDDDDDDDD"
```

None of the four reaches the single-item threshold, but the total of 100 exceeds the budget of 60. So the code persists the largest one (index 1, 50 bytes). The remaining 50 bytes fit the budget, and the loop ends. **It persists only one item. It does not persist everything above the budget** — it stops when the budget is met.

The matching implementation sorts by size first, then adds items to the persist set one by one until the budget is met:

```typescript
for (const index of ranked) {           // ranked is sorted by byte count, large to small
  if (retainedBytes <= this.#batchBudgetBytes) {
    break;                              // Already within budget. Stop
  }
  if (selected.has(index)) { continue; }
  selected.add(index);
  retainedBytes -= sizes[index];
}
```

The sort uses `rightSize - leftSize || left - right`: when the byte counts are equal, sort by the original index, so the result is deterministic and reproducible.

### Why the preview truncates by byte, and why it loses characters

Note that the 2,000 preview limit is **bytes**, not characters. If the boundary falls exactly in the middle of a multi-byte character, that incomplete character is discarded.

Lower the preview limit, and measure value by value:

```text
previewHeadBytes=3 -> "甲"     actual 3 bytes / 1 character
previewHeadBytes=4 -> "甲"     actual 3 bytes / 1 character
previewHeadBytes=5 -> "甲"     actual 3 bytes / 1 character
previewHeadBytes=6 -> "甲乙"   actual 6 bytes / 2 characters
previewHeadBytes=7 -> "甲乙"   actual 6 bytes / 2 characters
```

With a 4-byte limit, the second character fits only 1 byte, so the whole character is dropped, and the output is actually only 3 bytes. **So the actual character count of a Chinese preview is usually less than "limit ÷ 3".**

The implementation uses a loop that tries at most 4 times — one UTF-8 code point takes at most 4 bytes, so dropping at most 3 bytes aligns the boundary:

```typescript
const decoder = new TextDecoder("utf-8", { fatal: true });
for (let offset = 0; offset <= Math.min(content.byteLength, 3); offset += 1) {
  const candidate = boundary === "head"
    ? content.subarray(0, content.byteLength - offset)   // Head: shave back from the tail
    : content.subarray(offset);                          // Tail: shave forward from the head
  try {
    return decoder.decode(candidate);
  } catch {
    // Keep shaving until it decodes
  }
}
```

`fatal: true` is the key: by default, `TextDecoder` turns incomplete bytes into the replacement character ``, and silently produces garbled text. Here the code chooses to throw, and then shaves the boundary actively.

### Three safety rules for writing the file

Writing an artifact is not a simple `writeFile`. It has three protection layers:

**1. Write a temporary file and sync it first, then publish the final path exclusively.**

```typescript
const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
handle = await open(temporary, "wx");     // wx = create exclusively; fail if it exists
await handle.writeFile(content);
await handle.sync();                      // Force a flush to disk
await handle.close();
await link(temporary, path);              // Publish by hard link; an existing target gives EEXIST
```

The final path appears only on success. You never see a half-written file. A duplicate ID fails with `EEXIST`, and becomes an `ArtifactConflictError`. It **never overwrites**.

**2. Recheck the real identity of the directory.** After `ensureSafeDirectory()` creates the directory, it runs `lstat()` and `realpath()` again, and rejects a symbolic link or a path that points outside the workspace. A test verified this with a junction that points to an external directory: persistence failed, and no file appeared in the external directory either.

**3. Clean up when the same batch fails in the middle.** The artifacts that this batch already created are deleted, so the state does not end up as half references and half original text:

```typescript
} catch (error) {
  await removeCreatedArtifacts(artifacts.map((a) => a.reference), error);
}
```

The return type of `removeCreatedArtifacts()` is `Promise<never>` — it always throws. When the cleanup itself fails, it throws an `AggregateError` that carries the original error and the cleanup error together. It hides neither one.

### What the Loop does after persistence fails

The Loop's `#processToolResults()` catches the error that `compactToolResults()` throws, and replaces the whole batch of results with a controlled error uniformly:

```typescript
} catch {
  return Object.freeze(
    calls.map(() => toolError("tool_result_processing_error", "Tool result processing failed")),
  );
}
```

Note the `calls.map()` — the result count after replacement still equals the call count, so the contract "exactly one result per call" still holds. The code replaces the whole batch uniformly instead of keeping part of it, so one turn never mixes original body text and persistence references. That mix would leave later troubleshooting unable to judge the state.

One more detail: when an error result is persisted, `isError` and `errorCode` must stay unchanged.

```typescript
if (original.isError) {
  const errorCode = original.errorCode;
  if (errorCode === undefined) {
    throw new CompactionError("error tool result lost its errorCode");
  }
  transformed[index] = Object.freeze({ content: rendered, isError: true, errorCode });
}
```

After an oversized error output (for example, a failed build log) is persisted, it **is still an error result**. If the code lost the `errorCode` here, the error classification that chapter 3 built would break.

---

## Level 2: snip Cuts the Middle by Group

`snipCompactHistory()` triggers only when the default message group count **exceeds** 50. After it triggers, it keeps:

```text
[ The first 3 complete groups ]
[ One system marker: [Compacted: N message groups omitted] ]
[ The last 46 complete groups ]
```

The code computes 46. It is not hard-coded:

```typescript
const keepTailGroups = maxGroups - keepHeadGroups - 1;   // 50 - 3 - 1 = 46
```

That `- 1` reserves the position of the omission marker itself. So the total group count after compaction equals `maxGroups` exactly.

### Why keep the first 3 groups

The head of the history usually holds the user's original request and the earliest key constraints. This information stays valid for the whole task. If you cut it, the model forgets what it is doing. Keeping 3 groups is an empirical value: enough to hold "the user's question + the first one or two explorations".

The middle is the part most likely to expire — the trial and error in between, the files that the Agent read and then found irrelevant, the wrong turns. The tail is the latest progress, and it must stay.

### It counts groups, not message counts

This point needs one more emphasis. A tool exchange group with two tool calls actually takes 3 messages, but in the snip budget it counts as only **1 group**, and it can only stay whole or be omitted whole.

One measurement (`maxGroups=3, keepHeadGroups=1`, so `keepTailGroups = 3-1-1 = 1`):

```text
Original: 7 messages / 4 groups:
  Group 0: user "start"
  Group 1: assistant(calls=2) + tool(a) + tool(b)
  Group 2: assistant(calls=1) + tool(c)
  Group 3: assistant "done"

After snip: 3 messages:
  [0] user      "start"
  [1] system    "[Compacted: 2 message groups omitted]"
  [2] assistant "done"

bytes: 642 → 143
```

Groups 1 and 2 are omitted whole, and the number in the marker is exactly 2. **No orphan `tool` message appears** — this is the direct benefit of slicing by group.

The algorithm for the number in the marker is:

```typescript
const omitted = groups.length - keepHeadGroups - keepTailGroups;   // 4 - 1 - 1 = 2
```

It also counts groups, so the marker says "2 message groups omitted", while the messages actually saved are 5. This wording is deliberate: it tells the model "something was taken away", and it does not give it a message count that would mislead it.

### Configuration validation

`validateSnipConfiguration()` rejects three unreasonable configurations:

```typescript
requirePositiveInteger("maxGroups", maxGroups);
requirePositiveInteger("keepHeadGroups", keepHeadGroups);
if (maxGroups < 3) {
  throw new RangeError("maxGroups must leave room for head, marker, and tail groups");
}
if (keepHeadGroups > maxGroups - 2) {
  throw new RangeError("keepHeadGroups must leave room for marker and tail groups");
}
```

`maxGroups` must at least hold the three parts "head + marker + tail". `keepHeadGroups` cannot eat the positions of the marker and the tail. These validations run at construction time. They do not wait until run time to explode.

---

## Level 3: micro Downgrades Only Old Tool Results

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaHibxNmOfSEomAhqhzHBNm5aXSfyFSXgH6uEz3azPEHjibnRTaF1mbGkCa3aDhBYKmYvuECftNU44XXFMO1ZuW8GjNCPTmbIh2B8/640?from=appmsg&watermark=1#imgIndex=6)

By default, `microCompactHistory()` keeps the **most recent 3 tool exchange groups** complete. In an earlier tool group, it replaces all result content with:

```text
[Earlier tool result compacted. Re-run if needed.]
```

The `Re-run if needed` in this sentence is a hint to the model: the content is gone, but you can call the tool again to get it back.

### What it keeps, and what it replaces

| Element | After micro |
| --- | --- |
| The `tool_calls` of the assistant | **Kept complete**, including the tool name and the arguments |
| `tool_call_id` | **Kept complete**. The pairing relation does not change |
| The content of a tool result | Replaced with the placeholder |
| Message count | Unchanged |

Why keep the call and replace only the result? Because the fact "I called `read_file('config.json')`" is itself valuable — the model knows what it did, and it can call again when needed. The 500 lines of JSON that the call returned may no longer be needed at all.

One measurement (`keepRecentToolGroups=1`):

```text
  [0] user             "start"
  [1] assistant calls=2 null
  [2] tool(a)          "[Earlier tool result compacted. Re-run if needed.]"
  [3] tool(b)          "[Earlier tool result compacted. Re-run if needed.]"
  [4] assistant calls=1 null
  [5] tool(c)          "Content of C"        ← the most recent 1 group, kept complete
  [6] assistant        "done"
```

Note `[2]` and `[3]`: the two calls that one assistant issued have their results replaced **together**. If you replaced only one of them, the whole atomic group would sit in a half-compacted state, and its semantics would be hard to explain.

### One honest observation: micro sometimes makes the history longer

The byte counts of the measurement above are:

```text
Before micro: 642 bytes
After micro: 720 bytes    ← 78 bytes longer
```

The reason is direct: the original result is `"Content of A"` (about 10 bytes), and the placeholder is an English sentence of 49 characters. **When the original result is shorter than the placeholder, the replacement increases the byte count.**

This is not a bug. It is the necessary result of the threshold design. The design target of micro is tool output of a few KB to a few tens of KB. At that scale, a 49-byte placeholder is negligible. The example grows longer only because its results are too short.

Understanding this point matters for reading the code: **the current implementation has no branch of the form "replace only when the result exceeds N characters".** As long as a tool group sits before the most recent 3 groups, its results are replaced.

```typescript
const compactCount = Math.max(0, toolGroupIndices.length - keepRecentToolGroups);
if (compactCount === 0) {
  return snapshot;
}
const compactedIndices = new Set(toolGroupIndices.slice(0, compactCount));
```

This trade-off buys two benefits: the rule is simple enough to state in one sentence, and the result is fully deterministic — the same input always gives the same output. That determinism is a necessary condition for the cache judgement in the next section.

### The execution order of snip and micro

The order in `prepare()` is fixed:

```typescript
prepared = snipCompactHistory(prepared, { ... });     // snip first
prepared = microCompactHistory(prepared, { ... });    // micro second
```

Snip before micro is cheaper: snip may drop some tool groups whole, and those groups then do not need the micro replacement logic. In the reverse order, micro would do useless work on groups that are about to be dropped.

Both generate their result from a new immutable array snapshot. **Neither modifies the history passed in, in place.** After each step, the code runs `validateToolPairing()` again.

---

## Level 4: Call the Summary Model Only Above 50,000 Bytes

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaFEOEbHS6NMSiclbbIS5PTqdhGtH29icOhmKPoeP4vw15GIXtlF7zV4X3xugZY3ZhqIniaj0iapXxkVfOlQLAQgTVMknibroicUzVC30/640?from=appmsg&watermark=1#imgIndex=8)

After the first three levels, `historyUtf8Bytes()` converts the request snapshot to canonical OpenAI JSONL, then computes the encoded UTF-8 bytes. By default, only when the result is **greater than** 50,000 bytes does the flow enter the model summary.

### What does this threshold actually measure?

It is **not**:

- The `length` of a JavaScript string;
- The sum of the tool body lengths;
- The token count from a model tokenizer;
- The context window size that a model vendor promises.

It is a **deterministic byte budget** that the current implementation chose. It includes the role, `tool_calls`, `tool_call_id`, JSON punctuation, and line breaks after serialization. A test writes this algorithm out in full:

```typescript
const history = [userMessage("甲"), ...exchange("call-1", "乙")];
const expected =
  `${JSON.stringify({ content: "甲", role: "user" })}\n` +
  `${JSON.stringify({ content: null, role: "assistant", tool_calls: [...] })}\n` +
  `${JSON.stringify({ content: "乙", role: "tool", tool_call_id: "call-1" })}\n`;

expect(historyUtf8Bytes(history)).toBe(Buffer.byteLength(expected, "utf8"));
```

In other words, two messages of only 1 Chinese character each produce a byte count far greater than 6 — because the JSON structure itself takes the majority. This is deliberate: the model request really does transmit this JSON, so measuring it is meaningful.

Why not use an exact token count? Because that needs a tokenizer dependency, and different models have different tokenizers. A byte budget triggers compaction stably. Its cost is that **it cannot guarantee that 50,000 bytes correspond to the same token count for every model**. This is an explicit teaching trade-off, not an oversight.

### The five steps into level 4, and why the order matters

```text
1. First write the "canonical snapshot that has not passed through snip / micro / summary" as a transcript
2. Then let the summarizer read the "request history that the cheap levels already processed"
3. The summary model request carries no tools
4. Accept only a JSON object with finishReason === "stop", no toolCalls, non-empty, and exact fields
5. On success, the request history becomes one system message, with the transcript path and five classes of information
```

Steps 1 and 2 use **two different histories**. This is the easiest place to miss:

```typescript
const transcript = await this.#writeArtifact("transcript", ".jsonl",
  serializeTranscript(transcriptHistory));           // ← canonical, complete
const compactedSummary = await this.#summarizer.summarize(summaryHistory);   // ← already compacted
```

Why split them? Because their purposes differ: the transcript is an archive for human troubleshooting, and it must be complete. The summary input is for the model to read, and shorter means cheaper.

The order "write the transcript first, call the summary second" is also deliberate. A test pins both directions:

```typescript
// The summary fails, and the transcript still remains
await expect(manager.compactProactively([userMessage("unchanged")])).rejects.toThrow(/summary failed/);
expect(await readFile(".../transcript-failed-summary.jsonl", "utf8")).toContain("unchanged");

// The transcript write fails, and the summary model is never called
await expect(manager.compactProactively(history)).rejects.toThrow(ArtifactPathError);
expect(summarizer.histories).toEqual([]);
```

In one sentence: **rather leave an archive that goes unused than reach the state "the history was compacted but the scene was never saved".**

### The five fields of the summary

```text
current_goal            the current goal (a non-empty string)
key_findings            key findings (an array of strings)
files_read_or_changed   files read or changed (an array of strings)
remaining_work          remaining work (an array of strings)
user_constraints        user constraints (an array of strings)
```

The request history after one measured summary (the threshold was lowered to 800 bytes to trigger it):

```text
canonical bytes = 1029 > threshold 800

prepare #1: summary call count = 1  request history count = 1
Request history item 0 role = system
{
  "current_goal": "Summarise the Markdown files in the current directory",
  "files_read_or_changed": ["README.md"],
  "key_findings": ["README describes how to run it"],
  "kind": "compacted_history",
  "remaining_work": ["Verify the commands"],
  "transcript_path": ".agent_tutorial/artifacts/transcript-probe-1.jsonl",
  "user_constraints": ["Examples use PowerShell only"]
}
```

A whole history segment became one system message. Note the two extra fields: `kind` marks this as a compaction summary, and `transcript_path` tells the model (and you) where the complete record is.

### The summary output is an untrusted boundary

The output of the model must be validated strictly. `parseCompactionSummary()` uses **exact equality of the field set**, not "contains the required fields":

```typescript
const expected = ["current_goal", "files_read_or_changed", "key_findings",
                  "remaining_work", "user_constraints"];
if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    Object.keys(payload).sort().join("\0") !== expected.join("\0")) {
  throw new CompactionError("summary model output must contain the exact fields");
}
```

One extra field means rejection. This looks excessively strict, but the reason is practical: the summary replaces a large segment of real history. If the model adds a field on its own initiative, it did not obey the contract strictly, so its other fields are not necessarily trustworthy either. Rather let this summary fail (canonical history does not change, and the next turn retries) than accept a summary that may have a problem.

A `test.each` covers the first four rejection cases one by one. The fifth has only an implementation and no test:

| What the model returned | Rejection reason | Has a test? |
| --- | --- | --- |
| With `tool_calls` | `must not call tools` — the summary request gave no tools, and it must not call any | Yes |
| `finishReason: "length"` | `finishReason must be stop` — the output was truncated, and the JSON is incomplete | Yes |
| One extra `extra: true` field | `exact fields` — the field set does not match exactly | Yes |
| `key_findings: [" "]` | `invalid values` — an array item cannot be a blank string | Yes |
| Not valid JSON | `not valid JSON` (line 683 of `compaction.ts`) | **No**. This is a current test gap |

There is one more type safeguard:

```typescript
const compactedSummary: unknown = await this.#summarizer.summarize(summaryHistory);
if (!(compactedSummary instanceof CompactionSummary)) {
  throw new TypeError("summarizer must return CompactionSummary");
}
```

Even if someone implements the `HistorySummarizer` interface themselves and returns a plain object with a similar shape, it does not pass. The summary must be a `CompactionSummary` instance that the constructor validated.

### Automatic summary keeps no tail messages

When `prepare()` reaches level 4, the `keepTailGroups` it passes is 0:

```typescript
const outcome = await this.#compactValidated(snapshot, prepared, 0);
```

So after an automatic summary, the request history holds only that one system message. **It does not append the most recent messages.**

Keeping the most recent complete groups is the separate behavior of the reactive recovery API (`compactOnPromptTooLong`), which keeps 5 groups by default. Do not confuse the two — this is an easy point to mix up when you read the code.

---

## What Does the transcript Actually Save?

The transcript sits at `.agent_tutorial/artifacts/transcript-<id>.jsonl`. Each line is one internal `ChatMessage` converted to the OpenAI wire shape as canonical JSON. It uses UTF-8, keeps Chinese text, and ends with a line break.

It saves the **canonical history snapshot from before the model summary happened**, not the request history that already passed through snip / micro. So you can restore the message sequence "from before request-level compaction".

### But it is not a full backup

This is the easiest place to misunderstand. A body that exceeds the tool result threshold was written into a separate tool-result artifact before it entered canonical history. The transcript records that artifact's **path and preview**.

```text
transcript-abc.jsonl
  {"content":"Read the large file","role":"user"}
  {"content":null,"role":"assistant","tool_calls":[...]}
  {"content":"<persisted-tool-result>\npath: .agent_tutorial/artifacts/tool-result-xyz.txt\n...","role":"tool","tool_call_id":"call-1"}
                                              ↑
                              The complete body is in this file, not in the transcript
```

To restore the complete scene, you must **keep both the transcript and the artifact files that it references**.

### Stable JSON: an inconspicuous but key design

`serializeTranscript()` uses stable JSON with sorted keys:

```typescript
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map((item) => sortJson(item)); }
  if (typeof value !== "object" || value === null) { return value; }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
```

So a history with the same content produces **byte-for-byte identical** text, no matter in which order the fields were created. This brings two benefits:

1. `historyUtf8Bytes()` and the transcript use the same serialization, so the threshold judgement and the archive never compute two different byte counts.
2. `historiesEqual()` and `historyStartsWith()` can reliably identify the two cache cases "completely identical" and "pure append" — the next section uses them immediately.

Without key sorting, `{"role":"user","content":"x"}` and `{"content":"x","role":"user"}` would be judged as different histories, and the cache would fail at once.

### An ID conflict does not overwrite

The default ID is a UUID (with the hyphens removed), and the file is created by exclusive publish. If the generator gives a duplicate ID, the second write fails explicitly:

```typescript
const manager = new CompactionManager({ ..., idGenerator: idGenerator("same", "same") });
const first = await manager.compactProactively([userMessage("first")]);

await expect(manager.compactProactively([userMessage("second")]))
  .rejects.toThrow(ArtifactConflictError);

expect(await readFile(first.transcript.path, "utf8")).toBe(before);   // The first copy was not touched
expect(summarizer.histories).toEqual([[userMessage("first")]]);       // The summary model was not called a second time
```

The first transcript is intact, and the summary model was not called in vain.

---

## The Cache: an Identical History Is Not Compacted Twice, a Pure Append Reuses the Prefix

`CompactionManager` keeps the most recent `#preparedSource` (the canonical snapshot before compaction) and `#preparedHistory` (the request history after compaction) inside the current Agent instance.

It handles three cases separately:

| Case | What it does |
| --- | --- |
| The canonical snapshot is **completely identical** | Return the request history prepared last time directly. No snip / micro / transcript write / summary call |
| The new history is a **pure append** of the old history | Reuse the compacted prefix, append only the new suffix, then run the bounded check again |
| The two are **not** in an append relation | Prepare completely again from the current canonical snapshot |

The matching implementation:

```typescript
if (cachedSource !== undefined && cachedHistory !== undefined &&
    historiesEqual(snapshot, cachedSource)) {
  return cachedHistory;                                    // Case one: return directly
}

let prepared: readonly ChatMessage[] = snapshot;
if (cachedSource !== undefined && cachedHistory !== undefined &&
    snapshot.length > cachedSource.length &&
    historyStartsWith(snapshot, cachedSource)) {
  prepared = Object.freeze([...cachedHistory, ...snapshot.slice(cachedSource.length)]);
}                                                          // Case two: compacted prefix + new suffix
```

Three consecutive measured calls (the threshold is set to 800 bytes, so the first call triggers a summary):

```text
canonical bytes = 1029 > threshold 800

prepare #1:                    summary call count = 1   request history count = 1
prepare #2 (identical content): summary call count = 1   is it the same object = true
prepare #3 (pure append of one message): summary call count = 1   count = 2
Is it "compacted prefix + new message" = true  The latest answer

Was canonical rewritten = No (it is still 1 message of 1000 characters)
```

Three calls, and the summary model was called only **1 time**. The second call returns even the same object reference (`=== true`). The third call is "the summary from last time + the newly appended message".

### On re-compaction, the two histories part ways again

If the appended content makes the request exceed the threshold again, one thing worth noting happens. Look at the assertions of this test:

```typescript
expect(summarizer.histories).toEqual([firstCanonical, [...firstPrepared, appended]]);
//                                     ↑ first time        ↑ second time: cached prefix + new suffix

// But the transcript holds the complete canonical
expect(transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
  { content: "x".repeat(1_000), role: "user" },        // The complete first segment
  { content: "y".repeat(1_000), role: "assistant" },   // The complete second segment
]);
```

At the second summary, the summarizer sees "the cached compacted prefix + the new suffix" — this avoids sending the old long history into the summary model again and again. But the transcript written this time still comes from the **complete new canonical history**.

In one sentence: **the saving is on the summary input, not on the archive.**

### The boundary of the cache

The cache exists only inside this `CompactionManager` instance:

- It does not cross processes — a restart loses it.
- It is not persisted to disk.
- It does not cross Agent instances — a subagent has its own history, and so its own preparation process.

It optimises the request preparation cost. **It is not another source of session facts.** Canonical history is always the single source of truth.

---

## The Proactive Compaction API Is Not a `compact` Tool

`CompactionManager.compactProactively()` provides an independent API: the caller can explicitly request "save the complete transcript first, then turn the given history into a structured summary".

It has one clear difference from `prepare()`: **it does not pass through snip and micro**. It summarises the history passed in directly.

```typescript
async compactProactively(history: readonly ChatMessage[]): Promise<HistoryCompactionOutcome> {
  const { snapshot } = validatedGroups(history);
  return this.#compactValidated(snapshot, snapshot, 0);   // Both arguments are the snapshot
}
```

Focused tests cover four paths: success, summary failure, write failure, and ID conflict.

**But the current P08 tool registry has no `compact` tool**, and the model cannot call it proactively inside a conversation. The tool list assertion in the section "Look at one real compaction first" already proved this: still the 8 tools from chapter 7.

What P08 adds over P07 is the two runtime capability bits ARTIFACTS / COMPACTION, not a new tool name:

```typescript
export const P08: ChapterProfile = Object.freeze({
  chapter: 8,
  capabilities: new CapabilitySet([
    "loop", "powershell", "tool_registry", "files", "policy",
    "hooks", "todo", "subagent", "skills",
    "artifacts", "compaction",              // ← the two bits added in this chapter
  ]),
});
```

What actually connects to the Loop is the `prepare()` that runs automatically before each request, and the whole-batch tool result processor.

Therefore, the following statement does **not** match the current implementation:

> ❌ "When the model feels that the context is almost full, it calls the compact tool."

What the current code can guarantee is: automatic request-level compaction, plus a proactive compaction API that outer code can call.

---

## prompt-too-long: the Recovery Primitive Exists, the Loop Signal Does Not Yet

`compactOnPromptTooLong(history, { retryCount: 0 })` is an independent reactive recovery primitive. It:

- Saves the complete transcript of the history passed in;
- Generates a structured summary;
- **Keeps the most recent 5 complete message groups** after the summary (this is its key difference from the automatic summary);
- Throws a `PromptTooLongRetryError` when `retryCount > 0`, and blocks a second compaction in the same recovery window.

A test pins both "keep the tail" and "allow only once":

```typescript
const outcome = await manager.compactOnPromptTooLong(history, { retryCount: 0 });
expect(outcome.history.slice(1)).toEqual([                  // Item 0 is the summary
  systemMessage("middle"), ...exchange("recent", "data"),   // After it, the kept most recent 2 groups
]);

await expect(manager.compactOnPromptTooLong(history, { retryCount: 1 }))
  .rejects.toThrow(PromptTooLongRetryError);                // A second attempt in the same window is rejected
```

Why allow compaction only once? Because if the request is **still** too long after compaction, compacting again usually does not help — the real cause may be that one single message itself exceeds the window, or that the summary did not actually shorten the history. Infinite retries at that point only burn money. Let it fail explicitly, and give the decision back to the upper layer.

### But the P08 Loop does not receive this signal yet

**The current P08 `AgentRunner` does not yet connect to a vendor-neutral "input prompt too long" error signal.** In other words, the P08 Loop does not call this method automatically.

It needs a future model error classification boundary to first confirm "this request was rejected because the input is too long", and then give the explicit retry count to the recovery primitive.

### Never treat `finishReason === "length"` as prompt-too-long

These are two completely different signals:

| Signal | Meaning | Current P08 behavior |
| --- | --- | --- |
| `finishReason === "length"` | The model **accepted** the request, but the **output** reached the generation limit, and the reply is incomplete | `AgentRunner` throws an `IncompleteModelReplyError`, and does no reactive compaction |
| Input prompt-too-long | The **input context** of the request is rejected by the vendor, and the model never started generating | P08 has no unified typed signal yet, and no automatic recovery wiring |
| `compactOnPromptTooLong(..., { retryCount: 0 })` | The recovery primitive that is available after the caller completes the error classification | Testable alone. It allows only one attempt in the current recovery window |

The consequence of confusing the two is practical: when the output is truncated, you compact the input. That does not solve the problem, and it throws context away in vain.

You also cannot fake a generic signal by checking whether the exception string contains `prompt_too_long` or `too many tokens`. The exception types, status codes, and response bodies of different OpenAI-compatible endpoints are not consistent. String matching may work today and fail tomorrow. **Error classification belongs in the model adapter or the recovery layer.** That is the topic of chapter 11.

This boundary explains why the chapter 8 tests can directly prove "a second reactive compaction is rejected", but cannot claim from that proof that the real P08 Agent Loop already handles an over-long input automatically.

---

## Prove the Behavior with Offline Tests

`npm run test:ch08` runs all the tests accumulated from chapters 1 to 8. The current result:

```text
 Test Files  21 passed (21)
      Tests  174 passed (174)
```

Three new files relate directly to this chapter, with 31 tests in total:

| File | Test count | What it covers |
| --- | ---: | --- |
| `chapters/ch08/tests/compaction.test.ts` | 23 | The summary contract, the persistence budget, message group trimming, transcript and cache |
| `chapters/ch08/tests/loop-processors.test.ts` | 7 | The two wiring points themselves: whole-batch result processing, the controlled error on failure, request history replacement without polluting canonical |
| `chapters/ch08/tests/ch08-compaction.test.ts` | 1 | Assemble the full Agent and run it once, and see what stays in the message after a large result is persisted |

The 23 tests in `compaction.test.ts` split into four `describe` groups (4 of them are `rejects ...` cases from one `test.each`). The names themselves are a contract list:

```text
model-backed history summarizer
  sends a tool-free request and accepts only the five-field JSON contract
  rejects tool calls
  rejects a non-stop finish reason
  rejects an extra field
  rejects an empty array item

tool-result artifact budgeting
  persists values above the strict UTF-8 threshold and keeps bounded previews
  keeps a value exactly at the threshold inline
  persists the largest remaining value first and preserves error metadata
  never overwrites an existing artifact and removes earlier files from the failed batch
  rejects unsafe IDs and artifact directory setup failures without changing input
  rejects a state-directory junction that escapes the workspace

atomic message-group compaction
  micro compaction replaces every old result but keeps recent exchanges intact
  snip compaction removes whole groups and inserts an exact omission marker
  counts canonical OpenAI JSONL bytes including non-ASCII UTF-8 and the final newline

final history compaction
  persists the full transcript before replacing history with one structured summary
  keeps the transcript when summarization fails
  reactive compaction runs once per retry window and retains recent complete groups
  prepare caches semantic equality, reuses a compressed prefix, and leaves canonical input intact
  prepare summarizes once, caches equal history, and appends to the compressed prefix
  recompaction summarizes the cached prefix but transcribes the full canonical history
  a transcript collision never overwrites or invokes the summarizer again
  a transcript directory failure leaves history unchanged and skips summarization
  validates pairing before any transcript write or summary call
```

Check them against the acceptance contract one by one:

| Acceptance contract | Pinned by which test |
| --- | --- |
| 1 Real UTF-8 bytes; a value equal to the threshold is not persisted | `keeps a value exactly at the threshold inline` |
| 2 Trim by complete message group | `snip compaction removes whole groups...` + `micro compaction replaces every old result...` |
| 3 Does not rewrite canonical history | `prepare caches semantic equality, reuses a compressed prefix, and leaves canonical input intact` |
| 4 Write the transcript first, then summarise | `keeps the transcript when summarization fails` + `a transcript directory failure leaves history unchanged and skips summarization` |
| 5 Exclusive publish, no overwrite | `a transcript collision never overwrites or invokes the summarizer again` |
| 6 On persistence failure, replace the whole batch with a controlled error | In `loop-processors.test.ts`, `pairs every call with a controlled error when the processor %s` (3 variants: throws an exception / wrong count / invalid result). The cleanup of artifacts already created in the batch is covered by `never overwrites an existing artifact and removes earlier files from the failed batch` |
| 7 Identical and pure-append histories reuse the cache | `prepare summarizes once, caches equal history, and appends to the compressed prefix` |

The other 4 tests in `loop-processors.test.ts` pin the remaining wiring boundaries: a whole batch of results passes through the processor before it is written back; when `PostToolUse` stops early, the returned result is the **processed** one; the output of the `historyProcessor` enters the request only, not canonical; and when a processor returns an orphan history, it fails **before** the model is called.

`profiles.test.ts` also pins that `ch08` maps fixedly to `P08`, asserts the capability bit sequence of `P08`, and asserts that `profileForChapter(9)` still throws `not been migrated`.

### What offline tests can prove, and what they cannot

| Metric type | Offline test coverage | Verification boundary |
| --- | --- | --- |
| Mechanism metrics | Threshold judgement, group boundaries, the pairing invariant, path safety, cache hits, error propagation | Deterministic, repeatable offline |
| Goal metrics | After compaction, can the model still complete the task correctly? Is the summary quality sufficient? | Needs real model trajectories and human acceptance. Offline tests promise nothing |

So "all tests pass" proves only that the compaction mechanism behaves correctly at every boundary. It does **not** prove that the model still knows what to do after a summary — that depends on the summary quality, and it needs a separate evaluation with real task trajectories.

---

## Run Chapter 8

### Step 0: prepare the environment

```powershell
Set-Location 'F:\笔记\Agent实操\code'
node --version      # Needs Node 20 or above
npm install         # Run only the first time, or after the dependencies change
```

### Step 1: run the offline tests first (no API Key needed)

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch08
```

Expect to see `Test Files 21 passed (21)` and `Tests 174 passed (174)`.

One line appears in the middle of the output:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**This is not an error.** It is an expected output that `config.test.ts` asserts actively — the test verifies "when the configuration is missing, the program must report an error explicitly instead of degrading silently". As long as the last line is `passed`, everything is normal.

### Step 2: create a file that is large enough

The default threshold is 30,000 bytes, so you need a file above it. Chinese counts as 3 bytes per character, so 10,001 characters are enough:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
('甲' * 10001) | Set-Content -LiteralPath '.\large-demo.txt' -Encoding utf8NoBOM

# Confirm the byte count
(Get-Item '.\large-demo.txt').Length
```

Expect to see about `30003` (if you use `-Encoding utf8` with a BOM, it adds 3 bytes. The conclusion does not change).

PowerShell 5.1 has no `utf8NoBOM`. Use `-Encoding utf8`.

### Step 3: let the Agent read it, and observe the persistence

This step needs a real model. First confirm that `code\.env` has `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` set.

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch08 -- --prompt "Read large-demo.txt and tell me its content characteristics"
```

The Hook log prints in this order:

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: read_file
[Permission] read_file: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: read_file -> ok
[Hook] Stop
```

Note that `PostToolUse` comes first, and **persistence happens after it**, so the log does not show the persistence step — it is not a tool call, and it does not trigger a Hook.

### Step 4: find that artifact on disk

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Get-ChildItem '.\.agent_tutorial\artifacts\' | Format-Table Name, Length
```

Expect to see something like:

```text
Name                                              Length
----                                              ------
tool-result-3f9a1c72e8b04d5f9c1e7a2b6d8f0e41.txt   30003
```

`Length` should match the original file byte count. Verify that the content really is complete:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
$artifact = Get-ChildItem '.\.agent_tutorial\artifacts\tool-result-*.txt' | Select-Object -First 1
(Get-Content -LiteralPath $artifact.FullName -Raw).Length
```

Expect `10001` (the character count).

### Step 5: the unified entry

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 8 --prompt "Read a large file and summarise it, and observe the path and preview after the complete result is persisted"
```

The two entries are equivalent. `ch08` is the chapter-specific script, and `agent-tutorial` is the unified CLI.

### Step 6 (optional): the full gates

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run typecheck
npm run lint
```

### Cleanup

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item -LiteralPath '.\large-demo.txt' -Force
Remove-Item -Recurse -Force '.\.agent_tutorial\artifacts'
```

The artifact directory currently has **no automatic cleanup**. Run it many times and it keeps accumulating. You must delete it by hand — this is one of the explicit boundaries of this chapter.

### Troubleshooting common errors

| What you see | Cause | What to do |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` (in the middle of the `npm run test:ch08` output) | This is the expected output that `config.test.ts` asserts | Ignore it. Check whether the last line is `passed` |
| `Configuration Error: Missing required settings: ...` (exits directly after `npm run ch08`) | `code\.env` is not set | Copy `.env.example` to `.env` and fill in the three values |
| Nothing in the artifacts directory | The file is not large enough. It did not trigger the 30,000-byte threshold | Create the file again with the step 2 command, and confirm that `Length` exceeds 30000 |
| No `<persisted-tool-result>` in the message | Same as above, or the model did not really read that file | Check whether the Hook log has `PreToolUse: read_file` |
| `ArtifactPathError: artifact directory could not be created` | `.agent_tutorial` was created as a file, or the permission is insufficient | Delete that same-named file. Check the directory permissions |
| `ArtifactPathError: artifact directory escapes workspace` | `.agent_tutorial` or `artifacts` was replaced with a symbolic link / junction | Delete the link, and let the runtime create a real directory itself |
| `ArtifactConflictError: artifact already exists` | A duplicate ID (you meet this only with a custom `idGenerator`) | Normal protection behavior. Check your ID generation logic |
| A `tool_result_processing_error` appears in a tool result | The whole persistence batch failed (disk full, permission, path replaced) | Use the rows above to check the disk and directory state |
| `CompactionError: summary model must not call tools` | The summary model misbehaves and returns a tool call | Switch the model, or check whether you passed the tool definitions by mistake |
| `CompactionError: summary model output must contain the exact fields` | The summary model gave one field too many or too few | A normal interception. This turn's compaction fails, and canonical is not affected |
| `IncompleteModelReplyError: Model output reached the token limit` | The **output** was truncated. This is not an over-long input | Raise `max_tokens`. Do not compact the input |

---

## Five Hands-on Experiments

None of these five experiments calls a real model. After you run them, you can see all the core numbers of this chapter. First create a temporary script directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType Directory -Force '.\scratch' | Out-Null
```

All five scripts need the same boilerplate (a summarizer that is never called). Look at the full form in the first one. The later ones list only the key parts.

**Experiment 1: see exactly what stays in the message after persistence**

Save it as `code\scratch\probe1-persist.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompactionManager } from "../chapters/ch08/src/features/compaction.js";
import type { CompactionSummary, HistorySummarizer } from "../chapters/ch08/src/features/compaction.js";
import type { ChatMessage } from "../chapters/ch08/src/core/messages.js";
import { toolSuccess } from "../chapters/ch08/src/core/tools.js";

class NeverSummarizer implements HistorySummarizer {
  async summarize(_history: readonly ChatMessage[]): Promise<CompactionSummary> {
    throw new Error("summarizer should not be called in this probe");
  }
}

const workspace = mkdtempSync(join(tmpdir(), "probe1-"));
const manager = new CompactionManager({
  workspace,
  summarizer: new NeverSummarizer(),
  persistThresholdBytes: 30,     // Lower the threshold from 30000 to 30, for easy observation
  batchBudgetBytes: 1_000,
  previewHeadBytes: 6,
  previewTailBytes: 6,
});

const big = "甲乙丙丁戊己庚辛壬癸子丑寅卯";   // 14 Chinese characters = 42 bytes
console.log("Original bytes =", Buffer.byteLength(big, "utf8"));

const outcome = await manager.compactToolResults([toolSuccess(big)]);
console.log("--- What stays in the message ---");
console.log(outcome.results[0]?.content);
console.log("--- artifact ---");
console.log("relativePath =", outcome.artifacts[0]?.reference.relativePath);
console.log("originalBytes =", outcome.artifacts[0]?.reference.originalBytes);

rmSync(workspace, { recursive: true, force: true });
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe1-persist.ts
```

Actual output:

```text
Original bytes = 42
--- What stays in the message ---
<persisted-tool-result>
path: .agent_tutorial/artifacts/tool-result-6ffe1a8402154a04a550467a792efb41.txt
original_bytes: 42
head_preview:
甲乙
tail_preview:
寅卯
</persisted-tool-result>
--- artifact ---
relativePath = .agent_tutorial/artifacts/tool-result-6ffe1a8402154a04a550467a792efb41.txt
originalBytes = 42
```

`previewHeadBytes: 6` gives 2 Chinese characters, exactly 6 bytes. The hexadecimal string in the file name is a random UUID. **What you get when you run it will differ from here.** That is normal.

**Note that `path` is a relative path** — the absolute path stays only in the internal `reference.path`. It does not enter the model context, so it cannot leak the local directory structure.

**Experiment 2: the preview byte boundary loses characters**

Try `previewHeadBytes` from 3 to 7 once each, and set `previewTailBytes` to 0:

```typescript
for (const limit of [3, 4, 5, 6, 7]) {
  const manager = new CompactionManager({
    workspace, summarizer: new NeverSummarizer(),
    persistThresholdBytes: 10, batchBudgetBytes: 1_000,
    previewHeadBytes: limit, previewTailBytes: 0,
  });
  const outcome = await manager.compactToolResults([toolSuccess("甲乙丙丁戊己庚辛壬癸")]);
  const head = /^head_preview:\n([\s\S]*)\ntail_preview:/m.exec(outcome.results[0]?.content ?? "")?.[1];
  console.log(`previewHeadBytes=${limit} -> ${JSON.stringify(head)}  actual ${Buffer.byteLength(head ?? "", "utf8")} bytes`);
}
```

Actual output:

```text
previewHeadBytes=3 -> "甲"    actual 3 bytes
previewHeadBytes=4 -> "甲"    actual 3 bytes
previewHeadBytes=5 -> "甲"    actual 3 bytes
previewHeadBytes=6 -> "甲乙"  actual 6 bytes
previewHeadBytes=7 -> "甲乙"  actual 6 bytes
```

The values 4, 5, and 7 all "waste" bytes — because the next complete character does not fit. **When you compute the preview capacity for Chinese content, round down at 3 bytes per character.**

**Experiment 3: how the batch budget picks the persistence targets**

```typescript
const results = [
  toolSuccess("A".repeat(10)), toolSuccess("B".repeat(50)),
  toolSuccess("C".repeat(30)), toolSuccess("D".repeat(10)),
];
console.log("Four result byte counts =", results.map((r) => Buffer.byteLength(r.content, "utf8")));
console.log("Total =", results.reduce((sum, r) => sum + Buffer.byteLength(r.content, "utf8"), 0));

const manager = new CompactionManager({
  workspace, summarizer: new NeverSummarizer(),
  persistThresholdBytes: 100,   // No single item exceeds it
  batchBudgetBytes: 60,         // But the total of 100 exceeds it
});
const outcome = await manager.compactToolResults(results);
console.log("Persisted indexes =", outcome.artifacts.map((a) => a.resultIndex));

outcome.results.forEach((r, i) => {
  const persisted = r.content.startsWith("<persisted-tool-result>");
  console.log(`  [${i}] ${persisted ? "persisted" : "stays in the message"} ${persisted ? "" : JSON.stringify(r.content)}`);
});
```

Actual output:

```text
Four result byte counts = [ 10, 50, 30, 10 ]
Total = 100
Persisted indexes = [ 1 ]
  [0] Stays in the message "AAAAAAAAAA"
  [1] Persisted
  [2] Stays in the message "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
  [3] Stays in the message "DDDDDDDDDD"
```

Only the largest one is persisted. **Stop when the budget is met. Do no extra disk writes.**

**Experiment 4: one assistant with two calls — how snip and micro each cut**

```typescript
const history: ChatMessage[] = [
  userMessage("start"),
  assistantMessage(null, [
    toolCall("a", "read_file", '{"path":"a.txt"}'),
    toolCall("b", "read_file", '{"path":"b.txt"}'),
  ]),
  toolMessage("Content of A", "a"),
  toolMessage("Content of B", "b"),
  assistantMessage(null, [toolCall("c", "read_file", '{"path":"c.txt"}')]),
  toolMessage("Content of C", "c"),
  assistantMessage("done"),
];
console.log("Original count =", history.length, " bytes =", historyUtf8Bytes(history));

const micro = microCompactHistory(history, { keepRecentToolGroups: 1 });
const snip = snipCompactHistory(history, { maxGroups: 3, keepHeadGroups: 1 });
```

Actual output:

```text
Original message count = 7
Original bytes  = 642

--- micro (keepRecentToolGroups=1) ---
  [0] user             "start"
  [1] assistant calls=2 null
  [2] tool(a)          "[Earlier tool result compacted. Re-run if needed.]"
  [3] tool(b)          "[Earlier tool result compacted. Re-run if needed.]"
  [4] assistant calls=1 null
  [5] tool(c)          "Content of C"
  [6] assistant        "done"
After micro: count = 7  bytes = 720

--- snip (maxGroups=3, keepHeadGroups=1) ---
  [0] user      "start"
  [1] system    "[Compacted: 2 message groups omitted]"
  [2] assistant "done"
After snip: count = 3  bytes = 143
```

Three conclusions are clear at once:

1. Micro keeps the message count unchanged and replaces only the content. The results of the two calls are replaced **together**.
2. Snip drops whole groups. 7 messages become 3, and **there is no orphan `tool` message**.
3. This time micro **increased** the byte count (642 → 720) — the placeholder is longer than the original short result. This confirms what the earlier text said: micro is designed for results of a few KB and above.

**Experiment 5: how many model calls does the cache actually save?**

```typescript
class CountingSummarizer implements HistorySummarizer {
  calls = 0;
  async summarize(_history: readonly ChatMessage[]): Promise<CompactionSummary> {
    this.calls += 1;
    return new CompactionSummary({ currentGoal: "...", keyFindings: ["..."], ... });
  }
}

const manager = new CompactionManager({ workspace, summarizer, proactiveThresholdBytes: 800 });
const canonical = [userMessage("x".repeat(1_000))];

const first = await manager.prepare(canonical);
const again = await manager.prepare([userMessage("x".repeat(1_000))]);      // Identical content
const appended = await manager.prepare([...canonical, assistantMessage("The latest answer")]);
```

Actual output:

```text
canonical bytes = 1029 > threshold 800
prepare #1: summary call count = 1  request history count = 1
prepare #2 (identical content): summary call count = 1  is it the same object = true
prepare #3 (pure append): summary call count = 1  count = 2
Was canonical rewritten = No
```

Three `prepare()` calls, one summary. The second call returns even the same object reference. The third call reuses the compacted prefix.

When you finish, delete the temporary directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item -Recurse -Force '.\scratch'
```

---

## What This Chapter Does Not Do

| Already has | Does not have yet | When to add it |
| --- | --- | --- |
| A UTF-8 byte budget | Exact token counting | **Will not add**. It needs a tokenizer dependency, and it is not common across models |
| A four-level pipeline | The `contextCollapse` level of Claude Code | **Will not add**. See "Differences from Claude Code" |
| The `compactProactively()` API | A `/compact` command or a `compact` tool | **Will not add**. Exposing it as a tool makes the context cost unpredictable |
| The `compactOnPromptTooLong()` primitive | The Loop automatically identifies prompt-too-long | Chapter 11 (API resilience and error classification) |
| The summary keeps 5 classes of information | Automatically re-read the most recently changed files after compaction | **Will not add**. It needs a state recovery layer outside `CompactionManager` |
| Artifact persistence | Automatic artifact directory cleanup, redaction, encryption | **Will not add**. The compaction module must not solve these implicitly |
| In-session compaction | Cross-session persistent memory | Chapter 9 (file-level memory) |
| An in-instance cache | A cross-process persisted compaction cache | **Will not add**. Canonical history is the single source of truth |
| Uniform placeholder replacement | A retention strategy by tool type | **Will not add**. See the last paragraph of "Differences from Claude Code" |

The dual of the last row needs special emphasis: the `microCompactHistory()` of this chapter replaces **all** tool results with a placeholder, without distinction. Claude Code distinguishes by tool type — a `read_file` result can be read again after compaction, so it dares to replace it directly. The result of another tool may not be reproducible, and it needs a more conservative strategy.

This difference has a practical impact on a production system: if the result of a tool is not reproducible (for example, an API query with a timestamp), replacing it with "Re-run if needed" is a lie — a re-run does not return the same result. This chapter does not make the distinction, to keep the rule simple. But when you add this layer in a real system, you must think it through.

---

## Differences from Claude Code

The context compaction of this chapter is a teaching subset. The Claude Code compaction system follows the same "cheap first, expensive later" principle, but its implementation has the significant differences below. Official documentation: https://code.claude.com/docs/en/context-window , https://code.claude.com/docs/en/commands , https://code.claude.com/docs/en/agent-sdk/hooks . Reference external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code), `s08_context_compact/README.md`.

- **Different precision.** Claude Code uses an exact token threshold (`contextWindow - maxOutputTokens - 13,000`). P08 uses a UTF-8 byte estimate, and omits the cost of introducing an exact tokenizer.
- **Different number of compaction levels.** The five-level Claude Code pipeline is `budget → snip → micro → contextCollapse → auto` (`query.ts:379-468`). P08 has no `contextCollapse` level. Its execution order is `budget → snip → micro → auto`.
- **contextCollapse is not sessionMemoryCompact.** The Claude Code source contains an independent `contextCollapse` context management system (when it is on, it suppresses proactive autocompact) and `sessionMemoryCompact` (before a compact, it tries a light summary with the session memory first). P08 involves neither.
- **Different summary format.** The Claude Code summary prompt contains 9 information parts. The model output uses the double tags `<analysis>` / `<summary>`, and a double safeguard at the head and tail forbids tool calls. P08 uses strict 5-field JSON, with no safeguard tags.
- **Different proactive compaction and Hooks.** Claude Code has a built-in `/compact` command and a `SnipTool` tool, and a complete `PreCompact` / `PostCompact` Hook life cycle. P08 does not expose `compactProactively()` as a tool, and `CompactionManager` emits no Hook events.
- **Different post-compaction recovery.** After a compact, Claude Code automatically re-reads the most recently changed files (at most 5 files, 5K tokens each, a total budget of 50K tokens), and it maintains a `readFileState` to avoid re-reading an unmodified file. P08 keeps only the summary. It does not restore file content automatically.
- **Different reactive retries.** Claude Code has finer graded retries and model error classification. The P08 `compactOnPromptTooLong()` is a testable passive primitive, but the P08 Loop does not yet connect to a vendor-neutral prompt-too-long signal.

---

## What to Learn from ai-agent-book: Compaction Is Not Saving Tokens, It Is Organising Knowledge

Chapter 2 of `ai-agent-book`, "Context compaction strategies", proposes that compaction has two motives: the first is the length and cost constraint, and the second is **thinking quality**. The second is easier to ignore, and it is the Context Rot from the start of this article.

Its experiment 2-9 uses one research task to compare six strategies. The results are worth comparing against:

| Strategy | Measured result | Problem it exposes |
| --- | --- | --- |
| No compaction | About 367,000 characters in 7 tool calls. At iteration 5, about 165K tokens, exceeding the 128K budget | A large window alone is not viable |
| Individual summary | A 10.9% compaction ratio, 12 iterations, 276,608 tokens | Repeated page information fragments |
| Combined summary | A 4.3% compaction ratio, 10 iterations, 93,449 tokens | An over-long input truncation can lose the tail |
| Context-aware summary | A compaction ratio of about 3.0%, 7 iterations, 40,157 tokens. Once it compacted 147,877 characters into 1,963 characters | The summary request must include the current goal and the existing conclusions |
| Summary with citations | 222,992 tokens | Traceable, but the citation metadata has a clear cost |
| Adaptive windowing | 174,601 tokens. Near the 80% threshold, it batch-compacts all unmarked results | Early turns keep the original information. Later turns downgrade it in a batch |

After the comparison, the P08 design trade-offs are clearer:

- **Cheap first, expensive later is a production principle.** `ai-agent-book` splits production-grade compaction into five levels: tool result budget control, noise deletion, API-level micro-compaction, archive-style summary, and full compaction with a circuit breaker. The four P08 levels are a teaching subset: persistence matches level 1, snip approximates middle deletion, micro approximates API-level micro-compaction with a local placeholder, and the model summary is the last resort. P08 does not implement server-side context editing, and it has no consecutive-failure circuit breaker.
- **A structured summary beats leaving the original text for the model to summarise itself.** In the experiment, the token count and the iteration count of the context-aware summary are clearly lower than the individual summary. The P08 5-field JSON turns the goal, the findings, the files, the remaining work, and the constraints into verifiable state. The transcript and the artifacts keep the original scene. This matches the book's trade-off of "lossy compaction + lossless index".
- **The current P08 is not yet context-aware compaction.** The best strategy in the book writes the current query intent and the existing conclusions into the summary prompt. The P08 `SUMMARY_SYSTEM_PROMPT` is a fixed JSON schema. It takes no current goal parameter. Therefore you **cannot** use a goal metric such as 40,157 tokens to claim that P08 reaches the same effect.
- **Markers make the compaction result readable, but they are not a persistent anti-duplication mechanism.** The adaptive windowing in the book uses a `[COMPRESSED]` marker to prevent compacting the same batch of results twice. The P08 `[Compacted: ...]` and `[Earlier tool result compacted...]` markers make the request history inspectable. But the cache judgement is done by `historiesEqual()` / `historyStartsWith()`, **not by scanning the message body**.
- **The retention priority matches the P08 five fields.** The book suggests keeping architecture decisions, key constraints, changed files, verification state, and unresolved TODO items. The P08 summary fields have no dedicated "verification state". But `key_findings` / `remaining_work` can carry pass/fail and rollback information, and the canonical transcript guarantees that the pre-compaction scene is not lost.

---

## The Code Boundary of This Chapter

| Implementation | Responsibility and boundary |
| --- | --- |
| The `DEFAULT_*` constants | Centrally hold the default budgets such as `30_000`, `200_000`, `2_000`, `3`, `5`, `50_000`, and `50`. Tests can inject small values at construction |
| `CompactionManager.prepare()` | Before a model request, generate the request history from the canonical snapshot: snip → micro → summarise only above `50_000` bytes. It affects only this request and the later reusable request snapshots |
| `compactToolResults()` | Before a whole turn of tool results is written back into canonical history, persist by the single-item threshold and the batch budget, keep the error metadata, and return the results and the artifact references |
| `validatedGroups()` / `validateToolPairing()` | Validate the pairing of the assistant tool calls and the tool results first, then cut into ordinary groups and tool exchange groups. Every trim boundary is based on a group |
| `snipCompactHistory()` | Above `50` message groups, keep the first `3` groups, the omission marker, and the last `46` groups. Omit whole groups |
| `microCompactHistory()` | Keep the most recent `3` tool exchange groups. Replace an earlier tool result with a placeholder. Do not delete the assistant call or the `tool_call_id` |
| `historyUtf8Bytes()` / `serializeTranscript()` | Turn the history into stable JSONL, then compute the UTF-8 bytes. This is the same canonical output for the summary threshold and the transcript |
| `ModelHistorySummarizer` / `parseCompactionSummary()` | Issue a tool-free summary request. Require `stop`, and require the output to be a non-empty JSON with exactly 5 fields |
| `historiesEqual()` / `historyStartsWith()` | Use stable JSON to identify "completely identical" and "pure append", reuse the compacted prefix, and avoid sending to the model again |
| `boundedUtf8Preview()` / `decodeUtf8Boundary()` | Take the head and tail by byte. Use a decoder with `fatal: true` to discard an incomplete character at the boundary |
| `ensureSafeDirectory()` / `writeExclusiveAtomic()` / `removeCreatedArtifacts()` | Recheck the real directory, publish exclusively with a temporary file plus a hard link, and clean up the artifacts created in the batch on a failure |
| `compactProactively()` / `compactOnPromptTooLong()` | The explicit outer compaction API and the reactive recovery primitive. The second keeps the most recent `5` complete groups after the summary, and limits one retry with a `PromptTooLongRetryError` |
| `AgentRunner.#processToolResults()` | When the result processor fails, replace the whole batch of results with a `tool_result_processing_error`. It still corresponds one-to-one with the original tool call count |

---

## Chapter Summary

### The three-sentence version

1. The four compaction levels execute in cost order, from low to high: persistence → snip → micro → model summary. The first three levels cost no model call.
2. Compaction acts only on the request history. Canonical history is always the session facts that compaction never rewrites.
3. Every trim uses a complete message group as the unit. Several tool calls in one turn never cut out an orphan message.

### Eight rules to remember

| # | Conclusion | In which section |
| ---: | --- | --- |
| 1 | A threshold counts UTF-8 **bytes**, not characters. One Chinese character is 3 bytes | Level 1: persist a large tool result by UTF-8 bytes |
| 2 | A value exactly equal to the threshold is **not** persisted. It must be strictly greater | Same as above (a dedicated test) |
| 3 | One assistant + all of its tool results = 1 message group. A trim can only take a whole group | Message atomic groups |
| 4 | Persistence happens **before** the write into canonical history, so the source of truth never held that oversized body | Never confuse the four objects |
| 5 | Write the transcript first, then call the summary. If the transcript write fails, do not call the summary model | Level 4: the five steps |
| 6 | The summary field set must match **exactly**. One extra field means rejection | Level 4: the untrusted boundary |
| 7 | Micro can make the history **longer** for a short result — it is designed for results of a few KB and above | Level 3: one honest observation |
| 8 | P08 has no `compact` tool, and no automatic prompt-too-long recovery | The proactive compaction API / prompt-too-long |

### Check whether you really understood

1. Does a 30,000-byte tool result get persisted? What about 30,001? (Level 1)
2. In one turn there are 5 results, each 50,000 bytes. How many get persisted? (Level 1: the batch budget)
3. With `previewHeadBytes: 10` on pure Chinese content, how many characters can actually show? (Experiment 2)
4. One assistant issues 3 calls. In the snip budget, how many groups is that? How many messages does it take? (Message atomic groups)
5. After `snip`, did canonical history get shorter? Can you see the trimmed messages in `RunResult.history`? (The four objects)
6. The summary model returns the correct 5 fields, plus a `confidence: 0.9`. What happens? (Level 4)
7. Can you find the complete 30,003-byte body in the transcript? Where is it? (What does the transcript actually save?)
8. You call `prepare()` three times in a row with a completely identical history. How many times is the summary model called? (The cache)
9. The model returns `finishReason: "length"`. Does P08 trigger reactive compaction? Why? (prompt-too-long)
10. The disk fills up during persistence. What do the 5 tool results of this turn become? Do they still satisfy the pairing contract? (Level 1: persistence failure)

---

## Compaction Solves the Present, Memory Solves Across Sessions

What this chapter can directly guarantee now is: a tool result is persisted in a bounded way by real UTF-8 bytes; every trim keeps the OpenAI tool message atomic group; request-level compaction does not rewrite canonical history; a traceable transcript is saved before the model summary; an identical history and a pure-append history can reuse the cache.

It does not promise exact token counting. It does not expose `compactProactively()` as a tool. It does not automatically identify prompt-too-long in the P08 Loop. The artifact directory still needs manual cleanup, and it has no redaction or encryption capability.

Context compaction solves the "does not fit" and "not clear" problems of the current session. But when the session ends, the summary and the transcript are only files on disk. The Agent of the next run does not know that they exist.

The next chapter discusses a different thing on top of this boundary: which information deserves to survive **across sessions**, and how file-level memory still loses no data when a write fails. On-demand loading takes less. Context compaction sheds load in time. File-level memory remembers for next time.
