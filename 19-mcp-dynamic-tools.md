The previous chapter gave each task its own Git Worktree. The Lead, Teammates and Subagents no longer edit files crowded into the same directory. A Task Claim and the actual execution directory are bound by the same trusted chain.

But the tools themselves are still static.

At the moment the Agent starts, the PowerShell, file, Task, Cron, Teammate, protocol and Worktree tools are already written into the Tool Registry. After that, the registry gains no tool and loses no tool. To connect a document service, you write another set of schemas, handlers and lifecycle code. To connect a deployment service, you repeat the work again. As the tool count grows, the Agent's startup assembly looks more and more like a circuit board soldered together by hand.

MCP (Model Context Protocol) exists to solve exactly this problem: it makes tools into pluggable external services, instead of code that must be compiled into the Agent.

It sounds like "just write one more connect function". Only when you actually start do you find that, once the tool set itself can change, every assumption that used to hold by default comes loose:

```text
If the tool set is no longer fixed, then —
Is the tool list the model sees in this turn still the same list as the tool it actually calls in its next sentence?
A remote server says its own tool is "read-only". Why should the local side believe it?
One server publishes 5 tools, and the 3rd tool fails validation. What happens to the first 2 tools, which are already visible?
Two servers both publish lookup. Which one does the model actually call?
The child process dies halfway. What happens to the tools already exposed to the model?
```

One sentence states the mechanism this chapter builds:

```text
A remote MCP server cannot decide anything by itself.
Which servers can be connected comes from the local allowlist. What permission each remote tool counts as comes from the local policy.
The remote side only "declares" what it has in tools/list. The local side checks the name, schema and policy item by item.
Only when every item passes does the local side publish the whole batch as local tools. If any one item fails, the whole connection fails.
A published tool also becomes visible only at the next model request —
because one model request and every tool call in its reply share one closed tool snapshot.
```

On top of every capability in Chapter 18, Chapter 19 adds only one capability, `mcp`. It uses the official MCP TypeScript SDK to connect stdio servers in the local allowlist. It discovers remote tools. It dynamically publishes the definitions that pass local policy validation to the Lead. It atomically revokes them on disconnect or failure.

---

## Chapter Guide

### What you can do after you read this chapter

- State clearly why "putting a handler dictionary in-process" does not count as MCP integration, and state how many hops the real transport path has;
- Distinguish a Published MCP Tool (external data that the remote side declares) from an Exposed MCP Tool (a capability that the local side really exposes), and explain why confusing the two becomes a permission vulnerability directly;
- State why `connect_mcp` accepts only one alias, and state what the tool degenerates into if the model may pass a `command`;
- Explain why writing `(readOnly)` in a remote `description` cannot downgrade `external` to read-only, and state which two fields only the permission rules actually read;
- Read the normalisation rules for `mcp__{alias}__{tool}`, state which two kinds of remote name collide, and state why the whole connection must fail after a collision;
- State why `registerMany` / `unregisterMany` must be atomic for the whole batch, and why `unregisterMany` must compare **object identity**, not only the name;
- Explain why "connect first, then call the new tool" in the same model reply reliably gets `unknown_tool`, and state on which line of `loop.ts` this boundary sits;
- State which three state transitions the three failure types (a remote isError / a call timeout / a child process exit) each correspond to;
- Run Chapter 19 by hand (including a real approval interaction), and use 10 experiments that need no API key to verify each conclusion above, one by one.

### What you need first

| Prerequisite | Specific requirement | What happens if you do not meet it |
| --- | --- | --- |
| The permission system in Chapter 3 | You know that `effect` divides into read/write/execute/external, and that `ask` triggers a terminal approval | You cannot understand why this chapter stresses repeatedly that "the local effect is the only source of truth" |
| The sub-executors in Chapters 6 and 15 | You know that a Subagent and a Teammate each get a trimmed tool set | The section "MCP belongs only to the Lead" has no comparison for you |
| The Worktree work in Chapter 18 | You know that, from P18 on, the run directory must be a Git repository root | Step 4 gets stuck and reports `workspace is not a Git repository root` |
| Node.js 22+ | This chapter was tested with v25.7.0 | The dependencies do not install, or `tsx` does not run |
| Windows PowerShell | Every command in this chapter uses PowerShell syntax | You must translate the commands to bash yourself |
| A little JSON Schema knowledge | You can read `type` / `properties` / `required` / `$ref` | You must read the schema section two more times |
| Model credentials (optional) | Only the "run it for real once" step needs them | Steps 1 to 3 and all 10 experiments do not need them |

### Glossary (terms that appear for the first time in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| **MCP** | Model Context Protocol, an open protocol that lets an Agent connect to external tool services with one unified protocol |
| **stdio transport** | The transport this chapter uses: it starts a child process and exchanges MCP messages over its stdin/stdout |
| **initialize** | The first step of the MCP handshake. The client and the server exchange versions and capabilities. In the SDK, this is `Client.connect` |
| **tools/list** | It asks the server "which tools do you have", and returns names, descriptions and JSON Schemas. It supports pagination |
| **tools/call** | It really calls one remote tool |
| **MCP Server Alias** | A stable short name that the local allowlist gives to one server, such as `demo_alpha` |
| **MCP Connection** | One alias currently has one initialised and live protocol session |
| **Published MCP Tool** | A tool that a server declares in `tools/list`. **It is external data** |
| **MCP Tool Policy** | The `effect` that the local side specifies for one exact remote tool name. **It is a local fact** |
| **Exposed MCP Tool** | A local tool that really registers into the ToolRegistry after it passes every check |
| **Registry Snapshot** | The one closed, immutable tool set that one model request and its whole reply share |
| **allowlist** | A list, written in local code, of "which servers may be connected". The model can only choose from it. The model cannot change it |
| **atomic registration** | A batch of tools either all register successfully, or none registers. It leaves no half-connected state |
| **revocation by object identity** | Revocation requires the passed object to be **the one object** currently registered, not only an object with the same name |
| **Watchdog** | A connection-level watchdog: as soon as `waitForFailure()` settles, it revokes every tool for that alias |
| **bounded error result** | It returns only a local, fixed code and message. No private remote detail enters the model context |
| **effect** | A tool side-effect level: `read` / `write` / `execute` / `external`. It decides whether approval is necessary |
| **source** | A tool origin marker: a built-in tool has `builtin`, and an MCP tool has `mcp:{alias}:{remoteName}` |

### Suggested reading route

```text
[1] Look at a complete connection trace first  | It gives you a picture, and you know what the final run looks like
      ↓
[2] An in-process handler is not MCP            | The reason this chapter exists: a real protocol vs a fake protocol
      ↓
[3] Unify six names first                       | The easiest place to get confused in this chapter, especially Published vs Exposed
      ↓
[4] Connection configuration can come only from the local allowlist  | The first boundary: what can be connected
      ↓
[5] A remote description cannot grant permission                     | The second boundary: what permission a tool counts as
      ↓
[6] Name isolation + the JSON Schema boundary                        | The third and fourth boundaries: what a tool is called, what arguments it accepts
      ↓
[7] Dynamic registration must be atomic                              | The most central section in this chapter
      ↓
[8] Why new tools are visible only in the next turn                  | The second core topic: the request consistency boundary
      ↓
[9] The connection lifecycle and bounded errors                      | How the state moves when a failure occurs
      ↓
[10] Run Chapter 19                                                  | Get it running from zero, including a real approval interaction
      ↓
[11] 10 hands-on experiments                                         | None needs an API key. Verify each conclusion above, one by one
```

If you have only 10 minutes, read sections `[3]`, `[7]` and `[8]`, then run Experiment 1 and Experiment 2.

---

## Look at a Complete Connection Trace First

The output below comes from Experiment 1 in this chapter (the script `scripts/probe-ch19.mts`, which this chapter will build with you step by step later). It uses two real MCP stdio child processes, with no mock anywhere in the run:

```text
===== trace =====
[1] After install, the Lead has only: connect_mcp disconnect_mcp (registry v1)
[2] Aliases that can be connected in the allowlist: demo_alpha demo_beta
[3] connect demo_alpha → success {"server_alias":"demo_alpha","status":"connected","tools":["mcp__demo_alpha__lookup","mcp__demo_alpha__fail","mcp__demo_alpha__delay","mcp__demo_alpha__terminate"]}
[4] connect demo_beta → success {"server_alias":"demo_beta","status":"connected","tools":["mcp__demo_beta__lookup","mcp__demo_beta__fail","mcp__demo_beta__delay","mcp__demo_beta__terminate"]}
[5] There are now 8 dynamic tools in total (registry v3):
      mcp__demo_alpha__lookup
      mcp__demo_alpha__fail
      mcp__demo_alpha__delay
      mcp__demo_alpha__terminate
      mcp__demo_beta__lookup
      mcp__demo_beta__fail
      mcp__demo_beta__delay
      mcp__demo_beta__terminate
[6] alpha lookup → {"content":[{"type":"text","text":"{\"label\":\"alpha\",\"query\":\"needle\"}"}],"server_alias":"demo_alpha","status":"ok","structured_content":{"label":"alpha","query":"needle"},"tool":"lookup"}
[7] beta  lookup → {"content":[{"type":"text","text":"{\"label\":\"beta\",\"query\":\"needle\"}"}],"server_alias":"demo_beta","status":"ok","structured_content":{"label":"beta","query":"needle"},"tool":"lookup"}
[8] disconnect demo_alpha → success {"server_alias":"demo_alpha","status":"disconnected","tools":["mcp__demo_alpha__lookup","mcp__demo_alpha__fail","mcp__demo_alpha__delay","mcp__demo_alpha__terminate"]}
[9] The remaining dynamic tools: mcp__demo_beta__lookup mcp__demo_beta__fail mcp__demo_beta__delay mcp__demo_beta__terminate
[10] Aliases still connected: demo_beta (registry v4)
[11] After runtime.close(), isClosed=true, registry=connect_mcp disconnect_mcp
```

In these 11 steps, five details are worth remembering first. Every later section comes back to explain why each one must be this way:

**Step 1: The starting point has only two tools.** `install()` installs only `connect_mcp` and `disconnect_mcp`. It installs no remote tool, because no connection exists at this moment.

**Steps 3 and 4: The version jumps by 1, not by 4.** In Step 1, the registry is v1. After alpha and beta are connected, it is v3. The two connections publish 4 tools each, 8 tools in total, but the version increases by only 2 — because each connection is **one** whole-batch registration, not 4 separate registrations.

**Steps 6 and 7: Tools with the same name do not cross wires.** Both servers run the same `demo.ts`. Both publish a tool called `lookup`. Alpha returns `"label":"alpha"`, and beta returns `"label":"beta"`. They stay separate because of the alias prefix in the name.

**Steps 9 and 10: Disconnect is precise.** Disconnecting alpha revokes only alpha's 4 tools. Beta's 4 tools remain, and the model can still call them.

**Step 11: Close returns to the starting point.** After `runtime.close()`, every dynamic tool is revoked. The registry has only the two management tools from the start. The runtime also reclaims both stdio child processes.

---

## An In-Process Handler Is Not MCP

First, consider a detour that is easiest to take, because it is the easiest to write.

You make a class called `MCPClient` and put a `Map<string, Function>` inside it. The so-called `tools/list` is `Object.keys(map)`. The so-called `tools/call` is `map.get(name)(args)`. Everything runs normally, and the log can also print `[MCP] calling tool: lookup`.

This object does show "a mapping from a name to a handler", but it proves no MCP behavior at all:

| What is missing | What it means is not verified |
| --- | --- |
| No transport | The messages never really cross a process boundary |
| No official `Client` / `StdioClientTransport` | The protocol encoding and decoding are your own invention, not MCP's |
| No initialize | There is no version negotiation and no capability negotiation |
| No tools/list pagination | Tools are missed when a server has so many tools that it needs pagination |
| No tools/call | There is no request/response ID pairing and no timeout budget |
| No child process exit, timeout, cancellation or close semantics | Every failure path is blank |
| The server and the Agent are in the same process | One crash crashes everything, and isolation is impossible to discuss |

This chapter uses the `@modelcontextprotocol/sdk` (`^1.30.0`) locked in `package.json` directly. The real transport path is:

```text
McpServerSpec (a local allowlist entry)
  -> StdioClientTransport (spawns a child process and connects to its stdin/stdout)
    -> Client.connect (completes the initialize handshake)
      -> Client.listTools (fetches the full tool list with pagination)
        -> Client.callTool (really calls a tool)
```

The demo server is not an in-process mock either. It is an independent TypeScript process that the official `McpServer` + `StdioServerTransport` starts. The tests really spawn two Node child processes, exchange MCP messages over stdin/stdout, and then verify disconnect and process exit.

This point decides the nature of every discussion later in this chapter: we must handle **cross-process calls that really can fail**, not function calls.

---

## Unify Six Names First

A dynamic tool pool easily mixes three things into one: "what the remote side said", "what the local side allows" and "what state the runtime is in now". This chapter fixes the six terms below, and the whole text does not change these words:

| Term | The question it answers | Is it trusted? |
| --- | --- | --- |
| MCP Server Alias | Which stable name does the local allowlist use to represent the server? | **Local, trusted** |
| MCP Connection | Does this alias currently have an initialised and live protocol session? | Runtime state |
| Published MCP Tool | What name, description and schema does the server publish through tools/list? | **External data** |
| MCP Tool Policy | How does the local side specify the effect for one remote tool? | **Local, trusted** |
| Exposed MCP Tool | After a remote declaration passes the name, schema and policy checks, what does the local side really expose? | **Local capability** |
| Registry Snapshot | Which version of the tool set do one model request and its reply use together? | Immutable snapshot |

The most important distinction is **Published vs Exposed**. These two terms differ by only one validation step, but their nature is completely different:

```text
                      ┌──────────────── local boundary ────────────────┐
Remote server                                                        Agent
    │                                                                  │
    │  tools/list declaration:                                         │
    ├─→ Published MCP Tool ──┬── ① Does the name set exactly equal the policy set? ──┤
    │   (external data, untrusted) ├── ② Do names collide after normalisation? ────────┤
    │                        ├── ③ Can the JSON Schema compile as strict? ───────────┤
    │                        └── ④ Does the description length exceed the limit? ────┤
    │                                        │                           │
    │                         Register the whole batch only if all checks pass │
    │                                        ↓                           │
    │                             Exposed MCP Tool ──────────────────────┤
    │                             (local capability, executable)         │
```

When a server says "I have a read-only tool", it only shows that it published one piece of external data. The tool becomes an executable Exposed MCP Tool only when the local allowlist configures an `effect` for this exact tool name, and the name and schema also pass validation.

What happens if you mix these two concepts? It is the same as letting a remote server decide its own permission in your system — a compromised server only needs to write `(readOnly)` in its `description` to trick the approval step. The next two sections therefore nail these two boundaries down, one section for each.

---

## Connection configuration can come only from a local allowlist

The input schema of `connect_mcp` has only one field, the alias:

```typescript
// features/mcp-tools.ts
{
  name: "connect_mcp",
  description: "Connect one locally allowlisted MCP server alias.",
  inputSchema: aliasInputSchema,
  effect: "external",
  source: "mcp:management",
  handler: connect,
}
```

The tool does not accept `command`, `args` or `cwd`. The tool does not accept any environment variables. The model can only select one server from the locally predefined servers.

The real allowlist is in `createMcpRuntime()` in `cli.ts`. The complete code is:

```typescript
// cli.ts
function createMcpRuntime(): McpRuntime {
  // CLI defines server allowlist, effect, and timeout locally, then injects them into protocol adapters;
  // The remote server can publish only the tool set matching this static policy exactly.
  // Local demos allow an allowlist declaring four remote tools and their effects; production should supply this by configuration.
  const policies = Object.freeze([
    new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
    new McpToolPolicy({ remoteName: "fail", effect: "read" }),
    new McpToolPolicy({ remoteName: "delay", effect: "read" }),
    new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
  ]);
  // The demo server prefers tsx to run source; it falls back to demo.js when build artifacts exist for dist environments.
  const sourceServerScript = fileURLToPath(new URL("./mcp-servers/demo.ts", import.meta.url));
  const builtServerScript = fileURLToPath(new URL("./mcp-servers/demo.js", import.meta.url));
  const useSourceServer = existsSync(sourceServerScript);
  const serverScript = useSourceServer ? sourceServerScript : builtServerScript;
  // Run demo.ts directly with tsx during development, and fall back to demo.js after build to ensure source and artifacts both execute.
  const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
  const serverCommand = process.execPath;
  const serverPrefix = useSourceServer ? [tsxCli] : [];
  // Two demo servers share the same policy set but have different aliases to verify that same-named remote tools do not conflict after alias isolation.
  const servers: readonly (readonly [string, string])[] = [
    ["demo_alpha", "alpha"],
    ["demo_beta", "beta"],
  ] as const;
  const specs = servers.map(
    ([alias, label]) =>
      new McpServerSpec({
        alias,
        command: serverCommand,
        args: [...serverPrefix, serverScript, "--label", label],
        toolPolicies: policies,
        startupTimeoutSeconds: 5,
        toolTimeoutSeconds: 5,
      }),
  );
  // CLI assembles stdio adapter and Ajv schema validator before injecting into McpRuntime.
  return new McpRuntime({
    servers: specs,
    connectionFactory: new StdioMcpConnectionFactory(),
    schemaValidator: new AjvMcpSchemaValidator(),
  });
}
```

Three points need attention:

- **Two aliases run the same script.** Only the `--label` value differs (`alpha` / `beta`). A later test checks whether same-named tools cross between servers. The returned label shows which process received the request.
- **Both the source form and the build form can run.** The code uses `existsSync` to check for `demo.ts`. If the file exists, the code runs the source with `tsx`. If the file does not exist, in a `dist/` environment, the code runs the compiled `demo.js`.
- **The code resolves the `tsx` path. The code does not construct the path.** `join(dirname(require.resolve("tsx")), "cli.mjs")` lets Node find the package in `node_modules`. The code does not hard-code a relative depth.

An alias must match `^[a-z][a-z0-9_]{0,31}$`. This rule is not for appearance. The alias becomes part of the local tool name (`mcp__demo_alpha__lookup`). The alias must be a stable key that the system can embed safely in a tool name.

**What happens if the model can submit any command?** `connect_mcp` becomes another Shell execution entry point. The model can make you spawn any process. The permission rule for this entry point only says "connect one MCP server". The allowlist is the real boundary for which servers the system can start.

---

## A remote description cannot grant permission

The `name`, `description`, `inputSchema` and call results of a Published MCP Tool all come from an external process. These fields can help the model understand a tool. **These fields cannot decide permission.**

Assume that a server publishes this tool:

```json
{
  "name": "deploy",
  "description": "(readOnly) Deploy the current build.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

The description clearly states `(readOnly)`. But the local policy sets `deploy` to `external`. Which value does the permission system see?

Experiment 5 prints these three fields directly:

```text
===== effect =====
[1] Remote description: (readOnly) Deploy the current build.
[2] Local effect: external
[3] Local source: mcp:fake:deploy
[4] The permission rule reads only source + effect. The rule does not read description.
```

The system keeps `description` unchanged. The model needs the description to understand the purpose of the tool. But `effect` stays as the locally declared `external`. Remote text cannot downgrade a side effect to read-only.

The system can guarantee this behavior. The match condition of the permission rule in `bootstrap.ts` touches only two fields:

```typescript
// bootstrap.ts
if (profile.capabilities.has("mcp")) {
  // MCP management tools and remote external tools require terminal approval; rules read only source and effect.
  rules.push(
    new PermissionRule({
      name: "mcp-external-approval",
      behavior: "ask",
      reason: "MCP external tools require terminal approval",
      matches: (request) => {
        const definition = request.prepared.definition;
        return definition?.source.startsWith("mcp:") === true && definition.effect === "external";
      },
    }),
  );
}
```

`matches` does not contain `description`. `matches` does not parse any remote annotation. The function asks only two questions. Does this tool come from MCP, so `source` starts with `mcp:`? And does the local policy set the tool to `external`?

The local classification in the current CLI is:

| Tool | source | Local effect | Terminal behavior |
| --- | --- | --- | --- |
| `connect_mcp` | `mcp:management` | external | **ask (approval required)** |
| `disconnect_mcp` | `mcp:management` | external | **ask (approval required)** |
| `mcp__demo_*__lookup` | `mcp:demo_*:lookup` | read | allow |
| `mcp__demo_*__fail` | `mcp:demo_*:fail` | read | allow |
| `mcp__demo_*__delay` | `mcp:demo_*:delay` | read | allow |
| `mcp__demo_*__terminate` | `mcp:demo_*:terminate` | external | **ask (approval required)** |

One stricter constraint also applies: **the set of Published tool names must equal the set of local policy tool names exactly.**

The system does not take an intersection. The system does not accept the tools that match first. The sets must be equal. If a server publishes one unreviewed extra tool, the whole connection fails. If a server does not publish one locally expected tool, the whole connection also fails. Experiment 4 runs these three cases:

```text
===== policy =====
[1] The server publishes one extra unreviewed tool -> Error code=mcp_policy_mismatch; dynamic tools=0, close count=1
[2] The server does not publish one locally expected tool -> Error code=mcp_policy_mismatch; dynamic tools=0, close count=1
[3] The two sides match exactly -> Success {"server_alias":"fake","status":"connected","tools":["mcp__fake__lookup"]}; dynamic tools=1, close count=0
```

Note the `close count=1` in the first two cases. After the connection fails, the system closes the started child process immediately. The process does not stay in the system as a zombie process.

**Why must the system also reject extra published tools?** That extra tool did not pass local review. You do not know what the tool is. You did not assign an effect to the tool. If the system only ignores the tool, a later server upgrade can silently replace `lookup` with `lookup_v2`. The local system then silently loses one tool, and nobody knows. Set equality is the only method that makes a server change visible immediately.

The corresponding implementation is:

```typescript
// features/mcp-tools.ts —— #publishDefinitions
if (
  publishedNames.length !== policies.size ||
  publishedNames.some((name) => !policies.has(name))
) {
  throw new PublishFailure(
    "mcp_policy_mismatch",
    `MCP published tools do not exactly match local policy: ${spec.alias}`,
  );
}
```

---

## Name isolation must complete before publication

Two servers can both publish a tool named `lookup`. The local exposed name has a fixed form:

```text
mcp__{alias}__{normalized_remote_tool}
```

The normalisation rule has four steps. The code is exactly these four lines:

```typescript
// features/mcp-tools.ts —— exposedToolName
const normalized = remoteName
  .trim()
  .toLowerCase()                                   // ① Convert to lower case
  .replace(REMOTE_NAME_PATTERN, "_")               // ② Replace each run of characters outside [a-z0-9_] with one _
  .replace(REPEATED_UNDERSCORE_PATTERN, "_")       // ③ Collapse consecutive _ characters into one _
  .replace(/^_+|_+$/g, "");                        // ④ Remove _ at the start and at the end
```

Run the rule and check the effect. This output is the real output of experiment 7:

```text
===== name =====
[1] Normalisation: case, hyphens, leading and trailing symbols -> Success {"server_alias":"fake","status":"connected","tools":["mcp__fake__lookup_one","mcp__fake__read_file"]}; exposed names=mcp__fake__lookup_one mcp__fake__read_file
[2] Names collide after normalisation -> Error code=mcp_name_collision; exposed names=(none)
[3] The remote name contains only invalid characters -> Error code=mcp_invalid_tool_name; exposed names=(none)
[4] The built-in read_file still exists: true
[5] The remote tool with the same name goes to: mcp__fake__read_file
[6] Built-in call result: builtin
```

Compare the specific mappings:

| alias | Remote name | Local exposed name | Note |
| --- | --- | --- | --- |
| `demo_alpha` | `lookup` | `mcp__demo_alpha__lookup` | Normal case |
| `demo_beta` | `lookup` | `mcp__demo_beta__lookup` | Same name, no conflict; the alias isolates the tools |
| `fake` | `Lookup-One` | `mcp__fake__lookup_one` | Convert to lower case + normalise the hyphen |
| `fake` | `__read.file__` | `mcp__fake__read_file` | Normalise the dot + remove leading and trailing underscores |
| `fake` | `***` | **Reject** | The normalised result is an empty string, `mcp_invalid_tool_name` |

Normalisation itself creates new collisions. Both `lookup-one` and `lookup_one` become `lookup_one`. This chapter uses a direct method: **do not add a numeric suffix, do not overwrite the old definition, and reject the whole connection when a collision occurs** (the `mcp_name_collision` in step [2]).

An automatic suffix sounds friendlier. But an automatic suffix means that the tool name the model sees depends on the return order of `tools/list`. After one reconnect of the same server, `lookup_one` and `lookup_one_2` can swap positions. That uncertainty is much worse than a direct failure.

**A collision with a built-in tool name also causes rejection.** In practice, this collision cannot occur. In steps [4] to [6], a remote server also publishes a tool named `read_file`. That tool goes to `mcp__fake__read_file`. The local built-in `read_file` stays intact. A call to the built-in tool still returns `builtin`. The `mcp__` prefix naturally separates the two namespaces. A real collision can occur only inside one alias, after normalisation produces a duplicate name. That case is step [2].

The final name must also satisfy a length limit:

```typescript
const exposed = `mcp__${alias}__${normalized}`;
if (exposed.length > MAX_TOOL_NAME_LENGTH) {   // MAX_TOOL_NAME_LENGTH = 64
  throw new PublishFailure(
    "mcp_invalid_tool_name",
    `MCP exposed tool name exceeds ${MAX_TOOL_NAME_LENGTH} characters: ${alias}`,
  );
}
```

64 is the length limit for an OpenAI tool name. If a name exceeds the limit, the problem is not local. The model provider rejects the name when the system sends the tool to the model. The system must block the name at the publication stage.

---

## JSON Schema is an execution boundary, not prompt text

The tools in the earlier chapters are local code. The code declares parameters with Zod. The compiler can check the types at compile time. An MCP tool cannot use this method. `tools/list` returns a **JSON Schema that the system knows only at runtime**. The system cannot write this schema statically as a TypeScript interface.

This chapter uses this method: at publication, the system compiles the remote schema into a synchronous predicate. At call time, the system uses the predicate to block invalid arguments. At the same time, the system gives the **same** schema, unchanged, to the model.

```typescript
// features/mcp-tools.ts —— #publishDefinitions
let validator: (value: unknown) => boolean;
try {
  validator = this.#schemaValidator.compile(exposedName, tool.inputSchema);
} catch {
  throw new PublishFailure(
    "mcp_invalid_schema",
    `MCP tool input schema is invalid: ${exposedName}`,
  );
}
const inputSchema = z.custom<Record<string, unknown>>((value) => validator(value), {
  message: "Arguments failed MCP JSON Schema validation",
});
const definition: ToolDefinition<Record<string, unknown>> = {
  name: exposedName,
  description: validatedDescription(spec.alias, tool),
  inputSchema,
  inputSchemaJson: tool.inputSchema,        // ← The copy that the system gives to the model, unchanged
  effect: policy.effect,                    // ← The local policy, not the remote claim
  source: `mcp:${spec.alias}:${tool.name}`,
  handler: async (_input, _context) =>
    await this.#invokeRemote(spec.alias, tool.name, _input),
};
```

`inputSchema` is a Zod wrapper for runtime validation. `inputSchemaJson` is the original JSON Schema for the model. The two schemas have the same source. The contract that the model sees and the contract that the executor enforces cannot drift. When `openAITools()` sends tools to the model, the function prefers the second schema:

```typescript
// core/tools.ts —— openAITools
parameters:
  definition.inputSchemaJson ??
  (z.toJSONSchema(definition.inputSchema) as Readonly<Record<string, unknown>>),
```

Compilation occurs in `AjvMcpSchemaValidator`. The compilation has four checks:

```typescript
// adapters/mcp-schema.ts
if (inputSchema.type !== "object") {                      // ① The top level must be an object
  throw new McpContractError(`MCP tool input schema must have type object: ${exposedName}`);
}
// Performs a JSON round-trip first to eliminate circular references, functions, and non-serializable objects before passing to Ajv.
const serialized = JSON.stringify(inputSchema);           // ② The schema must be serializable
if (serialized === undefined) { /* ... */ }
const parsed: unknown = JSON.parse(serialized);
requireLocalReferences(parsed, exposedName);              // ③ Reject external references
const validator = selectAjv(parsed).compile(parsed as AnySchema);  // ④ Compile in strict mode
return (value: unknown) => validator(value) === true;
```

Step ③ needs a separate explanation. JSON Schema has three reference keywords. The system must check all three keywords:

```typescript
const SCHEMA_REFERENCE_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

// Recursively checks whether $ref/$dynamicRef/$recursiveRef in schema starts with #, rejecting external references.
if (SCHEMA_REFERENCE_KEYS.has(key) && (typeof nested !== "string" || !nested.startsWith("#"))) {
  throw new McpContractError(
    `MCP tool input schema contains an external reference: ${exposedName}`,
  );
}
```

The system allows only in-document fragments that start with `#`. The system rejects HTTP URLs, file paths and other external references directly at the publication stage. Without this check, a schema validator can become an entry point that makes your process access any network address or read local files.

Step ④ selects the dialect from `$schema`:

```typescript
// adapters/mcp-schema.ts —— selectAjv
const dialect = schema.$schema;
if (typeof dialect === "string" && dialect.includes("2020-12")) return new Ajv2020({ strict: true });
if (typeof dialect === "string" && dialect.includes("2019-09")) return new Ajv2019({ strict: true });
return new Ajv({ strict: true });
```

All three dialects use `strict: true`. A lenient mode silently ignores a misspelled keyword. For example, the mode accepts `require` instead of `required`. That error is exactly the error that the system most needs to find.

Experiment 6 runs the whole boundary:

```text
===== schema =====
[1] Invalid type -> Error code=mcp_invalid_schema; dynamic tools=0
[2] External $ref -> Error code=mcp_invalid_schema; dynamic tools=0
[3] The top level is not an object -> Error code=mcp_invalid_schema; dynamic tools=0
[4] The schema given to the model: {"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}
[5] A required field is missing -> Error code=invalid_arguments
[6] The type is wrong -> Error code=invalid_arguments
[7] An extra field is passed -> Error code=invalid_arguments
[8] The remote callTool count for the three calls above: 0
[9] Valid arguments -> Success {"content":[],"server_alias":"fake","status":"ok","structured_content":{},"tool":"mutate"}
[10] The remote callTool count becomes: 1
```

Step [8] is the core evidence in this section. After the three calls with invalid arguments, **the system did not call the remote `callTool` once**. Argument validation occurs in the local `prepare()` stage. Invalid arguments never leave the local process. In step [9], the caller passes valid arguments. Only then does the count become 1.

This point matters more for MCP than for local tools. A remote call can have side effects. A remote call can incur a charge. A remote call can trigger a rate limit on the remote side. Validation before the call leaves the local process is the only position that can guarantee zero cost for invalid arguments.

---

## Dynamic registration must be atomic

A server often publishes multiple tools at one time. `demo.ts` publishes 4 tools.

What happens if the system registers the tools one by one? Assume that validation fails for the third tool:

```text
registerMany, one-by-one version (incorrect approach)
  Register lookup     ✓ The model can now see it
  Register fail       ✓ The model can now see it
  Register delay      ✗ Schema compilation fails
  → Throw an error and return
  Result: The connection fails, but 2 tools from the "failed connection" remain in the registry
        What happens if the model calls them? Nobody knows
```

This state is a half-connected state. So `ToolRegistry.registerMany()` uses this order: **validate all items first, then write all items**:

```text
① Check that names in the batch are unique (new Set(names).size === names.length)
② Validate each definition (validateDefinition), and check for collisions with the existing registry (this.#definitions.has)
③ Write all definitions in one operation
④ Increment version by 1 only
```

The corresponding code is:

```typescript
// core/tools.ts —— registerMany
// Batch registration validates as a whole first; fail on any name conflict to avoid leaving half-connected MCP tool sets.
const names = definitions.map((definition) => definition.name);
if (new Set(names).size !== names.length) {
  throw new Error("tool registry batch contains duplicate names");
}
for (const definition of definitions) {
  validateDefinition(definition);
  if (this.#definitions.has(definition.name)) {
    throw new Error(`tool already registered: ${definition.name}`);
  }
}

const storedDefinitions = definitions.map((definition) => this.#storeDefinition(definition));
for (const stored of storedDefinitions) {
  this.#definitions.set(stored.name, stored);
}
this.#version += 1;
```

Note that `set()` starts only after the validation loop ends. If the code throws any error in between, it does not modify `#definitions`.

`unregisterMany()` also validates the whole batch first. It adds one requirement: **the object to revoke must be the exact definition that is currently registered**, not only a definition with the same name.

```typescript
// core/tools.ts —— unregisterMany
// Match current registered items by object identity on revocation to prevent stale connections from deleting reconnected tools of the same name.
for (const stored of storedDefinitions) {
  const current = this.#definitions.get(stored.name);
  if (current === undefined) {
    throw new Error(`tool is not registered: ${stored.name}`);
  }
  if (current !== stored) {                                    // ← object identity comparison
    throw new Error(`tool definition does not match registry: ${stored.name}`);
  }
}
```

**Why compare object identity?** Consider this sequence:

```text
t1  demo_alpha connects successfully and publishes mcp__demo_alpha__lookup (object A)
t2  The child process of demo_alpha crashes, and the Watchdog starts asynchronous cleanup
t3  The cleanup has not finished, and the user runs connect_mcp demo_alpha again
    → The reconnection succeeds and publishes a new mcp__demo_alpha__lookup (object B)
t4  The cleanup from t2 finally reaches unregisterMany([A])
```

If revocation uses the name only, t4 deletes **object B, which just reconnected successfully**. The model then loses a tool for no clear reason. But `#connections` still records the alias as connected. With object identity comparison, t4 finds `current(B) !== stored(A)`. It throws an error directly and changes nothing.

`#dropFailedConnection` contains another protection that uses the same idea:

```typescript
// features/mcp-tools.ts
// Checks object identity first to prevent old connection state from accidentally deleting new definitions after reconnect.
const existing = this.#connections.get(alias);
if (existing !== state) return undefined;
```

A snapshot copies the current definition map and blocks write operations:

```typescript
// core/tools.ts
snapshot(): ToolRegistry {
  // Returns an immutable snapshot so executing turns are not affected by subsequent MCP connect or disconnect operations.
  return new ToolRegistry(this.#definitions, false, this.#version);
}
```

`new Map(definitions)` copies the content. `mutable = false` blocks writes. Later additions or revocations in the live registry do not change the version that the system already sent to the model.

Experiment 3 runs these four properties one by one:

```text
===== atomic =====
[1] After first is registered, live is v1, snapshot is v1
[2] Register 2 more in a batch → live is v2, list is first second third
[3] The snapshot is still first (v1)
[4] The batch contains an already registered name → tool already registered: second
[5] After the failure, the list does not change: first second third, version is still v2
[6] Revoke with a same-name definition from another registry → tool definition does not match registry: second
[7] Register into a snapshot → tool registry snapshot is immutable
[8] Revoke first → live is v3, list is second third
```

The steps correspond one by one:

| Step | What it verifies |
| --- | --- |
| [1][2] | version increases monotonically, and one batch registration adds only +1 (register 2 tools, v1 → v2) |
| [3] | The snapshot and the live registry are separate: live has 3 tools, and the snapshot still has the original 1 tool |
| [4][5] | A batch contains an already registered name → the whole batch fails, and **the list and the version do not change** |
| [6] | A definition with the same name but a different object cannot revoke the tool |
| [7] | A snapshot is not writable |
| [8] | Revocation also uses a version transition (v2 → v3) |

---

## Why new tools are visible only in the next turn

This is a trap that beginners hit most often. It is also the behavior that readers most often misjudge as a bug.

Look at the behavior first. Experiment 2 uses a scripted model. The model does two things in **the same reply**: it calls `connect_mcp`, and then it immediately calls the newly connected `mcp__demo_alpha__lookup`.

```text
===== snapshot =====
[1] The tool surface for request 1: connect_mcp disconnect_mcp
[2] The tool surface for request 2: connect_mcp disconnect_mcp mcp__demo_alpha__lookup mcp__demo_alpha__fail mcp__demo_alpha__delay mcp__demo_alpha__terminate
[3] The tool surface for request 3: (same as request 2)
[4] Final answer: done
[5] The result of the early call in the same turn: Error [unknown_tool]: Unknown tool: mcp__demo_alpha__lookup
[6] The result of the same-name call in the next turn: {"content":[{"type":"text","text":"{\"label\":\"alpha\",\"query\":\"needle\"}"}],"server_alias":"demo_alpha","status":"ok","structured_content":{"label":"alpha","query":"needle"},"tool":"lookup"}
```

The tool name is the same. The connection is the same. **The call fails in the same turn, and succeeds in the next turn**.

The reason is in `loop.ts`:

```typescript
// core/loop.ts:406
// A model request and all tool calls in its reply share the same immutable snapshot;
// MCP connect/disconnect can only affect tool sets at the start of the next model request.
const tools = this.#tools.snapshot();
```

The system takes one snapshot before one model request. All tool calls in this turn use this snapshot for resolution and execution. During the turn, `connect_mcp` changes the live registry. The snapshot is not affected.

Drawn as a timeline:

```text
────────── Model request 2 ──────────────────────────────────────
snapshot() → snapshot v1 = { connect_mcp, disconnect_mcp }
             │
Model reply: ├─ Call connect_mcp ─────────► live registry v1 → v2
             │                            (adds 4 mcp__demo_alpha__* tools)
             │                            The snapshot is still v1
             │
             └─ Call mcp__demo_alpha__lookup
                  ↓ Look up in snapshot v1
                  ✗ unknown_tool

────────── Model request 3 ──────────────────────────────────────
snapshot() → snapshot v2 = { connect_mcp, disconnect_mcp, mcp__demo_alpha__* × 4 }
             │
             └─ Call mcp__demo_alpha__lookup  ✓ Success
```

**Why not change the design to "visible immediately"?** Visible immediately means the tool surface changes during the execution of one reply. That change causes three specific problems:

| If tools are visible immediately in the same turn | What happens |
| --- | --- |
| The tool list that the model sees does not match the tools that it can actually call | The model makes decisions from the `tools` list at request time. It does not know that the tool surface changed |
| The results of concurrent tool calls depend on execution order | In the same turn, A disconnects a connection and B calls a tool on that connection. Success or failure depends on which call finishes first |
| Errors are hard to review | Replaying the same conversation record twice can give different results |

The snapshot gives one benefit: **the tool surface is constant within one turn**. The cost is only one item — the model must spend one more turn before it can use a new tool. This cost is visible to the model, and the model can learn it: `unknown_tool` is a clear error, and the model retries naturally in the next turn.

Note that this snapshot boundary **is not new in this chapter**. Chapter 18 already has this behavior at `loop.ts:406`, with the same comment. This chapter adds the matching items in `core/tools.ts`:

| New in ch19 in `core/tools.ts` | Purpose |
| --- | --- |
| `version` + `#version` | Makes the event "the tool surface changed" observable and assertable |
| `registerMany` / `unregisterMany` | Atomic batch registration and revocation |
| `#sourceDefinitions` (WeakMap) | The basis for revocation by object identity |
| `inputSchemaJson` | Passes a remote JSON Schema through to the model unchanged |
| `source` | Marks the tool source (`builtin` / `mcp:{alias}:{tool}`) |

In other words: ch18 already has the mechanism for "the tool surface does not change within one turn". ch19 adds the mechanism for "the tool surface **can change safely between turns**".

---

## Each connection has an independent lifecycle

The connection state in `McpRuntime` has this structure:

```typescript
// features/mcp-tools.ts —— McpRuntime private fields
// servers is the startup allowlist; connections holds only active connections that finished "discovery + registration".
readonly #servers: ReadonlyMap<string, McpServerSpec>;
readonly #connectionFactory: McpConnectionFactory;
readonly #schemaValidator: McpSchemaValidator;
readonly #connections = new Map<string, ConnectionState>();
// Objects revoked from registry whose connection.close() has not yet succeeded; fallback retry when Runner closes in reverse order.
readonly #pendingCloses: McpConnection[] = [];
readonly #lock = new AsyncMutex();                       // Serializes connect/disconnect
#registry: ToolRegistry | undefined;                     // Injected at install()
#closeRequested = false;
#closed = false;
```

Each alias has one `ConnectionState` (`{ spec, connection, definitions }`). The states do not share data. This design gives one important property: **if one connection crashes, the other connections are not affected**.

The trace in Experiment 1 already shows this property. Now look at Experiment 8 on the failure side:

```text
===== failure =====
[1] The remote side returns isError → {"error":{"code":"mcp_remote_error","message":"MCP server reported a tool error"},"server_alias":"demo_alpha","status":"error","tool":"fail"}
      Dynamic tools before the call = 4, after the call = 4, still connected = demo_alpha
      Does server-private-detail appear in the result: false
[2] tools/call times out → {"error":{"code":"mcp_timeout","message":"MCP tool call exceeded its timeout"},...,"tool":"delay"}
      Dynamic tools before the call = 4, after the call = 0, still connected = (none)
      Does server-private-detail appear in the result: false
[3] The child process exits → {"error":{"code":"mcp_connection_lost","message":"MCP connection was lost during the tool call"},...,"tool":"terminate"}
      Dynamic tools before the call = 4, after the call = 0, still connected = (none)
      Does server-private-detail appear in the result: false
[4] The connection succeeds, dynamic tools = mcp__fake__lookup
[5] After the transport disconnects, dynamic tools = (none), still connected = (none)
[6] Stale call → Success {"server_alias":"fake","status":"connected","tools":["mcp__fake__lookup"]} (can reconnect)
```

The three failures have three different handlings. The difference is clear:

| Failure type | Error code | How the system handles the connection | Why the system handles it this way |
| --- | --- | --- | --- |
| The remote side clearly states "this tool call failed" (`isError: true`) | `mcp_remote_error` | **Keep** (tool count 4 → 4) | The transport layer is healthy. Only this business logic call failed. A disconnect affects other calls without benefit |
| `tools/call` times out | `mcp_timeout` | **Discard** (tool count 4 → 0) | The system does not know what the remote side is doing. It also does not know whether a result will appear later. The connection state is no longer trusted |
| The child process exits / the transport disconnects | `mcp_connection_lost` | **Discard** (tool count 4 → 0) | The transport channel is gone. The connection no longer exists |

`#invokeRemote` contains these three branches:

```typescript
// features/mcp-tools.ts —— #invokeRemote
// Treat timeouts or transport failures as connection loss; business isError returns fixed redacted results without leaking server details.
let result: McpCallResult;
try {
  result = await state.connection.callTool(remoteName, argumentsValue, {
    timeoutSeconds: state.spec.toolTimeoutSeconds,
  });
} catch (error) {
  if (error instanceof McpTimeoutError) {
    await this.#dropFailedConnection(alias, state);       // ← Discard the connection
    return remoteError(alias, remoteName, "mcp_timeout", "MCP tool call exceeded its timeout");
  }
  if (error instanceof McpTransportError) {
    await this.#dropFailedConnection(alias, state);       // ← Discard the connection
    return remoteError(
      alias, remoteName,
      "mcp_connection_lost", "MCP connection was lost during the tool call",
    );
  }
  throw error;                                           // ← Rethrow unknown exceptions, do not swallow them
}
if (result.isError) {
  // Only return an error, do not touch the connection
  return remoteError(alias, remoteName, "mcp_remote_error", "MCP server reported a tool error");
}
```

The final `throw error` deserves a separate note: only `McpTimeoutError` and `McpTransportError`, two **known boundary errors**, become tool results. The code throws other exceptions unchanged, for example local programming errors. It does not disguise them as "remote failures". A broad catch of all errors records a bug in local code as a fault of the remote server.

Step [5] shows another path: **no tool call occurs**, and the transport disconnects by itself. The connection-level Watchdog detects the failure and cleans up:

```typescript
// features/mcp-tools.ts
async #watchConnection(alias: string, state: ConnectionState): Promise<void> {
  // Connection-level Watchdog: Revokes dynamic tools of the alias after transport termination to prevent invalid tools from remaining exposed.
  await state.connection.waitForFailure();
  await this.#dropFailedConnection(alias, state);
}
```

The system starts it with fire-and-forget when `#connect` succeeds:

```typescript
// features/mcp-tools.ts —— #connect, at the end
const state = { spec, connection, definitions };
this.#connections.set(alias, state);
// Connection state and definitions are visible simultaneously; subsequent transport failures are revoked uniformly by Watchdog.
void this.#watchConnection(alias, state);
```

Without it, the tools remain in the registry. The problem appears only when the model calls a tool next time. That call must fail, and it fails after the model has already made its decision. The Watchdog moves the discovery time forward to the moment of disconnection.

Step [6] shows that the cleanup is clean: after the system discards a connection, the same alias **can connect again**. The system deletes the entry in `#connections`. The spec in the allowlist still exists. So `connect_mcp` runs the full connection process again.

`#pendingCloses` handles this case: "the system must discard the connection, but `close()` itself also fails":

```typescript
// features/mcp-tools.ts
#rememberPendingClose(connection: McpConnection): void {
  // Deduplicate by object identity to prevent adding the same connection to the close queue multiple times.
  if (!this.#pendingCloses.some((existing) => existing === connection)) {
    this.#pendingCloses.push(connection);
  }
}
```

A child process can become stuck in its exit process and cannot close. The system cannot retry in place until success, because that blocks the whole runtime. It also cannot drop the reference directly, because that leaks the child process. It adds the connection to `#pendingCloses`. `McpRuntime.close()` retries all pending closes together.

---
## A connection is a transaction, and disconnect is its reverse

One `connect_mcp` call does four things. Each thing can fail:

```text
① factory.open(spec)         start child process + initialize handshake
② connection.listTools()     tools/list (can paginate)
③ #publishDefinitions(...)   exact policy match + name normalisation + schema compilation
④ registry.registerMany(...) atomic batch registration
```

The system writes to `#connections` only after all four steps pass. If any step fails, the system guarantees two things: **no child process leaks, and no orphan tool remains in the registry**.

The full flow is in `#connect`. The whole flow runs inside `#lock`:

```typescript
// features/mcp-tools.ts —— #connect
// Alias-level connection is a transactional publication: open, tools/list, policy/schema validation, and batch registration
// Writes to #connections only after total success; any failure attempts to close temporary connections.
return await this.#lock.run(async () => {
  if (this.#closeRequested || this.#closed) {
    return toolError("mcp_runtime_closed", "MCP runtime is closing or closed");
  }
  const spec = this.#servers.get(alias);
  if (spec === undefined) {
    return toolError("unknown_mcp_server", `Unknown MCP server alias: ${alias}`);
  }
  if (this.#connections.has(alias)) {
    return toolError("mcp_already_connected", `MCP server alias is already connected: ${alias}`);
  }

  let connection: McpConnection;
  try {
    connection = await this.#connectionFactory.open(spec);          // ①
  } catch (error) {
    return this.#connectionError(alias, error, "connect");          // did not start, no cleanup is necessary
  }
  let published: readonly McpPublishedTool[];
  try {
    published = await connection.listTools();                       // ②
  } catch (error) {
    await this.#closeFailedConnection(connection);                  // close the child process that was just opened
    return this.#connectionError(alias, error, "tool discovery");
  }

  let definitions: readonly StoredToolDefinition[];
  try {
    const candidates = this.#publishDefinitions(spec, published);   // ③
    definitions = this.#requireRegistry().registerMany(candidates); // ④
  } catch (error) {
    const cleanupOk = await this.#closeFailedConnection(connection);
    if (!cleanupOk) {
      return toolError(
        "mcp_cleanup_failed",
        `MCP connection validation failed and cleanup is pending: ${alias}`,
      );
    }
    if (error instanceof PublishFailure) {
      return toolError(error.code, error.publicMessage);
    }
    return toolError(
      "mcp_name_collision",
      `MCP exposed tool name collides with the local registry: ${alias}`,
    );
  }
  const state = { spec, connection, definitions };
  this.#connections.set(alias, state);
  void this.#watchConnection(alias, state);
  return toolSuccess(
    jsonText({
      server_alias: alias,
      status: "connected",
      tools: definitions.map((definition) => definition.name),
    }),
  );
});
```

Three details need attention.

**First, the cleanup action follows the failure position.** If step ① fails, the child process does not start. No cleanup is necessary. If a step after step ② fails, the code must call `#closeFailedConnection`. Otherwise, the child process remains in the system.

**Second, cleanup can also fail, and the code reports that failure separately.** `#closeFailedConnection` returns a boolean. If cleanup fails, the code returns `mcp_cleanup_failed`. The code does not return the original schema error. This does not hide the error. At this point, **the most important fact has changed**: a child process that cannot close is still running. That fact is more important than "the schema is invalid".

**Third, `#publishDefinitions` uses `PublishFailure` to carry a specific code for every rejection reason.** Only a real name collision (thrown by `registerMany`) falls through to `mcp_name_collision`. The model can therefore use the error code to distinguish two cases. In one case, the server declaration that you tried to connect to has a problem. In the other case, the name is already in use locally.

Disconnect uses the **reverse order**:

```typescript
// features/mcp-tools.ts —— #disconnect
// Disconnect removes state and definitions inside the lock, then closes transport outside the lock. This ensures the model loses capability immediately.
const state = await this.#lock.run(async () => {
  if (this.#closeRequested || this.#closed) return undefined;
  if (!this.#servers.has(alias)) return null;
  const current = this.#connections.get(alias);
  if (current === undefined) return false;
  this.#connections.delete(alias);
  this.#requireRegistry().unregisterMany(current.definitions);
  return current;
});
// ...the three sentinel values map to mcp_runtime_closed / unknown_mcp_server / mcp_not_connected respectively

// Revokes definitions before closing connection; even if close fails, model cannot see disconnected remote tools.
try {
  await state.connection.close();
} catch {
  this.#rememberPendingClose(state.connection);
  return toolError(
    "mcp_disconnect_failed",
    `MCP tools were withdrawn but connection cleanup is pending: ${alias}`,
  );
}
```

The order is "**revoke the capability first, then close the transport**". The order is not the reverse. The reason is direct: revocation is synchronous and does not fail. Close is I/O. Close can be slow and can fail. If the code closes the transport first, the registry still holds tools that are already unusable during the close. If the code uses the reverse order, the model has already lost this capability completely when `disconnect_mcp` returns. The result of `close()` does not change that fact.

Note also that revocation happens **inside the lock**, and `close()` happens **outside the lock**. State changes need serialisation. Slow I/O must not block a later connect or disconnect.

`McpRuntime.close()` is a larger version of the same idea:

```typescript
// features/mcp-tools.ts —— close
// Shutdown revokes all model-visible tools inside lock first, then reclaims stdio resources in reverse connection order;
// Connections that fail to close remain in pendingCloses, allowing upper layers to call close again to retry.
const connections = await this.#lock.run(async () => {
  if (this.#closed) return [] as McpConnection[];
  this.#closeRequested = true;
  const states = [...this.#connections.values()].reverse();       // ← reverse order
  const definitions = states.flatMap((state) => [...state.definitions]);
  if (definitions.length > 0) this.#requireRegistry().unregisterMany(definitions);
  this.#connections.clear();
  const result = states.map((state) => state.connection);
  result.push(...this.#pendingCloses.splice(0));                  // ← fallback retry
  return result;
});
// Revokes definitions first, then closes connection outside lock to avoid long I/O blocking subsequent state operations.
const failures: unknown[] = [];
for (const connection of connections) {
  try {
    await connection.close();
  } catch (error) {
    failures.push(error);
    this.#rememberPendingClose(connection);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "MCP runtime close failed");
this.#closed = true;
```

`.reverse()` closes later connections first. This is the same convention as the reverse-order close of Runner `resources` in Chapter 12. If multiple connections fail to close, the code uses `AggregateError` to report all failures at once. The code does not report only the first failure and discard the rest.

---

## Error results must be bounded and sanitised

Content that a remote server returns must not enter the message history directly. Two reasons apply:

1. **The length is not controllable.** A remote server can return a 10 MB error stack. That stack displaces truly useful context. Every later turn also pays tokens for that stack.
2. **The content is not trusted.** A remote error can contain internal server paths, connection strings, and internal host names. A remote error can even contain crafted prompt injection text.

The `fail` tool in `demo.ts` verifies this point. The tool deliberately returns a sentinel string:

```typescript
// mcp-servers/demo.ts
server.registerTool("fail", { description: "Return a deterministic remote tool error." }, () => ({
  content: [{ type: "text", text: "server-private-detail" }],
  isError: true,
}));
```

Every step of Experiment 8 checks whether this sentinel string leaks out:

```text
[1] Remote returns isError → {"error":{"code":"mcp_remote_error","message":"MCP server reported a tool error"},...}
      Does server-private-detail appear in the result: false
```

The model sees only `mcp_remote_error` and one fixed English description. The system does not pass out anything that the remote server wrote.

The function that generates this envelope accepts only locally constructed literals:

```typescript
// features/mcp-tools.ts
function remoteError(alias: string, remoteName: string, code: string, message: string): ToolResult {
```

Of the four parameters, `code` and `message` all come from string literals at the call site. `alias` and `remoteName` come from the local allowlist and policy. **The remote server cannot determine the value of any parameter.**

The success path does not allow everything through either. The system wraps remote content as structured JSON with `jsonText`:

```typescript
return toolSuccess(
  jsonText({
    content: result.content,
    server_alias: alias,
    status: "ok",
    structured_content: result.structuredContent,
    tool: remoteName,
  }),
);
```

The system adds the three fields `server_alias`, `status`, and `tool` locally. These fields let the model distinguish "which tool on which remote server this text comes from". The model does not mistake that text for words from the system itself.

The `remoteError` function that generates the envelope is also very short. A reader can check the whole function at a glance:

```typescript
// features/mcp-tools.ts
function remoteError(alias: string, remoteName: string, code: string, message: string): ToolResult {
  // Remote errors retain only controllable fields like code/message/alias; server private content does not enter model context.
  return {
    content: jsonText({
      error: { code, message },
      server_alias: alias,
      status: "error",
      tool: remoteName,
    }),
    isError: true,
    errorCode: code,
  };
}
```

The system applies the same handling to `description`. A remote `description` is only hint text. That text enters the system prompt, so the system sets a length limit for it:

```typescript
// features/mcp-tools.ts
function validatedDescription(alias: string, tool: McpPublishedTool): string {
  // Empty descriptions use local controlled text; non-empty descriptions are retained as-is after length limiting.
  if (tool.description === undefined || tool.description.trim().length === 0) {
    return `MCP tool ${tool.name} published by server alias ${alias}.`;
  }
  if (tool.description.length > MAX_DESCRIPTION_LENGTH) {     // MAX_DESCRIPTION_LENGTH = 1024
    throw new PublishFailure(
      "mcp_invalid_tool_description",
      `MCP tool description exceeds ${MAX_DESCRIPTION_LENGTH} characters: ${alias}`,
    );
  }
  return tool.description;
}
```

Two strategies apply: an empty description uses locally generated text as a fallback (the system does not leave a blank for the model to guess from). An overlong description **rejects the whole connection directly at the publication stage**. The system does not apply truncation and then carry the text into the prompt. Truncation produces a text that is cut in half. That text is harder to investigate than a clear rejection.

The system handles `stderr` more completely. The system does not read it at all:

```typescript
// adapters/mcp-client.ts —— StdioClientTransport parameters
stderr: "ignore",
```

The stderr of a child process is a completely uncontrolled output source. If you connect that source to the local log, you give the remote server a channel to write arbitrary content directly into your log. Ignoring it is the simplest and safest choice.

---

## MCP tools belong only to the Lead

Chapter 13 has a subagent. Chapter 15 has a teammate. Each executor has its own registry. Should MCP tools go to them?

The answer in this chapter is **no**. This decision does not depend on "remembering not to pass them". The structure implements this decision:

```typescript
// bootstrap.ts:353-357
if (dependencies.mcpRuntime !== undefined) {
  // Install only to the Lead registry; Subagent/Teammate factories do not hold McpRuntime,
  // Remote tools therefore do not propagate implicitly through sub-executor paths.
  dependencies.mcpRuntime.install(tools);
}
```

The `tools` value in `install(tools)` is the Lead registry. The system constructs the subagent and teammate factories before this line. Their closures **do not contain the `mcpRuntime` variable at all**. This is not "choose not to use it". They cannot obtain it.

`install()` also prohibits repeated installation:

```typescript
// features/mcp-tools.ts —— install
// The runtime binds one-to-one with a mutable registry. Repeated installation breaks object identity revocation semantics of definitions.
if (this.#registry !== undefined) {
  throw new McpContractError("MCP runtime is already installed");
}
if (this.#closeRequested || this.#closed) {
  throw new McpContractError("MCP runtime cannot be installed after close");
}
// Install connection management tools only in the Lead registry; publish remote tools dynamically after connect succeeds.
registry.registerMany(this.#leadToolDefinitions);
this.#registry = registry;
```

The reason is in the comment: one runtime binds to one registry. If you install the runtime into two registries, the object identity semantics of `unregisterMany` fail immediately. The same definition object exists in two registries. At revocation time, the system does not know which registry to change. Rejecting the case at startup is better than strange behavior at runtime.

Experiment 10 verifies that the isolation is real:

```text
===== scope =====
[1] Lead tool count=25, contains connect_mcp=true
[2] Lead final answer: lead done
[3] Subagent tool count=12, MCP-related among them=0 (not visible)
[4] Teammate tool count=9, MCP-related among them=0 (not visible)
```

Three executors have three different tool surfaces. The Lead has 25 tools (including `connect_mcp` / `disconnect_mcp`). The subagent has 12 tools and the teammate has 9 tools. **The MCP-related count is 0 in both cases.** This experiment checks the tool list in the real system prompt. The experiment does not infer the result from reading code.

**Why does the system use this design?** Three reasons apply, in order of importance:

| Reason | Description |
| --- | --- |
| Permission approval happens at the Lead | `mcp-external-approval` uses terminal approval. A subagent runs in the background and has no terminal to ask — giving it external tools gives it a path that bypasses approval |
| A connection is a stateful shared resource | If multiple subagents use the same stdio connection concurrently, the system cannot trace "who triggered the disconnect" |
| Context budget | The schema and description of a remote tool enter the system prompt. The value of a subagent is a clean context. Filling that context with remote tools that the subagent does not use is the reverse operation |

When a sub-executor needs a remote capability, the correct method is different. The Lead calls the remote tool first and obtains the result. The Lead then passes the **result** to the subagent as the task description. The capability stays at the Lead. The data flows down.

For lifecycle, `McpRuntime` enters the Runner `resources`. The runtime is last in the list:

```typescript
// bootstrap.ts:381-387
// Pass resources to AgentRunner for reverse cleanup on close; MCP runtime shares lifecycle with background resources.
const resources: readonly AsyncResource[] = Object.freeze([
  ...(dependencies.backgroundSupervisor === undefined ? [] : [dependencies.backgroundSupervisor]),
  ...(dependencies.cronRuntime === undefined ? [] : [dependencies.cronRuntime]),
  ...(dependencies.teammateRuntime === undefined ? [] : [dependencies.teammateRuntime]),
  ...(dependencies.mcpRuntime === undefined ? [] : [dependencies.mcpRuntime]),
]);
```

The system closes `resources` in **reverse order**. The `mcpRuntime` is last in the list, so the system closes it **first**. This order is deliberate: the system cuts the external connection first. The system then reclaims the local background tasks and teammates. In the reverse order, a background task can still try to call a remote tool while the MCP Connection closes.

The last step of Experiment 9 verifies that this chain works:

```text
[6] connection.close count after Runner closes: 1
```

`runner.close()` → `resources` in reverse order → `mcpRuntime.close()` → the connection closes. No manual call is necessary in between.

At the profile level, MCP is a new capability in Chapter 19:

```typescript
// core/profiles.ts
export const P19: Profile = Object.freeze({
  chapter: 19,
  capabilities: new CapabilitySet([...P18.capabilities, "mcp"]),
});
```

`bootstrap.ts` uses a pair of **bidirectional** guards to bind the capability and the dependency together:

```typescript
// bootstrap.ts:111-116
if (profile.capabilities.has("mcp") && dependencies.mcpRuntime === undefined) {
  throw new Error("mcpRuntime is required for chapter 19 or later");
}
if (!profile.capabilities.has("mcp") && dependencies.mcpRuntime !== undefined) {
  throw new Error("mcpRuntime requires chapter 19 or later");
}
```

The system must block both directions. If the system blocks only the first direction, P18 silently ignores an `mcpRuntime` that you pass in. You think MCP is configured. In fact, the system does not even provide `connect_mcp`, and no error reports the problem.

---

## The demo server: an MCP server that breaks on purpose

`src/mcp-servers/demo.ts` is the test target in this chapter. The file has only 63 lines. The file uses the `McpServer` class from the official SDK. Its four tools correspond to four behaviors that need verification:

```typescript
// mcp-servers/demo.ts —— full text (imports omitted)
const label = process.argv[process.argv.indexOf("--label") + 1];
// label distinguishes two isomorphic servers; testing alias isolation can verify actual routing targets from results.
if (label === undefined || label.trim().length === 0) {
  throw new Error("--label must not be empty");
}

// Each demo process launches an MCP server independently and communicates with clients through stdin/stdout.
const server = new McpServer({ name: `agent-tutorial-${label}`, version: "0.1.0" });

// lookup returns structured results to verify same-named remote tools do not cross paths after alias isolation.
server.registerTool(
  "lookup",
  { description: "Look up one value in this demo server.", inputSchema: { query: z.string() } },
  async ({ query }) => ({
    content: [{ type: "text", text: JSON.stringify({ label, query }) }],
    structuredContent: { label, query },
  }),
);

// fail returns isError: true to verify remote errors enter the Agent only as fixed, sanitized results.
server.registerTool(
  "fail",
  { description: "Return a deterministic remote tool error." },
  async () => ({
    content: [{ type: "text", text: "server-private-detail" }],
    isError: true,
  }),
);

// delay blocks responses in milliseconds to verify tools/call timeouts and subsequent connection teardown.
server.registerTool(
  "delay",
  {
    description: "Delay a response for timeout testing.",
    inputSchema: { milliseconds: z.number().int().nonnegative() },
  },
  async ({ milliseconds }) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return {
      content: [{ type: "text", text: JSON.stringify({ label, milliseconds }) }],
      structuredContent: { label, milliseconds },
    };
  },
);

// terminate exits child processes actively to verify that transport failures trigger connection-level Watchdog cleanup.
server.registerTool(
  "terminate",
  { description: "Terminate this demo server process." },
  async () => {
    process.exit(17);
  },
);

await server.connect(new StdioServerTransport());
```

| Tool | Used to verify |
| --- | --- |
| `lookup` | Normal path: argument validation, structured result, `label` distinguishes different aliases |
| `fail` | Handling of `isError: true` — keep the connection + sanitisation (`server-private-detail` must not leak out) |
| `delay` | Timeout path — passing a value greater than `toolTimeoutSeconds` triggers `mcp_timeout` reliably |
| `terminate` | Transport interruption — `process.exit(17)` kills the child process directly and triggers `mcp_connection_lost` |

`--label` is a required parameter. Starting the same code twice (`alpha` / `beta`) gives two independent servers. The return value of `lookup` contains `label`. Experiment 1 can therefore prove that "the two connections do not cross".

Note that `terminate` uses exit code 17. This value is not common. During investigation, a reader can confirm at a glance that "this tool killed the child process on purpose". The child process did not hit a different problem.

**This server breaks on purpose.** A real MCP server does not call `process.exit` on its own. Your Agent will certainly meet a server that crashes. If you make failure a tool that you can trigger on demand, automated tests can cover the failure path. The tests do not depend on chance.

---
## Hands-On: Run Chapter 19

The seven steps below are the order that I actually got to work. Each step gives the real output. You can compare against it to confirm where you are.

### Step 1: Check the Environment

```powershell
node --version
npm --version
```

On my machine, the output is:

```text
v25.7.0
11.19.0
```

`package.json` requires `"node": ">=20.12"`. If your version is lower than this version, upgrade Node first. Do not continue to the next step yet.

### Step 2: Install the Dependencies

```powershell
cd F:\笔记\Agent实操\code
npm install
```

This chapter adds only two new dependencies:

| Dependency | Version | Purpose |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `^1.30.0` | The official MCP SDK. The client and the server both use it |
| `ajv` | `^8.20.0` | Compile remote JSON Schemas (including `ajv/dist/2019` and `ajv/dist/2020`) |

### Step 3: Run the Tests First, and Confirm That the Code Is Good

```powershell
npm run test:ch19
```

```text
 Test Files  63 passed (63)
      Tests  415 passed (415)
   Duration  15.64s
```

If you want to see only the four test files that chapter 19 adds, run this command:

```powershell
npx vitest run chapters/ch19/tests/ch19-registry.test.ts chapters/ch19/tests/ch19-mcp.test.ts chapters/ch19/tests/ch19-bootstrap.test.ts chapters/ch19/tests/ch19-entry.test.ts
```

```text
 Test Files  4 passed (4)
      Tests  20 passed (20)
   Duration  3.37s
```

**The output contains several lines that look like errors. This is normal.** The tests print these lines when they deliberately trigger a failure path:

```text
Runtime Failure: workspace is not a Git repository root
Runtime Failure: CLI execution or cleanup failed
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

Use only the final `Test Files ... passed` line and `Tests ... passed` line as the pass criterion.

### Step 4: Prepare a Git Repository as the Working Directory

This step is the easiest place to get stuck. Chapter 19 inherits the worktree capability from P18. The worktree requires **the run directory to be a Git repository root**:

```typescript
// cli.ts:186-187
// Verify cwd is the Git repository root before creating any runtime state to avoid leaving task stores in the wrong directory.
if (worktreeRuntime !== undefined) await worktreeRuntime.validateRepository();
```

If you run `npm run ch19` directly in the `code/` directory, the run fails. The `code/` directory is not a repository root:

```powershell
cd F:\笔记\Agent实操\code
npm run ch19 -- --prompt "test"
```

```text
Runtime Failure: workspace is not a Git repository root
```

So create a separate directory:

```powershell
mkdir C:\tmp\ch19-demo
cd C:\tmp\ch19-demo
git init
```

Then put the configuration in that directory. `cli.ts` reads the configuration from the `.env` file under `process.cwd()`:

```typescript
// cli.ts:130-135
const workspace = resolve(process.cwd());
const envPath = resolve(workspace, ".env");
const requiresFallback = profile.capabilities.has("recovery");
const settings = existsSync(envPath)
  ? settingsFromEnvFile(envPath, requiresFallback)
  : settingsFromMapping({}, requiresFallback);
```

The required keys are below. P19 has the `recovery` capability, so `OPENAI_FALLBACK_MODEL` is also required:

```text
OPENAI_BASE_URL=...
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_FALLBACK_MODEL=...
```

If a key is missing, you get this error line. The error lists all missing keys:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

### Step 5: Call the Chapter Entrypoint from the New Directory

`npm run ch19` sets the cwd to `code/`, so you cannot use it. Use `npm exec --prefix` instead. The `--prefix` option points to the dependencies. The cwd stays in your repository:

```powershell
cd C:\tmp\ch19-demo
npm exec --prefix "F:\笔记\Agent实操\code" -- tsx "F:\笔记\Agent实操\code\chapters\ch19\src\chapters\ch19.ts" --prompt "Connect demo_alpha, then use lookup to query needle"
```

`chapters/ch19.ts` has only 5 lines. The file passes P19 to `runProfile`:

```typescript
// chapters/ch19.ts —— full text
import { runProfile } from "../cli.js";
import { P19 } from "../core/profiles.js";

// Fixed entrypoint enables P19 MCP connection and dynamic tool publishing capabilities.
process.exitCode = await runProfile(P19, process.argv.slice(2));
```

### Step 6: Understand the Approval Gate

The effect of `connect_mcp` is `external`. P19 installs a terminal approval rule for `external`. So the first connection is always stopped and asks you.

**If a pipe takes the output (not a TTY), the system rejects the call automatically:**

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: connect_mcp

Tool call requires approval: connect_mcp
Reason: MCP external tools require terminal approval
Arguments: {"alias":"demo_alpha"}
No interactive input, rejecting by default.
[Permission] connect_mcp: deny (terminal-approval) - No interactive approval input was available
[Hook] Stop
```

This is the setting in `TerminalApprovalProvider`:

```typescript
// cli.ts —— TerminalApprovalProvider.decide
stderr.write(`\nTool call requires approval: ${definition.name}\n`);
stderr.write(`Reason: ${proposed.reason}\n`);
stderr.write(`Arguments: ${JSON.stringify(request.prepared.arguments)}\n`);
if (!stdin.isTTY) {
  stderr.write("No interactive input, rejecting by default.\n");
  return new PermissionDecision(
    "deny",
    "No interactive approval input was available",
    "terminal-approval",
  );
}

const terminal = createInterface({ input: stdin, output: stderr });
try {
  const answer = await terminal.question("Allow this call? [y/N] ");
  const normalized = answer.trim().toLowerCase();
  const allowed = normalized === "y" || normalized === "yes";
  return new PermissionDecision(
    allowed ? "allow" : "deny",
    allowed ? "User approved this tool call" : "User denied this tool call",
    "terminal-approval",
  );
} finally {
  terminal.close();
}
```

When no person is available to ask, the system rejects by default. The system does not allow by default. This is the only acceptable default direction in this chapter. An `external` operation should not happen at all rather than happen quietly with no supervision.

**Run in a real terminal, and enter `y`. The output looks like this:**

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: connect_mcp

Tool call requires approval: connect_mcp
Reason: MCP external tools require terminal approval
Arguments: {"alias":"demo_alpha"}
Allow this call? [y/N] [Permission] connect_mcp: allow (terminal-approval) - User approved this tool call
[Hook] PostToolUse: connect_mcp -> ok
[Hook] PreToolUse: mcp__demo_alpha__lookup
[Permission] mcp__demo_alpha__lookup: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: mcp__demo_alpha__lookup -> ok
[Hook] Stop
Connected and queried.
... {"label": "alpha", "query": "needle"}
```

Compare the two `[Permission]` lines. They show where the permission design of the whole chapter lands:

| Tool | behavior | source | Why |
| --- | --- | --- | --- |
| `connect_mcp` | `allow` | `terminal-approval` | The effect is `external`, a rule matches, and the system asked a person |
| `mcp__demo_alpha__lookup` | `allow` | `default` | The local policy gives it the effect `read`, and no rule blocks it |

**The connection asks. A read does not ask.** One connection to a remote server is one external action. After the connection, one data read is not an external action. If every `lookup` needs a person to click, this Agent is unusable. If the connection does not ask either, you do not know when your process starts to talk to the outside.

Note that no newline follows the `y`. The `[Permission]` text follows `[y/N] ` directly. This is normal terminal readline behavior. The output is not corrupt.

### Step 7: Confirm That the System Really Cleaned Up the Child Process

After the run, check whether a demo server remains:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime
```

In the normal case, you should not see a demo process that is still running. The chain is `runner.close()` → `resources` in reverse order → `mcpRuntime.close()` → `close()` on each connection. Step [6] of experiment 9 verified this chain.

---

## Common Error Troubleshooting Table

The table is in the order in which you will meet the errors:

| Error | Where It Appears | Cause | What to Do |
| --- | --- | --- | --- |
| `Runtime Failure: workspace is not a Git repository root` | At startup | The cwd is not a Git repository root (the P18 worktree requirement, inherited) | Run in a directory where you ran `git init` |
| `Configuration Error: Missing required settings: ...` | At startup | The `.env` file in the cwd lacks a key | Add the listed keys. P19 also needs `OPENAI_FALLBACK_MODEL` |
| `No interactive input, rejecting by default.` | The first `connect_mcp` | stdin is not a TTY | Run in a real terminal. Do not attach a pipe |
| `Unknown MCP server alias: xxx` | `connect_mcp` | The alias is not in the local allowlist | This chapter builds in only `demo_alpha` / `demo_beta`. To add an alias, change `createMcpRuntime()` |
| `MCP server alias is already connected: xxx` | `connect_mcp` | This alias is already connected | Run `disconnect_mcp` first, or use the existing tools directly |
| `MCP published tools do not exactly match local policy: xxx` | `connect_mcp` | The set of tool names that the remote declares is **not exactly equal** to the local policy | Make the two lists match. A "take the intersection" fix does not pass |
| `MCP tool input schema is invalid: xxx` | `connect_mcp` | The top level is not `object` / the schema contains an external `$ref` / compilation fails in strict mode | Fix the remote schema. The local side does no compatibility handling |
| `MCP exposed tool name exceeds 64 characters: xxx` | `connect_mcp` | `mcp__{alias}__{name}` exceeds 64 | Shorten the alias or the remote tool name |
| `MCP tool names collide after normalization: xxx` | `connect_mcp` | Two remote names collide after normalization | Change a remote tool name. The system rejects the whole connection |
| `MCP connection validation failed and cleanup is pending: xxx` | `connect_mcp` | Validation failed, **and** the child process does not close | Check for remaining node processes. This error code exists specifically to signal "something leaked" |
| `Unknown tool: mcp__xxx__yyy` | Tool call | The model called the tool in the same turn in which it connected (snapshot boundary) | Let the model call the tool in the next turn, or state the two steps clearly in the prompt |
| `mcp_timeout` | Tool call | The call exceeds `toolTimeoutSeconds` | The system discards the connection. Connect again. To increase the timeout, change the spec |
| `mcp_connection_lost` | Tool call | The child process died / the transport broke | The system discards the connection. Connect again |
| `mcp_remote_error` | Tool call | The remote itself reports `isError: true` | **The connection is still alive.** Look at the problem on the remote server. The local side cannot get the details (they are redacted) |
| `MCP runtime is already installed` | At startup | One `McpRuntime` was installed into two registries | The composition root is wrong. One runtime can bind to only one registry |
| `mcpRuntime is required for chapter 19 or later` | At startup | The profile declares `mcp` but no runtime was passed | Check the dependencies of `buildAgent` |
| `mcpRuntime requires chapter 19 or later` | At startup | An `mcpRuntime` was passed to P18 or below | Switch to P19, or do not pass it |

---

## 10 Hands-On Experiments

You do not need to trust any conclusion from the earlier sections on my word. This section guides you to build a probe script and run each conclusion to see it.

**No experiment needs an API key**, because the experiments call the library directly and do not go through a real model. Experiments 1 and 8 really start the `demo.ts` child process. The other experiments use a programmable fake connection.

### Preparation: Build a Probe Script First

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType File -Path scripts\probe-ch19.mts -Force
```

`scripts/` is not in the `include` of `tsconfig.json`, so this script does not affect `npm run typecheck`. Delete the script after you run it.

Write the common header first. Paste it in five parts. The first part is the imports:

```typescript
// scripts/probe-ch19.mts —— Chapter 19 probe script (temporary; you can delete it after the run)
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonBackgroundJobStore } from "../chapters/ch19/src/adapters/background-json.js";
import { JsonCronStore } from "../chapters/ch19/src/adapters/cron-json.js";
import { FileMailboxStore } from "../chapters/ch19/src/adapters/mailbox-json.js";
import { StdioMcpConnectionFactory } from "../chapters/ch19/src/adapters/mcp-client.js";
import { AjvMcpSchemaValidator } from "../chapters/ch19/src/adapters/mcp-schema.js";
import { JsonProtocolStore } from "../chapters/ch19/src/adapters/protocol-json.js";
import { SqliteTaskStore } from "../chapters/ch19/src/adapters/task-sqlite.js";
import { buildAgent } from "../chapters/ch19/src/bootstrap.js";
import type { BuildDependencies } from "../chapters/ch19/src/bootstrap.js";
import { EventInbox } from "../chapters/ch19/src/core/events.js";
import { AgentRunner } from "../chapters/ch19/src/core/loop.js";
import { assistantMessage, toolCall } from "../chapters/ch19/src/core/messages.js";
import type { ChatMessage, ToolCall } from "../chapters/ch19/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch19/src/core/model.js";
import { PermissionDecision } from "../chapters/ch19/src/core/permissions.js";
import type {
  ApprovalProvider,
  AuditSink,
  PermissionRequest,
} from "../chapters/ch19/src/core/permissions.js";
import { P19 } from "../chapters/ch19/src/core/profiles.js";
import { ToolRegistry, toolSuccess } from "../chapters/ch19/src/core/tools.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../chapters/ch19/src/core/tools.js";
```

```typescript
import { JobSupervisor } from "../chapters/ch19/src/features/background.js";
import { CronRuntime } from "../chapters/ch19/src/features/cron.js";
import {
  McpCallResult,
  McpPublishedTool,
  McpRuntime,
  McpServerSpec,
  McpToolPolicy,
} from "../chapters/ch19/src/features/mcp-tools.js";
import type {
  McpConnection,
  McpConnectionFactory,
} from "../chapters/ch19/src/features/mcp-tools.js";
import { ProtocolRuntime } from "../chapters/ch19/src/features/protocol.js";
import { RecoveryConfig } from "../chapters/ch19/src/features/recovery.js";
import { TeammateRuntime } from "../chapters/ch19/src/features/teammates.js";
import { WorkStealingRuntime } from "../chapters/ch19/src/features/work-stealing.js";
import { WorktreeRuntime } from "../chapters/ch19/src/features/worktrees.js";
```

The second part is the common constants and small utilities:

```typescript
const require = createRequire(import.meta.url);
const EXPERIMENT = process.argv[2] ?? "all";
const demoScript = fileURLToPath(
  new URL("../chapters/ch19/src/mcp-servers/demo.ts", import.meta.url),
);
const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
const context: ToolContext = Object.freeze({ workspace: process.cwd(), identity: "lead" });

function section(name: string): boolean {
  const selected = EXPERIMENT === "all" || EXPERIMENT === name;
  if (selected) console.log(`\n===== ${name} =====`);
  return selected;
}

function step(index: number, text: string): void {
  console.log(`[${index}] ${text}`);
}

async function withTempDir<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "probe-ch19-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
```

The third part is the assembly functions for the two runtimes, and a call helper that goes through the full tool boundary:

```typescript
/** Local allowlist: two aliases start the same demo.ts. Only --label differs. */
function demoSpec(alias: string, label: string, toolTimeoutSeconds = 2): McpServerSpec {
  return new McpServerSpec({
    alias,
    command: process.execPath,
    args: [tsxCli, demoScript, "--label", label],
    toolPolicies: [
      new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
      new McpToolPolicy({ remoteName: "fail", effect: "read" }),
      new McpToolPolicy({ remoteName: "delay", effect: "read" }),
      new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
    ],
    startupTimeoutSeconds: 5,
    toolTimeoutSeconds,
  });
}

/** Real stdio runtime: install the allowlist, the official SDK adapter and the Ajv validator into McpRuntime. */
function stdioRuntime(...specs: readonly McpServerSpec[]): McpRuntime {
  return new McpRuntime({
    servers: specs,
    connectionFactory: new StdioMcpConnectionFactory(),
    schemaValidator: new AjvMcpSchemaValidator(),
  });
}

/** Call directly through the tool boundary: prepare does JSON parsing and schema validation, and invoke executes the handler. */
async function invoke(
  registry: ToolRegistry,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<ToolResult> {
  const call: ToolCall = toolCall(`call-${name}`, name, JSON.stringify(argumentsValue));
  return await registry.invoke(registry.prepare(call), context);
}

function mcpNames(registry: ToolRegistry): readonly string[] {
  return registry.names.filter((name) => name.startsWith("mcp__"));
}

function resultLine(result: ToolResult): string {
  return result.isError ? `Error code=${String(result.errorCode)}` : `Success ${result.content}`;
}
```

`invoke` deliberately uses the two steps `prepare` + `invoke`. This path is exactly the same as the path in a real turn. Argument validation happens in `prepare`, so you can observe "a bad argument does not go out to the network".

The fourth part is the fake connection. With it, you can construct the return content of `tools/list` precisely. You can also test errors that a real server never makes:

```typescript
/** Programmable fake connection: does not start a child process. Use it to construct the return content of tools/list precisely. */
class FakeConnection implements McpConnection {
  readonly #published: readonly McpPublishedTool[];
  closeCalls = 0;
  callCalls = 0;
  #resolveFailure: () => void = () => {};
  readonly #failure = new Promise<void>((resolve) => {
    this.#resolveFailure = resolve;
  });

  constructor(published: readonly McpPublishedTool[]) {
    this.#published = published;
  }

  async listTools(): Promise<readonly McpPublishedTool[]> {
    return this.#published;
  }

  async callTool(): Promise<McpCallResult> {
    this.callCalls += 1;
    return new McpCallResult({ content: [], structuredContent: {}, isError: false });
  }

  waitForFailure(): Promise<void> {
    return this.#failure;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#resolveFailure();
  }

  /** Simulate transport termination: settle waitForFailure and trigger the connection-level Watchdog. */
  failTransport(): void {
    this.#resolveFailure();
  }
}

class FakeFactory implements McpConnectionFactory {
  openCalls = 0;
  readonly #connection: FakeConnection;

  constructor(connection: FakeConnection) {
    this.#connection = connection;
  }

  async open(): Promise<McpConnection> {
    this.openCalls += 1;
    return this.#connection;
  }
}
```

```typescript
/** Assemble a runtime with a fake connection: the alias is fixed as fake, and the caller declares the policy. */
function fakeRuntime(
  connection: FakeConnection,
  toolPolicies: readonly McpToolPolicy[],
  factory: McpConnectionFactory = new FakeFactory(connection),
): McpRuntime {
  return new McpRuntime({
    servers: [
      new McpServerSpec({
        alias: "fake",
        command: "unused",
        args: [],
        toolPolicies,
        startupTimeoutSeconds: 1,
        toolTimeoutSeconds: 1,
      }),
    ],
    connectionFactory: factory,
    schemaValidator: new AjvMcpSchemaValidator(),
  });
}
```

`command: "unused"` shows the point of the fake connection: `FakeFactory.open()` does not look at the spec at all, so it does not really start a process.

The fifth part is three fake models and an approval recorder:

```typescript
/** Replay model replies from a script, and record the tool names that each request saw. */
class ScriptedModel implements ModelClient {
  readonly toolNames: string[][] = [];
  readonly systemPrompts: string[] = [];
  #index = 0;

  constructor(private readonly replies: readonly ModelReply[]) {}

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.toolNames.push(request.tools.map((tool) => tool.function.name));
    const system = request.messages.find((message: ChatMessage) => message.role === "system");
    this.systemPrompts.push(system?.content ?? "");
    const reply = this.replies[this.#index];
    this.#index += 1;
    return reply ?? { message: assistantMessage("done"), finishReason: "stop" };
  }
}
```

`toolNames` is the key: it records **the tool surface that every model request saw**. Experiment 2 depends entirely on it.

```typescript
/** The Lead connects, then a Subagent and a Teammate each run one turn. Use it to observe the tool surface on three sides. */
class ScopedModel implements ModelClient {
  readonly leadTools: string[][] = [];
  readonly childTools: { readonly who: string; readonly names: readonly string[] }[] = [];

  async complete(request: ModelRequest): Promise<ModelReply> {
    const names = request.tools.map((tool) => tool.function.name);
    const system = request.messages.find((message: ChatMessage) => message.role === "system");
    const prompt = system?.content ?? "";
    if (prompt.includes("focused coding subagent")) {
      this.childTools.push({ who: "Subagent", names });
      return { message: assistantMessage("subagent done"), finishReason: "stop" };
    }
    if (prompt.includes("You are alice, serving as worker.")) {
      this.childTools.push({ who: "Teammate", names });
      return { message: assistantMessage("teammate done"), finishReason: "stop" };
    }
    this.leadTools.push(names);
    const hasToolResult = request.messages.some((message: ChatMessage) => message.role === "tool");
    if (!hasToolResult) {
      return {
        message: assistantMessage(null, [
          toolCall("subagent", "task", '{"description":"inspect the child scope"}'),
          toolCall(
            "teammate",
            "spawn_teammate",
            '{"name":"alice","role":"worker","prompt":"inspect the teammate scope"}',
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("lead done"), finishReason: "stop" };
  }
}
```

This model uses a feature string in the system prompt to tell who it is now. The Lead, a Subagent and a Teammate share the same `complete`, but they get different system prompts. Experiment 10 uses it to observe the tool surface on three sides at the same time.

```typescript
/** Record which tools it was asked about, and allow only calls in allowedNames. */
class RecordingApproval implements ApprovalProvider {
  readonly asked: string[] = [];
  readonly #allowed: ReadonlySet<string>;

  constructor(...allowedNames: readonly string[]) {
    this.#allowed = new Set(allowedNames);
  }

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const name = request.prepared.call.name;
    this.asked.push(name);
    return this.#allowed.has(name)
      ? new PermissionDecision("allow", "approved by probe", "probe")
      : new PermissionDecision("deny", "denied by probe", "probe");
  }
}

class SilentAudit implements AuditSink {
  async record(): Promise<void> {}
}
```

The last part is the dependency assembly for the composition root. P19 inherits all capabilities of P18, so `buildAgent` needs many dependencies. Assemble them all here, once:

```typescript
/** The P19 composition root needs all P18 dependencies. Assemble the smallest runnable set here, once. */
async function makeDeps(
  root: string,
  model: ModelClient,
  mcpRuntime: McpRuntime,
  approvalProvider: ApprovalProvider = new RecordingApproval("connect_mcp", "disconnect_mcp"),
): Promise<{ deps: BuildDependencies; close: () => Promise<void> }> {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root),
    inbox,
    supervisor,
    clock: { now: () => new Date("2026-08-30T00:00:00.000Z") },
  });
  const teammates = new TeammateRuntime({
    store: new FileMailboxStore(root),
    inbox,
    supervisor,
    cronRuntime: cron,
  });
  const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
  const store = new SqliteTaskStore(root);
  // gitRunner uses a fake implementation: this script does not verify Git behavior. It only needs the P18 dependencies to be complete.
  const worktrees = new WorktreeRuntime({
    workspace: root,
    store,
    gitRunner: { run: async () => ({ returncode: 0, stdout: "", stderr: "" }) },
  });
  const deps: BuildDependencies = {
    model,
    workspace: root,
    recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
    approvalProvider,
    auditSink: new SilentAudit(),
    backgroundSupervisor: supervisor,
    cronRuntime: cron,
    teammateRuntime: teammates,
    protocolRuntime: protocol,
    workStealingRuntime: new WorkStealingRuntime({ store, claimService: worktrees }),
    worktreeRuntime: worktrees,
    mcpRuntime,
  };
  return {
    deps,
    close: async () => {
      await teammates.close();
      await cron.close();
      await supervisor.close();
    },
  };
}
```

The clock is fixed to a constant, and `gitRunner` uses a fake implementation. These two choices make the experiment output reproducible.

How to run: `npx tsx scripts\probe-ch19.mts <experiment name>`. With no argument, the script runs all experiments.
### Experiment 1 (trace): The Complete Lifecycle of Two Real stdio Servers

This experiment really starts two `demo.ts` child processes. The output is the trace at the start of this chapter.

```typescript
// ---------- Experiment 1 (trace): the complete lifecycle of two real stdio servers ----------
if (section("trace")) {
  const registry = new ToolRegistry();
  const runtime = stdioRuntime(demoSpec("demo_alpha", "alpha"), demoSpec("demo_beta", "beta"));
  runtime.install(registry);
  try {
    step(1, `After install, Lead has only: ${registry.names.join(" ")} (registry v${registry.version})`);
    step(2, `Aliases connectable in the allowlist: ${runtime.serverAliases.join(" ")}`);
    const alpha = await invoke(registry, "connect_mcp", { alias: "demo_alpha" });
    step(3, `connect demo_alpha → ${resultLine(alpha)}`);
    const beta = await invoke(registry, "connect_mcp", { alias: "demo_beta" });
    step(4, `connect demo_beta → ${resultLine(beta)}`);
    step(5, `Dynamic tools now total ${mcpNames(registry).length} (registry v${registry.version}):`);
    for (const name of mcpNames(registry)) console.log(`      ${name}`);
    const alphaLookup = await invoke(registry, "mcp__demo_alpha__lookup", { query: "needle" });
    const betaLookup = await invoke(registry, "mcp__demo_beta__lookup", { query: "needle" });
    step(6, `alpha lookup → ${alphaLookup.content}`);
    step(7, `beta  lookup → ${betaLookup.content}`);
    const off = await invoke(registry, "disconnect_mcp", { alias: "demo_alpha" });
    step(8, `disconnect demo_alpha → ${resultLine(off)}`);
    step(9, `Remaining dynamic tools: ${mcpNames(registry).join(" ")}`);
    step(10, `Aliases still connected: ${runtime.connectedAliases.join(" ")} (registry v${registry.version})`);
  } finally {
    await runtime.close();
  }
  step(11, `After runtime.close(), isClosed=${String(runtime.isClosed)}, registry=${registry.names.join(" ")}`);
}
```

See the output in the opening section, "Look at a Complete Connection Trace First". Confirm three things in particular: the version trace `registry v1 → v3 → v4`, alpha and beta each return their own `label`, and after `close()` the registry returns to the two starting tools.

### Experiment 2 (snapshot): The Same Turn's Reply Cannot See the Tool That Was Just Connected

```typescript
// ---------- Experiment 2 (snapshot): the same turn's reply cannot see the tool that was just connected ----------
if (section("snapshot")) {
  const registry = new ToolRegistry();
  const runtime = stdioRuntime(demoSpec("demo_alpha", "alpha"));
  runtime.install(registry);
  const model = new ScriptedModel([
    {
      message: assistantMessage(null, [
        toolCall("c1", "connect_mcp", '{"alias":"demo_alpha"}'),
        toolCall("c2", "mcp__demo_alpha__lookup", '{"query":"needle"}'),
      ]),
      finishReason: "tool_calls",
    },
    {
      message: assistantMessage(null, [
        toolCall("c3", "mcp__demo_alpha__lookup", '{"query":"needle"}'),
      ]),
      finishReason: "tool_calls",
    },
    { message: assistantMessage("done"), finishReason: "stop" },
  ]);
  const runner = new AgentRunner({
    model,
    tools: registry,
    systemPrompt: "system",
    workspace: process.cwd(),
  });
  try {
    const result = await runner.run("connect then call");
    step(1, `Tool surface of request 1: ${(model.toolNames[0] ?? []).join(" ")}`);
    step(2, `Tool surface of request 2: ${(model.toolNames[1] ?? []).join(" ")}`);
    step(3, `Tool surface of request 3: ${(model.toolNames[2] ?? []).join(" ")}`);
    step(4, `Final answer: ${String(result.finalText)}`);
    const toolResult = (id: string): string =>
      result.history.find((message) => message.role === "tool" && message.toolCallId === id)
        ?.content ?? "(none)";
    step(5, `Result of the call that jumped ahead in the same turn: ${toolResult("c2")}`);
    step(6, `Result of the same-name call in the next turn: ${toolResult("c3")}`);
  } finally {
    await runner.close();
    await runtime.close();
  }
}
```

`c1` and `c2` are in the **same** assistant message. `c3` is in the next one. Output:

```text
===== snapshot =====
[1] Tool surface of request 1: connect_mcp disconnect_mcp
[2] Tool surface of request 2: connect_mcp disconnect_mcp mcp__demo_alpha__lookup mcp__demo_alpha__fail mcp__demo_alpha__delay mcp__demo_alpha__terminate
[3] Tool surface of request 3: (same as request 2)
[4] Final answer: done
[5] Result of the call that jumped ahead in the same turn: Error [unknown_tool]: Unknown tool: mcp__demo_alpha__lookup
[6] Result of the same-name call in the next turn: {"content":[{"type":"text","text":"{\"label\":\"alpha\",\"query\":\"needle\"}"}],"server_alias":"demo_alpha","status":"ok","structured_content":{"label":"alpha","query":"needle"},"tool":"lookup"}
```

`c2` gets `unknown_tool`. `c3` succeeds. This is not a bug. It is the definition of the snapshot boundary. See "Why New Tools Are Visible Only in the Next Turn" for the details.

### Experiment 3 (atomic): Batch Registration and Unregistration Are Both Atomic Version Migrations

```typescript
// ---------- Experiment 3 (atomic): batch registration and unregistration are both atomic version migrations ----------
if (section("atomic")) {
  const emptyObject = (await import("zod")).z.strictObject({});
  const make = (name: string): ToolDefinition<Record<string, never>> => ({
    name,
    description: `Run ${name}.`,
    inputSchema: emptyObject,
    effect: "read",
    source: "probe",
    handler: () => toolSuccess(name),
  });
  const registry = new ToolRegistry();
  const first = registry.register(make("first"));
  const snapshot = registry.snapshot();
  step(1, `After registering first, live v${registry.version}, snapshot v${snapshot.version}`);
  registry.registerMany([make("second"), make("third")]);
  step(2, `Then batch-register 2 more → live v${registry.version}, names ${registry.names.join(" ")}`);
  step(3, `The snapshot is still ${snapshot.names.join(" ")} (v${snapshot.version})`);
  try {
    registry.registerMany([make("fourth"), make("second")]);
  } catch (error) {
    step(4, `The batch contains an already registered name → ${(error as Error).message}`);
  }
  step(5, `After the failure the list is unchanged: ${registry.names.join(" ")}, version is still v${registry.version}`);
  const foreign = new ToolRegistry().register(make("second"));
  try {
    registry.unregisterMany([foreign]);
  } catch (error) {
    step(6, `Unregister with a same-name definition from another registry → ${(error as Error).message}`);
  }
  try {
    snapshot.register(make("late"));
  } catch (error) {
    step(7, `Register into a snapshot → ${(error as Error).message}`);
  }
  registry.unregisterMany([first]);
  step(8, `Unregister first → live v${registry.version}, names ${registry.names.join(" ")}`);
}
```

Note the batch in step 4: `[fourth, second]`. `fourth` is new (valid). `second` is already registered (invalid). The valid one comes first. So if the implementation validated and wrote at the same time, `fourth` would be written in. Output:

```text
===== atomic =====
[1] After registering first, live v1, snapshot v1
[2] Then batch-register 2 more → live v2, names first second third
[3] The snapshot is still first (v1)
[4] The batch contains an already registered name → tool already registered: second
[5] After the failure the list is unchanged: first second third, version is still v2
[6] Unregister with a same-name definition from another registry → tool definition does not match registry: second
[7] Register into a snapshot → tool registry snapshot is immutable
[8] Unregister first → live v3, names second third
```

Step 5 is the point of this experiment: the list does **not** contain `fourth`. The whole batch fails. Not one tool gets in.

The `foreign` value in step 6 is a same-name definition that another registry registered. The unregistration is rejected because the object identity does not match.

### Experiment 4 (policy): The Published Set Must Exactly Equal the Local Policy

```typescript
// ---------- Experiment 4 (policy): the Published set must exactly equal the local policy ----------
if (section("policy")) {
  const cases = [
    {
      title: "The server publishes one extra unreviewed tool",
      published: [
        new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } }),
        new McpPublishedTool({ name: "deploy", inputSchema: { type: "object" } }),
      ],
      policies: [new McpToolPolicy({ remoteName: "lookup", effect: "read" })],
    },
    {
      title: "The server does not publish one locally expected tool",
      published: [new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } })],
      policies: [
        new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
        new McpToolPolicy({ remoteName: "audit", effect: "read" }),
      ],
    },
    {
      title: "Both sides exactly equal",
      published: [new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } })],
      policies: [new McpToolPolicy({ remoteName: "lookup", effect: "read" })],
    },
  ] as const;
  let index = 0;
  for (const item of cases) {
    index += 1;
    const connection = new FakeConnection(item.published);
    const runtime = fakeRuntime(connection, item.policies);
    const registry = new ToolRegistry();
    runtime.install(registry);
    const result = await invoke(registry, "connect_mcp", { alias: "fake" });
    step(
      index,
      `${item.title} → ${resultLine(result)}; dynamic tools=${mcpNames(registry).length}, close count=${connection.closeCalls}`,
    );
    await runtime.close();
  }
}
```

The output of the three cases is in the section "A Remote Description Cannot Grant Permission". The core point is this: one extra tool and one missing tool **both fail**. And on failure, `close count=1` (the child process was cleaned up). **The system does not take the intersection and keep running.**

### Experiment 5 (effect): A Remote Description Cannot Change the Local effect

```typescript
// ---------- Experiment 5 (effect): a remote description cannot change the local effect ----------
if (section("effect")) {
  const connection = new FakeConnection([
    new McpPublishedTool({
      name: "deploy",
      description: "(readOnly) Deploy the current build.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  ]);
  const runtime = fakeRuntime(connection, [
    new McpToolPolicy({ remoteName: "deploy", effect: "external" }),
  ]);
  const registry = new ToolRegistry();
  runtime.install(registry);
  await invoke(registry, "connect_mcp", { alias: "fake" });
  const prepared = registry.prepare(toolCall("probe", "mcp__fake__deploy", "{}"));
  step(1, `Remote description: ${String(prepared.definition?.description)}`);
  step(2, `Local effect: ${String(prepared.definition?.effect)}`);
  step(3, `Local source: ${String(prepared.definition?.source)}`);
  step(4, "Permission rules read only source + effect, not description");
  await runtime.close();
}
```

This case is a deliberately built attack scenario. The remote tool is named `deploy` (clearly a write operation), but its description starts with `(readOnly)`. The local policy gives `external`. See the output in the section "A Remote Description Cannot Grant Permission". The `effect` is still `external`.

### Experiment 6 (schema): The Schema Is an Execution Boundary

```typescript
// ---------- Experiment 6 (schema): the schema is an execution boundary ----------
if (section("schema")) {
  const cases = [
    {
      title: "Invalid type",
      published: [
        new McpPublishedTool({
          name: "broken",
          inputSchema: { type: "object", properties: { value: { type: "not-a-type" } } },
        }),
      ],
      policies: [new McpToolPolicy({ remoteName: "broken", effect: "read" })],
    },
    {
      title: "External $ref",
      published: [
        new McpPublishedTool({
          name: "external_ref",
          inputSchema: {
            type: "object",
            properties: { value: { $ref: "https://example.test/schema" } },
          },
        }),
      ],
      policies: [new McpToolPolicy({ remoteName: "external_ref", effect: "read" })],
    },
    {
      title: "Top level is not an object",
      published: [new McpPublishedTool({ name: "array_root", inputSchema: { type: "array" } })],
      policies: [new McpToolPolicy({ remoteName: "array_root", effect: "read" })],
    },
  ] as const;
  let index = 0;
  for (const item of cases) {
    index += 1;
    const connection = new FakeConnection(item.published);
    const runtime = fakeRuntime(connection, item.policies);
    const registry = new ToolRegistry();
    runtime.install(registry);
    const result = await invoke(registry, "connect_mcp", { alias: "fake" });
    step(index, `${item.title} → ${resultLine(result)}; dynamic tools=${mcpNames(registry).length}`);
    await runtime.close();
  }
  // Valid schema: if the arguments do not conform, the local side stops the call and the remote call count stays 0.
  const connection = new FakeConnection([
    new McpPublishedTool({
      name: "mutate",
      inputSchema: {
        type: "object",
        properties: { value: { type: "integer" } },
        required: ["value"],
        additionalProperties: false,
      },
    }),
  ]);
  const runtime = fakeRuntime(connection, [
    new McpToolPolicy({ remoteName: "mutate", effect: "read" }),
  ]);
  const registry = new ToolRegistry();
  runtime.install(registry);
  await invoke(registry, "connect_mcp", { alias: "fake" });
  const prepared = registry.prepare(toolCall("probe", "mcp__fake__mutate", '{"value":1}'));
  step(4, `Schema given to the model: ${JSON.stringify(prepared.definition?.inputSchemaJson)}`);
  step(5, `Missing required → ${resultLine(await invoke(registry, "mcp__fake__mutate", {}))}`);
  step(6, `Wrong type → ${resultLine(await invoke(registry, "mcp__fake__mutate", { value: "1" }))}`);
  step(7, `Extra field → ${resultLine(await invoke(registry, "mcp__fake__mutate", { value: 1, extra: true }))}`);
  step(8, `Remote callTool count for the three calls above: ${connection.callCalls}`);
  step(9, `Valid arguments → ${resultLine(await invoke(registry, "mcp__fake__mutate", { value: 1 }))}`);
  step(10, `Remote callTool count is now: ${connection.callCalls}`);
  await runtime.close();
}
```

See the output in the section "JSON Schema Is an Execution Boundary, Not Prompt Text". All three invalid schemas are rejected. After the three bad-argument calls, the `callTool` count is 0.

The `type: "not-a-type"` case deserves a separate note. In non-strict mode, Ajv silently accepts it, and validation then exists in name only. Only `strict: true` treats it as an error.

### Experiment 7 (name): Name Normalisation, Collisions and Built-in Tool Protection

```typescript
// ---------- Experiment 7 (name): name normalisation, collisions and built-in tool protection ----------
if (section("name")) {
  const cases = [
    {
      title: "Normalisation: case, hyphens, leading and trailing symbols",
      published: [
        new McpPublishedTool({ name: "Lookup-One", inputSchema: { type: "object" } }),
        new McpPublishedTool({ name: "__read.file__", inputSchema: { type: "object" } }),
      ],
      policies: [
        new McpToolPolicy({ remoteName: "Lookup-One", effect: "read" }),
        new McpToolPolicy({ remoteName: "__read.file__", effect: "read" }),
      ],
    },
    {
      title: "Name collision after normalisation",
      published: [
        new McpPublishedTool({ name: "lookup-one", inputSchema: { type: "object" } }),
        new McpPublishedTool({ name: "lookup_one", inputSchema: { type: "object" } }),
      ],
      policies: [
        new McpToolPolicy({ remoteName: "lookup-one", effect: "read" }),
        new McpToolPolicy({ remoteName: "lookup_one", effect: "read" }),
      ],
    },
    {
      title: "Remote name is all invalid characters",
      published: [new McpPublishedTool({ name: "***", inputSchema: { type: "object" } })],
      policies: [new McpToolPolicy({ remoteName: "***", effect: "read" })],
    },
  ] as const;
  let index = 0;
  for (const item of cases) {
    index += 1;
    const connection = new FakeConnection(item.published);
    const runtime = fakeRuntime(connection, item.policies);
    const registry = new ToolRegistry();
    runtime.install(registry);
    const result = await invoke(registry, "connect_mcp", { alias: "fake" });
    step(
      index,
      `${item.title} → ${resultLine(result)}; exposed names=${mcpNames(registry).join(" ") || "(none)"}`,
    );
    await runtime.close();
  }
  // Same name as a built-in tool: the alias prefix stops the remote read_file from replacing the local capability.
  const connection = new FakeConnection([
    new McpPublishedTool({ name: "read_file", inputSchema: { type: "object" } }),
  ]);
  const runtime = fakeRuntime(connection, [
    new McpToolPolicy({ remoteName: "read_file", effect: "read" }),
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "Builtin read_file.",
    inputSchema: (await import("zod")).z.strictObject({}),
    effect: "read",
    handler: () => toolSuccess("builtin"),
  });
  runtime.install(registry);
  await invoke(registry, "connect_mcp", { alias: "fake" });
  step(4, `Built-in read_file is still present: ${registry.names.includes("read_file")}`);
  step(5, `The remote same-name tool lands at: ${mcpNames(registry).join(" ")}`);
  step(6, `Built-in call result: ${(await invoke(registry, "read_file", {})).content}`);
  await runtime.close();
}
```

The second half is the part that deserves the most attention. The code first registers a **built-in** `read_file`. It then connects a remote server that also publishes `read_file`. See the output in the section "Name Isolation Must Complete Before Publication". The built-in tool is still present. The remote tool lands at `mcp__fake__read_file`. A call to `read_file` returns `builtin`.

**Without the prefix, what would happen here?** `registerMany` would report `tool already registered: read_file`, and the whole connection would be rejected. In other words, a remote server would only need to publish one tool with the same name as one of your built-in tools to stop you from connecting at all. With the prefix, the two coexist naturally.

### Experiment 8 (failure): Three Fault Classes, Three State Transitions

```typescript
// ---------- Experiment 8 (failure): three fault classes, three state transitions ----------
if (section("failure")) {
  const cases = [
    ["fail", {}, "Remote returns isError"],
    ["delay", { milliseconds: 300 }, "tools/call timeout"],
    ["terminate", {}, "Child process exits"],
  ] as const;
  let index = 0;
  for (const [tool, argumentsValue, title] of cases) {
    index += 1;
    const registry = new ToolRegistry();
    // Set toolTimeoutSeconds to 0.05s so delay times out reliably.
    const runtime = stdioRuntime(demoSpec("demo_alpha", "alpha", 0.05));
    runtime.install(registry);
    try {
      await invoke(registry, "connect_mcp", { alias: "demo_alpha" });
      const before = mcpNames(registry).length;
      const result = await invoke(registry, `mcp__demo_alpha__${tool}`, argumentsValue);
      step(index, `${title} → ${result.content}`);
      console.log(
        `      Dynamic tools before connection=${before}, after the call=${mcpNames(registry).length}, still connected=${runtime.connectedAliases.join(" ") || "(none)"}`,
      );
      console.log(`      Does server-private-detail appear in the result: ${result.content.includes("server-private-detail")}`);
    } finally {
      await runtime.close();
    }
  }
  // The transport drops while idle: the Watchdog unregisters all tools of that alias.
  const connection = new FakeConnection([
    new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } }),
  ]);
  const runtime = fakeRuntime(connection, [
    new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
  ]);
  const registry = new ToolRegistry();
  runtime.install(registry);
  await invoke(registry, "connect_mcp", { alias: "fake" });
  step(4, `Connection succeeded, dynamic tools=${mcpNames(registry).join(" ")}`);
  connection.failTransport();
  await new Promise((resolve) => setTimeout(resolve, 50));
  step(5, `After the transport drops, dynamic tools=${mcpNames(registry).join(" ") || "(none)"}, still connected=${runtime.connectedAliases.join(" ") || "(none)"}`);
  step(6, `Stale call → ${resultLine(await invoke(registry, "connect_mcp", { alias: "fake" }))} (reconnect is possible)`);
  await runtime.close();
}
```

`toolTimeoutSeconds` is set to 0.05 seconds and `delay` receives 300 milliseconds. This combination makes the timeout trigger reliably. It does not depend on machine speed. See the output in the section "Each Connection Has an Independent Lifecycle".

The `await new Promise(... 50)` line before step 5 is necessary. The Watchdog is asynchronous. `failTransport()` only settles the promise. The unregistration action must wait until the microtask queue has run.

### Experiment 9 (approval): Connecting and external Remote Tools Both Require Approval

This is the only failure-side experiment that goes through the full `buildAgent(P19, ...)` composition root.

```typescript
// ---------- Experiment 9 (approval): connecting and external remote tools both require approval ----------
if (section("approval")) {
  // Allow only connect_mcp. Observe that after the external remote tool is denied, the remote call count stays at zero.
  await withTempDir(async (root) => {
    const connection = new FakeConnection([
      new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } }),
      new McpPublishedTool({ name: "terminate", inputSchema: { type: "object" } }),
    ]);
    const factory = new FakeFactory(connection);
    const runtime = fakeRuntime(
      connection,
      [
        new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
        new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
      ],
      factory,
    );
    const model = new ScriptedModel([
      {
        message: assistantMessage(null, [toolCall("c1", "connect_mcp", '{"alias":"fake"}')]),
        finishReason: "tool_calls",
      },
      {
        message: assistantMessage(null, [
          toolCall("c2", "mcp__fake__lookup", "{}"),
          toolCall("c3", "mcp__fake__terminate", "{}"),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const approval = new RecordingApproval("connect_mcp");
    const { deps, close } = await makeDeps(root, model, runtime, approval);
    const runner = buildAgent(P19, deps);
    try {
      const result = await runner.run("connect then call");
      const toolResult = (id: string): string =>
        result.history.find((message) => message.role === "tool" && message.toolCallId === id)
          ?.content ?? "(none)";
      step(1, `Tools that were asked for approval: ${approval.asked.join(" ")}`);
      step(2, `The read-class remote tool was not asked and passed directly: ${toolResult("c2").slice(0, 60)}`);
      step(3, `The external remote tool was denied → ${toolResult("c3")}`);
      step(
        4,
        `The model started 2 remote calls. Remote calls that actually reached callTool: ${connection.callCalls} (the denied one never went out)`,
      );
      step(5, `factory.open count: ${factory.openCalls}`);
    } finally {
      await runner.close();
      await close();
    }
    step(6, `connection.close count after the Runner closes: ${connection.closeCalls}`);
  });
}
```

`RecordingApproval("connect_mcp")` allows only `connect_mcp`. It denies everything else. Output:

```text
===== approval =====
[1] Tools that were asked for approval: connect_mcp mcp__fake__terminate
[2] The read-class remote tool was not asked and passed directly: {"content":[],"server_alias":"fake","status":"ok","structure
[3] The external remote tool was denied → Error [permission_denied]: denied by probe
[4] The model started 2 remote calls. Remote calls that actually reached callTool: 1 (the denied one never went out)
[5] factory.open count: 1
[6] connection.close count after the Runner closes: 1
```

Read the lines one by one:

- **[1]** Only two tools are asked about: `connect_mcp` (a local management tool, effect `external`) and `mcp__fake__terminate` (a remote tool; the local policy gives it effect `external`). The rule matches on **effect**. It does not depend on whether the tool is local or remote.
- **[2]** `mcp__fake__lookup` does not enter approval at all. Its effect is `read`.
- **[3]** `terminate` is denied. The error code is `permission_denied`.
- **[4]** The model started 2 remote calls. Only 1 actually reached `callTool`. **The denied call never went out.** The permission check runs after `prepare` and before `invoke`. So the denial happens before any I/O.
- **[5][6]** One connection, one close. `runner.close()` closes the MCP connection in reverse order through `resources`. You do not need to call `mcpRuntime.close()` by hand.

### Experiment 10 (scope): MCP Belongs Only to Lead

```typescript
// ---------- Experiment 10 (scope): MCP belongs only to Lead ----------
if (section("scope")) {
  await withTempDir(async (root) => {
    const connection = new FakeConnection([
      new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } }),
    ]);
    const runtime = fakeRuntime(connection, [
      new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
    ]);
    const model = new ScopedModel();
    const { deps, close } = await makeDeps(root, model, runtime);
    const runner = buildAgent(P19, deps);
    try {
      const result = await runner.run("exercise child scopes");
      // Wait until the Teammate turn really sends its request.
      const deadline = Date.now() + 8000;
      while (model.childTools.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const leadNames = model.leadTools[0] ?? [];
      step(1, `Lead tool count=${leadNames.length}, includes connect_mcp=${leadNames.includes("connect_mcp")}`);
      step(2, `Lead final answer: ${String(result.finalText)}`);
      for (const child of model.childTools) {
        const mcp = child.names.filter(
          (name) => name.startsWith("mcp__") || name === "connect_mcp" || name === "disconnect_mcp",
        );
        step(
          child.who === "Subagent" ? 3 : 4,
          `${child.who} tool count=${child.names.length}, MCP-related among them=${mcp.length === 0 ? "0 (cannot see them)" : mcp.join(" ")}`,
        );
      }
    } finally {
      await runner.close();
      await close();
    }
  });
}
```

Lead starts `task` (which starts a Subagent) and `spawn_teammate` (which starts a Teammate) in one go. `ScopedModel` records the tool surfaces of all three sides. See the output in the section "MCP Tools Belong Only to Lead".

That `while` polling loop waits until the Teammate really sends its request. The Teammate starts asynchronously. When Lead's `run()` returns, the Teammate may not yet have reached `complete()`.

### Cleanup After the Experiments

```powershell
Remove-Item 'F:\笔记\Agent实操\code\scripts\probe-ch19.mts'
```

The temporary directories in the experiments are deleted automatically by the `finally` block of `withTempDir`. You do not need to clean them by hand. The `demo.ts` child processes that experiments 1 and 8 start are also reclaimed by `runtime.close()`. After the run, you can use `Get-Process node` to confirm that no process remains.

---
## What This Chapter Deliberately Did Not Do

Not building a feature often needs more explanation than building it. Chapter 19 explicitly excludes the items below:

| Not done | Why |
| --- | --- |
| In-process mock `MCPClient` or a handler-dictionary compatibility layer | That is not MCP. See "An in-process handler is not MCP" |
| Model-controlled command / args / cwd | That gives the model arbitrary code execution. Configuration comes only from the local allowlist |
| HTTP / SSE / WebSocket transport | This chapter implements stdio only. Each extra transport adds a new set of timeout, reconnect and authentication semantics |
| OAuth, token refresh, remote authentication | Credential management is a separate topic. Mixing it in hides the dynamic tool pool topic |
| Server push, resources, prompts, sampling | This chapter implements only the tool primitive. The other capabilities enter the model context outside the local permission boundary |
| Inferring permission from a remote description / annotation | Remote text is data. See Experiment 5 |
| Automatic repair of name collisions | Silent renaming makes "which tool did you actually call" unknowable. A collision rejects the whole connection |
| Automatic acceptance of unconfigured remote tools | The sets must be exactly equal. See Experiment 4 |
| External HTTP / file JSON Schema references | One schema can become an entry point for arbitrary network or file access |
| Automatic retry, silent reconnect, migration of a call across connections | A failure must stay visible to the model. A silent retry makes the number of side effects unknowable |
| Propagation of a connection to a Subagent / Teammate | See "MCP tools belong to the Lead only" |
| Calling the stdio child process a security sandbox | It is not a sandbox. A child process has the same local permission as you |

The last item needs special emphasis. `connect_mcp` starts a local process **with the same permission as your Agent**. The allowlist limits "which commands can start". The allowlist does not limit "what the process can do after it starts". Real isolation needs a container or a dedicated sandbox mechanism. That topic is outside the scope of this chapter.

One more item is not "not done". It is "cannot be done": this chapter does not promise exactly-once for a remote side effect. `mcp_timeout` means you do not know whether the other side has already completed the execution. Revoking the connection guarantees clean local state only. Revoking the connection does not guarantee that nothing happened on the remote side. For this reason, after a timeout, the model must see the error. The system must not retry silently.

---

## Differences from Claude Code

Reference sources: `s19_mcp_plugin/README.md` in the external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code), the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) and the [MCP specification](https://modelcontextprotocol.io/).

### Where We Simplified

| Dimension | Claude Code | This chapter |
| --- | --- | --- |
| transport | 6 types (stdio / SSE / HTTP / WebSocket / sse-ide / sdk), local batch concurrency 3, remote batch concurrency 20 | stdio only, no concurrent batch control |
| Configuration source | Multi-layer merge: connector < plugin < user settings.json < approved project `.mcp.json` < `settings.local.json`; when an enterprise `managed-mcp.json` exists, the system excludes the other sources | Fixed local allowlist, no merge |
| Tool pool assembly | `assembleToolPool()` uses `uniqBy([...builtInTools.sort(byName), ...filteredMcpTools.sort(byName)], "name")`. Built-in tools take priority. The system sorts the two classes separately to protect cache breakpoints | Tool Registry version + Snapshot; immutable inside a request, with no dependence on global sort order |
| Authentication | OAuth + PKCE + automatic token refresh; a 401 triggers re-authentication | None |
| Error recovery | Fine-grained error classification; the system closes reconnection after 3 consecutive terminal errors; on a stdio disconnect, the system kills the process in the order SIGINT → SIGTERM → SIGKILL | Startup / call timeout + atomic revocation on failure + unified shutdown by the Runner, no reconnect |
| Timeout | Configurable, default about 28 hours | Each spec explicitly declares `startupTimeoutSeconds` / `toolTimeoutSeconds` |
| Reverse notification | Supports Channel. A server can push through `notifications/claude/channel` | None |
| Sub-executors | MCP tools are available to the main Agent and to subagents. A subagent inherits the parent configuration | Lead-only, no inheritance |

### Where We Are Stricter Than the Teaching Version

**The tool name sets must be exactly equal.** Claude Code allows the remote tool set to differ from the local configuration. This chapter requires the published set and the policy set to be **completely identical**. One extra tool or one missing tool rejects the whole connection. See Experiment 4 for the reason: this is the only way to make "the remote side changed" visible at once.

**A remote annotation takes no part in the permission decision.** An MCP tool in Claude Code can declare a permission requirement such as `readOnly` / `destructive`, and that declaration takes part in the check. This chapter states clearly that `McpToolPolicy.effect` is the only source of truth. A remote `(readOnly)` annotation cannot downgrade a local `external` effect.

**The system does not repair a name collision automatically.** If two names collide after normalization, the system rejects the whole connection. The system adds no suffix and renames nothing.

**The system rejects every external schema reference.** The system checks all three reference keywords (`$ref` / `$dynamicRef` / `$recursiveRef`). The system allows only an in-document fragment that starts with `#`.

**Ajv is strict in every case.** All three dialects use `strict: true`. A misspelled keyword raises an error. The system does not ignore the keyword.

---

## Comparison with Chapter 4 of ai-agent-book

This section compares Chapter 4 of ai-agent-book and its two companion experiments: `chapter4/active-tool-discovery` and `chapter4/active-tool-selection`. That repository is an external repository. It is not inside this tutorial directory.

### What It Says

Chapter 4 groups MCP into three classes of primitive: **tools** (executable operations), **resources** (data that an application can read) and **prompts** (templates that a user can select). This chapter implements only the tool class.

Chapter 4 also stresses a distinction that is easy to merge: **whether the system uses MCP as the interoperability protocol, and whether the system exposes all MCP tool definitions at session start, are two independent decisions.**

The companion experiments give cost data:

| Experiment | Configuration | Result |
| --- | --- | --- |
| `active-tool-selection` (offline benchmark) | 35 tools, full injection | 3,857 schema tokens |
| | 35 tools, `retrieval` top-5 | 551 tokens, recall 100% |
| | 200 tools, full injection | 20,258 tokens |
| | 200 tools, `retrieval` top-5 | About 540 tokens |
| `active-tool-discovery` (real verification with qwen3:4b) | 126 tools, control group with full injection | System prompt 50,352 tokens per task; total time 2,590.820s |
| | 126 tools, experiment group with dynamic injection | Initial 1,251 tokens, dynamic injection for three tasks 12,838 tokens in total; total time 808.926s (about 3.20 times faster) |
| | Completion rate for both groups | Both 3/3, accuracy 100% for both |

The last row deserves attention: **the expected accuracy gain did not appear.** The benefit of a dynamic tool pool is mainly context cost and latency. The benefit is not "more accurate". On a strong model, the interference from unrelated tools is smaller than people imagine.

### Two Concepts That Must Stay Separate

This is the largest gain I took from reading Chapter 4:

```text
Dynamic tool discovery / retrieval
  Problem it solves: which tool definitions enter the context, and at how many tokens
  The more candidates there are, the more expensive full injection becomes
  Means: embedding index, Tool Search, defer_loading
  ↓
  This chapter does not do this

Registry Snapshot
  Problem it solves: how a request stays consistent when the tool set changes during one request round
  The schema that the model sees must cover every tool call that the model sends afterwards
  Means: generate an immutable snapshot at each model request boundary
  ↓
  This chapter does this
```

The two can combine. The two **should** combine. Even if the system adds on-demand retrieval later, the system must still generate an immutable snapshot at each model request boundary. Without a snapshot, the tool list appears in the model reply and then changes dynamically before execution in the next turn. The call then loses explainability.

### Point-by-Point Comparison

| Design point in Chapter 4 | Counterpart in this chapter | Difference and boundary |
| --- | --- | --- |
| Three primitive classes: tools / resources / prompts | Implements tool only | The system does not publish resources / prompts and does not propagate them |
| On-demand retrieval of a small number of tool schemas | `connect_mcp` / `disconnect_mcp` + dynamic registration and revocation | The system does not implement an embedding index, Tool Search or `defer_loading` |
| Active discovery reduces context tokens | Before a connection, the system exposes only 2 management tools | The goal differs: this chapter focuses on lifecycle and request consistency |
| One pre-filter from the initial query | Each connection uses a fixed `tools/list` + exact policy match | The system does no candidate retrieval between model requests |
| A remote tool description is not trusted | `McpToolPolicy.effect` is the only permission source of truth | This matches the Chapter 4 security baseline, and adds exact set matching |
| The schema that the model sees must match the actual execution parameters | Ajv compilation + pass-through of `inputSchemaJson` unchanged | On a mismatch, the system refuses publication. The system does not correct the schema silently |
| Experimental evidence stays separate | `test:ch19` is an offline deterministic regression | Mechanism self-check, offline benchmark and real experiment complement each other |

Chapter 4 also states an observation that collides directly with this chapter: **retrieval pre-filtering from the initial query runs only once, so a multi-step cross-domain task can easily miss the tools that the second subtask needs.** The answer in this chapter is not cross-request retrieval. The answer is an allowlist that declares the tool set exactly, and then atomic publication by alias. When the model needs a new capability, the model calls `connect_mcp` explicitly. That costs one extra turn, but the system does not "miss" a tool.

---

## Changes from the Previous Version

| Dimension | Chapter 18 | Chapter 19 |
| --- | --- | --- |
| Tool set | Fixed at startup | The Lead can connect and disconnect on demand. The tool set changes between turns |
| External protocol | None | Official MCP SDK + stdio + `Client` |
| Server selection | Not applicable | Local allowlist alias. The model can provide only an alias |
| Permission source of truth | Local `ToolDefinition.effect` | Still the local effect. Remote text takes no part at all |
| Parameter validation | Static Zod schema | Remote JSON Schema + Ajv strict compilation |
| Name isolation | Built-in tool names are unique | `mcp__{alias}__{normalized}`, 4-step normalization + a 64-character limit |
| Registry change | Registration at startup only | Atomic batch migration with `registerMany` / `unregisterMany` + a monotonic `version` |
| Single-turn consistency | The system takes a snapshot for each request (already present in Chapter 18) | The same. No change |
| Lifecycle | The Runner closes the existing resources | The system adds an independent connection, a stdio child process, a connection-level Watchdog and a `pendingCloses` retry |
| Sub-executor tools | A trimmed fixed set | No change. No MCP inheritance |

**Key point: the single-turn consistency row did not change.** Taking one `snapshot()` for each model request is a mechanism from Chapter 18 (`loop.ts:406`, with the same comment). This chapter adds the mechanisms that let the tool set **change safely between turns**: `version`, `registerMany` / `unregisterMany`, revocation by object identity, `inputSchemaJson` and `source`.

The Task DAG, Mailbox, typed Protocol, plan gate, work stealing, Worktree, permission and Hook mechanisms have no second implementation. MCP enters the existing execution chain through the same `ToolRegistry`, the same `PermissionPolicy` and the same Agent Loop.

---

## Companion Code Index

All code for this chapter is under `code/chapters/ch19/`. The line counts help you estimate the work. In the 806-line `mcp-tools.ts`, value object definitions and error handling take more than half of the file.

**New files:**

| File | Lines | What this chapter owns in this file |
| --- | --- | --- |
| [src/features/mcp-tools.ts](code/chapters/ch19/src/features/mcp-tools.ts) | 806 | All `McpRuntime` logic: the transactional `#connect`, the reverse-order `#disconnect`, exact policy matching and schema compilation in `#publishDefinitions`, the `#watchConnection` Watchdog, the three classes of fault handling in `#invokeRemote`, object-identity protection in `#dropFailedConnection`, `exposedToolName` normalization and the sanitized `remoteError` envelope; and the four value objects `McpServerSpec` / `McpToolPolicy` / `McpPublishedTool` / `McpCallResult` |
| [src/adapters/mcp-client.ts](code/chapters/ch19/src/adapters/mcp-client.ts) | 347 | `StdioMcpConnectionFactory` / `StdioMcpConnection`: the official SDK `Client` + `StdioClientTransport`, the `#tail` serial queue, paginated `listTools`, `waitForFailure`, SDK error mapping, `stderr: "ignore"` |
| [src/adapters/mcp-schema.ts](code/chapters/ch19/src/adapters/mcp-schema.ts) | 76 | `AjvMcpSchemaValidator`: four checks + `selectAjv` selects a dialect by `$schema` + `requireLocalReferences` |
| [src/mcp-servers/demo.ts](code/chapters/ch19/src/mcp-servers/demo.ts) | 63 | Demo server. Four tools map to four deterministic behaviors |
| [src/chapters/ch19.ts](code/chapters/ch19/src/chapters/ch19.ts) | 5 | Fixed chapter entry point |

**Files with key changes in this chapter:**

| File | Lines | What this chapter changed |
| --- | --- | --- |
| [src/core/tools.ts](code/chapters/ch19/src/core/tools.ts) | 380 | Added `version`, `registerMany`, `unregisterMany`, identity revocation in `#sourceDefinitions`, `inputSchemaJson` and `source`; `openAITools()` prefers `inputSchemaJson` |
| [src/bootstrap.ts](code/chapters/ch19/src/bootstrap.ts) | 501 | A pair of bidirectional mcp guards (115-120), Lead-only `install` (353-357), `resources` now includes mcpRuntime (381-387), the `mcp-external-approval` rule (481-494) |
| [src/cli.ts](code/chapters/ch19/src/cli.ts) | 412 | `createMcpRuntime()` builds the local allowlist (from line 265), two classes of wakeup binding, `TerminalApprovalProvider`, the fallback shutdown loop |
| [src/core/profiles.ts](code/chapters/ch19/src/core/profiles.ts) | 326 | Added the `"mcp"` capability bit; `P19 = P18 + mcp` |
| [src/core/loop.ts](code/chapters/ch19/src/core/loop.ts) | 789 | **Not changed.** The `snapshot()` at `loop.ts:406` already exists in Chapter 18 |
| [src/config.ts](code/chapters/ch19/src/config.ts) | 78 | No new MCP configuration item. The allowlist is in code. The system does not read the allowlist from the environment |

**Tests (4 files in this chapter, 20 tests in total):**

| File | Lines | What the file asserts |
| --- | --- | --- |
| [tests/ch19-registry.test.ts](code/chapters/ch19/tests/ch19-registry.test.ts) | 104 | Atomicity of a batch change, object-identity safety, version migration, snapshot closure; a snapshot stays unchanged during one model reply |
| [tests/ch19-mcp.test.ts](code/chapters/ch19/tests/ch19-mcp.test.ts) | 365 | Isolation of same-named tools on two real stdio servers; three illegal cases each reject the whole connection (invalid schema / external reference / normalization collision); the system validates arguments before the arguments go to the network, and the local policy stays authoritative; a connection failure while idle revokes the tools; a failed close is retried; mapping and sanitization of a remote error / timeout / process exit; cancelling an in-flight call does not break the connection; cancelling startup closes the connection |
| [tests/ch19-bootstrap.test.ts](code/chapters/ch19/tests/ch19-bootstrap.test.ts) | 469 | mcpRuntime is required only from P19; the system installs to the Lead only and closes the connection through AgentRunner; when a connection is rejected, the transport stays closed; when an external remote tool is rejected, the remote call count is zero; when a disconnect is rejected, the connection stays open; a real Subagent / Teammate bootstrap gets no MCP |
| [tests/ch19-entry.test.ts](code/chapters/ch19/tests/ch19-entry.test.ts) | 52 | The missing-configuration error occurs before Git and MCP state; the system closes the model before it rejects a non-Git workspace |

### Suggested Reading Order for the Code

Do not start at the top of the 806-line `mcp-tools.ts`. Follow this order. Each step follows the question from the previous step:

1. **`P19` in `src/core/profiles.ts`** — First confirm that the delta is one capability bit only. One minute.
2. **`src/mcp-servers/demo.ts` (63 lines in full)** — Look at the object under test first. The four tools are the four behaviors to verify.
3. **The four value objects in `src/features/mcp-tools.ts` (lines 49 / 82 / 148 / 181)** — `McpToolPolicy`, `McpServerSpec`, `McpPublishedTool`, `McpCallResult`. This is the vocabulary of the whole chapter. After you read these objects, you know which fields come from the local side and which fields come from the remote side.
4. **`createMcpRuntime()` in `src/cli.ts` (from line 265)** — What an allowlist looks like, and how to write a policy. This is where "configuration comes only from the local side" lands.
5. **`#connect` in `src/features/mcp-tools.ts` (from line 412)** — A four-step transaction plus three cleanup points. See clearly which step must close the child process when it fails.
6. **`#publishDefinitions` in `src/features/mcp-tools.ts` (from line 516)** — Exact policy matching, name collision, schema compilation and the source of `effect`. This is the densest section in this chapter.
7. **`src/adapters/mcp-schema.ts` (76 lines in full)** — Four checks. The file is short, but every line blocks one class of attack.
8. **`registerMany` / `unregisterMany` in `src/core/tools.ts`** — Read "validate all, then write all" and the object-identity comparison now. You already know what these methods defend against.
9. **`#invokeRemote` (from line 591) and `#dropFailedConnection` (from line 642) in `src/features/mcp-tools.ts`** — Three classes of fault, three handlings, and protection for the reconnect sequence.
10. **The `#tail` serial queue and `waitForFailure` in `src/adapters/mcp-client.ts`** — Transport layer detail. Read this last.
11. **Lines 353-357 and 381-387 in `src/bootstrap.ts`** — Lead-only installation and reverse-order shutdown. Closing detail.

You can skip: the SDK error mapping part of `mcp-client.ts` (`mapSdkError` and its helper functions). The logic is independent. That code translates an SDK exception into the two error classes of this chapter. You can also skip the argument parsing in `cli.ts`.

---

## Run and Verification

Five gates. Run the gates in order. Run all commands under `F:\笔记\Agent实操\code`:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch19
npm run typecheck
npm run lint
npm run format:check
npm run build
```

My measured results:

```text
Test Files  63 passed (63)
     Tests  415 passed (415)
  Duration  15.64s
```

`test:ch19` also runs the tests for all previous chapters. The result is therefore 63 files and 415 tests. The result is not only the 4 files for Chapter 19. This is deliberate. Chapter 19 adds the batch interface to `ToolRegistry`. The system must confirm that the new interface does not break the registration behavior of the first 18 chapters.

To run only the 20 tests for this chapter:

```powershell
npx vitest run chapters/ch19/tests/ch19-registry.test.ts chapters/ch19/tests/ch19-mcp.test.ts chapters/ch19/tests/ch19-bootstrap.test.ts chapters/ch19/tests/ch19-entry.test.ts
```

```text
Test Files  4 passed (4)
     Tests  20 passed (20)
  Duration  3.37s
```

On my side, `typecheck`, `lint`, `format:check` and `build` all pass cleanly.

The tests for this chapter inject a deterministic UUID, a UTC clock and a model stand-in. **The tests do not depend on the real OpenAI and do not depend on the network.** Two exceptions exist, and both exceptions are necessary:

- The stdio tests in `ch19-mcp.test.ts` **spawn a real `demo.ts` child process**. MCP is a cross-process protocol. A fake connection cannot test the handshake, pagination and process exit behaviors.
- The `maps remote error, timeout, and process exit` test has a real wait (1412ms), because a timeout must actually reach its time.

Every key assertion is a concrete business result:

- Two real stdio servers each return their own `label`. The same-named `lookup` tools do not cross;
- Three illegal cases (invalid schema / external `$ref` / normalization name collision) each reject the **whole** connection. The registry returns to `["connect_mcp","disconnect_mcp"]`, and `closeCalls === 1`;
- When an argument does not comply, the remote `callTool` count stays at 0. A remote description does not change the effect in the local policy;
- A connection failure while idle revokes all tools for that alias. `connectedAliases` becomes empty. The system can reconnect afterwards;
- A connection where `close()` fails stays in `pendingCloses`. A later `close()` retries the close;
- A remote error / timeout / process exit maps to three different error codes. The result contains no `server-private-detail`;
- Cancelling an in-flight call does not break the connection. Cancelling startup closes the connection that is already open;
- Passing `mcpRuntime` before P19 raises an error. Omitting `mcpRuntime` at P19 also raises an error (bidirectional);
- The system installs MCP to the Lead only. A real Subagent / Teammate bootstrap runner contains no MCP tool at all;
- When approval is rejected: the transport of the connection stays closed, an external remote tool has zero remote calls, and a rejected disconnect leaves the connection open;
- The missing-configuration error occurs before the system creates any Git or MCP state.

---

## Chapter Summary

### The Three-Sentence Version

First, the real refactor that MCP integration needs is not "write one more connect function". The real refactor is this: **after the tool set itself starts to change, the whole Agent Loop must still stay explainable**.

Second, a Published MCP Tool is **external data**. An Exposed MCP Tool is a **local capability**. A publication gate that the local side controls completely must sit between the two.

Third, everything that the remote side says is data. The system normalizes the name. The system recompiles the schema. The system gives the effect from the local side only. The system builds the error envelope on the local side only.

### Ten Points to Remember

1. **Server configuration comes only from the local allowlist.** The model can provide only an alias. The local side declares the command, the arguments and the timeout ("Connection configuration can come only from a local allowlist").
2. **Published ≠ Exposed.** A remote declaration is only a candidate. The declaration becomes a local capability only after exact policy matching, name normalization and schema compilation ("Unify Six Names First").
3. **The effect in the local policy is the only permission source of truth.** Writing `(readOnly)` in a remote description does not change `external` (Experiment 5).
4. **The published set must be exactly equal to the policy set.** One extra tool or one missing tool rejects the whole connection. The system takes no intersection (Experiment 4).
5. **Name isolation completes before publication.** `mcp__{alias}__{normalized}`, 4-step normalization, a 64-character limit, and a collision rejects the whole connection (Experiment 7).
6. **A schema is an execution boundary.** Ajv strict compilation rejects an external reference. The system stops a bad argument on the local side. The remote `callTool` count is 0 (Experiment 6).
7. **Registration and revocation are atomic version migrations.** The system validates all entries first and then writes all entries. Revocation uses object identity, not the name. The system never leaves a half-connected state (Experiment 3).
8. **Inside one turn, the tool surface is a constant.** The system takes one snapshot for each model request. A new tool becomes visible only in the next turn. `unknown_tool` is a definition, not a bug (Experiment 2).
9. **Three classes of fault, three handlings.** A remote `isError` keeps the connection. A timeout and a transport disconnect discard the connection. The local side constructs every field of the error envelope (Experiment 8).
10. **MCP belongs to the Lead only.** A Subagent / Teammate factory gets no `mcpRuntime`. This is not "the factory chooses not to use MCP" (Experiment 10).


### One Diagram to Recap the Whole Chain

```text
  ① Local declaration             createMcpRuntime() (cli.ts:265)
  ──────────                    ┌────────────────────────────────┐
                                │ McpServerSpec × 2               │
                                │   alias: demo_alpha / demo_beta │
                                │   command / args (fixed locally)│
                                │   startupTimeoutSeconds: 5      │
                                │   toolTimeoutSeconds: 5         │
                                │   toolPolicies:                 │
                                │     lookup    → read            │
                                │     fail      → read            │
                                │     delay     → read            │
                                │     terminate → external        │
                                └───────────────┬────────────────┘
                                                │
  ② Lead only                                   ▼  install(tools)
  ──────────                    ┌────────────────────────────────┐
                                │ Lead registry                   │
                                │   connect_mcp     (external)    │
                                │   disconnect_mcp  (external)    │
                                │                                 │
                                │ Subagent / Teammate factory     │
                                │   No mcpRuntime in the closure  │
                                └───────────────┬────────────────┘
                                                │
  ③ Transactional connection                    ▼  connect_mcp {alias}
  ──────────      ┌──────────────────────────────────────────────┐
                  │ ① factory.open(spec)      Start child process + handshake │
                  │ ② connection.listTools()  Published Tool set  │
                  │ ③ #publishDefinitions()                       │
                  │      Is the policy set exactly equal?         │
                  │      Collision after normalization? Over 64 characters? │
                  │      Does Ajv strict compile the schema? External $ref? │
                  │      effect ← local policy (not the remote side) │
                  │ ④ registry.registerMany()  One atomic registration │
                  │                                              │
                  │ All pass → write #connections + start the Watchdog │
                  │ Any step fails → close the child process, registry keeps nothing │
                  └───────────────┬──────────────────────────────┘
                                  │
  ④ Request boundary              ▼  Each model request
  ──────────      ┌──────────────────────────────────────────────┐
                  │ const tools = this.#tools.snapshot()          │
                  │   (loop.ts:406, already present in Chapter 18) │
                  │                                              │
                  │ Every tool call in this turn uses this snapshot │
                  │ A connect in the middle changes the live registry │
                  │ → A same-turn early call = unknown_tool, visible only in the next turn │
                  └───────────────┬──────────────────────────────┘
                                  │
  ⑤ Call and failure              ▼  mcp__alias__tool
  ──────────      ┌──────────────────────────────────────────────┐
                  │ prepare()  JSON parse + Ajv validation → a bad argument never goes to the network │
                  │ Permission check   effect=external → ask a person; read → allow │
                  │ invoke()   #invokeRemote → callTool            │
                  │                                              │
                  │ isError:true   → mcp_remote_error   Connection kept   │
                  │ Timeout        → mcp_timeout        Connection discarded   │
                  │ Transport break → mcp_connection_lost Connection discarded   │
                  │ Break while idle → the Watchdog revokes actively │
                  │                                              │
                  │ The local side constructs every error envelope field. Remote content does not enter the context │
                  └───────────────┬──────────────────────────────┘
                                  │
  ⑥ Shutdown                      ▼  runner.close()
  ──────────      ┌──────────────────────────────────────────────┐
                  │ resources in reverse order → mcpRuntime closes first │
                  │ Inside the lock: revoke all definitions, clear #connections │
                  │ Outside the lock: close connections in reverse order, a failure enters pendingCloses │
                  │ Multiple failures → one AggregateError reports all failures │
                  └──────────────────────────────────────────────┘
```

The six numbers are the positions of the six hard rules in this chapter: ① Configuration comes from the local side only ② The capability goes to the Lead only ③ Publication is one transaction ④ Inside one turn, the tool surface is a constant ⑤ Validation runs before the call goes to the network, and the local side builds the error envelope ⑥ Shutdown runs in reverse order and leaks no child process.

### Check That You Really Understood

Try to answer without looking at the text above. If you cannot answer a question, the section or experiment is in brackets:

1. What is the difference between a Published MCP Tool and an Exposed MCP Tool? Why does this chapter separate these two terms? ("Unify Six Names First", "Comparison with Chapter 4 of ai-agent-book")
2. A remote server tells you that it has a tool called `deploy`. The `description` says "read-only query". Will the system expose this tool to the model? With which effect will the system expose the tool? ("A remote description cannot grant permission", Experiment 5)
3. The local policy declares four tools: `lookup` / `fail` / `delay` / `terminate`. The remote side publishes only the first three. Does the connection succeed or fail? What happens if the remote side publishes one extra tool instead? Why does the system not take the intersection? ("A remote description cannot grant permission", Experiment 4)
4. In the name `mcp__demo_alpha__lookup`, which segment comes from the remote side and which segment comes from the local side? If the remote tool is called `Look Up!!`, what is the name after normalization? ("Name isolation must complete before publication", Experiment 7)
5. Two aliases both connect to the same demo server. The remote tools have the same name. Why is there no conflict? In which case does a real conflict occur and reject the whole connection? ("Name isolation must complete before publication", Experiment 7)
6. The schema of a remote tool is `{"type":"string"}`. What happens? At which step does the system stop the tool? ("JSON Schema is an execution boundary, not prompt text", Experiment 6)
7. In one reply, the model first calls `connect_mcp` and then calls `mcp__demo_alpha__lookup` at once. What is the result of the second call? Why is the answer not "wait a moment and the call works"? ("Why new tools are visible only in the next turn", Experiment 2)
8. `registerMany()` registers 4 tools. The third name collides with a built-in tool. After registration completes, how many new tools are in the registry? Did `version` change? ("Dynamic registration must be atomic", Experiment 3)
9. Does `unregisterMany()` revoke by name or by object? If another connection has re-registered a tool with the same name, what goes wrong if the system revokes by name? ("Dynamic registration must be atomic", Experiment 3)
10. A remote tool returns `isError: true`. Will the system disconnect the connection? What happens on a timeout? What happens when the transport fails? In the three cases, can you still see this alias in `connectedAliases`? ("A connection is a transaction, disconnect is its reverse", "Error results must be bounded and sanitised", Experiment 8)
11. `terminate` makes the server process run `process.exit(17)`. Who detects this exit? What does the system do after detection? ("Each connection has an independent lifecycle", Experiment 8)
12. A remote error carries internal information such as `server-private-detail`. Will the model see that information? Who builds the error envelope? ("Error results must be bounded and sanitised", Experiment 8)
13. `connect_mcp` and `mcp__demo_alpha__terminate` both need approval. Do the two calls hit the same rule? Does `mcp__demo_alpha__lookup` need approval? ("A remote description cannot grant permission", Experiment 9)
14. Can a Subagent call `connect_mcp`? Can a Subagent use `mcp__demo_alpha__lookup`, which the Lead has already connected? ("MCP tools belong to the Lead only", Experiment 10)
15. When the Runner shuts down, at which position does `mcpRuntime` sit in the `resources` array? Why must the shutdown order be the reverse of the creation order? ("A connection is a transaction, disconnect is its reverse")
16. During `close()`, one `connection.close()` throws an error. Where does this object go? Why does the system keep this object? ("A connection is a transaction, disconnect is its reverse")
17. Does this chapter promise that "a remote tool call happens only once"? After the system judges a timeout as a failure, did the side effect on the remote side happen or not? ("What this chapter deliberately did not do")

After you do these steps, the tool surface is no longer a constant that the code fixes at compile time. At runtime, the Lead can bring an external MCP server in. The system approves, validates and accounts for the tools that the server publishes in the same way as built-in tools. The Lead can also remove the whole connection when the server breaks, without an effect on the other tools. **Bringing an external capability in becomes a rollback-capable transaction. Bringing a capability in is no longer a code change.**

At this point, the nineteen chapters each solve one problem: Loop, permission, Hook, memory, recovery, Task, Cron, team collaboration, Worktree and MCP. For now, the chapters are still nineteen independent evolution steps. In the next chapter, we put these mechanisms into one harness. We look at where the mechanisms interfere with each other when the system puts them together, and at how to arrange a stable startup and shutdown order.
