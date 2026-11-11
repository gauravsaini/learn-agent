
I have seen how many people react when they first meet an Agent framework: they open the architecture diagram and see Orchestrator, Planner, Memory, and Tool Registry, with arrows between every box. It feels clear while they read it. But ask one question — "What is the core code of an Agent?" — and they often cannot answer.

This article draws no boxes. It looks only at code, and it covers only one core idea: the Agent Loop.

Its concept is an infinite loop. The model proposes tool calls. The program executes the tools. The program then puts the results back into the message history. Then it asks the model again, until the model no longer calls tools. To make sure this loop ends, the companion implementation writes it as a `for` loop with a maximum number of turns. This prevents a case where the model keeps calling tools and the program never exits.

---

## Chapter Guide

### What You Can Do After You Read This Chapter

1. Say in one sentence how an Agent differs from "calling a model API once".
2. Understand which JSON fields one turn of an Agent conversation actually sends over the network.
3. Write your own Agent Loop in fewer than 60 lines and make it run.
4. State the condition under which this loop ends, and why a turn limit is necessary.
5. Run the Chapter 1 companion code on your own machine, and let the Agent execute a PowerShell command for you.

### What You Need First

| Need | Level |
| --- | --- |
| TypeScript / JavaScript | You can read `async/await`, arrays, and `interface`. You do not need advanced types |
| Command line | You can change directory in PowerShell and run `npm` commands |
| Large model API | It is enough to know this: you send messages to the model, and the model returns text |
| Previous chapter | None. This is Chapter 1 |

You do not need to read any Agent framework documentation. Every concept this chapter creates for itself is explained first in the glossary below.

### Quick Glossary (Terms That Appear for the First Time in This Chapter)

Scan this table first. When you meet an unfamiliar word in the text, come back and check it here. **You do not need to memorise it.** After you read the main text, you will understand it naturally.

| Term | One-sentence explanation |
| --- | --- |
| **Agent Loop** | The loop of "ask the model → execute the tool → feed the result back → ask the model again". The only topic of this chapter |
| **Harness** | All of the code outside the loop: configuration validation, tool registration, argument validation, approval, error classification, and the turn limit. The model decides. The Harness puts the decision into effect safely |
| **turn** | One "send a request to the model" counts as one turn. Note: one tool call does not count as one turn |
| **tool_calls** | An array field in the model's reply. A non-empty value means "I want to use a tool". An empty value means "I have finished" |
| **tool_call_id** | The unique ID of each tool call. A tool result uses this ID to show which call it belongs to |
| **ToolRegistry** | The Tool Registry. It stores the name, description, parameter format, and execution function of every tool |
| **snapshot** | The registry is "photographed and frozen" for this turn. This guarantees that the tool list the model sees and the tool list that is actually executed later are the same list |
| **ToolResult** | The unified result type for tool execution. Both success and failure are a `ToolResult`. It does not throw an exception to interrupt the loop |
| **discriminated union** | A TypeScript pattern: the `role` field distinguishes four message types, and the compiler uses it to know which fields each message type has |
| **observation space / action space** | What the model "can see" (system prompt + message history + tool descriptions) and what it "can do" (the tools in the registry) |
| **composition root** | The only file that creates real dependencies and injects them. In this chapter, this file is `bootstrap.ts`. The core loop itself does not use `new` to create any SDK or subprocess |
| **profile** | A chapter capability whitelist. Chapter 1's `P01` allows only two capabilities: `loop` and `powershell` |
| **effect** (side-effect class) | A tool declares whether it changes the world. `shell` is marked as `execute`, so by default it requires human approval for each call |
| **fail-closed** | When an error occurs, the system chooses to deny rather than to allow. If the approval step throws an exception, the system also treats it as a "denial" |

### Suggested Reading Route

```text
Chapter guide (you are here)
  ↓
① First, the role you play now      ← Build intuition: the Agent replaces "you"
  ↓
② Two signals, one loop        ← The decision tree has only two branches
  ↓
③ A first look at the real data flow      ← Two turns of JSON examples, the most important section
  ↓
④ Five-step breakdown + the complete function       ← How the code runs
  ↓
⑤ Boundaries and gaps               ← Format differences, shell is not a sandbox, four gaps compared with CC
  ↓
⑥ Conclusion and source map            ← Agent = model + Harness + history; what each of the 13 files does
  ↓
⑦ Run the Chapter 1 agent         ← Hands-on: six steps + a troubleshooting table
  ↓
⑧ Verification, experiments, and summary          ← Three hands-on experiments + self-test questions
```

**Want to run it first and read the principles later?** Jump directly to "Run the Chapter 1 Agent". That section is a fully self-contained list of steps. Run it first, then come back and read ③.

---

## First, the Role You Play Now

Before there was an Agent, you probably used a large model in a way like this:

You type in the chat box: "Show me which TypeScript files are in the current directory, then analyse which file is the largest." The model outputs a command:

```powershell
Get-ChildItem -File -Filter '*.ts' |
    Sort-Object Length -Descending |
    Select-Object Name, Length
```

But it does not run the command itself. You switch to the terminal, paste it in, press Enter, see the output, switch back to the chat box, and copy the output in. The model then says, "Good, the largest one is `main.ts`. Let me analyse it…", and then gives the next command:

```powershell
(Get-Content .\main.ts).Count
Get-Content .\main.ts -TotalCount 50
```

You go to the terminal and run it again, and paste the output back again.

On every round trip, you do the same thing: you pass the tool result back to the model by hand. At this moment, you are actually a "human API". You are also the "middle layer" between the model and the real world.

Automating this middle layer is the only thing the Agent Loop has to do.

---

## Two Signals, One Loop

The logic of the Agent Loop is extremely simple. The whole decision tree has only two branches:

```text
Did the model return tool_calls?
├── Yes → Execute the tool, feed the result back, and ask again
└── No → The model thinks it is done, exit
```

Translated into signals that code can recognise:

| Signal                       | Meaning           | Action                         |
| ------------------------ | ------------ | -------------------------- |
| assistant.tool\_calls is non-empty | The model raises its hand and says "I want to use a tool" | Execute each call or generate an error result → put the result back → continue the loop |
| assistant.tool\_calls is empty | The model does not request another tool    | Return the final text; if there is no text, fail explicitly           |

Note: the "loop" here is mechanical. It has no intelligence at all. All of the real intelligence is in the model. The loop is only the model's hands and feet.

From the conceptual framework of ai-agent-book, this loop corresponds exactly to the two interfaces between the model and the real world:

- What the model can see is determined by the context. This is the observation space.
- What the model can do is determined by the tools. This is the action space.

In this code, the observation space is the request snapshot that the `system prompt`, the message history, and the tool schemas form together. The action space is all of the tools registered in the `ToolRegistry`. After a tool finishes executing, the program must put the result back into the observation space. Only then can the loop continue.

---

## A First Look at the Real Data Flow

This section is the most important part of the whole chapter. Many people get stuck when they read Agent tutorials. They do not get stuck on the code. They get stuck because they do not know what actually travels over the network. So we do not look at code first. We look only at data.

Suppose the user enters: **"Run Write-Output 42 and tell me the result"**. Below are the actual fields of the complete two-turn request and response.

### Turn 1 · The Request We Send

What we send to the model is a JSON object. It has only two parts that we care about: `messages` (what the model can see) and `tools` (what the model can do).

```json
{
  "model": "gpt-4.1",
  "messages": [
    { "role": "system", "content": "You are a coding agent. Use tools when needed, inspect their results, and answer accurately." },
    { "role": "user",   "content": "Run Write-Output 42 and tell me the result" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "shell",
        "description": "Run a PowerShell command in the current workspace.",
        "parameters": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "properties": { "command": { "type": "string", "minLength": 1 } },
          "required": ["command"],
          "additionalProperties": false
        }
      }
    }
  ]
}
```

This `system` content is the one line of `SYSTEM_PROMPT` that is hard-coded in `bootstrap.ts`. Chapter 1 does no dynamic assembly. (Chapter 10 introduces a Provider that generates the system prompt from the runtime state.)

Note the `parameters` section in `tools`. It is the "tool manual". We do not write it by hand. The `ToolRegistry` generates it automatically from this one line of Zod definition: `z.strictObject({ command: z.string().min(1) })`. **The same definition generates the manual that the model reads and also validates the arguments that the model actually returns.** This makes a mismatch impossible, such as "the manual says `command`, but validation requires `cmd`".

### Turn 1 · The Response the Model Returns

```json
{
  "choices": [
    {
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "shell",
              "arguments": "{\"command\":\"Write-Output 42\"}"
            }
          }
        ]
      }
    }
  ]
}
```

Three details that you must see clearly:

1. **`content` is `null`.** The model says nothing in this turn. It only raises its hand and asks for a tool. So you cannot judge whether "the model has finished" by whether there is text.
2. **`arguments` is a string, not an object.** It contains JSON text, `{"command":"Write-Output 42"}`, and we must `JSON.parse` it ourselves. The model can also output JSON with a syntax error. This is a real case that we must handle. It is not a theoretical risk.
3. **`id` is `"call_abc123"`.** Remember it. The next step uses it.

When the loop sees that `tool_calls` is non-empty, it knows: it cannot end. It must do work.

### Intermediate Step · We Execute on This Machine

The Harness does four things. The order cannot change:

```text
① Look up the tool by name       shell → find the definition (if not found, generate an unknown_tool error result)
② Parse arguments     JSON.parse('{"command":"Write-Output 42"}')
③ Zod validation           There must be a command, it must be a non-empty string, and there must be no extra fields
④ Human approval           The terminal prints the command and waits for you to enter y
   ↓ You approved it
⑤ Actually execute           Start a PowerShell subprocess and get stdout: "42"
```

**Step ③ comes before step ⑤. This order is the core of the safety design.** Argument validation must happen before the side effect. Once the command has run, it has no meaning to find that the arguments are invalid.

### Turn 2 · We Feed the Result Back

The key is this: **the assistant message from the previous turn must stay in the history exactly as it was**, and a new message with `role: "tool"` must follow it immediately.

```json
{
  "model": "gpt-4.1",
  "messages": [
    { "role": "system", "content": "You are a coding agent. Use tools when needed, inspect their results, and answer accurately." },
    { "role": "user",   "content": "Run Write-Output 42 and tell me the result" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        { "id": "call_abc123", "type": "function",
          "function": { "name": "shell", "arguments": "{\"command\":\"Write-Output 42\"}" } }
      ]
    },
    { "role": "tool", "tool_call_id": "call_abc123", "content": "42" }
  ],
  "tools": [ "…exactly the same as in turn 1…" ]
}
```

`tool_call_id: "call_abc123"` matches the `id` from the previous turn. This is the model's only clue. It uses this ID to know that "`42` is the result of my `Write-Output 42` call". If the model requests three tools in one turn, there must be three messages with `role: "tool"`, and each ID must match its own call.

### Turn 2 · The Model Returns the Final Answer

```json
{
  "choices": [
    {
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "The command ran successfully. The output is 42.",
        "tool_calls": []
      }
    }
  ]
}
```

`tool_calls` is empty. The loop exits and returns `content` to the user as the final answer.

### Compress the Two Turns into One Diagram

```text
        We                                Model
         │                                   │
 Turn 1  │  messages (2) + tools (1)  ───▶  │
         │                                   │ "I want shell"
         │  ◀───  tool_calls=[call_abc123]   │
         │                                   │
 Execute │ Look up tool → parse arguments → Zod validation → approval → run    │
         │ Get "42"                          │
         │                                   │
 Turn 2  │  messages (4) + tools (1)  ───▶  │
         │   ↑ Two more messages: assistant + tool     │ "That is enough. I can answer now"
         │  ◀───  tool_calls=[] content="…"  │
         │                                   │
 End     │ Return content to the user                │
```

In every turn, `messages` grows longer. This is the Agent's "memory". There is no other mechanism. It is only an array that keeps receiving `push` calls. Because it only grows and never shrinks, Chapter 8 must cover context compaction as a dedicated topic.

**One sentence to summarise this section**: the Agent Loop chooses between "`tool_calls` is non-empty" and "`tool_calls` is empty", and then it appends messages to an array. All of the remaining code exists to make sure this does not break when an error occurs, and that it can stop when it goes out of control.

---
## The Five Steps: How the Code Runs

The previous section looked at the data. This section looks at the code. Split the Agent Loop into five steps. Each step corresponds to a small piece of code.

First, look at the overall mapping. This prevents you from losing your place when you read the details:

| Step | What it does | Inside or outside the loop | Which part of the previous section it matches |
| ---: | --- | --- | --- |
| 1 | The user question enters the message list | **Outside** the loop, done only once | The `user` message in the turn 1 request |
| 2 | Send messages + tool definitions to the model | Inside the loop, done every turn | The requests in turn 1 / turn 2 |
| 3 | Append the model reply, check `tool_calls` | Inside the loop | The decision between "continue" and "stop" |
| 4 | Execute tools, collect results | Inside the loop, only when there are tool calls | The five sub-steps of the middle step |
| 5 | Append results, return to step 2 | Done by the `for` loop itself | The two messages that make the turn 2 request longer |

**Note that step 1 is outside the loop.** The user question needs to enter the message history only once. In every later turn, the model can see it again. No one needs to add it again.

### Step 1: The User Question Enters the Message List

**What this step solves**: It gives the loop a starting point.

```typescript
this.#history.push(userMessage(prompt));
```

This line puts what you said into an array. There is no magic. The `#` before `#history` is the ECMAScript private field syntax. TypeScript supports it natively. External code cannot get a reference to this array. It can only read a frozen copy through the `history` getter. It cannot change the internal state.

What is really worth learning is **why messages have defined types**. The companion implementation does not pass dictionaries around with `Record<string, unknown>`. It defines `ChatMessage` as a discriminated union of four message types:

```typescript
type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;
```

The `role` of each message type is a fixed literal type. The fields differ by type:

| role | Required fields | Specific constraints |
| --- | --- | --- |
| `system` | `content` | Does not enter the message history; the runner prepends it temporarily at each request |
| `user` | `content` | Only one message appears at the start of one run |
| `assistant` | `content`, `toolCalls` | `content` can be `null`, but then `toolCalls` must be non-empty |
| `tool` | `content`, `toolCallId` | Must correspond to the `id` of an earlier `toolCalls` entry |

The benefit is direct. After you write `if (message.role === "tool")`, the compiler knows this message definitely has a `toolCallId`. Writing `.toolCallId` on a `user` message gives an error immediately. With the dictionary style, this class of error only surfaces at runtime.

Three more safeguards exist. A different function handles each one:

| Safeguard | Who runs it | What it stops |
| --- | --- | --- |
| Freeze messages (`Object.freeze`) | Each message constructor | A message is quietly rewritten after creation |
| Unique call IDs within one reply | `assistantMessage()` | Two calls use the same `id`, so results cannot pair one-to-one |
| Full-history pairing validation | `validateToolPairing()` | Orphan results (orphan), missing results (missing), unexpected duplicate results (unexpected) |

`validateToolPairing()` runs once before the request in each turn. The model returns an error for all three kinds of bad history. Stopping them early is cheaper than a remote rejection. The error message is also more precise. It tells you directly which ID has the problem.

In every later turn, the runner appends the model output and the tool results to this message history. They become content that the model can see in its next request.

### Step 2: Send the Messages and the Tool Definitions to the Model Together

**What this step solves**: It constructs the model's observation space. What the model can see and what it can do are both in this request.

```typescript
// Excerpt from AgentRunner.run()
const tools = this.#tools.snapshot();
const request: ModelRequest = Object.freeze({
  messages: Object.freeze([systemMessage(this.#systemPrompt), ...this.#history]),
  tools: tools.openAITools(),
});
const reply = await this.#model.complete(request);
```

The code has four lines. Look at each line:

| Line | What it does | Why it is written this way |
| --- | --- | --- |
| `snapshot()` | Freezes the registry as the immutable tool set for this turn | See the explanation below |
| `systemMessage(...)` + `...this.#history` | Temporarily assembles the complete message list | The system prompt is the same in every turn; storing it in the message history would store N duplicate copies |
| `openAITools()` | Generates JSON Schema from the Zod definitions | The description and the validation rules have one source, so they cannot get out of sync |
| `await complete(request)` | Sends the request | `#model` is an interface, not an SDK; tests can replace it with a scripted fake model |

**Why `snapshot()` is necessary**: The schema that the model sees and the registry that the runner uses during execution must be the same copy. Otherwise, an inconsistency can occur. The model sees tool A, but the runner executes tool B. After Chapter 19 connects the MCP dynamic tool pool, the registry changes during a run. This constraint then changes from a good habit into a requirement. Chapter 1 establishes it early. Later chapters do not need to change the loop.

The JSON Schema that `ToolRegistry` generates tells the model which tools it has now: what each tool is called, what it does, and which arguments it accepts. Chapter 1 has only one PowerShell tool, named `shell`.

The OpenAI SDK is in `code/chapters/ch01/src/adapters/openai-chat.ts`. The adapter sends the request with Chat Completions. It then converts the SDK response immediately into `ModelReply` and internal messages. **The core loop itself stores no SDK objects.** Step 3 mentions this boundary again. It is one of the reasons the whole code base stays maintainable in the long term.

The input schema, the handler, and the effect (side-effect class) of `shell` come from the same `ToolDefinition`. The core definition below matches the companion implementation. The actual source is in `code/chapters/ch01/src/features/builtin-tools.ts`:

```typescript
import { z } from "zod";

import type { CommandResult, CommandRunner } from "../core/commands.js";
import type { ToolDefinition } from "../core/tools.js";
import { ToolRegistry, toolError, toolSuccess } from "../core/tools.js";

const shellInputSchema = z.strictObject({ command: z.string().min(1) });

function createShellTool(commandRunner: CommandRunner): ToolDefinition<{ command: string }> {
  return {
    name: "shell",
    description: "Run a PowerShell command in the current workspace.",
    inputSchema: shellInputSchema,
    effect: "execute",
    handler: async ({ command }, context) => {
      let result: CommandResult;
      try {
        result = await commandRunner.run(command, context.workspace);
      } catch {
        return toolError("shell_start_failed", "PowerShell process could not be started");
      }

      let output = result.output.length === 0 ? "(no output)" : result.output;
      if (result.truncated) output = `${output}\n[output truncated]`;
      if (result.timedOut) return toolError("shell_timeout", output);
      if (result.exitCode !== 0) {
        return toolError(
          "shell_failed",
          `PowerShell exited with code ${result.exitCode}\n${output}`,
        );
      }
      return toolSuccess(output);
    },
  };
}

export function createChapterOneTools(commandRunner: CommandRunner): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(createShellTool(commandRunner));
  return tools;
}
```

`z.strictObject()` rejects extra arguments before the runner executes any side effect.

`ToolDefinition` in this code has five fields. Each field has a clear job:

| Field | Value | Who uses it |
| --- | --- | --- |
| `name` | `"shell"` | The model uses it to make a call; the registry uses it to find the definition |
| `description` | `"Run a PowerShell command..."` | Only the model reads it. Vague text makes the model use the tool wrongly |
| `inputSchema` | `z.strictObject({ command: ... })` | It generates the JSON Schema for the model and validates the actual arguments before execution |
| `effect` | `"execute"` | It declares "I will change the world", so the approval step requires human confirmation by default |
| `handler` | That `async` function | The place that does the real work; it returns a `ToolResult` |

Next, look at the error handling inside `handler`. It shows a principle that runs through the whole book: **a tool failure is data, not an exception**.

```typescript
if (result.timedOut) return toolError("shell_timeout", output);
if (result.exitCode !== 0) return toolError("shell_failed", ...);
return toolSuccess(output);
```

Four cases exist: the process does not start, the command times out, the exit code is non-zero, and normal success. All four return a `ToolResult`. None of them uses `throw`. Why? A `throw` breaks the loop. The model never sees the information "the command failed". It gets no chance to retry with a different form. A returned `toolError` becomes a normal `role: "tool"` message. The runner feeds it back to the model. The model sees `shell_failed` and the error output. In the next turn, it can use the correct command.

**This is the mechanism that lets an Agent correct itself.** The model has no mysterious ability. We simply feed the error information back to it, honestly.

`PowerShellRunner` is the actual implementation on the execution side. It has three hard limits:

| Limit | Default value | Purpose |
| --- | --- | --- |
| Timeout | 120 seconds | One command cannot hang the whole Agent permanently |
| Output limit | 50000 characters | One `Get-ChildItem -Recurse` cannot flood the context |
| stdout/stderr | Merged into one output | The model gets the error information and the normal output together, so it can diagnose the problem |

Timeout, non-zero exit code, and truncation all have clear, observable results. Nothing disappears silently.

The feature does not instantiate `PowerShellRunner`. The composition root, `bootstrap.ts`, creates the adapter. It passes the adapter as a `CommandRunner` to `createChapterOneTools`. The feature therefore depends only on the contract in `core/commands.ts`. Offline tests can inject a fake command runner. They do not need to start real PowerShell.

One diagram makes this "who creates, who injects" layering clear:

```text
bootstrap.ts (composition root, the only place that uses new on real implementations)
  ├─ new PowerShellRunner()  ──inject──▶ createChapterOneTools(commandRunner)
  ├─ new OpenAIChatModel()   ──inject──▶ AgentRunner({ model })
  └─ new ToolRegistry()      ──inject──▶ AgentRunner({ tools })

core/loop.ts (core loop)
  Knows only the interfaces ModelClient / ToolRegistry / CommandRunner
  Never creates an SDK or child process with new, and never reads .env
```

The benefit is that a test can replace only one boundary. To test the loop, replace the model. To test `shell`, replace the command runner. The other parts stay real. The "Verification and Experiments" section at the end of this chapter covers this topic.

### Step 3: Append the Model Reply and Check Whether It Called a Tool

**What this step solves**: It decides whether the loop continues or stops. This is the only branch point in the whole Agent.

```typescript
// Excerpt from AgentRunner.run()
const assistant = reply.message;
this.#history.push(assistant);

if (assistant.toolCalls.length === 0) {
  if (assistant.content === null) {
    throw new AgentRunError("Model stopped without final text or tool calls");
  }
  return Object.freeze({
    finalText: assistant.content,
    history: Object.freeze([...this.#history]),
    turns: turn,
  });
}
```

One detail here is worth noting. An SDK reply object cannot go directly into the long-term message history. `OpenAIChatModel` already normalises it at the adapter boundary into an internal immutable message. Only when the runner sends another request does `toOpenAIMessage()` regenerate the object that Chat Completions needs. Business code therefore sees a stable internal type. It does not see the response shape of one SDK version.

Another detail: the loop exit condition is not "the model finished speaking". It is "the model called no tools". These two things are not equivalent. The model can output text and call tools at the same time. It can also call tools without speaking. It can also speak without calling tools. We care about only one thing: whether it requested a tool.

List the four combinations of `content` and `toolCalls`. The list makes the decision basis clear:

| `content` | `toolCalls` | Meaning | How the code handles it |
| --- | --- | --- | --- |
| `null` | Non-empty | Calls tools only, no speech (the most common case) | Execute the tools, continue the loop |
| Has text | Non-empty | Explains and calls tools at the same time | Execute the tools, continue the loop (the text stays in the message history) |
| Has text | Empty | Gives the final answer normally | **Return `finalText`, exit** |
| `null` | Empty | Neither speaks nor calls tools | Throw `AgentRunError`: this is a bad response, and the code cannot treat it as an answer |

The fourth case needs explicit handling. If the code ignores it, `finalText` is `null`. The user sees an empty answer and thinks the Agent "succeeded". **An empty result cannot pretend to be success.** This principle appears again in every later chapter.

The code must also validate `finish_reason`. It and `tool_calls` are two independent signals:

| `finish_reason` | Meaning | What Chapter 1 does |
| --- | --- | --- |
| `stop` | The model finished speaking naturally | Normal |
| `tool_calls` | The model stopped in order to call tools | Normal |
| `length` | The output hit the token limit and was **truncated** | Throw `IncompleteModelReplyError` |
| `content_filter` | The content was blocked by the safety filter | Throw `AgentRunError` |

Why must `length` produce an error instead of continuing? Truncated output can be half a sentence or half a JSON value. Returning it to the user as the final answer disguises incomplete content as a complete conclusion. Chapter 1 chooses to fail explicitly. Chapter 11 adds automatic continuation and recovery. **First fail correctly. Then recover gracefully.** The order cannot be reversed.

### Step 4: Execute the Tools and Collect the Results

**What this step solves**: It turns the model's "intent" into something that really happens on this machine. It also ensures that every call receives a result.

```typescript
// Excerpt from AgentRunner.run()
for (const call of assistant.toolCalls) {
  const prepared = tools.prepare(call);
  const result = await tools.invoke(prepared, context);
  this.#history.push(toolMessage(result.content, call.id));
}
```

`prepare()` first makes `ToolRegistry` look up the tool. It then parses the arguments into a JSON object and validates them with Zod. The call then passes through the runtime approval boundary. Only then does the code call the handler. Unknown tools, invalid JSON, schema errors, approval rejections, timeouts, and execution exceptions all become a `ToolResult`. They do not break the message chain. The snippet above omits the approval branch, to highlight the Loop. In the actual CLI, `shell` requires the user to approve each command by default.

Splitting `prepare` and `invoke` into two methods is a deliberate design: **`prepare` never produces side effects. Only `invoke` really executes.** All validation can therefore run safely in `prepare`. Only after the code confirms that everything is correct does it let the world change.

The table below lists every result that `prepare` + `invoke` can produce. Note that the last column says "backfill" in every row:

| Case | Who finds it | What it produces | Did the message chain break? |
| --- | --- | --- | --- |
| The tool name does not exist | `prepare` looks up the registry | `toolError("unknown_tool", ...)` | No, normal backfill |
| `arguments` is not valid JSON | `JSON.parse` in `prepare` | A parse error result | No |
| An argument field is missing / extra / has the wrong type | Zod validation in `prepare` | A schema error result | No |
| The user enters `n` in the terminal | The approval boundary | `toolError("permission_denied", ...)` | No |
| The approval step itself throws an exception | The `catch` of the approval boundary | `permission_denied` (fail-closed) | No |
| The handler execution times out | `invoke` → PowerShellRunner | `toolError("shell_timeout", ...)` | No |
| The command exit code is non-zero | handler | `toolError("shell_failed", ...)` | No |
| Everything is normal | handler | `toolSuccess(output)` | No |

**Eight cases, zero broken chains.** This is the whole secret of the loop's robustness. Whatever happens, the model receives one correctly formatted `role: "tool"` message. The loop can then continue.

One rule in the table is called fail-closed: "an exception in the approval step itself also counts as a rejection". The comment in the source code states it directly:

```typescript
} catch {
  // Reject rather than allow when the authorization boundary fails to avoid expanding permissions on approval infrastructure exceptions.
  result = toolError("permission_denied", "Tool approval failed closed");
}
```

If the code did the opposite, "allow when approval fails", every way to crash approval would become a way to bypass permission. **When a security boundary fails, it must choose the stricter side.** Chapter 3 covers the permission system. It expands this principle into a complete four-state decision model.

Last, the pairing requirement. Each tool call result corresponds to a separate `role: "tool"` message. The message pairs with the earlier call through `tool_call_id`. This is a requirement of the OpenAI format. It lets the model know which result corresponds to which call. Each call in one assistant message must receive exactly one result with the same ID. This includes failures and rejections.

An example in which the model calls two tools at the same time shows this:

```text
assistant  content=null  tool_calls=[ {id:"call_1",...}, {id:"call_2",...} ]
tool       tool_call_id="call_1"  content="42"
tool       tool_call_id="call_2"  content="Error: shell_failed ..."
             ↑ call_2 failed, but the runner must still backfill one message
```

What happens if `call_2` is missing? `validateToolPairing()` throws `missing tool results for ids: ["call_2"]` before the request in the next turn. The code does not wait for the model or the provider to report a vague error.

### Step 5: Append the Results and Return to Step 2

**What this step solves**: It lets the model decide again with new information. This is the whole meaning of the word "loop".

```typescript
// The previous step already pushed the tool message
// Go directly into the next bounded loop iteration and call the model again
```

The loop structure itself implements "return to step 2". The message history that the model sees in this turn contains its previous output and the tool execution results. It can therefore continue its reasoning: "Good, I have the file list. Now I need ..."

The only thing here that needs extra explanation is **why `maxTurns` must exist**.

The form `for (let turn = 1; turn <= this.#maxTurns; turn += 1)` looks like defensive programming. But it blocks something that really happens. The model can fall into an endless cycle: "call a tool → the result is unsatisfactory → call again with different arguments → still unsatisfactory → call again". Without a limit, the program never exits. It keeps burning tokens.

Chapter 1 uses 20 turns by default. Note the counting unit:

```text
One turn = one model request, not one tool call.

The model requests 3 tools in one turn → the runner executes 3 tools, but it counts as only 1 turn.
```

If the turns run out and the code still has no final text, it throws `AgentLimitError`. The message carries the specific limit value:

```typescript
throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
```

The code uses a **separate error type**. It does not return `null` or a plain `Error`. This lets the caller distinguish "the model is stuck" from "the model reported an error". The recovery strategies for these two cases are completely different.

---

## The Complete agent_loop Function

Assemble the five steps above. The result is the runnable, equivalent simplified version below. `executeTool` is a narrow interface that returns a `ToolResult`. The loop cares about only one thing: which result this call produced. It does not care how the tool executes internally. The real `AgentRunner` completes execution with `ToolRegistry.prepare()`, the approval boundary, and `ToolRegistry.invoke()`.

```typescript
import { resolve } from "node:path";

import {
  AgentLimitError,
  AgentRunError,
  IncompleteModelReplyError,
} from "../core/loop.js";
import type { RunResult } from "../core/loop.js";
import { systemMessage, toolMessage, userMessage } from "../core/messages.js";
import type { ChatMessage, ToolCall } from "../core/messages.js";
import type { ModelClient, ModelRequest } from "../core/model.js";
import type { ToolContext, ToolRegistry, ToolResult } from "../core/tools.js";

type ExecuteTool = (call: ToolCall, context: ToolContext) => Promise<ToolResult>;

async function agentLoop(options: {
  prompt: string;
  model: ModelClient;
  tools: ToolRegistry;
  executeTool: ExecuteTool;
  workspace: string;
  systemPrompt: string;
  maxTurns?: number;
}): Promise<RunResult> {
  const maxTurns = options.maxTurns === undefined ? 20 : options.maxTurns;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error("maxTurns must be a positive integer");
  }

  const history: ChatMessage[] = [userMessage(options.prompt)];
  const context = Object.freeze({ workspace: resolve(options.workspace), identity: "user" });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const request: ModelRequest = {
      messages: [systemMessage(options.systemPrompt), ...history],
      tools: options.tools.openAITools(),
    };
    const reply = await options.model.complete(request);
    if (reply.finishReason === "length") {
      throw new IncompleteModelReplyError("Model output reached the token limit");
    }
    if (reply.finishReason === "content_filter") {
      throw new AgentRunError("Model response was blocked by the content filter");
    }

    const assistant = reply.message;
    history.push(assistant);
    if (assistant.toolCalls.length === 0) {
      if (assistant.content === null) {
        throw new AgentRunError("Model stopped without final text or tool calls");
      }
      return { finalText: assistant.content, history, turns: turn };
    }

    for (const call of assistant.toolCalls) {
      const result = await options.executeTool(call, context);
      history.push(toolMessage(result.content, call.id));
    }
  }

  throw new AgentLimitError(`Agent exceeded maxTurns=${maxTurns}`);
}
```

This is the minimal kernel of an Agent Harness that can run.

When you read this code for the first time, use the order below. Skip all validation branches:

```text
① for (let turn = 1; ...)           ← Skeleton: a bounded loop
② const reply = await ...complete() ← Ask the model
③ history.push(assistant)           ← Remember what the model said
④ if (toolCalls.length === 0)       ← The only branch point
⑤   return { finalText }            ←   Exit A: normal end
⑥ for (const call of toolCalls)     ← Exit B: do the work, then continue
⑦   history.push(toolMessage(...))  ← Feed the result back
⑧ throw new AgentLimitError         ← Exit C: turns exhausted
```

**Three exits, one branch point.** Recognise these eight lines. The rest of the code is protection added around them:

| Code fragment | What it protects | What happens without it |
| --- | --- | --- |
| `maxTurns` positive-integer validation | Configuration errors | A caller passes `0`, the loop does not run even once, and the code silently returns an error |
| `finishReason === "length"` | Truncated responses | Half a sentence is treated as the final answer |
| `finishReason === "content_filter"` | Filtered responses | Empty content is treated as an answer |
| `assistant.content === null` check | Bad responses | `finalText` is `null`, and the user sees a blank |
| `resolve(options.workspace)` | Non-standard paths | A relative path points to different directories under different cwd values |

The simplified version differs from the real `AgentRunner` in only three places. None of them affects your understanding of the loop:

| Simplified version | Real version | Why |
| --- | --- | --- |
| `executeTool`, one narrow function | `tools.prepare()` + approval + `tools.invoke()` | The simplified version merges three parts into one interface and highlights the main line of the loop |
| No `validateToolPairing` | Validates once before the request in each turn | The real version must stop corrupted history before it sends a request |
| Returns `history` directly | `Object.freeze([...history])` | The real version does not let callers change the internal state |

The complete version is in `code/chapters/ch01/src/core/loop.ts`. The fixed Chapter 1 entry point is in `code/chapters/ch01/src/chapters/ch01.ts`. The behavior tests are in `code/chapters/ch01/tests/ch01-loop.test.ts` and `code/chapters/ch01/tests/shell-tool.test.ts`.

---
## An Easily Overlooked Difference: Anthropic Format vs OpenAI Format

This code uses the OpenAI-compatible format. If you read the official Anthropic API documentation, you will find that the message structure is slightly different. Putting the two formats side by side makes the signal itself clearer: has the model requested a tool, or not?

| Concept | Anthropic format | OpenAI format |
| --- | --- | --- |
| How to tell whether the model called a tool | response.stop\_reason == "tool\_use" | Whether response.choices\[0\].message.tool\_calls is non-empty |
| Tool call ID field | tool\_use\_id | tool\_call\_id |
| Role of the tool result message | user (the tool\_result is nested inside a user message) | tool |
| Format of the tool call block | A type: "tool\_use" block inside content | The message.tool\_calls array |

The forms differ, but the essential signal is the same: has the model raised its hand and asked for a tool? This is the only signal the Agent Loop needs to perceive, and it has nothing to do with which SDK you use.

---

## This Must Be Stated Clearly: The Shell Is Not a Sandbox

The companion implementation runs on Windows 11. The tool is named `shell`, and it executes PowerShell. It has no string blacklist, because a blacklist can be bypassed by writing the command in a different way, and it easily creates the false impression that the system is already safe.

The real chapter entry point marks `shell` with the execute effect. Before each execution, it displays the tool name, the reason, and the arguments, and it asks:

```text
Allow this call? [y/N]
```

The command executes only if the user explicitly enters `y` or `yes`. Pressing Enter, entering anything else, having no interactive stdin, or an approval error all reject the call by default. A rejection still produces a tool error result with the same `tool_call_id`, so the model can choose a different approach.

But approval is not the same as isolation. The `cwd` of `PowerShellRunner` is only the starting working directory of the child process. The command can still change directories, access absolute paths, start other processes, or access the network. The file tools in later chapters have a separate workspace path boundary; `shell` does not. Chapter 3 covers the real rule merging, audit, and rejection priority. Until then, never describe `cwd` as a sandbox.

---

## A Few Dozen Lines vs 1729 Lines: Where Is the Gap in the CC Source?

The external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code) once checked an older core file of Claude Code, `query.ts`, line by line, and its records show that the file is about 1729 lines long. Claude Code itself is not open source, and the public repository does not contain this file, so the line numbers below are only a reference snapshot and do not represent the current interface.

The core loop logic is only the few dozen lines above. So what does the rest of the code do?

All of it is protection mechanisms.

### Difference 1: How the Code Decides Whether the Loop Continues

The code above decides whether to continue by checking whether `tool_calls` is non-empty. CC does it differently:

```ts
// Reference check snapshot (not an excerpt from the current source):
// stop_reason === 'tool_use' is unreliable.
// Set during streaming whenever a tool_use block arrives.
let needsFollowUp = false
```

In the reference snapshot, CC uses a `needsFollowUp` flag. While it receives a streaming response, it sets the flag to `true` as soon as it detects a `tool_use` block. It does not wait for the whole response and then check `stop_reason`.

Why? Because in a streaming response, `stop_reason` can lag behind: the content blocks have already arrived, but the metadata field has not been updated yet. If you only check `stop_reason`, you can misjudge the situation in a streaming scenario. The tool is then not executed, and the loop exits early. This is a concrete adaptation that production code makes for streaming transport, not a difference at the theoretical level.

The official Agent SDK documentation now also describes the loop as "repeat until the model produces a response with no tool calls". The `stop_reason` field is still used to judge why the final turn ended, for example `end_turn`, `max_tokens`, or `refusal`.

### Difference 2: The State Object Carries 10 Fields

The core of chapter 1 needs only the history, the turn count, and the tool context. The State object of the CC loop has 10 fields:

| Field | Purpose |
| --- | --- |
| messages | The message array for the current iteration |
| toolUseContext | Tool, signal, and permission context |
| autoCompactTracking | Tracking of the context compaction state |
| maxOutputTokensRecoveryCount | Number of token recovery attempts, with a limit of 3 |
| hasAttemptedReactiveCompact | Whether this turn has already attempted reactive compaction |
| maxOutputTokensOverride | An override that raises the output token limit from 8K to 64K |
| pendingToolUseSummary | A summary of tool calls, generated in the background with Haiku |
| stopHookActive | Whether the stop hook produced a blocking error |
| turnCount | Turn count, used for the maxTurns check |
| transition | The reason the previous loop iteration continued |

Here are two interesting ones:

`maxOutputTokensRecoveryCount` retries at most 3 times. The reason is that the model is sometimes truncated by the token limit and stops before it has finished speaking. A production system must detect this situation and recover from it. It must not simply treat it as "the model is done" and exit.

`pendingToolUseSummary` uses a cheaper model (Haiku) in the background to generate a summary of the tool call history. This compresses the context length and saves tokens. It is one of the context management methods an Agent uses when it runs a task for a long time.

Also note: `taskBudgetRemaining` (the remaining task budget) is not on State. A source code comment states this explicitly: `Loop-local (not on State)`. It is only a local variable inside the loop, and it is reset each time the loop is entered.

### Difference 3: Exit Paths

The minimal concept code has only 1 normal exit path: the model does not call a tool. From chapter 1, the companion implementation also adds a maximum number of turns, plus explicit failures such as `length`, `content_filter`, and no final text. These only prevent an incorrect completion. This chapter does not recover from them automatically.

The exit paths of CC cover:

- The maximum number of turns is reached (maxTurns)
- The context is too long (prompt too long); the system attempts compaction and continues
- The model output is truncated by the token limit; the system recovers and continues
- The model returns an error
- The user interrupts actively (abort)
- A Stop Hook intercepts and produces a blocking error
- The continuation strategy after the token budget is exhausted
- A reactive compaction retry

Each path has its own handling logic and recovery strategy. It is not a simple `return` or `throw`. Chapter 1 is still close to a single-lane road; later chapters add these recovery paths step by step.

### Difference 4: Streaming Parallel Tool Execution

CC also has a `StreamingToolExecutor`. While the model is still generating the response content, it starts to execute the tool calls that have already arrived. It does not wait for the model to finish speaking.

How does it decide between concurrent and serial execution? It checks the `concurrency-safe` mark of the tool. Safe tools can run in parallel. Tools with a risk of state conflicts run exclusively. This is a pure performance optimisation, and it has nothing to do with the correctness of the loop itself. But in an Agent task with many tool calls, it can reduce the total latency significantly.

---

## Putting the Pieces Above Together

We can now give a clear conclusion:

```text
Agent = model decisions + Harness execution + message history passing
```

These three things together are an Agent. No Planner is needed, no Memory is needed, and no Orchestrator is needed; those are only capabilities stacked on top of these three things.

- Model decisions: "Should I use a tool, which tool should I use, and which arguments should I pass?" This is intelligence. The model completes it, and the loop code cannot control it.
- Harness execution: "If a tool is called, run it, and feed the result back." This is a mechanical action, and it is a very short loop.
- Message history passing: "Append the input and output of each turn to the list." This is memory, that is, the internal `history` list.

In a more common conceptual formula, this is **Agent = LLM + context + tools**:

- The LLM is the decision core. It decides "should I use a tool, which tool should I use, and which arguments should I pass?";
- The context is the observation space the model can see at each decision point. It consists of the tool definitions, the system prompt, and the session history together;
- The tools are the action space with which the model changes the world. Harness execution connects the tools to this context.

The constraints, validation, recovery, and permission mechanisms built around these three parts are the Harness. The minimal loop keeps only these three runnable parts. Planner, Memory, and Orchestrator are all capabilities stacked on top of them.

Of the three things, Harness execution is the minimal loop we wrote today. The rest of the production code is protection, recovery, and optimisation added around "Harness execution"; the core loop itself never changes.

In the chapter 1 code, the observation space consists of the `system prompt`, the message history, and the tool schema. The action space consists of `shell` in the `ToolRegistry`. And the config, the manual approval, the error classification, and `maxTurns` are the earliest Harness.

---

## Source Design Map: Each of the 13 Files Manages One Thing

Put the 13 source files of chapter 1 together, and you will see this: most of the code outside the core loop works on "startup, boundaries, and constraints":

| File | Responsibility | Corresponding section in the main text |
| --- | --- | --- |
| `src/core/loop.ts` | `AgentRunner`: message history, bounded loop, tool result backfill, stop conditions | The five-step breakdown |
| `src/core/messages.ts` | A discriminated union of the four message types, and tool pairing validation | Step 1 |
| `src/core/tools.ts` | `ToolRegistry`: schema, the model tool view, prepare/invoke, error results | Step 2, step 4 |
| `src/core/model.ts` | The `ModelClient` / `ModelReply` model boundary | Step 2 |
| `src/core/commands.ts` | The `CommandRunner` / `CommandResult` process execution contract | The shell tool |
| `src/core/profiles.ts` | `ChapterProfile` / `P01`, the chapter capability whitelist | The startup chain |
| `src/features/builtin-tools.ts` | Registers the `shell` tool | Step 2 |
| `src/adapters/openai-chat.ts` | The OpenAI SDK adapter and response narrowing | Step 3 |
| `src/adapters/powershell.ts` | `PowerShellRunner`: timeout, truncation, UTF-8 | The shell tool |
| `src/config.ts` | Validates `.env` and the URL before startup | Running |
| `src/bootstrap.ts` | The composition root: injects the model, commands, tools, and profile | The startup chain |
| `src/cli.ts` | Two entry points, the fixed chapter entry and the general CLI, and `TerminalAuthorizer` | Approval |
| `src/chapters/ch01.ts` | The fixed chapter 1 entry point | Running |

`profiles.ts` looks very small, but it is the chapter capability boundary: the fixed entry point allows only `P01`, and the composition rejects loading later chapter capabilities into chapter 1 on that basis. `commands.ts` is the narrow interface behind `PowerShellRunner`, and it lets the tests replace the real child process with a fake. The startup order is: the entry point parses the arguments → `config.ts` validates the configuration → `bootstrap.ts` assembles the dependencies → `AgentRunner` runs the loop. The core loop never touches the SDK, child processes, or `.env`.

---

## The Problem of Having Only the Shell in Your Hand

At present, this Agent has only one tool in its hand: `shell`, that is, the Windows PowerShell command entry point.

This means:

- To read a file, use Get-Content .\path\to\file
- To write a file, use Set-Content .\path\to\file -Value "..."
- To find a file, use Get-ChildItem -Recurse -Filter '*.ts'
- To move a file, use Move-Item

It is ugly and fragile to use: paths and escaping are easy to get wrong; this is especially clear when the file content contains quotes, line breaks, or special characters; and multi-step operations have no atomicity either.

The next article gives it four dedicated tools: `read_file`, `write_file`, `edit_file`, and `glob`. The `shell` tool is kept, and later chapters continue to accumulate capabilities on top of this chapter.

New problems will appear then: will the model call multiple tools at once? What happens if two tools write the same file at the same time? Where is the boundary of parallel execution?

---

## Run the Chapter 1 Agent

This section is completely self-contained: start from zero, and run it through in six steps. Each step gives the expected result. If your result does not match, look at the troubleshooting table below.

### Step 0: Check the Node Version

```powershell
node --version
```

The expected output is similar to `v20.12.0` or higher. If it is lower than `20.12`, upgrade Node.js first. The companion code uses ESM and `node:` built-in module features that depend on this version.

### Step 1: Enter the Code Directory and Install the Dependencies

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm ci
```

Use `npm ci` and not `npm install`: the former installs strictly according to `package-lock.json`, and it guarantees that your dependency versions match the tutorial.

Expected result: after the command finishes, a `node_modules` directory appears, and the last line of the terminal is a statistic such as `added N packages`.

### Step 2: Run the Offline Tests First (No Key Is Required)

**Do this step before you configure the API.** It verifies that the code itself has no problem, and it separates "environment problems" from "configuration problems":

```powershell
npm run test:ch01
```

The last few lines of the expected output:

```text
 Test Files  6 passed (6)
      Tests  30 passed (30)
```

In the middle, you will see a line `Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL` — **this is normal**. It is the output of a test case that `config.test.ts` triggers deliberately. It is not an error in your environment.

These 30 tests are all offline: the model and PowerShell are both injected as substitutes, and they do not send a single network request. So if they pass, the loop logic, the message pairing, and the error classification are all good.

### Step 3: Create and Fill In .env

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in the three items below. **None of them may be left empty:**

```dotenv
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1
```

`OPENAI_BASE_URL` has two hard requirements, and very many people write it incorrectly:

| Requirement | Correct | Incorrect |
| --- | --- | --- |
| Do not add `/chat/completions` | `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` |
| It usually ends with `/v1` | `https://your-provider.com/v1` | `https://your-provider.com` |

The reason is simple: the SDK appends `/chat/completions` to the base URL **itself**. If you have already written it, the final request path becomes `/v1/chat/completions/chat/completions`. Before it sends the request, `config.ts` detects this form of writing and reports an error directly. It does not let you guess for a long time in front of a 404.

If any item is empty, the program lists the missing fields before the network request. It does not hide a configuration error behind a default model or a default address. **No implicit default values** is a deliberate design: it is better for startup to fail than for you to think you are using model A while you are actually using model B.

### Step 4: Run the Real Agent

Chapter 1 provides two entry points. Both build the same `P01` profile, and the effect is exactly the same:

```powershell
# Entry point 1: the fixed chapter script
npm run ch01 -- --prompt "Run Write-Output 42, and tell me the result"

# Entry point 2: the unified CLI, select the chapter with --chapter
npm run agent-tutorial -- run --chapter 1 --prompt "Run Write-Output 42, and tell me the result"
```

Note the two dashes in `--`: they tell npm "the arguments after this are for the script, not for npm". If you omit them, the arguments do not get through.

### Step 5: Understand the Approval Prompt and Approve

When the model decides to use `shell`, the terminal stops and asks you:

```text
Tool call requires approval: shell
Reason: PowerShell command execution requires explicit approval.
Arguments: {"command":"Write-Output 42"}
Allow this call? [y/N] 
```

These three lines of information correspond to the three bases for the approval judgement: **which tool, why approval is required, and what the concrete arguments are**. Look carefully at the `Arguments` line before you decide — this is the only place where you can stop a dangerous command.

Enter `y` and press Enter. The expected final output is similar to:

```text
42

The command ran successfully, and the output is 42.
```

(The first part, `42`, is the output of the PowerShell child process printed directly to the terminal; the second part is the final answer of the model.)

The command executes only if you explicitly enter `y` or `yes`. **Pressing Enter, entering anything else, having no interactive stdin, or an approval error all reject the call by default.** A rejection still produces a tool error result with the same `tool_call_id`, so the model can choose a different approach — so after you enter `n`, the Agent does not crash. It will tell you "I was not able to execute the command".

The command reads `.env` from the current directory, and it also uses the current directory as the Agent workspace. Approve only real commands that you have already checked.

### Troubleshooting Common Errors

Look the error up by the error text the terminal displays:

| The error you see | Cause | How to fix it |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` | `.env` is missing a field, or a field is empty | Fill in the items listed in the error. Note that a space after the equals sign also counts as empty |
| `Configuration Error: Missing required settings: OPENAI_BASE_URL` (only this item is reported) | The URL is invalid, the protocol is not http(s), or it ends with `/chat/completions` | Change the URL according to the table in step 3 |
| `Runtime Failure: Unknown argument: ...` | An argument is spelled incorrectly, or `--` is missing | Check whether you wrote `npm run ch01 --prompt "..."` (one `--` is missing) |
| `Runtime Failure: Both --chapter and --prompt are required` | You used the unified entry point but did not give `--chapter` | Add `--chapter 1` |
| `Runtime Failure: Expected command: run` | The unified entry point is missing the `run` subcommand | Use `npm run agent-tutorial -- run --chapter 1 ...` |
| `Runtime Failure: Agent exceeded maxTurns=20` | The model calls tools repeatedly but does not get a satisfactory result | Use a clearer prompt; or first use a simple command to confirm that the chain works |
| `Runtime Failure: Model output reached the token limit` | The model output was truncated (`finish_reason=length`) | Make the task output shorter. Only chapter 11 recovers from this situation automatically |
| `Runtime Failure: Unsupported finish_reason: ...` | The provider returned a non-standard `finish_reason` | That third-party interface is not fully compatible with Chat Completions. Change the provider or the model |
| It prints `No interactive input, rejecting by default.` | There is no interactive terminal (a pipe, CI, or the built-in terminal of some IDEs) | Run it in a real PowerShell window |
| 401 / 403 network errors | The API Key is invalid or has no permission | Check `OPENAI_API_KEY`, and confirm that the key can access `OPENAI_MODEL` |
| 404 network errors | The base URL path is wrong | In most cases `/v1` is missing; see step 3 |

---

## Verification and Experiments: Tests Are Repeatable Controls

The companion tests turn the most critical boundaries of this chapter into repeatable offline experiments. Running `npm run test:ch01` executes 6 test files and 30 tests:

| Test file | What it verifies |
| --- | --- |
| `ch01-loop.test.ts` | The complete Agent loop, tool result pairing, an unknown tool, invalid JSON, the maximum number of turns, a truncated reply |
| `shell-tool.test.ts` | The real PowerShell cwd / UTF-8, timeout, truncation, a startup failure, an invalid handler return value |
| `messages.test.ts` | Strict pairing of tool calls and results, duplicate / orphan / missing results |
| `config.test.ts` | Missing configuration, a non-HTTP URL, a duplicate `/chat/completions` path |
| `profiles.test.ts` | The `P01` capability whitelist and the immutable set |
| `openai-chat.test.ts` | SDK response normalisation, refusal, an invalid finish_reason, the legacy function_call, usage validation |

These tests are the engineering version of "ablation experiment" thinking: with a scripted `ModelClient` or a fake `CommandRunner`, you replace only one external boundary at a time, and you observe whether `AgentRunner` still maintains the message pairing, the error backfill, and the stop conditions. A real model experiment requires a key. The offline verification is covered by these repeatable tests.

### Three Small Experiments We Recommend You Do by Hand

Understanding is not the same as being able to write it. Each of the three changes below takes only a few minutes, but each one turns a core constraint of this chapter from "known" into "verified". Remember to change it back when you are done.

**Experiment 1: Set the turn limit to 1 and watch how it fails**

In `code/chapters/ch01/tests/ch01-loop.test.ts`, find the place that constructs the Agent, pass `maxTurns` as `1`, and then let the scripted model request a tool in the first turn.

Expected: it throws `AgentLimitError`, and the message is `Agent exceeded maxTurns=1`.
What you learn: the turn limit blocks this situation: "the model called a tool in the first turn, but it has no chance to give the final text" — the tool execution finished, but the loop has no next turn available.

**Experiment 2: Deliberately omit one tool result**

Construct a history by hand: one assistant message with two `toolCalls`, but followed by only one `tool` message. Then call `validateToolPairing(history)`.

Expected: it throws `MessageContractError`, and the message has the form `missing tool results for ids: ["call_2"]`.
What you learn: the value of the pairing validation is that it reports the error **early**. Without this layer of validation, you would discover the problem only when the provider returns a vague 400, and you would not know which ID is missing.

**Experiment 3: Let the fake command executor return a non-zero exit code**

Use `FakeCommandRunner` to return `exitCode: 1`, and observe whether the loop interrupts.

Expected: the loop does not interrupt. A `role: "tool"` message whose content contains `shell_failed` appears in the history, and the model can still continue to the next turn.
What you learn: this is what the table in step 4 wanted to say — **a tool failure is data, not an exception**. It is also exactly the reason the Agent can change its approach and retry by itself.

---

## Chapter Summary

### The Three-Sentence Version

1. The Agent Loop is "ask the model → check whether `tool_calls` is empty → execute the tool → push the result back into the history → ask the model again", and the code is under 60 lines.
2. The loop has only one branch point (whether `tool_calls` is empty) and three exits (a normal return, the turns are exhausted, an unrecoverable error).
3. The code size gap of a production-grade Agent is not in the loop. It is all in the protection around the loop: validation, approval, error classification, recovery, and limits.

### Five Points You Must Remember

| # | Conclusion | In which section it appears |
| ---: | --- | --- |
| 1 | The exit condition is "the model did not call a tool", not "the model finished speaking" | Step 3 |
| 2 | Each `tool_call` must have exactly one result with the same ID; a failure and a rejection also count | Step 4 |
| 3 | Argument validation must happen before the side effect; `prepare` does not execute, only `invoke` executes | Step 4 |
| 4 | A tool failure returns a `ToolResult` and does not `throw` — otherwise the model has no chance to correct the error | The shell tool |
| 5 | At a security boundary, choose rejection when an error occurs (fail-closed); do not choose to let it pass | Step 4 |

### The Code Boundary of This Chapter (An Explicit Statement of "What Has Not Been Done Yet")

| Already present | Not yet present | In which chapter it is added |
| --- | --- | --- |
| One `shell` tool | Dedicated file tools (read/write/edit/find) | Chapter 2 |
| Manual approval for each call | A rule-based permission policy, audit, a four-state decision | Chapter 3 |
| The `cwd` starting directory | A real path boundary (`shell` currently has **none**) | Chapters 2 and 3 |
| Explicit failures (`length`/`content_filter`) | Truncation continuation, rate limit retry, a fallback model | Chapter 11 |
| A `history` that only grows | Context compaction and artifact persistence | Chapter 8 |
| A single Agent | Subagents, multi-Agent collaboration | Chapters 6 and 15–18 |
| A tool set fixed at startup | A dynamic MCP tool pool | Chapter 19 |

**Do not treat the `cwd` of chapter 1 as a sandbox.** This is the boundary this chapter needs to emphasise most. The section "The shell is not a sandbox" above has already explained the reason.

### Check Whether You Really Understood

Try to answer these five questions without looking at the article. If you cannot answer one, go back to the corresponding section and read it again:

1. The model returns `content: "OK"` and `tool_calls: []`. Should the loop continue or end? (Step 3)
2. The model returns `content: null` and `tool_calls: []`. What should the code do? Why can it not simply return? (Step 3)
3. In one turn, the model requests 3 tools, and 1 of them fails during execution. How many `tool` messages should be pushed into the history? (Step 4)
4. What problem exactly does `snapshot()` protect against? (Step 2)
5. Why does `maxTurns=20` mean 20 model requests, and not 20 tool calls? (Step 5)

From the next chapter, we install four dedicated file tools on this loop, and we meet the problem "a tool needs a boundary" for the first time.
