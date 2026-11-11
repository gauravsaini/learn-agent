Before the project ran, I prepared three documents for the Agent: a TypeScript code style guide, a SQL style guide, and API design conventions. Together they ran to several thousand lines.

The most direct approach is to stuff all of them into the System Prompt. The result: every time the Agent requests the model — whether it is changing one line of a comment or designing a table — it carries the full set of documents. Most of the content has nothing to do with the current task, but it occupies the context on every turn.

Worse, the conventions keep growing. Every time a new document is added, the System Prompt inflates by another chunk. The previous chapter just used Subagents to isolate exploration traces; stuffing static knowledge into the context all at once here is clearly not worth it.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaEqiby9nHnFAthU3CsU1lt3JWQru7hurkR5HzZ6RhpV93s1Kvd1LM8YhIibos9yLr4aO7bqJtXtGYPiaNscJHPSfP7FWlUvycWdFY/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter guide

### What you can do after this chapter

1. Explain why the "knowledge catalog" and the "knowledge body" must enter the context at two separate levels, and where the cost of each one lies.
2. Write a `SKILL.md` that passes validation, and know how to write a `description` so the model does not trigger it by mistake.
3. Explain why `load_skill` accepts only a `name` and not a `path` — this is not convenience, it is a security boundary.
4. Recount the full trace of one load: the catalog enters the System Prompt, the body enters the tool result, and the two never swap places.
5. Explain why the scan does not decode the body, while the load revalidates every path **again**.
6. Point out the deliberate asymmetry between the parent Agent and the subagent for Skills (the subagent has the tool, but no catalog).

### What you need first

| Prerequisite | From which chapter | How this chapter uses it |
| --- | --- | --- |
| `ToolRegistry` generates parameter definitions from a Zod schema and revalidates before a call | Chapters 1, 2 | `load_skill` does not maintain a separate JSON Schema |
| Workspace hard boundary and path component validation | Chapter 2 | Skill paths reuse the same `isWindowsReservedComponent` |
| Permission policy and audit | Chapter 3 | `load_skill` is `read`; it does not pop up an approval, but it still enters the audit |
| The four Hook events | Chapter 4 | `load_skill` still triggers `PreToolUse` / `PostToolUse` |
| `task` delegation and subagent isolation | Chapter 6 | The subagent can use `load_skill`, but cannot see the parent catalog |

### Quick term reference (terms that first appear in this chapter)

| Term | One-line explanation |
| --- | --- |
| Skill | One directory + one `SKILL.md`, holding a piece of convention or process knowledge that loads on demand |
| frontmatter | The YAML metadata at the start of `SKILL.md`, enclosed by two `---` lines |
| Body | All content after the second `---`; the actual guidance text |
| Catalog | The list of "name + one-line description" for all Skills; it enters the System Prompt |
| Two-level loading | The catalog stays resident, the body loads on demand — the core design of this chapter |
| `load_skill` | The tool this chapter adds; its input is a single `name`, and it returns the body |
| Snapshot | The immutable metadata scanned at the moment the Agent is built; it does not change at run time |
| Path re-check | At load time, resolve each directory level again with `realpath`, to guard against a link swap after the scan |
| Byte budget | The catalog limit counts actual UTF-8 bytes, not the string `length` |
| Whole-entry truncation | When the budget is not enough, drop the whole entry; never insert half a line of description |
| Routing | The model reads the `description` and decides "should I load this Skill" |
| `Use when / Don't use for` | A description style that makes routing more accurate: give positive examples and counter-examples |

### Suggested reading route

```text
Chapter guide (you are here)
  ↓
① Look at one real load first   ← What is in the catalog, and when the body appears
  ↓
② Knowledge management ≠ knowledge loading   ← The two-level model and its real cost
  ↓
③ Acceptance contract   ← The six rules this chapter pins down
  ↓
④ Catalog and manifest contract   ← How to write a legal SKILL.md
  ↓
⑤ The scan reads only the frontmatter   ← Why the startup cost does not grow with the body
  ↓
⑥ load_skill input and re-check   ← Why the name cannot be swapped for a path
  ↓
⑦ Connect to the Tool Registry   ← The parent/child asymmetry
  ↓
⑧ Change comparison + differences from the official version   ← What chapter 7 adds over chapter 6, and how it differs from the real Claude Code
  ↓
⑨ Offline tests + run + troubleshooting   ← Hands-on + experiments + self-test
```

---

## Look at one real load first

Abstract talk about "two-level loading" is no match for looking at one real run. Everything in this section comes from `code/chapters/ch07/tests/ch07-skills.test.ts`. It is asserted, real data, not a sketch.

The workspace has only one Skill:

```text
<workspace>/
  skills/
    python-style/
      SKILL.md
```

The content of `SKILL.md` is:

```text
---
name: python-style
description: Python project conventions
---
# Python Style

Use pathlib for filesystem paths.
```

After the Agent is built, when it requests the model for the first time, the System Prompt the model receives looks like this:

```text
You are a coding agent. Use tools when needed, inspect their results, and answer accurately.
For complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.

Available workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:
- **python-style**: Python project conventions
```

Please put your attention on what **does not appear**:

| Does it appear in the first request | Content | Test assertion |
| --- | --- | --- |
| ✅ Appears | `python-style` | `expect(initialPrompt).toContain("python-style")` |
| ✅ Appears | `Python project conventions` | `expect(initialPrompt).toContain("Python project conventions")` |
| ❌ Does not appear | `Use pathlib` | `expect(initialPrompt).not.toContain("Use pathlib")` |

In other words: **the model knows this Skill exists and knows what it governs, but it has not seen a single word of the body.**

The model then calls `load_skill` on its own. Message 3 in the parent history (index 2) is asserted as:

```typescript
expect(result.history[2]).toEqual({
  role: "tool",
  content: "# Python Style\n\nUse pathlib for filesystem paths.\n",
  toolCallId: "skill-1",
});
```

Three details are worth a pause:

1. It returns the **body**, not the complete `SKILL.md`. The four frontmatter lines did not enter the context — they are for the scanner, not for the model.
2. It does not return a **file path**. The model gets the content; it does not need to send another `read_file`.
3. The `toolCallId` pairs with that call from the model. This is still the chapter 1 invariant: every `tool_call` must have a paired result.

The same test also asserts the tool list the model sees. The order is fixed:

```typescript
expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
  "shell", "read_file", "write_file", "edit_file", "glob", "todo_write", "task", "load_skill",
]);
```

8 tools, and `load_skill` is last — because the composition root deliberately registers it after `task`.

### Does loading the body need a human to click "agree"?

No. The approver this test passes in is the one that throws:

```typescript
class UnexpectedApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    throw new Error("load_skill should not request approval");
  }
}
```

The test passes, which shows that this `decide()` was never called. But the audit did record it:

```typescript
expect(audit.tools).toEqual(["load_skill"]);
```

**No approval popup ≠ unmanaged.** The effect class of `load_skill` is `"read"`. The default rules do not block read operations, so no box pops up. But it still goes through the full permission pipeline, still leaves an audit record, and still triggers the `PreToolUse` / `PostToolUse` of chapter 4.

### What the subagent sees when it loads a Skill

The third integration test has the parent Agent call `task`, and the subagent calls `load_skill` in its own history. One assertion in the result is especially worth noting:

```typescript
expect(model.requests[1]?.tools.map((tool) => tool.function.name)).toEqual([
  "shell", "read_file", "write_file", "edit_file", "glob", "todo_write", "load_skill",
]);
expect(model.requests[1]?.messages[0]?.content).not.toContain("python-style");
```

The subagent's tool list **has** `load_skill` (7 tools, no `task` — recursion stays off), but its System Prompt **does not have** the catalog. The section "Connect to the existing Tool Registry" explains why this asymmetry is deliberate.

---

## Knowledge management and knowledge loading are two different things

Beginners most easily mix these two into one: "I want the Agent to know this convention", so they paste the convention into the System Prompt. But that sentence actually contains two independent needs:

- **Knowledge management**: which conventions exist in the system in total? (The model must know, or it cannot even choose.)
- **Knowledge loading**: which convention's body does this task need? (Pay the context cost only when needed.)

Merging the two into one means paying for all conventions on every turn. Chapter 7 uses two-level loading:

| Level | Content that enters the context | Injection time | Default limit |
| --- | --- | --- | --- |
| Skill catalog | Name + one-line description | Enters the System Prompt when the chapter 7 Agent is built | 100 entries, 8000 UTF-8 bytes |
| Skill body | The body after the `SKILL.md` frontmatter | Enters the tool result after the model explicitly calls `load_skill` | One registered Skill per load |

Use one diagram to see the two-level loading timeline (assume 3 Skills, each body 2000 lines):

```text
[The "stuff everything into the System Prompt" approach]
Request 1  system: Convention A (2000 lines) + Convention B (2000 lines) + Convention C (2000 lines) + ...
Request 2  system: Convention A (2000 lines) + Convention B (2000 lines) + Convention C (2000 lines) + ...
Request 3  system: Convention A (2000 lines) + Convention B (2000 lines) + Convention C (2000 lines) + ...
        ↑ 6000 lines ride along on every turn, and at least 4000 of them are unrelated to the current task

[Chapter 7's two-level loading]
Request 1  system: catalog (3 lines) ← the model only knows "A/B/C exist and what each governs"
  ↓ The model judges that this task needs B and calls load_skill("Convention B")
Request 2  system: catalog (3 lines) + the history now holds Convention B's 2000-line body
Request 3  system: catalog (3 lines) + the history still holds Convention B's 2000-line body
        ↑ The bodies of Convention A and Convention C never entered the context at all
```

The catalog lets the model choose. The body pays the context cost only when it is really needed. The catalog is sorted by name and truncated by whole entries. It never inserts half a line of description into the Prompt just to fit the budget.

The catalog in this chapter is a snapshot taken when the Agent is built. A Skill added at run time enters the catalog only after the Agent is rebuilt. The body of a registered Skill, in contrast, is read and validated again on every `load_skill`. One test pins this down directly:

```typescript
const registry = SkillRegistry.scan(workspace);   // Scan first (there is no Skill yet)
await writeSkill(workspace, "alpha", { body: "first body" });
expect(registry.names).toEqual([]);               // ← A newly added Skill does not enter the old snapshot

const refreshed = SkillRegistry.scan(workspace);  // Only a rescan sees it
// Then change both the description and the body of SKILL.md...
expect(refreshed.renderCatalog()).toBe("- **alpha**: A test skill.");  // The catalog still shows the old description
await expect(refreshed.loadSkill("alpha")).resolves.toBe("second body"); // But the body is the new one
```

In the same registry, **the catalog is frozen and the body is read fresh**. This is not a bug; it is a deliberate trade-off: the catalog must stay stable to reuse the KV Cache, and the body must be read fresh so an edit takes effect at once. Only in chapter 10 will the System Prompt be rendered per turn by a dynamic provider.

One point that is easy to misunderstand needs a clarification here: the catalog is a stable prefix, so it can reuse the KV Cache. But "KV Cache friendly" does not mean "zero cost". At the start of a session, the catalog itself still needs one prefill. After that, it stays fixed at its original position in the System Prompt, and later turns can read it from the cache. When a Skill body is loaded for the first time, the body also needs a prefill first; after that, it is reused from the cache as part of the session history. The gain comes from two points: at startup, there is no need to read all Skill bodies into the Prompt; later, loading a new Skill does not rewrite the already cached prefix.

---

## Chapter 7's acceptance contract

List the conclusions this chapter pins down first. Every later section explains one of them, and the section "Prove the behavior with offline tests" verifies them one by one.

| # | Contract | What the opposite looks like |
| ---: | --- | --- |
| 1 | The catalog contains only names and one-line descriptions, and **never** contains bodies | Stuffing all conventions into the Prompt at startup |
| 2 | The catalog is sorted by name; two scans are byte-identical | The catalog order jitters with the file system's return order, and the KV Cache is wasted |
| 3 | The budget counts UTF-8 bytes; over the limit, drop the whole entry | Using the string `length` as bytes; truncating to half a line of description |
| 4 | The scan decodes only up to the second `---`; the body is not decoded | The startup cost grows linearly with the total body size |
| 5 | `load_skill` accepts only `name`; one extra field and it is rejected | Accepting `path`, letting the model name any file |
| 6 | At load time, every path level is re-checked with `realpath` | Trusting the path stored at scan time; a link swap after the scan escapes |

---
## The Skill catalog and manifest contract

The default directory is `skills/` under the current workspace. The scan looks only at its first-level subdirectories. Every Skill must have a `SKILL.md`:

```text
skills/
  typescript-style/
    SKILL.md
  sql-style/
    SKILL.md
```

A minimal manifest looks like this:

```yaml
---
name: typescript-style
description: Use when writing or reviewing TypeScript types, modules, imports and runtime validation; Don't use for SQL, deployment or general project planning.
---
# TypeScript Style

Treat external input as unknown first. Let it enter business logic only after it passes runtime validation.
```

The frontmatter is not "parseable is enough". It has explicit boundaries:

- The first line must be `---`, and there must be a closing delimiter.
- `name` and `description` must both exist, and both must be strings.
- After trimming, `description` must not be empty, and it must not span lines.
- `name` has at most 64 characters. Only lowercase letters, digits, and single-hyphen segments are allowed, for example `typescript-style`.
- `name` must match the directory name exactly. Windows device names such as `nul`, `com1`, and `lpt9` are not legal Skill names.
- A duplicate name fails the scan directly. A later entry does not silently overwrite an earlier one.
- The frontmatter and the explicitly loaded complete file must be UTF-8.

What you get when you violate these rules, aligned in one table (error types come from `features/skills.ts`):

| If you write it like this | When it fails | Error type thrown |
| --- | --- | --- |
| The first line is not `---` | At scan time | `SkillManifestError`: must begin with YAML frontmatter |
| Only an opening `---`, no closing `---` | At scan time | `SkillManifestError`: has no closing frontmatter delimiter |
| A YAML syntax error in the frontmatter | At scan time | `SkillManifestError`: is not valid YAML |
| The frontmatter is an array or a scalar, not key-value pairs | At scan time | `SkillManifestError`: must be a mapping |
| `name` or `description` missing | At scan time | `SkillManifestError`: requires string name and description |
| `description` is an empty string or spans lines | At scan time | `SkillManifestError`: must be one non-empty line |
| `name: My_Skill` (uppercase, underscore) | At scan time | `SkillManifestError`: contains an invalid name |
| `name` does not match the directory name | At scan time | `SkillManifestError`: must match its directory |
| Two directories use the same `name` | At scan time | `DuplicateSkillError` |
| The body has non-UTF-8 bytes | **At load time** (the scan passes!) | `SkillManifestError`: is not valid UTF-8 |
| The Skill directory is a link that points outside the workspace | At scan time | `SkillPathError`: escapes Skills root |

Note the timing difference in the last two rows. It comes directly from the "the scan reads only the frontmatter" design: the scanner never decoded the body, so it cannot discover bad bytes in the body. Only when `load_skill` really reads the whole file does it fail. This is not a loophole. It is the necessary price of "the startup cost does not grow with the body", and the failure point is still **before** the body enters the context.

Two more cases are **skipped silently** and are not errors:

- A first-level subdirectory under `skills/` has no `SKILL.md` → skip it, no error (you can keep drafts there).
- A file placed directly under `skills/` (not a directory) → skip it; only first-level subdirectories are scanned.

The `description` is not a "feature summary". It is the condition the model uses to make the routing decision. Chapter 2 of *ai-agent-book* compared Anthropic's Agent Skills practice: the most effective form is `Use when / Don't use when`, with explicit counter-examples. Without counter-examples, a broad description easily triggers by mistake on unrelated tasks, and the routing accuracy drops clearly. So in the example, "writing or reviewing TypeScript types, modules, imports and runtime validation" is the positive example, and "SQL, deployment or general project planning" is the counter-example.

Compare the three forms:

| Form | Example | How the model will use it |
| --- | --- | --- |
| ❌ Too general | `description: Code conventions` | Almost any task may trigger it; or it may never trigger, because the scope is unclear |
| ⚠️ Positive example only | `description: Use when writing TypeScript` | It may also load while writing SQL, wasting context |
| ✅ Positive + counter-example | `description: Use when writing or reviewing TypeScript types, modules, imports and runtime validation; Don't use for SQL, deployment or general project planning.` | The routing boundary is clear, and mistaken triggers drop clearly |

One-line mnemonic: **the `description` is written for the judgement "should I open this book", not for the introduction "what does this book cover".**

This reserved-name check is not a separate, looser rule set written just for YAML. It reuses the file system path component validation. `isWindowsReservedComponent` lives in `core/filesystem.ts`. The file adapter and the Skill scan use the same implementation, so the two boundaries do not drift apart slowly.

The value of these constraints is not in YAML itself. It is in making the name, the directory, and the load target form a stable mapping. The model cannot name an arbitrary file path through the `name` parameter.

---

## The scan phase reads only the frontmatter

One common problem in the old approach: at startup scan time, it directly uses `readFileSync()` to read and decode every complete body, then stores the original text in a global `Map`. That does not inject into the Prompt at once, but the startup cost is still bound to the total body size.

The current `SkillRegistry.scan()` reads only up to the frontmatter's closing delimiter, and builds an immutable metadata snapshot. The body is not decoded at scan time:

```typescript
import { SkillRegistry } from "./chapters/ch07/src/features/skills.js";

const workspace = process.cwd();
const skills = SkillRegistry.scan(workspace, {
  maxCatalogEntries: 100,
  maxCatalogBytes: 8_000,
});
const catalog = skills.renderCatalog();
```

You can understand the read process of `readFrontmatter()` like this — it reads in 4 KiB chunks, judges line by line, and **returns as soon as it meets the second `---`**:

```text
SKILL.md file (assume a 2000-line body)
┌──────────────────────────────┐
│ ---                          │ ← Line 1 delimiter
│ name: typescript-style       │ 
│ description: Use when ...    │  ← These three lines get decoded into strings
│ ---                          │ ← Line 2 delimiter: return at once, read no further
├──────────────────────────────┤
│ # TypeScript Style           │ ╮
│                              │ ├─ These 2000 lines are neither read into memory
│ Treat external input as unknown first…    │ │   nor decoded into strings
│ …(1997 more lines)             │ ╯
└──────────────────────────────┘
```

So the startup cost relates only to "number of Skills × frontmatter size", not to the total body size. Add ten thousand lines of body to `SKILL.md`, and the scan time barely changes.

The catalog render result looks like this:

```text
- **typescript-style**: Use when writing or reviewing TypeScript types, modules, imports and runtime validation; Don't use for SQL, deployment or general project planning
- **sql-style**: SQL writing conventions and query constraints
```

The budget counts the actual byte count from `Buffer.byteLength(catalog, "utf8")`. It does not pass off the JavaScript string `length` as bytes. Chinese usually takes several UTF-8 bytes, so this distinction directly affects whether a catalog can stably meet the model's input budget.

How big is the difference? The `.length` of `"中文说明"` is 4, but `Buffer.byteLength(..., "utf8")` is 12. If you take `length` as the budget, a Chinese catalog will exceed what you think by 3 times. A test pins the budget exactly at "just enough for one entry" to verify this:

```typescript
await writeSkill(workspace, "alpha", { description: "中文说明" });
await writeSkill(workspace, "beta", { description: "short" });
const firstLine = "- **alpha**: 中文说明";

const registry = SkillRegistry.scan(workspace, {
  maxCatalogEntries: 10,
  maxCatalogBytes: Buffer.byteLength(firstLine, "utf8"),  // Budget = exactly the byte count of the first entry
});

expect(registry.renderCatalog()).toBe(firstLine);   // Only the first entry comes out
```

Note that `beta`'s description is only 5 bytes and looks like "it would still fit". But the budget is already used up — when `boundedCatalog()` computes the next entry, it also counts the newline between entries (`separatorBytes`). As soon as `usedBytes + entryBytes > maxBytes`, it `break`s as a whole. It does not skip `alpha` to squeeze in a smaller `beta`, and it does not truncate `beta` to half a line.

The sorting is pinned down the same way. Three Skills are written to disk in the order `zeta`, `alpha`, `beta`, and the scan result is:

```typescript
expect(registry.names).toEqual(["alpha", "beta", "zeta"]);           // All registered, in dictionary order
expect(registry.catalogEntries.map((e) => e.name)).toEqual(["alpha", "beta"]);  // The catalog holds only 2 entries
expect(secondScan.renderCatalog()).toBe(registry.renderCatalog());   // Two scans are byte-identical
expect(registry.renderCatalog()).not.toContain("PRIVATE");           // Body keywords do not appear
```

`names` (everything registered) and `catalogEntries` (the ones that enter the Prompt) are two different things: **a Skill over the budget can still be loaded by `load_skill`; the model just cannot see it in the catalog.** This is deliberate — the budget constrains only the Prompt size, not the registry.

If `skills/` does not exist, the registry returns an empty catalog, and `bootstrap.ts` writes `(No workspace Skills are currently available.)` explicitly in the Prompt. This sentence itself has a test: the System Prompt of the model's first request must contain it. Why say "none" explicitly instead of writing nothing? Because leaving it empty lets the model guess — guess that some Skill exists, then call `load_skill` and get `skill_not_found`, wasting a turn for nothing.

If the Skill root directory, a subdirectory, or `SKILL.md` escapes the controlled boundary through a symbolic link or a Windows junction, the scan fails directly.

---

## load_skill: load the body by name

The tool input of `load_skill` has only one field:

```json
{
  "name": "typescript-style"
}
```

It does not accept `path`, and it does not accept extra fields. Zod's `.strict()` rejects extra fields before the handler runs. `../secret` gets `invalid_arguments` at the argument validation stage. A name that is legal in format but not registered gets `skill_not_found`.

Why not give the model a `path` parameter? Because that is equal to reopening the "read any file" capability under a new name. Chapter 2's `read_file` already has a complete path boundary; Skills do not need a second entrance. **The Harness decides the mapping from `name` to file, not the model** — this is the most important security design in this chapter.

The input schema and the tool definition stay in the same feature (the complete code of `features/skills.ts`):

```typescript
const SKILL_NAME_REGEXP = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const loadSkillInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_SKILL_NAME_LENGTH)          // 64
      .regex(SKILL_NAME_REGEXP)            // Only lowercase letters, digits and single-hyphen segments are allowed
      .refine((name) => !isWindowsReservedComponent(name))  // Reject nul / com1 / lpt9
      .describe("The exact Skill name from the available catalog."),
  })
  .strict();                               // One extra field and the whole input is rejected

this.toolDefinition = Object.freeze({
  name: LOAD_SKILL_TOOL_NAME,
  description: "Load the full instructions for one Skill listed in the workspace catalog.",
  inputSchema: loadSkillInputSchema,
  effect: "read",
  handler: (input: LoadSkillInput, context: ToolContext) => this.#handleLoad(input, context),
});
```

No separate JSON Schema is maintained here. Chapter 1's `ToolRegistry` generates the parameter definition sent to the model from this Zod schema, and a test even asserts the generated result:

```typescript
expect(tools.openAITools()[0]?.function.parameters).toMatchObject({
  type: "object",
  additionalProperties: false,                                  // ← The product of .strict()
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },  // ← The product of the regex
  },
});
```

In other words, the model knows the legal format of `name` **at the moment it sees the tool definition**, not by trial and error. Before the handler is really called, the `ToolRegistry` validates the arguments once more with the same schema — one schema, two places in effect.

What the four out-of-bounds inputs get, pinned down one by one in tests:

| Arguments the model sent | Result | Blocked at which layer |
| --- | --- | --- |
| `{"name":"missing"}` | `skill_not_found` | handler (the format is legal; it is just not registered) |
| `{"name":"../secret"}` | `invalid_arguments` | **schema** (the regex does not allow `.` and `/`) |
| `{"name":"known","path":"secret"}` | `invalid_arguments` | **schema** (`.strict()` rejects the extra field) |
| `{"name":"nul"}` | `invalid_arguments` | **schema** (`.refine()` rejects the Windows device name) |

Note the common point of the last three rows: **they never entered the handler, and not one file access happened.** Validation happens before the disk is touched. This is "reject first, then execute", not "execute first, then check".

At load time, the registry does not blindly trust the information stored at startup. It completes these checks again:

1. After resolution, the Skill directory is still inside the scanned Skill root directory.
2. After resolution, the `SKILL.md` target is still inside the matching Skill directory, and the target is a file.
3. The complete file decodes as UTF-8, and the frontmatter is still valid.
4. The current `name` still matches the requested name and the directory name.

Why validate again when the scan already validated? Because **any length of time** sits between the two validations, and the file system is mutable:

```text
Build the Agent (scan)          ……ran for 20 minutes……          The model calls load_skill
      ↓                                                        ↓
skills/alpha/ is a normal directory                     skills/alpha/ has been swapped for
Validation passes, the path is stored                   a junction that points to C:\Windows
                                                             ↓
                                          Using the path stored at scan time directly → the escape succeeds
                                          Re-check with realpath again     → SkillPathError
```

This scenario has a dedicated test: `rechecks path containment when a registered directory becomes an escape link` — scan normally first, then replace the registered directory with an escape link, then call `loadSkill()`, and assert that it throws `SkillPathError`.

After everything passes, what comes back is the body after the frontmatter — not the complete `SKILL.md`, and not a file path:

```text
# TypeScript Style

Treat external input as unknown first. Let it enter business logic only after it passes runtime validation.
```

The common Loop writes this result as a `tool` message paired with the `load_skill` call ID. The next model request sees the body; requests before the load saw only the catalog.

`#handleLoad()` maps domain exceptions to error codes that are stable for the model. There are five in total:

| errorCode | Trigger condition | Text the model sees |
| --- | --- | --- |
| `skill_not_found` | The name is legal but not registered | Requested Skill is not registered |
| `skill_path_escape` | The path re-check fails at load time | Registered Skill path is no longer safe |
| `invalid_skill` | The frontmatter is invalid at load time, or not UTF-8 | Registered Skill manifest is invalid |
| `skill_workspace_mismatch` | `ToolContext.workspace` and the registry are not the same | Skill registry belongs to a different workspace |
| `skill_workspace_error` | `ToolContext.workspace` cannot be resolved at all | Current workspace could not be resolved |

Note that the error text contains **no internal file path**. The exception has one (the `SkillPathError` message carries the source), but it is dropped when it is mapped to a tool result. The reason matches chapter 3: the error message itself is also content that enters the context, and it should not feed the host's directory structure to the model.

The effect class of `load_skill` is `"read"`, but it still goes through the Hooks built in chapter 4 and the permission pipeline built in chapter 3. A Skill body is only task guidance for the model. It cannot relax a hard permission, and it cannot turn a write outside the workspace into an allowed operation.

---

## Connect to the existing Tool Registry

The complete implementation lives in `code/chapters/ch07/src/features/skills.ts`. `SkillRegistry` itself holds the `ToolDefinition` of `load_skill`. The schema and the handler still come from the same definition; no second dispatch table is maintained.

`code/chapters/ch07/src/bootstrap.ts` completes three things when it builds P07:

```typescript
const skillRegistry = profile.capabilities.has("skills")
  ? SkillRegistry.scan(dependencies.workspace)
  : undefined;

if (skillRegistry !== undefined) {
  tools.register(skillRegistry.toolDefinition);
}
```

Step one scans the workspace and builds the snapshot. Step two registers `load_skill` into the parent tool set. Step three appends the bounded catalog to this chapter's System Prompt. The registration order is deliberately placed after `task`, so P07's parent tool order is stable as:

```text
shell, read_file, write_file, edit_file, glob, todo_write, task, load_skill
```

Because P07 inherits P06, both the parent Agent and the one-shot subagent can call `load_skill`. When the child tool set is created, the composition root adds the same registry's tool definition:

```typescript
toolsFactory: () => {
  const childTools = createStandardTools(profile, commandRunner, fileSystem).tools;
  if (skillRegistry !== undefined) {
    childTools.register(skillRegistry.toolDefinition);
  }
  return childTools;
},
```

The child tool list still does not contain `task`, so adding knowledge loading does not reopen recursive delegation. What the parent and the child share is the metadata snapshot of the available Skills and the same path boundary. They do not share conversation history. A body the subagent loads enters only the child history. In the end, the parent history gets only the `task` conclusion.

But there is one deliberate asymmetry here, from the same source as the `todo_write` one in chapter 6:

| | Parent Agent | Subagent |
| --- | :---: | :---: |
| `load_skill` in the tool list | ✅ | ✅ |
| The Skill catalog in the System Prompt | ✅ | ❌ |
| Can load any registered Skill | ✅ | ✅ |
| Knows which Skills can be loaded | ✅ | ❌ (unless the parent Agent tells it in the description) |

The reason: `SubagentTool` uses the fixed `DEFAULT_SUBAGENT_SYSTEM_PROMPT`, and the composition root splices the catalog only into the **parent** Agent's System Prompt. A test asserts this directly:

```typescript
expect(model.requests[1]?.messages[0]?.content).not.toContain("python-style");
```

This is not an omission. It is the natural result of chapter 6's rule "the description must be self-contained": **if you want the subagent to use a Skill, write its name clearly in the `task` description.** Conversely, if you want the subagent to choose for itself, you must also splice the catalog into the child prompt — that is the work of chapter 10's dynamic System Prompt, and this chapter does not do it.

The chapter entry `code/chapters/ch07/src/chapters/ch07.ts` is still only `runProfile(P07, process.argv.slice(2))`. The Skill integration did not copy or rewrite the common Agent Loop.

The core implementation points of `features/skills.ts` split into a few clear responsibilities:

| Function | Responsibility and boundary |
| --- | --- |
| `SkillRegistry.scan()` | Resolves the real paths of the workspace and `skills/`, scans first-level subdirectories, reads only the frontmatter, and builds an immutable snapshot of name, directory, and manifest; a duplicate name fails directly |
| `readFrontmatter()` | Reads the file in 4 KiB chunks and returns the frontmatter bytes only when it meets the second `---`; it does not decode the body early |
| `parseSkillDocument()` | Validates the frontmatter delimiters, the YAML types, the `name` rules, and the single-line non-empty `description`, and cuts out the body |
| `boundedCatalog()` | Generates the catalog under the double budget of entry count and `Buffer.byteLength`; over the limit, it truncates as a whole |
| `resolveSkillRoot()` | Allows only relative paths, rejects parent levels and Windows reserved components, and guarantees the resolved directory stays inside the workspace |
| `checkedRealDirectoryAsync()` / `checkedRealFileAsync()` | At load time, re-checks every physical path level with an asynchronous `realpath`, blocking a link-swap escape after the scan |
| `loadSkill()` | Revalidates the requested name, the directory name, the manifest, and UTF-8, and returns the body string after the frontmatter |
| `#handleLoad()` | First confirms that the tool context workspace matches the registry, then maps domain errors to stable `errorCode` values |

Together, these boundaries answer one question: the catalog lets the model "know what exists", the body lets the model "read it when it needs it", and the path validation keeps the "name to file" mapping from becoming an unauthorised entrance.

---

## Compared with chapter 6, how big is the change

| Component | Chapter 6 | Chapter 7 |
| --- | --- | --- |
| Parent tools | 7 | 8, with `load_skill` added |
| Skill catalog | None | Sorted, with an entry count limit and a UTF-8 byte limit |
| Skill body | None | Enters the matching tool result after an explicit load |
| Path input | Not applicable | The model can give only a safe Skill name, not a path |
| Subagent | No `task` | Still no `task`, but it can use `load_skill` |
| Common Loop | `AgentRunner` | Still the same `AgentRunner` |

One sentence summarises this table: **what is added is an on-demand loading channel, not a new execution mechanism.** The complete "what was not done / which chapter adds it" is in the section "What this chapter does not do".

## Differences from Claude Code

This chapter's `load_skill` is a teaching subset. Claude Code's Skill system is also designed under the same two-level loading framework (official documentation: https://code.claude.com/docs/en/skills; reference external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code)'s `s07_skill_loading/README.md`). The main differences between the two are:

- The skill loading sources differ. Claude Code loads skills from many sources, including user skills (`~/.claude/skills/`), project skills (`.claude/skills/`), `--add-dir` directories, legacy commands, built-in skills, and MCP skills. This chapter scans only one `skills/` directory under the current workspace. Many sources add the complexity of source priority, deduplication, and permission management. That part is left for the reader to land as needed.
- The frontmatter fields differ. Claude Code's SKILL.md supports fields such as `allowed-tools` (the automatically allowed tool list), `context` (`inline` or `fork` — fork mode runs the skill as a subagent), `model` (a model override), `hooks`, and `paths` (glob patterns for conditional activation). Among them, `context: fork` needs the subagent runtime (the chapter 6 `task` foundation) and upper-level orchestration logic, so this chapter omits it deliberately.
- The tool input differs. Claude Code's Skill tool receives `skill` + `args`. The teaching version simplifies it to `name`, avoiding the extra complexity of argument parsing and forwarding.
- The content injection method differs. Claude Code expands the SKILL.md through `getPromptForCommand()`, then injects it into the conversation through the `SkillTool` as `newMessages` (the tool_result shows only `Launching skill: {name}`). The teaching version puts the body directly in the tool_result. The final effect is equivalent: the body enters the conversation history but does not occupy the System Prompt.
- The stop conditions match. An inline skill is controlled by the main Agent's loop. This chapter's `load_skill` only injects knowledge on demand; it does not change the toolbox or the end conditions.

Notes: this chapter does not implement `context: fork`; all skills expand inside the parent Agent's history. It also does not implement `allowed-tools`; loading a skill does not automatically adjust the tool list the model can see. If needed, chapter 6's `task` and chapter 7's `load_skill` can be combined at an upper level, but that is outside this chapter's content boundary.

---

## Prove the behavior with offline tests

`npm run test:ch07` runs all tests accumulated from chapters 1 to 7. The current result:

```text
 Test Files  18 passed (18)
      Tests  143 passed (143)
```

Two files relate directly to this chapter:

| File | Number of cases | What it governs |
| --- | ---: | --- |
| `chapters/ch07/tests/skills.test.ts` | 14 | `SkillRegistry` scanning, budgets, paths, and error codes |
| `chapters/ch07/tests/ch07-skills.test.ts` | 3 | Builds the complete Agent and runs it once, to see where the catalog and the body land |

The names of the 14 unit cases are themselves a contract list:

```text
an absent Skills directory produces an empty catalog
the catalog is a snapshot while registered bodies are reread
catalog limits must be positive integers
scans a stable bounded catalog without decoding or exposing bodies
scan reads only frontmatter while explicit loading validates the full UTF-8 document
counts UTF-8 bytes and never emits a partial catalog entry
load_skill returns only a registered body after explicit tool invocation
rejects unknown, traversal, reserved, and extra load arguments before file access
rejects malformed frontmatter, unsafe names, and duplicate names
requires the manifest name to match its directory
load_skill rejects a ToolContext from another workspace
load_skill reports an unresolvable ToolContext workspace
rejects unsafe skill roots and directory links that escape the workspace
rechecks path containment when a registered directory becomes an escape link
```

Check them against the acceptance contract one by one:

| Acceptance contract | Which case pins it |
| --- | --- |
| 1 The catalog never contains bodies | `scans a stable bounded catalog without decoding or exposing bodies` (asserts `not.toContain("PRIVATE")`) |
| 2 Stable sorting, two scans agree | The same case (asserts `secondScan.renderCatalog()` equals the first) |
| 3 Byte budget, whole-entry truncation | `counts UTF-8 bytes and never emits a partial catalog entry` |
| 4 The scan does not decode the body | `scan reads only frontmatter while explicit loading validates the full UTF-8 document` |
| 5 Only `name`; an extra field is rejected | `rejects unknown, traversal, reserved, and extra load arguments before file access` |
| 6 Paths are re-checked at load time | `rechecks path containment when a registered directory becomes an escape link` |

The other three integration cases cover: the empty-workspace prompt sentence, where the catalog/body land plus the audit record, and the subagent loading without recursive delegation. `profiles.test.ts` also pins `ch07` to a fixed mapping to `P07`.

Chapter 7 is designed as two levels of verification:

| Metric type | Offline test coverage | Verification boundary |
| --- | --- | --- |
| Mechanism metrics | Catalog discoverability, description routing conditions, body entry trace, path and permission boundaries | Deterministic, repeatable offline |
| Goal metrics | Whether a real model loads a Skill on its own, and whether it follows the body after loading | Needs real model traces and human acceptance; offline tests do not promise this |

So "all tests pass" proves only that the Harness lets a Skill be discovered and loaded safely. It does not prove that a given real model will load a Skill, and it does not prove that the model will follow the body completely after loading. Those two kinds of problems should be assessed separately with real run traces — for example, record the activation timing of `load_skill`, whether later actions execute as the body says, and whether the task finally succeeds.

---

## Run chapter 7

### Step 0: Prepare the environment

```powershell
Set-Location 'F:\笔记\Agent实操\code'
node --version      # Node 20 or above is required
npm install         # Run only the first time or after dependencies change
```

### Step 1: Run the offline tests first (no API Key needed)

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch07
```

Expect to see `Test Files 18 passed (18)` and `Tests 143 passed (143)`.

One line appears in the middle of the output:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**This is not an error report.** It is an expected output that `config.test.ts` asserts on purpose — the test verifies that "when the configuration is missing, it must report clearly instead of degrading silently". As long as the last line is `passed`, everything is normal.

### Step 2: Confirm a Skill exists in the workspace

The repository ships with one minimal example. Look at it first:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Get-Content -LiteralPath '.\skills\typescript-style\SKILL.md'
```

If this file does not exist, create it with the command below (PowerShell 7 or above):

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType Directory -Force '.\skills\typescript-style' | Out-Null
@'
---
name: typescript-style
description: Use when writing or reviewing TypeScript types, modules, imports and runtime validation; Don't use for SQL, deployment or general project planning.
---
# TypeScript Style

Treat external input as unknown first. Let it enter business logic only after it passes runtime validation.
'@ | Set-Content -LiteralPath '.\skills\typescript-style\SKILL.md' -Encoding utf8NoBOM
```

PowerShell 5.1 has no `utf8NoBOM`. Using `-Encoding utf8` also passes — the decoder strips the BOM automatically, and it does not affect the frontmatter judgement. But if the body is saved in an encoding such as GBK, `load_skill` reports `invalid_skill` at load time.

### Step 3: Observe in which turn the catalog and the body appear

This step needs a real model. First confirm that `code\.env` has `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` configured.

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch07 -- --prompt "First call load_skill to load typescript-style, then summarise two of its conventions"
```

The Hook log prints this order (the `[Hook]` lines come from `liveHooks()` in `cli.ts` and are written to stderr):

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: load_skill
[Permission] load_skill: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: load_skill -> ok
[Hook] Stop
```

Note the `Permission` line: `load_skill` went through the permission pipeline and got `allow (default)`, **without an approval popup**. This is the same fact as the `UnexpectedApproval` test in the subsection "Does loading the body need a human to click 'agree'", shown by two kinds of evidence.

Whether a real model calls the tool as you instruct is uncertain. If it starts guessing the convention content directly, it means it did not load — that belongs to the "goal metrics", exactly the part the section "Prove the behavior with offline tests" says offline tests do not promise.

### Step 4: Let a subagent do the loading

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 7 --prompt "Call task and let the subagent load typescript-style and check whether the current project follows it"
```

Because the subagent's System Prompt has no catalog, the prompt must **write the Skill name out**. This is what the asymmetry in the section "Connect to the existing Tool Registry" looks like in real use.

The log shows two `UserPromptSubmit` and two `Stop` lines (one each for the parent and the child), with the subagent's `load_skill` in between:

```text
[Hook] UserPromptSubmit                  ← Parent Agent
[Hook] PreToolUse: task
[Hook] UserPromptSubmit                  ← ★ The subagent starts
[Hook] PreToolUse: load_skill            ← ★ The subagent is loading
[Hook] PostToolUse: load_skill -> ok
[Hook] Stop                              ← ★ The subagent ends
[Hook] PostToolUse: task -> ok
[Hook] Stop                              ← The parent Agent ends
```

### Step 5 (optional): The full gates

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run typecheck
npm run lint
```

### Troubleshooting common errors

| What you see | Cause | What to do |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` (appears in the middle of the `npm run test:ch07` output) | This is the expected output asserted by `config.test.ts` | Ignore it; check whether the last line is `passed` |
| `Configuration Error: Missing required settings: ...` (appears right after `npm run ch07` and exits at once) | `code\.env` is not configured | Copy `.env.example` to `.env` and fill in the three values |
| `Skill manifest must begin with YAML frontmatter` | The file's first line is not `---` (often a blank line at the start) | Delete the leading blank line; a BOM is not the cause |
| `Skill manifest has no closing frontmatter delimiter` | Only the opening `---` was written | Add the second `---` line |
| `Skill description must be one non-empty line` | The `description` was written over several lines (for example with YAML's `\|`) | Compress it to one line |
| `Skill frontmatter contains an invalid name` | The `name` uses uppercase, an underscore, or a dot | Change it to `lowercase-letters-digits` segments, such as `my-skill` |
| `Skill name must match its directory: xxx` | The `name` and the directory name differ | Make the two the same string |
| `Duplicate Skill name: xxx` | Two directories declare the same `name` | Rename one, or delete the extra directory |
| The model says "no Skill is available" | The catalog entry was dropped whole by the byte budget, or the Skill was added after the scan | Shorten the `description`; restart the process after adding a Skill |
| `skill_not_found` appears in a tool result | The name format is legal but not registered (misspelled, or the directory was not built right) | Confirm the directory structure with the step 2 commands |
| `invalid_arguments` appears in a tool result | The model gave a path, an extra field, or a device name | A normal interception; no code change needed. Check whether the model was misled by the prompt |
| `invalid_skill` appears in a tool result | At load time the body is not UTF-8, or the frontmatter has become invalid | Re-save `SKILL.md` as UTF-8 |
| `skill_path_escape` appears in a tool result | After the scan, the Skill directory was swapped for an escape link | Check whether `skills/` contains a symbolic link or a junction |

### Four small experiments to try yourself

All four experiments only read, never write, and never call a real model. First create a temporary script directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType Directory -Force '.\scratch' | Out-Null
```

**Experiment 1: Prove the catalog really has no body, and see the byte count clearly**

Save the content below as `code\scratch\skill-probe.ts`:

```typescript
import { SkillRegistry } from "../chapters/ch07/src/features/skills.js";

const workspace = process.cwd();
const full = SkillRegistry.scan(workspace);
console.log("names   =", full.names);
console.log("catalog =", JSON.stringify(full.renderCatalog()));
console.log("bytes   =", Buffer.byteLength(full.renderCatalog(), "utf8"));
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\skill-probe.ts
```

The actual output (with the Skill the repository ships):

```text
names   = [ 'typescript-style' ]
catalog = "- **typescript-style**: Use when writing or reviewing TypeScript types, modules, imports and runtime validation; Don't use for SQL, deployment or general project planning."
bytes   = 171
```

For this English description, the byte count and the `.length` are the same: 171. The difference appears as soon as the text is not ASCII. With the Chinese description from the original edition, this same catalog string takes 155 bytes, but its `.length` is only 93 — a difference of 62. The default budget of 8000 bytes fits about 51 such strings. Counted by `.length`, you would wrongly think it fits 86. This is the practical meaning of "count by bytes".

**Experiment 2: Press the budget down to 10 bytes and see the difference between the catalog and the registry**

Append this at the end of the same script:

```typescript
const tiny = SkillRegistry.scan(workspace, { maxCatalogBytes: 10 });
console.log("tiny names   =", tiny.names);
console.log("tiny catalog =", JSON.stringify(tiny.renderCatalog()));
console.log("tiny load    =", JSON.stringify(await tiny.loadSkill("typescript-style")));
```

The actual output:

```text
tiny names   = [ 'typescript-style' ]
tiny catalog = ""
tiny load    = "# TypeScript Style\r\n\r\nTreat external input as unknown first. Let it enter business logic only after it passes runtime validation."
```

Three conclusions are visible at once: the catalog entry is dropped **whole** (not truncated to half a line); the Skill is still in the registry; `load_skill` can still load it. **The budget constrains only the System Prompt size, not the registry.** Also note that the `\r\n` in the body is kept as is — the body is returned byte by byte, with no newline normalisation.

**Experiment 3: Create five kinds of bad frontmatter and watch the failure timing**

Save it as `code\scratch\skill-fail.ts`:

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../chapters/ch07/src/features/skills.js";

function probe(label: string, manifest: string, dir = "demo"): void {
  const workspace = mkdtempSync(join(tmpdir(), "fail-"));
  mkdirSync(join(workspace, "skills", dir), { recursive: true });
  writeFileSync(join(workspace, "skills", dir, "SKILL.md"), manifest, "utf8");
  try {
    const registry = SkillRegistry.scan(workspace);
    console.log(`${label} -> OK, catalog=${JSON.stringify(registry.renderCatalog())}`);
  } catch (error) {
    console.log(`${label} -> ${(error as Error).constructor.name}`);
  }
}

probe("description two lines", "---\nname: demo\ndescription: |\n  first\n  second\n---\nbody\n");
probe("name does not match directory", "---\nname: other\ndescription: ok\n---\nbody\n");
probe("name has underscore", "---\nname: my_skill\ndescription: ok\n---\nbody\n", "my_skill");
probe("no closing delimiter", "---\nname: demo\ndescription: ok\n");
probe("CRLF line endings", "---\r\nname: demo\r\ndescription: ok\r\n---\r\nbody\r\n");
```

The actual output:

```text
description two lines -> SkillManifestError
name does not match directory -> SkillManifestError
name has underscore -> SkillManifestError
no closing delimiter -> SkillManifestError
CRLF line endings -> OK, catalog="- **demo**: ok"
```

The first four fail at the **scan stage** — that is, when the Agent is built, not when the model calls the tool. The last one shows that `isFrontmatterSeparator()` is compatible with CRLF, so editing `SKILL.md` on Windows hits no trap.

**Experiment 4: Create a duplicate name and watch it refuse silent overwrite**

```typescript
const workspace = mkdtempSync(join(tmpdir(), "dup-"));
for (const dir of ["alpha", "beta"]) {
  mkdirSync(join(workspace, "skills", dir), { recursive: true });
  writeFileSync(
    join(workspace, "skills", dir, "SKILL.md"),
    "---\nname: alpha\ndescription: ok\n---\nbody\n",
    "utf8",
  );
}
SkillRegistry.scan(workspace);   // Throws DuplicateSkillError: Duplicate Skill name: alpha
```

If this chose "the later one overwrites the earlier one", which body the model gets when it loads `alpha` would depend on the file system's return order — an unreproducible bug. So it fails directly.

When you finish, remember to delete the temporary directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item -Recurse -Force '.\scratch'
```

---

## What this chapter does not do

| Already there | Not yet | When it is added |
| --- | --- | --- |
| Single source `<workspace>/skills/` | User-level / project-level / MCP multi-source and priority | **Not added.** It would introduce deduplication and source governance, beyond this chapter's boundary |
| The two fields `name` + `description` | `allowed-tools`, `context`, `model`, `hooks`, `paths` | **Not added.** See the section "Differences from Claude Code" |
| Two levels: catalog + body | A third level (automatic indexing of sub-documents the body references) | **Not added.** Sub-documents are read normally with `read_file` |
| One scan at build time | Hot reload of the catalog at run time | Chapter 10 (dynamic System Prompt) |
| The body enters the tool result and stays in the history | Discard / compact the body after use | Chapter 8 (Context Compact) |
| Load one Skill at a time | Load several at once, auto-activate by glob condition | **Not added.** Auto-activation makes the context cost unpredictable |
| The parent Prompt has the catalog | The subagent Prompt has the catalog | Chapter 10 |

Row three needs special emphasis: a `SKILL.md` body can reference sub-documents, scripts, or templates — for example, "read `reference.md` first, then generate the product with `scripts/build.ts`". But P07 does not index these sub-documents automatically, and it does not authorise execution just because a Skill body mentions a script. After the model loads the body, it still has to read or run them through ordinary tools such as `read_file` and `shell`. Those calls still go through the path boundaries, permission policies, and Hooks built in chapters 2, 3, and 4.

**A Skill only "tells the Agent what to do". It cannot expand the Agent's capability boundary by itself.** This sentence is this chapter's security bottom line: a malicious `SKILL.md` that someone slips into `skills/` can at most make the model read one more passage of text. It cannot give it one more tool, one more permission, or one more writable path.

---

## Chapter summary

### The three-sentence version

1. The catalog (name + one-line description) stays resident in the System Prompt. The body enters the tool result only after the model calls `load_skill`.
2. The model can give only a `name`, not a `path` — the Harness decides the mapping from name to file.
3. The paths validated at scan time are all validated again at load time.

### Eight points to remember

| # | Conclusion | Which section it appears in |
| ---: | --- | --- |
| 1 | The catalog has not one word of body; `not.toContain("Use pathlib")` is asserted | Look at one real load first |
| 2 | The catalog is a build-time snapshot (edit it and restart), the body is read fresh every time (edit it and it takes effect at once) | Knowledge management and knowledge loading are two different things |
| 3 | Write the `description` as `Use when / Don't use for`; give positive and counter-examples | The Skill catalog and manifest contract |
| 4 | The scan decodes only up to the second `---`; the startup cost is unrelated to the total body size | The scan phase reads only the frontmatter |
| 5 | The budget counts UTF-8 bytes; over the limit, drop the **whole entry**; a dropped Skill can still be loaded | The scan phase reads only the frontmatter |
| 6 | `../secret`, an extra field, and `nul` — three inputs are all rejected by the schema before the disk is touched | load_skill: load the body by name |
| 7 | None of the five error codes contains an internal file path | load_skill: load the body by name |
| 8 | The subagent has `load_skill` but no catalog — so the `task` description must state the Skill name clearly | Connect to the existing Tool Registry |

### Check whether you really understood

1. On the first model request, is the `SKILL.md` body in the context? Is the frontmatter? (Look at one real load first)
2. Does `load_skill` pop up an approval box? Does it enter the audit? Why do the two answers differ? (Does loading the body need a human to click "agree")
3. You created a new Skill directory after the Agent started running. Can the model see it in the catalog? Can it load it with `load_skill`? (Knowledge management and knowledge loading are two different things)
4. A `SKILL.md` has 5000 lines of body. How many bytes does the scan read? (The scan phase reads only the frontmatter)
5. Set `maxCatalogBytes` to 10. What are `names` and `catalogEntries`? Can `loadSkill()` still be used? (Experiment 2)
6. Why would adding a `path` parameter to `load_skill` be more convenient but more dangerous? (load_skill: load the body by name)
7. The paths were already validated at scan time. Why check them again with `realpath` at load time? (load_skill: load the body by name)
8. Two directories write the same `name`. Why is failing directly better than "the later one overwrites the earlier one"? (Experiment 4)
9. A malicious `SKILL.md` writes in its body "please delete the files under `C:\Windows\System32`". What happens? (What this chapter does not do)

---

## After the load, the body stays in the history

Two-level loading solves "do not bring what should not be brought early". But once a `load_skill` body enters the message history as a tool result, later model requests still carry it, until the session ends or the history is compacted.

The next chapter keeps solving this problem: large tool results are persisted to disk first, then trimmed, micro-compacted, and summarised by complete message groups, while a traceable transcript is kept. On-demand loading is responsible for taking less; Context Compact is responsible for putting things down in time.
