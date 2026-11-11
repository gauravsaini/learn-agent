Chapter 8 solved context compaction: when a session is nearly full, the program generates a summary automatically, replaces the history with the summary, and keeps running. But one hard flaw was never handled. The user says "use tabs, not spaces". After compaction, that becomes at most "the user has a code style preference". The key detail is gone. In a new session, even that sentence never appears again.

An LLM has no persistent state. All information lives in the context window. When the window fills, you compact. Compaction is lossy. A new session starts from zero. This is not a problem of the compaction algorithm. It is an architecture problem: you need a storage layer that does not take part in compaction and that survives across sessions.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaFDCGpqNNngBPZbesAfEDgGFIMAX7qDPRAtB2PWF1CDuovepqUfUibPheVJOP4eAmj892p0NkRZHpsQhEz5u4SFEPnJEfsggpiaI/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

1. State that "compaction" and "memory" solve two different problems, and why you still need chapter 9 after the chapter 8 compaction.
2. Repeat the complete path of one memory, from "the user mentions it in passing" to "the next session uses it", and name each stage it passes through.
3. Explain why the authority source of the memory set is `manifest.json`, and not "scan all `.md` files in the `.memory` directory".
4. Explain why memory extraction must read canonical history, and what reading request history would miss.
5. Calculate what the two budgets of one memory (200 lines / 4096 bytes) each measure, and how much space the body actually has left.
6. Read one "consolidation" commit order, and explain why a wrong order causes "after a consolidation failure, the memory is completely empty".
7. Judge which capabilities this chapter does **not** implement (vector retrieval, memory quality evaluation, Reviewer review), so you do not claim behavior that does not exist.

### What you need first

| Prerequisite | From which chapter | How this chapter uses it |
| --- | --- | --- |
| The message history structure of the Agent Loop | Chapter 1 | Memory reads and writes at a turn boundary. It does not enter the tool call loop |
| The workspace hard boundary and path validation | Chapter 2 | `.memory` must stay inside the workspace. A link cannot bypass it |
| The pairing invariant of tool calls and results | Chapters 1 and 2 | The history snapshot that the extractor receives must still satisfy the pairing |
| The difference between canonical history and request history | Chapter 8 | **The most important prerequisite of this chapter**. Extraction reads canonical only |
| A large tool result persisted as an artifact | Chapter 8 | A middle fact may exist only in an artifact. The extractor cannot see it |
| Profile capability bits and the composition root | Chapters 5 to 8 | P09 uses one `memory` capability bit to decide the wiring |

### Quick terminology (terms that appear for the first time in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| File-level memory | Write information that still has value across sessions into `.md` files on disk. It does not take part in compaction |
| `MemoryRecord` | The immutable value object of one memory. The constructor completes all validation |
| `MemoryStore` | The single transaction entry of the memory set. All reads, changes, and writes take the lock |
| `MemorySession` | Wraps `MemoryStore` as a turn life cycle that the Loop can call |
| manifest | `manifest.json`, the single authority pointer of the current memory set |
| Derived view | Something that the program can regenerate from the manifest (`MEMORY.md`). If it breaks, the facts do not change |
| Bounded catalog | A light index with only a name and a one-line description, for the selector to read. It holds no body |
| side-query | One independent model request with no tools, only to get one JSON segment |
| selector / extractor / consolidator | The three side-query roles: select / extract / consolidate |
| Deterministic fallback | When the selector fails, use keyword matching with fixed rules instead. Do not rely on the model |
| Consolidation | When the memories grow, merge the duplicates and the conflicts. It must declare which old records it replaced |
| Atomic replacement | Write a temporary file and fsync it first, then rename over the target. A reader never sees a half-written file |

### Suggested reading route

```text
Chapter guide (you are here)
  ↓
① Look at memory really working across sessions first   ← two independent Agent instances, one writes and one reads
  ↓
② Why choose the file system   ← the trade-off against a vector store and SQL
  ↓
③ One set, two derived views   ← the most important architecture decision of this chapter: the manifest is the authority
  ↓
④ Load: select the name first, then read the body   ← the key to saving context, and how failure degrades
  ↓
⑤ Write: extract from canonical history   ← why you cannot read request history
  ↓
⑥ Consolidate: declare the sources first, then commit once   ← the commit order decides whether a failure loses data
  ↓
⑦ Concurrency and failure boundaries   ← two lock layers + atomic replacement
  ↓
⑧ Run + experiments + troubleshooting   ← verify all the numbers of this chapter by hand
```

---

## Look at Memory Really Working Across Sessions First

Talking about "persistence" in the abstract is worse than looking at one run directly. This code comes from `code/chapters/ch09/tests/ch09-memory.test.ts`. It is real data that the tests assert.

It builds **two completely independent Agent instances**. They share one workspace directory. Note: these are not two turns of one session. They are two `buildAgent()` instances, and each holds its own independent history.

**First instance: the user says one sentence, and the Agent records it.**

```typescript
const first = buildAgent(P09, { model: firstModel, workspace, /* ... */ });
await first.run("remember the database rule");
```

In this turn, the instance sent 2 requests to the model:

| # | What it is | With tools? | Model returns |
| ---: | --- | --- | --- |
| 1 | Main request (answer the user) | Yes, 8 tools | `"stored"` |
| 2 | extractor side-query | `tools: []` | One JSON array |

The JSON of request 2 is:

```json
[
  {
    "name": "project-fact",
    "type": "project",
    "description": "Project database rule",
    "body": "Always use the integration database."
  }
]
```

The turn ends, and this memory lands on disk. The life cycle of the first instance ends here, and all of its history is discarded.

**Second instance: switch to another Agent, and ask a related question.**

```typescript
const second = buildAgent(P09, { model: secondModel, workspace, /* ... */ });
const result = await second.run("which database should I use?");
```

This turn becomes 3 requests. The order matters:

| # | What it is | With tools? | What it does |
| ---: | --- | --- | --- |
| 1 | selector side-query | `tools: []` | Pick the relevant memories from the catalog, and return `["project-fact"]` |
| 2 | Main request (answer the user) | Yes, 8 tools | The context **already** contains the body of that memory |
| 3 | extractor side-query | `tools: []` | This turn has nothing new. Return `[]` |

The key assertion is request 2:

```typescript
expect(
  secondModel.requests[1]?.messages.some((message) =>
    message.content?.includes("Always use the integration database."),
  ),
).toBe(true);
```

**A constraint that the user stated in the first instance appears in the context of the second instance.** Nobody passed it by hand in between. It works only through those few files on disk.

Three more assertions pin the boundary: of the three requests, only the main request carries tools. The `tools` of both side-queries must be an empty array.

```typescript
expect(secondModel.requests[0]?.tools).toEqual([]);   // selector
expect(secondModel.requests[2]?.tools).toEqual([]);   // extractor
expect(secondModel.requests[1]?.tools.map((t) => t.function.name)).toEqual([
  "shell", "read_file", "write_file", "edit_file", "glob", "todo_write", "task", "load_skill",
]);
```

### One cost must be stated clearly first

You can compute it from the tables above: **with the memory capability on, one turn costs at most 2 extra model calls** (selector + extractor). After the consolidation threshold is reached, it costs 1 more (consolidator).

The first instance sent only 2 requests, because its memory set was empty at the start — `beginTurn()` read 0 memories and returned directly, without even calling the selector. This is a deliberate short circuit: when there is no memory to select, do not waste a call.

This cost is a direct consequence of the design of this chapter. It is not a bug. When you connect this mechanism in a real project, judge for yourself whether it is worth it: a long-term project where preferences and constraints recur is worth it. A one-off script is not.

---

## Why Choose the File System

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaHibPdk2x4Oj1EYnZLaboUkc3SVC7Rk96k5SXI5833MuNozibm7JJkq0cXzIo2jbZ6QhsxdHYmmPiaUJjtHDVVlVmxal3u8GtCiaKQ/640?from=appmsg&watermark=1#imgIndex=2)

The first reaction may be a vector database — embed the preferences and the background, store them, and do semantic retrieval at query time. But that road has several problems: heavy deployment dependencies, debugging that is not intuitive, and complete overkill for a small-scale scenario.

Another idea is a structured database, storing memory with SQL or JSON. The problem is that you must write the query logic yourself, and an LLM does not read it naturally. It needs an extra serialization layer.

Compare the three roads:

| | Files + Markdown | Vector database | SQL / JSON |
| --- | --- | --- | --- |
| Deployment dependency | None | Needs a service or an embedded library | Needs a driver or a schema migration |
| Can a human read it directly? | Yes. Open it and read | No. It is vectors | Barely. It needs formatting |
| Does an LLM read and write it naturally? | Naturally. It is natural language | Needs a conversion layer | Needs a serialization layer |
| How do you locate a problem? | Compare the manifest and the body | Check embeddings and similarity | Check tables and query statements |
| Semantic retrieval | **Not supported**. This chapter uses name matching | Supported | Not supported |

The last row is a cost, not an advantage. The choice of this chapter is: at a small scale, auditability is worth more than semantic recall. When the memories reach several hundred, this trade-off needs a new calculation.

The file system has one more implicit benefit: a manual edit is a **supported** operation. You can open a file under `.memory` directly and change its content. But keep the contract — keep the frontmatter format, do not exceed the size limit, and do not delete a file that the manifest references. If you break it, the read side rejects it (the section "The read side trusts nothing" explains exactly which cases it rejects).

### Storage format: Markdown + YAML frontmatter

```yaml
---
name: user-preference-tabs
description: User prefers tabs for indentation
type: user
---

User prefers using tabs, not spaces, for indentation.
**Why:** Consistency with existing codebase conventions.
**How to apply:** Always use tabs when writing or editing files.
```

The frontmatter holds the metadata. The body holds the complete detail. This layering is the basis for "select the name first, then read the body" saving context later:

- `name` and `description` enter the bounded catalog. **The selector sees them in every turn**, so they must be short.
- `body` enters the context only when this memory is selected, so it can be detailed.

One practical suggestion for writing the body: state clearly "what it is / why / how to use it", as above. If you write only "use tabs", the model does not know in which scenario to apply it next time.

### Four memory types, each with its own job

| Type | What it records | Example |
| --- | --- | --- |
| `user` | Who the user is, and what they prefer | "Use tabs, not spaces" |
| `feedback` | How to work, and which traps were hit | "Do not mock the database" |
| `project` | What is happening now | "The auth rewrite is compliance-driven" |
| `reference` | Where to find things | "The pipeline bug is in Linear INGEST" |

These four values are a **closed set**. If the model writes another type, the program rejects it directly:

```typescript
expect(() => new MemoryRecord({
  name: "valid-name", description: "description",
  kind: "invalid" as never, body: "body",
})).toThrow(/MemoryType/);
```

Why close the set? Because the type takes part in the routing of the selection and consolidation stages. If you let the model invent types freely, it may change the classification system on every run. After a few dozen memories, maintenance becomes impossible.

---

## One Set, Two Derived Views

This section is the most important architecture decision of this chapter. It is worth reading slowly.

One natural idea is: the memories are all the `.md` files in the `.memory` directory, and to read them you scan the directory. **This chapter explicitly does not do that.**

The reason is that a write and a consolidation can both fail in the middle. Imagine a consolidation crashes halfway through writing: the directory holds 3 old files and 2 new files at the same time. A directory scan treats them all as valid memories, so the model sees two contradictory content sets. The directory may also hold orphan files left by a previous failure.

So the current implementation has three layers:

| File | Responsibility | What happens if it breaks |
| --- | --- | --- |
| `.memory/manifest.json` | The **single authority pointer** of the current memory set | The set cannot be read. Report an error directly |
| `.memory/MEMORY.md` | The bounded catalog generated from the current set, for the selector to read | Does not affect the facts. It can be rebuilt |
| `.memory/<name>-<id>.md` | The frontmatter and body of one memory | If the manifest references it, report an error. Otherwise, ignore it |

After one successful write, the disk really looks like this (this is actual output from a run, not a diagram):

```text
.memory/
├── MEMORY.md
├── manifest.json
└── tabs-style-c60d6de834bb4afc98bd5f8a41ca426d.md
```

`manifest.json`:

```json
{"version":1,"files":["tabs-style-c60d6de834bb4afc98bd5f8a41ca426d.md"]}
```

`MEMORY.md`:

```text
- [tabs-style](tabs-style-c60d6de834bb4afc98bd5f8a41ca426d.md) - Tabs indentation preference
```

The record file itself:

```text
---
name: tabs-style
description: Tabs indentation preference
type: user
---

Always indent with tabs.
```

Three details deserve attention.

**First, the string after the file name is 32 hexadecimal characters.** `randomUUID()` produces it, with the hyphens removed. What you get when you run it will certainly differ from here. That is normal.

Why add this ID string? Because committing a new set **cannot overwrite the old files**. During consolidation, if the new `tabs-style` wrote directly onto the old `tabs-style.md`, a bad write would lose both sides. With a unique ID, the new file is a new file. The old file is deleted only after the manifest switch succeeds.

**Second, `MEMORY.md` is a derived view. It does not carry the transaction pointer responsibility.** The program can rebuild it completely from the manifest. Delete it, and the next commit regenerates it. Break it, and the set that `records()` reads does not change.

One point here is easy to misunderstand: the catalog that the selector sees does **not** come from reading the `MEMORY.md` file. `renderCatalog()` renders again in memory from the current manifest set. `MEMORY.md` lands on disk mainly for humans to read and for debugging.

**Third, `.memory/.lock` is not part of the memory set.** It is the lock file that `proper-lockfile` uses for cross-process mutual exclusion. The "Concurrency" section explains it later.

The matching implementation is concentrated in `MemoryStore` in `code/chapters/ch09/src/features/memory.ts`. The whole file has no second directory scan logic.

### The write entry accepts only a validated value object

```typescript
import { MemoryRecord, MemoryStore, MemoryType } from "./features/memory.js";

const store = new MemoryStore({ workspace: process.cwd() });
await store.add(
  new MemoryRecord({
    name: "user-prefers-tabs",
    description: "User prefers tabs for indentation",
    kind: MemoryType.USER,
    body: "Use tabs in this repository.",
  }),
);
```

Note that the code does **not** use a trick such as `replace("/", "-")` to quietly turn invalid input into another name. The `name` must already be a safe lowercase slug. If it does not comply, throw an error.

The reason for this choice: the name decides the file name directly. A quiet rename produces a memory that neither the user nor the model knows about. Next time, a lookup by the original name finds nothing, so the writer writes another one. Very soon, duplicates pile up.

Every rejected name has a test that pins it:

```typescript
test.each(["../escape", "has space", "UPPER", "nul", "com1", "lpt9", "file:stream", "trailing."])(
  "rejects unsafe memory name %s",
  (name) => { expect(() => record(name, "description", "body")).toThrow(/slug/); },
);
```

Look at each one and see what it defends against:

| Rejected name | What it defends against |
| --- | --- |
| `../escape` | Path traversal. It writes outside `.memory` |
| `has space` | A space. It makes the file name hard to handle on a command line |
| `UPPER` | Uppercase. It collides on a case-insensitive file system |
| `nul` / `com1` / `lpt9` | **Windows reserved device names**. Creating one gives a strange error at once |
| `file:stream` | The Windows NTFS alternate data stream syntax |
| `trailing.` | Windows silently removes a trailing dot, so the name no longer matches |

The last four rows are Windows-specific traps. A cross-platform Agent that blocks only `..` and `/` can still fail on Windows.

### Two budgets: 200 lines / 4096 bytes

The `description` must be a single-line, non-empty text. The complete serialized file is under two limits at the same time. **Both count the whole file, not only the body:**

```typescript
expect(() => record("too-many-lines", "description", Array(201).fill("line").join("\n")))
  .toThrow(/200 lines/);
expect(() => record("frontmatter-counts", "description", Array(195).fill("line").join("\n")))
  .toThrow(/200 lines/);
expect(() => record("too-many-bytes", "description", "界".repeat(1_400)))
  .toThrow(/4096 UTF-8 bytes/);
```

The name of the second test (`frontmatter-counts`) is the point: **a 195-line body is also rejected**, because the frontmatter also takes lines.

Measured, the real body limit is **194 lines**:

```text
Body 193 lines: pass
Body 194 lines: pass
Body 195 lines: reject -> memory file must not exceed 200 lines
```

The missing 6 lines are used like this:

```text
---                                    ← 1
name: tabs-style                       ← 2
description: Tabs indentation ...      ← 3
type: user                             ← 4
---                                    ← 5
(blank line)                           ← 6
Body line 1                            ← 7
...
```

The byte budget works the same way. The 4096 bytes cover the whole file. The part that the frontmatter takes must come out of the body. Pure Chinese is 3 bytes per character, so a Chinese body reaches the top at about 1340 characters.

Note that this limit **is not a fixed value**: the longer the `name` and the `description`, the larger the frontmatter, and the fewer bytes remain for the body. Experiment 2 uses the shortest `description: "d"` to measure the exact boundary (1348 characters pass, 1349 are rejected). Change the `description` to a Chinese sentence of a dozen or so characters, and the limit drops by a few characters.

Why put a budget on a memory file? Because memory is **injected into the context**. Select 5 memories of 8000 bytes each, and 40KB enters the request directly — that uses the memory mechanism to blow up again the context that chapter 8 just compacted. The budget is the self-restraint part of this mechanism.

After parsing, `.memory` must also stay inside the workspace. A directory link cannot bypass the boundary. This also has a test:

```typescript
await symlink(outside, join(root, ".memory"), "junction");
await expect(new MemoryStore({ workspace: root }).records())
  .rejects.toThrow(/escapes workspace/);
```

Conversely, the workspace itself may be a link — the code resolves it with `realpath` into the real path first, then creates `.memory` under the real path.

### The read side trusts nothing

Reading is not "accept every file that the manifest lists". On every load, `MemoryStore` runs the full validation set again:

| Validation | What it blocks |
| --- | --- |
| The manifest must be legal UTF-8 JSON | File corruption, encoding errors |
| The manifest must contain exactly the two keys `version` + `files` | An extra field, a missing field, structure drift |
| `version` must be the number `1` | A value such as `version: true`, which JS loose typing would let through |
| File names are unique | The same file registered twice |
| A file name follows the safety rules | `NUL.md`, `safe-name.md:stream` |
| `realpath` is still inside `.memory` | A link points a file outside the workspace |
| After parsing the body, validate with the same `MemoryRecord` constructor | A hand-broken frontmatter, an over-budget file |

The `version: true` row has a dedicated test, because it is a real trap — in JS, `true == 1` holds. Write the check carelessly, and a boolean passes as a version number:

```typescript
await writeFile(manifestPath, JSON.stringify({ version: true, files: [] }), "utf8");
await expect(new MemoryStore({ workspace: root }).records()).rejects.toThrow(/invalid schema/);
```

Conclusion: a file that a hand edit broke, a file that sits in the directory but is not registered in the manifest, and a file that escapes the workspace through a link are never treated as valid memory.

---

## Load: Select the Name First, Then Read the Body

At the start of each turn, `MemorySession.beginTurn(query)` reads the current set first. If the set is empty, it returns directly and does not call the model.

If the set is not empty, it gives the **query** and the **bounded catalog** to the selector. It gives the catalog, not all the bodies — this is the key to saving context. Assume there are 30 memories, and each body is 3KB:

| Method | What enters the context each turn |
| --- | --- |
| Push all bodies to the main model | About 90KB |
| This chapter: catalog selection + at most 5 selected bodies | Catalog about 2KB + bodies at most 15KB |

The model returns an array of memory `name` values, not file indexes:

```json
["user-preference-tabs", "project-database-rule"]
```

It uses names and not indexes because an index drifts. Add or remove one set item, and the thing that index 3 points to changes. A name is a stable identifier. If the selection is wrong, you see it at once ("this name does not exist").

### Three hard requirements for a side-query

`ModelMemoryQueries` issues a side-query through the same vendor-neutral `ModelClient`, but the request explicitly sets `tools: []`. The reply must satisfy three conditions at the same time:

| Requirement | What happens if it is not met | What it defends against |
| --- | --- | --- |
| No tool call | Throw an error | The model tries to use the side-query as a chance to read or write files |
| `finishReason` is exactly `stop` | Throw an error | `length` means the JSON was truncated, and parsing gives an incomplete result |
| The body is non-empty text | Throw an error | Treating an empty reply as "no relevant memory" silently loses information |

All three have tests:

```typescript
test.each([
  { message: assistantMessage("[]"), finishReason: "length" as const },
  { message: assistantMessage(null, [{ id: "bad", name: "read_file", arguments: "{}" }]),
    finishReason: "tool_calls" as const },
  { message: assistantMessage("   "), finishReason: "stop" as const },
])("rejects invalid side-query replies", async (reply) => { /* all reject */ });
```

The first case deserves a special note: with `finishReason: "length"`, the body is `"[]"`. **It looks like legal JSON.** `JSON.parse()` succeeds, and it parses into an empty array. If you do not check `finishReason`, this truncation is treated as "the model thinks there is no relevant memory", and the content that should be remembered is silently lost.

After that, the code uses `JSON.parse()` to parse the **whole** reply. It does not cut a substring that "looks like JSON" out of a code fence or explanatory text. So the system prompts of all three side-queries state explicitly that Markdown code blocks are forbidden:

```typescript
const NO_FENCE_INSTRUCTION =
  "Output pure JSON text directly. Do not wrap with Markdown code blocks or backticks. Do not output any explanatory text.";
```

This is a deliberate strict trade-off. A loose "find the JSON in the reply" raises the success rate. But when the model outputs ` ```json ... ``` ` plus an explanation, it can also treat the example JSON in the explanation as the real result. This chapter chooses strict failure + deterministic degradation.

In addition, the input JSON of the selector, the extractor, and the consolidator is generated by `stableJson()` with sorted keys. The same object presents the same field order in different runs. Offline tests can then assert stably, and the model has one less pointless variable.

### Selection failure: a deterministic keyword fallback

Selection keeps at most 5 items. Any of these cases counts as failure: the request itself fails, the output is not a JSON string array, a name repeats, or it references a memory that does not exist.

On failure, `MemorySession` records the degraded state, then does **deterministic** keyword matching on `name + description`:

- English: split into tokens of length at least 3
- Chinese: split into adjacent bigrams ("数据库" → `数据`, `据库`)
- Score = the number of tokens hit. On an equal score, sort stably by memory name

Note that the fallback **scans only the name and the description. It does not read the body.** That matches the range that the selector sees in the catalog.

Three failure modes, one result:

```typescript
test.each([new Error("offline"), "not json", '["unknown"]'])(
  "uses deterministic keyword fallback after selector failure",
  async (output) => {
    // ... stored the two memories tabs-style and database
    await session.beginTurn("Please check the database integration");
    expect(session.selected).toEqual([database]);
    expect(session.lastError).toBe("Memory selection failed; deterministic fallback used");
  },
);
```

The Chinese bigram case also has a dedicated test, because Chinese has no spaces. Splitting by token would turn a whole sentence into one word:

```typescript
const database = record("database", "生产数据库约束", "使用真实数据库。");
const interaction = record("interaction", "前端交互约束", "保持键盘可用。");
await session.beginTurn("检查数据库集成");
expect(session.selected).toEqual([database]);
```

The query "检查数据库集成" splits into `检查`, `查数`, `数据`, `据库`, `库集`, `集成`. `生产数据库约束` contains `数据` and `据库`, for a score of 2. `前端交互约束` scores 0 and is filtered out.

The design intent here is: **when the memory mechanism has a problem, the main task must never fail.** The model is unavailable, it returns garbage, the network is down — the Agent still answers the user. At most, the memory selection is less accurate.

### The real shape of the injection

The selected bodies are wrapped in `<relevant_memories>`. This is injection content from an actual run:

```text
<relevant_memories>

## database-rule (feedback)

Production database constraint

Tests must connect to the real integration database. Mocking is forbidden.

</relevant_memories>
```

In chapter 9, the life cycle adds one system context message before the model request. In chapter 10, the dynamic Prompt `memory` section injects it instead, and this injection is turned off (with `emitContextMessages: false`), so the same memory never appears twice.

The body of a memory that was not selected never appears:

```typescript
expect(context[0]?.content).toContain("Never mock the database.");
expect(context[0]?.content).not.toContain("Always indent with tabs.");
```

When no memory is selected, `beforeModel()` returns an empty array, and the request stays clean, with no extra message.

### The injection does not enter canonical history

Emphasise this point alone, because it is the premise for correct "extraction" later.

The `<relevant_memories>` that `beforeModel()` returns is **assembled into this model request only**. It is not appended to canonical history. A Loop-level test pins this:

```typescript
expect(model.requests[0]?.messages).toEqual([
  { role: "system", content: "test" },
  userMessage("go"),
  userMessage("memory context"),      // ← entered the request
]);
expect(result.history).toEqual([userMessage("go"), assistantMessage("done")]);
                                     // ↑ did not enter the history
```

The same test also pins the order of the three life cycle points:

```typescript
expect(trace).toEqual(["begin:go", "before", "complete:2"]);
```

If the injection were written into canonical history, something bad would happen: the memory injected in this turn would be extracted again by the extractor in the next turn, as a "new fact that appeared in the session". After a few turns, the same memory would pile up in several slightly different wordings. Memory injection does not pollute the session evidence. Only then can the extraction stage rely on the complete original session alone.

---

## Write: Extract from Canonical History

The user usually does not say "please write this to memory" specially. So the program cannot wait for an instruction — after the Agent gives the final answer of this turn, `MemorySession.complete()` automatically calls the extractor, and looks in the session for information that still has value across sessions.

### It must read canonical history. It cannot read request history

This is the place where this chapter goes wrong most easily, and it is also where the chapter 8 prerequisite really earns its place.

The three compaction levels of chapter 8 (snip, micro, summary) generate only the request history **that this model request uses**. The canonical history that `AgentRunner` holds is not rewritten by this request-level compaction.

```text
canonical history   ← the single source of truth for the session facts. Complete, append-only
      │
      ├─→ request history   ← derived from canonical before each request. Compaction acts here
      │                        A user message may be cut whole by snip
      │
      └─→ Memory extraction reads this one ✅
```

If the extractor read the request history, what would it miss? The user messages in the history segment that snip cut. The "do not mock the database" that the user said in turn 3 may already be cut out of the request history by turn 40. The extractor cannot read it, and that constraint is never remembered.

So extraction reads canonical history. The user messages and the ordinary canonical content stay complete.

### But there is one exception: a large ToolResult

A large tool result is another boundary. State it clearly, or it creates a wrong expectation.

Level 1 compaction of chapter 8 (persistence) happens **before** the result enters canonical history. In other words, canonical history never holds the complete body. It holds the artifact path plus the head and tail previews:

```text
<persisted-tool-result>
path: .agent_tutorial/artifacts/tool-result-3f9a....txt
original_bytes: 30003
head_preview:
(at most 2,000 bytes)
tail_preview:
(at most 2,000 bytes)
</persisted-tool-result>
```

Conclusion: **if a key fact exists only in the middle of the original text, the extractor cannot see it.**

A concrete example. The Agent reads a 30KB configuration file. Line 400 of it says "the debug endpoint is disabled in the production environment". This information is in neither the first 2000 bytes nor the last 2000 bytes. Then the history that the extractor receives does not contain this sentence at all, and it cannot extract it.

To get this information into memory, you must read the artifact back first (so it enters the history as a normal-sized content segment). Do not assume that the extractor automatically sees the complete file.

### The input is an immutable snapshot

The extraction input is first copied into an immutable message snapshot, and the tool call pairing is validated. The extractor does not get a reference to the caller's message objects:

```typescript
const before = structuredClone(history);
await session.complete(history);
expect(history).toEqual(before);                          // The original history did not change
expect(histories[0]).not.toBe(history);                   // Not the same array
expect((histories[0] as readonly ChatMessage[])[0]).not.toBe(history[0]);  // And not the same object
```

Line 3 is the point: even the **elements** in the array are new objects. It is not only a shallow copy of the outer array. Memory extraction is a side-path feature. It must never have the ability to change the session facts.

### The output contract of the extractor: four fields, and not one more

```json
[
  {
    "name": "windows-examples",
    "type": "project",
    "description": "Project examples target Windows",
    "body": "Use PowerShell for user-facing commands."
  }
]
```

It must contain these four fields, **and only** these four fields. If any item's schema, type, slug, or size is invalid, **the whole batch is not committed**.

"The whole batch is not committed" is easy to overlook, but it is deliberate:

```typescript
// Returns two items: the first is legal, the second has the name "../invalid"
await session.complete([userMessage("remember both"), assistantMessage("done")]);
expect(session.lastError).toBe("Memory extraction failed");
expect(await store.records()).toEqual([]);      // ← The legal one was not written either
```

Why not keep the legal one? Because the items of one extraction batch are often related. The model returns 3 memories that describe three aspects of one decision. Writing only 1 of them gives an incomplete and possibly misleading state. Either the whole batch holds, or the state stays as it was.

An extraction side-query failure does not fail the main task. But `lastError` records `Memory extraction failed` explicitly, and the old set stays unchanged. The answer that the user receives is as usual. This turn simply recorded nothing.

---

## Consolidate: Declare the Replacement Sources First, Then Commit Once

When the memories reach the default threshold of 10, the consolidator receives "the current set + this turn's legal extraction results".

The key constraint here is: it **cannot** return only a new array. It must state explicitly which old records it replaced.

```json
{
  "source_names": ["tabs-old", "tabs-new"],
  "records": [
    {
      "name": "tabs",
      "type": "user",
      "description": "Indentation preference",
      "body": "Use tabs in this repository."
    }
  ]
}
```

Read it as: "merge `tabs-old` and `tabs-new`, and replace them with this one `tabs` record".

What happens if you let the model return only a new set? The model leaves out a few items in writing, and those items are silently deleted. It does not need to "decide to delete". It only needs to "forget to mention". So this chapter requires it to declare the sources explicitly:

- `source_names` must be non-empty, unique, and all belong to the consolidation candidates.
- `records` must be a non-empty, legal set.
- **A memory not listed in the sources must be kept.** A local consolidation cannot delete it in passing.

A test pins this directly:

```typescript
// Stored first, second, and unrelated. The consolidation declares only first and second as replaced
await session.complete([userMessage("done"), assistantMessage("done")]);

expect(await store.records()).toEqual([
  unrelated,                                              // ← Not involved, kept unchanged
  record("merged", "Merged project facts", "merged body"),
]);
expect(JSON.parse(await readFile(join(root, ".memory", "manifest.json"), "utf8"))).toEqual({
  version: 1,
  files: ["unrelated-three.md", "merged-merged.md"],
});
```

At the end, it also checks that the directory holds no garbage files:

```typescript
expect((await readdir(join(root, ".memory"))).filter((n) => n.endsWith(".md")).sort())
  .toEqual(["MEMORY.md", "merged-merged.md", "unrelated-three.md"]);
```

The replaced `first-one.md` and `second-two.md` are already deleted — only after the manifest switch succeeded.

### Commit order: why you cannot delete the old files first

One intuitive implementation is "delete the old files first, then write the new files one by one". This order has a fatal problem: the old files are deleted, the new files are not yet fully written, and the process crashes. **All the memory is gone.**

Inside the file lock, `MemoryStore.applyConsolidation()` reads the manifest again, then follows this order strictly:

```text
① Verify that the base records in the consolidation have not changed
      ↓
② Merge the uninvolved records, the concurrently added records, this turn's additions, and the replacement records
      ↓
③ Generate the new files and fsync them            ← The old files still exist. The manifest still points to the old set
      ↓
④ Generate the bounded derived index and write it atomically
      ↓
⑤ Atomically replace the manifest last          ← This step is the "commit point". The set is self-consistent before and after it
      ↓
⑥ Clean up the replaced old files only after the commit succeeds
```

At any moment before step ⑤, a crash leaves the manifest pointing at the complete old set, and the uncommitted files of this turn are cleaned up. **The state "after a consolidation failure, the memory is completely empty" never occurs.**

Each of the three failure points has a test:

| What failed | Result |
| --- | --- |
| The index exceeds the budget | The old manifest and the directory content are unchanged, byte for byte. The old set is fully readable |
| The manifest replacement fails (the file is set read-only) | The index is restored to the old version. All new files of this turn are deleted |
| An exclusive record file creation hits a name collision | The whole batch of files is cleaned, including the ones that were written successfully |

The third test is very direct:

```typescript
// A second-collision.md that will collide is placed in the directory in advance
await expect(store.extend([record("first", ...), record("second", ...)])).rejects.toThrow(/already exists/);
expect(await readdir(memoryRoot)).toEqual(["second-collision.md"]);   // first did not remain either
```

### A concurrent addition during consolidation is kept

While the model thinks (possibly several seconds), another session may add a memory. That record did not take part in this consolidation, so it must be kept.

The implementation does this: inside the lock, it **re-reads** the manifest to get the newest set, instead of using the snapshot from the start of the consolidation. A test uses a controllable consolidator to reproduce this timing exactly:

```typescript
const consolidator = {
  async consolidate() {
    started?.();                  // Notify the test: the consolidation started, the model is "thinking"
    await releasePromise;         // Block here and wait
    return '{"source_names":["first"],"records":[{"name":"merged", ...}]}';
  },
};
const completion = session.complete([...]);
await startedPromise;

// While the consolidation is blocked, write a new memory with another MemoryStore instance
await new MemoryStore({ workspace: root, idGenerator: ids("late") }).add(late);
release?.();                      // Release the consolidation
await completion;

expect(await store.records()).toEqual([late, record("merged", "Merged fact", "merged body")]);
//                                     ↑ The concurrently added one is still there
```

Conversely, if a **base record that takes part in the consolidation** changes during the wait, the consolidation fails directly (`memory collection changed during consolidation`). This strictness is necessary: the model made its merge decision based on the old content. If the content underneath changed, that decision no longer holds.

### How atomic replacement works

The "atomic write" mentioned again and again above is implemented by `atomicReplace()`:

```text
① Write a temporary file with a random name under .memory
② sync()  ← Ensure the content really lands on disk, not only in the OS cache
③ rename over the target
```

Within one file system, `rename` is an atomic operation. So a reader sees either the complete old file or the complete new file. **It never sees a half-written state.** Both `MEMORY.md` and `manifest.json` take this path.

Step ②, the `sync()`, is easy to omit. But omitting it is risky: the `rename` succeeded, the content is still in the OS cache and not on disk, and the power fails. After the restart, the manifest may be an empty file or half a JSON.

### There is only one trigger condition

This version uses only "the candidate count reaches the threshold" as the consolidation trigger. It does not implement extra gates such as a 24-hour interval, a session count, or lock file mtime expiry.

This simplification has one direct consequence that is worth knowing: **after the memories reach 10, the consolidator is called at the end of every turn**, even when this turn extracted nothing new. This is a deliberate teaching simplification (one less gate logic set, behavior that is easier to predict). But in a real project, it produces a continuous model call cost. The section "What this chapter does not do" explains how to complete it.

---

## Concurrency: Two Lock Layers

A write operation creates `.memory/.lock`. It is not part of the memory set. It is the lock file that `proper-lockfile` uses for cross-process mutual exclusion.

Every read-modify-write of `MemoryStore` passes first through an **in-process Promise queue**, then acquires this **file lock**:

```text
Several concurrent turns in the same Node process
      ↓
① In-process Promise tail chain (queue)        ← Cheap. It does not touch the file system
      ↓
② proper-lockfile file lock (cross-process)   ← Expensive, but it blocks other processes
      ↓
Read-modify-write the manifest / index / record files
```

Why two layers? With only the file lock, concurrent operations in the same process compete for the same lock file, and on Windows they also hit rename contention such as `EBUSY` / `EPERM`. Queueing in-process first absorbs most of the contention. The file lock then handles only the real cross-process case.

Both scenarios have tests:

```typescript
// Same workspace, two MemoryStore instances write concurrently
await Promise.all([
  firstStore.add(record("first", "First fact", "first body")),
  secondStore.add(record("second", "Second fact", "second body")),
]);
// Both are there. Neither overwrote the other
```

There is also a harsher one: 8 writers recovering the same **stale lock** at the same time.

```typescript
await mkdir(lockPath);
const staleTime = new Date(Date.now() - 60_000);   // Forge a lock from 60 seconds ago
await utimes(lockPath, staleTime, staleTime);

const stores = Array.from({ length: 8 }, (_, i) =>
  new MemoryStore({ workspace: root, idGenerator: ids(`id-${i}`) }));
await Promise.all(stores.map((store, i) => store.add(record(`memory-${i}`, ...))));

expect(records).toHaveLength(8);      // All 8 written successfully. Not one lost
```

A stale lock is a real scenario: when a process crashes, the lock file stays on disk, and nobody releases it. The `stale` (30 seconds) and `update` (10 seconds) parameters of `proper-lockfile` identify and recover such a lock. This test verifies that when 8 processes judge at the same time "this lock is stale, I take over", still only one really gets it.

---

## Failure Matrix: One Table for All the Boundaries

Collect the failure behaviors scattered above into one place. The last column marks whether this row has a direct test. Two rows have only an implementation and no test — this is the current test gap, not a behavior that does not hold.

| What failed | Main task | Memory set | `lastError` | Has a test? |
| --- | --- | --- | --- | --- |
| selector request fails / returns non-JSON / references an unknown name | Completes normally | Unchanged | `Memory selection failed; deterministic fallback used` | Yes (three `test.each` variants) |
| extractor request fails | Completes normally | Unchanged | `Memory extraction failed` | Yes |
| One item in the extractor's returned batch is invalid | Completes normally | Unchanged (the legal items are not written either) | `Memory extraction failed` | Yes |
| extractor succeeds but the disk write fails | Completes normally | Unchanged | `Memory extraction failed` | **No** session-level test |
| consolidator request fails | Completes normally | Unchanged (the extraction results are not written either) | `Memory consolidation failed` | Yes |
| consolidator returns empty `records` | Completes normally | Unchanged | `Memory consolidation failed` | Yes |
| A base record changes during consolidation | Completes normally | Unchanged | `Memory consolidation failed` | **No** |
| The manifest replacement fails | Completes normally | Unchanged. The index is restored | The error of the matching stage | Yes (at the `MemoryStore` layer) |
| The manifest / a record file is broken by a hand edit | **Fails** | Cannot be read | — | Yes (several) |

State the two gaps clearly, so you do not look for tests that match the table:

- **The disk-write-failure row**: the `MemoryStore` layer has tests for write failures (the index exceeds the budget, a read-only manifest, an exclusive creation name collision — three kinds). But no test maps "the `store.extend()` throw" to the step `MemorySession.lastError = "Memory extraction failed"`. The code path is the `catch` that wraps `extend()` inside `complete()`.
- **The base-record-changed-during-consolidation row**: the branch `memory collection changed during consolidation` at line 347 of `memory.ts` has no test at all. A test exists for its **opposite** — a concurrent **addition** of one memory during consolidation, which is kept (`preserves a record committed while consolidation waits on the model`).

The first eight rows are one principle: **memory is a side-path capability. When it breaks, it must not drag the main task down.**

The last row is the exception, and it is deliberate. When the set cannot be read, the program cannot "treat it as an empty set and keep running" — that silently discards all of the user's long-term preferences. This case must report an error explicitly, so a human looks at what happened on disk.

Two rows deserve a separate look, because they show the "do not do half" principle:

**No consolidation after an extraction failure.** An extraction failure means that this turn's input is incomplete. A consolidation based on incomplete input produces a wrong merge decision.

```typescript
expect(session.lastError).toBe("Memory extraction failed");
expect(consolidationCalls).toBe(0);          // The consolidator was never called
expect(await store.records()).toEqual([first]);
```

**When consolidation fails, the extraction results are not written either.** Because this turn's extraction results were meant to be committed together with the consolidation. Write only the extraction and skip the consolidation, and you leave an intermediate state of "should merge but did not merge".

```typescript
// The extractor returned second successfully, but the consolidator threw
expect(session.lastError).toBe("Memory consolidation failed");
expect(await store.records()).toEqual([first]);    // second was not written
```

---

## The Division of Labour Between Memory and Session Memory

The chapter 8 compaction mechanism still exists. It and long-term memory solve different problems. The two things have similar names and are easy to confuse, so compare them:

| | Memory (this chapter) | Session Memory (chapter 8) |
| --- | --- | --- |
| Persistence range | Across Agent instances, across sessions | The current session |
| Storage location | `.memory/*.md` + `manifest.json` | The request history summary and the transcript |
| Injection position | A chapter 9 context message. A chapter 10 Prompt section | Replaces the early history that this request sees |
| What it solves | Long-term preferences, constraints, and project knowledge | Continue the current task after compaction |
| Can it be lost | No, unless a file is deleted by hand | When the session ends, nobody reads it again |

Distinguish them in one sentence: **compaction lets the current session keep running. Memory lets the next session skip starting from zero.**

The actual timing in one turn:

```text
beginTurn(query)
  ↓
Select the relevant memories from the current manifest set         ← selector side-query (skipped when the set is empty)
  ↓
Assemble the context and the request-level compacted history             ← the snip / micro / summary of chapter 8 are here
  ↓
The model and tool loop. Canonical history keeps appending completely
  ↓
The final answer                                  ← The user gets the result here
  ↓
complete(canonicalHistory)
  ↓
Extract. At the threshold, commit together with the consolidation result         ← extractor (+ consolidator) side-query
```

### What to remember, and what not to remember

Memory does not save "everything that ever happened". It saves only what the next session will still use.

| Suitable for memory | Leave to canonical history / summary / transcript |
| --- | --- |
| User preferences (indentation, language, report style) | This turn's tool call details |
| Recurring constraints (do not mock the database) | A verbatim record of the complete conversation |
| Project architecture decisions and their reasons | "Which file are we reading now" |
| Key dependencies and version constraints | The intermediate reasoning process |
| A troubleshooting entry point (which system holds the bug) | One-off temporary state |

The judgement standard is simple: **at the start of the next session, would not knowing this cause an error?** If yes, record it. If no, do not. Recording more is not free — every memory takes catalog space, takes part in selection, and may be selected and crowd the context.

---

## Run Chapter 9

### Step 0: prepare the environment

```powershell
Set-Location 'F:\笔记\Agent实操\code'
node --version      # Needs Node 20 or above
npm install         # Run only the first time, or after the dependencies change
```

### Step 1: run the offline tests first (no API Key needed)

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch09
```

Expect to see:

```text
Test Files  23 passed (23)
     Tests  214 passed (214)
```

One line appears in the middle of the output:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**This is not an error.** It is an expected output that `config.test.ts` asserts actively — the test verifies "when the configuration is missing, the program must report an error explicitly instead of degrading silently". As long as the last line is `passed`, everything is normal.

### Step 2: let the Agent remember one thing

This step needs a real model. First confirm that `code\.env` has `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` set.

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch09 -- --prompt "Remember: the examples in this project use PowerShell only"
```

### Step 3: look at the three files on disk

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Get-ChildItem '.\.memory\' -Force | Format-Table Name, Length
```

Expect to see something like (the hexadecimal string in the file name that you get will differ):

```text
Name                                              Length
----                                              ------
MEMORY.md                                             86
manifest.json                                         72
powershell-examples-c60d6de8...426d.md               142
```

See what the manifest points to:

```powershell
Get-Content -LiteralPath '.\.memory\manifest.json' -Raw
```

See the catalog index (this is what the selector sees in every turn):

```powershell
Get-Content -LiteralPath '.\.memory\MEMORY.md' -Raw
```

See a memory body:

```powershell
Get-ChildItem '.\.memory\*.md' -Exclude 'MEMORY.md' |
  ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }
```

Expect to see the frontmatter-plus-body structure. If the model extracted no memory, the `.memory` directory may not exist — try again with a clearer prompt. For example, change "remember" to "please record this constraint; all command examples from now on must obey it".

### Step 4: switch to a new session, and verify that it really remembered

The key is that this is **a completely new process**. The previous turn's history does not exist at all:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 9 --prompt "What constraints do the command examples in this project have?"
```

If the memory works, the answer mentions PowerShell. This is exactly what chapter 8 cannot do — that chapter's summary and transcript also sit on disk, but the next process does not know that they exist at all.

### Step 5 (optional): the full gates

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run typecheck
npm run lint
```

### Cleanup

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item -Recurse -Force '.\.memory'
```

Two things need attention.

First, `.memory` **has no automatic cleanup mechanism**. It is the persistence layer. It is supposed to stay. But that also means the memories that your experiments accumulate keep affecting later runs. When the behavior seems strange, look at what is inside first.

Second, `code\.gitignore` currently does **not** ignore `.memory/`. In other words, memory files produced in this repository are visible to Git. When you move this mechanism into your own project, decide first: a memory may contain user preferences and internal project constraints. Should it be committed (team sharing) or ignored (personal local)? Both are reasonable, but it must be an explicit decision.

### Troubleshooting common errors

| What you see | Cause | What to do |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` (in the middle of the test output) | The expected output that `config.test.ts` asserts | Ignore it. Check whether the last line is `passed` |
| `Configuration Error: Missing required settings: ...` (exits directly after `npm run ch09`) | `code\.env` is not set | Copy `.env.example` to `.env` and fill in the three values |
| The `.memory` directory does not exist | The model extracted no memory this turn | Use a clearer prompt. Or check whether the extractor request failed |
| `memory name must be a safe lowercase slug` | The model returned a name with uppercase, a space, Chinese, or a path symbol | A normal interception. This turn does not commit. Retry with another prompt |
| `memory file must not exceed 200 lines` | The memory body is too long (the body limit is 194 lines) | A normal interception. Let the model write a tighter body |
| `memory file must not exceed 4096 UTF-8 bytes` | Same as above. A Chinese body reaches the top at about 1340 characters | Same as above |
| `memory model must not call tools` | In a side-query, the model tried to call a tool | A normal interception. Switch the model, or check whether you passed the tool definitions by mistake |
| `memory model finishReason must be stop, got length` | The JSON was truncated by the output length | Raise `max_tokens`. Or let the model extract fewer items |
| `memory model output is not valid JSON` | The model added a code fence or explanatory text | A normal interception. Switch to a more obedient model |
| `memory manifest has an invalid schema` | The manifest was broken by a hand edit | Fix it back against the format of this chapter. Or delete the whole `.memory` and start again |
| `memory root escapes workspace` | `.memory` was replaced with a symbolic link / junction | Delete the link, and let the runtime create a real directory itself |
| `memory names already exist: ...` | An extracted name duplicates an existing memory | Normal protection. It means this item was already recorded |
| `memory collection changed during consolidation` | A base record was changed by another process during consolidation | Normal protection. The next turn consolidates again |
| A memory was written but is not selected | The selector judges it irrelevant, or the fallback matches no keyword | Try putting a word from the memory's `description` into the query |

---

## Five Hands-on Experiments

None of these five experiments **calls a real model**. They need no API Key. After you run them, you can see all the core numbers of this chapter. First create a temporary directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType Directory -Force '.\scratch' | Out-Null
```

The output of each experiment below is from an actual run. The hexadecimal string in a file name is a random UUID. **What you get when you run it will differ from here.** That is normal.

### Experiment 1: what three things are actually on disk

Save it as `code\scratch\probe1-layout.ts`:

```typescript
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryRecord, MemoryStore, MemoryType } from "../chapters/ch09/src/features/memory.js";

const workspace = mkdtempSync(join(tmpdir(), "probe1-"));
const store = new MemoryStore({ workspace });

await store.add(
  new MemoryRecord({
    name: "tabs-style",
    description: "Tabs indentation preference",
    kind: MemoryType.USER,
    body: "Always indent with tabs.",
  }),
);

const root = join(workspace, ".memory");
console.log("Directory content =", readdirSync(root).sort());
console.log("manifest  =", readFileSync(join(root, "manifest.json"), "utf8"));
console.log("MEMORY.md =", JSON.stringify(readFileSync(join(root, "MEMORY.md"), "utf8")));

const recordFile = readdirSync(root).find((n) => n.startsWith("tabs-style-"));
console.log("Record file  =", JSON.stringify(readFileSync(join(root, recordFile!), "utf8")));
console.log("Record byte count =", readFileSync(join(root, recordFile!)).byteLength);

rmSync(workspace, { recursive: true, force: true });
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe1-layout.ts
```

Actual output:

```text
Directory content = [
  'MEMORY.md',
  'manifest.json',
  'tabs-style-868e19a8b31d414b9d579747f90bf933.md'
]
manifest  = {"version":1,"files":["tabs-style-868e19a8b31d414b9d579747f90bf933.md"]}
MEMORY.md = "- [tabs-style](tabs-style-868e19a8b31d414b9d579747f90bf933.md) - Tabs indentation preference\n"
Record file  = "---\nname: tabs-style\ndescription: Tabs indentation preference\ntype: user\n---\n\nAlways indent with tabs.\n"
Record byte count = 103
```

Printing with `JSON.stringify` here is deliberate — it shows the exact position of each `\n`. Note that after the `---` that ends the frontmatter in the record file, there is a **blank line**. That is the 6th line that the earlier line-budget calculation counted.

A memory with a body of only 24 characters takes 103 bytes on disk. The other 79 bytes are all frontmatter. That is also why the 4096-byte budget counts the whole file.

### Experiment 2: the exact boundaries of the two budgets and the name validation

Save it as `code\scratch\probe2-budget.ts`:

```typescript
import { MemoryRecord, MemoryType } from "../chapters/ch09/src/features/memory.js";

function tryBody(label: string, body: string): void {
  try {
    new MemoryRecord({ name: "probe", description: "d", kind: MemoryType.PROJECT, body });
    console.log(`${label}: pass`);
  } catch (error) {
    console.log(`${label}: reject -> ${(error as Error).message}`);
  }
}

console.log("--- Line budget ---");
for (const lines of [193, 194, 195]) {
  tryBody(`Body ${lines} lines`, Array(lines).fill("x").join("\n"));
}

console.log("--- Byte budget (one Chinese character = 3 bytes) ---");
for (const count of [1330, 1340, 1350, 1400]) {
  tryBody(`Body ${count} characters = ${count * 3} bytes`, "界".repeat(count));
}

console.log("--- Exact boundary scan ---");
for (let n = 1340; n <= 1360; n += 1) {
  try {
    new MemoryRecord({
      name: "probe",
      description: "d",
      kind: MemoryType.PROJECT,
      body: "界".repeat(n),
    });
  } catch {
    console.log(`First rejected character count: ${n} (body ${n * 3} bytes)`);
    break;
  }
}

console.log("--- Name validation ---");
for (const name of ["ok-name", "../escape", "has space", "UPPER", "com1", "trailing."]) {
  try {
    new MemoryRecord({ name, description: "d", kind: MemoryType.PROJECT, body: "b" });
    console.log(`${name.padEnd(12)}: pass`);
  } catch (error) {
    console.log(`${name.padEnd(12)}: reject -> ${(error as Error).message}`);
  }
}
```

Actual output:

```text
--- Line budget ---
Body 193 lines: pass
Body 194 lines: pass
Body 195 lines: reject -> memory file must not exceed 200 lines
--- Byte budget (one Chinese character = 3 bytes) ---
Body 1330 characters = 3990 bytes: pass
Body 1340 characters = 4020 bytes: pass
Body 1350 characters = 4050 bytes: reject -> memory file must not exceed 4096 UTF-8 bytes
Body 1400 characters = 4200 bytes: reject -> memory file must not exceed 4096 UTF-8 bytes
--- Exact boundary scan ---
First rejected character count: 1349 (body 4047 bytes)
```

**The body limit is 194 lines, not 200 lines.** A Chinese body passes up to 1348 characters. At 1349 characters it is rejected — a 4047-byte body plus the frontmatter already crosses 4096.

This 1348 was **measured with the shortest `description: "d"`**. Change it to a Chinese description of a dozen or so characters, the frontmatter grows, and the limit drops by a few characters. So do not memorise 1348 as a fixed value. Memorise "4096 counts the whole file, and the frontmatter also takes a share".

The name validation part:

```text
ok-name     : pass
../escape   : reject -> memory name must be a safe lowercase slug
has space   : reject -> memory name must be a safe lowercase slug
UPPER       : reject -> memory name must be a safe lowercase slug
com1        : reject -> memory name must be a safe lowercase slug
trailing.   : reject -> memory name must be a safe lowercase slug
```

Note `com1` and `trailing.` — both are completely legal on Linux. They are blocked specially for Windows.

### Experiment 3: selection, injection, and fallback

Save it as `code\scratch\probe3-select.ts`. This experiment uses a fake selector, so it needs no model:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryRecord, MemorySession, MemoryStore, MemoryType,
} from "../chapters/ch09/src/features/memory.js";
import type { MemorySelector } from "../chapters/ch09/src/features/memory.js";

const workspace = mkdtempSync(join(tmpdir(), "probe3-"));
const store = new MemoryStore({ workspace });

await store.extend([
  new MemoryRecord({
    name: "tabs-style", description: "Tabs indentation preference", kind: MemoryType.USER,
    body: "This repository always uses Tab indentation, not spaces.",
  }),
  new MemoryRecord({
    name: "database-rule", description: "Production database constraints", kind: MemoryType.FEEDBACK,
    body: "Tests must connect to the real integration database. Mocking is forbidden.",
  }),
]);

// A. The selector works normally
const ok: MemorySelector = { async select() { return '["database-rule"]'; } };
const session = new MemorySession({ store, selector: ok });
await session.beginTurn("How do database tests run?");
console.log("A. Normal selection =", session.selected.map((r) => r.name));
console.log("   Injected message count =", session.beforeModel().length);
console.log(session.beforeModel()[0]?.content);

// B. The selector fails, deterministic fallback
const dead: MemorySelector = { async select() { throw new Error("offline"); } };
const fallback = new MemorySession({ store, selector: dead });
await fallback.beginTurn("Check database integration");
console.log("B. Fallback selection =", fallback.selected.map((r) => r.name));
console.log("   lastError =", fallback.lastError);

// C. The selector returns a name that does not exist
const bogus: MemorySelector = { async select() { return '["no-such-memory"]'; } };
const rejected = new MemorySession({ store, selector: bogus });
await rejected.beginTurn("tab or spaces?");
console.log("C. Unknown name =", rejected.selected.map((r) => r.name));

// D. Nothing matches at all
const none = new MemorySession({ store, selector: dead });
await none.beginTurn("weather forecast");
console.log("D. No-match injected count =", none.beforeModel().length);

rmSync(workspace, { recursive: true, force: true });
```

Actual output:

```text
A. Normal selection = [ 'database-rule' ]
   Injected message count = 1
<relevant_memories>

## database-rule (feedback)

Production database constraints

Tests must connect to the real integration database. Mocking is forbidden.

</relevant_memories>
B. Fallback selection = [ 'database-rule' ]
   lastError = Memory selection failed; deterministic fallback used
C. Unknown name = [ 'database-rule', 'tabs-style' ]
D. No-match injected count = 0
```

A and B give the same result, but the path is completely different: A is the model's selection, B is keyword matching. B's `lastError` records the degradation explicitly — this information is not lost, it only does not affect the main task.

**The C output is worth stopping to look at.** The query is "tab or spaces?", and `database-rule` ranks first. Why?

Because the fallback matching is **substring matching**. The tokens cut from the query include `tab`, and the name `database-rule` contains `tab` inside `database`:

```text
database-rule → not "data-tab-ase". It is the tab in "da-tab-ase"
                  ↑↑↑
```

Both memories score 1 point. On an equal score, the sort is by name, and `database-rule` comes first alphabetically.

This is a real limitation of the deterministic fallback, not a bug — it is a string match, and it does not understand semantics. It is written into the tutorial because you will meet the same class of case when you use this fallback in your own project: `data` matches `metadata`, and `test` matches `latest`. The position of the fallback is "when the model is unavailable, do not select completely blindly". It is not "as accurate as the model".

### Experiment 4: a local consolidation does not touch an unrelated memory

Save it as `code\scratch\probe4-consolidate.ts` (imports omitted; same source as experiment 3):

```typescript
await store.extend([
  record("tabs-old", "Old indentation preference", "Use tabs."),
  record("tabs-new", "New indentation preference", "Confirmed: use tabs, not spaces."),
  record("unrelated", "Unrelated reference material", "The bug is recorded in Linear INGEST."),
]);

console.log("Before consolidation =", (await store.records()).map((r) => r.name));
console.log("Files before consolidation =", readdirSync(root).filter((n) => n.endsWith(".md")).sort());

// Declares only tabs-old and tabs-new as replaced. unrelated is not mentioned
const consolidator: MemoryConsolidator = {
  async consolidate() {
    return JSON.stringify({
      source_names: ["tabs-old", "tabs-new"],
      records: [
        { name: "tabs", type: "user", description: "Indentation preference", body: "This repository uses tabs, not spaces." },
      ],
    });
  },
};

const session = new MemorySession({ store, consolidator, consolidateThreshold: 2 });
await session.complete([userMessage("done"), assistantMessage("done")]);

console.log("After consolidation =", (await store.records()).map((r) => r.name));
console.log("Files after consolidation =", readdirSync(root).filter((n) => n.endsWith(".md")).sort());
```

Actual output (file names shortened so the change is visible):

```text
Before consolidation = [ 'tabs-old', 'tabs-new', 'unrelated' ]
Files before consolidation = [ 'MEMORY.md',
  'tabs-new-95df2404....md',
  'tabs-old-9f16a0d1....md',
  'unrelated-deb1cbc1a8bd47a1970b38d19ec97ce3.md' ]

After consolidation = [ 'unrelated', 'tabs' ]
Files after consolidation = [ 'MEMORY.md',
  'tabs-0dcc0132....md',
  'unrelated-deb1cbc1a8bd47a1970b38d19ec97ce3.md' ]
lastError = undefined
```

Three things happened together:

1. `tabs-old` and `tabs-new` merged into `tabs`, and both old files were deleted.
2. `unrelated` is still there — its **file name did not change by one character** (`deb1cbc1a8bd...`). This proves that it was not rewritten. It stayed exactly as it was.
3. The new `tabs` has a completely new file name. It does not overwrite an old file.

The second half of the script tries an illegal consolidation:

```typescript
const bad: MemoryConsolidator = {
  async consolidate() { return JSON.stringify({ source_names: ["tabs"], records: [] }); },
};
```

```text
After empty records = [ 'unrelated', 'tabs' ]
lastError = Memory consolidation failed
```

Empty `records` is rejected, and the set stays as it was. Without this block, a model returning an empty array would mean "delete `tabs`" — while it expressed no deletion intent at all.

### Experiment 5: the manifest is the authority

Save it as `code\scratch\probe5-manifest.ts` (imports and the store creation omitted, same source as experiment 1; `root` is `join(workspace, ".memory")`). This experiment directly verifies the core architecture decision of this chapter:

```typescript
await store.add(new MemoryRecord({
  name: "registered", description: "A registered memory",
  kind: MemoryType.PROJECT, body: "This one is in the manifest.",
}));

// Place a file by hand that is completely legal in format, but not registered in the manifest
writeFileSync(
  join(root, "sneaky-deadbeef.md"),
  "---\nname: sneaky\ndescription: An unregistered memory\ntype: project\n---\n\nThis one is not in the manifest.\n",
  "utf8",
);

console.log("The .md files in the directory =", readdirSync(root).filter((n) => n.endsWith(".md")).sort());
console.log("manifest     =", readFileSync(join(root, "manifest.json"), "utf8").trim());
console.log("records()    =", (await store.records()).map((r) => r.name));
console.log("renderCatalog():");
console.log(await store.renderCatalog());

// Delete the derived view, and see whether it affects the facts
rmSync(join(root, "MEMORY.md"));
console.log("records() after deleting MEMORY.md =", (await store.records()).map((r) => r.name));

// Break the manifest
writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: true, files: [] }), "utf8");
try {
  await new MemoryStore({ workspace }).records();
  console.log("Bad manifest: it passed, unexpectedly");
} catch (error) {
  console.log("Bad manifest: reject ->", (error as Error).message);
}
```

Actual output:

```text
The .md files in the directory = [ 'MEMORY.md', 'registered-f761ce9c....md', 'sneaky-deadbeef.md' ]
manifest     = {"version":1,"files":["registered-f761ce9caec64b4891591468368924c4.md"]}
records()    = [ 'registered' ]
renderCatalog():
- [registered](registered-f761ce9caec64b4891591468368924c4.md) - A registered memory

records() after deleting MEMORY.md = [ 'registered' ]
Bad manifest: reject -> memory manifest has an invalid schema
```

All three conclusions are visible at once:

| What was done | Result | What it proves |
| --- | --- | --- |
| Place a legal but unregistered `.md` | It is not in `records()` | **A directory-scan implementation would read it. This chapter does not** |
| Delete `MEMORY.md` | `records()` returns as usual | It is a derived view. It carries no fact responsibility |
| Change `version` to `true` | An explicit error | A broken authority pointer must report an error. It cannot be treated as an empty set |

The first row is the core value of this architecture. If the implementation scanned the directory, that `sneaky-deadbeef.md` would be treated as a valid memory and injected into the model context — while it may be stale content left by a previous failed consolidation, or something else entirely.

### Cleanup

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item -Recurse -Force '.\scratch'
```

---

## What This Chapter Does Not Do

Claiming a capability that the tutorial does not have is the easiest trap to fall into. State the boundaries clearly:

| Already has | Does not have yet | When to add it |
| --- | --- | --- |
| Keyword matching on name + description | Vector retrieval, semantic recall | **Will not add**. See the trade-off in "Why choose the file system" |
| Consolidation triggered when the candidate count reaches the threshold | A 24-hour interval, a session count, lock mtime expiry gates | **Will not add**. A deliberate teaching simplification. A real project should add them |
| Single-model side-query extraction and consolidation | An independent Reviewer review, evidence citations | **Will not add**. See "What to learn from ai-agent-book" |
| Offline tests cover mechanism correctness | Memory quality evaluation, LLM-as-judge | **Will not add**. This is the next step to take. It is not in this chapter's scope |
| A chapter 9 context message injection | The dynamic Prompt `memory` section | Chapter 10 |
| `MemoryStore` transactions and locks | Memory time decay, importance scoring | **Will not add**. It needs extra scoring dimensions and history versions |
| Two layers: frontmatter + body | Nested slots, person/relationship, versioned conflict fields | **Will not add**. It makes the format complexity exceed the teaching benefit |
| An extraction failure records `lastError` | Report `lastError` to the user or to monitoring | **Will not add**. That is observability. The memory module must not decide it |
| `.memory` persists | Automatic cleanup, redaction, encryption | **Will not add**. A persistence layer is supposed to stay |

Two rows need special emphasis.

**There is no semantic retrieval.** Query "what do we use for indentation". If a memory's `description` says "code style convention", the selector may pick it (the model understands semantics). But the deterministic fallback certainly cannot (there is no common string). This means how you write the `description` directly affects the usability of the fallback — prefer words that the user might really say out loud.

**There is no memory quality evaluation.** All 214 tests in this chapter verify "is the mechanism correct": is a write atomic, does a failure lose nothing, are the boundaries kept. **Not one test verifies "is the remembered content useful".** These two things are completely different. The second needs an evaluation set, and it is the next step of work.

---

## Differences from Claude Code

The Claude Code memory is dual-track: `CLAUDE.md` provides hand-written persistent instructions that load across sessions, and auto memory lets Claude record build commands, debugging experience, and preferences itself. Auto memory is on by default, and the `/memory` command can view and edit it (official documentation: [How Claude remembers your project](https://code.claude.com/docs/en/memory.md)). This teaching edition implements only the single-track auto-memory-style `MemoryStore`. But it emphasises auditable set transactions more than the reference implementation.

**Storage and index.** The Claude Code auto memory is stored in `~/.claude/projects/<sanitized-git-root>/memory/`. It is isolated by git repository and shared across worktrees. In each project directory, `MEMORY.md` is the entry index, and Claude reads and writes topic files on demand with the standard file tools. P09 puts the memory in the workspace-local `.memory/`. It uses `manifest.json` as the single authority pointer and `MEMORY.md` as a rebuildable derived view. So it never treats an unregistered or incompletely committed `.md` in the directory as a valid memory. The reference implementation scans the directory directly. The teaching edition trades a manifest for a clearer commit boundary.

**Budget and selection.** Each session, Claude Code loads the first 200 lines or 25KB of `MEMORY.md` (the frontmatter and block-level HTML comments do not count). It reads topic files on demand. The selector picks at most 5 items, and the memory content budget of one session is about 60KB. The P09 derived catalog is also constrained by 200 lines by default. But its byte budget defaults to only 4096, and a record file is also under the 200-line / 4096-byte limits at the same time. The selector also picks at most 5 items, and on a side-query failure it degrades to deterministic keyword matching.

**Extraction and consolidation.** Claude Code uses a restricted subagent to extract asynchronously in a stop hook. Consolidation (Dream) has four gate layers: at least 24 hours since the last merge, scan throttling, at least 5 session transcripts changed since the last merge, and it holds the merge lock. The P09 extraction is a tool-free side-query of the same model. A failure only records `lastError` and does not interrupt the main task. Consolidation triggers only when the candidate count reaches the threshold (default 10). It has no time, session-count, or lock mtime gate. This is a deliberate teaching simplification.

**Concurrency and failure boundaries.** The Agent itself writes the Claude Code memory directory with file tools. When `MEMORY.md` exceeds its limit, it returns a "memory index is over its read limit" error. The consolidation stage has a `.consolidate-lock` and stale recovery. P09 pushes the concurrency problem down into `MemoryStore`: an in-process Promise tail chain + a cross-process `proper-lockfile`. Every read-modify-write takes the lock first, then commits the manifest with fsync + atomic replacement. During consolidation, it also re-reads the base records inside the lock, and fails at once if it finds a concurrent change. For a tutorial reader, the P09 transaction model is more conservative than Claude Code. It suits as a reference when you implement long-term memory yourself.

One architecture difference deserves attention: **Claude Code lets the Agent read and write memory with ordinary file tools. P09 does not let the model touch files.** In P09, the model only returns JSON (which to select, what to extract, how to merge). `MemoryStore` executes all disk writes. The cost is that the model has less flexibility (it cannot organise the file structure itself). The return is that every write passes through the same validation and transaction set.

---

## What to Learn from ai-agent-book: Set the Evaluation First, Then Talk About Storage

In the external repository [`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book), `book/chapter3.md` (the companion experiments are in `chapter3/`) is the closest comparison for this chapter: it also splits "cross-session memory" into a trajectory layer and a long-term memory layer, and it covers memory representation, retrieval, consolidation, and evaluation. P09 is the minimal teaching file implementation. ai-agent-book shows the complete production path. After the comparison, you can distinguish more clearly "which designs P09 already has" and "which capabilities only a later extension needs to add".

| Key design in ai-agent-book | P09 counterpart | Difference and boundary |
| --- | --- | --- |
| A trajectory is the append-only raw event record of the current session. Long-term memory is distilled knowledge that survives across sessions and can be rewritten | Canonical history approximates the trajectory. MemoryStore approximates long-term memory | The P09 canonical history stays complete only during a run. The chapter 8 transcript handles the cross-run record. A memory record saves no evidence ID |
| Working memory is a dynamic subset of long-term memory, activated by relevance | The request history + `<relevant_memories>` are injected only in a model request | Memory selection serves this request after `beginTurn`. It is not appended to canonical history |
| Four storage formats: Simple Notes, Enhanced Notes, JSON Cards, Advanced JSON Cards | The `.md` frontmatter + body is close to Enhanced Notes | No nested slots, backstory, person/relationship, or versioned conflict fields |
| Memory compression: importance scoring, clustering, abstraction, versioned conflict detection | At the threshold, the consolidator returns `source_names` and a new set | P09 does no scoring, clustering, or time decay, and it keeps no history versions |
| The file system paradigm OpenViking: an L0 summary, an L1 overview, and L2 full text loaded on demand | `MEMORY.md` is the bounded catalog. `<name>-<id>.md` is the body on demand | P09 uses the manifest as the authority commit boundary, which is stricter than a directory scan. But it has no link navigation between files |
| Incremental update + periodic full consolidation, with Proposer/Reviewer PR review | The extractor extracts incrementally each turn. At the threshold, one consolidation commits | P09 is a single-model side-query. It has no independent Reviewer, no evidence citation, and no PR review |
| Dual-layer memory: a resident overview of Advanced JSON Cards + context-aware RAG for the details | A resident catalog for selection, a body injected on demand | P09 has no vector retrieval, semantic recall, conflict resolution, or proactive service |
| Three-level evaluation: basic recall, multi-session retrieval, proactive service | Offline tests cover mechanism correctness | P09 has no three-level memory evaluation, and it does not use LLM-as-judge to verify memory quality |

The most valuable lesson from ai-agent-book is the order: first define "what counts as a good memory system" as a three-level evaluation framework, then design storage and retrieval. Experiment 3-1 builds 20 cases per level, 60 in total. Experiment 3-2 switches four storage formats under one unified interface, and uses the same session and query set to compare the extraction shape and the final score of Simple Notes, Enhanced Notes, JSON Cards, and Advanced JSON Cards. This order — "set the ruler first, then run the experiment" — exposes memory quality problems better than testing only "did the file write succeed".

Another point worth comparing is knowledge update. ai-agent-book proposes treating both incremental update and periodic consolidation as a code repository PR: a Proposer Agent proposes a diff from the original evidence, and a Reviewer Agent from a different source independently checks the evidence and the conflicts. After it passes, the derived index is rebuilt. P09 already separates three things at the storage layer: "the original canonical history, the consolidated records, the rebuildable MEMORY.md". And it uses an atomic manifest commit to avoid a half-written state. But extraction and consolidation are still one fixed side-query. There is no review stage, and a record saves neither "which evidence segment it came from" nor "when it was approved".

Therefore, the strength of P09 is not "higher memory quality". It is "more auditable boundaries": a single manifest authority, a cross-process lock, an atomic replacement after fsync, a deterministic degradation on selection failure, and three explicit life cycle points — `beginTurn` / `beforeModel` / `complete`. The contribution of ai-agent-book is to add quality, retrieval, conflict, and review as independent dimensions. If you evolve P09 further, add a memory evaluation set, evidence citations, and Reviewer review first — not a vector database.

---

## Companion Code Index

The chapter 9 implementation is concentrated in `code/chapters/ch09/src/`. The chapter entry fixes the P09 Profile. The `features/compaction.ts` from the previous chapter keeps handling request-level compaction and artifact persistence. This chapter adds `features/memory.ts`, and it connects to AgentRunner through the `TurnLifecycle` in `core/loop.ts`.

- Feature implementation: `code/chapters/ch09/src/features/memory.ts`
- Composition root: `code/chapters/ch09/src/bootstrap.ts`
- Life cycle: `code/chapters/ch09/src/core/loop.ts`
- Capabilities and profile: `code/chapters/ch09/src/core/profiles.ts`
- Chapter entry: `code/chapters/ch09/src/chapters/ch09.ts`
- Compaction boundary: `code/chapters/ch09/src/features/compaction.ts`
- Direct behavior tests: `code/chapters/ch09/tests/memory.test.ts`
- Wiring tests: `code/chapters/ch09/tests/ch09-memory.test.ts`
- Loop boundary tests: `code/chapters/ch09/tests/loop-processors.test.ts`

Read from top to bottom, the three classes in `memory.ts` divide the work like this:

```text
MemoryRecord    ← One memory. The constructor validates. Immutable
     ↑
MemoryStore     ← The transaction entry of the set: lock, manifest, atomic commit
     ↑
MemorySession   ← The turn life cycle: select / inject / extract / consolidate
     ↑
AgentRunner     ← Calls through the TurnLifecycle interface. It does not know that memory exists
```

The last line deserves attention: `AgentRunner` knows only the `TurnLifecycle` interface (three methods: `beginTurn` / `beforeModel` / `complete`). It knows nothing about what memory is. So you can remove the memory capability as a whole, and the Loop does not change by one line.

| Implementation | Responsibility and boundary |
| --- | --- |
| `MemoryRecord` | The immutable memory value object. It validates a safe slug, a single-line description, the `MemoryType`, and the body budget. After serialization, it runs the 200-line / 4096-byte limits again |
| `MemoryStore.records()` / `renderCatalog()` | Trusts only the set in the manifest. Before a read, it validates the workspace, the `.memory` realpath, the manifest schema, and each record, and it re-reads under the lock |
| `MemoryStore.add()` / `extend()` | Appends only a new memory that does not exist in the current set. It generates a unique file name, creates the record file exclusively, reads back to verify after fsync, then commits the index and the manifest atomically |
| `MemoryStore.applyConsolidation()` | Re-reads the manifest inside the lock. It validates that `baseRecords` did not change. It keeps the uninvolved records and the concurrent additions. It replaces by `source_names`, then commits once |
| `ModelMemoryQueries` | The selector / extractor / consolidator share one tool-free model boundary. It requires `finishReason === "stop"` and a non-empty full-text JSON. It does not cut a substring from a fence or explanatory text |
| `MemorySession` | Before a turn, select the memories. Before a request, inject `<relevant_memories>`. After a turn, extract and consolidate from the complete canonical history. A failure only records `lastError`. It does not interrupt the main task |
| `keywordSelect` | The deterministic fallback after a side-query failure. English uses tokens of at least 3 characters. Chinese uses bigrams. On an equal score, sort stably by name |
| `atomicReplace()` / in-process mutual exclusion / `proper-lockfile` | A temporary file in the same directory + fsync + rename, so a reader never sees a half-written file. An in-process Promise tail chain and a cross-process file lock serialise the file transactions together |
| `TurnLifecycle` | `beginTurn` runs before the first model request of a turn. `beforeModel` affects only the next model request. `complete` closes with the complete canonical history |
| `bootstrap.createMemorySession()` | Assembles `MemoryStore` and `ModelMemoryQueries` into a `MemorySession`, and decides the injection by the profile capability bit |
| `P09` | Adds `memory` on top of the P08 capabilities, so one AgentRunner has both request-level compaction and cross-session file memory |
| `ch09.ts` | Fixes the chapter entry to P09, and prevents this entry from enabling other capabilities by accident |
| `CompactionManager` | A capability inherited from chapter 8. Compaction rewrites only the request history. Canonical history stays complete, so the memory extractor can still read the original session |

---

## Run and Verify

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch09 -- --prompt "Remember: the examples in this project use PowerShell only"
npm run agent-tutorial -- run --chapter 9 --prompt "What constraints do the command examples in this project have?"
```

Offline behavior verification covers cross-instance selection, strict side-queries, path boundaries, write faults, local consolidation, and a concurrent addition during consolidation:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch09
```

Current result: `Test Files 23 passed (23)`, `Tests 214 passed (214)`.

---

## Chapter Summary

### The three-sentence version

1. Memory is a set of `.md` files on disk. It does not take part in compaction. It survives across sessions and across processes.
2. `manifest.json` is the single authority pointer of the current set. `MEMORY.md` is only a rebuildable derived view.
3. Any failure of the memory mechanism only records `lastError`, and the main task completes as usual — unless the authority pointer itself is broken.

### Nine rules to remember

| # | Conclusion | In which section |
| ---: | --- | --- |
| 1 | Reading the set trusts only the manifest. An unregistered `.md` in the directory is always ignored | One set, two derived views / Experiment 5 |
| 2 | Extraction must read canonical history. Reading request history misses the user messages that snip cut | Write: extract from canonical history |
| 3 | The extractor cannot see a fact in the middle of a large ToolResult. Read the artifact back first | Same as above |
| 4 | The body limit is **194 lines**, not 200 — the frontmatter takes 6 lines | Two budgets / Experiment 2 |
| 5 | The 4096 bytes count the whole file, and the frontmatter also takes a share. A Chinese body reaches the top at about 1340 characters | Same as above |
| 6 | A side-query must have `finishReason === "stop"`. At `length`, a `"[]"` is a truncation, not an empty result | The three hard requirements for a side-query |
| 7 | One invalid item in an extraction batch means the whole batch is not committed. The legal items are not written either | The output contract of the extractor |
| 8 | A consolidation must declare `source_names`. A memory not listed must be kept | Consolidate: declare the replacement sources first |
| 9 | The atomic manifest replacement is the commit point. A crash before it leaves the old set complete and undamaged | Commit order |

### Check whether you really understood

1. With the memory capability on, how many extra model calls does one turn cost at most? How many when the set is empty? (Look at memory really working across sessions first)
2. You place a completely legal `.md` in `.memory` by hand. Is it injected into the model context? (Experiment 5)
3. You delete `MEMORY.md`. Can `records()` still read the memories? (Experiment 5)
4. A constraint that the user stated in turn 3 — can it still be extracted in turn 40? Why? (Write: canonical vs request)
5. A constraint on line 400 of a 30KB configuration file — can the extractor extract it? (The large ToolResult exception)
6. What happens when the body has 195 lines? What about 194 lines? (Experiment 2)
7. A side-query returns `finishReason: "length"` and the body is `"[]"`. Is it treated as "no memory"? (The side-query hard requirements)
8. The extraction returns 3 items, and the name of item 2 is `../bad`. How many are finally written? (The output contract of the extractor)
9. A consolidation declares only 2 replacements. What happens to the other 5 memories in the set? (Experiment 4)
10. When the manifest replacement fails, what is the state on disk? Is memory lost? (Commit order / failure matrix)
11. After the selector throws, does the main Agent still answer the user normally? (Failure matrix)
12. With the query "tab or spaces?", why does the fallback select `database-rule`? (Experiment 3 C)

---

## Memory Solves Across Sessions, the Next Chapter Solves the Prompt Itself

What this chapter can directly guarantee now is: the memory set uses the manifest as the single authority commit boundary; a write passes through fsync plus atomic replacement, and no mid-way failure loses the old set; extraction reads the complete canonical history, unaffected by request-level compaction; a selection failure degrades to deterministic keyword matching, and does not block the main task; cross-process concurrency is serialised by two lock layers.

It does not implement semantic retrieval. It has no consolidation time or session gate. It has no Reviewer review or evidence citation. And it has no memory quality evaluation. You must decide yourself whether `.memory` enters version control.

On-demand loading takes less. Context compaction sheds load in time. File-level memory remembers for next time — the three things are complete here.

But the cost is that the system prompt gets messier and messier. The tool list, the workspace explanation, the Skill catalog, the selected memories — every new capability pushes one more segment into that string, and by now nobody dares to change it. The next chapter handles this problem: tools, workspace, Skills, and selected memories are all assembled from runtime state. Nobody maintains a pot of hard-coded strings any more.
