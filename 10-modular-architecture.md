After chapter 9, the Agent already has a fairly complete capability stack: a memory system, context compaction, lazy Skill loading, a permission pipeline, and subagent scheduling. Every new capability adds one more segment to the system prompt. By the end of chapter 9, that string looked roughly like this:

```typescript
const systemPrompt = [
  "You are a coding agent.",
  "Use tools when needed and inspect their results.",
  "For complex tasks, keep the TODO snapshot current.",
  // Tools, Skill, workspace and memory are not hard-coded here.
].join(" ");
```

Nobody dared to change it. You could not tell which segments were required and which were left over from some debugging session. You could not tell whether a change in one place would affect another place. When you switched projects, you had to rewrite the whole string. But you were never sure what to keep and what to throw away.

This is not a question of whether the prompt is well written. It is a structure problem. One large hard-coded string hides configuration inside code. That is the same class of error as writing a database connection string directly into business logic.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaHHeHpRlBuAT1pPoQZBztdcFmicsZuFkuEhAn6ibm1BmChZ2DPYQhicl37o0eZibicdhp5zJe2RQsOkEhqu7fVLLdjaU3SwXBaGLvKM/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

1. State the three reproducible engineering problems that a hard-coded system prompt causes. Do not use a vague claim such as "not elegant".
2. Describe the three roles that a system prompt passes through, from a runtime object to the string sent to the model. Explain why the design cannot omit any role.
3. Recite the fixed order of the five sections. Explain why the order itself is a contract.
4. Judge whether the renderer accepts or rejects a context value. Name the error that a rejection throws.
5. Explain why the cache must live on the instance and not in a module global. State what happens when the cache key misses one input.
6. Explain why the cache in this chapter is **not** the vendor API prompt cache. Do not present the two as the same thing.
7. Distinguish the runtime changes that take effect in the next turn from the changes that require a rebuilt Agent.
8. Explain why this chapter must turn off the chapter 9 memory injection path. State what you see if you do not turn it off.

### What you need first

| Prerequisite | From chapter | How this chapter uses it |
| --- | --- | --- |
| How the Agent Loop assembles a model request in each turn | Chapter 1 | The system prompt renders before the Loop assembles each request |
| `ToolRegistry` and the tool snapshot | Chapter 2 | The `tools` section reads the current registry names directly |
| The workspace absolute path and its hard boundary | Chapter 2 | The `workspace` section outputs the normalized absolute path |
| Profile capability bits and the composition root | Chapters 5–9 | P10 uses one `dynamic_prompt` capability bit to switch the rendering path |
| The separation of the Skill catalog and the Skill body | Chapter 7 | The `skills` section holds only the catalog. The body still uses `load_skill` |
| `MemorySession.selected` and `TurnLifecycle` | Chapter 9 | **The most important prerequisite in this chapter.** Memory injection moves from the old path to the new path |

### Quick glossary (terms that first appear in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| Dynamic system prompt | A system prompt that the program renders again from the current runtime state before each model request |
| section | One independent segment of the system prompt with a `## heading`. This chapter fixes five sections |
| `DynamicPromptRenderer` | A pure renderer. It receives the runtime object and assembles the string in a fixed order |
| `DynamicPromptProvider` | An adapter. It binds the renderer to the runtime object and exposes only a zero-argument `render()` |
| `SystemPromptProvider` | The interface on the Loop side. It has one zero-argument method, `render(): string` |
| Runtime value lookup | The renderer reads the current value from the data source at render time. It does not copy values into strings at build time |
| Canonical JSON | A unique serialization form with sorted keys and compact output. Equal semantics always produce equal text |
| Cache key | A canonical JSON string that covers every model-visible input. The program uses it to decide whether it can reuse the last result |
| Session isolation | The cache lives on the renderer instance. Two Agent instances do not affect each other |
| API prompt cache | A vendor-side cache that matches by request prefix. It is **not the same thing** as the in-process cache in this chapter |
| Bounded catalog | A light index that holds only a name and a one-line description. It does not hold the body |

### Suggested reading route

```text
Chapter Guide (you are here)
  ↓
① Look at the rendered result first     ← Three stages. Watch the sections appear
  ↓
② Three real pain points               ← Why you must split the prompt. This is not a style question
  ↓
③ Three roles, one rendering chain     ← The architecture skeleton of this chapter: Renderer / Provider / Loop
  ↓
④ Five sections and a fixed order      ← The order is the contract. Empty values also have an explicit shape
  ↓
⑤ Context must be strict JSON          ← Why you cannot paper over it with default=str
  ↓
⑥ The cache must belong to the session ← A wrong location leaks across sessions. A missing key input sends stale instructions
  ↓
⑦ Connect to the single Loop           ← The zero-argument contract, and why a failure does not fall back
  ↓
⑧ Inject memory only once              ← You must turn off the chapter 9 path
  ↓
⑨ Run + six experiments + troubleshooting  ← Verify every claim in this chapter by hand
```

---

## Look at the Rendered Result First

Talking about "modularity" in the abstract is less useful than looking at the output. The three blocks below are real results from the same renderer at three stages. A temporary workspace produced them. The full script is in Experiment 1 later in this chapter.

**Stage 1: empty registry, no Skill, no memory.**

```text
## identity
agent
context: {"chapter":10}

## tools
(none)

## workspace
C:\Users\YourUsername\AppData\Local\Temp\probe1-OTdZiy
```

Three sections. Note the `(none)` under `tools`. When there are no tools, the renderer does not omit this section. It writes explicitly that there are currently no tools. A later section explains why.

**Stage 2: register two tools, everything else unchanged.**

```text
## identity
agent
context: {"chapter":10}

## tools
- read_file
- todo_write

## workspace
C:\Users\YourUsername\AppData\Local\Temp\probe1-OTdZiy
```

Only the `tools` section changed. Nobody edited a string by hand here. The `ToolRegistry` gained two tools, and the renderer read the new list at render time.

**Stage 3: add one Skill and one selected memory.**

```text
## identity
agent
context: {"chapter":10}

## tools
- read_file
- todo_write

## workspace
C:\Users\YourUsername\AppData\Local\Temp\probe1-OTdZiy

## skills
- **sql-style**: SQL authoring specification

## memory
<relevant_memories>

## database (project)

Production database constraints

Always use a real database.

</relevant_memories>
```

All five sections now appear. Remember two facts first:

- The `skills` section holds only the **name and the one-line description** of `sql-style`. It holds no word of the Skill file body. The body still requires an explicit `load_skill` call.
- The `memory` section holds only the selected memory. The same store holds another `keyboard` memory that was not selected. Its body also does not appear here.

Experiment 1 asserts both facts:

```text
Contains the Skill body = false
Contains the unselected memory body = false
```

### What it looks like in a real run

The blocks above use minimal input. When you run the real P10 Agent, the `identity` section looks like this. Experiment 6 produces it:

```text
## identity
You are a coding agent. Use tools when needed, inspect their results, and answer accurately.
For complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.
context: {"chapter":10,"identity":"demo-user"}
```

The `tools` section lists all 8 tools:

```text
## tools
- shell
- read_file
- write_file
- edit_file
- glob
- todo_write
- task
- load_skill
```

One point is easy to miss here: **the `identity` argument does not receive only the "who you are" sentence. It receives the whole baseline instruction block that the composition root assembled.** The `bootstrap.ts` file passes `BASE_SYSTEM_PROMPT` plus the TODO instruction together as `identity`. So the identity section has three lines: two behavior baseline lines and one context line. This is the real shape of the current implementation. It is not a typo.

---

## Three Real Pain Points

Before we take the solution apart, state the problem clearly. The problem is not a vague "not elegant enough". It is three specific places that break.

### Pain point 1: a new project forces a full prompt rewrite, and you do not know what to change

The current Agent is a coding agent. Its prompt holds a working directory, a tool list, and behavior rules. Move to a new project and the working directory changes. The tools may change. But the identity definition and the behavior rules may still be reusable.

After you hard-code everything into one string, these boundaries become invisible. You face one blob of text. You can only rewrite all of it, or do careful string replacement. String replacement on a prompt is especially dangerous. A wrong replacement throws no error. It only makes the model behavior subtly wrong.

After you split the prompt into sections, the boundaries become visible: you can reuse `identity`, you must replace `workspace`, and `tools` follows the registry by itself.

### Pain point 2: a change in one place can silently affect the whole prompt

Add one tool description, and it may conflict semantically with a behavior rule earlier in the string. How the LLM resolves that conflict is completely unpredictable.

The worst property of this bug class is that **it throws no error.** Type checks pass. Tests pass, if the tests do not assert the prompt content. CI is fully green. The Agent only makes a strange choice now and then. During diagnosis, you do not even suspect the prompt, because "the prompt did not change" — except that someone did add a segment to it last week.

After you split the prompt into sections and assert the section order and content in tests, this class of change at least becomes visible. You can assert which section a new item lands in, and whether it pushed in front of another section.

### Pain point 3: every request carries all content, but not every request needs it

Memory content matters only in a turn that actually selects a relevant record. If this turn selects nothing and you still leave a placeholder that says "there is currently no relevant memory", that text is pure noise.

The program sends the system prompt in every turn. Irrelevant instructions do not only waste tokens. More importantly, they **dilute attention**. Chapter 5 covered this problem: the more irrelevant content the context holds, the lower the relative weight of the key instructions.

So the rule in this chapter is: when the `skills` and `memory` sections have no content, the renderer **omits the whole section**. It leaves no placeholder.

### Three pain points, three design decisions

| Pain point | Countermeasure in this chapter | Section that covers it |
| --- | --- | --- |
| Invisible boundaries | Split into five named sections, each with one data source | Five sections and a fixed order |
| One change affects the whole prompt | Fix the order as a contract and assert it in tests | Same section |
| Irrelevant content as placeholder | Omit an optional section completely when it has no content | Same section |
| Solved on the side: values go stale | Runtime value lookup. Read again in every turn | Three roles, one rendering chain |

---

## Three Roles, One Rendering Chain

This section is the architecture skeleton of this chapter. It is worth a slower read.

A system prompt becomes the string that the program sends to the model. Between the runtime object and that string, it passes through three roles. Their responsibilities strictly do not overlap:

```text
Runtime data sources                    Three roles                        Model
────────────────────                 ──────────────                     ─────

ToolRegistry ─┐
SkillRegistry ─┤
MemorySession ─┼──> DynamicPromptProvider ──> DynamicPromptRenderer ──> system message
workspace path ─┤    (binding + zero-argument adapter)   (validation + normalization + assembly)        ↑
identity/context ┘              ↑                                        │
                                │                                        │
                          AgentRunner calls render() before each request ─────────────┘
```

| Role | Single responsibility | Explicitly does not do |
| --- | --- | --- |
| `DynamicPromptRenderer` | Validate the input, normalize the context, assemble the string in a fixed order, maintain the cache | Does not discover dependencies, does not read the disk, does not select memories |
| `DynamicPromptProvider` | Bind the renderer and the runtime object at build time, expose a zero-argument `render()` | Does not change rendering logic, does not add its own cache |
| `AgentRunner` | Call `render()` once before each model request, validate the return value | Does not know how many sections exist, does not know where the data comes from |

### Why the Provider layer exists

When you first see this design, a natural question comes up: the renderer can already render, so why not let `AgentRunner` call `renderer.render({...})` directly?

Because then the Loop must know every data source. It must hold `ToolRegistry`, `SkillRegistry`, `MemorySession`, the workspace, and the context. Then every new section adds one more constructor argument to the Loop. That is exactly the coupling this chapter removes. It only moves from the string into the parameter list.

The Provider collects these bindings in the **composition root**. For the Loop, the system prompt is only an interface:

```typescript
export interface SystemPromptProvider {
  // Temporarily read dynamic system prompt each model call without writing rendered results to conversation history.
  render(): string;
}
```

One method, zero arguments. The Loop does not know that five sections exist behind it. It does not know what memory is.

The Provider implementation only forwards. It makes no decisions:

```typescript
render(): string {
  return this.#renderer.render({
    identity: this.#identity,
    tools: this.#tools,
    workspace: this.#workspace,
    context: this.#context,
    ...(this.#skills === undefined ? {} : { skills: this.#skills }),
    ...(this.#memory === undefined ? {} : { memory: this.#memory }),
  });
}
```

Note the spread syntax in the last two lines. `skills` and `memory` are optional capabilities. **When the capability does not exist, the code does not pass the key at all.** It does not pass `undefined`. So on the renderer side, "the capability does not exist" and "the capability is currently empty" are two different states. They do not mix.

### How the composition root wires it

In `bootstrap.ts`, the Provider construction looks like this:

```typescript
const systemPromptProvider = new DynamicPromptProvider({
  renderer: new DynamicPromptRenderer(),
  identity: systemPrompt,
  tools,
  workspace: dependencies.workspace,
  context: Object.freeze({ chapter: profile.chapter, identity }),
  ...(skillRegistry === undefined ? {} : { skills: skillRegistry }),
  ...(memorySession === undefined ? {} : { memory: memorySession }),
});
```

Three details:

First, the code creates the `renderer` **here, with `new`**. Every `buildAgent()` call gets a new renderer. This is the precondition that lets "the cache must belong to the session" hold later in this chapter.

Second, the code passes `tools`, `skillRegistry`, and `memorySession` as **object references**. It does not pass their current string form. So when the internal state of these objects changes later, the renderer reads the new value on its next read.

Third, the code creates the whole Provider only when the `dynamic_prompt` capability bit is on:

```typescript
const dynamicPrompt = profile.capabilities.has("dynamic_prompt");
```

P09 and earlier chapters do not have this capability bit. In those chapters, `systemPromptProvider` is `undefined`, and the Loop falls back to the fixed string from build time. The old chapter behavior did not change by one line.

---

## Five Sections and a Fixed Order

The current implementation does not maintain a `PROMPT_SECTIONS` string dictionary. It does not maintain a hand-written `enabledTools` list either. `DynamicPromptRenderer` reads the objects that already take part in the run, and it outputs five sections:

| Section | Policy | Data source | When it has no content |
| --- | --- | --- | --- |
| `identity` | Always | Baseline behavior instructions + normalized JSON context | Cannot be empty. An empty identity throws an error at once |
| `tools` | Always | Current snapshot of `ToolRegistry.names` | Outputs `(none)` |
| `workspace` | Always | The resolved workspace absolute path | Cannot be empty. An empty string throws an error at once |
| `skills` | On demand | `SkillRegistry.renderCatalog()`, without the body | **Omits the whole section** |
| `memory` | On demand | `MemorySession.renderSelected()`, the memories selected in this turn | **Omits the whole section** |

The order is a contract: `identity -> tools -> workspace -> skills -> memory`.

### Why the "order" must be a contract

A common implementation puts the sections into an object and iterates the keys for output. Then the order depends on the object key insertion order — something a refactor can quietly change.

This chapter uses an array. The code writes the order down:

```typescript
const sections = [
  // Fixed section order keeps prompts predictable; subsequent optional sections only append without interleaving.
  `## identity\n${identity}\ncontext: ${contextJson}`,
  `## tools\n${toolCatalog}`,
  `## workspace\n${workspace}`,
];
if (skillCatalog.length > 0) {
  sections.push(`## skills\n${skillCatalog}`);
}
if (memoryBody.length > 0) {
  sections.push(`## memory\n${memoryBody}`);
}
// Fixed section order is a contract; append optional sections only to the end without changing relative positions of earlier content.
const prompt = sections.join("\n\n");
```

You can read two rules directly from this code:

1. **The first three sections exist unconditionally.** Their positions are always 0, 1, and 2.
2. **An optional section can only push to the end.** It never inserts between the first three.

The tests assert relative position, not "contains some text":

```typescript
expect(prompt?.indexOf("## identity")).toBeLessThan(prompt?.indexOf("## tools") ?? -1);
expect(prompt?.indexOf("## tools")).toBeLessThan(prompt?.indexOf("## workspace") ?? -1);
expect(prompt?.indexOf("## workspace")).toBeLessThan(prompt?.indexOf("## skills") ?? -1);
expect(prompt?.indexOf("## skills")).toBeLessThan(prompt?.indexOf("## memory") ?? -1);
```

So if anyone changes a `push` to an `unshift`, or moves a section, the test turns red at once.

### Why `(none)` for no tools, but omission for an empty Skill section

These two decisions look contradictory. They actually target two different situations.

```typescript
// Output "(none)" even when tool lists are empty, letting models know clearly that no tools are currently available.
const toolCatalog = tools.length === 0 ? "(none)" : tools.map((name) => `- ${name}`).join("\n");
```

**Tools are a core capability, and "no tools" is a fact the model must know.** If the renderer omits the whole section, the model sees that "a tool list should be here, but nothing was said". It may still try to call tools, and then it receives a pile of errors. When the renderer writes `(none)` explicitly, the model knows it can only answer with plain text in this turn.

**Skills and memories are supplementary information. "None" means "this thing does not exist".** A segment that says "there are currently no available Skills" has no guiding value. It is placeholder noise — exactly what pain point 3 removes.

Remember the test with this rule: **when this section is empty, should the model behavior change?** If the tool list is empty, the behavior must change: do not call tools. If the Skill list is empty, the behavior does not change: the option never existed.

### Sections are separated by a blank line

`sections.join("\n\n")` means one blank line separates the sections. In the minimal case, the raw characters of the rendered result look like this. `JSON.stringify` produced this output, so you can see the exact positions of `\n`:

```text
"## identity\nagent\ncontext: {\"chapter\":10}\n\n## tools\n(none)\n\n## workspace\nC:\\Users\\YourUsername\\AppData\\Local\\Temp\\probe1b-cLL8zY"
```

Split it open and you get 9 lines: 3 identity lines + a blank line + 2 tools lines + a blank line + 2 workspace lines. You can verify this number directly in Experiment 1.

---

## Context Must Be Strict JSON

The program uses `context` for small structured state: the chapter number, the identity, and the run mode. This state is special: **the same context must render into text for the model, and it must also take part in the cache key calculation.**

That is why you cannot smear an unknown object into a string with a technique such as `JSON.stringify(context, null, 0)` plus `default=str`. Once you allow the smear, two contexts with different semantics can serialize to the same string, and the cache hits by error. Or one context serializes to two different strings, and the cache never hits.

### Allowed types

```typescript
type JsonScalar = boolean | number | string | null;
interface JsonObject {
  // Allows only string keys; values are constrained recursively by JsonValue to ensure stable serialization.
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonScalar | readonly JsonValue[] | JsonObject;
```

The types are only the first gate. A recursive runtime check also exists, because code can bypass TypeScript types at a boundary, with `as never`, with an `unknown` cast, or with external JSON input.

### The complete accept / reject list

This table is the actual result from Experiment 2. It is not a guess. The Chinese string values (`"文本"` means "text", `"二"` means "two") are data under test: the check proves that canonical JSON keeps string values unchanged.

| Input | Result | Rendered context / error message |
| --- | --- | --- |
| `{}` | Pass | `context: {}` |
| `{ n: 1, s: "文本", b: true, nil: null }` | Pass | `context: {"b":true,"n":1,"nil":null,"s":"文本"}` |
| `{ a: { y: 2, x: 1 }, list: [1, "二", false, null] }` | Pass | `context: {"a":{"x":1,"y":2},"list":[1,"二",false,null]}` |
| `{ z: 1, a: 2 }` | Pass | `context: {"a":2,"z":1}` |
| `JSON.parse('{"__proto__":"safe"}')` | Pass | `context: {"__proto__":"safe"}` |
| `["must not be an array"]` | Reject | `PromptContextError: context must be a JSON object` |
| `"must not be a string"` | Reject | Same as above |
| `{ when: new Date() }` | Reject | `context contains an unsupported JSON value` |
| `{ m: new Map() }` | Reject | Same as above |
| `{ fn: () => 1 }` | Reject | Same as above |
| `{ maybe: undefined }` | Reject | Same as above |
| `{ n: Number.NaN }` | Reject | `context contains a non-finite JSON number` |
| `{ n: Number.POSITIVE_INFINITY }` | Reject | Same as above |
| `{ [Symbol("secret")]: "hidden" }` | Reject | `context JSON object keys must be strings` |
| Self-referencing object | Reject | `context contains a cyclic JSON object` |
| Self-referencing array | Reject | `context contains a cyclic JSON array` |

A few rows deserve a separate note.

**Key order does not affect the result.** `{ z: 1, a: 2 }` renders as `{"a":2,"z":1}` — sorted by key. Nested objects behave the same: `{ y: 2, x: 1 }` becomes `{"x":1,"y":2}`. So two contexts with "a different written order and the same content" get the same cache key.

**The renderer rejects `undefined`. It does not ignore it.** This differs from `JSON.stringify`, which silently drops a key whose value is `undefined`. The renderer rejects it explicitly, because "I passed a key but it disappeared" must be an error.

**`__proto__` is an ordinary string key.** A `__proto__` key from `JSON.parse` is a real own property, not a prototype setter. So the renderer keeps it as an ordinary key, and it takes part in the cache key. A test pins this behavior down:

```typescript
expect(first).toContain('context: {"__proto__":"first"}');
expect(second).toContain('context: {"__proto__":"second"}');
expect(second).not.toBe(first);
```

If the code used a prototype-setting technique such as `Object.assign` here, two renders would produce the same result — a silent wrong cache hit.

### Two key points in the implementation

`normalizeContext` clones recursively and freezes the result. It keeps an `active` Set on the recursion path to detect cyclic references:

```typescript
if (Array.isArray(value)) {
  // The active set stores objects on the current recursive path to detect circular references.
  if (active.has(value)) {
    throw new PromptContextError("context contains a cyclic JSON array");
  }
  active.add(value);
  try {
    return Object.freeze(value.map((item) => normalizeJsonValue(item, active)));
  } finally {
    active.delete(value);
  }
}
```

Note the `active.delete(value)` in the `finally` block. If the code does not delete it, the same object in two **sibling positions** — a legal DAG, not a cycle — also counts as a cycle by error. After the delete, only an object that is truly on the **current recursion path** counts as a cycle.

The `isPlainObject` check uses strict prototype equality. It does not use `typeof === "object"`:

```typescript
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
```

So `Date`, `Map`, `Set`, and every class instance stay out. This is deliberate: the serialization form of these objects either depends on implementation details — a `Date` depends on the time zone — or has no standard JSON form at all, as with `Map`.

### identity also has validation

The `identity` rules are simpler but equally strict:

```typescript
function normalizeIdentity(identity: string): string {
  // identity is a Prompt-visible input; empty strings fail before entering the cache.
  if (typeof identity !== "string") {
    throw new TypeError("identity must be a string");
  }
  const normalized = identity.trim();
  if (normalized.length === 0) {
    throw new Error("identity must not be empty");
  }
  return normalized;
}
```

Measured behavior:

| identity input | Result |
| --- | --- |
| `"  padded  "` | Pass. Renders as `padded`, after the trim |
| `""` | Reject: `identity must not be empty` |
| `"   "` | Reject: same as above |

The trim exists so that "one extra space" does not produce a new cache key.

---

## The Cache Must Belong to the Session

### A module global leaks across sessions

One version is very easy to write:

```typescript
// Counter-example: do not write it this way
let lastContextKey: string | undefined;
let lastPrompt: string | undefined;
```

A single Agent runs with no problem at all. But when two Agent instances run in the same process, they share these two variables. The first Agent finishes a render, and the second Agent, with different input, may read the first Agent's result. The symptom is "the Agent in session B got the workspace path of session A". It is extremely hard to reproduce, because it depends on the render timing of the two sessions.

This chapter puts the cache into instance fields:

```typescript
export class DynamicPromptRenderer {
  // Stable JSON key for the previous complete input; data from different sections does not falsely hit the cache.
  #lastKey: string | undefined;
  // Final prompt text corresponding to #lastKey.
  #lastPrompt: string | undefined;
  // Used only to observe cache reuse count; does not affect rendering results.
  #cacheHits = 0;
```

Every `buildAgent()` call runs `new DynamicPromptRenderer()`, so the cache is isolated by session by construction. You can see this directly in Experiment 3: switch to a new renderer instance, and `cacheHits` starts from 0, even with completely identical input.

### The cache key must cover every visible input

This is the most important rule in this section. When the cache key misses one input, the consequence is not "lower cache efficiency". The consequence is that **the program sends stale instructions to the model**.

```typescript
// The cache key covers all model-visible inputs; any tool, memory, or Skill change invalidates it.
const key = stableJson({
  context,
  identity,
  memory: memoryBody,
  skills: skillCatalog,
  tools: [...tools],
  workspace,
});
```

Six inputs. They correspond exactly to everything that can change in the five sections:

| Item in the cache key | Section | What happens if it is missing |
| --- | --- | --- |
| `identity` | identity | A changed behavior baseline still sends the old instructions |
| `context` | identity | A changed chapter number or run mode does not appear |
| `tools` | tools | **The model does not know a newly registered tool, or it still calls a removed tool** |
| `workspace` | workspace | A changed working directory still reports the old path |
| `skills` | skills | A new Skill does not appear in the catalog, and the model does not know it can load it |
| `memory` | memory | The memory selected in this turn is the memory from the previous turn |

Note the spread in `tools: [...tools]`. `tools` is a `readonly string[]`. The spread creates a new array so that `stableJson` can serialize it normally. And the key uses the **name list**, not the registry object. A change in a tool description or schema does not trigger invalidation, because that content does not enter the system prompt. It travels in the `tools` parameter, which is a different boundary.

### The actual cache behavior

Experiment 3 produced this complete sequence:

```text
After render 1           cacheHits = 0
Render 2 (identical)     cacheHits = 1 | same string = true
Render 3 (keys reversed) cacheHits = 2 | same string = true
Render 4 (new tool)      cacheHits = 2 | same string = false
Another renderer         cacheHits = 0 | text same as last time = true
Invalid context rejected = context contains an unsupported JSON value
Render after the failure cacheHits = 3 | still reuses the pre-failure result = true
```

Read it line by line:

- Render 1 must miss. There is nothing to compare against.
- Render 2 is completely identical. It hits.
- Render 3 reverses the context key order, and it **still hits**. That is what canonical JSON does.
- Render 4 registers a new tool. `cacheHits` stays at 2 and does not grow, and the renderer returns a different string. Invalidation works.
- A different renderer instance starts with `cacheHits` at 0, but it renders **the same text**. Both facts must hold at once. Then the design is right: the cache is isolated, and the result is consistent.
- The last part is the most interesting. A separate note follows below.

### A failure does not pollute the cache

Look at these three lines:

```text
Invalid context rejected = context contains an unsupported JSON value
Render after the failure cacheHits = 3 | still reuses the pre-failure result = true
```

After one invalid render throws, a render with the earlier valid input **still hits the cache**. It returns the result from before the failure.

The reason is that all validation completes **before** the code updates `#lastKey` / `#lastPrompt`:

```typescript
const context = normalizeContext(options.context);   // An invalid value throws here
const contextJson = stableJson(context);
// ...
const key = stableJson({ /* ... */ });
if (key === this.#lastKey && this.#lastPrompt !== undefined) {
  this.#cacheHits += 1;
  return this.#lastPrompt;
}
// ...assembly...
this.#lastKey = key;      // Control reaches this line only after full success
this.#lastPrompt = prompt;
```

If the order were reversed — write the cache first, validate second — one failed call would set the cache to a half-finished state. Every later render would then read dirty data. A test covers this rule specifically. It runs four kinds of invalid context, one pass each:

```typescript
test.each([
  ["root array", ["root must be an object"]],
  ["unsupported object", { value: new Date() }],
  ["non-finite number", { value: Number.NaN }],
  ["symbol key", { [Symbol("secret")]: "hidden" }],
])("rejects %s context without poisoning the cache", (_label, context) => {
```

### This cache is not the API prompt cache

State this clearly. Otherwise it is easy to claim a performance benefit by mistake.

| Comparison item | The cache in this chapter | The vendor API prompt cache |
| --- | --- | --- |
| Where it lives | In the process, in renderer instance fields | On the vendor server |
| What it saves | The CPU cost of repeated string assembly | The cost and latency of repeated processing of the same token prefix |
| Hit condition | The canonical snapshots of all six inputs are equal | The full request prefix before the breakpoint is identical |
| Who can observe it | `renderer.cacheHits` | The usage field in the response |

The current OpenAI adapter does **not** split the static and dynamic sections into different cache-control blocks. So this chapter cannot claim that "a dynamic content change still hits the API-level static prefix cache". That needs an extra block design, and this chapter does not build it.

The `cacheHits` getter exists for **testability**, not as a performance metric:

```typescript
// Cache hit counts are used for tests and observability, proving identical inputs do not reassemble strings.
get cacheHits(): number {
  return this.#cacheHits;
}
```

---

## Connect to the Single Loop, Do Not Copy the Loop

This chapter adds one capability, but it does not copy one line of the tool execution loop in `core/loop.ts`. The dynamic prompt has exactly one connection point: before the Loop assembles the model request in each turn.

```typescript
// The system prompt renders before each turn assembly request, making tool list and selected memory changes take effect next turn.
const systemPrompt = this.#renderSystemPrompt();
const requestMessages = Object.freeze([
  systemMessage(systemPrompt),
  ...requestHistory,
  ...turnGuidance,
  ...observerGuidance,
]);
```

Tool calls, permissions, hooks, batch result processing, compaction, and Stop behavior all keep the original implementation.

### Two validations, two moments

**At construction time**, the code validates that the provider has a `render()`:

```typescript
if (
  options.systemPromptProvider !== undefined &&
  typeof options.systemPromptProvider.render !== "function"
) {
  // provider contracts validate during construction to avoid discovering missing render() during model calls.
  throw new TypeError("systemPromptProvider must implement render()");
}
```

**At each render**, the code validates the return value:

```typescript
// Render the system prompt before each model request; use the build-time fixed string when provider is missing.
#renderSystemPrompt(): string {
  // Provider output is model boundary input; empty values fail immediately rather than falling back to stale cache.
  const rendered =
    this.#systemPromptProvider === undefined
      ? this.#systemPrompt
      : this.#systemPromptProvider.render();
  if (typeof rendered !== "string" || rendered.trim().length === 0) {
    throw new AgentRunError("System prompt provider returned an empty prompt");
  }
  return rendered;
}
```

Experiment 6 ran every branch:

| provider | Result |
| --- | --- |
| `{ render: () => "## identity\nagent" }` | Pass. Completes normally |
| `{ render: () => "" }` | `AgentRunError: System prompt provider returned an empty prompt` |
| `{ render: () => "   \n  " }` | Same as above. Whitespace only also counts as empty |
| `{ render: () => null }` | Same as above |
| `{ render: () => 42 }` | Same as above. A wrong type takes this path too |
| `{ render: "not a function" }` | `TypeError: systemPromptProvider must implement render()` |
| `{}` | Same as above |
| `{ render: () => { throw new Error("the renderer blew up") } }` | Throws the original `Error: the renderer blew up` |

The last row shows that the Loop **does not catch** exceptions from inside the renderer. This is deliberate: a render failure means that a data source for the system prompt is broken. If the run continues, it operates on the real environment with wrong instructions. Letting it blow up is safer than a silent downgrade.

### Why a failure does not fall back to the build-time string

`AgentRunner` does hold a build-time `#systemPrompt`. In P10 it is the `BASE_SYSTEM_PROMPT` plus the TODO instruction. A fallback exists, so why not use it when the provider returns an empty value?

Because that string **does not contain the workspace, the tool list, the Skill catalog, or the memory**. If the Agent runs with it, the model believes it has no tools, and it does not know which directory it works in. That is not a downgrade. That is a different Agent.

The last part of Experiment 6 proves that the build-time string does not take part when a provider exists:

```text
The system message actually sent to the model = "runtime rendered result"
```

The `systemPrompt: "build-time fixed fallback"` that the test passed in never appears.

### The exact boundary of "takes effect in the next turn"

Understand the sentence "a runtime change takes effect in the next turn" by the real implementation. Do not read it loosely as "everything updates automatically".

| Change | Takes effect next turn? | Why |
| --- | --- | --- |
| `ToolRegistry` registers / removes a tool | Yes | Every render reads `tools.names` again |
| The memory that `MemorySession` selects in this turn changes | Yes | Every render reads `memory.selected` again |
| The workspace path | No change | The Provider binds the path that construction passed in |
| A Skill directory added / removed on disk | **No** | `SkillRegistry` is a snapshot that construction scanned |

The last row is the easiest to misunderstand. Experiment 4 verifies it directly:

```text
=== Same provider: add gamma on disk ===
Two renders are identical = true
gamma appears = false
```

With the same provider, a new Skill exists on disk, and the rendered result does not change by one character. To make it appear, you must rebuild the Agent:

```text
=== After beta is added on disk, rebuild the Agent to see it ===
## skills
- **alpha**: Alpha catalog entry
- **beta**: Beta catalog entry
```

A comment in the composition root states this boundary:

```typescript
// Scan once during chapter assembly; runtime load_skill still re-checks real paths.
const skillRegistry = profile.capabilities.has("skills")
  ? SkillRegistry.scan(dependencies.workspace)
  : undefined;
```

**The current implementation does not silently watch the directory.** This is a deliberate choice: a disk scan in every turn adds file system I/O to every model request, and a Skill directory almost never changes inside one session. A hot update should use an explicit invalidation notification mechanism. It should not rely on polling.

---

## Inject Memory Only Once

This section is the only place in this chapter that must change the previous chapter's behavior. It is also the easiest place to introduce a bug.

### The problem: two paths open at the same time

In chapter 9, `TurnLifecycle.beforeModel()` injects the memory. It returns one extra system message, and the Loop appends it after the request history:

```typescript
// Attach selected memories only as system context to the next model request; do not write to canonical history.
beforeModel(): readonly ChatMessage[] {
  if (!this.#emitContextMessages || this.#selected.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze([systemMessage(this.renderSelected())]);
}
```

After chapter 10, the selected memories already enter the `memory` section of the dynamic prompt. If the old path stays open, the same body appears **twice** in one request: once in the system prompt, and once as an independent system message.

This is not a theoretical deduction. Experiment 5 ran both configurations:

```text
emitContextMessages=true  -> the memory body appears 2 times in the main request (3 messages in total)
emitContextMessages=false -> the memory body appears 1 time in the main request (2 messages in total)
```

Duplicate injection burns one extra copy of the tokens. It also sends the model a wrong signal: a thing said twice usually looks more important.

### The fix: the composition root switches the ownership explicitly

```typescript
// When enabling dynamic prompts, disable standalone MemorySession.beforeModel() message injection; Provider outputs memory content uniformly.
const memorySession = profile.capabilities.has("memory")
  ? createMemorySession(dependencies, !dynamicPrompt)
  : undefined;
```

The negation in `!dynamicPrompt` is the core of the whole logic:

| Profile | `dynamicPrompt` | `emitContextMessages` | Where memory injection comes from |
| --- | --- | --- | --- |
| P09 | `false` | `true` | The independent system message from `TurnLifecycle.beforeModel()` |
| P10 | `true` | `false` | The `memory` section of the dynamic prompt |

So the P09 behavior does not change at all, P10 switches to the new path, and both inject exactly once.

### The lifecycle is not turned off. Only its injection is

One point is easy to misunderstand: `emitContextMessages: false` does **not** turn the memory feature off. `MemorySession` still does all of this work in full:

- `beginTurn()` reads the collection in every turn and calls the selector to select memories. On failure it degrades to keyword matching
- `complete()` extracts new memories from the canonical history at the end of a turn, and tidies when a threshold is reached
- The `selected` getter exposes the records selected in this turn

Only the independent message from `beforeModel()` is turned off. The renderer reads the same data through `selected`:

```typescript
const memoryBody =
  options.memory === undefined || options.memory.selected.length === 0
    ? ""
    : options.memory.renderSelected();
```

Note that this code reads `selected` and `renderSelected()`. It does not select again from the store. **The selection right still belongs to `MemorySession`. The renderer only renders.** This is the division-of-work principle that this chapter repeats: the prompt layer does not reimplement tool discovery, memory selection, or path validation.

### The change in injection position

Beyond Experiment 5, the comparison script in Experiment 5 also printed position information:

```text
P09 (old path: TurnLifecycle injection): main request messages = 3, messages containing <relevant_memories> = 1
  Position 1: role=system, position index=2
  System prompt contains "## memory" = false
P10 (new path: dynamic Prompt injection): main request messages = 2, messages containing <relevant_memories> = 1
  Position 1: role=system, position index=0
  System prompt contains "## memory" = true
```

The difference is clear:

```text
The P09 request:                      The P10 request:
┌─────────────────────────┐      ┌─────────────────────────┐
│ [0] system: fixed prompt │      │ [0] system: dynamic prompt │
│                         │      │      ├─ ## identity     │
│                         │      │      ├─ ## tools        │
│                         │      │      ├─ ## workspace    │
│                         │      │      ├─ ## skills       │
│                         │      │      └─ ## memory  ← injected │
├─────────────────────────┤      ├─────────────────────────┤
│ [1] user: user question  │      │ [1] user: user question  │
├─────────────────────────┤      └─────────────────────────┘
│ [2] system: memory ← injected │
└─────────────────────────┘
```

P10 has one message fewer. The memory position moved from "after the user question" to "inside the system prompt".

### How the tests pin this down

The key is to **count occurrences**. Do not assert "contains some text": that assertion also passes under duplicate injection:

```typescript
expect(
  firstMain?.messages.filter((message) =>
    (message.content ?? "").includes("<relevant_memories>"),
  ),
).toHaveLength(1);
```

The same test also asserts stability across a tool turn:

```typescript
expect(secondMain?.messages[0]).toEqual(firstMain?.messages[0]);
```

After one tool call, the system message of the second main request is **completely identical** to the first one. The tool set did not change, the selected memory did not change, and the Skill catalog did not change. So the cache hits, and the rendered result is consistent.

---

## Run Chapter 10

### Step 0: prepare the environment

```powershell
Set-Location 'F:\笔记\Agent实操\code'
node --version      # Requires Node 20 or later
npm install         # Run only the first time, or after the dependencies change
```

### Step 1: run the offline tests first (no API Key required)

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch10
```

Expect to see:

```text
Test Files  25 passed (25)
     Tests  226 passed (226)
```

One line appears in the middle of the output:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**This is not an error.** It is an expected output that `config.test.ts` asserts on purpose. The test verifies that "a missing configuration must report a clear error instead of a silent downgrade". As long as the last line says `passed`, everything is normal.

### Step 2: let the Agent report its own tool list

This step needs a real model. First confirm that `code\.env` sets `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`.

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch10 -- --prompt "List the tools available to the current Agent"
```

This prompt has a purpose: if the model reports the 8 tool names accurately, the `tools` section really reached it. If it answers "I have no tools", or it reports a pile of tool names that do not exist, the rendering chain is broken somewhere.

You can also use the unified entry. Both forms share the same Bootstrap and the same Loop:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 10 --prompt "List the tools available to the current Agent"
```

### Step 3: change the prompt and look at the workspace and the memory

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch10 -- --prompt "What is your current working directory? Which Skills can you load?"
```

The model should report the absolute path of the `code` directory, and the Skill names that the scan found under `code\skills\`.

If you ran chapter 9 before and `.memory` holds content, you can also try:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch10 -- --prompt "What constraints about this project do you remember?"
```

### Step 4 (optional): the full gates

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run typecheck
npm run lint
```

### Troubleshooting common errors

| What you see | Cause | What to do |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` in the middle of the test output | An expected output that `config.test.ts` asserts | Ignore it. Check that the last line says `passed` |
| `Configuration Error: Missing required settings: ...` and `npm run ch10` exits at once | `code\.env` is not configured | Copy `.env.example` to `.env` and fill in the three values |
| `TypeError: systemPromptProvider must implement render()` | You passed an object without a `render()` | Check whether you passed the renderer instead of the provider by mistake |
| `AgentRunError: System prompt provider returned an empty prompt` | `render()` returned an empty string, whitespace, `null`, or a non-string | Check the renderer data sources. Do not try to add a fallback |
| `PromptContextError: context must be a JSON object` | The context is an array or a scalar | The root must be a plain object |
| `PromptContextError: context contains an unsupported JSON value` | The context holds a `Date`, a `Map`, a function, or `undefined` | Convert to a JSON scalar first, for example with `date.toISOString()` |
| `PromptContextError: context contains a non-finite JSON number` | The context holds `NaN` or `Infinity` | Usually a calculation without a divide-by-zero guard |
| `PromptContextError: context JSON object keys must be strings` | A symbol is a key | Use string keys |
| `PromptContextError: context contains a cyclic JSON object` | The context holds a cyclic reference | Pick the fields you need by hand before you pass it. Do not throw the whole object in |
| `TypeError: tools must be ToolRegistry` | You passed a plain array or a list of strings | The renderer wants the registry object, not a name list |
| `Error: identity must not be empty` | The identity is an empty string or whitespace only | Give at least one sentence of identity description |
| `Error: profile must be a fixed chapter profile` | You constructed a profile object yourself | Use the exported `P10` singleton |
| The model says "I have no available tools" | The `tools` section is `(none)` | Check whether you used an empty `ToolRegistry` |
| A Skill added on disk does not appear | `SkillRegistry` is a build-time snapshot | Rebuild the Agent. This is a design boundary, not a bug |
| The memory body appears twice | `emitContextMessages` is not off | Check whether you assembled the session by hand and bypassed `bootstrap` |

---

## Six Hands-On Experiments

None of these six experiments **calls a real model**. They need no API Key, and a run verifies every core claim in this chapter. First create a temporary directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType Directory -Force '.\scratch' | Out-Null
```

The output of every experiment below is real run output. The random string in the temporary directory name **will differ when you run it**. That is normal.

### Experiment 1: how the five sections grow, and whether a body leaks

Save it as `code\scratch\probe1-sections.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ToolRegistry, toolSuccess } from "../chapters/ch10/src/core/tools.js";
import {
  MemoryRecord,
  MemorySession,
  MemoryStore,
  MemoryType,
} from "../chapters/ch10/src/features/memory.js";
import { DynamicPromptRenderer } from "../chapters/ch10/src/features/prompting.js";
import { SkillRegistry } from "../chapters/ch10/src/features/skills.js";

const workspace = mkdtempSync(join(tmpdir(), "probe1-"));

function addTool(tools: ToolRegistry, name: string): void {
  tools.register({
    name,
    description: `Run ${name}.`,
    inputSchema: z.object({}).strict(),
    effect: "read",
    handler: () => toolSuccess(name),
  });
}

// Stage 1: empty registry, no Skill, no memory
const tools = new ToolRegistry();
const renderer = new DynamicPromptRenderer();
console.log("=== Stage 1: nothing at all ===");
console.log(renderer.render({ identity: "agent", tools, workspace, context: { chapter: 10 } }));

// Stage 2: register two tools
addTool(tools, "read_file");
addTool(tools, "todo_write");
console.log("\n=== Stage 2: after registering two tools ===");
console.log(renderer.render({ identity: "agent", tools, workspace, context: { chapter: 10 } }));

// Stage 3: add the Skill catalog and the selected memory
mkdirSync(join(workspace, "skills", "sql-style"), { recursive: true });
writeFileSync(
  join(workspace, "skills", "sql-style", "SKILL.md"),
  "---\nname: sql-style\ndescription: SQL authoring specification\n---\n# This is the Skill body. It must not appear in the Prompt\n",
  "utf8",
);
const store = new MemoryStore({ workspace, idGenerator: () => "one" });
await store.extend([
  new MemoryRecord({
    name: "database",
    description: "Production database constraints",
    kind: MemoryType.PROJECT,
    body: "Always use a real database.",
  }),
  new MemoryRecord({
    name: "keyboard",
    description: "Unselected keyboard notes",
    kind: MemoryType.PROJECT,
    body: "This body must not appear in the Prompt",
  }),
]);
const memory = new MemorySession({
  store,
  selector: {
    async select() {
      return '["database"]';
    },
  },
});
await memory.beginTurn("Check the database");

const full = renderer.render({
  identity: "agent",
  tools,
  workspace,
  context: { chapter: 10 },
  skills: SkillRegistry.scan(workspace),
  memory,
});
console.log("\n=== Stage 3: all five sections appear ===");
console.log(full);

console.log("\n=== Leak check ===");
console.log("Contains the Skill body =", full.includes("This is the Skill body"));
console.log("Contains the unselected memory body =", full.includes("This body must not appear"));
console.log("cacheHits =", renderer.cacheHits);

rmSync(workspace, { recursive: true, force: true });
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe1-sections.ts
```

The output of the three stages is the three blocks at the start of this chapter, in "Look at the Rendered Result First". The last three lines are the key assertions:

```text
=== Leak check ===
Contains the Skill body = false
Contains the unselected memory body = false
cacheHits = 0
```

The first two `false` values prove two boundaries: the Skill body and the unselected memory body both stay out of the prompt. `cacheHits = 0` shows that the three renders had different inputs and all missed — as expected, because each render changed the tools or the sections.

To see the exact positions of the blank lines, add a minimal script, `code\scratch\probe1b-raw.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../chapters/ch10/src/core/tools.js";
import { DynamicPromptRenderer } from "../chapters/ch10/src/features/prompting.js";

const workspace = mkdtempSync(join(tmpdir(), "probe1b-"));
const prompt = new DynamicPromptRenderer().render({
  identity: "agent",
  tools: new ToolRegistry(),
  workspace,
  context: { chapter: 10 },
});

console.log("Raw characters =", JSON.stringify(prompt));
console.log("Line count =", prompt.split("\n").length);
rmSync(workspace, { recursive: true, force: true });
```

Actual output:

```text
Raw characters = "## identity\nagent\ncontext: {\"chapter\":10}\n\n## tools\n(none)\n\n## workspace\nC:\\Users\\YourUsername\\AppData\\Local\\Temp\\probe1b-cLL8zY"
Line count = 9
```

Printing with `JSON.stringify` is deliberate. A terminal folds consecutive blank lines. Only this form confirms that the sections really are separated by `\n\n`.

### Experiment 2: the exact boundary of context

Save it as `code\scratch\probe2-context.ts`:

```typescript
import { ToolRegistry } from "../chapters/ch10/src/core/tools.js";
import { DynamicPromptRenderer } from "../chapters/ch10/src/features/prompting.js";

const tools = new ToolRegistry();
const workspace = process.cwd();

function probe(label: string, context: unknown): void {
  const renderer = new DynamicPromptRenderer();
  try {
    const prompt = renderer.render({
      identity: "agent",
      tools,
      workspace,
      context: context as never,
    });
    const line = prompt.split("\n").find((text) => text.startsWith("context: "));
    console.log(`${label.padEnd(28)} pass -> ${line}`);
  } catch (error) {
    console.log(`${label.padEnd(28)} reject -> ${(error as Error).name}: ${(error as Error).message}`);
  }
}

console.log("--- Valid ---");
probe("Empty object", {});
probe("Scalar mix", { n: 1, s: "文本", b: true, nil: null });
probe("Nested object and array", { a: { y: 2, x: 1 }, list: [1, "二", false, null] });
probe("Reversed key order", { z: 1, a: 2 });
probe("__proto__ from JSON", JSON.parse('{"__proto__":"safe"}'));

console.log("\n--- Rejected ---");
probe("Root is an array", ["must not be an array"]);
probe("Root is a string", "must not be a string");
probe("Date object", { when: new Date() });
probe("Map object", { m: new Map() });
probe("Function value", { fn: () => 1 });
probe("undefined value", { maybe: undefined });
probe("NaN", { n: Number.NaN });
probe("Infinity", { n: Number.POSITIVE_INFINITY });
probe("Symbol key", { [Symbol("secret")]: "hidden" });

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
probe("Cyclic object", cyclic);

const cyclicArray: unknown[] = [];
cyclicArray.push(cyclicArray);
probe("Cyclic array", { list: cyclicArray });

console.log("\n--- identity validation ---");
for (const identity of ["  padded  ", "", "   "]) {
  try {
    const prompt = new DynamicPromptRenderer().render({
      identity,
      tools,
      workspace,
      context: {},
    });
    console.log(`identity=${JSON.stringify(identity)} pass -> line 2 = ${JSON.stringify(prompt.split("\n")[1])}`);
  } catch (error) {
    console.log(`identity=${JSON.stringify(identity)} reject -> ${(error as Error).message}`);
  }
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe2-context.ts
```

Actual output:

```text
--- Valid ---
Empty object                 pass -> context: {}
Scalar mix                   pass -> context: {"b":true,"n":1,"nil":null,"s":"文本"}
Nested object and array      pass -> context: {"a":{"x":1,"y":2},"list":[1,"二",false,null]}
Reversed key order           pass -> context: {"a":2,"z":1}
__proto__ from JSON          pass -> context: {"__proto__":"safe"}

--- Rejected ---
Root is an array             reject -> PromptContextError: context must be a JSON object
Root is a string             reject -> PromptContextError: context must be a JSON object
Date object                  reject -> PromptContextError: context contains an unsupported JSON value
Map object                   reject -> PromptContextError: context contains an unsupported JSON value
Function value               reject -> PromptContextError: context contains an unsupported JSON value
undefined value              reject -> PromptContextError: context contains an unsupported JSON value
NaN                          reject -> PromptContextError: context contains a non-finite JSON number
Infinity                     reject -> PromptContextError: context contains a non-finite JSON number
Symbol key                   reject -> PromptContextError: context JSON object keys must be strings
Cyclic object                reject -> PromptContextError: context contains a cyclic JSON object
Cyclic array                 reject -> PromptContextError: context contains a cyclic JSON array

--- identity validation ---
identity="  padded  " pass -> line 2 = "padded"
identity="" reject -> identity must not be empty
identity="   " reject -> identity must not be empty
```

Three rows deserve a side-by-side look:

- `{ z: 1, a: 2 }` outputs `{"a":2,"z":1}`, and the nested `{ y: 2, x: 1 }` outputs `{"x":1,"y":2}` — **the sort is recursive**.
- The renderer **rejects** `{ maybe: undefined }`. It does not drop the key. `JSON.stringify` deletes this key silently. Here the code reports an explicit error.
- `identity: "  padded  "` passes, but the trim reduces it to `padded`. Extra spaces do not become a new cache key.

### Experiment 3: six cache situations

Save it as `code\scratch\probe3-cache.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ToolRegistry, toolSuccess } from "../chapters/ch10/src/core/tools.js";
import { DynamicPromptRenderer } from "../chapters/ch10/src/features/prompting.js";

const workspace = mkdtempSync(join(tmpdir(), "probe3-"));
const tools = new ToolRegistry();
const renderer = new DynamicPromptRenderer();

function render(context: Record<string, unknown>): string {
  return renderer.render({
    identity: "agent",
    tools,
    workspace,
    context: context as never,
  });
}

// 1. First render: must be a miss
const first = render({ a: 1, b: 2 });
console.log("After render 1 cacheHits =", renderer.cacheHits);

// 2. Same context: hit
const same = render({ a: 1, b: 2 });
console.log("Render 2 (identical)     cacheHits =", renderer.cacheHits, "| same string =", same === first);

// 3. Different key order, same semantics: still a hit
const reordered = render({ b: 2, a: 1 });
console.log("Render 3 (keys reversed) cacheHits =", renderer.cacheHits, "| same string =", reordered === first);

// 4. Register a new tool: invalidation
tools.register({
  name: "write_file",
  description: "Write a file.",
  inputSchema: z.object({}).strict(),
  effect: "write",
  handler: () => toolSuccess("ok"),
});
const afterTool = render({ b: 2, a: 1 });
console.log("Render 4 (new tool)      cacheHits =", renderer.cacheHits, "| same string =", afterTool === first);

// 5. Another renderer instance: the cache is not shared
const other = new DynamicPromptRenderer();
const otherPrompt = other.render({ identity: "agent", tools, workspace, context: { b: 2, a: 1 } });
console.log("Another renderer         cacheHits =", other.cacheHits, "| text same as last time =", otherPrompt === afterTool);

// 6. An invalid context does not pollute the cache
try {
  render({ when: new Date() });
} catch (error) {
  console.log("\nInvalid context rejected =", (error as Error).message);
}
const afterFailure = render({ b: 2, a: 1 });
console.log("Render after the failure cacheHits =", renderer.cacheHits, "| still reuses the pre-failure result =", afterFailure === afterTool);

rmSync(workspace, { recursive: true, force: true });
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe3-cache.ts
```

Actual output:

```text
After render 1           cacheHits = 0
Render 2 (identical)     cacheHits = 1 | same string = true
Render 3 (keys reversed) cacheHits = 2 | same string = true
Render 4 (new tool)      cacheHits = 2 | same string = false
Another renderer         cacheHits = 0 | text same as last time = true
Invalid context rejected = context contains an unsupported JSON value
Render after the failure cacheHits = 3 | still reuses the pre-failure result = true
```

The third row from the bottom deserves the most thought: `cacheHits = 0`, but `text same as last time = true`. **The cache is isolated, and the rendering is deterministic.** Both must hold at once. If you achieve only the first, two Agents risk receiving different prompts. If you achieve only the second, you are back to the module-global cache problem.

### Experiment 4: which runtime changes take effect, and which do not

Save it as `code\scratch\probe4-live.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgent } from "../chapters/ch10/src/bootstrap.js";
import { assistantMessage } from "../chapters/ch10/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch10/src/core/model.js";
import { PermissionDecision } from "../chapters/ch10/src/core/permissions.js";
import { P10 } from "../chapters/ch10/src/core/profiles.js";
import { ToolRegistry } from "../chapters/ch10/src/core/tools.js";
import {
  DynamicPromptProvider,
  DynamicPromptRenderer,
} from "../chapters/ch10/src/features/prompting.js";
import { SkillRegistry } from "../chapters/ch10/src/features/skills.js";

class Recorder implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    return { message: assistantMessage("done"), finishReason: "stop" };
  }
}

function writeSkill(workspace: string, name: string, description: string): void {
  const directory = join(workspace, "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`,
    "utf8",
  );
}

const workspace = mkdtempSync(join(tmpdir(), "probe4-"));
try {
  writeSkill(workspace, "alpha", "Alpha catalog entry");

  // 1. The full P10 tool list
  const model = new Recorder();
  const runner = buildAgent(P10, {
    model,
    workspace,
    approvalProvider: { async decide() { return new PermissionDecision("allow", "t", "t"); } },
    auditSink: { async record() {} },
  });
  await runner.run("hi");
  const prompt = model.requests[0]?.messages[0]?.content ?? "";
  console.log("=== The P10 tools section ===");
  console.log(prompt.split("\n\n").find((s) => s.startsWith("## tools")));
  console.log("\n=== The P10 skills section ===");
  console.log(prompt.split("\n\n").find((s) => s.startsWith("## skills")));

  // 2. A Skill added on disk, but the registry is a snapshot that the build scanned
  writeSkill(workspace, "beta", "Beta catalog entry");
  const model2 = new Recorder();
  const runner2 = buildAgent(P10, {
    model: model2,
    workspace,
    approvalProvider: { async decide() { return new PermissionDecision("allow", "t", "t"); } },
    auditSink: { async record() {} },
  });
  await runner2.run("hi");
  const prompt2 = model2.requests[0]?.messages[0]?.content ?? "";
  console.log("\n=== After beta is added on disk, a rebuilt Agent sees it ===");
  console.log(prompt2.split("\n\n").find((s) => s.startsWith("## skills")));

  // 3. Inside one provider: the Skill directory does not rescan itself
  const tools = new ToolRegistry();
  const skills = SkillRegistry.scan(workspace);
  const provider = new DynamicPromptProvider({
    renderer: new DynamicPromptRenderer(),
    identity: "agent",
    tools,
    workspace,
    context: {},
    skills,
  });
  const before = provider.render();
  writeSkill(workspace, "gamma", "Gamma catalog entry");
  const after = provider.render();
  console.log("\n=== Same provider: add gamma on disk ===");
  console.log("Two renders are identical =", before === after);
  console.log("gamma appears  =", after.includes("gamma"));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe4-live.ts
```

Actual output:

```text
=== The P10 tools section ===
## tools
- shell
- read_file
- write_file
- edit_file
- glob
- todo_write
- task
- load_skill

=== The P10 skills section ===
## skills
- **alpha**: Alpha catalog entry

=== After beta is added on disk, a rebuilt Agent sees it ===
## skills
- **alpha**: Alpha catalog entry
- **beta**: Beta catalog entry

=== Same provider: add gamma on disk ===
Two renders are identical = true
gamma appears = false
```

The last two lines are the point of this experiment: **one provider does not rescan the disk.** This is a design boundary, not a bug. The reason is in the section "The exact boundary of 'takes effect in the next turn'".

The tool list order is also worth recording: `shell` through `glob` are the chapter 2 base tools, `todo_write` comes from chapter 5, `task` comes from chapter 6, and `load_skill` comes from chapter 7. The composition root registration order decides this order. `tests/ch07-skills.test.ts` asserts these eight names exactly. A comment in `bootstrap.ts` states why `load_skill` sits last:

```typescript
// load_skill is registered after task to keep parent tool order stable while child tools reuse the same registry.
tools.register(skillRegistry.toolDefinition);
```

### Experiment 5: how many times is the memory injected, exactly

Save it as `code\scratch\probe5-once.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRunner } from "../chapters/ch10/src/core/loop.js";
import { assistantMessage } from "../chapters/ch10/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch10/src/core/model.js";
import { ToolRegistry } from "../chapters/ch10/src/core/tools.js";
import {
  MemoryRecord,
  MemorySession,
  MemoryStore,
  MemoryType,
} from "../chapters/ch10/src/features/memory.js";
import {
  DynamicPromptProvider,
  DynamicPromptRenderer,
} from "../chapters/ch10/src/features/prompting.js";

class Recorder implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    return { message: assistantMessage("done"), finishReason: "stop" };
  }
}

// Deliberately keep the emitContextMessages default of true, and also connect memory to the dynamic Prompt.
async function run(emitContextMessages: boolean): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "probe5-"));
  try {
    const store = new MemoryStore({ workspace, idGenerator: () => "one" });
    await store.add(
      new MemoryRecord({
        name: "database",
        description: "Production database constraints",
        kind: MemoryType.PROJECT,
        body: "Always use a real database.",
      }),
    );
    const memory = new MemorySession({
      store,
      selector: { async select() { return '["database"]'; } },
      emitContextMessages,
    });
    const tools = new ToolRegistry();
    const model = new Recorder();
    const runner = new AgentRunner({
      model,
      tools,
      systemPrompt: "fallback",
      systemPromptProvider: new DynamicPromptProvider({
        renderer: new DynamicPromptRenderer(),
        identity: "agent",
        tools,
        workspace,
        context: { chapter: 10 },
        memory,
      }),
      workspace,
      turnLifecycle: memory,
    });

    await runner.run("Check the database");

    const request = model.requests[0];
    const hits = (request?.messages ?? []).filter((message) =>
      (message.content ?? "").includes("Always use a real database."),
    );
    console.log(
      `emitContextMessages=${String(emitContextMessages).padEnd(5)} -> the memory body appears ${hits.length} times in the main request` +
        ` (${request?.messages.length} messages in total)`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

await run(true);
await run(false);
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe5-once.ts
```

Actual output:

```text
emitContextMessages=true  -> the memory body appears 2 times in the main request (3 messages in total)
emitContextMessages=false -> the memory body appears 1 time in the main request (2 messages in total)
```

This experiment deliberately bypasses `bootstrap` and assembles `AgentRunner` by hand. The purpose is to reproduce the consequence of "forgetting to turn off the old path". A normal `buildAgent(P10, ...)` run does not have this problem, because the composition root forces it off with `createMemorySession(dependencies, !dynamicPrompt)`.

To see the P09 and P10 injection position difference at the same time, switch the profile to `buildAgent`. The output in the section "The change in injection position" in this chapter comes from such a run.

### Experiment 6: every failure branch of the provider contract

Save it as `code\scratch\probe6-provider.ts`:

```typescript
import { AgentRunner } from "../chapters/ch10/src/core/loop.js";
import { assistantMessage } from "../chapters/ch10/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch10/src/core/model.js";
import { ToolRegistry } from "../chapters/ch10/src/core/tools.js";

class Recorder implements ModelClient {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    return { message: assistantMessage("done"), finishReason: "stop" };
  }
}

async function attempt(label: string, provider: unknown): Promise<void> {
  try {
    const runner = new AgentRunner({
      model: new Recorder(),
      tools: new ToolRegistry(),
      systemPrompt: "build-time fixed fallback",
      systemPromptProvider: provider as never,
      workspace: process.cwd(),
    });
    const result = await runner.run("hi");
    console.log(`${label.padEnd(26)} pass -> finalText=${JSON.stringify(result.finalText)}`);
  } catch (error) {
    console.log(`${label.padEnd(26)} fail -> ${(error as Error).name}: ${(error as Error).message}`);
  }
}

await attempt("Normal string", { render: () => "## identity\nagent" });
await attempt("Empty string", { render: () => "" });
await attempt("Whitespace only", { render: () => "   \n  " });
await attempt("Returns null", { render: () => null });
await attempt("Returns a number", { render: () => 42 });
await attempt("render is not a function", { render: "not a function" });
await attempt("No render", {});
await attempt("render throws internally", {
  render: () => {
    throw new Error("the renderer blew up");
  },
});

// Prove that the build-time systemPrompt is no longer used when a provider exists
const model = new Recorder();
const runner = new AgentRunner({
  model,
  tools: new ToolRegistry(),
  systemPrompt: "build-time fixed fallback",
  systemPromptProvider: { render: () => "runtime rendered result" },
  workspace: process.cwd(),
});
await runner.run("hi");
console.log("\nThe system message actually sent to the model =", JSON.stringify(model.requests[0]?.messages[0]?.content));
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\probe6-provider.ts
```

Actual output:

```text
Normal string              pass -> finalText="done"
Empty string               fail -> AgentRunError: System prompt provider returned an empty prompt
Whitespace only            fail -> AgentRunError: System prompt provider returned an empty prompt
Returns null               fail -> AgentRunError: System prompt provider returned an empty prompt
Returns a number           fail -> AgentRunError: System prompt provider returned an empty prompt
render is not a function   fail -> TypeError: systemPromptProvider must implement render()
No render                  fail -> TypeError: systemPromptProvider must implement render()
render throws internally   fail -> Error: the renderer blew up

The system message actually sent to the model = "runtime rendered result"
```

Three observations:

- The first two `TypeError` results are thrown **at construction time**. `run()` never started. The earlier a contract problem surfaces, the better.
- Four kinds of "wrong return value" all map to the same `AgentRunError`, because for the Loop they are one class of problem: it cannot get a usable system prompt.
- The last line proves that `systemPrompt: "build-time fixed fallback"` is not used at all. When a provider exists, it is dead code. It is useful only on the P09 and earlier paths.

To see what the real P10 identity section looks like, run once with the provider switched to `buildAgent(P10, { ..., identity: "demo-user" })`. You get the output in the section "What it looks like in a real run" in this chapter. When you do not pass `identity`, the composition root falls back to `"user"`, and the context holds `"identity":"user"`.

### Cleanup

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item -Recurse -Force '.\scratch'
```

All six experiments create a temporary directory with `mkdtempSync` and clean up with `rmSync`. They leave no `.memory` or `skills` directory in the repository. The only thing you must delete by hand is `scratch` itself.

---

## What This Chapter Does Not Do

Claiming a capability that the tutorial does not have is the easiest trap to fall into. State the boundaries clearly:

| Already has | Does not have yet | When to add it |
| --- | --- | --- |
| Five fixed sections | A static / dynamic cache boundary split | **Will not add**. It needs adapter-layer cache-control support. See "This cache is not the API prompt cache" |
| Renderer instance cache | An API-level prompt cache hit guarantee | **Will not add**. The current OpenAI adapter has no block split |
| All content rendered into the system prompt | A system context / user context separation | **Will not add**. See "Differences from Claude Code" |
| A build-time scan of the Skill directory | Runtime hot update on a directory change | **Will not add**. It needs an explicit invalidation notification. It must not rely on polling |
| A Profile controls the capability set | Replace the whole prompt by run mode | **Will not add**. The teaching edition needs only one section set |
| A `cacheHits` counter | A real API cache ratio / TTFT experiment | **Will not add**. It needs real credentials and a load-test environment |
| Strict JSON context | A context schema declaration and versioning | **Will not add**. The current context holds only the chapter number and the identity |
| Offline assertions on order and content | Prompt quality evaluation (A/B, behavior regression) | This is the next step to take. It is not in this chapter's scope |

Two rows need special emphasis.

**There is no static / dynamic cache boundary.** This chapter renders identity, tools, workspace, the Skill catalog, and the selected memory **all** into the system prompt. That means one memory change changes the text of the whole system prompt. If the vendor caches by prefix, this also invalidates the earlier sections that did not actually change. A real product must split the static part and the dynamic part into different cache blocks. This chapter does not build that split, and it does not claim the benefit.

**There is no prompt quality evaluation.** All 226 tests in this chapter verify "is the structure correct": is the order right, does the cache leak across sessions, does a body leak, how many times is the memory injected. **Not one test verifies "does this prompt set make the model perform better".** That work needs an evaluation set and a behavior comparison. It is a completely different job.

---

## Differences from Claude Code

The Claude Code system prompt also assembles by section. But its scale is much larger than this teaching edition, and it separates static and dynamic content explicitly.

**Static / dynamic boundary.** In the standard interactive mode, static sections — `identity`, `doing_tasks`, `using_tools`, `tone_style`, and others — and dynamic sections — `session_guidance`, `memory`, `env_info_simple`, `output_style`, and others — are separated by `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. `mcp_instructions` is the only volatile section. It is marked with `DANGEROUS_uncachedSystemPromptSection()` so that it does not take part in the normal section cache — because an MCP server can connect or disconnect between turns.

The P10 order `identity -> tools -> workspace -> skills -> memory` only appends the optional sections to the end. It has no static / dynamic boundary, and it has no section that must bypass the cache. For a teaching edition, this is a reasonable simplification. But it means the P10 system prompt is one whole block where "everything can change".

**Cache levels.** The official API prompt caching caches the `tools`, `system`, and `messages` prefixes. It hits only when the full prefix before the breakpoint is identical ([Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)). Beyond the API-level cache, Claude Code also has a session-level `getSystemContext` / `getUserContext` memoize and a dynamic section registration cache.

P10 has only the renderer instance cache level. And the current OpenAI adapter does not split the static and dynamic sections into different cache blocks. So even when one session reuses an assembly result, the design cannot guarantee a vendor-side static prefix cache hit.

**Context ownership.** Claude Code appends **system context** such as `gitStatus` and `cacheBreaker` to the system prompt. It prepends **user context** such as `CLAUDE.md` and the current date as a `<system-reminder>` user message. P10 renders all visible context into the system prompt. It does not distinguish ownership.

This difference affects the stability of the static prefix directly: a user message change should not break the system prompt cache prefix, and P10 does not currently use that layer. If you want prefix caching in your own project, this is the first place to change.

**Mode replacement.** Claude Code supports run modes such as `CLAUDE_CODE_SIMPLE`, Proactive/KAIROS, Coordinator, and Agent. Some modes replace the standard sections wholesale with a compact prompt or a dedicated prompt. Under `CLAUDE_CODE_SIMPLE`, the core prompt is only about 150 characters.

The P10 Profile only controls the capability set. The renderer always outputs the same section set. A real product usually switches the whole instruction set by run mode. This is one clear line between the teaching edition and a product.

Summary of the four differences:

| Dimension | Claude Code | P10 |
| --- | --- | --- |
| Section scale | Many, explicitly split into static / dynamic groups | Five, all treated as changeable |
| Cache levels | API prefix cache + session memoize + section registration cache | Only the renderer instance cache |
| Volatile content | `mcp_instructions` is explicitly marked to bypass the cache | No such concept |
| Context ownership | System context goes to system, user context goes to a `<system-reminder>` message | Everything goes to the system prompt |
| Run modes | Many modes, can replace the whole prompt | One section set |

---

## What to Learn from ai-agent-book: Fix the Cache Boundary First, Then Make the Prompt Dynamic

In the external repository [`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book), `book/chapter2.md` is the closest comparison for this chapter. It uses the KV Cache and an Agent status bar to explain "what can go into the system prompt, and what you should append at the end".

P10 renders identity, tools, workspace, the Skill catalog, and the selected memory all into the system prompt. That is a teaching simplification. Its cost is that you cannot claim an API prompt cache hit.

| Key design in ai-agent-book | P10 counterpart | Difference and boundary |
| --- | --- | --- |
| Static prefix + dynamic trajectory, separated | P10 fixes five sections. Runtime state only reads the data sources | P10 has no static/dynamic cache boundary |
| Dynamic information appended at the end | The optional P10 skills/memory sections append to the prompt end | P10 still keeps everything in the system prompt. ai-agent-book suggests dynamic state as a user message at the end |
| The code maintains the Agent status bar deterministically | The P10 provider/renderer reads the runtime objects again in every turn | P10 has no independent status bar. workspace/skills/memory are all in the system prompt |
| The Skills catalog is resident, the body loads on demand | `SkillRegistry.renderCatalog()` + `loadSkill()` | P10 already agrees with the ai-agent-book position |
| An experiment defines the metric first, then the implementation | Offline tests: `cacheHits`, order assertions, context normalization, single memory injection | P10 has no real API cache ratio / TTFT experiment |

The most valuable lesson is **order**: first decide where the cache boundary is, then decide where the dynamic content goes. P10 does it in reverse — it splits the sections cleanly first, and it leaves the cache boundary for later. In teaching, that is acceptable: the split itself is what this chapter teaches. But in a real project, if you do not think through "which content changes, and who a change invalidates" at the start, you will very likely have to turn the whole prompt structure over again later.

If you evolve P10 further, the priority should be: first split the context by ownership into the system and user sides, then introduce static / dynamic cache blocks, and only then do prompt quality evaluation. In the reverse order, cache structure changes keep overturning the evaluation results.

---

## Companion Code Index

The chapter 10 implementation is concentrated in `code/chapters/ch10/src/`. The chapter entry fixes the P10 Profile. This chapter adds `features/prompting.ts`, and it connects to AgentRunner through the `SystemPromptProvider` interface in `core/loop.ts`.

- Feature implementation: `code/chapters/ch10/src/features/prompting.ts`
- Composition root: `code/chapters/ch10/src/bootstrap.ts`
- Loop connection point: `code/chapters/ch10/src/core/loop.ts`
- Capabilities and profile: `code/chapters/ch10/src/core/profiles.ts`
- Chapter entry: `code/chapters/ch10/src/chapters/ch10.ts`
- Data sources: `code/chapters/ch10/src/core/tools.ts`, `features/skills.ts`, `features/memory.ts`
- Direct behavior tests: `code/chapters/ch10/tests/prompting.test.ts`
- Wiring tests: `code/chapters/ch10/tests/ch10-prompt.test.ts`

Read from top to bottom, the three roles divide the work like this:

```text
ToolRegistry / SkillRegistry / MemorySession   ← Each holds its data and validates it
     ↑ reads only the current values
DynamicPromptRenderer   ← validation + normalization + fixed-order assembly + instance cache
     ↑ zero-argument adapter
DynamicPromptProvider   ← binds at build time, only forwards at run time
     ↑ SystemPromptProvider interface
AgentRunner             ← calls render() before each request, does not know how many sections exist
```

The last line deserves attention: `AgentRunner` knows only the `SystemPromptProvider` interface — one zero-argument method. It knows nothing about what the prompt contains. So you can remove the dynamic prompt capability as a whole, and the Loop does not change by one line. That is how P09 runs.

| Implementation | Responsibility and boundary |
| --- | --- |
| `DynamicPromptRenderer.render()` | The single rendering entry. It validates four input types, normalizes the context, generates the cache key, and outputs the five sections in a fixed order |
| `normalizeIdentity()` | Rejects a non-string and a blank identity. After the trim, the identity joins the cache key |
| `normalizeContext()` / `normalizeJsonValue()` | Clones legal JSON recursively and freezes it. It rejects a non-plain object, a symbol key, a non-finite number, and a cyclic reference |
| `isPlainObject()` | Judges a plain object by strict prototype equality. It rejects `Date`, `Map`, and every class instance |
| `stableJson()` | Serializes with a recursive key sort, so a context with equal semantics gets the same text and the same cache key |
| The `#lastKey` / `#lastPrompt` of `DynamicPromptRenderer` | An instance-level cache. It reuses only when the canonical snapshots of all six inputs are equal. A validation failure writes nothing |
| `cacheHits` | For tests and observability only. It proves that an identical input does not reassemble. It is not a performance metric |
| `DynamicPromptProvider` | Binds the renderer and the runtime objects at build time. It exposes a zero-argument `render()`. When an optional capability is missing, it does not pass the key |
| `SystemPromptProvider` | The Loop-side interface. It has only `render(): string`. It decouples the Loop from the data sources |
| `AgentRunner.#renderSystemPrompt()` | Renders before each model request. An empty value or a non-string throws `AgentRunError` at once. It does not fall back to the build-time string |
| `bootstrap.createMemorySession()` | Uses `!dynamicPrompt` to decide `emitContextMessages`, and guarantees that the memory is injected only once |
| `P10` | Adds `dynamic_prompt` on top of the P09 capabilities, so the composition root switches to the runtime rendering path |
| `ch10.ts` | Fixes the chapter entry to P10, and prevents this entry from enabling other capabilities by accident |

---

## Run and Verify

Chapter 10 has two equivalent start methods. Choose either one:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch10 -- --prompt "List the current directory and summarise it"
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 10 --prompt "List the current directory and summarise it"
```

Both take the P10 Profile. That is the path with the dynamic prompt enabled.

`--prompt` is a **named argument. You cannot omit it.** If you write `npm run ch10 -- "List the current directory and summarise it"` directly, it fails at once:

```text
Runtime Failure: Unknown argument: List the current directory and summarise it
```

The fixed entry `ch10` already adds `--chapter 10` automatically. You do not need to pass it yourself.

Run the tests:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch10
```

The actual result when this chapter was written:

```text
Test Files  25 passed (25)
     Tests  226 passed (226)
```

Of the 226 tests, two files relate directly to this chapter:

| File | What it verifies | Test count |
| --- | --- | --- |
| `tests/prompting.test.ts` | The direct behavior of the renderer and the provider: section order, optional section omission, context normalization and rejection, cache hits and isolation, `__proto__` handling | 10 (including one `test.each` with 4 variants) |
| `tests/ch10-prompt.test.ts` | Whether the wiring is correct: does the Agent from the real bootstrap get the right system prompt order in every turn, and is the memory injected only once | 1 |

The two files hold 11 tests in total. You can run them alone to check.

**One test gap needs a clear statement:** none of the **type guards** in this chapter has a test. Only Experiments 2 and 6 ran them. The only `toThrow` assertions in `prompting.test.ts` are `PromptContextError` and `/cyclic/` — both belong to context validation. You cannot find the nine errors below in the tests of any of the twenty chapters:

| Error message | Where it throws | Covered by which experiment |
| --- | --- | --- |
| `identity must not be empty` | `normalizeIdentity()` | Experiment 2 (both `""` and `"   "`) |
| `identity must be a string` | Same as above | — (Experiment 2 passed only an empty string and whitespace, not a non-string) |
| `tools must be ToolRegistry` | `DynamicPromptRenderer.render()` | — |
| `workspace must be a non-empty string` | Same as above | — |
| `skills must be SkillRegistry or undefined` | Same as above | — |
| `memory must be MemorySession or undefined` | Same as above | — |
| `renderer must be DynamicPromptRenderer` | The `DynamicPromptProvider` constructor | — |
| `systemPromptProvider must implement render()` | The `AgentRunner` constructor | Experiment 6 |
| `System prompt provider returned an empty prompt` | `AgentRunner.#renderSystemPrompt()` | Experiment 6 |

This is a current test gap. It does not mean the behavior does not hold — the experiment output is the real result of these branches. If you want to fill the gap, these are all pure synchronous validations. Each one is simpler to write than any existing test in this chapter.

If you changed `prompting.ts` and want a quick verification, run only these two files:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx vitest run chapters/ch10/tests/prompting.test.ts chapters/ch10/tests/ch10-prompt.test.ts
```

Before you commit, run the full checks once more:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run lint
npm run typecheck
```

---

## Chapter Summary

### The three-sentence version

1. A hard-coded prompt string is fixed at build time. When the tools, the Skills, or the memory change, it lies. This chapter turns the prompt into a **function** that renders again before each request.
2. The rendering has three roles: `DynamicPromptRenderer` only validates and assembles, `DynamicPromptProvider` binds the data sources and adapts them into a zero-argument interface, and `AgentRunner` calls `render()` once per turn.
3. The fixed five-section order (`identity -> tools -> workspace -> skills -> memory`), the canonical JSON cache key, and the instance-level cache together guarantee "the same context → the same text". This is the foundation for later cache boundary work.

### Five rules to remember

**Rule 1: the section order is a contract, not layout.** An optional section can only append to the end. It cannot cut in line. Once the order changes with the input, the cache key loses its meaning, and the structure that the model sees becomes unstable. The order assertions in the tests guard this line.

**Rule 2: the cache key must cover every model-visible input.** The P10 key holds six items: `context`, `identity`, `memory`, `skills`, `tools`, and `workspace`. Miss one item, and that item can change while the program reuses the old prompt. The model then receives stale information. This bug class throws no error. It only makes the Agent behavior inexplicable.

**Rule 3: the cache must be at instance level.** A module-level global cache lets two sessions pollute each other: the memory of session A can appear in the prompt of session B. This is not a performance problem. It is data leakage.

**Rule 4: validate before you write the cache.** An invalid context must throw, and it must **leave no trace**. If you write the cache first and validate second, one failure pollutes every later render.

**Rule 5: inject the memory only once.** After the dynamic prompt is on, the memory already enters the system prompt as the `## memory` section. `MemorySession` must then stop sending its own system message. The negation in `createMemorySession(dependencies, !dynamicPrompt)` does this job. It looks inconspicuous. Remove it, and you get a double injection.

### Check whether you really understood

Try to answer the five questions below. If you cannot answer one, go back to the matching experiment and run it again.

1. Why does `render()` take zero arguments? If it accepted arguments, who would become a dependency of the Loop? (Experiment 6 / the `SystemPromptProvider` section)
2. Do `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }` hit the same cache? Why do you need canonical JSON? (Experiments 2 and 3)
3. What happens when you put a `new Date()` into the context? Why not accept it directly? (Experiment 2)
4. The tool list changed but the identity did not. Does the cache hit? State your basis. (Experiments 1 and 3)
5. You add a Skill directory on disk. Does the running Agent see it? Why? (Experiment 4 / "What This Chapter Does Not Do")

Question 5 is the easiest to answer wrongly: no, it does not see it. `SkillRegistry.scan()` is a one-time build-time snapshot. It does not watch for directory changes. The "dynamic" in dynamic prompt means **read the runtime objects again in every turn**. It does not mean **rescan the disk at run time**. These two things are easy to confuse.

---

Chapter 10 turned the prompt from "a string at build time" into "a function at run time". At this point, the context that the Agent sees in every turn is finally the capability set it really has.

But a real run is far more than "is the context right". The model can stop mid-output through truncation. The API can apply a rate limit. It can return a 503. The input can exceed the context window. You may also want to switch to a different model in the middle. None of these is a logic error. They are conditions that a run will necessarily meet — and chapter 11 handles them one by one.
