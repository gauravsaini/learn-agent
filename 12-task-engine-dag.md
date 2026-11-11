You ask the Agent to do something slightly larger, for example "add a user system to this project". It cleverly breaks the work into four steps: create the database tables, write the endpoints, add tests, and write the documentation.

Then it starts writing the tests.

The database tables do not exist yet.

You stop it and say "create the database tables first". It does so. When it finishes, it goes to write the documentation. But the documentation must describe endpoints that have not been written yet.

The problem is not that it cannot break work into tasks. The `todo_write` tool from Chapter 5 could list steps long ago. The problem is the relationship between the four lines on that list. The model can only "remember" it by re-reading the context in every turn, and that memory is unreliable in three places:

- **Which tasks can really start now?** The list is flat. There is no edge between the four lines of text that says "who must come before whom".
- **Who claimed a task, and who has the right to declare it complete?** The list has no owner. Two Agents start work at the same time, and neither knows what the other is doing.
- **Does it still exist after the process exits?** No. The `todo_write` list lives in memory. Press `Ctrl+C` and it is gone. The next start is empty.

Chapter 12 adds exactly this layer: a task graph that **lives on disk, has dependency edges, and can be claimed concurrently by multiple processes**.

This chapter adds only one capability, but it has three parts: **five tools, three states, and one locked, persistent task graph**. Background execution, Cron, teammates, and work stealing all stay in later chapters.

![Image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaHUNeA6EyBOrnk4Ry5JG0O6G2ibb7kudEg3BgJvexBG0hnibYeEttV1Uic1yupPwhdSCvcYLQMGdBtWIyvyMuOb6dBbt8C9gM1vKc/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

1. State the granularity, owner, and lifecycle of the three "tasks": `todo_write`, the subagent `task` tool, and this chapter's Project Task. You will no longer mix them up.
2. Explain why there are only three states and no fourth `blocked` state, and where the fact of "blocked" is computed from.
3. State why the lock covers the whole graph and not a single task file, and give an example of what a lock on one file would miss.
4. Judge which error code the loser gets when two processes claim the same task at the same time, and why it is not a lock conflict error.
5. Describe the complete four steps of saving one task file, and state what remains on disk when any step fails.
6. State who appears in the `unblocked` list that `complete_task` returns, who does not appear, and why it does not rewrite the downstream files.
7. Explain why one corrupted task file makes the **whole graph** fail instead of being skipped.
8. Explain why `owner` cannot be passed in by the model through a parameter, and at which layer this defence line stops the forgery.

### What you need first

| Prerequisite | From which chapter | How this chapter uses it |
| --- | --- | --- |
| How the Agent Loop calls tools, and how tool results return to the history | Chapter 1 | The five task tools are ordinary tools and go through the same Loop |
| `ToolDefinition` / `ToolRegistry` / Zod schema validation | Chapter 2 | The input validation of the task tools relies entirely on `.strict()` schemas |
| Which fields in `ToolContext` are trusted | Chapters 2, 3 | **The most critical prerequisite of this chapter.** `owner` comes only from `context.identity` |
| The workspace is the only boundary for file operations | Chapters 2, 3 | Task files must land inside the workspace. A symlink escape must fail |
| The in-session list semantics of `todo_write` | Chapter 5 | This chapter draws a clear line against it. The two state sets coexist and do not connect |
| The subagent `task` tool means "delegate one piece of work" | Chapter 6 | It is a different thing from the Project Task. Only the name collides |
| Profile capability bits and the composition root injecting dependencies by capability | Chapters 5–11 | P12 connects the `TaskStore` through one `task_dag_json` capability bit |

If you have time to review only one chapter, review "which fields of `ToolContext` come from the runtime and which come from the model" in Chapter 2. This chapter's owner anti-forgery defence rests entirely on that boundary.

### Quick Term Reference (terms that first appear in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| Project Task | A unit of work that lives on disk and can be claimed and completed independently. It exists across sessions |
| Task DAG | A **directed acyclic graph** (Directed Acyclic Graph) made of tasks and dependency edges |
| `blocked_by` | One dependency edge: "I must wait for these tasks to complete". Disk storage and tool parameters both use this name |
| ready | A derived state: the task is `pending` and all its `blocked_by` entries are `completed` |
| owner | The claimer identity. It comes from the trusted runtime's `ToolContext.identity`, not from a model parameter |
| canonical UUID | The standard 36-character lowercase form with hyphens. All other forms are rejected |
| `TaskStore` | A domain layer interface. It defines five persistence operations and does not care whether the storage below is JSON or SQLite |
| `JsonTaskStore` | This chapter's implementation: one JSON file per task, serialised with a file lock |
| Whole-graph lock | One lock protects the whole `.tasks` directory, instead of one lock per task file |
| Critical section | The code between acquiring the lock and releasing it. Only one executor is inside at any moment |
| Reload inside the lock | After you enter the critical section, read the whole graph from disk **again**. Do not trust the stale value read outside the lock |
| Atomic replacement | Write a temporary file first, then `rename()`. A half-written file never appears at the final path |
| Whole-graph validation | Every load checks that dependencies exist, that no task depends on itself, and that there is no cycle |
| fail closed | Fail explicitly when there is a problem, instead of skipping bad data and running on |
| `unblocked` | The "directly unlocked by this completion" list that `complete_task` returns |

### Suggested Reading Route

```text
Chapter Guide (you are here)
  ↓
① First watch three processes run one graph in relay   ← Look at the output directly, no abstraction first
  ↓
② Three things are all called "task"          ← Separate the concepts first, or everything after is confusion
  ↓
③ The strict model of one Task          ← Three states, six fields, why there is no blocked
  ↓
④ What exactly sits on disk            ← Paths, file format, escape boundary
  ↓
⑤ Why the lock covers the whole graph            ← First see what happens without a lock, then see how the lock is written
  ↓
⑥ Atomic replacement + DAG validation at creation  ← Two safety mechanisms on the write side
  ↓
⑦ The five tools and owner anti-forgery       ← Where the boundary is that the model can touch
  ↓
⑧ Claim, complete, strict rebuild          ← How state advances, who got unlocked, how recovery works from disk
  ↓
⑨ Connect the composition root                    ← Capability bits, subagents share the same graph
  ↓
⑩ Run + eight experiments + troubleshooting        ← Verify every conclusion above by hand
```

---

## First Watch Three Processes Run One Graph in Relay

Do not talk about design first. Look at the result directly. Below are **three independent `npm run ch12` calls**. Each one is a brand-new Node process, and it exits when it finishes. They share no memory at all. Their only connection is the workspace on disk.

**The first process: build the graph.**

```powershell
npm run ch12 -- --prompt "Use create_task to create four tasks: schema (create the database tables, no dependencies), endpoints (write the endpoints, depends on schema), tests (add tests, depends on endpoints), docs (write the documentation, depends on schema). You must create schema first and get its id, then put the id into the blocked_by of the later tasks. Finally call list_tasks and report briefly."
```

Real output (repeated Hook lines omitted):

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: create_task
[Permission] create_task: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: create_task -> ok
... (create_task four times in total)
[Hook] PreToolUse: list_tasks
[Permission] list_tasks: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: list_tasks -> ok
[Hook] Stop
All four tasks are created:

| Task | ID | Dependency (blocked_by) |
|------|------|------|
| schema create the database tables | e2b62a72-cfc7-4cfd-ac15-2bda9417ca14 | None |
| endpoints write the endpoints | a8ec6fcc-f9b2-4764-87fc-407a99601550 | schema |
| tests add tests | 7e5c7bee-ba30-4a81-b9e4-ba08d62f7beb | endpoints |
| docs write the documentation | 2ade2ef8-7e38-45af-8225-384af568c2f2 | schema |
```

Note that the model must **create schema first, get the real ID, and only then create the other three**. It cannot invent an ID and put it into `blocked_by`, because creation fails directly when the dependency task does not exist. The section "Prove It Is Still a DAG at Creation" explains this constraint in detail later.

After the process exits, the disk holds four files:

```text
.agent_tutorial/.tasks/
  2ade2ef8-7e38-45af-8225-384af568c2f2.json
  7e5c7bee-ba30-4a81-b9e4-ba08d62f7beb.json
  a8ec6fcc-f9b2-4764-87fc-407a99601550.json
  e2b62a72-cfc7-4cfd-ac15-2bda9417ca14.json
```

**The second process: claim.** A brand-new process with nothing in memory.

```powershell
npm run ch12 -- --prompt "First call list_tasks to see the current task graph, then claim one task that can start now (a pending task whose dependencies are all complete)."
```

After the run, the schema file became:

```json
{"blocked_by":[],"description":"Create the database tables","id":"e2b62a72-cfc7-4cfd-ac15-2bda9417ca14","owner":"user","status":"in_progress","subject":"schema"}
```

`status` changed from `pending` to `in_progress`, and `owner` changed from `null` to `"user"`. This `"user"` was not filled in by the model. The CLI passed no `identity`, so the runtime defaulted to `"user"` and wrote it in. The later section "The Owner Cannot Be Forged Through a Model Parameter" explains this chain.

**The third process: complete.** Another brand-new process.

```powershell
npm run ch12 -- --prompt "You may use only these four task tools: list_tasks / get_task / claim_task / complete_task. Steps: 1) list_tasks; 2) find the task with status in_progress; 3) call complete_task on it; 4) report which subjects are in the returned unblocked list."
```

Real output:

```text
[Hook] UserPromptSubmit
[Hook] PreToolUse: list_tasks
[Permission] list_tasks: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: list_tasks -> ok
[Hook] PreToolUse: complete_task
[Permission] complete_task: allow (default) - No permission rule blocked the request
[Hook] PostToolUse: complete_task -> ok
[Hook] Stop
Done. The in_progress task is schema (create the database tables, id: e2b62a72-cfc7-4cfd-ac15-2bda9417ca14). complete_task was called on it.

The subjects in the returned unblocked list are:
- docs (write the documentation)
- endpoints (write the endpoints)
```

Three things in this output are worth a pause:

- **The third process knows nothing about what the first two processes did.** It calls `list_tasks` once and sees the complete four-node graph, including who is `in_progress` and who the owner is. This state comes entirely from disk.
- **`unblocked` contains docs and endpoints, but not tests.** tests depends on endpoints, and endpoints only just became ready. It is not complete yet. "Unlock" moves down exactly one level.
- **The files of docs and endpoints were not rewritten.** After schema completed, they are still `pending`, `owner: null`, with `blocked_by` unchanged. The fact "they can start now" is **computed**. It is not written into the files.

The final complete state of the four files on disk:

```json
{"blocked_by":["e2b62a72-..."],"description":"Write the documentation","id":"2ade2ef8-...","owner":null,"status":"pending","subject":"docs"}
{"blocked_by":["a8ec6fcc-..."],"description":"Add tests","id":"7e5c7bee-...","owner":null,"status":"pending","subject":"tests"}
{"blocked_by":["e2b62a72-..."],"description":"Write the endpoints","id":"a8ec6fcc-...","owner":null,"status":"pending","subject":"endpoints"}
{"blocked_by":[],"description":"Create the database tables","id":"e2b62a72-...","owner":"user","status":"completed","subject":"schema"}
```

This is what this chapter builds. Next, we take it apart.

---

## Three Things Are All Called "Task"

This is the easiest trap in this chapter. Up to Chapter 12, the code contains three concepts that can all be called a "task", and they have nothing to do with each other:

| | `todo_write` (Chapter 5) | The `task` tool (Chapter 6) | Project Task (this chapter) |
| --- | --- | --- | --- |
| What it is | A step list for the current work | "Send a subagent to look into something" | A project task that can be claimed and completed independently |
| Granularity | "The 5 steps I will do next" | A one-time delegation | One deliverable unit of work |
| Owner | A single Agent session | The Agent that calls it | The current workspace |
| Where it lives | Process memory (a private field of `TodoTracker`) | Not stored. It is gone after the run | `.agent_tutorial/.tasks/{uuid}.json` |
| Dependencies | None | None | `blocked_by` directed edges |
| How state changes | The whole list is overwritten and rewritten | Stateless | Conditional transitions inside the lock |
| After the process exits | All gone. A new session is empty | Irrelevant | Strictly recovered from disk |
| Count limit | 50 entries (`MAX_TODOS`) | None | None |

Interestingly, the state names of `todo_write` are **exactly the same** as in this chapter: `pending`, `in_progress`, `completed`. But the mechanism is completely different. In `todo_write`, the model passes a whole new list every time and overwrites the old one. In this chapter, the model can trigger only one-way transitions through `claim_task` and `complete_task`.

**Why not merge them into one?** Because they answer different questions:

```text
todo_write   answers "how do I finish this step I am on"  -> inside a session, rewritten at any time, no pain if lost
Project Task    answers "which work in the whole project comes first"      -> across sessions, transitions under a lock, chaos if lost
```

So P12 **keeps** `todo_write`. The model can use TODO to break down "how do I complete this task I just claimed". At the same time, it uses the Task DAG to manage "which tasks in the whole project come first and which are blocked". The two state sets do not synchronise automatically and do not overwrite each other. They cannot see each other.

The subagent tool called `task` in Chapter 6 is a third thing. It means "delegate one piece of work". It disappears after the run and does not enter the task graph. The name collision is historical. The five new tools in this chapter **all use full names with verbs** (`create_task`, `claim_task`, and so on). The purpose is to separate them from `task` in the tool list that the model sees:

```text
 1. shell
 2. read_file
 3. write_file
 4. edit_file
 5. glob
 6. todo_write        <- the in-session list from Chapter 5
 7. task              <- the one-time subagent from Chapter 6
 8. load_skill
 9. create_task       <- new in this chapter
10. get_task          <- new in this chapter
11. list_tasks        <- new in this chapter
12. claim_task        <- new in this chapter
13. complete_task     <- new in this chapter
```

This is the complete tool sequence of the P12 main Agent, from a real run. The first eight entries are the unchanged P11 prefix. The last five are added by this chapter.

---

## The Strict Model of One Task

The domain model is in [features/tasks.ts](code/chapters/ch12/src/features/tasks.ts). One Task has only six fields:

```typescript
import { Task, TaskStatus } from "./chapters/ch12/src/features/tasks.js";

const task = new Task({
  id: "9d59f5ec-7c94-49a7-b728-f36007fd912c",  // canonical UUID
  subject: "endpoints",                         // short title, must not be empty after trimming
  description: "create API endpoints",          // detailed description, may be empty
  status: TaskStatus.PENDING,                   // one of the three states
  owner: null,                                  // the claimer, must be null while pending
  blockedBy: [],                                // list of dependency task IDs
});
```

`Task` is not a loose dictionary. It is a domain object that is **validated and frozen at construction**. Note the last two lines of the constructor:

```typescript
Object.freeze(this.blockedBy);
Object.freeze(this);
```

After the freeze, nobody can change it. When `claim_task` wants to change the state, it can only create a new `Task`:

```typescript
const claimed = new Task({ ...task, status: TaskStatus.IN_PROGRESS, owner: normalizedOwner });
```

The benefit is this: **any `Task` object that exists has passed all validations.** When you hold a `Task`, you do not need to doubt whether its `status` and `owner` contradict each other.

### What exactly is validated at construction

| Check | When it fails | Error type |
| --- | --- | --- |
| `id` is a canonical UUID | `task id must be a canonical UUID` | `TaskGraphError` |
| `subject` is non-empty after trimming | `task subject must not be empty` | `TaskStorageError` |
| `status` is one of the three states | `task status is invalid` | `TaskStorageError` |
| Every entry of `blockedBy` is a canonical UUID | `task id must be a canonical UUID` | `TaskGraphError` |
| `blockedBy` has no duplicates | `task dependencies must be unique` | `TaskGraphError` |
| While `pending`, `owner === null` | `pending task must not have an owner` | `TaskStorageError` |
| While not `pending`, `owner` is non-empty | `in-progress or completed task requires an owner` | `TaskStorageError` |

The last two rules form a pair, and they deserve a separate mention: **the state and the owner must be consistent with each other**. There is no "pending but has an owner" task (what would that mean? Nobody claimed it, yet it has a master?). There is also no "in_progress but no owner" task (who is doing it?). These two combinations are rejected at the construction stage. They can never exist in memory, and they can never be written to disk.

`owner` is also trimmed first, and only then checked for emptiness:

```text
Passed in "  worker-a  ", actually stored as: "worker-a"
Claim with an empty string -> TaskOwnershipError(task_owner_mismatch): task owner must not be empty
```

Normalise first, then check for emptiness. This prevents `"worker-a"` and `" worker-a "` from being treated as two different people.

### How strict is the canonical UUID

Only one form passes: **lowercase hexadecimal, with hyphens, 36 characters**.

```typescript
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
```

Take a real UUID, `9d59f5ec-7c94-49a7-b728-f36007fd912c`, and deform it. Measured results:

| Form | Result |
| --- | --- |
| `9d59f5ec-7c94-49a7-b728-f36007fd912c` | Passes |
| `9D59F5EC-7C94-49A7-B728-F36007FD912C` (all uppercase) | Rejected |
| `9D59F5ec-7c94-49A7-b728-f36007fd912c` (mixed) | Rejected |
| `{9d59f5ec-...-f36007fd912c}` (with braces) | Rejected |
| `9d59f5ec7c9449a7b728f36007fd912c` (hyphens removed) | Rejected |
| `urn:uuid:9d59f5ec-...` (URN prefix) | Rejected |
| `` `9d59f5ec-...` `` with spaces before and after | Rejected |
| `../outside` | Rejected |
| `C:/Windows/system32` | Rejected |
| `9d59f5ec-....json` (suffix appended) | Rejected |
| `""` (empty string) | Rejected |

Why so strict? Because the **task ID is spliced directly into a file name**. Relax any "equivalent form" and you open a hole into the file system. Case is insensitive on Windows, `../` can cross directories, and braces are legal file name characters on some systems. Instead of defending at path-splicing time, accept only one shape at the entrance.

One point must be stated clearly: this regular expression **checks only the shape. It does not check the UUID version bits.** Measured:

```text
v4 (third group starts with 4)    -> Passes
v1 (third group starts with 1)    -> Passes (the regex checks only the shape, not the version bits)
v7 (third group starts with 7)    -> Passes (the regex checks only the shape, not the version bits)
All zeros                     -> Passes (the regex checks only the shape, not the version bits)
```

Actual generation uses `randomUUID()` from `node:crypto` (v4), but the validation layer does not enforce a version. This is deliberate. The version bits do not affect file name safety, and relaxing them lets tests use a fixed ID such as `11111111-1111-4111-8111-111111111111`, which you can recognise at a glance.

### Three states, one-way progress

```text
pending  --claim_task-->  in_progress  --complete_task-->  completed
```

There is no way back. This chapter has no `update_task`, `delete_task`, or `unclaim_task`, and no automatic rollback.

Measured results for all rejected transitions (the task is currently `in_progress`, and the owner is `worker-a`):

```text
Claim again (in_progress -> in_progress) -> TaskStateError(task_invalid_state): Task ... must be pending to claim
Complete by another person (owner mismatch)            -> TaskOwnershipError(task_owner_mismatch): Task ... is owned by worker-a
Owner completes it                      -> Success, status=completed
Claim after completion                           -> TaskStateError(task_invalid_state): Task ... must be pending to claim
Complete after completion                        -> TaskStateError(task_invalid_state): Task ... must be in_progress to complete
```

And completing directly, skipping the claim:

```text
Complete directly, skipping the claim -> TaskStateError(task_invalid_state): Task ... must be in_progress to complete
State unchanged: 2222  fresh      pending      owner=null      blocked_by=-
```

Note the last line: **after the failure, the state did not change at all**. This is no coincidence. The transition check and the disk write happen inside the same critical section. If the check fails, the code never reaches the write step.

**Why is there no `unclaim`?** Because after a process restart, an `in_progress` task means "somebody claimed it, and may already have started changing files, running commands, and sending requests". The runtime does not know how far those side effects went. Automatically returning it to `pending` so that somebody else can claim it again means assuming "the earlier half of the work can be safely redone". That assumption does not hold after files have been changed.

So this chapter's choice is: **keep the state as it is and leave the decision to a human**. Chapter 17 introduces leases and claim tokens. Only then is there enough information to talk about "release automatically when the lease expires".

### Why there is no fourth blocked state

A natural design adds a `blocked` state. This chapter deliberately does not add it.

Here, "blocked" is a **derived fact**, not a stored field:

```text
ready   = status === "pending" and all blocked_by entries are completed
blocked = status === "pending" and at least one blocked_by entry is not completed
```

`claim_task` recomputes it inside the lock every time:

```typescript
const blockedBy = task.blockedBy.filter((dependency) => {
  const dependencyTask = graph.get(dependency);
  return dependencyTask === undefined || dependencyTask.status !== TaskStatus.COMPLETED;
});
if (blockedBy.length > 0) {
  throw new TaskBlockedError(id, blockedBy);
}
```

**If `blocked` were a stored state, what would happen?** When schema completes, you must find all tasks that depend on it directly. You must check each one to see whether its remaining dependencies are also complete. Then you rewrite the ones that qualify from `blocked` to `pending`. **Every completion of one task forces a batch rewrite of downstream files.**

The problems with a batch rewrite are more than slowness:

- The process dies while writing the third file. Half of the downstream tasks on disk are `pending`, and half are still `blocked`.
- The two data copies, `blocked` and `blocked_by`, disagree. You must decide which one to trust.
- A task with 5 dependencies is rewritten 5 times (once per completed dependency). Each rewrite must re-judge the condition.

The derived approach has exactly one cost: every `claim` must read the whole graph. But the whole graph **must be read anyway**, because the dependency states must be checked. So this cost is zero.

Measure this derived logic (a four-node graph where only schema has no dependencies):

```text
1111 schema     ready=true  Incomplete dependencies=-
2222 endpoints  ready=false Incomplete dependencies=1111
3333 tests      ready=false Incomplete dependencies=2222,1111
4444 docs       ready=false Incomplete dependencies=1111
```

Race to claim a blocked task:

```text
claim endpoints -> TaskBlockedError(task_blocked)
  message: Task 22222222-2222-4222-8222-222222222222 is blocked by: 11111111-1111-4111-8111-111111111111
  Incomplete dependencies: 1111
File bytes unchanged: true
```

`TaskBlockedError` does not only say "blocked". It also carries **exactly which dependencies are incomplete** (the `blockedBy` field). The model receives this list and knows which task to do first. It does not need to check again itself.

The last line is the key invariant here: **a rejected operation does not touch the file bytes**.

---

## What Exactly Sits on Disk

The architecture rule requires all runtime data to sit under `workspace/.agent_tutorial/`. This chapter's relative directory is `.tasks/`:

```text
workspace/
  .agent_tutorial/
    .tasks/                                        <- all task files are here
      1b73c624-7ae6-4e78-83d5-7bcf91dd5f13.json
      9d59f5ec-7c94-49a7-b728-f36007fd912c.json
    .tasks.lock/                                   <- exists only inside the critical section
```

**One file per task.** The file name is the task's canonical UUID plus `.json`. The content is UTF-8, the fields are in alphabetical order, and the file ends with a newline:

```json
{"blocked_by":["11111111-1111-4111-8111-111111111111"],"description":"Write the endpoints","id":"22222222-2222-4222-8222-222222222222","owner":null,"status":"pending","subject":"endpoints"}
```

(The above is the actual single-line form that is written. Expanded, it looks like this:)

```json
{
  "blocked_by": ["11111111-1111-4111-8111-111111111111"],
  "description": "Write the endpoints",
  "id": "22222222-2222-4222-8222-222222222222",
  "owner": null,
  "status": "pending",
  "subject": "endpoints"
}
```

The serialisation code fixes the field order:

```typescript
function serializeTask(task: Task): Buffer {
  // Fix the field order and the trailing newline, so task files can be diffed and audited, and the written content does not drift randomly.
  const payload = {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}
```

Why care about field order? Because these files enter Git and are read with `git diff`. If the field order drifts with the insertion order of `Object.keys`, a commit that changes only `status` displays as a full-line rewrite. At audit time, you cannot see what actually changed.

**Note that the field name is `blocked_by` (underscore), not `blockedBy`.** The TypeScript domain object uses the camelCase `blockedBy` internally. Disk storage and tool parameters use the underscore form `blocked_by`. This mapping happens in only two places: in `serializeTask()` at write time, and in `taskPayload()` when the result returns to the model. The field names the model sees match the field names on disk exactly. One mapping layer less means one place less where an error can occur.

### A counter-intuitive detail: the lock file normally does not exist

The `.tasks.lock/` entry in the tree above carries the comment "exists only inside the critical section". Measured verification:

```text
Does .tasks.lock exist between operations: false
Does .tasks.lock exist inside the critical section: true
  Is it a directory or a file: a directory (proper-lockfile uses a directory as the lock)
Does .tasks.lock still exist after the operation ends: false
```

Three points:

- It is a **directory**, not a file. `proper-lockfile` uses the atomicity of `mkdir` as the lock. `mkdir` fails when the directory already exists. This "either it is created or it fails" semantic is exactly a mutex.
- It **exists only inside the critical section**. It is deleted when the lock is released. So a normal `ls` does not show it.
- If you **do** see it, an operation is running right now, or the previous holder exited abnormally and left a residue (treated as stale after 30 seconds, explained later).

### Path escape: three gates

The task file location is spliced together: `workspace` + `.agent_tutorial` + `.tasks` + `{uuid}.json`. Of these four parts, only the first comes from outside, and the last comes from the model. Both need defence.

The part from the model is already locked down by the canonical UUID regex. `../outside` cannot enter at all. But the directory itself may be made into a symlink (Linux/macOS) or a junction (Windows) that points outside the workspace. So the code re-validates before every operation:

```typescript
async #validatePaths(paths: JsonTaskPaths): Promise<void> {
  // Before every operation, validate the physical paths of root/tasks/lock again, to prevent a symlink escape.
  await this.#validateRoot(paths.workspace, paths.root);
  let resolvedRoot: string;
  let resolvedTasks: string;
  try {
    resolvedRoot = await realpath(paths.root);
    resolvedTasks = await realpath(paths.tasks);
  } catch (error) {
    throw new TaskStorageError("Task storage root could not be resolved", { cause: error });
  }
  if (!pathIsInside(paths.workspace, resolvedRoot) || !pathIsInside(resolvedRoot, resolvedTasks)) {
    throw new TaskStorageError("Task storage root escapes workspace");
  }
  // ...it also confirms that they are all directories, and that the lock path is not a symlink
}
```

The key is `realpath()`: it resolves a symlink to the real physical path. Then `relative()` checks whether the real path is still inside the workspace. Measured results for two escapes:

```text
=== 1. .agent_tutorial is a junction that points outside the workspace ===
createTask -> TaskStorageError(task_storage_error): Task storage root escapes workspace
Was a task file written into the external directory: false

=== 2. .tasks itself is a junction that points outside ===
createTask -> TaskStorageError(task_storage_error): Task storage root escapes workspace
Was a task file written into the external directory: false
```

The two directory levels are validated **separately**, because an escape can happen at either level. The third gate is that the `lock` path must not be a symlink. Otherwise the lock would be placed somewhere else, which equals no lock at all.

An invalid workspace parameter must also fail:

```text
Empty string workspace   -> TypeError: workspace must be a non-empty string
A directory that does not exist         -> TaskStorageError(task_storage_error): Task storage root is invalid
workspace points to a file -> TaskStorageError(task_storage_error): Task storage root is invalid
```

The first one is a `TypeError`, not a `TaskStorageError`, because it is a **constructor argument error**. That is a program bug, not a runtime state problem.

### Read-only operations do not create directories

One small but important behavior: **read operations do not create state**.

```text
listTasks returns = []
getTask -> TaskNotFoundError
Was .agent_tutorial created: false
```

The boolean parameter of `#preparePaths(create)` controls this. Only `createTask` passes `true`:

```typescript
async createTask(input: CreateTaskInput): Promise<Task> {
  const paths = await this.#preparePaths(true);   // create the directory only when needed
  // ...
}

async listTasks(): Promise<readonly Task[]> {
  const paths = await this.#preparePaths(false);  // return empty when the directory does not exist
  if (paths === undefined) {
    return Object.freeze([]);
  }
  // ...
}
```

Why care? Because "run `list_tasks` once and leave an empty directory in the user's project" is an unnecessary side effect. A pure read operation should leave no visible trace.

---

## Why the Lock Covers the Whole Graph

### First see what happens without a lock

Talking about "races" in the abstract is worse than watching one real failure. The mini implementation below deliberately has **no lock**. Its other steps are the same as `claimTask`: read, judge, write:

```typescript
// A mini implementation that deliberately has no lock, to show the window between "read -> judge -> write"
async claim(id: string, owner: string, pause: number): Promise<string> {
  const task = this.#read(id);                              // 1. Read
  if (task.status !== "pending") {
    return `${owner} failed: the status is ${task.status}`;
  }
  await new Promise((resolve) => setTimeout(resolve, pause)); // Simulate the scheduling gap during the judgement
  this.#write({ id, status: "in_progress", owner });          // 2+3. Write after the judgement passes
  return `${owner} succeeded`;
}
```

Two people claim the same `pending` task at the same time. Measured:

```text
=== No lock: two people claim the same pending task at the same time ===
  worker-a succeeded
  worker-b succeeded
  Final owner on disk = worker-a
  Both think they succeeded, but the disk remembers only one -> the other is doing ownerless work
  File count = 1 (no half file; the problem is not a broken write, it is an invalid judgement)
```

Note the last line. **The file is not broken. The JSON is complete. There is no half file.** This bug and "power loss halfway through writing a file" are two completely different problem classes:

```text
Broken file write    -> atomic replacement solves it (write a temporary file first, then rename)
Invalid judgement    -> atomic replacement cannot solve it; a critical section is required
```

At the moment `worker-b` read `pending`, its judgement was correct. By the time it wrote, the world had changed. Atomic replacement guarantees that its `rename` is atomic. But the **content** it writes already rests on a stale judgement.

In a real scenario, this means two Agents start changing the same set of files at the same time, submit at the same time, and both report "I completed this task".

### Why you cannot lock only the target file

An intuitive optimisation is this: `claim_task` changes only one file, so lock only that file, and get higher concurrency.

The problem is that the **judgement of `claim` depends on more than the target file**:

```text
To judge whether endpoints can be claimed, you must read:
  endpoints.json     -> is it pending
  schema.json        -> is its dependency complete   <- another file!
```

If you lock only `endpoints.json`, anybody can change `schema.json` during your judgement. You locked what you write, but you did not lock the **basis of the judgement**.

`create_task` is more extreme. It must validate that the whole graph has no cycle, so it reads **all** files:

```text
To judge whether the graph is still a DAG after the new task is added, you must read:
  all .json files, and run one complete DFS
```

So this chapter's choice is direct: **one lock protects the whole `.tasks` directory**. Trade a little concurrency for an invariant you can state clearly:

> "Read the whole graph -> make the judgement -> write one file" is one indivisible decision.

Only in Chapter 17, after the move to SQLite, are there real row-level locks and transactions. Only then can you do fine-grained concurrency. JSON plus a file lock is enough in this chapter to prove the state and persistence contracts.

### The real structure of the lock

`#withLock` is a little more complex than you might expect, because it must handle two kinds of concurrency at the same time: **inside one process** and **across processes**:

```typescript
async #withLock<T>(paths: JsonTaskPaths, operation: () => Promise<T>): Promise<T> {
  // An in-process queue plus a cross-process file lock guarantees that a read-modify-write on the same graph is one critical section.
  return await withProcessMutex(paths.tasks, async () => {
    let release: (() => Promise<void>) | undefined;
    let windowsRaceRetries = 0;
    try {
      while (release === undefined) {
        try {
          release = await acquireFileLock(paths.tasks, {
            lockfilePath: paths.lock,
            realpath: true,
            stale: LOCK_STALE_MS,     // 30_000
            update: LOCK_UPDATE_MS,   // 10_000
            retries: 0,
          });
        } catch (error) {
          if (isWindowsLockRace(error) && windowsRaceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
            windowsRaceRetries += 1;
            await delay(LOCK_RETRY_MS); // 10ms
            continue;
          }
          if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ELOCKED")) {
            await delay(LOCK_RETRY_MS);
            continue;
          }
          throw error;
        }
      }
      await this.#validatePaths(paths);
      return await operation();      // <- Critical section: inside the operation, the whole graph is read again
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;                 // Domain errors are thrown upward as they are, keeping the error code
      }
      throw new TaskStorageError("Task storage operation failed", { cause: error });
    } finally {
      if (release !== undefined) {
        await release();             // Release in all cases, success or failure
      }
    }
  });
}
```

Take it apart into four layers:

**Layer one, `withProcessMutex`: queue inside the process.** One Node process may hold two `JsonTaskStore` instances at the same time (for example, the main Agent and a subagent). A file lock is unreliable inside one process (`proper-lockfile` treats a lock held by the same process as re-entrant). So a Promise chain first queues the operations of one process in order:

```typescript
async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // Concurrent operations inside one process also queue; the cross-process part is guaranteed by the file lock.
  const previous = PROCESS_LOCK_TAILS.get(key);
  const result = previous === undefined ? operation() : previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,   // A failure of the previous one must not block the later ones
  );
  PROCESS_LOCK_TAILS.set(key, tail);
  // ...
}
```

That `.then(() => undefined, () => undefined)` is the key. It swallows success and failure alike into `undefined`. So when one operation in the queue throws, the operations queued behind it do **not** all fail.

**Layer two, `acquireFileLock`: mutual exclusion across processes.** `retries: 0` means "`proper-lockfile` must not retry itself". The `while` loop outside controls the retry logic.

**Layer three, the retry loop: separate "lock is held" from "real error".**

| Error code | Meaning | Handling |
| --- | --- | --- |
| `EEXIST` / `ELOCKED` | The lock is held by somebody else | Wait 10ms and retry, with no limit |
| `EBUSY` / `ENOTEMPTY` / `EPERM` | A transient race in creating or deleting the lock directory on Windows | Wait 10ms and retry, at most 100 times |
| Other | A real problem | Throw directly |

The three Windows error codes need an explanation. On the Windows file system, in the instant after one process removes a lock directory with `rmdir`, another process that creates a directory with the same name through `mkdir` may get `EBUSY` or `EPERM`, instead of a clean "already exists". This is not a logic error. It is pure timing jitter, so a retry is right. But the count is **limited to 100**. If 100 retries (about 1 second) still fail, there is a real problem, and an infinite loop is wrong.

**Layer four, `stale: 30_000` and `update: 10_000`: handle a crashed holder.** The lock holder updates the lock timestamp every 10 seconds. If a lock has not been updated for more than 30 seconds, the holder is dead (killed with `kill -9`, crashed, or lost power). A later process may then take the lock over by force. Without this mechanism, one crash would lock the task graph forever.

### Reload inside the lock: the core of the whole matter

The most important line in the code above is this one:

```typescript
return await operation();      // <- Critical section: inside the operation, the whole graph is read again
```

`operation` is not "write with the data read outside the lock". It **reads `#loadGraph()` again inside the lock**. Look at `claimTask`:

```typescript
return await this.#withLock(paths, async () => {
  // After the reload inside the lock, blocked is recomputed: even if a task just became ready outside the lock, the critical section sees only the latest graph.
  const graph = await this.#loadGraph(paths);   // <- read again
  const task = graph.get(id);
  if (task === undefined) {
    throw new TaskNotFoundError(`Task not found: ${id}`);
  }
  if (task.status !== TaskStatus.PENDING) {
    throw new TaskStateError(`Task ${id} must be pending to claim`);
  }
  // ...judge the dependencies, then write
});
```

Two processes can both decide outside the lock, "I will claim A". But after they enter the critical section:

```text
Process 1 takes the lock -> reloads, sees A is pending -> writes in_progress/worker-a -> releases the lock
Process 2 takes the lock -> reloads, sees A is in_progress -> throws TaskStateError -> releases the lock
```

So **the loser does not get a lock conflict error. It gets "the state is no longer pending"**. This point is easy to get wrong, so look at the measured result separately.

### Measured: only one winner in a concurrent claim

Two stores in one process:

```text
=== 1. Two stores race for the same task at the same time ===
worker-a -> Succeeded, owner=worker-a
worker-b -> Failed, TaskStateError(task_invalid_state): Task ... must be pending to claim
Final owner on disk = worker-a
Success count = 1

=== 2. What error does the loser get ===
Class name = TaskStateError
Error code = task_invalid_state
Not a lock error, but "the state is no longer pending"
```

Ten concurrent claims:

```text
Success = 1, Failure = 9
Set of loser error codes = task_invalid_state
Final owner = worker-0
```

**In the two transcripts above, the "who wins" item changes between runs. Nothing else in this chapter's measured output changes.** The reason is that the `mkdir` and `stat` calls in `#preparePaths` are asynchronous. Which store reaches `withProcessMutex` first depends on how the event loop interleaves them, not on the order in which you called them. Measured over six consecutive runs: in the two-party race, `worker-a` and `worker-b` each won a few times. In the ten-party race, the winner varied between `worker-0`, `worker-1`, and `worker-2`.

**What does not change is the count and the error code**: the success count is always 1, and the set of loser error codes is always `{task_invalid_state}`. These two are what the lock guarantees. "Who wins" should not be deterministic. If one owner always won, that would instead prove starvation.

(The cross-process version in the next section is stable with `proc-a` winning in the measurement. But that is not a design guarantee. It is only because the four processes spawn in sequence, and the Node start time magnifies the gap between them to tens of milliseconds. Do not treat it as an ordering promise.)

The error codes of the nine losers are **all the same**. Not one is a lock timeout or a lock conflict. They all entered the critical section successfully. Only inside did they find that the task had already been taken.

Verify again that the critical section is really mutually exclusive (add markers inside `atomicReplace`; each of the two operations needs 30ms):

```text
B enters the write -> B leaves the write -> A enters the write -> A leaves the write
Interleaving means no serialisation; pairs mean the critical section is mutually exclusive
```

`B enters -> B leaves -> A enters -> A leaves`, in pairs. Without mutual exclusion, you would see `B enters -> A enters -> B leaves -> A leaves`.

### Across processes it is the same

The tests above are all in one process. The file lock is really needed across processes. Four **independent Node processes** race for the same task. Measured:

```text
Task created: 7e6eb3bb-e7f8-4862-8c22-7488cd1ff417
Initial state: pending, owner=null

=== Result of each of the four processes ===
proc-a Succeeded owner=proc-a status=in_progress
proc-b Failed TaskStateError(task_invalid_state)
proc-c Failed TaskStateError(task_invalid_state)
proc-d Failed TaskStateError(task_invalid_state)

Final state on disk: status=in_progress, owner=proc-a
Number of successful processes = 1
```

Four operating-system processes, each with its own `new JsonTaskStore(workspace)`, unable to see each other's memory. Exactly one wins.

### Read operations take the lock too

`get_task` and `list_tasks` are pure reads. Why do they also enter `#withLock`?

Because of the **consistent snapshot**. One `list_tasks` call reads N files. Without a lock, while you read the third file, another process may complete the fifth task. The graph you return is then a mixture of "half before the transition, half after". A model that plans with such a graph can reach a self-contradictory conclusion, such as "A is complete, but B, which depends on A, still shows as blocked".

The cost is that read operations also queue against each other. This chapter accepts that cost. A task graph usually has only a few dozen nodes, and one full read takes milliseconds.

---

## Atomic Replacement: Holding the Lock Is Not Enough

The lock solves "will the judgement become invalid". It does not solve "power loss halfway through a write".

These two problems exist independently. You can hold the lock and write a file, and then the process is killed after `write()` has written 80 bytes. The disk then holds a broken JSON. At the next load, it is neither a valid task nor "does not exist". It is a bad file.

So every save goes through atomic replacement:

```typescript
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // Sync a temporary file in the same directory first, then publish it with rename; the final path never exposes half-written content.
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");   // wx = exclusive creation, fails if the file already exists
    await handle.writeFile(content);
    await handle.sync();                    // Force a flush to the physical disk
    await handle.close();
    handle = undefined;
    await rename(temporary, path);          // Atomic publish
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
    await rm(temporary, { force: true });   // On success this is a no-op; on failure it cleans up
  }
}
```

Four steps, and each step has its reason:

| Step | Why it is done this way |
| --- | --- |
| Temporary file in the **same directory** | `rename()` is atomic only inside one file system. A `rename` across disks degrades to "copy + delete", and a half file can appear in between |
| `open(temporary, "wx")` | `wx` is the exclusive creation flag: if the file already exists, it fails directly instead of overwriting somebody else's temporary file |
| `handle.sync()` | The return of `writeFile` means only that the data entered the operating system cache. `sync()` forces a flush to the physical disk. Without this step, after a power loss the `rename` may already be in effect while the content has not reached the disk |
| `rename(temporary, path)` | POSIX and Windows both guarantee that a `rename` in the same directory is atomic: the target path holds either the old content or the new content, never an intermediate state |
| `finally` block `rm(force: true)` | If any earlier step fails, the temporary file must be cleaned up. `force: true` makes "the file does not exist" not an error. On the success path, the file has already been renamed away |

The temporary file name is `.${randomUUID()}.tmp`. The leading dot makes it a hidden file on Unix, and the UUID guarantees that two concurrent writes do not collide on a name. With the lock in place there should be no concurrent writes, but the temporary file name does not depend on the correctness of the lock. That is one more layer of safety.

### What remains on disk when it fails

Inject an `atomicReplace` that always fails. Measured:

```text
=== 4. An ID collision and an atomic write failure both do not overwrite the old file ===
The generator gives the same ID again -> TaskGraphError(task_graph_error): task id already exists: 1111...
Disk failure during atomic replacement     -> TaskStorageError(task_storage_error): Task file persist failed: 1111...
Are the old file bytes completely unchanged: true
The task state is still: pending
Short ID: 1111, subject is still: keep
```

Three guarantees:

- **The old file bytes are completely unchanged.** Not "the content looks the same". They are identical byte by byte under `Buffer.equals()`.
- **The caller receives a typed error** (`TaskStorageError` / `task_storage_error`), not a silent failure.
- **An ID collision does not overwrite either.** If the generator produces an existing UUID, `create_task` fails explicitly instead of replacing the old task. The collision probability of `randomUUID()` is negligible, but this check stops the case "a bad generator was injected". This chapter's tests do exactly that.

### This is not a database transaction

The boundary must be stated clearly. Atomic replacement guarantees only this: **one single-file replacement never produces a half file**.

It does **not** guarantee:

- That writes to multiple files succeed or fail together. Every operation in this chapter writes one file, so this problem does not arise. But if a future design must "complete A and update B at the same time", atomic replacement cannot give cross-file atomicity.
- Consistency between the task file and external side effects. The Agent claims a task and changes source files, and then `complete_task` fails. The source changes do not roll back.

The graph-level lock guarantees that "no other compliant writer inserts itself between the condition check and this replacement". Together, the two mechanisms are enough to support this chapter's contract, but they are not a transaction. The SQLite TaskStore in Chapter 17 puts multi-task work stealing and leases into real transactions.

---

## Prove It Is Still a DAG at Creation

The input of `create_task` has only three fields:

```json
{
  "subject": "endpoints",
  "description": "create API endpoints",
  "blocked_by": ["1b73c624-7ae6-4e78-83d5-7bcf91dd5f13"]
}
```

**Note that there is no `id`.** The injectable generator produces the UUID. The model is not allowed to specify it:

```typescript
#generatedId(): string {
  let value: string;
  try {
    value = this.#idGenerator();
  } catch (error) {
    throw new TaskGraphError("task id generator failed", { cause: error });
  }
  try {
    return canonicalTaskId(value);
  } catch (error) {
    throw new TaskGraphError("generated task id must be a canonical UUID", { cause: error });
  }
}
```

The generator defaults to `randomUUID` from `node:crypto`. In tests it is replaced by a fixed sequence. Even a self-injected generator must pass the canonical UUID validation on its output. **Code inside the trust boundary must also validate its output.**

### Five steps inside the lock

```typescript
return await this.#withLock(paths, async () => {
  // Rebuild the whole graph inside the lock, and decide whether to write in the order "no collision -> dependencies exist -> no self-dependency -> whole graph has no cycle".
  const graph = await this.#loadGraph(paths);
  const id = this.#generatedId();
  if (graph.has(id)) {
    throw new TaskGraphError(`task id already exists: ${id}`);
  }
  const task = new Task({ /* ... */ });     // The constructor validates the invariants of the six fields
  const candidate = new Map(graph);
  candidate.set(task.id, task);
  validateGraph(candidate);                 // Validate on the candidate graph, not on the real graph
  await this.#writeTask(paths, task);       // Write to disk only after everything passes
  return task;
});
```

The order is deliberate:

1. **Reload the whole graph** (inside the lock, get the latest state)
2. **Generate the ID and check for a collision** (overwrite no existing task)
3. **Construct the `Task`** (the invariants of the six fields are validated here)
4. **Run the whole-graph validation on the candidate graph** (dependencies exist, no self-dependency, no cycle)
5. **Atomically write only after everything passes**

The `candidate` in step 4 is a **copy**: `new Map(graph)`, then add the new node. When validation fails, the real `graph` is untouched, and the disk is untouched. This is the "prove first, then commit" style.

### validateGraph does two things

```typescript
function validateGraph(graph: ReadonlyMap<string, Task>): void {
  // Before a write, validate the dependency references and cycles, so later claim/complete calls handle only a valid DAG.
  for (const task of graph.values()) {
    for (const dependency of task.blockedBy) {
      if (dependency === task.id) {
        throw new TaskGraphError(`Task ${task.id} must not depend on itself`);
      }
      if (!graph.has(dependency)) {
        throw new TaskGraphError(`Task ${task.id} dependency does not exist: ${dependency}`);
      }
    }
  }
  // Then DFS cycle detection
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new TaskGraphError(`Task graph contains a cycle at ${id}`);
    }
    if (visited.has(id)) {
      return;                    // Do not walk a subgraph already confirmed acyclic again
    }
    visiting.add(id);
    // ...recurse over all dependencies
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of graph.values()) {
    visit(task.id);
  }
}
```

The cycle detection uses the classic **three-colour DFS**:

```text
Unvisited (in no set)    -> not seen yet
visiting (grey)              -> on the current DFS path
visited (black)              -> this subgraph is confirmed acyclic
```

If the DFS reaches a node that is still in `visiting`, it has looped back. There is a cycle. The `visited` set makes each node fully walked at most once, so the whole check is O(V + E), not exponential.

### Measured: five rejections at creation

```text
=== 3. Graph validation at creation (fails before the disk write) ===
Dependency ID does not exist     -> TaskGraphError(task_graph_error): Task 1111... dependency does not exist: 2222...
Depends on itself           -> TaskGraphError(task_graph_error): Task 1111... must not depend on itself
The same ID repeated as a dependency   -> TaskGraphError(task_graph_error): task dependencies must be unique
subject is all spaces    -> TaskStorageError(task_storage_error): task subject must not be empty
Task count after the failures = 0
```

The last line is the key: **after four failures, the disk holds no task at all**. All validation happens before the disk write.

### Why "dependency does not exist" must fail

This is a design choice, and it is a place where this chapter changed relative to earlier versions.

A more "tolerant" approach is this: when a dependency ID does not exist, treat it as "not created yet" and keep the task `pending`. It sounds flexible. You can declare the dependency relation first and add the depended-on task later.

The problem is that this **turns a typo into a permanent silent fault**:

```text
The model wants to depend on schema, but copies the ID with one digit wrong
  -> Tolerant approach: task creation succeeds, state pending
  -> Who completes that non-existent dependency? Nobody
  -> This task stays pending forever and never becomes ready
  -> No error message at all, and list_tasks looks perfectly normal
```

This kind of bug is extremely hard to track down: the graph looks right, and the task simply does not move. The cost of an explicit failure is only "the model calls `list_tasks` once more to get the correct ID". It should do that anyway.

So the legal API allows only **a new task pointing at existing tasks**. This constraint has one side effect: it makes multi-node cycles almost impossible to produce through the normal API. Think about it. If every new task can depend only on existing tasks, the dependency edges always point in the "new -> old" direction. The graph is naturally acyclic.

Then why still run cycle detection? Because the **disk may be damaged by hand**, or the data may come from an old version. The whole-graph validation at rebuild time catches it:

```text
Two tasks depend on each other (a cycle)   -> TaskGraphError(task_graph_error): Task graph contains a cycle at 1111...
Depends on a task that does not exist     -> TaskGraphError(task_graph_error): Task 1111... dependency does not exist: 4444...
```

When `list_tasks` meets such a graph, it does not skip them and does not return half a graph. It reports a `TaskGraphError`.

---

## The Five Tools: Schema and Handler from One Source

The domain layer is complete now. Wrap it into tools the model can call.

Register all five at once:

```typescript
export function registerTaskTools(registry: ToolRegistry, store: TaskStore): void {
  // All five tools are registered here; schema and handler both come from the same ToolDefinition.
  registry.register(createTaskDefinition(store));
  registry.register(taskIdDefinition("get_task", "...", "read", store));
  registry.register({ name: "list_tasks", /* ... */ });
  registry.register(taskIdDefinition("claim_task", "...", "write", store));
  registry.register({ name: "complete_task", /* ... */ });
}
```

Measured registration order (the order the model sees in the `tools` array):

```text
=== 1. Registration order and the tool names the model sees ===
create_task  get_task  list_tasks  claim_task  complete_task
```

This order is not arbitrary. It is the model's workflow: **build the graph -> query one -> query all -> claim -> complete**. The tool list itself is an implicit process description.

| Tool | effect | Input | Returns |
| --- | --- | --- | --- |
| `create_task` | `write` | `subject`, `description?`, `blocked_by?` | The new task |
| `get_task` | `read` | `task_id` | A single task |
| `list_tasks` | `read` | `{}` | `{ tasks: [...] }`, sorted by ID |
| `claim_task` | `write` | `task_id` | The task after the claim |
| `complete_task` | `write` | `task_id` | `{ task, unblocked: [...] }` |

The `effect` field comes from the permission layer in Chapter 8: `read` tools can execute automatically, and `write` tools go through the approval policy. All three write tools change the disk, so all are marked `write`.

### Three schemas, all strict

```typescript
const taskIdSchema = z.string().regex(CANONICAL_UUID, "task_id must be a canonical UUID");

const createTaskSchema = z
  .object({
    subject: z.string().trim().min(1),
    description: z.string().trim().default(""),
    blocked_by: z.array(taskIdSchema).default([]),
  })
  .strict();
const taskIdInputSchema = z.object({ task_id: taskIdSchema }).strict();
const listTasksInputSchema = z.object({}).strict();
```

Three schemas cover five tools: `get_task` and `claim_task` share `taskIdInputSchema`, and `complete_task` uses it too.

Note several details:

- **`.strict()` appears on every schema.** Passing a field that is not in the schema fails directly. It is not ignored.
- **`listTasksInputSchema` is `z.object({}).strict()`, not `z.any()`.** An empty object must also be strict: `list_tasks` accepts no parameter at all, and passing `{ status: "pending" }` is rejected.
- **`description` and `blocked_by` have `.default()`.** The model can create a task with only `subject`.
- **`.trim()` comes before `.min(1)`.** So `"   "` is first trimmed to `""`, and then rejected by `min(1)`.

Measured defaults:

```text
=== 5. Defaults of create_task ===
create_task   identity=planner  -> {"blocked_by":[],"description":"","id":"3333...","owner":null,"status":"pending","subject":"Only subject given"}
```

### Four bad task_id forms stopped at the schema layer

```text
=== 4. An invalid task_id is stopped at the schema layer ===
get_task  { task_id: "../outside" }                          -> invalid_arguments
get_task  { task_id: "11111111111141118111111111111111" }    -> invalid_arguments  # 32 characters, no hyphens
get_task  { task_id: "9D59F5EC-7C94-49A7-B728-F36007FD912C" } -> invalid_arguments  # uppercase
get_task  { task_id: "22222222-2222-4222-8222-222222222299" } -> task_not_found     # format correct, does not exist
list_tasks { status: "pending" }                              -> invalid_arguments  # extra field
```

The first three and the last one never even entered the handler. The `registry.prepare()` stage already returned `invalid_arguments`. The fourth has a legal format, so it entered the handler and then got `task_not_found` from the domain layer.

**This boundary matters**: a format error is `invalid_arguments` (protocol layer), and an existence error is `task_not_found` (domain layer). When the model sees different error codes, it knows whether to fix the format or fix the ID.

### The handler only forwards

```typescript
handler: async (input) => {
  try {
    // The handler only forwards from the input to the TaskStore; whole-graph validation and atomic writes are the responsibility of the persistence boundary.
    const task = await store.createTask({
      subject: input.subject,
      description: input.description,
      blockedBy: input.blocked_by,
    });
    return toolSuccess(encodePayload(taskPayload(task)));
  } catch (error) {
    return taskToolError(error);
  }
},
```

There is no business judgement in the handler. No "check the state first", no "fill in a default on the side", and no retry. It does only three things: **rename the field (`blocked_by` -> `blockedBy`), call the store, and encode the result as JSON**.

All validation lives in the `TaskStore`, because that is where the lock is. A check placed in the handler is all TOCTOU: between the check and the real write, another process may already have changed the state.

### How the error code travels out

```typescript
function taskToolError(error: unknown) {
  // A known domain error keeps its stable error code; an unknown exception keeps travelling upward, to avoid swallowing a program defect.
  if (error instanceof TaskError) {
    return toolError(error.code, error.message);
  }
  throw error;
}
```

Two branches, with a clear boundary:

- **A `TaskError` subclass** -> converted into `toolError(code, message)`. The model sees a stable error code and can decide the next step from it.
- **Any other exception** -> keeps travelling upward.

The second branch is deliberate. If you wrote `catch (e) { return toolError("unknown", String(e)) }` here, a `TypeError: cannot read property of undefined` (a real code bug) would be wrapped into a tool error message and fed to the model. The model would try to "retry". In the logs you would see only "the tool failed", with no stack. A program defect must explode out.

### Fields returned to the model use the disk naming

```typescript
function taskPayload(task: Task): Readonly<Record<string, unknown>> {
  // The fields returned to the model use the disk naming blocked_by, to avoid an inconsistency between the wire format and the storage format.
  return {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
}
```

Inside the `Task` class it is called `blockedBy` (TypeScript camelCase). On disk and in tool parameters it is called `blocked_by` (JSON snake_case). The conversion happens in only this one function and one line of the handler.

`[...task.blockedBy]` is a copy, not a direct return. The array inside `Task` is frozen with `Object.freeze`, but returning a copy is clearer: the caller can change the returned array as it likes, and it cannot touch the domain object.

Measured complete normal flow:

```text
=== 3. Normal flow ===
create_task   identity=planner  -> {"blocked_by":[],"description":"Create the database tables","id":"1111...","owner":null,"status":"pending","subject":"schema"}
create_task   identity=planner  -> {"blocked_by":["1111..."],"description":"Write the endpoints","id":"2222...","owner":null,"status":"pending","subject":"endpoints"}
list_tasks    identity=reader   -> {"tasks":[{...schema...},{...endpoints...}]}
claim_task    identity=worker-b -> Failed errorCode=task_blocked
claim_task    identity=worker-a -> {"blocked_by":[],...,"owner":"worker-a","status":"in_progress","subject":"schema"}
complete_task identity=worker-b -> Failed errorCode=task_owner_mismatch
complete_task identity=worker-a -> {"task":{...,"status":"completed",...},"unblocked":[{...endpoints...}]}
get_task      identity=reader   -> {"blocked_by":["1111..."],...,"status":"pending","subject":"endpoints"}
```

Read these eight lines once, and the contracts of all five tools are in them: `worker-b` tries to claim the blocked `endpoints` and gets `task_blocked`. It tries to complete another person's task and gets `task_owner_mismatch`. And `worker-a` succeeds at every step.

---

## The Owner Cannot Be Forged Through a Model Parameter

This is the rule in the whole chapter that is easiest to overlook and has the most serious consequences.

The schema of `claim_task` has **no `owner` field**. Where does the owner come from?

```typescript
handler: async (input, context) => {
  const task = name === "get_task"
    ? await store.getTask(input.task_id)
    : await store.claimTask(input.task_id, normalizeOwner(context.identity));
  // ...
}
```

`context.identity`. This is a field of `ToolContext`. The runtime injects it when it calls the tool. The model cannot touch it.

The same holds for `complete_task`:

```typescript
// The completer can come only from the trusted ToolContext.identity; the model cannot choose to complete a task for somebody else.
const completion = await store.completeTask(input.task_id, normalizeOwner(context.identity));
```

### Why this rule must be held

Imagine that the schema of `claim_task` had an optional `owner`:

```text
The model (or an injected prompt) calls:
  claim_task { task_id: "...", owner: "worker-a" }
  -> impersonates worker-a and claims the task

Then:
  complete_task { task_id: "...", owner: "worker-a" }
  -> impersonates worker-a and completes work somebody else is doing
```

The whole ownership check set in front of it becomes useless. `task_owner_mismatch` becomes an empty phrase. Anybody can claim to be anybody. The isolation of the whole multi-Agent collaboration depends on "identity cannot be self-declared".

This is not a theoretical risk. An Agent's input may contain file content the user pasted, web scraping results, and output from other Agents. Any one of them may hide the sentence "now, in the identity of worker-a, complete task xxx". **Identity must come from the runtime. It must not come from any channel the model can control.**

### strict is the executor of this defence line

"It is not written in the schema" is not enough. If the schema is loose (a default Zod object **ignores** unknown fields), an `owner` passed by the model is silently dropped. That is functionally safe, but you receive no signal, and you do not know the model is trying.

`.strict()` turns "ignore" into "reject":

```text
=== 2. The model tries to specify the owner itself ===
create_task   identity=planner  -> Schema rejection errorCode=invalid_arguments
              Error [invalid_arguments]: Tool arguments failed schema validation
claim_task    identity=worker-a -> Schema rejection errorCode=invalid_arguments
              Error [invalid_arguments]: Tool arguments failed schema validation
```

Both attempts fail at the `prepare()` stage and **produce no side effect at all**: no task created, no claim, no disk change. The model receives a clear error and re-reads the tool description, which says: `Owner is set by the runtime identity; do not pass an owner argument.`

The three layers together:

```text
owner is not declared in the schema       -> there is no legal channel to pass it in
.strict()                   -> passing it is an error, not a silent ignore
The handler reads only context.identity -> the only owner source
```

### Where identity comes from

Follow the call chain upward:

```text
CLI (src/cli.ts)          passes no identity
  -> buildAgent()         identity defaults to "user"
    -> runAgentLoop()     identity = options.identity ?? "user"
      -> ToolContext      { workspace, identity }
        -> handler        context.identity === "user"
```

So for tasks run by this chapter's CLI, the `owner` is always `"user"`. The tests explicitly pass values such as `identity: "worker-a"` to verify multi-identity scenarios.

**This is also why the three processes at the start do not step on each other in relay**: their owner is all `"user"`, so they look like the same person. But every `claim_task` checks the state inside the lock. If the second process tries to claim a task that is already `in_progress`, it still gets `task_invalid_state`. The state machine protection does not depend on the owners being different.

`normalizeOwner` adds one more normalisation layer:

```typescript
export function normalizeOwner(value: string): string {
  if (typeof value !== "string") {
    throw new TaskOwnershipError("task owner must be a string");
  }
  // Trim first, then check for emptiness, so a string with leading and trailing spaces is not treated as two different owners.
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskOwnershipError("task owner must not be empty");
  }
  return normalized;
}
```

`"worker-a"` and `" worker-a "` normalise to the same owner. Without this step, one extra space could make `complete_task` report `task_owner_mismatch`, while you stare at two strings in the log that look exactly the same and doubt your sanity.

---

## Claim: Three Checks, and the Order Cannot Change

`claimTask` does four things inside the lock:

```typescript
return await this.#withLock(paths, async () => {
  const graph = await this.#loadGraph(paths);         // 1. Reload inside the lock
  const task = graph.get(id);
  if (task === undefined) {
    throw new TaskNotFoundError(`Task not found: ${id}`);
  }
  if (task.status !== TaskStatus.PENDING) {           // 2. The status must be pending
    throw new TaskStateError(`Task ${id} must be pending to claim`);
  }
  const blockedBy = task.blockedBy.filter((dependency) => {   // 3. Compute the incomplete dependencies now
    const dependencyTask = graph.get(dependency);
    return dependencyTask === undefined || dependencyTask.status !== TaskStatus.COMPLETED;
  });
  if (blockedBy.length > 0) {
    throw new TaskBlockedError(id, blockedBy);
  }
  const claimed = new Task({ ...task, status: TaskStatus.IN_PROGRESS, owner: normalizedOwner });
  await this.#writeTask(paths, claimed);              // 4. Write only this one file
  return claimed;
});
```

Step 3 is the "blocked is computed" point from the section "Why There Is No Fourth Blocked State". The `filter` keeps all dependencies that are **not completed**. It reports exactly as many as remain:

```typescript
class TaskBlockedError extends TaskError {
  constructor(taskId: string, blockedBy: readonly string[]) {
    super("task_blocked", `Task ${taskId} is blocked by: ${blockedBy.join(", ")}`);
  }
}
```

The message the model receives carries **exactly which dependencies are not complete yet**, not a bare "blocked". It can take these IDs directly to `claim_task`. It does not need another `list_tasks` call to guess.

The `dependencyTask === undefined` branch should theoretically be unreachable. `validateGraph` already guarantees that the dependencies exist. But it is defensive: if an inconsistency ever appears between `loadGraph` and `validateGraph`, this branch treats it as "dependency not complete" and rejects the claim, instead of treating it as "dependency complete" and letting it through. **When you choose a failure direction, choose the conservative side.**

### Why the state check comes before the dependency check

Swapping the order gives a misleading error. Suppose a task is already `in_progress`, and one of its dependencies is `completed`:

```text
Current order: state check first -> "must be pending to claim" (correct, this task has already been taken)
Swapped order:  dependency check first -> all dependencies are complete, pass -> then the state error is reported
```

The second form also errors in the end. But if the dependencies happen to include an incomplete one, you would see `task_blocked`, while the real reason is "it has already been claimed by somebody else". **Report the earliest and most fundamental reason first.**

### No unclaim

What if you claim a task and cannot finish it? This chapter's answer is: **there is no way**. The task stays at `in_progress` forever.

This is not an omission. It is a deliberate narrowing. Adding an `unclaim_task` immediately brings a string of questions:

- Who may unclaim? Only the owner, or can anybody take it back?
- How does a crashed process unclaim automatically? It needs a heartbeat, a lease, and a timeout.
- How long a timeout counts as dead? A large refactor legitimately takes 30 minutes.

These questions form the complete design of a **task lease**. That design alone is enough for a chapter. The SQLite TaskStore in Chapter 17 does this work: leases, heartbeats, timeout reclamation, and work stealing. Until then, `in_progress` is final. The cost of one rerun is far lower than the cost of a wrongly designed lease.

---

## Complete: Report Only the Tasks This Completion Directly Unlocks

`completeTask` is the only one of the five tools that returns two data parts:

```typescript
const completed = new Task({ ...task, status: TaskStatus.COMPLETED });
const candidate = new Map(graph);
candidate.set(id, completed);
// Report only pending Tasks that directly depend on this completion and whose dependencies are all completed; do not rewrite downstream files.
const unblocked = [...candidate.values()]
  .filter(
    (dependent) =>
      dependent.status === TaskStatus.PENDING &&
      dependent.blockedBy.includes(id) &&
      dependent.blockedBy.every(
        (dependency) => candidate.get(dependency)?.status === TaskStatus.COMPLETED,
      ),
  )
  .sort((left, right) => compareText(left.id, right.id));
await this.#writeTask(paths, completed);              // Note: write only one file
return Object.freeze({ task: completed, unblocked: Object.freeze(unblocked) });
```

None of the three filter conditions can be dropped:

| Condition | Case it excludes |
| --- | --- |
| `status === PENDING` | A downstream task already in progress or complete does not count as "unlocked" |
| `blockedBy.includes(id)` | A task unrelated to this completion (even if it happens to be ready) |
| `blockedBy.every(... COMPLETED)` | A task that still has other incomplete dependencies |

`candidate` appears again: add `completed` to the copy, then compute unblocked on the copy. This way, when `every(...)` checks the task that just completed, it sees the `completed` state, not the `in_progress` state that is still on disk.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaGv911icaO7f2g8PDWFP6Jsj9BVlKjsaqPuH1a1HZhjvqmiaNYjTkbnu8YL2VcLHibqZcR6pj9H6XjwFBqZBLrRD7gTibw3kLISTfI/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=2)

### Verify the semantics with a diamond graph

The theory is done. Look at the measurement. This graph has a fork, a join, and one isolated node:

```text
schema ──> endpoints ──> tests ──┐
   └────> docs ──────────────────┴─> release
lint (independent, no dependencies)
```

`release` depends on both `tests` and `docs`. `lint` depends on nobody and is ready from the start.

**Step one, complete schema:**

```text
unblocked = [endpoints, docs]
Is lint in it = false (it was ready from the start, so it does not count as "unlocked by this completion")
Is tests in it = false (it still waits for endpoints)
Is release in it = false
```

All three semantics verified at once:

- `endpoints` and `docs` depend on `schema` directly and have no other dependency -> reported.
- `lint` is ready from the start, but it does not depend on `schema` -> **not reported**. This is the role of `blockedBy.includes(id)`. The semantics of unblocked is "became ready because of this completion", not "all tasks that are ready now".
- `tests` depends on `endpoints`, and `endpoints` is not complete yet -> not reported.
- `release` is two levels away -> not reported. **There is no transitive closure.**

**Step two, complete endpoints:**

```text
unblocked = [tests]
Is docs in it = false (already unlocked in the previous round, not reported again in this round)
```

`docs` is still `pending` and ready now. But it does not depend on `endpoints`, so it is not in this round's report. **Each task is reported exactly once, at the moment that unlocks it.**

**Step three, complete tests:**

```text
unblocked = []
release still lacks docs, so it is not reported
```

An empty array. Only one of the two dependencies of `release` is complete, so `blockedBy.every(... COMPLETED)` does not hold. This is the correct behavior of a join node. If `release` were reported here, the model would go to claim it and immediately get `task_blocked`. A wasted trip.

**Step four, complete docs:**

```text
unblocked = [release]
```

The last dependency arrives, and only then is `release` reported.

### Why downstream files are not rewritten

Look at that comment: **do not rewrite downstream files**.

An intuitive approach is this: when a task completes, delete this ID from the `blocked_by` of all downstream tasks. Then an empty `blocked_by` would mean ready, and `claim` would not need to compute it on the spot.

The cost is:

```text
Complete a node that 20 tasks depend on
  -> 21 files must be rewritten (itself + 20 downstream)
  -> The 15th write fails
  -> The first 14 are already changed, the last 5 are not
  -> The disk holds an inconsistent graph, and no mechanism can repair it
```

Single-file atomic replacement cannot give atomicity for 21 files. The current approach **writes exactly one file per operation**. So "the atomicity of one operation" and "the atomicity of one file replacement" are the same thing. The ready state is computed fresh every time. The cost is O(number of dependencies), which is negligible.

### Sorting

`unblocked` is sorted in ID lexicographic order (`compareText`). `list_tasks` does the same:

```text
=== Sorting of list_tasks ===
1111  schema     completed
2222  endpoints  completed
3333  tests      completed
4444  docs       completed
5555  lint       pending
6666  release    pending
Lexicographic by ID, not creation order, and not state order
```

Why not sort by creation time or by state? Because the **disk has no creation time field** (there is no timestamp among the six fields). The `readdir` order of the file system is not guaranteed to be consistent across platforms, and `mtime` changes with `claim` and `complete`. ID sorting is the only stable choice that needs no extra field and is consistent across platforms.

A stable order matters for an Agent: two `list_tasks` calls on the same graph return the same order, so the model's reasoning is reproducible. Real UUIDs are random, so this order looks scrambled. But it is stable. To view the graph by dependency level, the model can topologically sort by `blocked_by` itself.

---

## Rebuild Is Not "Count Whatever You Scan"

Every operation must rebuild the whole graph from disk. This is the place in this chapter that is easiest to write wrong, because the "tolerant" version looks friendlier and is actually more dangerous.

```typescript
async #loadGraph(paths: JsonTaskPaths): Promise<Map<string, Task>> {
  // A rebuild must load and validate the whole graph; damage to any file makes the whole store fail explicitly.
  let entries: readonly Dirent[];
  try {
    entries = (await readdir(paths.tasks, { withFileTypes: true }))
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((left, right) => compareText(left.name, right.name));
  } catch (error) {
    throw new TaskStorageError("Task files could not be listed", { cause: error });
  }
  const graph = new Map<string, Task>();
  for (const entry of entries) {
    const path = join(paths.tasks, entry.name);
    let task: Task;
    try {
      const information = await lstat(path);
      if (!information.isFile() || information.isSymbolicLink()) {
        throw new Error("Task file is not a regular file");
      }
      const payload = JSON.parse(UTF8_DECODER.decode(await readFile(path))) as unknown;
      task = parseStoredTask(payload);
    } catch (error) {
      // ...uniformly wrapped into a TaskStorageError(`Task file is invalid: ${entry.name}`)
    }
    if (entry.name !== `${task.id}.json`) {
      throw new TaskStorageError(`Task filename does not match payload id: ${entry.name}`);
    }
    if (graph.has(task.id)) {
      throw new TaskStorageError(`Duplicate task id: ${task.id}`);
    }
    graph.set(task.id, task);
  }
  validateGraph(graph);
  return graph;
}
```

Take each link apart.

### Only .json counts, no recursion

`filter(entry => entry.name.endsWith(".json"))` excludes `.tmp` temporary files, the `.tasks.lock` directory, and an editor's `.swp` files. If somebody scans the directory during an atomic replacement, they see a `.uuid.tmp`. It does not end with `.json`, so it is skipped.

`readdir` is called without `recursive`, so nothing inside subdirectories is looked at.

Sorting uses `compareText` (a stable wrapper around `Intl.Collator`), which guarantees a consistent order across platforms. The `readdir` order itself differs between ext4 and NTFS.

### lstat, not stat

```typescript
const information = await lstat(path);
if (!information.isFile() || information.isSymbolicLink()) {
  throw new Error("Task file is not a regular file");
}
```

`stat` follows symlinks. `lstat` does not. If `.tasks/xxx.json` is a symlink that points to `C:\Windows\System32\config\SAM`, `stat` would say "this is a file" and then read it. `lstat` sees the link itself, `isSymbolicLink()` returns true, and it is rejected directly.

This rule and the earlier "Path Escape: Three Gates" are the same class of defence, but they cover different entrances: that section defends against "the directory is replaced by a link", and this one defends against "a single task file is replaced by a link".

### Fatal-mode UTF-8 decoding

```typescript
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
```

`fatal: true` is the key. The default `TextDecoder` **silently replaces** an illegal byte sequence with `\uFFFD` (the replacement character). A damaged file could then decode into a string that "looks like legal JSON", with a few garbled blocks in the `subject`, and be loaded as a valid task.

`fatal: true` makes illegal bytes throw a `TypeError` directly, which the outer layer wraps into `Task file is invalid`.

The order also matters: **decode first, then `JSON.parse`**. `JSON.parse` accepts a Buffer (with an implicit `toString()`), but that path uses tolerant decoding. Only an explicit decode first makes `fatal` take effect.

### Exactly six keys

```typescript
function parseStoredTask(value: unknown): Task {
  // The disk schema must match the six fields exactly; an extra or missing field makes the whole graph recovery fail.
  if (!hasExactKeys(value, ["id", "subject", "description", "status", "owner", "blocked_by"])) {
    throw new TaskStorageError("Task file has an invalid schema");
  }
  // ...then check the type of each field
}
```

`hasExactKeys` checks for an **exact match**, not "at least contains": one extra field fails, and one missing field fails.

Why must one extra field fail? Because it means this file comes from **another schema version**. If it has an extra `priority` field, tolerant loading would ignore it, and then `complete_task` would drop it when it writes back. A field the user added by hand would silently disappear. That is much harder to track down than an explicit error.

The field type checks are also written explicitly, one by one, without Zod. This code sits in the storage adapter, below the tool layer. Fewer dependencies are better. And these checks must control the error messages precisely, so you can locate which field is broken.

### The file name must equal the id in the payload

```typescript
if (entry.name !== `${task.id}.json`) {
  throw new TaskStorageError(`Task filename does not match payload id: ${entry.name}`);
}
```

This check runs **after** `parseStoredTask`. First confirm that it is a structurally legal task, then confirm that it sits in the right place.

Why must they match? Because `getTask(id)` **splices the path directly and reads the file**:

```text
getTask("1111-...") -> reads .tasks/1111-....json
```

If the file name and the content id were allowed to differ, `getTask` would read a task whose id does not match. And `listTasks` goes through `loadGraph`, which builds the Map by the id in the payload. The two paths would give different answers.

### Three validation layers, from one file to the whole graph

```text
parseStoredTask   -> the structure and field types of a single file
new Task(...)     -> the invariants of a single task (state-owner pairing, non-empty subject, ID format)
validateGraph     -> relations across tasks (dependencies exist, no self-dependency, no cycle)
```

The three layers run in order. If any layer fails, the whole `loadGraph` fails.

### Fail closed: one bad file poisons the whole graph

This is the core decision of this chapter, and it deserves its own measurement:

```text
=== 2. Is a bad file simply skipped ===
With two good files, listTasks returns 2
After one bad file is added, listTasks -> TaskStorageError: Task file is invalid: 3333....json
Now read one of the two good tasks with get_task -> TaskStorageError: Task file is invalid: 3333....json
```

The third line is the point: **`get_task` reads a perfectly good task, and it fails too.** Because it also needs `loadGraph` (dependency relations need the whole graph), and `loadGraph` is all-or-nothing.

It looks very unfriendly. But the other choice is worse:

```text
Tolerant approach: skip the bad file and return the remaining N-1 tasks
  -> The broken task is endpoints, a dependency of three tasks
  -> Now the blocked_by of those three tasks points at an ID that "does not exist"
  -> validateGraph says the dependency does not exist -> it still fails
  -> Even if you relax that rule, claim treats "dependency does not exist = not complete" -> blocked forever
  -> Or worse: it treats "dependency does not exist = can be ignored" -> the dependency relation is silently bypassed
```

A DAG that misses one node makes the remaining edges meaningless. **"A partly correct graph" is not a useful concept.** It only makes the Agent work on wrong dependency relations.

The benefit of an explicit failure is that it is repairable: the error message carries the exact file name. You open that file and see the problem. Tasks are independent JSON files. Fix one file by hand and the graph recovers.

### Nine bad disk states, measured

First, seven kinds of damage at the single-file level:

```text
=== 1. Seven bad disk states, all fail the whole graph ===
Broken JSON text                     -> TaskStorageError: Task file is invalid: 1111....json
Unknown state status=unknown          -> TaskStorageError: Task file is invalid: 2222....json
One extra field priority              -> TaskStorageError: Task file is invalid: 1111....json
One missing field (description deleted)    -> TaskStorageError: Task file is invalid: 1111....json
File name does not match the payload id        -> TaskStorageError: Task filename does not match payload id: 2222....json
pending but has an owner               -> TaskStorageError: Task file is invalid: 1111....json
in_progress but has no owner         -> TaskStorageError: Task file is invalid: 1111....json
```

Add the two graph-level kinds of damage from the earlier section "Why 'Dependency Does Not Exist' Must Fail":

```text
Two tasks depend on each other (a cycle)            -> TaskGraphError: Task graph contains a cycle at 1111...
Depends on a task that does not exist              -> TaskGraphError: Task 1111... dependency does not exist: 4444...
```

Nine cases, two error code classes:

| Error code | Coverage | Meaning |
| --- | --- | --- |
| `task_storage_error` | The first seven | A single file has a problem in structure, fields, or position |
| `task_graph_error` | The last two | Every single file is legal, but their relations are not legal |

This distinction is useful for the model: `task_storage_error` hints that one file is broken (the message has the file name), and `task_graph_error` hints that the graph structure is broken (the message has the task IDs involved).

### The write-back format is fixed

```typescript
function serializeTask(task: Task): Buffer {
  // Fix the field order and the trailing newline, so task files can be diffed and audited, and the written content does not drift randomly.
  const payload = {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}
```

The fields are fixed in alphabetical order, and a `\n` is added at the end.

The key order of `JSON.stringify` depends on the insertion order of the object, so it is fixed explicitly in alphabetical order here. The benefit is that the field order of one task never changes, no matter how many `claim` and `complete` operations it passes through. `git diff` then shows only the fields that really changed. The trailing newline makes the file follow the POSIX text file convention, so after a `cat` it does not stick to the next line.

Single line instead of pretty-print: task files are read by programs. When a human needs to read one, a `jq` pass is enough. A single line also makes `git diff` more compact: one task, one line.

---

## Connect It to the Progressive Bootstrap

The domain layer, the storage layer, and the tool layer are all ready. The last step connects it to `buildAgent`, and it must connect in a way that makes **wrong combinations impossible to assemble**.

This chapter adds one capability bit:

```text
P11 capability bits = { ..., recovery }
P12 capability bits = all of P11 + task_dag_json
```

`buildAgent` gains a pair of two-way checks:

```typescript
if (profile.capabilities.has("task_dag_json") && dependencies.taskStore === undefined) {
  // DAG capability must not silently degrade to in-memory tasks; refuse assembly when the persistence boundary is missing.
  throw new Error("taskStore is required for chapter 12 or later");
}

if (!profile.capabilities.has("task_dag_json") && dependencies.taskStore !== undefined) {
  throw new Error("taskStore requires chapter 12 or later");
}
```

Measured:

```text
=== 1. Capability bits and dependencies must come as a pair ===
P11 + taskStore -> Error: taskStore requires chapter 12 or later
P12 without taskStore -> Error: taskStore is required for chapter 12 or later
P12 + taskStore -> Build succeeds
```

### Why a two-way check

A one-way check misses two classes of bug, in opposite directions.

**Direction one (capability bit present, dependency missing)**: if you only "register the tools when a taskStore exists", a P12 that lacks the store builds successfully and silently. It simply has no five tools. The Agent runs and cannot find `create_task`, so the model turns to `todo_write` instead. **The tasks fall into memory, and when the process ends they are all gone.** You think you are using the persistent task engine, but you are actually using in-session todo. This degradation raises no error, which makes it the hardest to discover.

**Direction two (dependency present, capability bit missing)**: P11 receives a taskStore. That means the caller misunderstands the chapter capability. Making it fail explicitly is better than "quietly giving it five extra tools". The tool set of each chapter in the progressive course is assertable. One extra tool breaks the chapter boundary.

The pattern "capability bit and dependency appear as a pair" was already used in earlier chapters:

```typescript
if (dependencies.recoveryConfig !== undefined && !profile.capabilities.has("recovery")) {
  throw new Error("recoveryConfig requires chapter 11 or later");
}
if (profile.capabilities.has("recovery") && dependencies.recoveryConfig === undefined) {
  // The recovery capability and its configuration must appear as a pair, to prevent P11 from silently degrading to a raw ModelClient.
  throw new Error("recoveryConfig is required for chapter 11 or later");
}
```

Exactly the same structure. **Every new capability bit gets one pair of checks.** This is the fixed discipline of this bootstrap.

### The main Agent and subagents share the same store

The task tools are registered twice, with the **same store instance**:

```typescript
// In the tool factory of a subagent
if (dependencies.taskStore !== undefined) {
  // A subagent and the main Agent use the same TaskStore and see the same project graph.
  registerTaskTools(childTools, dependencies.taskStore);
}

// ...the main Agent
if (dependencies.taskStore !== undefined) {
  // The main Agent registers the persistent task tools directly, with the same TaskStore as the subagents.
  registerTaskTools(tools, dependencies.taskStore);
}
```

Note that a subagent's tool registry is **created fresh each time** (`createStandardTools(...)` is called inside `toolsFactory`). This avoids state leaking across tasks. But the store is shared, because it represents the one graph on disk, not in-process state.

This connects the `task` tool from Chapter 6 with this chapter's task graph: the main Agent builds the graph, spawns subagents to claim and complete tasks, and the main Agent can see the subagents' progress. `todo_write` could not do this before. Its list lives inside a `TodoTracker` instance, and a subagent gets a different instance.

### The complete P12 tool list

```text
=== 2. The complete tool sequence the P12 main Agent sees ===
 1. shell
 2. read_file
 3. write_file
 4. edit_file
 5. glob
 6. todo_write
 7. task
 8. load_skill
 9. create_task   <- new in this chapter
10. get_task      <- new in this chapter
11. list_tasks    <- new in this chapter
12. claim_task    <- new in this chapter
13. complete_task <- new in this chapter
13 in total
```

The first eight come from Chapters 2–11, in unchanged order. The five new tools are appended at the end.

The stable order is deliberate: `ch12-bootstrap.test.ts` contains an assertion that fixes these 13 names in order. Changing the tool registration order turns the test red. This is the concrete implementation of "the tool set of each chapter in the progressive course is assertable".

### CLI side: the capability bit decides whether a store is built

```typescript
// The P12 capability bit decides whether a JSON TaskStore is created, to prevent a lower version from accidentally starting the persistent task boundary.
const taskStore = profile.capabilities.has("task_dag_json")
  ? new JsonTaskStore(workspace)
  : undefined;
const runner = buildAgent(profile, {
  model,
  workspace,
  // ...
  ...(taskStore === undefined ? {} : { taskStore }),
});
```

`workspace` is `resolve(process.cwd())`. Run `npm run ch12` in a directory, and the tasks live under that directory's `.agent_tutorial/.tasks/`.

The spread `...(taskStore === undefined ? {} : { taskStore })` works together with `exactOptionalPropertyTypes`: instead of passing `taskStore: undefined`, the code **does not pass the key at all**. Under TypeScript strict mode, these two are not equivalent.

### Configuration errors come before store construction

Look at the order in `execute()`:

```typescript
const settings = existsSync(envPath) ? settingsFromEnvFile(...) : settingsFromMapping({}, ...);
const model = new OpenAIChatModel(settings);      // The configuration check is complete before this
const fileSystem = new NodeWorkspaceFileSystem();
const taskStore = profile.capabilities.has("task_dag_json") ? new JsonTaskStore(workspace) : undefined;
```

Configuration reading and validation happen **before** the `JsonTaskStore` construction. `ch12-entry.test.ts` asserts this: when four environment variables are missing, all four variable names must appear in the error message, and stderr must **not** contain `Task storage`.

Why care about this order? Because "no API key configured" and "a problem with the workspace path" are two completely different problem classes. If the store construction ran first and failed on a permission problem, the user would see `Task storage root is invalid` and go to check directory permissions, while the real problem is that `.env` was never created. **Report the most likely reason first.**

---

## Run Chapter 12

Everything above is principle. Now run it from zero.

### Step 0: Confirm the environment

```powershell
node --version
```

The `engines` field of `code/package.json` requires `node >= 20.12`. This chapter uses `randomUUID()` from `node:crypto` and `FileHandle.sync()`, both inside that range.

### Step 1: Install dependencies

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm install
```

The `code/` directory is one shared workspace. All 20 chapters share one `node_modules` and one `package.json`. The lock library this chapter uses is `proper-lockfile` (pinned at `4.1.2`), and it is already in the dependency list.

### Step 2: Run the tests first (no API key needed)

```powershell
npm run test:ch12
```

This step does not access the network and needs no model. When it finishes, you know the whole code set is good on your machine:

```text
Test Files  31 passed (31)
     Tests  271 passed (271)
```

The 31 test files are all tests accumulated from Chapters 1–12. Of the 271 assertions, the part this chapter adds covers: three-state progress, concurrent claiming, bad disk states, path escapes, bootstrap pairing, and the 13-tool list.

**If this step already fails**, do not continue downward. Common causes are a Node version that is too low, or an `npm install` that did not finish.

### Step 3: Configure the model

Create `.env` under `code/`:

```text
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_FALLBACK_MODEL=gpt-4o-mini
```

All four are required. The recovery capability from Chapter 11 requires an explicit `OPENAI_FALLBACK_MODEL`. It does not secretly fall back to the primary model.

**If any one of the four variables is missing, the CLI reports all missing items at once.** It does not report one, let you fix it, and then report the next.

### Step 4: A real run

```powershell
npm run ch12 -- --prompt "Use create_task to create two tasks: schema (create the database tables) and endpoints (write the endpoints, depends on schema), then call list_tasks and show me the graph."
```

The task files appear in the directory where you ran the command (`workspace = resolve(process.cwd())`, that is, `code/`):

```powershell
Get-ChildItem .agent_tutorial\.tasks\
Get-Content .agent_tutorial\.tasks\*.json | ConvertFrom-Json | Format-Table id, subject, status, owner
```

Then run once more with a different prompt, to verify cross-process persistence:

```powershell
npm run ch12 -- --prompt "Call list_tasks to see which tasks exist, then use claim_task to claim the ready one. Do only these two steps."
```

### Common error troubleshooting

| Symptom | Cause | What to do |
| --- | --- | --- |
| `Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_FALLBACK_MODEL` | `.env` does not exist or has missing items | Complete the four variables under `code/`. Note that it is `code/.env`, not the repository root |
| `Runtime Failure: turn deadline exceeded` | The model circles between tools and exceeds the turn limit | Write a specific prompt: name the tools to call, and say clearly "do only these steps" |
| `[Permission] shell: deny ... no interactive input, denied by default.` | The model tries to run shell, and this is not an interactive terminal | Normal protective behavior. Restrict the prompt to task tools only |
| `Error [invalid_arguments]: Tool arguments failed schema validation` | The model passed a field outside the schema (such as `owner`), or the task_id format is wrong | Ignore it; the model retries by itself. The tool description already says clearly not to pass an owner |
| `task_blocked: Task X is blocked by: Y` | It claimed a task whose dependencies are not complete | Complete the dependencies listed in the message first |
| `task_owner_mismatch` | It completes a task claimed under one identity with another identity | This chapter's CLI owner is always `user`; this error appears mainly in tests |
| `TaskStorageError: Task file is invalid: xxx.json` | That file was damaged by hand editing | Open it and repair it against the six-field format; or delete the whole `.tasks/` and start again |
| `TaskGraphError: Task graph contains a cycle at X` | Hand editing created a cycle | Change one `blocked_by` edge |

To reset completely, delete the whole directory (note: this discards all tasks and cannot be undone):

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item -Recurse -Force .agent_tutorial
```

The next `create_task` rebuilds it. A deleted task graph leaves no residue: one file per task, no index, no metadata.

---

## Eight Hands-On Experiments

Between understanding and being able to use it, one step remains: **break it by hand, then watch how it errors**.

Do the eight experiments below in order. The difficulty increases. **None of the eight needs an API key**, and none accesses the network. Experiment 1 gives one "real run" command, which does need `.env`, but the same experiment also gives an alternative that needs no key.

### Preparation: build a probe script first

Experiments 2–5 repeatedly "damage the disk, then watch how the store errors". Starting the full Agent each time is too slow, and it needs an API key. So first create a small script under `code/` that connects to the store directly:

```typescript
// code/peek.ts
import { JsonTaskStore } from "./chapters/ch12/src/adapters/task-json.js";

const store = new JsonTaskStore(process.cwd());
try {
  const tasks = await store.listTasks();
  console.log(`listTasks returns ${tasks.length} tasks`);
  for (const task of tasks) {
    console.log(`  ${task.id.slice(0, 4)}  ${task.subject}  ${task.status}  owner=${task.owner}`);
  }
} catch (error) {
  console.log(`Failed -> ${(error as Error).name}: ${(error as Error).message}`);
}
```

How to run it:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx peek.ts
```

It bypasses the model and calls the `TaskStore` directly, so it needs no API key. Remember to delete `peek.ts` after the experiments.

### Experiment 1: See clearly what a task file looks like

First create a few tasks. If `.env` is configured, a real run is the most direct:

```powershell
npm run ch12 -- --prompt "Use create_task to create three tasks: a, b (depends on a), c (depends on a)"
```

Without `.env` you can still create them. Temporarily add two lines to `peek.ts`:

```typescript
const a = await store.createTask({ subject: "a", description: "The first", blockedBy: [] });
await store.createTask({ subject: "b", description: "The second", blockedBy: [a.id] });
```

Then look at the disk:

```powershell
Get-ChildItem .agent_tutorial\.tasks\
Get-Content (Get-ChildItem .agent_tutorial\.tasks\*.json | Select-Object -First 1)
```

**What to observe**: one file per task, the file name is the UUID, the six fields are in alphabetical order, there is a trailing newline, and the field name is the underscore form `blocked_by`, not camelCase.

### Experiment 2: Change status by hand to a value that does not exist

Open any task file in an editor. Change `"status":"pending"` to `"status":"doing"`. Then:

```powershell
npx tsx peek.ts
```

**Expected**: `Failed -> TaskStorageError: Task file is invalid: xxx.json`.

**What to observe**: the error message contains the **exact file name**, so you can locate it directly. Any value outside the three legal states cannot enter the domain object. Change it back to `pending` and it recovers.

### Experiment 3: Verify that one bad file poisons the whole graph

Add a file with garbage content under `.tasks/` (use a legal UUID as the file name):

```powershell
Set-Content -Path .agent_tutorial\.tasks\11111111-1111-4111-8111-111111111111.json -Value 'not json at all'
npx tsx peek.ts
```

**Expected**: `listTasks` fails as a whole, instead of "returning the remaining N-1 tasks":

```text
Failed -> TaskStorageError: Task file is invalid: 11111111-1111-4111-8111-111111111111.json
```

To see it more thoroughly, call `getTask` on a **good** task in `peek.ts`. It fails too, and it still reports the bad file's name.

**What to observe**: this is fail closed. `get_task` also needs `loadGraph`, and `loadGraph` is all-or-nothing. Delete the bad file and it recovers.

### Experiment 4: Create a cycle

Find two task files, A and B, and edit them by hand: add B's id to A's `blocked_by`, and add A's id to B's `blocked_by` at the same time. Then run `npx tsx peek.ts`.

**Expected**: `Failed -> TaskGraphError: Task graph contains a cycle at xxx`.

**What to observe**: the error type is `TaskGraphError` (error code `task_graph_error`), not `TaskStorageError`. Both files are themselves legal six-field JSON. It is the **relation between them** that is illegal. This distinction helps you judge where to repair.

**Think about it on the side**: why can a normal `create_task` call not create this cycle? (Hint: a new task can depend only on tasks that **already exist**, so dependency edges always point in the "new -> old" direction.)

### Experiment 5: File name and id do not match

Copy a task file under another name (replace `<some id>` with the real one on your disk):

```powershell
Copy-Item .agent_tutorial\.tasks\<some id>.json .agent_tutorial\.tasks\99999999-9999-4999-8999-999999999999.json
npx tsx peek.ts
```

**Expected**: `Task filename does not match payload id: 99999999-9999-4999-8999-999999999999.json`.

**What to observe**: the copied file content is completely legal. The id in the payload is still the original one. Only the file name changed. This check guarantees that `getTask` (splices the path and reads directly) and `listTasks` (scans the directory and reads) always give consistent answers. Delete the copy when you are done.

### Experiment 6: Catch the lock directory flashing past

`.tasks.lock` exists only inside the critical section. Normally you cannot see it. Open two PowerShell windows to catch it.

Window one (probe every 50 milliseconds, for 10 seconds):

```powershell
Set-Location 'F:\笔记\Agent实操\code'
1..200 | ForEach-Object {
  if (Test-Path .agent_tutorial\.tasks.lock) { Write-Host "$_ lock seen" }
  Start-Sleep -Milliseconds 50
}
```

Window two (run it while window one is running; change `peek.ts` to create five tasks in a row, or run `npm run ch12` directly):

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npx tsx peek.ts
```

**What to observe**: window one will most likely **see it zero times**. Each creation holds the lock for only a few milliseconds, and a 50-millisecond sampling period cannot catch it. This proves exactly that "the lock directory is not a persistent product". To see it reliably, temporarily add one line, `await delay(3000)`, in `#withLock` just before the `return await operation()` line. Run it again and you will catch it (remember to change it back).

### Experiment 7: Confirm that a concurrent claim has only one winner

The existing tests already cover this. Look directly:

```powershell
npm run test:ch12 -- --reporter=verbose
```

Find the concurrent claim test in the output. A better approach is to read [tests/ch12-tasks.test.ts](code/chapters/ch12/tests/ch12-tasks.test.ts) directly. It uses two `JsonTaskStore` instances to claim the same pending task concurrently, and asserts:

```text
Exactly 1 succeeds
The loser gets a TaskStateError (task_invalid_state), not a lock conflict error
```

**What to observe**: the loser's error code is `task_invalid_state`. Because both competitors **entered the critical section in turn**. When the second one entered, it saw the state already at `in_progress`, so it reported a state error. The role of the lock is not to make people queue up for a lock error. It is to keep the "read -> judge -> write" decision from becoming invalid.

### Experiment 8: Remove the lock and see how it breaks

This experiment proves that "an atomic write cannot replace a lock". It is the most valuable of the eight.

`#withLock` is a private method, so a subclass cannot override it. So follow the approach in the section "First See What Happens Without a Lock": write an **independent mini store**. It needs only three steps, "read JSON -> judge the status -> write JSON", with no lock at all, and a `setTimeout` inserted between the judgement and the write to widen the scheduling gap. Then let two owners claim the same task concurrently.

**Expected**: both claims return "success", and the disk holds the owner of the later writer. The file count is 1, the JSON is complete, and there is no half file.

**What to observe**: every single write can be atomic, and the result is still wrong. **Atomicity guarantees "you will not write it broken". It does not guarantee "you will not overwrite".** These two problems need two mechanisms. That is why this chapter has both `atomicReplace` and `#withLock`.

Clean up after all experiments:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Remove-Item peek.ts
Remove-Item -Recurse -Force .agent_tutorial
```

---

## What This Chapter Deliberately Does Not Do

State the boundaries clearly, and you know what to expect from the next chapter.

The scope of P12 ends at "a persistent JSON DAG that can be claimed atomically":

| Not done | In which chapter |
| --- | --- |
| Slow tools run in the background | P13: managed background jobs + a typed event inbox |
| Scheduled tasks | P14: Cron |
| Resident teammates and a mailbox | P15 |
| A request-response protocol and plan gating | P16 |
| Leases, claim tokens, and work stealing | P17: the SQLite TaskStore |

There are also three deliberate omissions inside this chapter:

- **No update / delete / unclaim.** State can only move forward in one direction. When a requirement changes, create a new task.
- **No `blocks` field (downstream list).** A dependency is recorded in one direction only, in the downstream task's `blocked_by`. To know who depends on me, scan the graph once. This way each edge has exactly one source of truth, and there is no two-way inconsistency where A says it depends on B but B does not know.
- **No `activeForm` / `metadata`.** Six fields are the minimal set that supports this chapter's contract.

**One more point must be stated clearly**: JSON plus an exclusive file lock is enough to prove this chapter's state and persistence contracts. But it **does not turn external side effects into a database transaction**. After the Agent claims a task, it changes files, runs shell commands, and sends network requests. Those operations still go through the existing permission, Hook, cancellation, and recovery boundaries. The task graph records "who is doing what". It is not a "rollback log of what was done".

---

## Differences from Claude Code

With reference to the analysis of the CC source code in `s12_task_system/README.md` in the external repository [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code), this chapter's teaching simplifications appear in six places. **These are not "this chapter did it wrong". They are "complexity this chapter cut to explain the core mechanism clearly"**. Only when you know what was cut do you know where to start when you add it back later.

**1. Lock granularity.** CC uses an independent `proper-lockfile` file lock for each task file (it locks `{taskId}.json`). It also uses a list-level `.lock` to check whether the same Agent already has another open task. P12 uses one global lock, `.tasks.lock`, to protect the read-modify-write of the whole graph.

The cost is direct: in CC, while one Agent claims task A, another Agent can read and write the unrelated task B in parallel. P12 serialises all operations. The benefit is what the section "Why You Cannot Lock Only the Target File" explains: whole-graph validation and cross-task judgements need only one lock, and there is no deadlock. When the task count reaches the thousands, the global lock becomes a bottleneck. That is also one motivation for the P17 move to SQLite.

**2. TaskUpdate separation.** CC has an independent `TaskUpdate` tool that manages dependency relations (`addBlocks` / `addBlockedBy`), `activeForm`, and `metadata`. CC's `complete_task` is actually also implemented through `TaskUpdate`.

P12 concentrates dependency declaration in `create_task(blocked_by=...)`, completed in one shot, and unchangeable afterwards. There is no independent update, delete, or release tool. This is the direct consequence of this chapter's "three states, one-way progress". If dependencies could be changed, you would have to handle the string of questions "is the graph still a DAG after the change" and "can a task that is already in_progress change its dependencies".

**3. A high-water mark prevents ID reuse.** CC uses a `.highwatermark` file to record the highest ordinal ID ever allocated. Even if a task is deleted, the ID is not reused. P12 uses UUID v4, which naturally has no ID reuse risk, so it does not need this file.

The cost is readability: CC's task IDs are `1`, `2`, `3`, which a human can remember. P12's is `9d59f5ec-7c94-49a7-b728-f36007fd912c`. An ordinal ID needs one extra piece of persistent state (the high-water mark) to guarantee no reuse. A UUID does not. This is "stateless generation" traded for "unreadable".

**4. 9 fields vs 6 fields.** CC's `TaskRecord` has 9 fields: `id`, `subject`, `description`, `activeForm`, `owner`, `status`, `blocks` (downstream list), `blockedBy`, and `metadata`. P12's `Task` has only 6. It lacks `activeForm`, `blocks`, and `metadata`.

- `activeForm` is the verb form in progress ("Creating schema"). It is for UI display.
- `blocks` is the downstream list. It makes "who depends on me" O(1) to query. The cost is that every edge has two sources of truth, and two-way consistency must be maintained.
- `metadata` is a free field where the upper layer puts business data.

All three are useful, but none of them affects the state and concurrency contracts this chapter must prove.

**5. The release path.** When a teammate closes or terminates, CC calls `release` (clears the `owner`, and returns the state from `in_progress` to `pending`). This lets other Agents claim an interrupted task again. P12 has no unclaim or release. `in_progress` can only move forward to `completed`.

The section "No Unclaim" explained why: a complete release needs leases, heartbeats, and timeout judgements. That is P17's content.

**6. fs.watch reactive UI.** CC has `useTaskListWatcher`, based on `fs.watch`. It watches task directory changes and refreshes the task state UI in real time. P12 has no file system monitoring. Every time you want to see the graph, you call `list_tasks` once.

---

## Companion Code Index

| File | Lines | Role in this chapter |
| --- | --- | --- |
| [features/tasks.ts](code/chapters/ch12/src/features/tasks.ts) | 345 | The domain model (`Task`, three states, six typed errors, canonical UUID) + the schemas and handlers of the five tools |
| [adapters/task-json.ts](code/chapters/ch12/src/adapters/task-json.ts) | 568 | `JsonTaskStore`: the four-layer `#withLock` lock, the strict `#loadGraph` rebuild, the `validateGraph` cycle detection, `atomicReplace` |
| [bootstrap.ts](code/chapters/ch12/src/bootstrap.ts) | 281 | The composition root. The two-way paired check of `task_dag_json` and `taskStore`, the main Agent and subagents sharing one store |
| [cli.ts](code/chapters/ch12/src/cli.ts) | 227 | The real entry point. It builds the store by capability bit, `workspace = resolve(process.cwd())`, configuration validation before store construction |
| [core/profiles.ts](code/chapters/ch12/src/core/profiles.ts) | 271 | The capability bit definition of `P12 = P11 + "task_dag_json"` |
| [features/todos.ts](code/chapters/ch12/src/features/todos.ts) | 138 | The comparison object. In-session TODO: in-memory state, whole-table overwrite, `MAX_TODOS = 50` |
| [tests/ch12-tasks.test.ts](code/chapters/ch12/tests/ch12-tasks.test.ts) | 320 | Three-state transitions, single winner in concurrent claims, bad disk states, path escapes, atomic write failure injection |
| [tests/ch12-bootstrap.test.ts](code/chapters/ch12/tests/ch12-bootstrap.test.ts) | 71 | Two-way pairing of capability bits and dependencies, the 13-tool sequence assertion |
| [tests/ch12-entry.test.ts](code/chapters/ch12/tests/ch12-entry.test.ts) | 34 | All four environment variables reported at once, and no early store construction triggered |

Suggested code reading order: the first half of `features/tasks.ts` (domain model) -> `#withLock` and `#loadGraph` in `adapters/task-json.ts` -> the second half of `features/tasks.ts` (tool registration) -> `tests/ch12-tasks.test.ts`.

---

## Run and Verification

Two entry points bind the same P12 Bootstrap:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run ch12 -- --prompt "Create the task dependencies for schema, endpoints, tests, and docs"
npm run agent-tutorial -- run --chapter 12 --prompt "List the current project tasks and claim one ready task"
```

Five verification gates:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch12
npm run typecheck
npm run lint
npm run format:check
npm run build
```

This chapter's tests cover persistence, concurrency, and the real composition entry point: they use two `JsonTaskStore` instances to race concurrently for the same `pending` task, and assert that only one claim succeeds. They inject an atomic replace failure, a UUID collision, bad JSON, an illegal state, a cycle, and a Windows junction. **No API Key is needed anywhere, and no network is accessed.**

---

## Chapter Summary

### The Three-Sentence Version

Chapter 12 upgrades the "task list" into a verifiable project task graph. Three states, six fields, one whole-graph lock, and exactly one file written per operation are enough to support multi-Agent collaboration across processes and sessions. Every approach that "looks more flexible" — a fourth state, partial loading, rewriting downstream tasks, the model reporting its own identity — loses correctness in some concrete scenario.

### Five Rules You Must Remember

1. **TODO and Task are layered.** In-session steps and cross-session project state each have exactly one owner. They do not synchronise with each other.
2. **State is minimal, and derived values are computed fresh.** Three states move forward in one direction. Blocked is computed from the dependencies at claim time and is not stored on disk. One state less means a whole class of inconsistency less.
3. **The lock protects the judgement, and the atomic write protects the bytes.** Two mechanisms solve two independent problems. Neither can be missing. Experiment 8 proves this.
4. **Reload inside the lock is the key action.** After you take the lock, you must read from disk again. Data read outside the lock is already stale at the moment you enter the critical section.
5. **Fail closed.** One bad file makes the whole graph fail explicitly. Nothing is skipped, and no half graph is returned. "A partly correct DAG" is not a useful concept.

### Check Whether You Really Understood

Answer these seven questions without looking at the text:

1. Why is there no fourth `blocked` state? What concrete cost would adding it bring?
2. Atomic file replacement already exists. Why is a lock still needed?
3. Why does the lock cover the whole graph, and not a single task file?
4. Two processes claim the same task at the same time. What error code does the loser receive? Why is it not a lock conflict error?
5. In the `unblocked` list that `complete_task` returns, why are the tasks that "were ready anyway" not included?
6. The model puts an `owner` field into the `claim_task` parameters. What happens? Which three mechanism layers defend against it?
7. `.tasks/` holds 10 files, and 1 of them is bad JSON. `get_task` reads a good task. Does it succeed or fail? Why?

If you cannot answer one, go back and read the matching section:

| Question | Go back to |
| --- | --- |
| 1 | "Why There Is No Fourth Blocked State" |
| 2, 3 | The first two subsections of "Why the Lock Covers the Whole Graph" |
| 4 | "Measured: Only One Winner in a Concurrent Claim" |
| 5 | "Verify the Semantics with a Diamond Graph" |
| 6 | "The Owner Cannot Be Forged Through a Model Parameter" |
| 7 | "Fail Closed: One Bad File Poisons the Whole Graph" |

---

The next article enters background tasks. The task DAG already knows "what can be done". But a slow operation still occupies the current Agent Loop. Claim a task and run a five-minute build, and during those five minutes the Agent can do nothing else. P13 adds managed background jobs and a typed event inbox, so the Agent can keep handling other work while it waits.
