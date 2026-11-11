In the previous chapter, we ran the smallest Agent Loop: the model could request `shell`, the runtime executed PowerShell, and the runtime returned the result to the model by `tool_call_id`.

But `shell` alone is not enough.

When the model wants to read a file, it must build a `Get-Content` command itself. When the model wants to write a file, it must also handle the path, quotes, line breaks, and encoding. In other words, the real intent of the model is "read this file", but the program translates that intent into a PowerShell command. The more complex the translation is, the easier it is to make a mistake. The model also spends reasoning on details that do not matter.

This chapter adds four dedicated tools to the Agent:

- `read_file`: read UTF-8 text;
- `write_file`: write UTF-8 text;
- `edit_file`: replace the first exact text;
- `glob`: find workspace files by pattern.

After this change, P02 has five tools in total: `shell`, `read_file`, `write_file`, `edit_file`, and `glob`.

The most important point is this: the Agent Loop does not need to change.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaFwcgKu3oibhStZK50Z8SiahgiaBbW57wLEMOJnoibvia0ibsh4xcgVTicP70iabZclr1iaSIibhtkrkvtIb605nttNRap3PeFFJ7JddwSeM/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

From a context engineering point of view, a tool definition is not a separate registry. It is part of the context that the model actually sees on each call. The `tools` field in the API request and the `system` message together form the **static prefix**. If the system prompt and the tool definitions do not change, the server can reuse the KV Cache for this prefix. Later turns then only process the new message history.

This fact gives one hard constraint. After the tool set is fixed, the runtime must not reorder the tools or rewrite the descriptions on each turn. If the prefix changes, the cached result becomes invalid. The model also sees an inconsistent capability boundary. The fixed registration order, the immutable snapshot, and the single-source schema in this chapter all build this stable prefix.

---

## Chapter Guide

### What You Will Be Able to Do After This Chapter

1. Add a new tool to an Agent on your own, and explain why the Agent Loop does not need to change.
2. Use Zod to write an input schema where the "instructions the model sees" and the "runtime validation rules" come from the same source.
3. Explain why `edit_file` cannot accept line numbers, and state the correct edit workflow for the model.
4. Explain what each of the two checks in `safePath` blocks, and explain why the second check must access the disk.
5. Run Chapter 2, and let the Agent complete one full "write → edit → read → find" path with file tools only.

### What You Need First

| Need | Level |
| --- | --- |
| Chapter 1 | **Required**. You must understand `ToolRegistry`, `ToolResult`, `tool_call_id` pairing, and the approval boundary |
| TypeScript | You can read `interface`, `async/await`, and `instanceof` checks |
| Zod | Not required. This chapter explains every pattern it uses |
| File system concepts | You know roughly what "relative path / absolute path" and "symbolic link" mean |

### Quick Glossary (Terms That Appear for the First Time in This Chapter)

| Term | One-sentence explanation |
| --- | --- |
| **ToolDefinition** | The complete declaration of one tool: name, description, input schema, effect, and handler. The five items sit in one object |
| **Zod** | A runtime validation library for TypeScript. One schema can validate data and also export a JSON Schema |
| **`z.strictObject`** | A strict object in Zod: the runtime rejects every field that the schema does not declare. It does not ignore the field |
| **`.describe()`** | Adds descriptive text to a Zod field. The text enters the exported JSON Schema, and the model reads it |
| **Static prefix / KV Cache** | The start of a request that does not change between turns (`system` + `tools`). If the bytes are stable, the server can reuse the computed result, which saves cost and latency |
| **safePath** | A function that translates a "workspace-relative path" into a safe absolute path. If it cannot translate the path, it rejects the path. It never guesses a fix |
| **junction / symbolic link** | A directory "shortcut" that points somewhere else. The text path looks inside the workspace, but the real location can be outside |
| **NTFS ADS** | The Windows Alternate Data Stream. A colon in a path triggers it, for example `file:stream` |
| **Windows reserved names** | `NUL`, `CON`, `COM1`, `LPT9`, and similar names. They point to devices, not files |
| **effect (side-effect class)** | The impact range that a tool declares for itself: `read`, `write`, `execute`. In Chapter 2 it is metadata only. It takes part in decisions only in Chapter 3 |
| **WorkspaceFileSystem** | The file capability interface that the core layer declares. The feature layer knows only this interface. It does not know Node |
| **profile (P01/P02)** | The chapter capability allowlist. P02 = P01 + `tool_registry` + `files` |

### Suggested Reading Route

```text
Chapter Guide (you are here)
  ↓
① Define the observable results first  ← The acceptance criteria for this chapter, 9 items
  ↓
② One complete example                 ← How the model completes one task with the four tools
  ↓
③ ToolRegistry                         ← Where the "one line" goes
  ↓
④ File system boundary + Zod           ← Dependency direction, single-source schema, descriptions are also context
  ↓
⑤ safePath                             ← The core of security in this chapter, two checks
  ↓
⑥ The four tools, one by one           ← The trade-offs in read / write / edit / glob
  ↓
⑦ Error mapping + profile              ← Stable error codes, the difference between P01 and P02
  ↓
⑧ Pairing and the permission boundary  ← The hard rule for multiple tools in one turn, and the gap this chapter leaves on purpose
  ↓
⑨ Run, verify, and summary             ← Hands-on work + troubleshooting table + self-test questions
```

---

## Define the Observable Results First

This chapter is not complete when you "write four functions". The final behavior must meet these conditions:

1. P01 still exposes only `shell` to the model;
2. P02 exposes five tools in a fixed order;
3. Tool arguments must pass strict schema validation first, and only then produce side effects;
4. A file path can only land inside the current workspace;
5. `..`, absolute paths, Windows device names, and links outside the workspace must fail;
6. Writes use UTF-8 and return the real byte count;
7. An edit replaces only the first exact text, and does not change the file when the text is not found;
8. glob returns POSIX-style relative paths in stable sorted order;
9. Multiple tool calls in one assistant message still return one result each, and keep `tool_call_id` pairing.

### Companion Code Structure

The source code for this chapter sits in `code/chapters/ch02/src/`. Each file has this responsibility:

| File                                      | Responsibility                                                            |
| --------------------------------------- | ------------------------------------------------------------- |
| `core/tools.ts`                         | Tool Registry, ToolDefinition, argument prepare, immutable snapshot, OpenAI schema export |
| `core/filesystem.ts`                    | WorkspaceFileSystem interface and file domain error types                               |
| `core/loop.ts`                          | AgentRunner core loop, message pairing, maximum turns, authorizer boundary                              |
| `core/messages.ts`                      | Message role union type, immutable factory functions, tool_call_id pairing validation                            |
| `core/model.ts`                         | Model boundaries such as ModelClient, ModelReply, and OpenAIToolSchema                 |
| `core/commands.ts`                      | CommandRunner and CommandResult command execution boundary                            |
| `core/profiles.ts`                      | P01/P02 fixed capability snapshots and chapter entry validation                                         |
| `features/builtin-tools.ts`             | The Zod schema, description, effect, handler, and registration functions for shell and the four file tools              |
| `adapters/filesystem.ts`                | NodeWorkspaceFileSystem and the double path boundary check in safePath                   |
| `adapters/powershell.ts`                | PowerShellRunner subprocess execution, timeout, and output truncation                                |
| `adapters/openai-chat.ts`               | OpenAI Chat Completions adapter, response normalisation, and refusal handling                 |
| `bootstrap.ts`                          | Selects the tool set by profile and assembles the AgentRunner                                |
| `config.ts`                             | .env parsing, required-field validation, baseUrl normalisation                                    |
| `cli.ts`                                | General CLI and fixed chapter entry, terminal interactive approval, exit by error code                                   |
| `chapters/ch01.ts` / `chapters/ch02.ts` | Fixed profile entry, locks the chapter capability snapshot                                        |

Later sections go deep into the tool layer, the file adapter, and the Agent Loop. The `model`, `commands`, `openai-chat`, `config`, and `cli` parts are the run entry and the provider boundary. When you read the source code, start with the contracts in `core/`. Then read how `adapters/` implements these contracts.

---

## One Complete Example: How the Four Tools Connect

An abstract contract is hard to remember, so look at one real run first. The user enters:

> Use file tools only: write `demo/note.txt` with content `alpha`; change the first `alpha` to `gamma`; read the file and use glob to list `demo/*.txt`

The model splits the task into four steps itself, one step per turn. The list below shows only the key fields in each turn (the `tool_call_id` pairing rules from Chapter 1 do not change at all):

| Turn | Tool the model requests | `arguments` | Result returned to the model |
| ---: | --- | --- | --- |
| 1 | `write_file` | `{"path":"demo/note.txt","content":"alpha"}` | `Wrote 5 UTF-8 bytes to demo/note.txt` |
| 2 | `edit_file` | `{"path":"demo/note.txt","old_text":"alpha","new_text":"gamma"}` | `Edited demo/note.txt` |
| 3 | `read_file` | `{"path":"demo/note.txt"}` | `gamma` |
| 4 | `glob` | `{"pattern":"demo/*.txt"}` | `demo/note.txt` |
| 5 | (no tool call) | — | The model gives the final text, and the loop exits |

Note that the return value in turn 1 is `5`: the five ASCII characters in `alpha` are exactly 5 bytes. Change the content to `你好` and the result is `6`. The section "The Byte Count Follows the Content on Disk" in this chapter explains this point.

### How Hard the Same Task Is with the Chapter 1 Approach

For the same task, with `shell` only, the model must write this:

```powershell
Set-Content -Path .\demo\note.txt -Value 'alpha' -Encoding utf8
(Get-Content .\demo\note.txt -Raw) -replace 'alpha','gamma' |
    Set-Content .\demo\note.txt -Encoding utf8 -NoNewline
Get-Content .\demo\note.txt
Get-ChildItem .\demo\*.txt | Select-Object -ExpandProperty Name
```

The problem is not that this is "long". The problem is that **every step can fail silently**:

| Hazard | Consequence |
| --- | --- |
| The `demo` directory does not exist | `Set-Content` fails at once, and the model must think of `New-Item` first |
| The model forgets `-Encoding utf8` | PowerShell 5 writes UTF-16 by default, and Chinese text becomes garbled |
| The model uses `-replace` | That operator does a **regular expression** replacement, so `.` in `alpha.beta` matches any character |
| The model uses `-replace` | It replaces **all** matches, not the first one |
| The model forgets `-NoNewline` | The file gets an extra line break at the end, and the next exact match fails |
| The content contains a single quote | A wrong quote escape breaks the command syntax at once |

**This is the real reason to add dedicated tools**: not to type less, but to change these hazards from "the model must remember them every time" to "the tool is correct by default". `write_file` creates parent directories automatically and fixes the encoding to UTF-8. `edit_file` does an exact text match, not a regular expression match, and changes only the first occurrence. The model can save its reasoning budget for the task itself.

### Failure Is Also Part of the Complete Path

The model can try to access a file outside the workspace. The runtime does not throw an exception and break the loop in this case. It returns an error result instead:

```text
assistant  tool_calls=[ { id:"call_9", name:"read_file",
                          arguments:'{"path":"../secret.txt"}' } ]
tool       tool_call_id="call_9"
           content="Error [path_escape]: Path escapes workspace: ../secret.txt"
```

When the model sees `path_escape`, it knows to change the path. It does not get stuck. This behavior inherits the principle from Chapter 1: **a tool failure is data, not an exception**.

---

## ToolRegistry: The Loop Only Dispatches

If you hard-code tools inside the loop, the second tool starts a pile of conditional branches:

```typescript
// Counter-example: do not let the Agent Loop know concrete tools.
if (call.name === "shell") {
  return runShell(call.arguments);
}
if (call.name === "read_file") {
  return readFile(call.arguments);
}
```

The problem with this structure is not only that the code gets longer. Each new tool forces a change to the loop. Tool argument parsing, error handling, and the call protocol also scatter across different branches. A better design lets the loop know only the abstract protocol "one call returns one result". The loop does not care what the tool does.

The companion implementation continues to use the `ToolRegistry` from Chapter 1. The loop handles only `ToolCall`, `PreparedToolCall`, and `ToolResult`:

```typescript
for (const call of assistant.toolCalls) {
  const prepared = tools.prepare(call);
  const result =
    prepared.error === undefined
      ? await tools.invoke(prepared, context)
      : prepared.error;
  this.#history.push(toolMessage(result.content, call.id));
}
```

The registry does four things:

1. It finds a tool by name;
2. It parses the JSON string from OpenAI into an object;
3. It validates the arguments strictly with Zod;
4. It calls the handler that sits in the same `ToolDefinition` as the schema.

An unknown tool, bad JSON, a wrong type, and an extra field all become a structured error before the handler runs. Invalid arguments therefore do not write a file first and report an error later.

**This order is the first layer of security in this chapter.** Imagine the reverse order: run `writeFile` first, then validate the arguments. The file is already changed, and a validation failure comes too late. All validation must therefore sit in `prepare()`, and `prepare()` guarantees that it produces no side effect.

The exact meaning of "adding a tool takes one line" is this: after you complete the tool definition, you only register the definition. You do not change the Agent Loop, and you do not maintain a second handler table.

```typescript
registry.register(createReadFileTool(fileSystem));
```

The "one line" is this `register` line. Of course you must still write the tool itself. But **where you write it, and whether the loop must change with it**, is the architecture question. Compare how many places the two approaches must touch:

| Change needed | Hard-coded in the loop | With the registry |
| --- | --- | --- |
| Agent Loop | Add one `if` branch | **No change** |
| Argument parsing | Each branch does its own `JSON.parse` | The registry does it in one place |
| Argument validation | Each branch writes its own, and can easily miss a case | The schema binds to the definition, so a miss is impossible |
| Error handling | Each branch writes its own set | All errors convert to `ToolResult` in one place |
| Schema for the model | You hand-write a second copy, which easily disagrees with the implementation | The runtime exports it from the same Zod definition |
| Change points for a new tool | 3 to 4 places | 1 place (`register`) |

The "No change" entry in the right column is the most important result in this chapter. Chapters 3 to 20 keep adding tools to this registry. If every addition must change the loop, this path does not reach Chapter 20.

---

## Make the File System a Boundary First

File operations belong to an external boundary. The `features` layer must not create a Node file system adapter directly. If it does, the business layer depends in reverse on a concrete implementation.

In plain words: **the handler of a tool must not contain `import { readFile } from "node:fs/promises"`.**

Why? Look at the cost of a direct import:

| Direct `import` of Node fs | Injection through an interface |
| --- | --- |
| To test "a path escape is rejected", you must create a real junction on disk | You inject a substitute, and it throws `WorkspacePathError` directly |
| To test "the file is not valid UTF-8", you must create a file with bad bytes | The substitute returns `InvalidUtf8Error` |
| Tests really write files, and you must clean up after the run | The substitute only records an entry in memory |
| To change to an in-memory file system or remote storage, you must change the handler | You only change the implementation class |

So `code/chapters/ch02/src/core/filesystem.ts` declares only the capability that the runtime needs:

```typescript
export interface WorkspaceFileSystem {
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
```

Four methods correspond to four tools. Note two common points:

1. **The first parameter of every method is `workspace`.** The interface holds no implicit state such as "current directory". Each call must state explicitly where the boundary is. One instance can therefore serve different workspaces, and a state change in one place cannot affect another place.
2. **`relativePath` is named relative.** The name itself is the contract: an absolute path is not "also supported". The runtime rejects it explicitly.

The concrete Node implementation sits in `code/chapters/ch02/src/adapters/filesystem.ts`. A tool definition depends only on the `WorkspaceFileSystem` interface. Only `bootstrap.ts` creates a `NodeWorkspaceFileSystem` and injects it.

This dependency direction matters:

```text
bootstrap
   ├─ creates NodeWorkspaceFileSystem
   └─ injects it into features

features ──depends on──> core/WorkspaceFileSystem
adapters ──implements──> core/WorkspaceFileSystem
```

The key point when you read this diagram: **both arrows point to `core`.** `features` (business) and `adapters` (technical detail) do not know each other. Each side knows only the interface in the middle. If you replace either side, the other side does not change.

A test can inject a substitute. The production entry can inject the Node adapter. The feature layer does not need to know the difference between the two.

---

## Define Strict Input with Zod

The input schemas for the four file tools sit in `code/chapters/ch02/src/features/builtin-tools.ts`:

```typescript
const readFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative file path. `..`, absolute paths, Windows device names, and symlink/junction escapes are rejected.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional maximum number of lines to return. The full file is returned when omitted.",
    ),
});
// Input contract for full writes; empty content intentionally represents clearing files rather than parameter errors.
const writeFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative destination path. Parent directories are created automatically."),
  content: z
    .string()
    .describe("UTF-8 text content to write. Use an empty string to clear the file."),
});
// Input contract for exact editing; old_text is required and non-empty to prevent unbounded insertion.
const editFileInputSchema = z.strictObject({
  path: z.string().min(1).describe("Workspace-relative target file path."),
  old_text: z
    .string()
    .min(1)
    .describe(
      "Exact existing text to replace. Only the first occurrence is changed; read the file first to get exact text.",
    ),
  new_text: z
    .string()
    .describe("Replacement text. Use an empty string to delete the matched text."),
});
// Restricted glob input contract for file discovery. The security boundary rejects parent directory segments.
const globInputSchema = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative glob pattern, for example `**/*.ts`; patterns containing `..` are rejected.",
    ),
});
```

The constraints here are real contracts:

- `strictObject` rejects fields outside the schema;
- `path`, `old_text`, and `pattern` cannot be empty;
- `limit` must be an integer greater than 0;
- `true`, `"2"`, `0`, and `-1` are not valid values for `limit`;
- `content` and `new_text` allow an empty string, because clearing a file or deleting a text segment is a valid operation.

Use real input for `read_file` as an example. You can see at a glance which inputs pass and which inputs fail:

| `arguments` from the model | Result | Reason |
| --- | --- | --- |
| `{"path":"note.txt"}` | Pass | `limit` is optional |
| `{"path":"note.txt","limit":50}` | Pass | A positive integer |
| `{"path":""}` | Reject | `.min(1)`, an empty path has no meaning |
| `{"path":"note.txt","limit":"50"}` | Reject | A string is not a number, and **the runtime does no implicit conversion** |
| `{"path":"note.txt","limit":0}` | Reject | `.positive()`, a request to read 0 lines has no meaning |
| `{"path":"note.txt","limit":2.5}` | Reject | `.int()`, the runtime cannot read half a line |
| `{"path":"note.txt","encoding":"gbk"}` | Reject | `strictObject`: an extra field |
| `{}` | Reject | The required field `path` is missing |

Row 4 and the second-to-last row deserve the most attention:

- **`"50"` is rejected. The runtime does not convert it to `50` automatically.** An implicit conversion looks "tolerant", but it actually hides an error by the model. The model will send a string again next time. An explicit error lets the model correct the call in the same turn.
- **An extra field is rejected. The runtime does not ignore it.** When the model sends `encoding`, it thinks this parameter is useful. A silent ignore deceives the model with "I handled it". The file is then read as UTF-8 and produces garbled text, and nobody knows where the problem is.

These two rules together form one principle: **do not guess the intent of the model.** Input outside the contract fails explicitly in every case.

The Zod schema serves runtime validation and OpenAI tool schema generation at the same time. You do not need to hand-write a second JSON Schema:

```typescript
parameters: z.toJSONSchema(definition.inputSchema)
```

The contract that the model sees and the contract that the handler actually accepts therefore come from the same source. The `.describe()` text on a parameter also enters the OpenAI tool schema with `z.toJSONSchema`. The model needs no extra document. It can see the role of each parameter in the JSON Schema.

| Tool           | Input                             | effect  | Success result   |
| ------------ | ------------------------------ | ------- | ------ |
| `read_file`  | `path`, `limit?`               | `read`  | File text   |
| `write_file` | `path`, `content`              | `write` | Number of bytes written  |
| `edit_file`  | `path`, `old_text`, `new_text` | `write` | Edit confirmation   |
| `glob`       | `pattern`                      | `read`  | List of matching paths |

In Chapter 2, effect is structured metadata only. Chapter 3 uses it in permission decisions.

## Descriptions Are Also Model Context

The `description` of a tool and the parameter descriptions are not documentation. They are context that the model actually reads when it selects a tool. The [OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling) and the [Anthropic tool use documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) both recommend this: a description must state what the tool does, when to use it, what it returns, and the boundary and failure semantics. It must not contain one sentence only.

In the request structure, the tool definitions sit in the top-level `tools` field of the API. Together with the `system` message, they form the static prefix that does not change between turns. The KV Cache depends on byte stability in the prefix. If the runtime reorders tools on each turn, changes descriptions, or puts changing content such as a timestamp into a tool description, the prefix changes. The server then cannot reuse the cached intermediate result. The `ToolRegistry` exports tools stably in registration order, and `snapshot()` forbids a change to the registry in the middle of a turn. The runtime keeps this prefix for this reason.

Experimental evidence also shows the cost of a missing description. If you keep the function signature and the parameter definitions and remove only the descriptive text, the tool call error rate rises clearly. A similar ablation experiment comes from a context engineering tutorial. It is not offline test data from this chapter, but it shows the same point: the more complete the semantic understanding of a tool by the model is, the less likely the model is to send a wrong parameter.

The file tool descriptions in P02 therefore do not use minimal text such as "read a file". They put the key decision information directly into the schema:

- `read_file` states the returned line count, the `limit` semantics, and the UTF-8 failure behavior;
- `edit_file` states that it replaces only the first exact text, does not accept line numbers, and leaves the file unchanged when the text is not found;
- `glob` states that it returns `/` relative paths in stable sorted order;
- `shell` states that it requires interactive approval, so the model does not build PowerShell strings when a file operation is available.

The parameter layer also adds explanations with the `.describe()` method in Zod. `path` describes the workspace-relative path and the rejection rules. `old_text` describes "read the file first, then provide the exact text". `limit` describes the full-read semantics when the model omits it. The JSON Schema that the model sees keeps these descriptions. The runtime validator also comes from the same schema. Drift of the form "the document says it is allowed, the validator rejects it" therefore cannot occur.

Official practice does not fix one template for all cases, but you can split "the model does not need to guess" into four checks:

- What it does: what input the tool accepts, and what side effect it produces;
- When to use it: how it divides work with similar tools, for example file operations take priority over shell;
- What it returns: the form of a success result, for example a byte count, a line count, or a path list;
- What to do on failure: what the stable error code is, and how the model can recover in the next step, for example read first and edit later.

Cross-tool cooperation is also worth writing into a description: `edit_file` requires the model to read the file first and does not accept line numbers. The model then does not build an old text segment from memory. A description is not better when it is longer. It is better when the model does not need to guess at a decision point.

---

## safePath: Hold the Workspace Boundary First

The four tools share one path boundary. The public contract is "workspace-relative path", so the runtime does not guess or repair dangerous input.

The runtime rejects these paths directly:

```text
../secret.txt
nested/../secret.txt
C:\secret.txt
/etc/passwd
NUL.txt
nested/CON.log
file:stream
trailing.
```

The list below explains why, one by one. It also explains several cases that are not intuitive:

| Rejected path | Rejection reason | What happens if the runtime does not block it |
| --- | --- | --- |
| `../secret.txt` | It contains `..` and jumps up out of the workspace | The runtime reads any file outside the workspace |
| `nested/../secret.txt` | It contains `..`. The runtime rejects it even if the final **result** is inside the workspace | See the explanation below |
| `C:\secret.txt` | An absolute path with a drive letter | The contract is a relative path. An absolute path is outside the semantics |
| `/etc/passwd` | An absolute path (POSIX style) | Same as above |
| `NUL.txt` | The first segment is the Windows reserved name `NUL` | The system can resolve it as a device, not a file |
| `nested/CON.log` | One segment is the reserved name `CON` | Same as above. A reserved name is dangerous at **every level** |
| `file:stream` | A colon can trigger an NTFS Alternate Data Stream | Data goes into a hidden stream, and a normal read cannot see it |
| `trailing.` | Win32 silently removes a trailing dot | You think you write `trailing.`, but you actually write `trailing` |

About `nested/../secret.txt`: after simplification, it is `secret.txt`, and it is indeed inside the workspace. **The runtime still rejects it.** The reason is this: if you allow "path simplification", you must guarantee that your simplification logic matches the operating system exactly. Any difference is an exploitable gap. A direct rejection of `..` costs very little. The model only needs to change the path to `secret.txt`.

Names such as `NUL`, `CON`, `COM1`, and `LPT9` can point to devices in Windows, not to normal files. A colon can form an NTFS Alternate Data Stream. Win32 also handles a trailing dot or space in a special way. Even if a name looks normal on another platform, this project rejects it under the Windows 11 run environment.

`safePath` checks in two steps:

```typescript
export async function safePath(
  workspace: string,
  relativePath: string,
): Promise<string> {
  const root = await workspaceRoot(workspace);
  const parts = relativeParts(relativePath, "path", false);
  const target = resolve(root, ...parts);
  if (!isInside(root, target)) {
    throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
  }

  const existing = await resolvedExistingParent(root, target);
  const resolved = resolve(
    existing.physical,
    relative(existing.lexical, target),
  );
  if (!isInside(root, resolved)) {
    throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
  }
  return resolved;
}
```

The first check is a lexical check. It does not need to access the disk. It first rejects an empty value, a NUL byte, an absolute path, a drive letter, `..`, and a reserved Windows component.

The second check resolves the parent path that already exists on disk. If `workspace/escape` is a junction or a symbolic link that points outside the workspace, the text of `escape/secret.txt` looks inside the workspace, but the real path is outside. If the resolved path is not inside the root, the operation fails at once.

### Why the Second Check Must Exist

The first check looks at the string only. The second check touches the disk. **Many people think the first check is enough.** The example below shows why it is not enough.

Assume that someone (or an earlier build script) left a junction in the workspace:

```text
workspace\escape  ──points to──▶  C:\Users\you\.ssh
```

The model requests `read_file` with the argument `escape/id_rsa`. Walk through the two checks:

```text
Input: "escape/id_rsa"

First check (string only, does not touch the disk)
  ├─ Empty value?      No
  ├─ Contains NUL?     No
  ├─ Absolute path?    No
  ├─ Contains ..?      No
  ├─ Reserved name?    escape / id_rsa are both not reserved
  └─ Build target = workspace\escape\id_rsa
     isInside(root, target) → true  ✅ The first check passes it!

Second check (resolves the real path on disk)
  ├─ Find the existing parent directory: workspace\escape
  ├─ Resolve its real location:          C:\Users\you\.ssh   ← the junction is exposed here
  ├─ Rebuild:  C:\Users\you\.ssh\id_rsa
  └─ isInside(root, ...) → false  ❌ Reject
```

**The path is fully legal when the first check looks at the string. Only a real resolution on disk finds that it points outside the workspace.** This is why the second check must exist, and why it must access the disk.

The three variable names in the code have a division of work that matches this flow exactly:

| Variable | Meaning |
| --- | --- |
| `existing.lexical` | The parent path segment that exists in text form (`workspace\escape`) |
| `existing.physical` | Its real location after resolution (`C:\Users\you\.ssh`) |
| `resolved` | The final path after the runtime joins the remaining part to the real location |

The runtime resolves only the "existing parent path" and not the whole path. The reason is that `write_file` allows the model to create a file that does not exist yet. A part that does not exist has no real path to resolve, but its parent directory does.

This mechanism is not a complete sandbox. It protects only the four file tools. The `cwd` of `shell` is the workspace, but PowerShell can still use an absolute path, access the network, or start a child process.

---

## read_file: Limit the Context Size

`read_file` uses strict UTF-8 decoding. The runtime does not silently replace an invalid byte with `�`. It returns `invalid_utf8`.

Why not be more tolerant? Because once `�` enters the context, the model sees **a wrong file content**, and it does not know that the content is wrong at all. It can then run `edit_file` on the basis of this garbled text and damage the file. An explicit `invalid_utf8` return at least tells the model: "I cannot read this file. I must use another method."

```typescript
async readFile(
  workspace: string,
  relativePath: string,
  limit?: number,
): Promise<string> {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new RangeError("limit must be a positive integer");
  }
  const target = await safePath(workspace, relativePath);
  const text = decodeUtf8(await readFileBytes(target), relativePath);
  const lines = splitLines(text);
  if (limit !== undefined && limit < lines.length) {
    return [
      ...lines.slice(0, limit),
      `... (${lines.length - limit} more lines)`,
    ].join("\n");
  }
  return lines.join("\n");
}
```

Note the execution order in this function. It follows the same principle as `prepare`:

```text
① Validate limit          ← If the argument is invalid, do not go further
② safePath                ← If the path is unsafe, do not touch the disk
③ Read the bytes
④ Strict UTF-8 decoding   ← If decoding fails, fail explicitly
⑤ Split by lines, and truncate by limit
```

**Each step is "reject first, then proceed".** If any of the first four steps fails, nothing is read and nothing is written.

For example, a file has three lines and `limit` is 2. The result is:

```text
one
two
... (1 more lines)
```

A limit on the number of lines prevents one large file from filling the model context. When `limit` takes effect, the tail states explicitly how many lines remain. When the caller does not pass `limit`, the tool returns the complete file. The model does not need to guess whether the content is truncated.

The last line `... (1 more lines)` is not decoration. It is a signal to the model: **"the content is truncated here, and more content exists".** If the tool returned only the first two lines with no marker, the model would think the whole file has two lines. It would then draw a conclusion from incomplete information. In Chapter 8, on context compaction, "a truncation must leave a trace" becomes a general rule.

---

## write_file: The Byte Count Follows the Content on Disk

```typescript
async writeFile(
  workspace: string,
  relativePath: string,
  content: string,
): Promise<number> {
  const target = await safePath(workspace, relativePath);
  const bytes = Buffer.from(content, "utf8");
  await mkdir(dirname(target), { recursive: true });
  await writeFileBytes(target, bytes);
  return bytes.byteLength;
}
```

The tool creates parent directories automatically, and writes UTF-8 bytes directly. It returns `bytes.byteLength`, not the JavaScript string length.

For example, the `length` of `你好` is 2, but it takes 6 bytes in UTF-8 in reality. On success, the tool returns:

```text
Wrote 6 UTF-8 bytes to note.txt
```

The result then matches the data that the runtime really wrote to disk.

This difference is not a detail for its own sake. Look at these examples:

| Content | `content.length` (character count) | UTF-8 byte count | Difference |
| --- | ---: | ---: | --- |
| `alpha` | 5 | 5 | The same (pure ASCII) |
| `你好` | 2 | 6 | 3 times |
| `café` | 4 | 5 | A difference of 1 (`é` takes 2 bytes) |
| `🙂` | 2 | 4 | One emoji counts as 2 "characters" in JS |

**If the tool returned the character count, the model would get a number that has nothing to do with the disk.** It could not use this number to verify that a write is complete. It could not use it to judge the file size either. The return value of a tool must describe "what really happened in the world", not "the value of one variable inside the program".

The line `mkdir({ recursive: true })` also deserves a separate note: it lets `write_file` write `demo/sub/note.txt` in one call, even if `demo/sub` does not exist yet. Without this line, the model must first think "I need to create a directory". But it has no directory creation tool at all, so it can only fall back to `shell`. **One test for tool design: does the tool let the model avoid a fall back to `shell`?**

---

## edit_file: Change Only the First Exact Text

`edit_file` does not accept line numbers. A line number shifts as a whole after each earlier edit. The model can easily change the wrong position with an old line number.

A concrete example shows how easily this "shift" causes an accident. The model reads a file:

```text
1  import a
2  import b
3  
4  function run() {
```

It plans two edits: delete line 2, then change line 4. After the first edit runs, the file becomes:

```text
1  import a
2  
3  function run() {
```

**The original line 4 is now line 3.** If the model changes "line 4" as planned, it changes the next line. And it does not know at all that it changed the wrong line. The model is not at fault here. The coordinate system "line number" itself becomes invalid after an edit.

An exact match with `indexOf` does not have this problem: a text segment is a coordinate that carries its own position information. The number of lines deleted before it does not affect it.

The tool requires the model to provide the old text and the new text:

```typescript
const index = current.indexOf(oldText);
if (index === -1) {
  throw new TextNotFoundError(`Exact text not found in ${relativePath}`);
}
const updated =
  `${current.slice(0, index)}${newText}` +
  current.slice(index + oldText.length);
await writeFileBytes(target, Buffer.from(updated, "utf8"));
```

This design gives three explicit behaviors:

1. The old text must exist exactly;
2. The tool replaces only the first occurrence;
3. If the tool does not find the old text, it does not write the file back.

Point 3 is the principle "do not make a partial change": `writeFileBytes` sits after the `throw`, so on a match failure the file does not change by one byte. The model receives `text_not_found`, and the file is still in the state the model last read. A retry is therefore safe.

Point 2, "replace only the first occurrence", is a deliberate conservative choice. If `old_text` occurs 5 times in a file, the model probably does not realise this fact at all. A change to all 5 occurrences is very likely not its intent. "Change only the first occurrence + state this fact explicitly" is safer than "guess that it wants to change all of them". If the model really wants to change all of them, it can call the tool several more times.

The tool reads the whole original text and replaces only the matched segment. It writes every other character back unchanged. The CRLF in an unchanged part is therefore not changed to LF as a side effect. A test compares the bytes before and after an edit directly.

**This "write every other character back unchanged" behavior matters most on Windows.** Many tools normalise the line breaks in the whole file to LF as a side effect. Git then shows "the whole file changed", and the one real change drowns in a diff of several hundred lines. The implementation here touches only the matched segment. It does not touch any other byte.

The correct workflow for the model is this: read the file first, then call `edit_file` with an exact segment from the read result. If the file has changed, the tool fails. The model must read the file again. It must not overwrite the file blindly.

```text
✅ Correct: read_file → get the exact segment → edit_file
❌ Wrong:   build an old_text segment from memory or by guess → edit_file → text_not_found
```

The second approach fails at a high rate. The code in the memory of the model is often "roughly like this", and the indentation and spaces may not match. This is also why the `.describe()` text for `edit_file` states explicitly "read the file first, then provide the exact text". **A description is a behavior guide for the model. It is not a document for a human reader.**

---

## glob: See the Project First, Then Decide What to Read

The model usually does not know which files exist in the workspace. `glob` lets it search first, and then select a target to read:

```json
{"pattern":"chapters/ch02/src/**/*.ts"}
```

The return value uses `/` uniformly, and uses stable sorting:

```text
chapters/ch02/src/bootstrap.ts
chapters/ch02/src/core/loop.ts
chapters/ch02/src/core/messages.ts
```

If nothing matches, the tool returns `(no matches)`.

**The return of `(no matches)` instead of an empty string** is also a deliberate choice: the model cannot distinguish an empty string from "the tool is broken", but `(no matches)` states explicitly "the tool worked normally, and the answer is zero".

Three design points deserve attention:

| Design | Why |
| --- | --- |
| Use `/` as the separator uniformly | The model feeds these paths to `read_file` in the next step, so the format must be directly usable |
| Stable alphabetical sorting | The same project and the same pattern give the same result on two calls, so the reasoning of the model is reproducible |
| One path per line | No JSON wrapper is needed, and both the model and a human can read the result directly |

The glob pattern itself must also be a relative path, and it cannot contain `..`. The fixed prefix before the first wildcard passes through `safePath` first, so `escape/*.txt` cannot use an existing junction to jump out of the workspace. The traversal also does not enter a symbolic link directory recursively. Each match result also gets a real-path check again.

There are three lines of defence here, because glob is harder to protect than the other three tools:

```text
① The fixed prefix of the pattern passes safePath     escape in escape/*.txt is checked first
② The traversal does not enter a symbolic link directory       This prevents the traversal itself from leaving the workspace
③ Each match result gets a real-path check again       A fallback, in case the first two lines miss a case
```

Why three lines? Because `read_file` handles **one** definite path, while glob traverses **a whole** directory tree. The check points grow from 1 to hundreds or thousands. When the attack surface grows, the defence must grow thicker.

---

## handler: Map Expected Errors Only at the Tool Boundary

The Node adapter first translates operating system errors such as `ENOENT`, `EISDIR`, and `ENOTDIR` into `FileNotFoundError`, `InvalidFilePathError`, and `FileSystemOperationError` as defined in core. The feature layer does not read a Node error code. When you replace the file system adapter, the stable semantics in the tool layer therefore do not change.

The handler sits at the tool boundary. It converts these expected failures into stable error codes that the model can understand.

This is the complete dispatch logic for `edit_file`:

```typescript
handler: async ({ path, old_text, new_text }, context) => {
  try {
    await fileSystem.editFile(
      context.workspace,
      path,
      old_text,
      new_text,
    );
    return toolSuccess(`Edited ${path}`);
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return toolError("path_escape", error.message);
    }
    if (error instanceof TextNotFoundError) {
      return toolError("text_not_found", `Exact text not found in ${path}`);
    }
    if (error instanceof InvalidUtf8Error) {
      return toolError("invalid_utf8", `File is not valid UTF-8: ${path}`);
    }
    if (error instanceof FileNotFoundError) {
      return toolError("file_not_found", `File not found: ${path}`);
    }
    if (error instanceof InvalidFilePathError) {
      return toolError("invalid_path", `Path is a directory: ${path}`);
    }
    if (error instanceof FileSystemOperationError) {
      return toolError("filesystem_error", `Could not edit file: ${path}`);
    }
    throw error;
  }
}
```

This `catch` sits at the boundary between the process and the model. It can control the output to the outside. It publishes stable information only. It does not leak a local absolute path or an internal stack trace to the model.

The last line in the code, `throw error`, is the key point. It is easy to mistake it for an omission:

```typescript
    if (error instanceof FileSystemOperationError) {
      return toolError("filesystem_error", `Could not edit file: ${path}`);
    }
    throw error;   // ← An unknown error continues upward
  }
```

**This is not a missing case. It is deliberate.** This `catch` translates only **known failures that you expect to occur**. If an error appears that nobody expected (for example an internal bug in a dependency library), a conversion to `filesystem_error` disguises a real fault as a "normal file operation failure". The model then thinks a retry with a different path is enough, and the real bug is hidden permanently.

Compare the consequences of the two styles:

| Style | Known failure | Unknown bug |
| --- | --- | --- |
| End with `throw error` (the approach in this chapter) | Converts to a stable error code, and the model can recover | Throws to the upper layer, and exposes the fault explicitly |
| End with `return toolError("unknown", ...)` | Same as above | **Swallowed**, and disguised as a normal failure |

You can generalise this principle: **`catch` handles only errors whose names you can list.** If you cannot list the name, you do not understand the error. You then have no basis to decide how to handle it.

The four tools use these main error codes:

| error_code         | Meaning                | What the model must do after it sees the code |
| ------------------ | ----------------- | --- |
| `path_escape`      | The path violates the workspace boundary | Change to a relative path inside the workspace. Do not retry the same path |
| `file_not_found`   | The target file does not exist           | Use `glob` first to find the real path, or use `write_file` to create the file |
| `text_not_found`   | The exact old text does not exist          | Run `read_file` again, and edit with the original text from the read result |
| `invalid_path`     | The file and directory types do not match the operation requirement    | The target is a directory. Change to a concrete file |
| `invalid_utf8`     | The file is not valid UTF-8      | This file is a binary file. Do not try a text read again |
| `filesystem_error` | Another controlled file system failure        | Change the path or change the plan. Do not retry the call unchanged |

**The third column is the real value of an error code.** A good error code does not only "tell the model that the call failed". It lets the model derive the next step. Compare the two designs: if every failure returned the same sentence "the operation failed", the model could only retry the same call blindly and burn several turns of tokens. With six stable error codes, the model has a clear next step in each case.

This also explains why an error code must be **stable**: the model (and the tests you write) depends on these strings for a decision. A casual change from `text_not_found` to `not_found` is a breaking change, even if it is only a string.

---

## P01 and P02 Differ Only in the Build-Time Tool Set

The four tools are complete at this point. But one question has no answer yet: **what exactly is the code difference between the Chapter 1 agent and the Chapter 2 agent?**

The answer is surprisingly small: they differ by one tool set.

`code/chapters/ch02/src/core/profiles.ts` defines the fixed capability snapshots:

```typescript
export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

export const P02: ChapterProfile = Object.freeze({
  chapter: 2,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
  ]),
});
```

The bootstrap selects the registry by the fixed profile:

```typescript
const tools =
  profile.chapter === 1
    ? createChapterOneTools(commandRunner)
    : createChapterTwoTools(
        commandRunner,
        dependencies.fileSystem === undefined
          ? new NodeWorkspaceFileSystem()
          : dependencies.fileSystem,
      );
```

The tool construction for P02 is also direct:

```typescript
export function createChapterTwoTools(
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
): ToolRegistry {
  // Chapter capability accumulation: retain P01 Shell, then register file read, write, and enumeration tools.
  const registry = createChapterOneTools(commandRunner);
  registry.register(createReadFileTool(fileSystem));
  registry.register(createWriteFileTool(fileSystem));
  registry.register(createEditFileTool(fileSystem));
  registry.register(createGlobTool(fileSystem));
  return registry;
}
```

Read this as "reuse first, then append": the first line of `createChapterTwoTools` calls `createChapterOneTools`, so P02 always contains the full behavior of P01. This is not a habit. It is a structural guarantee. To remove `shell`, you must change code. You cannot lose it by an oversight.

The real difference between the two profiles:

| | P01 | P02 |
| --- | --- | --- |
| capabilities | `loop`, `powershell` | Plus `tool_registry`, `files` |
| Tools the model sees | `shell` | `shell`, `read_file`, `write_file`, `edit_file`, `glob` |
| Agent Loop code | The same copy | **The same copy** |
| Message history handling | The same copy | **The same copy** |
| Composition root change | — | One more branch that selects the registry |

One point deserves attention: **a capability is fixed at build time. It is not a switch that the runtime can change.** The composition root selects the registry by `profile.chapter`. After that, the tool set does not change during this run. The `tools` array that the runtime sends to the model on each turn is therefore stable (back to the static prefix at the start of this chapter). A test can also assert a deterministic fact such as "P01 exposes only `shell`".

A dynamic addition and removal of tools at run time is a problem that Chapter 19, on MCP, must solve. The complexity it introduces (Registry Snapshot, name isolation, effect only in the next turn) is not needed at all in this chapter.

The Agent Loop still generates the tools schema from the same registry snapshot on each turn. The model call, the message history, the maximum turns, and the result pairing need no copy and no change.

---

## Multiple Tool Calls in One Turn Must Still Pair

The tool count grows from 1 to 5. This growth brings a case that Chapter 1 rarely meets: **the model can request several tools in one turn at the same time.**

The model can request multiple tools in one assistant message:

```typescript
const assistant = assistantMessage(null, [
  toolCall(
    "write-1",
    "write_file",
    '{"path":"note.txt","content":"value"}',
  ),
  toolCall("read-1", "read_file", '{"path":"note.txt"}'),
]);
```

The current implementation executes the calls in order. The result history for the example above must be:

```text
assistant(tool_calls: write-1, read-1)
tool(tool_call_id: write-1, write result)
tool(tool_call_id: read-1, read result)
```

The runtime cannot omit the result of a failed call. It also cannot insert a new user or assistant message between two tool results. Even if the arguments are invalid, the runtime must generate an error result that pairs with the original ID.

### What Happens When Pairing Breaks

This rule is not a "best effort" rule. **A violation breaks the run at once.** Three typical wrong forms:

```text
❌ One result is missing (validation for write-1 fails, so the code skips it and returns nothing)
   assistant(tool_calls: write-1, read-1)
   tool(read-1, ...)
   → validateToolPairing throws: missing tool results for ids: [write-1]

❌ Another message sits in the middle
   assistant(tool_calls: write-1, read-1)
   tool(write-1, ...)
   user("Wait, change it to something else")      ← inserted in the middle of the pairing
   tool(read-1, ...)
   → The structure is broken, and the OpenAI side also rejects this history

❌ A result that nobody requested is returned
   assistant(tool_calls: write-1)
   tool(write-1, ...)
   tool(read-1, ...)             ← The model never requested read-1
   → The runtime throws: unexpected tool result id: read-1
```

So "the tool execution failed" and "no result is returned" are two completely different things. The first case is normal. The second case is a bug. This is also why Chapter 1 designs `ToolResult` as **data, not an exception**. A `throw` inside a handler breaks the loop and loses the pairing. A `toolError(...)` return reports the failure and keeps the structure complete at the same time.

### Why Serial and Not Concurrent

Serial execution is a deliberate choice. A read and a write of the same file have an order dependency. Without a concurrency safety contract, the runtime must not run calls concurrently for speed on its own decision.

Take a concrete example: the model requests `write_file("note.txt", "alpha")` and `read_file("note.txt")` in one turn at the same time.

| Execution method | Result |
| --- | --- |
| Serial (this chapter) | The runtime writes first and reads later, and reads `alpha`. Deterministic |
| Concurrent | The runtime can read `alpha`. It can also read the old content, or read a half-written file. **Non-deterministic** |

Concurrency is not impossible. But before you do it, you must answer "which tools can run concurrently" and "how the runtime detects a conflict". Chapter 13 introduces background tasks and handles this question directly. Only then does the matching contract exist. A small speed gain now is not worth a non-reproducible bug.

---

## The Permission Boundary in Chapter 2

This chapter has one **deliberate asymmetry**. If you have read this far, you should see it clearly:

```text
shell "Remove-Item note.txt"    → An approval prompt appears. The call does not run until you enter y
write_file "note.txt" "..."     → It runs directly. You see nothing
```

Both calls can change a file, but only one needs approval. Why? Because Chapter 2 has no permission system yet. It has only one hard-coded rule, "`shell` needs approval". The `effect: "write"` label is already attached, but **no code reads it**.

P02 does not yet have the complete policy system from Chapter 3. This chapter keeps this fixed behavior:

- `shell` has effect `execute`. The real CLI requires an explicit `y` or `yes` input before each call;
- The four file tools run directly under the `safePath` boundary;
- No interactive input, a default Enter key press, or an approval exception all reject `shell`;
- `cwd` is not a sandbox. You cannot extend the path guarantee of the file tools to PowerShell.

The last point is the easiest to misunderstand, so here is a separate, clear statement:

| | Protected by `safePath`? | Note |
| --- | --- | --- |
| `read_file` / `write_file` / `edit_file` / `glob` | Yes | The path must land inside the workspace |
| `shell` | **No** | A `C:\Windows\...` path in PowerShell is fully possible. `cwd` is only the start directory |

The security model in this chapter is therefore **two sets that coexist**: the file tools rely on a code boundary, and `shell` relies on human approval. **Do not apply the guarantee of the first set to the second set.** This is also why Chapter 3 builds a unified permission system. Two coexisting rule sets will leak sooner or later.

Chapter 3 adds structured permission rules. Write tools then also enter the approval and audit flow. The chapter also guarantees that a strong deny cannot be overridden by a weak allow.

---

## Run Chapter 2

The prerequisites are exactly the same as in Chapter 1: you have already run `npm ci` in `code/`, and you have filled in all three variables in `.env`. If you have not done this, go back to "Run the Chapter 1 Agent" in Chapter 1 and do it once.

### Step 1: Run the Offline Tests First

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch02
```

Expected last two lines:

```text
 Test Files  8 passed (8)
      Tests  47 passed (47)
```

This is 2 more files and 17 more tests than Chapter 1. The additions are exactly the file tools and the path boundary. The tests also need no API Key, and they send no network request.

### Step 2: Run One Complete Four-Tool Path

```powershell
npm run ch02 -- --prompt 'Use file tools only: write demo/note.txt with content alpha; change the first alpha to gamma; read the file and use glob to list demo/*.txt'
```

**This command really creates `code/demo/note.txt`.** After the run, you can confirm the result yourself:

```powershell
Get-Content .\demo\note.txt
```

The expected output is `gamma`. In the whole process, the model calls a tool four times. This matches the table in "One Complete Example" in this chapter.

The sentence "Use file tools only" in the prompt is deliberate: without it, the model can build one PowerShell command directly. That path goes back to Chapter 1, and it also triggers the per-call approval for `shell`.

### Step 3: Change to a Read-Only Task

```powershell
npm run agent-tutorial -- run --chapter 2 --prompt 'Read package.json, and list chapters/ch02/src/**/*.ts'
```

This command uses only `read_file` and `glob`. It produces no file change, so it is suitable for repeated runs and observation.

The current PowerShell directory is both the `.env` lookup location and the Agent workspace. **In other words, the directory where you enter the command is where the workspace boundary of the Agent is.** If you run the command in `code/`, `safePath` protects `code/`.

### Step 4 (Optional): Run the Complete Offline Verification

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

These tests need no API Key, and they do not access the network. A real OpenAI run is extra verification only. It does not replace the offline contract tests.

### Troubleshooting Common Errors

The table from Chapter 1 still applies (errors for configuration, arguments, and approval). The table below shows the new cases in this chapter, all of them related to the file tools:

| Symptom | Cause | How to handle it |
| --- | --- | --- |
| `Error [path_escape]: ...` appears in a tool result | The path from the model contains `..`, an absolute path, or a Windows reserved name | Normal behavior. Check whether the prompt makes the model think it must access a file outside the workspace |
| `Error [text_not_found]: ...` | The model built `old_text` by guess | Normal behavior. In the next turn, the model must run `read_file` first. Repeated failures mean the text description in the prompt is not precise enough |
| `Error [invalid_utf8]: ...` | The model read a binary file (an image, an `.exe`, a lock file, and so on) | Normal behavior. Use `glob` to limit the search to a text suffix such as `**/*.ts` |
| `Error [file_not_found]: ...` | The path is wrong, or the file really does not exist | Let the model run `glob` first to confirm the path |
| The model still calls `shell` and does not use the file tools | The prompt does not state the limit explicitly | Write "Use file tools only" in the prompt |
| A written file shows garbled text | This is not a problem in the code of this chapter | `write_file` fixes the encoding to UTF-8. Check which program you open the file with. An old Notepad version can decode the file as ANSI |
| `demo/note.txt` appears in an unexpected location | You did not run the command in the `code/` directory | Run `Set-Location` to go to `code/`, then run the command again |

---

## Verification and Experiments

`npm run test:ch02` runs 8 test files and 47 tests. Their division of work is:

| Test file | Verified content |
| --- | --- |
| `ch02-files.test.ts` | The success paths of the four file tools, each error code, and multi-tool pairing in one turn |
| `filesystem.test.ts` | The two checks in `safePath`, Windows reserved names, a junction escape, and the glob boundary |
| `ch01-loop.test.ts` | The loop behavior from Chapter 1 still holds under P02 |
| `shell-tool.test.ts` | The `shell` timeout, truncation, and non-zero exit code behavior do not change |
| `messages.test.ts` | Strict `tool_call_id` pairing |
| `profiles.test.ts` | P01 exposes only `shell`; P02 exposes five tools in a fixed order |
| `config.test.ts` | `.env` validation and baseUrl normalisation |
| `openai-chat.test.ts` | SDK response narrowing and refusal handling |

The presence of `ch01-loop.test.ts` and `shell-tool.test.ts` here is not copy-and-paste padding. They verify the **accumulation principle**: Chapter 2 adds four tools, and the behavior from Chapter 1 must not change by one character. Every chapter in this tutorial keeps the tests from earlier chapters. A "careless break of old behavior" is then exposed at once.

### Three Suggested Hands-On Experiments

**Experiment 1: Pass an extra field to `read_file`**

In a test, let the scripted model return `arguments: '{"path":"note.txt","encoding":"gbk"}'`.

Expected result: the call fails in the `prepare()` stage and returns a schema error result. **`readFile` is not called once.**
What you learn: the combined effect of `strictObject` and validation before execution. You can add a counter in the substitute file system to confirm that the runtime really did not call it.

**Experiment 2: Run `edit_file` twice in a row with the same `old_text`**

The first call replaces the text successfully. What happens on the second call?

Expected result: the second call returns `text_not_found` (the first occurrence is already changed), and the file content does not change.
What you learn: the real consequence of the two behaviors "replace only the first occurrence" and "do not write back on failure".

**Experiment 3: Create an escaping junction in the workspace by hand**

```powershell
# This needs administrator rights. Remember to delete it after the experiment
New-Item -ItemType Junction -Path .\escape -Target C:\Windows\Temp
npm run ch02 -- --prompt 'Read any one file in the escape directory'
```

Expected result: the run returns `path_escape`, and the model cannot read the file.
What you learn: the real effect of the second check in `safePath`. The first check passes the path fully when it looks at the string. The disk resolution blocks it.

```powershell
# Clean up
Remove-Item .\escape
```

---

## Chapter Summary

### The Three-Sentence Version

1. The correct way to add a tool is "define + register". The Agent Loop does not change by one line.
2. One Zod schema serves the model as reading material and the runtime as a validation rule at the same time. This design removes "the document and the implementation disagree" at the root.
3. The security of the file tools comes from the two checks in `safePath`: the lexical check blocks an obvious escape, and the disk resolution blocks a symbolic link.

### Six Points to Remember

| # | Conclusion | Section |
| ---: | --- | --- |
| 1 | All validation sits in `prepare()`, and all side effects sit in `invoke()`. The order cannot reverse | ToolRegistry |
| 2 | Input outside the contract fails explicitly. The runtime does no implicit conversion and does not ignore an extra field | Define Strict Input with Zod |
| 3 | The runtime rejects `..`, an absolute path, and a Windows reserved name in every case. It does not try to repair them | safePath |
| 4 | A string check alone cannot block a junction. The runtime must resolve the real path on disk | Why the Second Check Must Exist |
| 5 | `edit_file` uses exact text, not a line number, because a line number becomes invalid after one edit | edit_file |
| 6 | `catch` translates only errors whose names you can list. It throws every other error onward | handler Error Mapping |

### Code Boundaries in This Chapter (What Is Explicitly Not Done Yet)

| Already present | Not yet present | Chapter that adds it |
| --- | --- | --- |
| Five tools (including four file tools) | Structured permission rules, audit log | Chapter 3 |
| Per-call human approval for `shell` | Write tools also enter the approval flow | Chapter 3 |
| The `safePath` boundary for the file tools | A path boundary for `shell` (**still absent**) | Outside the scope of this tutorial; `shell` always depends on approval |
| `effect` metadata | `effect` takes part in a permission decision | Chapter 3 |
| Multi-tool **serial** execution in one turn | Concurrent execution and a concurrency safety contract | Chapter 13 (background tasks) |
| Full read + `limit` truncation | Product persistence, context compaction | Chapter 8 |
| Five tools fixed at start-up | Dynamic addition and removal of tools at run time | Chapter 19 |

### Check Whether You Really Understood

1. The model sends `{"path":"note.txt","limit":"10"}`. What happens? Why does the runtime not convert the value to a number automatically? (The Zod section)
2. After simplification, `nested/../secret.txt` is inside the workspace. Why does the runtime still reject it? (safePath)
3. The workspace contains a junction that points outside. What conclusion does the first check give, and what conclusion does the second check give? (Why the Second Check Must Exist)
4. `write_file` writes `你好`. Is the returned number 2 or 6? Why? (write_file)
5. The `old_text` for `edit_file` occurs 3 times in a file. How many occurrences does the tool change? (edit_file)
6. Why does the `catch` in the handler end with `throw error` and not with a fallback error code return? (Error Mapping)

---

The real addition in this chapter is not four isolated functions. It is one stable extension path:

```text
Zod schema
   ↓
ToolDefinition (name + description + effect + handler)
   ↓
ToolRegistry (schema snapshot + argument preparation + dispatch)
   ↓
Agent Loop (unchanged)
```

When you add a tool in the future, define the explicit input and the side effect first. Then implement the handler. Then register the definition once. The loop does not need to know the tool detail. The schema that the model sees and the handler that the runtime executes also do not split apart.

The next chapter solves the gap that this chapter leaves on purpose: `effect` is only a label now, and `write_file` can change a file with no approval at all. Chapter 3 turns it into a real permission system: rule merging, deny takes priority, and a complete audit.
