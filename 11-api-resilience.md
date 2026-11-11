At two in the morning, my phone rang.

An Agent task that had run for three hours was dead. The last line of the log read:

```text
openai.APIStatusError: Error code: 529 - {'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}
```

No retry. No wait. No recovery action of any kind. It had simply crashed.

Three hours of tool calls, file reads and writes, and intermediate conclusions were all wasted, while the overload on the provider side may have lasted only two seconds.

This is not a rare bug. It is the inevitable result of four everyday situations:

- 429 is the standard rate limit signal, and it appears as soon as quotas get tight;
- some OpenAI-compatible endpoints use 529 to report a temporary overload;
- when the input exceeds the context window, the endpoint returns a structured "prompt too long" error;
- when the output hits `max_tokens`, you receive a **successful** HTTP 200 whose body is half a sentence.

The question is never whether the API will fail. The question is whether the Agent can recover within clear boundaries.

The Agent from Chapter 10 already has memory, context compaction, planning tools, and a dynamic prompt. But the model request still passes naked through the single Loop: as soon as `model.complete(request)` throws, the whole `run()` ends. Chapter 11 adds exactly one layer of capability. It lets **one logical model request** handle output truncation, over-long input, and transient API failures by itself, while it guarantees that it does not pollute the canonical history, does not run a hook twice, and does not hide a failure.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaGsTNZSXRlG4fL5wHvcaIrLwardHsUpxcyrxic5ZEAWlaiaByrxZCvvezTicJhNcCXCx0yrsQoxYtAvEiaLIxXz7FTMqDLAm0rsZeI/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Guide to This Chapter

### What You Can Do After You Read This Chapter

1. You can separate three kinds of "the model gave no usable answer" failure. You can state the provider-independent signal and the recovery action for each kind, instead of vaguely saying "retry it".
2. You can explain why fault classification must not use `"429" in str(exc)`. You can state exactly which fields the correct approach reads.
3. You can explain why `finishReason === "length"` is not an exception. You can explain why the first truncated reply must be discarded in full.
4. You can compute by hand the wait time of each of the 10 transient retries under the default configuration. You can explain why the total wait accounts exactly for the 300-second default deadline.
5. You can decide whether a `Retry-After` header is accepted or rejected. You can state which error a rejection throws.
6. You can explain what **consecutive** means in "switch to the fallback after 3 consecutive 529s". You can state which events reset the counter to zero.
7. After one continuation recovery, you can state how many messages should remain in the canonical history. You can state what the outer turn count should be.
8. You can explain why this chapter wraps only the main Loop request. You can explain why memory extraction, compaction summaries, and subagents still call the bare model.

### What You Need First

| Prerequisite | From Which Chapter | How This Chapter Uses It |
| --- | --- | --- |
| How the Agent Loop assembles a model request in each turn | Chapter 1 | The recovery layer sits between "the request is assembled" and "the reply arrives" |
| The `ModelClient` / `ModelRequest` / `ModelReply` contract | Chapter 1 | The recovery layer knows only these three types, not provider objects |
| The difference between canonical history and request history | Chapter 8 | **The most important prerequisite in this chapter.** Recovery changes only the request snapshot, not the canonical history |
| `CompactionManager` and the rule that a protocol group cannot be split | Chapter 8 | An over-long input reuses it directly for reactive compaction |
| The dynamic system prompt is re-rendered in every turn | Chapter 10 | The first system message must stay in place during compaction |
| Profile capability bits and the composition root | Chapters 5 to 10 | P11 switches to the recovery path with one `recovery` capability bit |

If you have time to review only one chapter, review Chapter 8 and its point that "canonical history and request history are not the same thing". Half of the design in this chapter is built around this boundary.

### Quick Reference of Terms (Terms That Appear for the First Time in This Chapter)

| Term | One-Sentence Explanation |
| --- | --- |
| Logical model request | One "model call" as the outer Loop sees it. It may send several real HTTP requests internally |
| Recovery layer | `RecoveryManager`. It keeps retry, continuation, compaction, and switching for one logical request inside itself |
| Normalized error | The adapter boundary converts a provider exception into a type of this project. All later code dispatches by type only |
| Output truncation | The model stops at `max_tokens`. The status is HTTP 200, but `finish_reason` is `length` |
| Output budget escalation | On the first truncation, the code raises `maxTokens` from 8000 to 64000 and resends the same request |
| Continuation | If the output still truncates at the maximum budget, the code appends the existing fragment and a continuation prompt to the **request snapshot** and asks once more |
| Request snapshot | The local `requestMessages` inside `complete()`. It is a frozen array, and the code rebuilds it for every retry |
| Reactive compaction | Compaction that an "input too long" error triggers passively. It differs from the threshold-based compaction in Chapter 8 |
| Transient failure | A 429 rate limit and a 529 overload. These are the failures where a retry makes sense |
| Exponential backoff | The wait time grows as `base × 2^attempt`. The cap is 32 seconds |
| Jitter | A small random amount added to the backoff time. It prevents a batch of requests from waking up at the same moment |
| `Retry-After` | A response header where the server states exactly how long to wait. It has priority over local backoff |
| Fallback model | A backup model. The code switches to it when the primary model stays overloaded |
| Deadline | A wall-clock limit for one turn, counted from `beginTurn()`. The default is 300 seconds |
| Typed failure | Each kind of exhaustion, timeout, and cancellation has its own error class. The caller decides by type, not by message text |

### Suggested Reading Route

```text
Guide to This Chapter (you are here)
  ↓
① First look at what the three paths look like when they really run   ← Look at output directly, not at abstractions first
  ↓
② Three failures, three paths              ← Why they must be handled separately
  ↓
③ Normalize the error first                  ← Read structured fields only; validate a 200 as well
  ↓
④ Path one: output truncation              ← Escalate the budget → continue → only the merged result leaves
  ↓
⑤ Path two: input too long              ← Compact the request snapshot only, and compact it only once
  ↓
⑥ Path three: 429 / 529             ← The backoff curve, Retry-After, the fallback counter
  ↓
⑦ Cancellation and the deadline                  ← Attempt count is not the only boundary
  ↓
⑧ Connect to the single Loop                 ← Why an internal retry is not a new turn
  ↓
⑨ Run it + seven experiments + troubleshooting        ← Verify every conclusion above by hand
```

---

## First Look at What the Three Paths Look Like When They Really Run

Talking about "retry" in the abstract is not as useful as looking at output. The three transcripts below are real results from a **scripted fake model**. The fake model returns replies or throws errors in a preset order. The clock and the sleep function are injected fake implementations that a test can observe, so the test can print the parameters of every request and the seconds of every wait. The full script appears later in "Experiment One".

**Part one: the output is truncated.**

```text
=== Path one: output truncated ===
Request 1  model=primary-model maxTokens=8000 messages=2 last=user: "Write a long report"
Request 2  model=primary-model maxTokens=64000 messages=2 last=user: "Write a long report"
Request 3  model=primary-model maxTokens=64000 messages=4 last=user: "Continue exactly where you left off. Do not r
Final content = "First half. Second half."
Final finishReason = stop
Messages in the caller's original request = 2 (not rewritten)
state.recoveryCount = 1
state.hasEscalated = true
```

The three request log lines show three things:

- In request 2, `maxTokens` changes from 8000 to 64000, but **the message count is still 2**. The first incomplete reply is discarded in full. It does not enter the request.
- In request 3, the message count becomes 4. The two extra messages are "the previous partial reply + the continuation prompt". They exist only in the request snapshot.
- The last line says `Messages in the caller's original request = 2`. The `ModelRequest` in the caller's hands is never rewritten, from start to finish.

**Part two: the input is too long.**

```text
=== Path two: input too long ===
Request 1  model=primary-model maxTokens=8000 messages=2 last=user: "Write a long report"
Request 2  model=primary-model maxTokens=8000 messages=3 last=user: "Write a long report"
First message of request 2, role = system
Second message of request 2 contains compacted_history = true
Final content = "Success after compaction"
state.hasAttemptedReactiveCompact = false
```

Note that `maxTokens` does not change. An over-long input and a truncated output are two different things. One cannot substitute for the other. The first message is still the system message. The second message is now the compaction summary.

**Part three: consecutive overloads.**

```text
=== Path three: consecutive 529s switch to the fallback ===
Model used by each request = ["primary-model","primary-model","primary-model","fallback-model"]
Actual sleep seconds (jitter injected as 0) = [0.5,1,2]
```

Three 529s, three backoffs, and only the fourth request changes the model. This line `["primary-model","primary-model","primary-model","fallback-model"]` is the literal meaning of "switch to the fallback after 3 consecutive 529s".

The three paths behave completely differently on the outside. To the outer Loop, however, they are all just "`complete()` returned a usable `ModelReply`".

---

## Three Failures, Three Paths

The three failures all look like "the model gave no usable answer", but their trigger signals and recovery actions are completely different:

| Failure      | Provider-Independent Signal                                        | Recovery Action                                        |
| ------- | ---------------------------------------------- | ------------------------------------------- |
| Output truncated   | `ModelReply.finishReason === "length"`         | Raise the output budget on the first occurrence; after that, continue inside the request window                         |
| Input context too long | `ModelPromptTooLongError`                      | Keep the current system prompt, and apply reactive compaction to the request snapshot once              |
| Temporary failure    | `ModelRateLimitError` / `ModelOverloadedError` | Obey `Retry-After` or use exponential backoff; switch to the fallback after 3 consecutive 529s |

**Why one generic retry path cannot solve all three.** Look at the counterexamples one by one:

- A retry of the original request is meaningless when the output is truncated. The budget does not change, so the second attempt truncates at the same position. This case needs a **parameter change** (raise the budget) or a **request content change** (append a continuation prompt). It does not need a resend.
- A retry is worse when the input is too long. The request has not lost a single byte, so one hundred retries all return the same 400. This case needs a **smaller input**.
- A 429 or 529 is the exact opposite. The request itself is fully correct, and the only correct action is to **change nothing, wait a while, and send it again**. A content change may introduce a new problem.

A generic path will do the wrong thing in at least two of the three cases. The three paths therefore live together inside `RecoveryManager.complete()`, but **internally they are three independent branches**.

The duties of the public `AgentRunner` do not change at all. It assembles the current request, executes tools, appends the final reply, and runs hooks. The recovery layer never re-enters the outer Loop, so one API retry is not counted as a new Agent turn.

A fourth case needs a separate statement: **an unrecognized error**. A 500, a 503, a connection reset, a DNS failure, a TLS handshake failure, and a `TypeError` from the program itself are all thrown as they are. The code does not retry them even once.

```text
=== Unknown error: thrown as it is, no retry ===
Throws TypeError: undefined is not a function
Is it the same object = true
Actual request count = 1
Sleep count = 0
```

`Is it the same object = true` is an intentional assertion. The code passes the error object through unchanged. It does not wrap it, and it does not lose the stack. A later section, "What This Chapter Does Not Do", explains again why this conservative choice is correct.

---

## Normalize the Error First; Never Match Exception Text

Many code samples classify a failure like this:

```python
# Counterexample, do not write code like this
if "429" in str(exc):
    retry()
elif "prompt" in str(exc):
    compact()
```

This misclassifies in three situations:

1. A business error message happens to contain `429` (for example, a user enters an order number `INV-429`);
2. An HTML error page from a reverse proxy contains the word `prompt`;
3. An exception message from the program itself contains these words — a bug that should be exposed at once turns into a silent retry.

The current implementation restricts the provider object strictly to one file: [openai-chat.ts](code/chapters/ch11/src/adapters/openai-chat.ts). It is the only file in the whole project that imports the OpenAI SDK. The adapter reads only the stable structure of the SDK:

- `APIError.status`
- `APIError.error`
- `APIError.headers`
- `APIError.requestID`

The classification rules are explicit:

```typescript
const PROMPT_TOO_LONG_CODES = new Set([
  "context_length_exceeded",
  "max_context_window",
  "prompt_is_too_long",
  "prompt_too_long",
]);

if (status === 429) {
  const retryAfter = headers.get("retry-after");
  throw new ModelRateLimitError("OpenAI request was rate limited", {
    ...(retryAfter === null ? {} : { retryAfter }),
  });
}

if (status === 529) {
  throw new ModelOverloadedError("OpenAI model was overloaded");
}

if (status === 400 && errorCode !== undefined && PROMPT_TOO_LONG_CODES.has(errorCode)) {
  throw new ModelPromptTooLongError("OpenAI prompt exceeded the model context window");
}
```

`errorCode` may come only from a flat `error.code` / `error.type`, or from at most one level of nesting at `error.error.code` / `error.error.type`. The implementation does not read `message`. It does not search arbitrary JSON recursively. It does not guess from an exception string.

### Measured Classification Results

The 14 lines below are the real classification results after various error objects are fed to the adapter (see "Experiment Five" for the script):

```text
=== Error classification: structured fields only ===
APIError 429                                 -> normalized to ModelRateLimitError
APIError 429 + retry-after header                 -> normalized to ModelRateLimitError
APIError 529                                 -> normalized to ModelOverloadedError
APIError 400 code=context_length_exceeded    -> normalized to ModelPromptTooLongError
APIError 400 code=prompt_too_long            -> normalized to ModelPromptTooLongError
APIError 400 nested error.code=prompt_too_long   -> normalized to ModelPromptTooLongError
APIError 400 code=PROMPT_TOO_LONG (uppercase)        -> normalized to ModelPromptTooLongError
APIError 400 code=unknown_bad_request        -> thrown as it is, Error
APIError 400 message says prompt is too long   -> thrown as it is, Error
APIError 500                                 -> thrown as it is, Error
APIError 503                                 -> thrown as it is, Error
Plain Error, string contains 429                           -> thrown as it is, Error
Forged object: has status=429 but is not an APIError               -> thrown as it is, Error
Connection-level error ECONNRESET                             -> thrown as it is, Error
```

Four lines deserve a separate note:

- `code=PROMPT_TOO_LONG (uppercase)` **is recognized**. The code converts the value to lowercase before it recognizes it, because inconsistent casing between endpoints is a common phenomenon.
- `message says prompt is too long` **is not recognized**. Message text is not a contract. One wording change makes it invalid.
- `Plain Error, string contains 429` **is not recognized**. This is exactly the trap that text matching falls into.
- `Forged object: has status=429 but is not an APIError` **is not recognized**. The check uses `instanceof APIError`. It does not check "does it have a `status` field". Duck typing is a vulnerability here, not flexibility.

### Type and Status Are Invariants

The three internal exception types are defined in [model.ts](code/chapters/ch11/src/core/model.ts). The constructor locks the status:

| Error Class | Allowed Status | Extra Information It Carries |
| --- | --- | --- |
| `ModelRateLimitError` | Must be 429 | Optional raw `retryAfter` string |
| `ModelOverloadedError` | Must be 529 | None |
| `ModelPromptTooLongError` | Must be 400 | None |

The recovery layer can therefore dispatch by TypeScript type. It never receives a semantically contradictory object such as "the type says rate limit but the status is 500". An attempt to construct a contradictory object fails in the constructor. It does not appear as strange behavior inside the recovery logic.

### An HTTP 200 Is Also an Untrusted Boundary

Everything above discusses a "failed request". But a 200 from the provider does not mean the structure is trustworthy. A field can be missing, a type can be wrong, and an unseen enum value can appear. Before `normalizeResponse()` hands the response to the recovery layer, it validates the response field by field:

- There must be exactly one `choice`;
- `message.role` must be `assistant`;
- `finish_reason` must fall inside the allowlist;
- `content` must be `string | null`; when `refusal` is a string, the code can fall back to it as the final content;
- Every item in `tool_calls` must carry a complete `id`, `name`, and `arguments`;
- The three `usage` counts must be non-negative integers.

The 13 measured response kinds (see "Experiment Five" for the script):

```text
=== Successful response: validate a 200 field by field as well ===
Standard stop reply                     -> Pass: content="done" finishReason=stop
finish_reason=content_filter   -> Pass: content="Partial content" finishReason=content_filter
content=null but has refusal        -> Pass: content="I cannot help." finishReason=stop
choices is an empty array                   -> OpenAIResponseError: Chat completion must return exactly one choice
choices has two entries                    -> OpenAIResponseError: Chat completion must return exactly one choice
finish_reason is an unknown new value            -> OpenAIResponseError: Unsupported finish_reason: max_output_reached
role is not assistant              -> OpenAIResponseError: Chat completion message role must be assistant
tool_calls missing id                -> OpenAIResponseError: Invalid function tool call: tool call id must be a string
Legacy function_call               -> OpenAIResponseError: Legacy function_call responses are unsupported
usage.prompt_tokens is negative        -> OpenAIResponseError: Chat completion usage field prompt_tokens must be non-negative integer
usage missing total_tokens           -> OpenAIResponseError: Chat completion usage field total_tokens must be non-negative integer
usage has all three counts                     -> Pass: content="done" finishReason=stop
Response root is not an object                        -> OpenAIResponseError: Chat completion response must be an object
```

Three boundaries are easy to overlook:

**An unknown `finish_reason` value fails directly. The code does not treat it as `stop`.** The provider adds a new enum value (for example `max_output_reached`). Lenient handling would make the recovery layer accept a truncated reply as a complete reply. The answer then loses a section, and nobody knows. A clear failure is better than a silent error.

**`content_filter` can pass through the adapter.** It is a legal OpenAI `finish_reason`, and the duty of the adapter is to pass provider semantics through faithfully. The Loop decides whether to accept it in the end. A later section, "Connect to the Single Loop", explains at which layer it is rejected.

**A `refusal` can serve as content.** When the model refuses to answer, `content` is `null`, but `refusal` holds text. Treating it as the final content is closer to the real semantics than making the Loop throw "the model gave neither text nor a tool call".

The request side has a wire format mapping in the opposite direction. `toOpenAIMessage()` converts an internal `ChatMessage` into OpenAI message parameters (`system` / `user` map directly, a `tool` message must carry a `tool_call_id`, and an `assistant` message attaches `tool_calls` when it needs them). `toOpenAITool()` maps an internal tool schema in a fixed way to `type: "function"` plus `name` / `description` / `parameters`.

One sentence summarises the value of this layer: **the core does not import the OpenAI SDK. All provider details stay inside the adapter.** The recovery layer always faces the stable contract in model.ts. When the provider changes, a change to the adapter is enough.

---

## Path One: Output Truncation Exists Only Inside the Request Window

`finishReason === "length"` is a **normal response**. Its status is HTTP 200. It is not an exception. It means the model hit the `max_tokens` limit. It was cut off before it finished speaking.

When the recovery layer meets it for the first time, it does two things. It raises the output budget from 8000 to 64000. It then **discards the incomplete reply in full** and resends the same request:

```typescript
if (reply.finishReason === "length" && !state.hasEscalated) {
  state.currentMaxTokens = config.escalatedMaxTokens;
  state.hasEscalated = true;
  continue;
}
```

Why does the first attempt discard the whole reply instead of continuing from the break point? After the budget rises, the model may write the full reply in one pass. One coherent, complete reply has better quality than "a fragment + a splice". The few tokens that the discard wastes buy a better output structure. The trade is worth it.

`RecoveryConfig` validates `escalatedMaxTokens <= modelMaxTokens` in its constructor:

```text
escalatedMaxTokens > modelMaxTokens      -> RangeError: escalatedMaxTokens must not exceed modelMaxTokens
initialMaxTokens >= escalatedMaxTokens   -> RangeError: escalatedMaxTokens must exceed initialMaxTokens
```

The code cannot discover the budget by trial and error, in the style of "send the request first and see whether the provider accepts it". That style wastes one real request and one real wait for every configuration error.

### Only When the Output Still Truncates After the Escalation Does Continuation Begin

Only then does the code append the fragment and the continuation prompt, and it appends them only to the **local snapshot** `requestMessages`:

```typescript
const fragment = reply.message.content;
if (reply.message.toolCalls.length > 0 || fragment === null || fragment.length === 0) {
  throw new RecoveryRetriesExhausted(
    "length recovery requires a non-empty text-only assistant fragment",
  );
}
if (state.recoveryCount >= this.#config.maxContinuations) {
  throw new RecoveryRetriesExhausted("continuation recovery attempts exhausted");
}

fragments.push(fragment);
requestMessages = Object.freeze([
  ...requestMessages,
  reply.message,
  userMessage(CONTINUATION_PROMPT),
]);
```

The continuation prompt is one fixed sentence:

```typescript
export const CONTINUATION_PROMPT =
  "Continue exactly where you left off. Do not repeat any text, no apology, no recap. Pick up mid-thought.";
```

Each of the three requirements has a reason. `Do not repeat any text` prevents repeated body text. `no apology` prevents the model from writing text such as "Sorry, I was cut off just now", which is meaningless to the final reader. `Pick up mid-thought` states explicitly that the model may continue from the middle of a sentence. It does not need to force a new paragraph.

### Measured Request Counts

The default `maxContinuations` is 3. If the model keeps truncating, how many requests does the code actually send?

```text
=== Default maxContinuations=3, truncating every time ===
Throws RecoveryRetriesExhausted: continuation recovery attempts exhausted
Actual request count = 5
Messages per request = [2,2,4,6,8]
state.recoveryCount = 3
```

5 requests = 1 initial + 1 budget escalation + 3 continuations. The message count sequence `[2,2,4,6,8]` is easy to read. The budget escalation request keeps the same message count (the incomplete reply is discarded). After that, each continuation adds two messages (the partial reply + the continuation prompt).

Setting `maxContinuations` to 0 turns continuation off:

```text
=== maxContinuations=0: continuation turned off directly ===
Throws RecoveryRetriesExhausted: continuation recovery attempts exhausted
Actual request count = 2
```

Only "initial + budget escalation" remain. If the second reply still truncates, the code fails at once. This is a legal configuration. The constructor does not report an error.

### A Truncated Reply with tool_calls Fails at Once

```text
=== Truncated fragment has tool_calls: fails at once, no matter how many continuations remain ===
Throws RecoveryRetriesExhausted: length recovery requires a non-empty text-only assistant fragment
Actual request count = 2
state.recoveryCount = 0 (no continuation happened at all)
```

Note `recoveryCount = 0`. This is not "the continuation count is used up". It is "**continuation must not happen at all**". A truncated `tool_calls` argument may hold only half a JSON document. Splicing it as a fragment produces a tool call that no parser can read. Appending it to the history is worse. It leaves an orphan call that waits forever for a `tool` result. The code therefore chooses to fail at once.

An empty string fragment follows the same logic:

```text
=== Empty string fragment: rejected as well ===
Throws RecoveryRetriesExhausted: length recovery requires a non-empty text-only assistant fragment
Actual request count = 2
```

If an empty fragment were allowed, an endpoint that repeatedly returns an empty string plus `length` would make the recovery layer run three useless continuation rounds. It would splice them into an empty answer at the end.

### The Code Merges Only at the Moment of Final Success

The merge happens only at the moment of a successful return. The rule is "splice exactly as the text is; do not add a space automatically":

```typescript
function mergeFragments(reply: ModelReply, fragments: readonly string[]): ModelReply {
  if (fragments.length === 0) {
    return reply;
  }
  return Object.freeze({
    ...reply,
    message: {
      ...reply.message,
      content: `${fragments.join("")}${reply.message.content ?? ""}`,
    },
  });
}
```

Not adding a space is deliberate. An inserted space inside Chinese text, code, or a URL is an error. The model is told to "continue where the previous sentence stopped", so no extra blank should exist in the first place.

The final reply keeps its tool calls in full:

```text
=== Final reply has tool_calls: fragments merge as usual, tool calls stay complete ===
Final content = "I will say one half first, then the other half, then call a tool."
Final finishReason = tool_calls
Final toolCalls = [{"id":"call-final","name":"read_file","arguments":"{\"path\":\"README.md\"}"}]
```

Only this one merged message can return to the public Loop and enter the canonical history. This boundary solves two problems at the same time:

- The first incomplete reply, the continuation prompt, and the intermediate fragments never pollute the conversation history;
- A truncated response with incomplete `tool_calls` is never appended, so the design avoids an orphan tool call at the source.

---

## Path Two: An Over-Long Input Compresses the Request Snapshot Only Once

An over-long input comes from the `ModelPromptTooLongError` that the adapter throws. It and `finishReason === "length"` are two completely different things. One cannot replace the other:

| | Input Too Long | Output Truncated |
| --- | --- | --- |
| HTTP status | 400 | 200 |
| Form | Throws an exception | Returns normally, `finish_reason` is `length` |
| Root cause | The request is too large, and the model never starts to generate | The request is fine, but the answer cannot be written in full |
| Correct action | Shrink the input | Raise the output budget or continue |
| What happens if you take the wrong action | You keep raising the budget, the request still exceeds the window, and the attempts run in vain | You keep compacting the history, the answer is still truncated, and you lose context as well |

The recovery layer reuses the `CompactionManager.compactOnPromptTooLong()` from Chapter 8 directly:

```typescript
const [leadingSystem, compactableHistory] = splitLeadingSystem(requestMessages);
const outcome = await runBounded((signal) =>
  compaction.compactOnPromptTooLong(
    compactableHistory,
    { retryCount: promptTooLongRetries },
    signal,
  ),
);
requestMessages = Object.freeze([...leadingSystem, ...outcome.history]);
```

`splitLeadingSystem` does one small thing. If the first message is a system message, it removes it and keeps it separate. Compaction acts only on the messages after it. After compaction, the code puts the system message back in the first position.

Why is this step necessary? The system prompt from Chapter 10 is **dynamically rendered in every turn**. It holds the current tool list, the workspace path, and the selected memory. If compaction folds it into a summary, the model no longer knows which tools it has or which directory it can operate in. The measured run confirms that it stays in place:

```text
First message of request 2, role = system
Second message of request 2 contains compacted_history = true
```

The request snapshot after this point is compacted by **complete message group**. All `tool_calls` of an assistant message and the corresponding `tool` results remain an indivisible unit. This rule comes from Chapter 8. This chapter inherits it directly.

### No Original Array Is Modified

The canonical history, the `ModelRequest` that the caller passes in, and the read-only message snapshot are all unmodified. `requestMessages` is a local variable inside `complete()`. The code creates a new array with `Object.freeze` each time.

The reactive transcript records "the **request snapshot** before compaction". It is not an alias of the canonical history. The proactive compaction transcript from Chapter 8 still owns the full conversation trace. The two transcripts have different purposes. Do not confuse them.

### One Logical Request Compacts Only Once

```text
=== Path two: a second over-long input fails directly ===
Throws PromptTooLongRetryError: prompt-too-long compaction was already attempted
Actual request count = 2
```

Why is a second compaction not allowed? One compaction has already run, and the input still exceeds the window. The problem is therefore not "the history is too long". It lies somewhere else. A single user message may itself exceed the window. One tool may have returned a giant result. Or the real window of the model may be smaller than the value in the configuration. Repeated compaction in these cases only grinds away useful context bit by bit. In the end, it sends a request that has no context and still fails.

One state bit is easy to misread, and it needs a clarification. `state.hasAttemptedReactiveCompact` resets to `false` when the call returns successfully:

```text
Final content = "Success after compaction"
state.hasAttemptedReactiveCompact = false
```

It is not a persistent record of "this turn compacted once". The local counter `promptTooLongRetries` inside `complete()` is what really blocks a second compaction. `hasAttemptedReactiveCompact` is only a transient marker for external observation. If you want to assert in a test that "compaction happened", look at the failure path, or observe the transcript files.

The compaction and its model summary also sit inside the same cancellation and deadline boundary. A summary call cannot bypass the deadline. The summary itself can also fail. In that case, the code rolls back the transcript that the summary wrote to disk, together with the summary:

```text
=== Scenario three: a summary failure rolls back the transcript ===
Throws Error: The summary model itself failed
Is the summary failure thrown as it is = true
Contents of the artifacts directory = []
Model call count = 1 (no further retry)
```

`Contents of the artifacts directory = []` is the key assertion. A summary failure leaves no half-written transcript.

---

## Path Three: 429, 529, Retry-After, and the Fallback

A 429 and a 529 share one transient retry path. They differ in only two points. A 529 accumulates the consecutive counter. A 429 reads `Retry-After`.

### The Backoff Curve

Without a valid `Retry-After`, the default backoff baseline is `0.5 × 2^attempt`, with a cap of 32 seconds. Inject jitter as a constant 0, and you can see a clean curve:

```text
=== Complete backoff curve (jitter injected as 0, 10 attempts exhausted) ===
sleep sequence = [0.5,1,2,4,8,16,32,32,32]
Total sleep seconds = 127.5
Actual request count = 10
Throws RecoveryRetriesExhausted: rate limit recovery attempts exhausted
```

**Note: 10 requests, but only 9 sleeps.** This is not an off-by-one error. It is the correct behavior. At the tenth failure, the attempt count is exhausted. The code throws at once. It has no reason to sleep again.

When jitter takes its maximum (`base × 25%`):

```text
=== Jitter at maximum (jitter returns the upper bound = base × 25%) ===
sleep sequence = [0.625,1.25,2.5,5,10,20,40,40,40]
Total sleep seconds = 159.375
```

Every item is 1.25 times the no-jitter version. The total wait is 159.375 seconds. Note that the three items after the cap become 40 seconds. `maxDelaySeconds = 32` caps the **baseline**. The code adds jitter after the cap. This is deliberate. The purpose of jitter is to spread out requests that would wake at the same moment. If the cap also clamped the jitter hard at 32 seconds, a batch of clients that were rate limited at the same time would still retry in the same second.

In table form:

| Failure Number | Baseline (jitter=0) | Jitter at Maximum | Cumulative (Jitter at Maximum) |
| --- | --- | --- | --- |
| 1 | 0.5 | 0.625 | 0.625 |
| 2 | 1 | 1.25 | 1.875 |
| 3 | 2 | 2.5 | 4.375 |
| 4 | 4 | 5 | 9.375 |
| 5 | 8 | 10 | 19.375 |
| 6 | 16 | 20 | 39.375 |
| 7 | 32 (cap) | 40 | 79.375 |
| 8 | 32 | 40 | 119.375 |
| 9 | 32 | 40 | 159.375 |
| 10 | No sleep, exhausted directly | — | — |

The last column explains where the default `totalTimeoutSeconds = 300` comes from. In the worst case, waiting alone takes 159 seconds. Add the time of the 10 real requests themselves. 300 seconds is then the order of magnitude that "runs all retries to completion, but does not leave the user hanging until dawn". This value is not a guess.

### Retry-After Has Priority, but the Code Must Parse It Strictly

When a 429 carries `Retry-After`, the instruction from the server has priority over local backoff:

```text
=== Path three: a 429 obeys Retry-After ===
Actual sleep seconds = [3.25] (not the backoff baseline 0.5)
Model used by each request = ["primary-model","primary-model"]
```

The parsing rules are strict. The measured results for 14 input kinds (the injected current time is `2026-08-28T12:00:00.000Z`):

```text
=== Retry-After parsing rules ===
"0"                                  -> sleep 0 seconds
"3"                                  -> sleep 3 seconds
"3.25"                               -> sleep 3.25 seconds
" 7 "                                -> sleep 7 seconds
"-1"                                 -> InvalidRetryAfterError
""                                   -> InvalidRetryAfterError
"NaN"                                -> InvalidRetryAfterError
"Infinity"                           -> InvalidRetryAfterError
"1e2"                                -> InvalidRetryAfterError
"Fri, 28 Aug 2026 12:00:05 GMT"      -> sleep 5 seconds
"Fri, 28 Aug 2026 11:59:50 GMT"      -> sleep 0 seconds
"2026-08-28T12:00:30.000Z"           -> InvalidRetryAfterError
"2026-08-28T12:00:30"                -> InvalidRetryAfterError
"not-a-date"                         -> InvalidRetryAfterError
```

As a rule table:

| Input Form | Result | Reason |
| --- | --- | --- |
| A non-negative decimal number of seconds (fractions allowed) | Accept | The delta-seconds form in the HTTP specification |
| Spaces at both ends | Accept | The code calls `trim()` before it parses |
| `0` | Accept, wait 0 seconds | The server says a retry is possible at once, so retry at once |
| A negative number | Reject | There is no semantics of "wait backwards" |
| Empty string / `NaN` / `Infinity` | Reject | Not a valid number of seconds |
| `1e2` | Reject | Scientific notation is not in the delta-seconds grammar. Tolerating it means tolerating any garbage that `Number()` can parse |
| An HTTP-date with `GMT` / `UTC` / `±HHMM` | Accept, compute the difference | It has a clear time zone, so it determines one unique moment |
| An HTTP-date that is already in the past | Accept, wait 0 seconds | The difference takes `max(0, ...)` |
| ISO-8601 with `Z`, such as `2026-08-28T12:00:30.000Z` | **Reject** | See the explanation below |
| A date string with no time zone | Reject | A local time zone interpretation makes the same header produce different results on different machines |
| Any non-date text | Reject | It cannot be parsed |

The rejection of ISO-8601 with `Z` is the easiest rule to trip over. Semantically it clearly means UTC, but the time zone check in the current implementation is this regular expression:

```typescript
/(?:\b(?:GMT|UTC)\b|[+-]\d{4})$/i
```

It recognizes only a trailing `GMT`, `UTC`, or `±HHMM`. It does not recognize a single `Z`. In the HTTP specification, the date form of `Retry-After` is an HTTP-date (IMF-fixdate). It does not include ISO-8601. Strictly speaking, this strictness **follows the specification**. It is not a bug. But if your endpoint really returns ISO times, you will see `InvalidRetryAfterError`. In that case, change the regular expression. Do not loosen the whole parser.

The behavior for an illegal `Retry-After` is clear: **no sleep, no retry, throw `InvalidRetryAfterError` directly**. The endpoint returned a header that breaks the contract, so its rate limit semantics are not trustworthy. Guessing a duration from your own backoff at that point will very likely collide with the same rate limit window.

### Switch to the Fallback Only After Consecutive 529s

```typescript
state.consecutive529 += 1;
if (state.consecutive529 >= config.overloadFallbackThreshold) {
  state.currentModel = config.fallbackModel;
  state.consecutive529 = 0;
}
```

The default threshold is 3. At the third 529, the code updates the state and completes the current backoff. Only the **next request** (that is, the fourth) explicitly carries the fallback model. Look back at the output at the start of this chapter:

```text
Model used by each request = ["primary-model","primary-model","primary-model","fallback-model"]
Actual sleep seconds (jitter injected as 0) = [0.5,1,2]
```

The word "consecutive" is literal. A 429, an over-long input, and a successful response all reset the counter to zero:

```text
=== A 429 interrupts the consecutive 529 count ===
Model used by each request = ["primary-model","primary-model","primary-model","primary-model","primary-model"]
sleep sequence = [0.5,1,2,4]
Note: 529 -> 529 -> 429 -> 529, the 429 resets the consecutive count, so the code never switches to the fallback
```

The three 529s add up, but a 429 sits in the middle, so the primary model serves every request from start to finish. Why is the rule this strict? "Consecutive overload" is the evidence that the primary model is really unavailable. "Occasional overload" is normal fluctuation. A 429 in the middle proves that the request did reach the primary model and that the model processed it normally (it only applied a rate limit). It is not a reason to switch.

Note the `sleep sequence = [0.5,1,2,4]`. The backoff `attempt` uses the **total count of transient failures**. It does not distinguish a 429 from a 529. The fourth failure therefore waits 4 seconds. It does not restart at 0.5 seconds because "the 529 count reset". This matches intuition. Backoff fights "failure in general". An error type switch must not reset it.

---

## Cancellation and the Deadline Are Part of Recovery

The retry count is not the only boundary. The previous section computed the numbers: 10 backoffs at maximum jitter wait 159 seconds on waiting alone. If each real request also takes more than ten seconds, one turn can stretch past five minutes. The default total deadline for a turn is therefore 300 seconds. A test or a caller can shorten it explicitly:

```typescript
const config = new RecoveryConfig({
  primaryModel: "primary-model",
  fallbackModel: "fallback-model",
  initialMaxTokens: 8_000,
  escalatedMaxTokens: 64_000,
  modelMaxTokens: 64_000,
  maxContinuations: 3,
  maxTransientAttempts: 10,
  totalTimeoutSeconds: 300,
});
```

### Five Injectable Boundaries

`RecoveryManager` makes everything that "deals with the real world" an injectable dependency. This is the reason the offline tests in this chapter can be exact to the decimal point:

| Injection Point | Default Implementation | What a Test Replaces It With |
| --- | --- | --- |
| `monotonic` | `performance.now() / 1000` | A fake clock that the test advances by hand |
| `utcNow` | `() => new Date()` | A fixed moment, so a `Retry-After` date difference is predictable |
| `sleeper` | A real `setTimeout` | Records the seconds and advances the fake clock, without a real wait |
| `jitter` | `Math.random() * upperBound` | A constant 0 or a constant upper bound, for a deterministic curve |
| `cancellation` | A new `CancellationToken` | Held externally, and the test calls `cancel()` by hand |

A monotonic clock and a UTC clock are separate for a reason. A deadline calculation must use a monotonic clock (an NTP adjustment of the system time cannot break it). A `Retry-After` date difference must use a real UTC clock (it must align with the moment the server states). If one clock serves both jobs, one of the two jobs will certainly be wrong.

### Fail at Once When the Time to Fail Has Come

If a wait would reach or cross the remaining time of the current turn, the recovery layer throws `RecoveryDeadlineExceeded` directly. It does not sleep past the timeout first and report the failure afterwards:

```text
=== Scenario one: the sleep would cross the deadline ===
Retry-After = 30 seconds, remaining deadline = 10 seconds
Throws RecoveryDeadlineExceeded: retry delay would reach or cross the turn deadline
Did it really sleep = false
Model call count = 1
```

`Did it really sleep = false` is the whole point of this design. The opposite approach is "sleep 30 seconds first, wake up, discover the timeout, then report the error". The user waits 30 seconds in vain and receives the same failure.

### Cancellation Waits Until the Operation Really Settles

```typescript
async #runBounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  this.#raiseIfCancelled();
  const remaining = this.#remainingSeconds();
  const controller = new AbortController();
  // ...
  const result = await Promise.race([operationPromise, deadlinePromise, cancellationPromise]);
```

`#runBounded()` wraps three places in a uniform way: the model call, the backoff sleep, and reactive compaction. Each time it does the same thing. It checks cancellation and the deadline first. It then lets "operation / timeout / cancellation" race. Finally, it passes the same `AbortSignal` down to the layer below.

On cancellation or timeout, it calls `abort()` first and then awaits the settling of the operation:

```typescript
} catch (error) {
  if (error instanceof RecoveryCancelledError || error instanceof RecoveryDeadlineExceeded) {
    controller.abort();
    await operationPromise.catch(() => undefined);
  }
  throw error;
}
```

The line `await operationPromise.catch(...)` looks redundant. It is in fact the key. Without it, `complete()` would return while the aborted request is still in flight. The process would keep a background operation that may still write a file and may still call back. The measured run:

```text
=== Scenario two: cancel a model call in progress ===
The model request is sent, then cancel() is triggered
Throws RecoveryCancelledError: recovery turn was cancelled
Model-side signal.aborted = true
Model-side operation settled = true
```

The last two lines verify two separate facts. "The signal really went down." And "the aborted operation really ended."

The contract of `CancellationToken` is also explicit. `cancel()` is idempotent. It fires only once. After it fires, it clears the listeners. `subscribe()` rejects a non-function argument. If the token is already cancelled, a new subscription **executes at once** and returns a no-op unsubscribe function. The last rule guards against a race: a subscription that arrives one step late would otherwise wait forever for a notification.

### Five Typed Failures

Every exhaustion path has its own error class. The caller decides by type. It does not read message text:

| Error Class | When the Code Throws It | How to Handle It |
| --- | --- | --- |
| `RecoveryRetriesExhausted` | Continuation count used up, transient attempts used up, fragment not legal | It really failed. Report it to the user |
| `RecoveryDeadlineExceeded` | Not enough time remains, or an operation ran past the deadline | Shrink the task, or raise `totalTimeoutSeconds` |
| `RecoveryCancelledError` | An external `cancel()` is called | A normal path. It does not need an error report |
| `InvalidRetryAfterError` | The `Retry-After` from the server breaks the rules | Check the endpoint implementation, or loosen the parsing as needed |
| `PromptTooLongRetryError` | The input is still too long after one compaction | Check for a single giant message or tool result |

All of them extend `RecoveryError`. Code that wants to catch all recovery failures in one place can write `catch (e) { if (e instanceof RecoveryError) ... }`. Code that wants an exact distinction uses the concrete class.

---

## Connect to the Single Loop; Do Not Copy the Loop

The easiest wrong step is "copy the Loop, change the copy, and gain recovery that way". That step splits the system at once into two hook orders and two sets of history maintenance rules. Every later capability then needs a change in two places.

This chapter takes a different approach. It adds **one narrow protocol** to the public runtime. The protocol has only two methods:

```typescript
export interface ModelRequestExecutor {
  beginTurn(): void;
  complete(request: ModelRequest): Promise<ModelReply>;
}
```

`AgentRunner.run()` calls `beginTurn()` once, after the existing memory turn lifecycle:

```typescript
// The executor aligns its turn boundary with the memory lifecycle; without an injection, P01-P10 call the ModelClient directly as before.
this.#modelRequestExecutor?.beginTurn();
```

At the model boundary, the code then chooses one of two paths:

```typescript
const reply = await (this.#modelRequestExecutor === undefined
  ? this.#model.complete(request)
  : this.#modelRequestExecutor.complete(request));
```

### Why It Must Split into the Two Methods beginTurn and complete

`beginTurn()` resets the **recovery state that crosses requests**: the current model (it may already have switched to the fallback), the current output budget (it may already have been escalated), the consecutive 529 count, and the deadline start point.

```typescript
beginTurn(): void {
  const startedAt = this.#monotonicNow();
  this.#state = {
    currentModel: this.#config.primaryModel,
    currentMaxTokens: this.#config.initialMaxTokens,
    hasEscalated: false,
    recoveryCount: 0,
    consecutive529: 0,
    hasAttemptedReactiveCompact: false,
  };
  this.#deadline = startedAt + this.#config.totalTimeoutSeconds;
}
```

The lifetime of this state is "one Agent turn". `complete()` runs many times inside one turn (after every round of tool calls, the code asks the model again). If the reset sat inside `complete()`, the state would switch to the fallback in one round and return to the primary model in the next round. The deadline would also restart its clock in every round. The total deadline would then exist in name only.

Conversely, if the caller forgets `beginTurn()`, the code fails at once. It does not run silently on default values:

```text
=== Scenario five: beginTurn forgotten ===
Throws RecoveryError: Recovery turn has not been started
```

### An Internal Retry Re-Runs No Hook

This is the practical meaning of "one logical request". Inside `complete()`, no number of retries re-runs any of these:

- The UserPrompt Hook
- Request history preparation (`historyProcessor.prepare()`)
- Dynamic system prompt rendering
- The tool schema snapshot
- The Stop Hook

The outer layer still sees one model call. A test can measure this directly:

```text
=== Truncation recovery does not pollute the canonical history ===
finalText = "Complete answer"
turns = 1
canonical history:
  user: "Do the work"
  assistant: "Complete answer"
Main Loop request count = 2 (the outer layer counts only 1 turn)
Main Loop request maxTokens = [8000,64000]
Main Loop request model = ["primary-model","primary-model"]
Bypass request count (through the raw model) = 1
Bypass request model = ["undefined"]
```

This output is the one screen in this chapter that you should remember best (see "Experiment Six" for the full script). Read it line by line:

- **The canonical history has only two messages.** The discarded incomplete reply leaves no trace.
- **`turns = 1`.** The code sent 2 HTTP requests internally. The outer layer still counts one turn.
- **`maxTokens = [8000,64000]`.** The budget escalation really happened.
- **Bypass request `model = ["undefined"]`.** A call such as memory extraction carries no `model` field at all. This line is the topic of the next section.

### content_filter Fails Explicitly at the Loop Layer

The adapter can parse `content_filter`, because it is a legal OpenAI `finish_reason`. But a reply stopped by the content filter is neither a final answer nor a retryable transient error. loop.ts therefore rejects it before the code writes it into the history:

```typescript
// content_filter is an end state where the provider explicitly states "the reply was filtered"; it must not serve as final text or continue into a retry.
if (reply.finishReason === "content_filter") {
  throw new AgentRunError("Model response was blocked by the content filter");
}
```

```text
=== content_filter fails explicitly at the Loop layer ===
Throws AgentRunError: Model response was blocked by the content filter
Model request count = 1 (no retry)
```

The check sits at the Loop layer and not in the recovery layer because it is a **semantic judgement** (can this reply serve as the answer), not a **reliability judgement** (should this call be made again). The recovery layer owns only the second question.

### Reject a Caller Override of the Recovery State

`complete()` checks whether the caller tried to specify `model` or `maxTokens` itself:

```typescript
if (request.model !== undefined && request.model !== this.#config.primaryModel) {
  throw new RangeError("request.model must match RecoveryConfig.primaryModel");
}
if (
  request.maxTokens !== undefined &&
  (!Number.isInteger(request.maxTokens) ||
    request.maxTokens <= 0 ||
    request.maxTokens !== this.#config.initialMaxTokens)
) {
  throw new RangeError("request.maxTokens must match RecoveryConfig.initialMaxTokens");
}
```

The measured results for four input kinds:

```text
=== Scenario four: reject a caller override of the recovery state ===
model=another-model maxTokens=undefined    -> RangeError: request.model must match RecoveryConfig.primaryModel
model=undefined maxTokens=4000             -> RangeError: request.maxTokens must match RecoveryConfig.initialMaxTokens
model=undefined maxTokens=8000             -> Accepted, model called 1 time
model=primary-model maxTokens=undefined    -> Accepted, model called 1 time
```

The rule is "leave it empty, or fill it with a value that matches the starting point of the recovery layer". Why is it this strict? These two fields are exactly what the recovery state machine changes itself. `model` changes because of a fallback. `maxTokens` changes because of a budget escalation. If the caller may pass its own value in every round, it may reset the state machine to an uncertain position at any moment. Rather than letting this appear at run time as "the fallback mysteriously stopped working", the code reports the error at the wiring stage.

### The Composition Root: A Capability Bit and Its Configuration Must Come as a Pair

P01 to P10 do not inject an executor. They still call the raw `ModelClient` directly, and the original `length` guard remains as an explicit failure (`IncompleteModelReplyError`). Only the P11 bootstrap creates a `RecoveryManager`, and it requires an explicit `RecoveryConfig`:

```text
=== A capability bit and its configuration must come as a pair ===
P10 + recoveryConfig -> recoveryConfig requires chapter 11 or later
P11 without recoveryConfig -> recoveryConfig is required for chapter 11 or later
```

Both directions are blocked. Passing a recovery configuration to P10 is a configuration error (the capability bit is off, the configuration would never take effect, and a silent ignore is the worst outcome). Not passing a recovery configuration to P11 is more dangerous. If the code allowed it, P11 would **silently degrade to the raw ModelClient**. You would believe you have recovery, while you do not, and you would discover it at two in the morning in production.

A third check is a dependency relation:

```typescript
if (dependencies.recoveryConfig !== undefined) {
  if (compactionManager === undefined) {
    throw new Error("recovery capability requires compaction");
  }
```

Reactive compaction needs the `CompactionManager`, so the `recovery` capability must be built on top of `compaction`.

### The Summarizer Must Bind to the Bare Model

The bootstrap reuses one `CompactionManager` for proactive and reactive compaction (this keeps the protocol group splitting rule consistent). But the `ModelHistorySummarizer` still binds to the raw model:

```typescript
new CompactionManager({
  workspace: dependencies.workspace,
  summarizer: new ModelHistorySummarizer(dependencies.model),  // Note: model, not recovery
})
```

If the summarizer bound to the `RecoveryManager`, the path would become:

```text
Input too long → reactive compaction → summary request → recovery layer → the summary request itself is too long → compact again → ...
```

Every layer would still hold the deadline and the state of the layer above. The problem would appear as a "mysterious timeout", not as a clear stack overflow.

For the same reason, this chapter wraps only **main Loop requests**. The memory selector and extractor, the compaction summarizer, and one-shot subagents still use the raw model. That is the source of the line `Bypass request model = ["undefined"]` above: a bypass request carries no `model` field, because it never passes through the recovery layer.

Giving these bypass calls recovery capability needs a new session ownership contract (whose deadline? whose fallback state?). They cannot share the `RecoveryState` of the main Agent. This boundary is a deliberate line in this chapter. It is not an omission.

---

## Run Chapter 11

### Step 0: Prepare the Environment

```powershell
Set-Location 'F:\笔记\Agent实操\code'
node --version      # Needs Node 20 or above
npm install         # Run only the first time, or after the dependencies change
```

### Step 1: Run the Offline Tests First (No API Key Needed)

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch11
```

You should see:

```text
Test Files  28 passed (28)
     Tests  258 passed (258)
```

One line appears in the middle of the output:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**This is not an error report.** It is an expected output that `config.test.ts` asserts actively. The test verifies that "a missing configuration must report a clear error instead of degrading silently". As long as the last line says `passed`, everything is normal.

(This line lists only three fields, because that test runs `--chapter 1`. Chapter 1 does not need a fallback model.)

### Step 2: Configure Four Environment Variables

From Chapter 11 on, `.env` needs **four** fields. That is one more than the first ten chapters: `OPENAI_FALLBACK_MODEL`:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Copy-Item '.env.example' '.env'
notepad '.env'
```

The content of `.env.example` is these four lines:

```text
OPENAI_BASE_URL=
OPENAI_API_KEY=
OPENAI_MODEL=
OPENAI_FALLBACK_MODEL=
```

If you miss the fallback, startup fails at once. It does not wait until a real overload to let you discover it:

```text
Configuration Error: Missing required settings: OPENAI_FALLBACK_MODEL
```

If none of the four is configured, the error lists all four fields **at once**. You do not need to try them one by one:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_FALLBACK_MODEL
```

What should `OPENAI_FALLBACK_MODEL` contain? The most meaningful choice is **a model with a different capacity or a different deployment from the primary model**. When the primary model is continuously overloaded, a switch to an equally overloaded model brings no benefit. Filling it with the same name as the primary model is allowed (the configuration validation does not block it), but then the fallback only spins in place.

### Step 3: Run One Real Request

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch11 -- --prompt "Answer with one sentence only: which model name are you using now? Do not call any tool."
```

Actual output (what the model answers depends on the endpoint you configured):

```text
[Hook] UserPromptSubmit
[Hook] Stop
I am Claude, developed by Anthropic.
```

Each of the two `[Hook]` lines appears **once**. This is an implicit correctness signal in this chapter. The recovery layer sits inside the hooks, so an internal retry does not print them twice.

You can also use the unified entry point. The two forms share one P11 profile and one Loop:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run agent-tutorial -- run --chapter 11 --prompt "Check the current workspace and give a conclusion"
```

`--prompt` is a **named argument. You cannot omit it**. A positional argument fails at once:

```text
Runtime Failure: Unknown argument: Check the current workspace
```

The fixed entry point `ch11` already adds `--chapter 11` automatically. You do not need to pass it again.

### Step 4 (Optional): The Full Gates

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run typecheck
npm run lint
npm run format:check
```

### Troubleshooting Common Errors

| What You See | Cause | What to Do |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` (in the middle of test output) | An expected output that `config.test.ts` asserts | Ignore it. Check whether the last line says `passed` |
| `Configuration Error: Missing required settings: OPENAI_FALLBACK_MODEL` | You reused the three-field `.env` from the first ten chapters | Add the fourth field |
| `Runtime Failure: Unknown argument: ...` | You forgot `--prompt` | The argument must be named |
| `Error: recoveryConfig is required for chapter 11 or later` | You called `buildAgent(P11, ...)` by hand without a configuration | Pass a `RecoveryConfig`. This check blocks a "silent degradation to the bare model" |
| `Error: recoveryConfig requires chapter 11 or later` | You passed a recovery configuration to P10 or an earlier profile | The recovery configuration takes effect only at P11 and later. Remove it, or change the profile |
| `Error: recovery capability requires compaction` | You assembled a capability set with `recovery` but no `compaction` | Use the exported `P11` singleton |
| `RecoveryError: Recovery turn has not been started` | You called `complete()` directly, without `beginTurn()` first | Call `beginTurn()` once at the start of every turn |
| `RangeError: request.model must match RecoveryConfig.primaryModel` | The request specified a different model name itself | Do not override `model` in a request. The recovery layer decides the fallback |
| `RangeError: request.maxTokens must match RecoveryConfig.initialMaxTokens` | The request specified an output budget itself | The recovery layer escalates the budget. Do not write it in a request |
| `RangeError: escalatedMaxTokens must not exceed modelMaxTokens` | The escalated budget exceeds the model limit | Reduce `escalatedMaxTokens`, or raise `modelMaxTokens` |
| `RangeError: escalatedMaxTokens must exceed initialMaxTokens` | The two budget levels are reversed, or equal | The escalated level must be strictly greater than the initial level |
| `RangeError: baseDelaySeconds must not exceed maxDelaySeconds` | The backoff baseline is larger than the cap | Check these two values |
| `InvalidRetryAfterError: Retry-After is not seconds or an HTTP date` | The endpoint returned an ISO time or an illegal value | See the "Retry-After parsing rules" table. If you really must support ISO, change the regular expression |
| `PromptTooLongRetryError: prompt-too-long compaction was already attempted` | The input still exceeds the window after one compaction | Check for a single giant user message or a giant tool result |
| `RecoveryRetriesExhausted: continuation recovery attempts exhausted` | The continuation count is used up and the output still truncates | Split the task into smaller parts, or raise `maxContinuations` |
| `RecoveryRetriesExhausted: length recovery requires a non-empty text-only assistant fragment` | The truncated reply carries `tool_calls`, or its body is empty | This is a deliberate hard failure. See "Path One" |
| `RecoveryRetriesExhausted: rate limit recovery attempts exhausted` | All 10 attempts returned 429 | The quota really is not enough. Reduce concurrency, or change the key |
| `RecoveryDeadlineExceeded: retry delay would reach or cross the turn deadline` | The required wait exceeds the remaining time | Raise `totalTimeoutSeconds`, or accept this failure |
| `AgentRunError: Model response was blocked by the content filter` | The provider content filter matched | Change the prompt. This is not a retryable error |
| `OpenAIResponseError: Unsupported finish_reason: ...` | The endpoint returned an unknown end reason | First confirm the endpoint compatibility. Lenient handling introduces a silent truncation |
| A 500 / 503 / `ECONNRESET` thrown directly | This chapter deliberately does not retry these | See "What This Chapter Does Not Do" |

---

## Seven Hands-On Experiments

**None of the seven experiments calls a real model.** They need no API key, and they do not access the network. After you run them, you can verify every core conclusion in this chapter with your own hands.

First create a temporary directory:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType Directory -Force '.\scratch' | Out-Null
```

The first four experiments share one small utility file. It extracts the "scripted fake model + fully observable RecoveryManager" and removes duplicate code. Save it as `code\scratch\kit.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompactionManager, CompactionSummary } from "../chapters/ch11/src/features/compaction.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch11/src/core/model.js";
import { RecoveryConfig, RecoveryManager } from "../chapters/ch11/src/features/recovery.js";
import type { CancellationToken } from "../chapters/ch11/src/features/recovery.js";

// Returns replies or throws errors in script order, and records every request it receives
export class ScriptModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #actions: (ModelReply | Error)[];

  constructor(actions: readonly (ModelReply | Error)[]) {
    this.#actions = [...actions];
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const action = this.#actions.shift();
    if (action === undefined) {
      throw new Error("Script exhausted: no more requests may be sent");
    }
    if (action instanceof Error) {
      throw action;
    }
    return action;
  }
}

export interface KitOptions {
  readonly config?: RecoveryConfig;
  readonly jitter?: (upperBound: number) => number;
  readonly utcNow?: () => Date;
  readonly cancellation?: CancellationToken;
  readonly summarizerError?: Error;
  readonly realSleep?: boolean;
}

export interface Kit {
  readonly recovery: RecoveryManager;
  readonly workspace: string;
  readonly delays: number[];
  cleanup(): void;
}

// Assembles a fully observable RecoveryManager: a fake clock, a recording sleeper, injectable jitter
export function buildKit(model: ModelClient, options: KitOptions = {}): Kit {
  const workspace = mkdtempSync(join(tmpdir(), "kit-"));
  const delays: number[] = [];
  let clock = 1_000;
  const summarizer = {
    async summarize() {
      if (options.summarizerError !== undefined) {
        throw options.summarizerError;
      }
      return new CompactionSummary({
        currentGoal: "Compress the request back into the window",
        keyFindings: [],
        filesReadOrChanged: [],
        remainingWork: [],
        userConstraints: [],
      });
    },
  };
  const recovery = new RecoveryManager({
    model,
    compaction: new CompactionManager({
      workspace,
      summarizer,
      idGenerator: () => "kit-transcript",
    }),
    config:
      options.config ??
      new RecoveryConfig({ primaryModel: "primary-model", fallbackModel: "fallback-model" }),
    jitter: options.jitter ?? (() => 0),
    ...(options.utcNow === undefined ? {} : { utcNow: options.utcNow }),
    ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation }),
    ...(options.realSleep === true
      ? {}
      : {
          monotonic: () => clock,
          sleeper: async (seconds: number) => {
            delays.push(seconds);
            clock += seconds;
          },
        }),
  });
  return {
    recovery,
    workspace,
    delays,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}
```

Three design points in this file deserve attention. They are also a miniature of the test strategy in this chapter:

- `jitter` is injected as `() => 0` by default, so the backoff curve is **deterministic** and a test can assert it item by item.
- `sleeper` does not really wait. It only records the seconds and advances the fake clock. The 127.5 seconds of 10 backoffs run in under a millisecond in the measured run.
- `monotonic` is a fake clock that the code advances by hand. The deadline judgement is therefore fully controllable. Machine load does not affect it.

The output of every experiment below is a real run result. The random string in a temporary directory name **will differ when you run it**. That is normal.

### Experiment One: The Complete Trajectory of Each of the Three Recovery Paths

Save it as `code\scratch\exp1-paths.ts`:

```typescript
import { assistantMessage, systemMessage, userMessage } from "../chapters/ch11/src/core/messages.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../chapters/ch11/src/core/model.js";
import type { ModelRequest } from "../chapters/ch11/src/core/model.js";
import { ScriptModel, buildKit } from "./kit.js";

const original: ModelRequest = Object.freeze({
  messages: Object.freeze([systemMessage("system prompt"), userMessage("Write a long report")]),
  tools: Object.freeze([]),
});

function describe(request: ModelRequest): string {
  const tail = request.messages.at(-1);
  const preview =
    tail === undefined ? "(empty)" : `${tail.role}: ${JSON.stringify(tail.content).slice(0, 46)}`;
  return `model=${request.model} maxTokens=${request.maxTokens} messages=${request.messages.length} last=${preview}`;
}

console.log("=== Path one: output truncated ===");
{
  const model = new ScriptModel([
    { message: assistantMessage("This part will be discarded in full"), finishReason: "length" },
    { message: assistantMessage("First half."), finishReason: "length" },
    { message: assistantMessage("Second half."), finishReason: "stop" },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    const reply = await kit.recovery.complete(original);
    model.requests.forEach((request, index) => {
      console.log(`Request ${index + 1}  ${describe(request)}`);
    });
    console.log(`Final content = ${JSON.stringify(reply.message.content)}`);
    console.log(`Final finishReason = ${reply.finishReason}`);
    console.log(`Messages in the caller's original request = ${original.messages.length} (not rewritten)`);
    console.log(`state.recoveryCount = ${kit.recovery.state.recoveryCount}`);
    console.log(`state.hasEscalated = ${kit.recovery.state.hasEscalated}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Path two: input too long ===");
{
  const model = new ScriptModel([
    new ModelPromptTooLongError("too long"),
    { message: assistantMessage("Success after compaction"), finishReason: "stop" },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    const reply = await kit.recovery.complete(original);
    model.requests.forEach((request, index) => {
      console.log(`Request ${index + 1}  ${describe(request)}`);
    });
    console.log(`First message of request 2, role = ${model.requests[1]?.messages[0]?.role}`);
    console.log(
      `Second message of request 2 contains compacted_history = ${String(
        model.requests[1]?.messages[1]?.content.includes("compacted_history"),
      )}`,
    );
    console.log(`Final content = ${JSON.stringify(reply.message.content)}`);
    console.log(
      `state.hasAttemptedReactiveCompact = ${kit.recovery.state.hasAttemptedReactiveCompact}`,
    );
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Path two: a second over-long input fails directly ===");
{
  const model = new ScriptModel([
    new ModelPromptTooLongError("too long"),
    new ModelPromptTooLongError("still too long"),
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(original);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Actual request count = ${model.requests.length}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Path three: consecutive 529s switch to the fallback ===");
{
  const model = new ScriptModel([
    new ModelOverloadedError("overloaded"),
    new ModelOverloadedError("overloaded"),
    new ModelOverloadedError("overloaded"),
    { message: assistantMessage("The fallback model has answered"), finishReason: "stop" },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(original);
    console.log(`Model used by each request = ${JSON.stringify(model.requests.map((item) => item.model))}`);
    console.log(`Actual sleep seconds (jitter injected as 0) = ${JSON.stringify(kit.delays)}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Path three: a 429 obeys Retry-After ===");
{
  const model = new ScriptModel([
    new ModelRateLimitError("rate limited", { retryAfter: "3.25" }),
    { message: assistantMessage("Success after rate limiting"), finishReason: "stop" },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(original);
    console.log(`Actual sleep seconds = ${JSON.stringify(kit.delays)} (not the backoff baseline 0.5)`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Unknown error: thrown as it is, no retry ===");
{
  const defect = new TypeError("undefined is not a function");
  const model = new ScriptModel([defect]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(original);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Is it the same object = ${String(error === defect)}`);
    console.log(`Actual request count = ${model.requests.length}`);
    console.log(`Sleep count = ${kit.delays.length}`);
  } finally {
    kit.cleanup();
  }
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\exp1-paths.ts
```

The output is the three transcripts from "First Look at What the Three Paths Look Like When They Really Run" at the start of this chapter, plus the three transcripts after them:

```text
=== Path two: a second over-long input fails directly ===
Throws PromptTooLongRetryError: prompt-too-long compaction was already attempted
Actual request count = 2

=== Path three: a 429 obeys Retry-After ===
Actual sleep seconds = [3.25] (not the backoff baseline 0.5)

=== Unknown error: thrown as it is, no retry ===
Throws TypeError: undefined is not a function
Is it the same object = true
Actual request count = 1
Sleep count = 0
```

**Change one place and run it again:** remove one of the three `ModelOverloadedError` entries in path three, so only two remain:

```text
=== Path three: consecutive 529s switch to the fallback ===
Model used by each request = ["primary-model","primary-model","primary-model"]
Actual sleep seconds (jitter injected as 0) = [0.5,1]
```

Two 529s are not enough. The third request still hits the primary model. The threshold is 3. It is not "switch as soon as an overload occurs".

One word about how to use `ScriptModel`: its action list must be **exactly long enough**. If you want to try "truncate every time", you must put enough `length` replies into path one. If you do not, you hit `Error: Script exhausted: no more requests may be sent` first. That is an assertion of the script itself, not a behavior of the recovery layer. The next experiment is prepared exactly for "truncate every time".

### Experiment Two: The Four Boundaries of Continuation

Save it as `code\scratch\exp2-continuation.ts`:

```typescript
import {
  assistantMessage,
  systemMessage,
  toolCall,
  userMessage,
} from "../chapters/ch11/src/core/messages.js";
import type { ModelRequest } from "../chapters/ch11/src/core/model.js";
import { RecoveryConfig } from "../chapters/ch11/src/features/recovery.js";
import { ScriptModel, buildKit } from "./kit.js";

const req: ModelRequest = Object.freeze({
  messages: Object.freeze([systemMessage("s"), userMessage("Write a long text")]),
  tools: Object.freeze([]),
});

function config(maxContinuations: number): RecoveryConfig {
  return new RecoveryConfig({
    primaryModel: "primary-model",
    fallbackModel: "fallback-model",
    maxContinuations,
  });
}

console.log("=== Default maxContinuations=3, truncating every time ===");
{
  const model = new ScriptModel(
    Array.from({ length: 8 }, (_item, index) => ({
      message: assistantMessage(`fragment${index}`),
      finishReason: "length" as const,
    })),
  );
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Actual request count = ${model.requests.length}`);
    console.log(
      `Messages per request = ${JSON.stringify(model.requests.map((item) => item.messages.length))}`,
    );
    console.log(`state.recoveryCount = ${kit.recovery.state.recoveryCount}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== maxContinuations=0: continuation turned off directly ===");
{
  const model = new ScriptModel([
    { message: assistantMessage("Discard"), finishReason: "length" },
    { message: assistantMessage("Still truncated"), finishReason: "length" },
  ]);
  const kit = buildKit(model, { config: config(0) });
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Actual request count = ${model.requests.length}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Truncated fragment has tool_calls: fails at once, no matter how many continuations remain ===");
{
  const model = new ScriptModel([
    { message: assistantMessage("Discard"), finishReason: "length" },
    {
      message: assistantMessage(null, [toolCall("call-1", "read_file", "{}")]),
      finishReason: "length",
    },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Actual request count = ${model.requests.length}`);
    console.log(`state.recoveryCount = ${kit.recovery.state.recoveryCount} (no continuation happened at all)`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Empty string fragment: rejected as well ===");
{
  const model = new ScriptModel([
    { message: assistantMessage("Discard"), finishReason: "length" },
    { message: assistantMessage(""), finishReason: "length" },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Actual request count = ${model.requests.length}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Final reply has tool_calls: fragments merge as usual, tool calls stay complete ===");
{
  const call = toolCall("call-final", "read_file", '{"path":"README.md"}');
  const model = new ScriptModel([
    { message: assistantMessage("Discard"), finishReason: "length" },
    { message: assistantMessage("I will say one half first, "), finishReason: "length" },
    { message: assistantMessage("then the other half, then call a tool.", [call]), finishReason: "tool_calls" },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    const reply = await kit.recovery.complete(req);
    console.log(`Final content = ${JSON.stringify(reply.message.content)}`);
    console.log(`Final finishReason = ${reply.finishReason}`);
    console.log(`Final toolCalls = ${JSON.stringify(reply.message.toolCalls)}`);
  } finally {
    kit.cleanup();
  }
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\exp2-continuation.ts
```

Actual output:

```text
=== Default maxContinuations=3, truncating every time ===
Throws RecoveryRetriesExhausted: continuation recovery attempts exhausted
Actual request count = 5
Messages per request = [2,2,4,6,8]
state.recoveryCount = 3

=== maxContinuations=0: continuation turned off directly ===
Throws RecoveryRetriesExhausted: continuation recovery attempts exhausted
Actual request count = 2

=== Truncated fragment has tool_calls: fails at once, no matter how many continuations remain ===
Throws RecoveryRetriesExhausted: length recovery requires a non-empty text-only assistant fragment
Actual request count = 2
state.recoveryCount = 0 (no continuation happened at all)

=== Empty string fragment: rejected as well ===
Throws RecoveryRetriesExhausted: length recovery requires a non-empty text-only assistant fragment
Actual request count = 2

=== Final reply has tool_calls: fragments merge as usual, tool calls stay complete ===
Final content = "I will say one half first, then the other half, then call a tool."
Final finishReason = tool_calls
Final toolCalls = [{"id":"call-final","name":"read_file","arguments":"{\"path\":\"README.md\"}"}]
```

The third and fourth transcripts throw the same message, but their meanings differ. In the third, `recoveryCount = 0` shows "continuation must not happen". In the first, `recoveryCount = 3` shows "the continuation chances are used up". You cannot separate the two from the error message. You can separate them from the state.

### Experiment Three: The Backoff Curve and Retry-After Parsing

Save it as `code\scratch\exp3-backoff.ts`:

```typescript
import { assistantMessage, systemMessage, userMessage } from "../chapters/ch11/src/core/messages.js";
import { ModelOverloadedError, ModelRateLimitError } from "../chapters/ch11/src/core/model.js";
import type { ModelRequest } from "../chapters/ch11/src/core/model.js";
import { RecoveryConfig } from "../chapters/ch11/src/features/recovery.js";
import { ScriptModel, buildKit } from "./kit.js";

const req: ModelRequest = Object.freeze({
  messages: Object.freeze([systemMessage("s"), userMessage("u")]),
  tools: Object.freeze([]),
});

// Raise the deadline to 100000 seconds, so all 10 attempts run to completion and the deadline does not cut them off
const longDeadline = new RecoveryConfig({
  primaryModel: "primary-model",
  fallbackModel: "fallback-model",
  totalTimeoutSeconds: 100_000,
});

function tenRateLimits(): ScriptModel {
  return new ScriptModel(Array.from({ length: 10 }, () => new ModelRateLimitError("rate limited")));
}

console.log("=== Complete backoff curve (jitter injected as 0, 10 attempts exhausted) ===");
{
  const model = tenRateLimits();
  const kit = buildKit(model, { config: longDeadline });
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch (error) {
    console.log(`sleep sequence = ${JSON.stringify(kit.delays)}`);
    console.log(`Total sleep seconds = ${kit.delays.reduce((sum, item) => sum + item, 0)}`);
    console.log(`Actual request count = ${model.requests.length}`);
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Jitter at maximum (jitter returns the upper bound = base × 25%) ===");
{
  const kit = buildKit(tenRateLimits(), {
    config: longDeadline,
    jitter: (upperBound) => upperBound,
  });
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch {
    console.log(`sleep sequence = ${JSON.stringify(kit.delays)}`);
    console.log(`Total sleep seconds = ${kit.delays.reduce((sum, item) => sum + item, 0)}`);
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== A 429 interrupts the consecutive 529 count ===");
{
  const model = new ScriptModel([
    new ModelOverloadedError("overloaded"),
    new ModelOverloadedError("overloaded"),
    new ModelRateLimitError("rate limited"),
    new ModelOverloadedError("overloaded"),
    { message: assistantMessage("ok"), finishReason: "stop" },
  ]);
  const kit = buildKit(model);
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
    console.log(`Model used by each request = ${JSON.stringify(model.requests.map((item) => item.model))}`);
    console.log(`sleep sequence = ${JSON.stringify(kit.delays)}`);
    console.log("Note: 529 -> 529 -> 429 -> 529, the 429 resets the consecutive count, so the code never switches to the fallback");
  } finally {
    kit.cleanup();
  }
}

console.log("\n=== Retry-After parsing rules ===");
{
  const utcNow = new Date("2026-08-28T12:00:00.000Z");
  const cases: readonly string[] = [
    "0",
    "3",
    "3.25",
    " 7 ",
    "-1",
    "",
    "NaN",
    "Infinity",
    "1e2",
    new Date(utcNow.getTime() + 5_000).toUTCString(),
    "Fri, 28 Aug 2026 11:59:50 GMT",
    "2026-08-28T12:00:30.000Z",
    "2026-08-28T12:00:30",
    "not-a-date",
  ];
  for (const retryAfter of cases) {
    const model = new ScriptModel([
      new ModelRateLimitError("rate limited", { retryAfter }),
      { message: assistantMessage("ok"), finishReason: "stop" },
    ]);
    const kit = buildKit(model, { config: longDeadline, utcNow: () => utcNow });
    try {
      kit.recovery.beginTurn();
      await kit.recovery.complete(req);
      console.log(`${JSON.stringify(retryAfter).padEnd(36)} -> sleep ${kit.delays[0]} seconds`);
    } catch (error) {
      console.log(`${JSON.stringify(retryAfter).padEnd(36)} -> ${(error as Error).name}`);
    } finally {
      kit.cleanup();
    }
  }
  console.log(`(Injected utcNow = ${utcNow.toISOString()})`);
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\exp3-backoff.ts
```

The output is the four transcripts in the "Path Three" section (the backoff curve, jitter at maximum, the 429 count interruption, and the 14-line Retry-After matrix).

**The place in this experiment that is most worth changing by hand is `jitterRatio`.** Add one line, `jitterRatio: 0`, to `longDeadline`, and the backoff sequence becomes fully deterministic: `[0.5,1,2,4,8,16,32,32,32]`. Change it to `jitterRatio: 1`, and the jitter upper bound equals the baseline itself. In the worst case, every wait then doubles. The right value for a production environment depends on your concurrency scale. The higher the concurrency, the larger the jitter should be.

### Experiment Four: Deadline, Cancellation, Rollback, Override, and Constructor Validation

This experiment covers six "not the normal path" scenarios at once. Save it as `code\scratch\exp4-deadline.ts`. Read it in six parts:

```typescript
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { assistantMessage, systemMessage, userMessage } from "../chapters/ch11/src/core/messages.js";
import { ModelPromptTooLongError, ModelRateLimitError } from "../chapters/ch11/src/core/model.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch11/src/core/model.js";
import { CancellationToken, RecoveryConfig } from "../chapters/ch11/src/features/recovery.js";
import { ScriptModel, buildKit } from "./kit.js";

const req: ModelRequest = Object.freeze({
  messages: Object.freeze([systemMessage("s"), userMessage("u")]),
  tools: Object.freeze([]),
});

console.log("=== Scenario one: the sleep would cross the deadline ===");
{
  const model = new ScriptModel(
    Array.from({ length: 3 }, () => new ModelRateLimitError("rate limited", { retryAfter: "30" })),
  );
  const kit = buildKit(model, {
    config: new RecoveryConfig({
      primaryModel: "primary-model",
      fallbackModel: "fallback-model",
      totalTimeoutSeconds: 10,
    }),
  });
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch (error) {
    console.log("Retry-After = 30 seconds, remaining deadline = 10 seconds");
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Did it really sleep = ${String(kit.delays.length > 0)}`);
    console.log(`Model call count = ${model.requests.length}`);
  } finally {
    kit.cleanup();
  }
}
```

The second part constructs a "never returns" model. It verifies that cancellation really passes the signal down:

```typescript
console.log("\n=== Scenario two: cancel a model call in progress ===");
{
  class HangingModel implements ModelClient {
    signal: AbortSignal | undefined;
    settled = false;
    readonly started: Promise<void>;
    #resolveStarted: (() => void) | undefined;

    constructor() {
      this.started = new Promise<void>((resolve) => {
        this.#resolveStarted = resolve;
      });
    }

    async complete(_request: ModelRequest, signal?: AbortSignal): Promise<ModelReply> {
      this.#resolveStarted?.();
      if (signal === undefined) {
        throw new Error("The recovery layer must pass an AbortSignal");
      }
      this.signal = signal;
      return new Promise<ModelReply>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              this.settled = true;
              reject(new Error("Model call aborted"));
            });
          },
          { once: true },
        );
      });
    }
  }
  const model = new HangingModel();
  const cancellation = new CancellationToken();
  const kit = buildKit(model, { cancellation, realSleep: true });
  try {
    kit.recovery.beginTurn();
    const pending = kit.recovery.complete(req);
    await model.started;
    console.log("The model request is sent, then cancel() is triggered");
    cancellation.cancel();
    await pending;
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Model-side signal.aborted = ${String(model.signal?.aborted)}`);
    console.log(`Model-side operation settled = ${String(model.settled)}`);
  } finally {
    kit.cleanup();
  }
}
```

The third part makes the summarizer itself fail. It checks whether a compaction failure leaves a half-finished product:

```typescript
console.log("\n=== Scenario three: a summary failure rolls back the transcript ===");
{
  const failure = new Error("The summary model itself failed");
  const model = new ScriptModel(
    Array.from({ length: 3 }, () => new ModelPromptTooLongError("too long")),
  );
  const kit = buildKit(model, { summarizerError: failure });
  try {
    kit.recovery.beginTurn();
    await kit.recovery.complete(req);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Is the summary failure thrown as it is = ${String(error === failure)}`);
    const artifacts = join(kit.workspace, ".agent_tutorial", "artifacts");
    console.log(`Contents of the artifacts directory = ${JSON.stringify(readdirSync(artifacts))}`);
    console.log(`Model call count = ${model.requests.length} (no further retry)`);
  } finally {
    kit.cleanup();
  }
}
```

The fourth and fifth parts are two forms of "the caller makes a mistake":

```typescript
console.log("\n=== Scenario four: reject a caller override of the recovery state ===");
{
  const overrides: readonly ModelRequest[] = [
    { ...req, model: "another-model" },
    { ...req, maxTokens: 4_000 },
    { ...req, maxTokens: 8_000 },
    { ...req, model: "primary-model" },
  ];
  for (const overridden of overrides) {
    const model = new ScriptModel([{ message: assistantMessage("ok"), finishReason: "stop" }]);
    const kit = buildKit(model);
    const label = `model=${String(overridden.model)} maxTokens=${String(overridden.maxTokens)}`;
    try {
      kit.recovery.beginTurn();
      await kit.recovery.complete(overridden);
      console.log(`${label.padEnd(42)} -> Accepted, model called ${model.requests.length} time`);
    } catch (error) {
      console.log(`${label.padEnd(42)} -> ${(error as Error).name}: ${(error as Error).message}`);
    } finally {
      kit.cleanup();
    }
  }
}

console.log("\n=== Scenario five: beginTurn forgotten ===");
{
  const kit = buildKit(new ScriptModel([{ message: assistantMessage("ok"), finishReason: "stop" }]));
  try {
    await kit.recovery.complete(req);
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
  } finally {
    kit.cleanup();
  }
}
```

The sixth part runs the whole self-check rule set of the configuration, including two rules that "look wrong but are in fact legal":

```typescript
console.log("\n=== Scenario six: RecoveryConfig constructor validation ===");
{
  const cases: readonly [string, () => RecoveryConfig][] = [
    [
      "escalatedMaxTokens > modelMaxTokens",
      () =>
        new RecoveryConfig({
          primaryModel: "p",
          fallbackModel: "f",
          escalatedMaxTokens: 64_000,
          modelMaxTokens: 32_000,
        }),
    ],
    [
      "initialMaxTokens >= escalatedMaxTokens",
      () =>
        new RecoveryConfig({
          primaryModel: "p",
          fallbackModel: "f",
          initialMaxTokens: 64_000,
          escalatedMaxTokens: 64_000,
        }),
    ],
    [
      "baseDelaySeconds > maxDelaySeconds",
      () =>
        new RecoveryConfig({
          primaryModel: "p",
          fallbackModel: "f",
          baseDelaySeconds: 60,
          maxDelaySeconds: 32,
        }),
    ],
    ["primaryModel is blank", () => new RecoveryConfig({ primaryModel: "   ", fallbackModel: "f" })],
    [
      "maxTransientAttempts = 0",
      () => new RecoveryConfig({ primaryModel: "p", fallbackModel: "f", maxTransientAttempts: 0 }),
    ],
    [
      "maxContinuations = 0 (legal: turns continuation off directly)",
      () => new RecoveryConfig({ primaryModel: "p", fallbackModel: "f", maxContinuations: 0 }),
    ],
    [
      "jitterRatio = 0 (legal: a fully deterministic backoff)",
      () => new RecoveryConfig({ primaryModel: "p", fallbackModel: "f", jitterRatio: 0 }),
    ],
  ];
  for (const [label, build] of cases) {
    try {
      build();
      console.log(`${label.padEnd(40)} -> Construction succeeds`);
    } catch (error) {
      console.log(`${label.padEnd(40)} -> ${(error as Error).name}: ${(error as Error).message}`);
    }
  }
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\exp4-deadline.ts
```

The actual output of the six parts:

```text
=== Scenario one: the sleep would cross the deadline ===
Retry-After = 30 seconds, remaining deadline = 10 seconds
Throws RecoveryDeadlineExceeded: retry delay would reach or cross the turn deadline
Did it really sleep = false
Model call count = 1

=== Scenario two: cancel a model call in progress ===
The model request is sent, then cancel() is triggered
Throws RecoveryCancelledError: recovery turn was cancelled
Model-side signal.aborted = true
Model-side operation settled = true

=== Scenario three: a summary failure rolls back the transcript ===
Throws Error: The summary model itself failed
Is the summary failure thrown as it is = true
Contents of the artifacts directory = []
Model call count = 1 (no further retry)

=== Scenario four: reject a caller override of the recovery state ===
model=another-model maxTokens=undefined    -> RangeError: request.model must match RecoveryConfig.primaryModel
model=undefined maxTokens=4000             -> RangeError: request.maxTokens must match RecoveryConfig.initialMaxTokens
model=undefined maxTokens=8000             -> Accepted, model called 1 time
model=primary-model maxTokens=undefined    -> Accepted, model called 1 time

=== Scenario five: beginTurn forgotten ===
Throws RecoveryError: Recovery turn has not been started

=== Scenario six: RecoveryConfig constructor validation ===
escalatedMaxTokens > modelMaxTokens      -> RangeError: escalatedMaxTokens must not exceed modelMaxTokens
initialMaxTokens >= escalatedMaxTokens   -> RangeError: escalatedMaxTokens must exceed initialMaxTokens
baseDelaySeconds > maxDelaySeconds       -> RangeError: baseDelaySeconds must not exceed maxDelaySeconds
primaryModel is blank                         -> TypeError: primaryModel must be a non-empty string
maxTransientAttempts = 0                 -> RangeError: maxTransientAttempts must be a positive integer
maxContinuations = 0 (legal: turns continuation off directly)          -> Construction succeeds
jitterRatio = 0 (legal: a fully deterministic backoff)              -> Construction succeeds
```

Each of the six parts states one conclusion:

| Scenario | Conclusion |
| --- | --- |
| One | The deadline is not "check after the wait". It is "compute before the wait". It must wait 30 seconds, but only 10 seconds remain, so it does not wait a single second and throws `RecoveryDeadlineExceeded` directly |
| Two | Cancellation does not only make `complete()` return early. The `AbortSignal` really reaches the model client, and the recovery layer waits until the lower operation settles (`settled = true`) before it throws. It leaves no dangling request |
| Three | A compaction failure throws the summarizer error as it is (`error === failure` is `true`). It does not wrap it into a recovery layer error. An empty `artifacts` directory proves that no half-finished product was written |
| Four | An override of `model` or `maxTokens` is rejected, unless it matches the recovery layer value exactly. This is the defence line against "one field, two owners" |
| Five | If the caller forgets `beginTurn()`, the code throws `RecoveryError` directly. It does not run on with a stale state |
| Six | An unreasonable configuration explodes in the **constructor**. It does not wait until the fifth retry in production to expose itself |

**Change one place and run it again:** change `totalTimeoutSeconds` in scenario one from 10 to 100. The result of the same script becomes:

```text
sleep sequence = [30,30,30]
Model call count = 4
Throws Error: Script exhausted: no more requests may be sent
```

It honestly waits three times for 30 seconds (a cumulative 90 seconds, all inside the 100-second deadline). At the fourth request, the script holds only 3 prepared errors, so `ScriptModel` itself throws "script exhausted". Same input, same `Retry-After`, and only one deadline changes. The behavior moves from "do not wait a single second" to "wait the full 90 seconds". This is why the deadline should belong to the recovery layer and not to the caller. Each time the caller passes a different number, the behavior drifts.

### Experiment Five: The Adapter Error Classification and 200 Validation

This is the source of the output in the two earlier sections "Measured Classification Results" and "An HTTP 200 Is Also an Untrusted Boundary". It needs no real network. The second constructor parameter of `OpenAIChatModel` is an injectable `OpenAIClientBoundary`. Feed it a fake client and it works. Save it as `code\scratch\exp5-adapter.ts`:

```typescript
import { APIError } from "openai";

import { OpenAIChatModel } from "../chapters/ch11/src/adapters/openai-chat.js";
import type { OpenAIClientBoundary } from "../chapters/ch11/src/adapters/openai-chat.js";
import type { OpenAISettings } from "../chapters/ch11/src/config.js";
import { userMessage } from "../chapters/ch11/src/core/messages.js";
import type { ModelRequest } from "../chapters/ch11/src/core/model.js";

const settings: OpenAISettings = Object.freeze({
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  model: "primary-model",
});

const req: ModelRequest = Object.freeze({
  messages: Object.freeze([userMessage("hi")]),
  tools: Object.freeze([]),
});

// A minimal fake SDK client: it either throws the given value or returns the given response as it is
function client(result: unknown, mode: "throw" | "return"): OpenAIClientBoundary {
  return {
    chat: {
      completions: {
        async create() {
          if (mode === "throw") {
            throw result;
          }
          return result;
        },
      },
    },
  };
}

const api = (status: number, body: unknown, headers?: Record<string, string>): APIError =>
  new APIError(status, body, undefined, new Headers(headers));
```

The upper half feeds 14 kinds of error object in, one by one. It looks only at "normalised or thrown as it is":

```typescript
console.log("=== Error classification: only structured fields count ===");
const errorCases: readonly [string, unknown][] = [
  ["APIError 429", api(429, { code: "rate_limited" })],
  ["APIError 429 + retry-after header", api(429, { code: "rate_limited" }, { "retry-after": "5" })],
  ["APIError 529", api(529, { type: "overloaded_error" })],
  ["APIError 400 code=context_length_exceeded", api(400, { code: "context_length_exceeded" })],
  ["APIError 400 code=prompt_too_long", api(400, { code: "prompt_too_long" })],
  ["APIError 400 nested error.code=prompt_too_long", api(400, { error: { code: "prompt_too_long" } })],
  ["APIError 400 code=PROMPT_TOO_LONG (uppercase)", api(400, { code: "PROMPT_TOO_LONG" })],
  ["APIError 400 code=unknown_bad_request", api(400, { code: "unknown_bad_request" })],
  ["APIError 400 message says prompt is too long", api(400, { message: "prompt is too long" })],
  ["APIError 500", api(500, { code: "server_error" })],
  ["APIError 503", api(503, { code: "unavailable" })],
  ["A plain Error, the string contains 429", new Error("Error code: 429 - rate limited by upstream proxy")],
  [
    "A forged object: has status=429 but is not an APIError",
    Object.assign(new Error("looks like rate limit"), {
      status: 429,
      headers: new Headers({ "retry-after": "2" }),
      error: { code: "rate_limited" },
    }),
  ],
  ["Connection-layer error ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
];

for (const [label, thrown] of errorCases) {
  try {
    await new OpenAIChatModel(settings, client(thrown, "throw")).complete(req);
    console.log(`${label.padEnd(44)} -> Did not throw (must not happen)`);
  } catch (mapped) {
    const name = (mapped as Error).name;
    console.log(`${label.padEnd(44)} -> ${mapped === thrown ? `Thrown as it is ${name}` : `Normalised to ${name}`}`);
  }
}
```

The lower half constructs 13 kinds of HTTP 200 response. Two small factories, `choice()` and `ok()`, keep each case to one or two lines:

```typescript
console.log("\n=== Success responses: a 200 is validated field by field as well ===");

type Fields = Record<string, unknown>;

const choice = (overrides: Fields = {}, message: Fields = {}): Fields => ({
  index: 0,
  logprobs: null,
  finish_reason: "stop",
  message: { role: "assistant", content: "done", refusal: null, ...message },
  ...overrides,
});

const ok = (overrides: Fields = {}): Fields => ({
  id: "completion-1",
  created: 0,
  model: "primary-model",
  object: "chat.completion",
  choices: [choice()],
  ...overrides,
});

const responseCases: readonly [string, unknown][] = [
  ["Standard stop reply", ok()],
  [
    "finish_reason=content_filter",
    ok({ choices: [choice({ finish_reason: "content_filter" }, { content: "Partial content" })] }),
  ],
  ["content=null but has a refusal", ok({ choices: [choice({}, { content: null, refusal: "I cannot help." })] })],
  ["choices is an empty array", ok({ choices: [] })],
  ["choices has two entries", ok({ choices: [choice({}, { content: "a" }), choice({ index: 1 }, { content: "b" })] })],
  ["finish_reason is an unknown new value", ok({ choices: [choice({ finish_reason: "max_output_reached" })] })],
  ["role is not assistant", ok({ choices: [choice({}, { role: "user" })] })],
  [
    "tool_calls is missing the id",
    ok({
      choices: [
        choice(
          { finish_reason: "tool_calls" },
          { content: null, tool_calls: [{ type: "function", function: { name: "shell", arguments: "{}" } }] },
        ),
      ],
    }),
  ],
  [
    "Legacy function_call",
    ok({ choices: [choice({}, { content: null, function_call: { name: "shell", arguments: "{}" } })] }),
  ],
  ["usage.prompt_tokens is negative", ok({ usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } })],
  ["usage is missing total_tokens", ok({ usage: { prompt_tokens: 10, completion_tokens: 5 } })],
  ["usage has all three fields", ok({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })],
  ["Response root is not an object", "OK"],
];

for (const [label, response] of responseCases) {
  try {
    const reply = await new OpenAIChatModel(settings, client(response, "return")).complete(req);
    console.log(
      `${label.padEnd(30)} -> Passes: content=${JSON.stringify(reply.message.content)} finishReason=${reply.finishReason}`,
    );
  } catch (error) {
    console.log(`${label.padEnd(30)} -> ${(error as Error).name}: ${(error as Error).message}`);
  }
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\exp5-adapter.ts
```

The output is the 14 lines of "Measured Classification Results" earlier in this article, plus the 13 lines of "An HTTP 200 Is Also an Untrusted Boundary".

**Change one place and run it again:** change the status in `["APIError 429", api(429, { code: "rate_limited" })]` from 429 to 529. Watch it change from `ModelRateLimitError` to `ModelOverloadedError`. **You change only the number, not the wording, and the classification changes.** Then do the reverse. Change the wording from `rate_limited` to `totally_unrelated`. The classification **does not change**. Together, these two changes are the full meaning of "only structured fields count".

### Experiment Six: Observe the Recovery Layer from a Complete Agent

The first five experiments all operate on `RecoveryManager` directly. This experiment changes the viewpoint. It assembles a complete Agent through `buildAgent` and looks from the **outside** at what traces recovery leaves. Save it as `code\scratch\exp6-loop.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgent } from "../chapters/ch11/src/bootstrap.js";
import { assistantMessage } from "../chapters/ch11/src/core/messages.js";
import { PermissionDecision } from "../chapters/ch11/src/core/permissions.js";
import type {
  ApprovalProvider,
  AuditSink,
  PermissionRequest,
} from "../chapters/ch11/src/core/permissions.js";
import { P10, P11 } from "../chapters/ch11/src/core/profiles.js";
import { RecoveryConfig } from "../chapters/ch11/src/features/recovery.js";
import { ScriptModel } from "./kit.js";

class AllowAll implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "probe", "probe");
  }
}

class NoAudit implements AuditSink {
  async record(): Promise<void> {}
}

const config = new RecoveryConfig({
  primaryModel: "primary-model",
  fallbackModel: "fallback-model",
});

// Each scenario uses an independent temporary workspace and deletes it after the run
function withWorkspace<T>(prefix: string, body: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  return body(workspace).finally(() => rmSync(workspace, { recursive: true, force: true }));
}

console.log("=== Capability bits and configuration must come as a pair ===");
await withWorkspace("exp6-pair-", async (workspace) => {
  try {
    buildAgent(P10, { model: new ScriptModel([]), workspace, recoveryConfig: config });
  } catch (error) {
    console.log(`P10 + recoveryConfig -> ${(error as Error).message}`);
  }
  try {
    buildAgent(P11, { model: new ScriptModel([]), workspace });
  } catch (error) {
    console.log(`P11 without recoveryConfig -> ${(error as Error).message}`);
  }
});
```

The second part is the focus of this experiment. In the script, the first reply is truncated and only the second is complete. After the run, count how many entries the canonical history holds:

```typescript
console.log("\n=== Truncation recovery does not pollute the canonical history ===");
await withWorkspace("exp6-history-", async (workspace) => {
  const model = new ScriptModel([
    { message: assistantMessage("This incomplete reply will be discarded in full"), finishReason: "length" },
    { message: assistantMessage("Complete answer"), finishReason: "stop" },
    { message: assistantMessage("[]"), finishReason: "stop" },
  ]);
  const runner = buildAgent(P11, {
    model,
    workspace,
    recoveryConfig: config,
    approvalProvider: new AllowAll(),
    auditSink: new NoAudit(),
  });
  const result = await runner.run("Do the work");
  console.log(`finalText = ${JSON.stringify(result.finalText)}`);
  console.log(`turns = ${result.turns}`);
  console.log("canonical history:");
  for (const message of result.history) {
    console.log(`  ${message.role}: ${JSON.stringify(message.content)}`);
  }
  // Main Loop requests carry tools, side-path requests (memory extraction, summaries, and so on) do not
  const main = model.requests.filter((request) => request.tools.length > 0);
  console.log(`Main Loop request count = ${main.length} (the outer layer counts only 1 turn)`);
  console.log(`Main Loop request maxTokens = ${JSON.stringify(main.map((item) => item.maxTokens))}`);
  console.log(`Main Loop request model = ${JSON.stringify(main.map((item) => item.model))}`);
  const side = model.requests.filter((request) => request.tools.length === 0);
  console.log(`Side-path request count (through the raw model) = ${side.length}`);
  console.log(`Side-path request model = ${JSON.stringify(side.map((item) => String(item.model)))}`);
});

console.log("\n=== content_filter fails explicitly at the Loop layer ===");
await withWorkspace("exp6-filter-", async (workspace) => {
  const model = new ScriptModel([
    { message: assistantMessage("Filtered fragment"), finishReason: "content_filter" },
  ]);
  const runner = buildAgent(P11, {
    model,
    workspace,
    recoveryConfig: config,
    approvalProvider: new AllowAll(),
    auditSink: new NoAudit(),
  });
  try {
    await runner.run("Do the work");
  } catch (error) {
    console.log(`Throws ${(error as Error).name}: ${(error as Error).message}`);
    console.log(`Model request count = ${model.requests.length} (no retry)`);
  }
});
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\exp6-loop.ts
```

Actual output:

```text
=== Capability bits and configuration must come as a pair ===
P10 + recoveryConfig -> recoveryConfig requires chapter 11 or later
P11 without recoveryConfig -> recoveryConfig is required for chapter 11 or later
=== Truncation recovery does not pollute the canonical history ===
finalText = "Complete answer"
turns = 1
canonical history:
  user: "Do the work"
  assistant: "Complete answer"
Main Loop request count = 2 (the outer layer counts only 1 turn)
Main Loop request maxTokens = [8000,64000]
Main Loop request model = ["primary-model","primary-model"]
Side-path request count (through the raw model) = 1
Side-path request model = ["undefined"]
=== content_filter fails explicitly at the Loop layer ===
Throws AgentRunError: Model response was blocked by the content filter
Model request count = 1 (no retry)
```

The third reply placed in the script, `assistantMessage("[]")`, is prepared for the memory extractor. That call carries no tools, so the `side` filter selects it, and its `model` is `undefined`. This is the direct evidence for "only main Loop requests are wrapped". Inside one Agent, part of the requests pass through the recovery layer (with `model` and `maxTokens`), and part do not (both fields empty).

**Change one place and run it again:** change the `finishReason: "length"` of the first reply in the second part to `"stop"`:

```text
finalText = "This incomplete reply will be discarded in full"
turns = 1
canonical history:
  user: "Do the work"
  assistant: "This incomplete reply will be discarded in full"
Main Loop request count = 1 (the outer layer counts only 1 turn)
Main Loop request maxTokens = [8000]
```

The request count goes from 2 to 1, and `maxTokens` goes from `[8000,64000]` to `[8000]`. But the **shape** of the canonical history does not change. It is always "one user message, one assistant message", and `turns` is always 1. Only the content of that assistant message changes, because this time the model finished speaking by itself. The history structure is completely insensitive to "how many retries happened on the way". This is exactly the effect the recovery layer wants.

### Experiment Seven: Four-Field Configuration Validation

The last experiment is the shortest, but it matches the first trap you will really hit. The `.env` file grows from three fields to four. `settingsFromMapping(mapping, requireFallback)` is the function the CLI uses internally. Feed it a fake environment variable table and you can test it directly. Save it as `code\scratch\exp7-config.ts`:

```typescript
import { settingsFromMapping } from "../chapters/ch11/src/config.js";

// From Chapter 11 on, the CLI requires all four fields (requireFallback = true)
const cases: readonly [string, Record<string, string | undefined>][] = [
  ["All four fields present", {
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "primary-model",
    OPENAI_FALLBACK_MODEL: "fallback-model",
  }],
  ["Missing OPENAI_FALLBACK_MODEL", {
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "primary-model",
  }],
  ["OPENAI_FALLBACK_MODEL is only spaces", {
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "primary-model",
    OPENAI_FALLBACK_MODEL: "   ",
  }],
  ["Nothing configured at all", {}],
  ["baseUrl uses the file protocol", {
    OPENAI_BASE_URL: "file:///etc/passwd",
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "primary-model",
    OPENAI_FALLBACK_MODEL: "fallback-model",
  }],
  ["fallback has the same name as the primary model (allowed, but no isolation benefit)", {
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "same-model",
    OPENAI_FALLBACK_MODEL: "same-model",
  }],
];

for (const [label, mapping] of cases) {
  try {
    const settings = settingsFromMapping(mapping, true);
    console.log(
      `${label.padEnd(38)} -> Passes: model=${settings.model} fallbackModel=${String(settings.fallbackModel)}`,
    );
  } catch (error) {
    console.log(`${label.padEnd(38)} -> ${(error as Error).name}: ${(error as Error).message}`);
  }
}

console.log("\n=== The same configuration under P10 (requireFallback = false) ===");
try {
  const settings = settingsFromMapping(
    {
      OPENAI_BASE_URL: "https://api.example.test/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "primary-model",
    },
    false,
  );
  console.log(`Passes: model=${settings.model} fallbackModel=${String(settings.fallbackModel)}`);
} catch (error) {
  console.log(`${(error as Error).name}: ${(error as Error).message}`);
}
```

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx scratch\exp7-config.ts
```

Actual output:

```text
All four fields present                                 -> Passes: model=primary-model fallbackModel=fallback-model
Missing OPENAI_FALLBACK_MODEL                -> ConfigurationError: Missing required settings: OPENAI_FALLBACK_MODEL
OPENAI_FALLBACK_MODEL is only spaces             -> ConfigurationError: Missing required settings: OPENAI_FALLBACK_MODEL
Nothing configured at all                                  -> ConfigurationError: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_FALLBACK_MODEL
baseUrl uses the file protocol                     -> ConfigurationError: Missing required settings: OPENAI_BASE_URL
fallback has the same name as the primary model (allowed, but no isolation benefit)            -> Passes: model=same-model fallbackModel=same-model

=== The same configuration under P10 (requireFallback = false) ===
Passes: model=primary-model fallbackModel=undefined
```

Four points are worth noting:

- **Only spaces counts as not filled in.** The validation trims, so `OPENAI_FALLBACK_MODEL=   ` gives the same result as not writing it at all.
- **All missing fields are listed at once.** You do not need "fill one in, run once, then discover the next missing one".
- **The `file://` protocol is treated as "not filled in".** The validation checks more than the presence of a value. It also checks whether the protocol is `http` or `https`. This is a quiet but important security boundary.
- **The same three-field configuration passes under P10 and fails under P11.** `requireFallback` is the direct consequence of `profile.capabilities.has("recovery")`. Capability bits decide the configuration requirements. They are not two independent rule sets.

**Change one place and run it again:** change the `false` in the last part to `true`. The same configuration immediately becomes a `ConfigurationError`. This one line is the complete answer to "why is the `.env` from the first ten chapters not enough in Chapter 11".

---

## What This Chapter Does Not Do

Writing the boundaries clearly explains the position of this layer better than listing features.

**It does not retry 500 / 503 / connection errors.** This chapter applies backoff retry only to 429 and 529. A 500, a 503, `ECONNRESET`, and `ETIMEDOUT` are all thrown as they are. The reason is that the semantics of these states are unclear. A 500 may be an idempotent temporary fault. It may also be "the request has already been partly processed". A retry when you do not know whether the server has already produced a side effect has more risk than benefit. If you really want to add it, you must first make the idempotency contract clear.

**It does not do streaming recovery.** All recovery in this chapter rests on one premise: "judge only after you hold a complete `ModelReply`". When a streaming response breaks in the middle, whether the tokens already emitted should be kept and spliced into a continuation is a different design.

**It does not do active token budget control.** The recovery layer is **passive**. It compacts only after the provider says "too long". A real production system usually also estimates the token count **before** it sends a request, and trims in advance. That belongs to cost control, not to fault recovery.

**It does not give side-path requests recovery capability.** The memory selector and extractor, the compaction summarizer, and subagents still use the raw model. This is not an omission. They each need their own session ownership contract. Whose deadline? Whose fallback state? If they share the main Agent's `RecoveryState`, the states pollute each other.

**It does not do circuit breaking across turns.** `consecutive529` is cleared at every `beginTurn()`. So if three consecutive turns each meet two 529s, every turn starts again from the primary model. No turn remembers "this model has been bad lately". Health tracking across turns needs a lifecycle above the turn.

**It does not do a multi-fallback chain.** There is only one `fallbackModel`. When the fallback itself is overloaded too, the code retries until exhaustion. It does not switch further down.

---

## Differences from Claude Code

Claude Code's recovery system covers wider production scenarios than the teaching version P11. CC's query engine defines 17+ reasons/transitions. After each LLM call it routes to a specialised recovery path based on the stop_reason and the error type. P11 implements only three paths: length escalation → continuation → exhaustion, prompt_too_long → reactive compaction → exhaustion, and 429/529 → backoff → fallback → exhaustion. All other errors fail as they are. The CC implementation details above come from the `s11_error_recovery/README.md` in the external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code).

**Backoff formula.** CC uses `min(500 × 2^(attempt-1), 32000) + random(0~25%)` (milliseconds). Here, attempt means the retry number. P11 applies `baseDelaySeconds × 2^attempt` (default 0.5s), caps it at `maxDelaySeconds` (default 32s), and then adds the configurable `jitterRatio` (default 0.25). CC starts from attempt=1 (attempt-1 makes the first wait 500–625ms). P11 starts from attempt=0 (`2^0 = 1`) and gets the same 0.5s plus jitter. The two curves are the same in substance, and all parameters are configurable.

**Fallback switch.** When CC switches to the backup model, it clears all pending messages of the current turn. It also displays "Switched to {model} due to high demand". P11 only changes `currentModel` from primary to fallback. The messages and histories stay untouched. CC's clearing strategy avoids tokenization errors from incompatible prompt formats between models. P11 conservatively keeps the context and assumes that the prompt structures of the two models are compatible.

**Diminishing continuation returns.** CC's `tokenBudget.ts` tracks the token increment of each continuation. When three consecutive continuations each add fewer than 500 tokens, it stops the continuation actively. This avoids endlessly appending fragments with no real progress. P11 checks only the fixed `maxContinuations` count (default 3). It does not evaluate the actual quality change of each output.

**Streaming recovery.** In streaming mode, CC buffers errors such as 429 and 529. It does not interrupt the streaming output that already exists. It decides about a retry after the stream ends. The user perceives almost nothing of the back-end recovery. P11's `ModelClient` and `RecoveryManager` both use the request/response pattern. One LLM call either returns or throws. There is no streaming recovery path.

---

## Companion Code Index

To read the code by file, enter through this table:

| File | Lines | What you can find in it |
| --- | --- | --- |
| [features/recovery.ts](code/chapters/ch11/src/features/recovery.ts) | 603 | The main body of this chapter. `RecoveryConfig`, `RecoveryState`, `CancellationToken`, the five typed failures, the three recovery paths of `RecoveryManager.complete()`, `#runBounded`, `#parseRetryAfter`, `mergeFragments`, `splitLeadingSystem` |
| [core/model.ts](code/chapters/ch11/src/core/model.ts) | 158 | The stable contract layer. The `FinishReason` whitelist, the status invariants of `ModelAPIError` and its three subclasses, `ModelRequest` / `ModelReply` / `TokenUsage` / `ModelClient` |
| [adapters/openai-chat.ts](code/chapters/ch11/src/adapters/openai-chat.ts) | 344 | The only file that imports the OpenAI SDK. `maxRetries: 0`, `mapApiStatusError`, `structuredErrorIdentifier`, `retryAfterValue`, `normalizeResponse`, `toOpenAIMessage`, `toOpenAITool` |
| [core/loop.ts](code/chapters/ch11/src/core/loop.ts) | 444 | The `ModelRequestExecutor` protocol definition, the `beginTurn()` call site, the dispatch between the executor and the raw model, the `length` guard, the explicit `content_filter` failure |
| [bootstrap.ts](code/chapters/ch11/src/bootstrap.ts) | 263 | The composition root. The two-way paired check of capability bits and configuration, `recovery requires compaction`, the `RecoveryManager` construction, the summarizer bound to the raw model |
| [core/profiles.ts](code/chapters/ch11/src/core/profiles.ts) | 261 | The capability bit definition of `P11 = P10 + "recovery"` |
| [config.ts](code/chapters/ch11/src/config.ts) | 75 | `settingsFromMapping(mapping, requireFallback)`, the four-field validation, the `http`/`https` protocol check |
| [features/compaction.ts](code/chapters/ch11/src/features/compaction.ts) | 977 | The Chapter 8 compactor. This chapter reuses it through `compactOnPromptTooLong()` |

The tests are split into files by path. To see all boundary conditions of one path, read the matching test directly:

| Test file | What it covers | Case count |
| --- | --- | --- |
| `chapters/ch11/tests/recovery.test.ts` | The three recovery paths, backoff, fallback, deadline, cancellation, snapshot isolation (666 lines, the largest test file of this chapter) | 26 (22 `test` declarations, 4 of which are `test.each`) |
| `chapters/ch11/tests/ch11-recovery.test.ts` | Recovery behavior observed end to end from `buildAgent(P11, ...)` | 2 |
| `chapters/ch11/tests/openai-chat.test.ts` | Error normalisation, field-by-field validation of 200 responses, wire format mapping | 6 |
| `chapters/ch11/tests/config.test.ts` | Four-field validation, the `requireFallback` switch | 8 |
| `chapters/ch11/tests/ch11-entry.test.ts` | The stderr output when the fixed entry point lacks configuration | 1 |

These five files hold 43 cases in total. You can run them on their own to check:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm exec vitest run chapters/ch11/tests/recovery.test.ts chapters/ch11/tests/ch11-recovery.test.ts chapters/ch11/tests/openai-chat.test.ts chapters/ch11/tests/config.test.ts chapters/ch11/tests/ch11-entry.test.ts
```

---

## Run and Verification

Two entry points share the same P11 Bootstrap:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch11 -- --prompt "Check the current workspace and give a conclusion"
npm run agent-tutorial -- run --chapter 11 --prompt "Check the current workspace and give a conclusion"
```

The offline tests use a deterministic model, a FakeClock, a RecordingSleeper, and simulated OpenAI SDK state objects. They need no API Key and do not access the network:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch11
npm exec vitest run chapters/ch11/tests/openai-chat.test.ts chapters/ch11/tests/config.test.ts
npm run typecheck
npm run lint
npm run format:check
```

Measured result of `npm run test:ch11`:

```text
Test Files  28 passed (28)
     Tests  258 passed (258)
```

The current implementation deliberately does not retry unknown 5xx errors, connection resets, DNS, TLS, authentication, or streaming interruptions. Without a clear typed signal, idempotency semantics, and tests, failing these errors as they are is safer than a broad retry that "looks stronger".

---

## Chapter Summary

### The Three-Sentence Version

API resilience does not mean swallowing every exception. It means giving every recovery path verifiable inputs, state, and termination conditions. The three fault kinds each take their own road. Output truncation escalates the budget inside the request window and continues. Input that is too long compacts the request snapshot exactly once. A 429 or 529 retries with backoff on structured signals and switches to the fallback after consecutive overload. The recovery process is completely invisible to the canonical history. The formal history receives only the final, merged, complete reply.

### Five Rules You Must Remember

**One: recovery changes only the request snapshot, never the formal history.** This is the source of half of this chapter's design. Discarded truncation fragments, compacted middle messages, and failed retries all happen only on local variables inside `complete()`. The outer layer always sees "one model call, one final reply".

**Two: trust only structured fields, never match exception text.** `instanceof APIError` plus `status` plus `error.code`. That is all. Wording changes; `status` does not. A plain `Error` with 429 in its string must not be treated as a rate limit. Duck typing is a hole here, not flexibility.

**Three: an HTTP 200 is also an untrusted boundary.** When `finish_reason` shows an unknown new value, fail explicitly. Do not tolerate it and treat it as `stop`. Tolerant handling lets a truncated reply enter the history as a "complete answer", and nobody ever knows.

**Four: exhaustion must be a typed failure, not a silent degradation.** The five `RecoveryError` subclasses each match one exhaustion cause. See `RecoveryDeadlineExceeded` and you know it is the deadline. See `RecoveryRetriesExhausted` and you know it is the count. See `PromptTooLongRetryError` and you know whether one compaction was still not enough. A vague failure makes production problems undiagnosable.

**Five: capability bits and configuration must come as a pair.** Passing a recovery configuration to P10 is an error. Not passing one to P11 is also an error. The second case matters more. If it were allowed, P11 would silently degrade to a raw model. You would think you have recovery capability when you do not, and you would discover it only at two in the morning.

### Check Whether You Really Understood

If you cannot answer one, go back and read the matching section:

1. After one continuation recovery, how many messages does the canonical history hold? What is the outer `turns` count? ("Connect the Only Loop")
2. Why must the reply be **discarded in full** at the first `finishReason === "length"`, instead of being kept and continued? ("Path One")
3. Will `Retry-After: 2026-08-28T12:00:30.000Z` be accepted? Why? (the parsing table in "Path Three")
4. Why is the jitter added **after** the 32-second cap, not before? ("Path Three")
5. Two consecutive 529s, then one 429, then one more 529: does it switch to the fallback? (the third part of Experiment Three)
6. Will a plain `Error` with `Error code: 429` in its string be normalised to a `ModelRateLimitError`? ("Normalise Errors First")
7. Why must the `ModelHistorySummarizer` bind the raw model and not the `RecoveryManager`? ("The Summarizer Must Bind the Raw Model")
8. Why is `content_filter` rejected at the Loop layer and not at the recovery layer? ("`content_filter` Fails Explicitly at the Loop Layer")
9. How many sleeps do 10 transient attempts produce? Why is the default deadline 300 seconds? (the first part of Experiment Three)
10. The same three-field `.env`: why can P10 run and P11 not? (Experiment Seven)

---

The next article enters the task system. The Agent can now recover from API faults. But project tasks still need cross-process persistence, dependency unlocking, and atomic claiming. Chapter 12 separates the session TODO and the real JSON Task DAG into two models. The first is a to-do list inside one conversation. The second is a persistent dependency graph that many processes can claim from concurrently.
