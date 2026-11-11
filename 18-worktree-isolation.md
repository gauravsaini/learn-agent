At the end of the previous chapter, Alice and Bob could already find work on their own from the same SQLite task board, and use a claim token to prove "this task belongs to me now".

It looks as if the problem is solved. But as soon as you let them really start changing code at the same time, you will see a new failure:

```text
Alice claimed "Refactor the authentication module" → writes config.ts in the main directory
Bob   claimed "Refactor the login page"            → writes config.ts in the main directory
                            ↓
                  The one who writes later overwrites the one who wrote first
```

The Task DAG is correct, the lease is correct, and the message protocol is correct. The conflict happens at a completely different layer: **two executors share the same physical file space.**

Task ownership (who has the right to do this work) and file system isolation (where this write lands) are two different problems. The previous chapter solved the first one. This chapter solves the second one.

The mechanism this chapter implements can be stated in one passage:

```text
Before a task starts, the Lead first creates an independent Git Worktree for it
(physically, an independent directory + an independent branch, but sharing the same .git object store);
after that, before every tool call, the runtime resolves again "in which directory should this call execute" —
a call with a claimed task lands in the Worktree bound to that task; a call with no claim stays in the main directory.
Cleanup does not use --force: a Worktree is deleted only if it is "completed + clean + confirmed merged into the specified branch".
If that cannot be proved, it moves to needs_review, and the site is left for a person to inspect.
```

Chapter 18 adds only one capability, `worktree`, on top of all the capabilities in Chapter 17.

![Image](https://mmbiz.qpic.cn/mmbiz_png/1z26fJxNuiaExpIBPJzibicWOB7vYtNzliaSpVn5rYOmN38pN6outCzcFvWRfcccAJ6kiakYElPj0Zxpia8faC5qSuWHGVux8UkzQ3kVrVCmjhaJg/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

- State why "adding a lock to `write_file`" cannot solve file conflicts in parallel development, and state what a lock does prevent and what it does not prevent;
- State why Project Task, Task Claim, and Worktree Binding must be three independent state lines, and state what breaks if you put the worktree into the Task;
- Explain why the order "first write `reserved` in SQLite, then call Git" cannot be reversed, and why a cross-system operation cannot pretend to be atomic;
- Read and understand where "resolve the working directory again before every tool call" is implemented, and why `process.chdir()` cannot be used;
- State what each of the 8 proof steps in `remove_worktree` prevents, and why the code contains no `--force` and no `discard_changes`;
- State why an invalid claim must fail explicitly, and must not "fall back to the main directory and continue working";
- Run Chapter 18 yourself, and use 11 experiments that need no API key to verify each conclusion above, one by one.

### What you need first

| Prerequisite | Specific requirement | What happens if you do not meet it |
| --- | --- | --- |
| The mechanisms in Chapter 17 | Know that the task board is in SQLite, that the claim token is the claim credential, and that the lease is a half-open interval | You will not understand the whole claim routing section in this chapter |
| The mechanisms in Chapters 15 and 16 | Know that a Teammate is a persistent worker, and that the plan gate blocks tools with side effects | One link will be missing in the auto-claim section |
| Basic Git operations | Can use `git branch`, `git commit`, and `git merge`, and know what a "branch" is | You will need to read the cleanup proof section two more times |
| Node.js 22+ | This article was tested with v25.7.0 | Dependencies will not install, or `tsx` will not run |
| Git 2.5+ | `git worktree` was introduced in 2.5; 2.20+ is more stable in practice | `git worktree add` will report an unknown command directly |
| Windows PowerShell | All commands in this article use PowerShell form | You must translate the commands to bash yourself |
| Model credentials (optional) | Only the "run it for real once" step needs them | The first 6 steps and all 11 experiments do not need them |

**About `git worktree`:** If you have not used it before, you only need to remember one sentence first — it lets **the same repository** have **multiple working directories** on disk. Each directory checks out a different branch, but they **share one `.git` object store**. It is not `git clone`. It does not use multiple copies of the history, and switching does not need a stash. Experiment 2 in this chapter will let you confirm this yourself.

### Quick glossary (terms that appear for the first time in this chapter)

| Term | Explanation in one sentence |
| --- | --- |
| **Git Worktree** | A second (third, …) working directory of the same repository; each one checks out a different branch, and they share one `.git` |
| **Main working directory** | The directory you produced with `git clone`; in this chapter, it is also where the `integration_ref` lives |
| **Managed Worktree** | A Worktree that the runtime in this chapter creates; code derives its path and branch name, and the caller cannot customise them |
| **binding** | One persistent record of a "task ↔ Worktree" relation, stored in the `worktree_bindings` table |
| **integration ref (Integration Ref)** | An explicitly specified target branch, for example `refs/heads/main`; it is both the baseline for creating a Worktree and the criterion for deletion |
| **baseline commit** | The immutable commit ID that the `integration_ref` resolves to at the moment of creation |
| **branch tip** | The commit that the current `HEAD` of this Worktree points to |
| **`reserved`** | The binding is already stored in SQLite, but the Git directory has not been created successfully yet — an "intent record" |
| **`active`** | The Git directory and the branch have both been read back and confirmed; this binding can be claimed and routed |
| **`kept`** | The task is complete, but the directory is explicitly retained, waiting for a person to inspect it |
| **`needs_review`** | If any step in the cleanup process cannot be proved, the binding lands here, and it must carry a `review_reason` |
| **`removed`** | The directory and the branch have both been deleted safely; the binding row itself stays in the database as an audit record |
| **ToolContext** | The execution environment of one tool call: workspace, identity, claimToken, and so on |
| **`ToolContextProvider`** | A pluggable interface that can recompute the ToolContext before every tool call |
| **`executionScope`** | A new empty frozen object for each turn, used as an identity marker for "the same reply" |
| **WeakMap** | A Map whose keys are objects and that does not prevent garbage collection; this chapter uses it to map an `executionScope` to a claim token |
| **append-only** | Only INSERT is allowed; UPDATE / DELETE are not allowed; this chapter enforces this with a database trigger |
| **fail-closed** | If a decision cannot be made, reject, instead of "letting it pass"; in this chapter, an invalid claim always produces an explicit error |

### Suggested reading route

```text
[1] First read one complete isolation trace   | Gives you a picture, and shows you what the final run looks like
      ↓
[2] Why a file lock is not the answer          | The reason this chapter exists; what one lock can guarantee
      ↓
[3] Three independent state lines              | The most important design judgement in this chapter
      ↓
[4] Table structure and constraints            | What the data looks like, and what the database blocks
      ↓
[5] Creation: reserve first, then call Git     | Why the order of a cross-system operation cannot be reversed
      ↓
[6] Resolve the working directory per tool     | The core implementation in this chapter; how "territory" is implemented
      ↓
[7] An invalid claim must fail                 | The specific boundary of fail-closed
      ↓
[8] Cleanup must first prove "it can be deleted" | 8 proof steps, none of them can be omitted
      ↓
[9] Run it step by step                        | Run it from zero; except steps 4 and 5, no API key is needed
      ↓
[10] 11 hands-on experiments                   | None of them needs an API key; verify the conclusions above one by one
```

If you have only 10 minutes, read sections `[1]`, `[6]`, and `[8]`, then run Experiment 1 and Experiment 10.

---

## First, read one complete isolation trace

The output below comes from Experiment 1 in this chapter (the script `scripts/probe-ch18.mts`, which I will help you build step by step later). Two tasks, two Worktrees, one normal deletion, and one move to manual review:

```text
===== trace =====
[1] Lead created two tasks: A=…1801 B=…1802
[2] binding alice: active branch=wt/alice path=.agent_tutorial/worktrees/alice
[3] binding bob:   active branch=wt/bob path=.agent_tutorial/worktrees/bob
[4] Creating a binding did not advance the task status: Refactor the authentication module (pending) Refactor the login page (pending)
[5] alice claimed Refactor the authentication module token=…1811; bob claimed Refactor the login page token=…1812
[6] cwd resolved for alice: <root>\.agent_tutorial\worktrees\alice
[7] cwd resolved for bob:   <root>\.agent_tutorial\worktrees\bob
[8] alice's config.ts: "// alice's version\n"
[9] bob's config.ts:   "// bob's version\n"
[10] Main directory config.ts: "export const value = 0;\n"
[11] alice's branch has been merged into main, main tip = b47d4a2
[12] bob committed but did not merge into main, wt/bob tip = f038ae9
[13] Both tasks are completed: Refactor the authentication module (completed) Refactor the login page (completed)
[14] remove alice → removed
[15] remove bob   → needs_review (worktree branch tip is not contained by the integration ref)
[16] Remaining branches: main wt/bob
[17] Number of worktrees still registered in Git: 2
[18] Audit events (by sequence):
     #1 alice reserve -> reserved
     #2 alice create -> active
     #3 bob reserve -> reserved
     #4 bob create -> active
     #5 alice remove -> removed
     #6 bob needs_review -> needs_review (worktree branch tip is not contained by the integration ref)
```

Do not rush to read the code. Read these 18 lines once. All the design judgements in this chapter are inside them:

**`[4]` Creating a Worktree does not advance the task status.** The binding is ready, and the task is still `pending`. This is not an omission. It is deliberate — the Lead can prepare the whole diagram and all the directories first, and then start the teammates. The only thing that still moves a task from `pending` to `in_progress` is a claim.

**`[8]` `[9]` `[10]` The three `config.ts` files all have different contents.** Files with the same name exist at the same time, and they do not overwrite each other. The copy in the main directory has not been touched at all. This is the result this chapter wants.

**`[14]` and `[15]` are two different outcomes.** Alice's branch has already been merged into `main`, so it can be deleted. Bob committed but did not merge, so it cannot be deleted — **but this is not an error. It moves to `needs_review` and records the reason.** The directory and the commit are both still there.

**`[16]` `[17]` confirm the previous point.** The `wt/bob` branch is still there, and the number of worktrees registered in Git is still 2 (main directory + bob). The runtime did not make the decision for you.

**`[18]` Every state change leaves one record that cannot be modified.** Six events, including the `needs_review` event with its reason.

Every section that follows explains why one line in these 18 lines must be this way.

---

## Why a file lock is not the answer

When you see "two Agents fight over the same file", the first reaction is often to add a lock. This idea deserves a serious rebuttal once, because it is wrong in a very reasonable way.

First, look at what a lock can do. In Experiment 2, I wrap the write with a real mutex lock. The whole process is strictly serial. There is no concurrency at all:

```text
===== lock =====
  alice acquired the lock for config.ts
  alice released the lock
  bob acquired the lock for config.ts
  bob released the lock
Final content of the shared directory: "// bob's version\n"
The lock was never held concurrently during the whole process, and alice's change still disappeared: serialisation only guarantees order; it does not preserve versions.
```

The lock worked perfectly. Alice's change still disappeared.

The reason is simple: **a lock solves "only one person writes at the same moment". It does not solve "how are the two people's versions preserved separately".** It turns a concurrent overwrite into an ordered overwrite. In the end, only one copy of the content still survives.

```text
Before locking: Alice and Bob write at the same time → the result is uncertain, and it may be torn
After locking:  Alice writes first, Bob writes later → the result is certain, and it is Bob's copy

A certain wrong result is still a wrong result.
```

And in real parallel development, conflicts are far more than just "the same file is overwritten":

| Conflict type | Example | Can a lock prevent it? |
| --- | --- | --- |
| Same-file write conflict | Both people change `config.ts` | It can prevent tearing; it cannot prevent overwriting |
| Cross-file semantic conflict | Alice changed a function signature, and Bob still calls it with the old signature | It cannot prevent it at all |
| Intermediate state is read | Alice has changed half of it, and Bob reads the half-finished product | It needs a larger-grained lock, and it soon degrades into serial execution |

To really solve this, what you need is not "queue up to write the same copy", but **let the two candidate changes exist separately, each one complete, and then let an explicit process decide which copy enters the main line**.

This is exactly what Git Worktree provides:

```text
repository-root/                    ← Main working directory; the integration ref is here
├── .git/                           ← The only object store; the three directories share it
├── .agent_tutorial/
│   ├── tasks.sqlite3               ← The task board from Chapter 17 + the bindings in this chapter
│   └── worktrees/
│       ├── alice/                  ← Independent directory; checks out branch wt/alice
│       │   └── config.ts           "// alice's version"
│       └── bob/                    ← Independent directory; checks out branch wt/bob
│           └── config.ts           "// bob's version"
└── config.ts                       "export const value = 0;"  ← Not touched
```

Three copies of `config.ts` exist at the same time. Each one is complete. Each one has its own commit history. Whether the next step is review or merge is a person's decision, not the runtime's decision.

**Note the point about "sharing one `.git`".** This is the key difference between a Worktree and `git clone`: it does not copy the history, it does not use multiple copies of disk space, and Bob can reference Alice's commit objects immediately. Experiment 2 will verify this with `git rev-parse --git-common-dir`:

```text
alice worktree: "// alice's version\n"
bob   worktree: "// bob's version\n"
Main directory: "export const value = 0;\n"
The two worktrees share the same object store: "<root>/.git"
```

---

## Three independent state lines

Now that it is clear that Worktrees will be used, the next question is: where is this "task ↔ directory" relation stored?

The most convenient-looking approach looks very attractive — add one column to the `tasks` table:

```sql
-- Looks natural, but it is wrong
ALTER TABLE tasks ADD COLUMN worktree TEXT;
```

This one column mixes together three things that are originally unrelated:

| State line | Question it answers | Typical values | Who advances it |
| --- | --- | --- | --- |
| **Project Task** | Has this work not started, is it in progress, or is it complete | `pending` → `in_progress` → `completed` | `claim_task` / `complete_task` |
| **Task Claim** | Who owns the execution right within the lease period | active / expired / cleared | Claim and lease expiry |
| **Worktree Binding** | Which lifecycle stage is the isolated directory for the task in | `reserved` / `active` / `kept` / `needs_review` / `removed` | `create_worktree` / `keep_worktree` / `remove_worktree` |

Their **lifecycle lengths are completely different**. This is the most practical criterion for judging "should I split the table":

```text
Timeline ───────────────────────────────────────────────────────────▶

Task:      pending ──────────── in_progress ──────── completed ─────────────
Claim:                          ├─ 60 second lease ─┤        (cleared)
Binding:   reserved → active ────────────────────────────────── kept/removed
           ↑                                                    ↑
           It already exists before the task starts             It still lives after the task completes
```

A Binding is longer than a Claim. It may even be much longer than the "in progress" stage of a Task — after the task completes, that directory may need to stay for a few more days while a person reviews it. Putting them into one table means that every change on these three lines must take the other lines into account. In the end, nobody can state clearly "what the state is now".

It breaks in three specific places:

**One, Task state transitions will be polluted.** `create_worktree` must write this column, so it must UPDATE the `tasks` table. Should that UPDATE check `status = 'pending'`? Should it also change the status to "preparing"? Once you start worrying about this question, the Task is no longer driven only by claim/complete.

**Two, `needs_review` has nowhere to go.** A task is already `completed`, and its directory is in the state "cleanup failed, waiting for a person to inspect it". This is the state of the **directory**, not the state of the **task**. If you force it into the Task, you can only add a `completed_but_worktree_needs_review` — and the state machine starts to explode.

**Three, the audit does not line up.** A binding has its own complete history (reserve → create → keep → …), and a Task has its own history. If you mix them in one table, you cannot answer "what has this directory been through".

So P18 **did not change the Task schema at all**. Experiment 3 will list the fields of the two tables and compare them:

```text
The tasks table has no worktree field: sequence, id, subject, description, status, owner, claim_token, lease_expires_at_utc
The binding is an independent table: task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, status, review_reason, created_at_utc, updated_at_utc
```

The same experiment also verifies that "the three lines each go their own way":

```text
===== state =====
After createTask          task=pending     owner=null   token=null   binding=(no binding)
After createWorktree      task=pending     owner=null   token=null   binding=active
After claimNext           task=in_progress owner=alice  token=…1811  binding=active
After completeTask        task=completed   owner=alice  token=null   binding=active
After keepWorktree        task=completed   owner=alice  token=null   binding=kept
```

Read it line by line: `createWorktree` only changes the binding; `claimNext` only changes the task and the token; `completeTask` only clears the token; `keepWorktree` only changes the binding. **In four operations, not one operation changed two lines at the same time.**

---

## The Binding state machine

Five states, four legal transitions. All of them are defined in [src/features/worktrees.ts](code/chapters/ch18/src/features/worktrees.ts):

```text
                         ┌──────────┐
   create_worktree  ───▶ │ reserved │   The record is in SQLite; the Git directory has not been created yet
   (first step)          └────┬─────┘
                              │ git worktree add succeeds, and readback confirms the branch
                              ▼
                         ┌──────────┐
                         │  active  │   ← Only this state can be claimed and can route a cwd
                         └────┬─────┘
                 ┌────────────┼────────────────┐
                 │            │                │
      keep_      │            │ remove_        │ Any proof step fails
      worktree   │            │ worktree       │
                 ▼            ▼                ▼
            ┌────────┐   ┌─────────┐   ┌──────────────┐
            │  kept  │   │ removed │   │ needs_review │
            └───┬────┘   └─────────┘   └──────┬───────┘
                │                             │
                └──── remove_worktree ────────┘
                      (It can reach removed only if the proof passes)
```

Three design points deserve a separate explanation:

**`reserved` is not a temporary state like "creating". It is a persistent intent record.** If `git worktree add` fails, this `reserved` record will **stay in the database**. It will not be cleared. The next section explains the reason.

**Only `active` can be claimed.** The SQL in `claimNextBound` explicitly writes `WHERE status = 'active'`. A `reserved` binding cannot be picked up. A `kept` binding cannot be picked up.

**`kept` and `needs_review` are both retention states before a final state, and both can still move to `removed`.** But the entry condition is equally strict — the complete proof must be run again.

The `WorktreeStatus` and `WorktreeAction` values in the code are two different enums. This point is easy to confuse:

```typescript
export const WorktreeStatus = Object.freeze({
  RESERVED: "reserved",
  ACTIVE: "active",
  KEPT: "kept",
  NEEDS_REVIEW: "needs_review",
  REMOVED: "removed",
} as const);

export const WorktreeAction = Object.freeze({
  RESERVE: "reserve",
  CREATE: "create",
  KEEP: "keep",
  NEEDS_REVIEW: "needs_review",
  REMOVE: "remove",
} as const);
```

`Status` is "where the binding is now". `Action` is "which action this audit event records". The two names overlap (`needs_review`), but their meanings are different: a status is a noun, and an action is a verb. The audit table stores both columns. So you can query both "who turned it into this" and "what it is now".

---

## Table structure and constraints

`worktree_bindings` stores the current snapshot. `worktree_events` stores the immutable history. The DDL is in [src/adapters/task-sqlite.ts](code/chapters/ch18/src/adapters/task-sqlite.ts):

```sql
CREATE TABLE IF NOT EXISTS worktree_bindings(
  task_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL UNIQUE,
  integration_ref TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  branch_tip TEXT,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'kept', 'needs_review', 'removed')),
  review_reason TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK(
    (status = 'needs_review' AND review_reason IS NOT NULL)
    OR (status != 'needs_review' AND review_reason IS NULL)
  ),
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
);
```

**Four UNIQUE / PRIMARY KEY constraints, each one prevents one thing:**

| Constraint | What it prevents |
| --- | --- |
| `task_id PRIMARY KEY` | One task can have only one Worktree; there is no ambiguity about "in which directory is this task done" |
| `name UNIQUE` | Two tasks cannot both be called `alice` |
| `branch UNIQUE` | Two bindings cannot point to the same branch |
| `relative_path UNIQUE` | Two bindings cannot point to the same directory |

The last three are actually three projections of the same thing — `name` determines `branch` (`wt/{name}`) and also determines `relative_path` (`.agent_tutorial/worktrees/{name}`). All of them are written because **a constraint should express an invariant directly. It should not depend on the caller always deriving values by the rule**.

**That two-way CHECK is my favourite line in this chapter.** It pins down both "`needs_review` must have a reason" and "other states cannot have a reason" at the same time:

```sql
CHECK(
  (status = 'needs_review' AND review_reason IS NOT NULL)
  OR (status != 'needs_review' AND review_reason IS NULL)
)
```

Why must both directions be controlled?

- Control only the first half → An "`active` binding with a stale review_reason" may appear, and the reader does not know whether to trust it;
- Control only the second half → A "`needs_review` binding with no reason" may appear, and the person who takes over has no idea what happened.

Experiment 5 will use hand-written SQL to hit this constraint directly:

```text
The CHECK constraint also blocks an illegal combination. Try to write a needs_review by hand without giving a reason:
  → Error: CHECK constraint failed: (status = 'needs_review' AND review_reason IS NOT NULL)
          OR (status != 'needs_review' AND review_reason IS NULL)
```

The audit table uses an auto-increment `sequence` for ordering instead of a timestamp, and it uses two triggers to enforce append-only:

```sql
CREATE TABLE IF NOT EXISTS worktree_events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK(action IN ('reserve', 'create', 'keep', 'needs_review', 'remove')),
  status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'kept', 'needs_review', 'removed')),
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  integration_ref TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  branch_tip TEXT,
  reason TEXT,
  created_at_utc TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS worktree_events_reject_update
BEFORE UPDATE ON worktree_events
BEGIN
  SELECT RAISE(ABORT, 'worktree_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS worktree_events_reject_delete
BEFORE DELETE ON worktree_events
BEGIN
  SELECT RAISE(ABORT, 'worktree_events is append-only');
END;
```

**Why use a trigger instead of "do not write UPDATE statements in the code"?** Because the value of an audit comes from "it cannot be changed". A self-constraint at the code layer can only prevent your own mistakes. It cannot prevent another person from changing it directly with the `sqlite3` command line. A trigger rejects the change at the database layer. It is the same for everyone.

**Why use `sequence` instead of ordering by `created_at_utc`?** Two events may be written in a row in the same transaction (reserve and create), and their timestamps are exactly the same. An auto-increment primary key gives a unique, definite order.

Experiment 5 will verify that the triggers really block the change:

```text
UPDATE worktree_events SET action = 'remove' WHERE sequence = 1
  → Error: worktree_events is append-only
DELETE FROM worktree_events WHERE sequence = 1
  → Error: worktree_events is append-only
```

---

## Creation: why reserve first, then call Git

This section is about the place where this chapter is easiest to write incorrectly. It is also a common problem for all "cross-system operations".

`create_worktree` must change two systems: SQLite (write the binding) and Git (create the directory and the branch). They **have no common transaction**. You cannot say "either both sides succeed, or both sides roll back".

So how do you order them? There are only two choices:

```text
Option A: Git first, SQLite second
  git worktree add succeeds → the process crashes → the database has nothing
  Result: an orphan directory and an orphan branch appear on disk; nobody knows what they are for, and nobody is responsible for cleaning them

Option B: SQLite first, Git second
  Write reserved → git worktree add fails → a reserved record stays in the database
  Result: the state clearly states "there is an unfinished reservation here"; it can be queried, retried, and handled manually
```

The code chooses B. The core judgement is this: **an orphan side effect is much more dangerous than an extra state record.**

An extra state record is visible and queryable, and you can decide how to handle it. An orphan directory is invisible — except for `git worktree list`, no place remembers that it exists.

Look at the real implementation (`createWorktree` in [src/features/worktrees.ts](code/chapters/ch18/src/features/worktrees.ts)):

```typescript
async createWorktree(input: {
  readonly taskId: string;
  readonly name: string;
  readonly integrationRef: string;
}): Promise<WorktreeBinding> {
  await this.validateRepository();
  const taskId = canonicalTaskId(input.taskId);
  const name = canonicalAgentName(input.name);
  const integrationRef = canonicalIntegrationRef(input.integrationRef);
  const task = await this.#store.getTask(taskId);
  if (task.status !== TaskStatus.PENDING) {
    throw new WorktreeStateError(
      `Task ${task.id} is ${task.status}; creating a worktree requires pending`,
    );
  }
  // ① Pin the integration ref to an immutable commit
  const baseline = await this.#resolveCommit(integrationRef, this.#workspaceRoot);
  const now = this.#now();
  // ② First store reserved in SQLite (binding + reserve event, in the same transaction)
  const binding = await this.#store.reserveWorktree(
    new WorktreeBinding({
      taskId,
      name,
      branch: `wt/${name}`,
      relativePath: `.agent_tutorial/worktrees/${name}`,
      integrationRef,
      baselineCommit: baseline,
      branchTip: null,
      status: WorktreeStatus.RESERVED,
      reviewReason: null,
      createdAtUtc: now,
      updatedAtUtc: now,
    }),
  );
  // ③ Then execute the Git side effect
  const path = await this.#prepareNewWorktreePath(binding);
  const result = await this.#runGit(
    ["worktree", "add", "-b", binding.branch, path, binding.baselineCommit],
    this.#workspaceRoot,
  );
  if (result.returncode !== 0)
    throw new WorktreeGitError("Git could not create the reserved worktree");
  // ④ Readback proof: branch tip + current branch name
  const branchTip = await this.#resolveCommit("HEAD", path);
  const branch = await this.#runGit(["branch", "--show-current"], path);
  if (branch.returncode !== 0 || branch.stdout.trim() !== binding.branch) {
    throw new WorktreeGitError("Git created a worktree with an unexpected branch");
  }
  // ⑤ Only after the proof passes, transition to active
  return await this.#store.activateWorktree(binding.taskId, {
    branchTip,
    occurredAtUtc: this.#now(),
  });
}
```

Five steps. Each step has a reason:

**① `baseline` is a resolved commit ID, not a branch name.** `#resolveCommit` uses `git rev-parse --verify <ref>^{commit}`. It obtains a 40-character hexadecimal value. After that, `git worktree add` uses this ID, not `refs/heads/main`.

Why? Because a branch moves. If two bindings both say "based on main", and someone pushes a commit to main in between, the two Worktrees will have different starting points — but the database records the same string for both. After you pin it to a commit ID, the `baseline_commit` column is a **definite fact**.

**② `reserveWorktree` is one transaction internally. The binding and the reserve event are committed together.** You will not get "reserved but with no audit".

**③ `#prepareNewWorktreePath` performs three path safety checks**: it confirms that `relative_path` really is the value the runtime derives, it creates the parent directory and then uses `realpath` again to confirm that it has not escaped the workspace, and it confirms that the target path **does not exist yet**.

**④ Readback proof is not a formality.** A return value of 0 from `git worktree add` does not mean that the result is what you wanted. Because of various edge cases, it may check out a different branch. So ask once more with `git branch --show-current`. If it does not match, report an error.

**⑤ Only after the readback passes does `activateWorktree` run.** This is the only entry point from `reserved` to `active`.

Experiment 4 will inject a Git runner where "`worktree add` always fails", and will look at what a failure leaves behind:

```text
===== reserve =====
createWorktree throws: WorktreeGitError: Git could not create the reserved worktree
The binding status is still: reserved (branch_tip=null)
The Task status is still:  pending
Audit events: #1 reserve->reserved
Will auto-claim pick it up: undefined (reserved is not active)
Git branches: main (no half wt/alice is left behind)
```

Five lines of conclusion. Every line matters:

- The binding stays at `reserved`, and `branch_tip` is null — it honestly records "not created yet";
- The Task is still `pending` — it was not affected by this failure;
- There is one reserve audit event — evidence is left behind;
- **Auto-claim cannot pick it up** — `reserved` is not in the filter range of `claimNextBound`, so this failed reservation will not harm anyone;
- There is no half `wt/alice` in Git — it failed before it failed, and it left no orphan behind.

The last point deserves emphasis: a `reserved` state **does not** block the system. It just sits there, waiting for a person to inspect it, and waiting for a person to retry it. This is much better than "clear it automatically, and pretend that nothing happened".

### Why `integration_ref` must be written in full as `refs/...`

In the `create_worktree` schema, `integration_ref` is required, and it must use the complete `refs/...` form:

```typescript
const createWorktreeSchema = z.strictObject({
  task_id: z.string().uuid().toLowerCase(),
  name: z.string().trim().min(1),
  integration_ref: z.string().trim().min(1),
});
```

The validation function `canonicalIntegrationRef` blocks a long list of dangerous inputs at the boundary:

```typescript
export function canonicalIntegrationRef(value: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value.startsWith("refs/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || INVALID_REF_CHARACTERS.has(character) || codePoint < 32;
    })
  ) {
    throw new WorktreeStateError("integration_ref must be an explicit safe refs/... Git reference");
  }
  return value;
}
```

Together with `INVALID_REF_CHARACTERS`:

```typescript
const INVALID_REF_CHARACTERS = new Set([" ", "~", "^", ":", "?", "*", "[", "\\"]);
```

**Why not accept a short form like `main`?** Because the Git reference resolution rules have priorities: `main` may match `refs/heads/main`, it may match `refs/tags/main`, and in specific cases it may match something else. This ambiguity is not acceptable in a situation that "decides whether to delete a directory".

**Why ban `@{`?** Because reflog syntax such as `main@{1}` and `HEAD@{yesterday}` resolves to a commit that **changes over time**. The "already merged" result you calculated yesterday may not hold today.

**Why ban `..`?** `refs/heads/a..b` is range syntax in Git, not a single reference. Banning it also blocks path traversal as a side effect.

**Why ban spaces and `~ ^ : ? * [ \`?** These are all operators in Git revision syntax (`~3` means "three steps back", `^` means "parent commit", and `:` means "path separator"), or they have a special meaning in a shell. Although this chapter uses `execFile` and does not go through a shell, keeping a reference as "just a reference" is a cleaner boundary.

Experiment 11 will run all these inputs once:

```text
Input validation in canonicalIntegrationRef:
  "refs/heads/main"                  → refs/heads/main
  "refs/remotes/origin/main"         → refs/remotes/origin/main
  "main"                             → WorktreeStateError: integration_ref must be an explicit safe refs/... Git reference
  "HEAD"                             → WorktreeStateError: integration_ref must be an explicit safe refs/... Git reference
  "refs/heads/../../etc/passwd"      → WorktreeStateError: integration_ref must be an explicit safe refs/... Git reference
  "refs/heads/main@{1}"              → WorktreeStateError: integration_ref must be an explicit safe refs/... Git reference
  "refs/heads/feature branch"        → WorktreeStateError: integration_ref must be an explicit safe refs/... Git reference
  "refs/heads/main/"                 → WorktreeStateError: integration_ref must be an explicit safe refs/... Git reference
  " refs/heads/main"                 → WorktreeStateError: integration_ref must be an explicit safe refs/... Git reference
```

### `name` cannot be chosen freely either

`name` uses `canonicalAgentName`, which has existed since Chapter 15:

```typescript
const AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function canonicalAgentName(value: string): string {
  if (typeof value !== "string" || !AGENT_NAME.test(value) || isWindowsReservedComponent(value)) {
    throw new Error("Invalid or unsafe Agent name; expected a safe lowercase slug");
  }
  return value;
}
```

Lowercase letters, digits, and a single hyphen in the middle are allowed. **And it rejects Windows reserved names** (`CON`, `PRN`, `AUX`, `NUL`, `COM1`, …) — on Windows, a directory called `con` cannot be created. Instead of letting `git worktree add` report an incomprehensible error, it is better to reject it at the entry point.

This also explains why the caller cannot specify `branch` and `relative_path`:

```typescript
branch: `wt/${name}`,
relativePath: `.agent_tutorial/worktrees/${name}`,
```

**Validate the name once, and the path and the branch are both safe.** If a custom path were allowed, path traversal would have to be validated again in another place — one more entry point means one more place that may leak.

### Why Git commands use `execFile` + an array

[src/adapters/git.ts](code/chapters/ch18/src/adapters/git.ts) has only 74 lines, but every place has a reason:

```typescript
const result = await execFileAsync("git", ["--no-pager", ...argumentsValue], {
  // execFile bypasses shell and passes array elements directly as argv, remaining safe even with spaces or special characters.
  cwd: workingDirectory,
  encoding: "utf8",
  timeout: this.#timeoutMs,
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
});
```

| Choice | Reason |
| --- | --- |
| `execFile` instead of `exec` | `exec` builds one shell command line, and spaces, `&&`, and `;` in the arguments may change the semantics. `execFile` uses the array directly as argv |
| `--no-pager` | Without it, some commands (`branch`, `log`) will try to call `less`, and they will hang in a non-interactive environment |
| `timeout: 30_000` | Git can also hang (network references, file locks). 30 seconds is a value that is generous enough but has an upper limit |
| `windowsHide: true` | No black window pops up on Windows |
| `maxBuffer: 8MB` | The default is 1MB, and `git status` can exceed it in a large repository |

Error handling is divided into three categories. This classification is critical:

```typescript
if (details.killed === true || details.code === "ETIMEDOUT") {
  throw new GitExecutionError("Git command timed out", { cause: error });
}
if (typeof details.code === "number") {
  return Object.freeze({
    returncode: details.code,
    stdout: typeof details.stdout === "string" ? details.stdout : "",
    stderr: typeof details.stderr === "string" ? details.stderr : "",
  });
}
throw new GitExecutionError("Git command could not be started", { cause: error });
```

- **Timeout** → throw an exception (this is an environment problem, not a business result);
- **Non-zero exit code** → return a structured result (this is a **normal business signal**, for example "this branch has not been merged");
- **The process cannot start** → throw an exception (Git is not installed, or PATH is wrong).

**The judgement that "a non-zero exit code is not an exception" is important.** `git merge-base --is-ancestor A B` returns 1 to mean "A is not an ancestor of B" — this is an **answer**, not an error. If you turn it into an exception, the caller must use try/catch for branch decisions, and the code immediately becomes ugly.

The domain layer has one more fallback layer. It converts `GitExecutionError` uniformly to `returncode: -1`:

```typescript
async #runGit(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
  try {
    return await this.#git.run(argumentsValue, cwd);
  } catch (error) {
    if (error instanceof GitExecutionError) return { returncode: -1, stdout: "", stderr: "" };
    throw error;
  }
}
```

In this way, "Git timed out" and "Git said no" take the same path in the cleanup flow — both are "cannot be proved", and both land in `needs_review`. **No separate branch is needed for a timeout.**

---

## Resolve the working directory per tool

This is the core mechanism in this chapter. All the tables and states before this point exist to serve this section.

The problem is specific: Alice calls `write_file("config.ts", ...)`. How does the runtime know that it should write to `.agent_tutorial/worktrees/alice/config.ts` instead of the main directory?

### Three ways to get it wrong

**Method one: `process.chdir()`.**

```typescript
// Do not write it like this
process.chdir(worktreePath);
await writeFile("config.ts", content);
```

`process.cwd()` is **one global variable shared by the whole process**. The running form in this chapter is: the Lead, multiple Teammates, and several Subagents all run concurrently in the same Node process. Alice changes the process cwd, and Bob's next write lands in Alice's directory.

```text
Time t1: alice calls chdir(.../alice) → process cwd = .../alice
Time t2: bob   calls chdir(.../bob)   → process cwd = .../bob
Time t3: alice's next write_file → it writes to .../bob!
```

And this is a **timing-dependent** bug. It is hard to reproduce, and it is extremely painful to investigate.

**Method two: give the Runner a fixed workspace.**

```typescript
// This does not work either
const runner = new AgentRunner({ workspace: worktreePath, ... });
```

This solves the concurrency problem, but it cannot solve the **claim inside the same reply** scenario. The model may output two tool calls in one reply:

```text
assistant reply:
  tool_call #1: claim_task(task_id=…1801)
  tool_call #2: write_file(path="config.ts", content="...")
```

After `#1` executes, Alice owns that Worktree. But the Runner's workspace was set at construction time, so `#2` will still write to the main directory.

**Method three: let the model carry the path itself.**

```text
System prompt: After you claim a task, please add your worktree prefix before all file paths
```

This hands the isolation boundary to the model's self-discipline. If the model forgets, guesses wrong, or is tricked by prompt injection, the isolation is gone. **A security boundary cannot depend on the model cooperating.**

### The correct shape: resolve again before every tool call

The code introduces a pluggable interface, `ToolContextProvider` ([src/core/loop.ts](code/chapters/ch18/src/core/loop.ts)):

```typescript
export interface ToolContextProvider {
  readonly workspaceRoot: string;
  resolve(context: ToolContext): ToolContext | Promise<ToolContext>;
}
```

Then, in `#executeTool`, it calls it once for **every tool call**. Its position is extremely critical:

```typescript
let prepared: PreparedToolCall;
try {
  prepared = tools.prepare(call);          // ① Argument schema validation
} catch {
  return execution(toolError("tool_preparation_error", "Tool preparation failed"));
}
if (prepared.error !== undefined) {
  return execution(prepared.error);
}

// ② Resolve trusted workspace after argument schema validation and before PreToolUse, permissions, and handler;
//    Tool handlers remain uncalled on parse failure, returning pairing errors directly.
try {
  context = await this.#resolveToolContext(context);
} catch {
  return execution(toolError("tool_context_error", "Tool context resolution failed"));
}

let preHook: HookResult;
try {
  preHook = await this.#hooks.runPreTool(prepared);   // ③ PreToolUse hook
  ...
```

The order is **schema validation → resolve cwd → PreToolUse hook → permission decision → handler**.

Why must it be placed at exactly this position?

```text
Before schema validation  ✗  The arguments have not been validated yet; it may resolve a malformed task_id
After PreToolUse          ✗  The Hook sees the wrong workspace, and every judgement based on it is invalid
After the permission decision ✗  The permission policy decides from the wrong path, and it may allow an out-of-bounds write
Inside the handler        ✗  Every tool must remember to resolve it itself; miss one tool and you miss one hole

After the schema, before the Hook  ✓  The arguments are trusted, and every later stage sees the final cwd
```

**The sentence "the handler remains uncalled" is a hard constraint in this chapter.** When resolution fails, the tool function is not executed even once. What is returned is a paired error message (`tool_context_error`). In the history, the tool_call and the tool_result still form a pair — the model sees "this call failed", instead of seeing a dangling call.

### The Loop does not trust the provider

`ToolContextProvider` is pluggable. So what if someone injects a malicious provider and changes the workspace to `C:\Windows`?

After the provider returns, `#resolveToolContext` validates it again:

```typescript
async #resolveToolContext(context: ToolContext): Promise<ToolContext> {
  const provider = this.#toolContextProvider;
  if (provider === undefined) return context;
  // Provider maps claims to restricted workspaces; core only verifies identity immutability and paths within repo roots.
  const resolved = await provider.resolve(context);
  if (typeof resolved !== "object" || resolved === null) {
    throw new TypeError("tool context provider must return ToolContext");
  }
  if (
    resolved.identity !== context.identity ||
    resolved.idempotencyKey !== context.idempotencyKey ||
    resolved.executionScope !== context.executionScope
  ) {
    throw new Error("tool context provider changed immutable execution identity");
  }
  const workspace = await realpath(resolved.workspace);
  if (!(await stat(workspace)).isDirectory() || !isWithin(this.#workspaceRoot, workspace)) {
    throw new Error("resolved tool workspace is outside the controlled workspace root");
  }
  // Freezes and writes resolved real path again; tools cannot rewrite execution directory during calls.
  return Object.freeze({ ...resolved, workspace });
}
```

Three checks. Their responsibilities are divided clearly:

| Check | What it prevents | Who is responsible |
| --- | --- | --- |
| `identity` / `idempotencyKey` / `executionScope` are immutable | The provider impersonates someone else, or tampers with the idempotency key | Loop |
| `realpath` + `isWithin` | The path escapes the repository root (including a symlink bypass) | Loop |
| Whether the claim is valid, and whether the binding is active | Business rules | provider |

**The Loop controls only "it must not go out of bounds". The provider controls only "where it should go".** This division of work lets the provider be replaced, but a replacement cannot break through the boundary. At the end, it freezes the result once more with `Object.freeze`, so it cannot be changed during tool execution either.

### `executionScope`: how to recognise "the same reply"

Now return to that "claim first, then write, in the same reply" scenario. After `claim_task` executes, how does `write_file` know that it should go to Alice's directory?

The answer is that each turn creates a new empty object, and it uses the object's **reference identity** as the marker ([src/core/loop.ts](code/chapters/ch18/src/core/loop.ts)):

```typescript
// Create an independent executionScope for each turn; inject when provider is available.
// Allows consecutive tool calls within the same reply to share claim associations, without leaking across turns.
const toolContextScope = Object.freeze({});
const context: ToolContext = Object.freeze({
  workspace: this.#workspace,
  identity: runtimeEvent?.contextIdentity ?? this.#identity,
  ...(turnIdempotencyKey === undefined ? {} : { idempotencyKey: turnIdempotencyKey }),
  ...(claimToken === undefined ? {} : { claimToken }),
  ...(this.#toolContextProvider === undefined ? {} : { executionScope: toolContextScope }),
});
```

`Object.freeze({})` is an empty object. It carries no data. Its only function is "it is itself" — two empty objects are never equal.

`WorktreeRuntime` uses it as a WeakMap key:

```typescript
// executionScope -> claimToken mapping; consecutive tool calls in the same reply share this binding.
readonly #scopeClaims = new WeakMap<object, string>();
```

After `claim_task` succeeds, it registers one entry:

```typescript
async claimTask(taskId: string, context: ToolContext): Promise<TaskClaim> {
  const binding = await this.#store.getWorktreeBinding(taskId);
  if (binding.status !== WorktreeStatus.ACTIVE) {
    throw new WorktreeStateError(`Task ${binding.taskId} does not have an active worktree`);
  }
  if (context.executionScope === undefined) {
    throw new WorktreeContextError("Task claim requires an execution scope");
  }
  const claim = await this.#store.claimTask(binding.taskId, context.identity);
  this.#scopeClaims.set(context.executionScope, claim.claimToken);
  return claim;
}
```

Every later `resolve()` can find it:

```typescript
#explicitContextToken(
  context: ToolContext,
): { readonly required: true; readonly value: string } | { readonly required: false } {
  // Explicit claimToken has highest priority; executionScope only serves as a transient link to earlier claims in the same reply.
  if (context.claimToken !== undefined) {
    try {
      return { required: true, value: canonicalClaimToken(context.claimToken) };
    } catch (error) {
      throw new WorktreeContextError("Execution claim token is invalid", { cause: error });
    }
  }
  if (context.executionScope !== undefined) {
    const token = this.#scopeClaims.get(context.executionScope);
    if (token !== undefined) return { required: true, value: token };
  }
  return { required: false };
}
```

The return type is a **discriminated union**: when `required: true`, it necessarily carries a `value`; when `required: false`, it has no `value` field at all. So after the line `if (!token.required)` in `resolve()` in the next section, TypeScript knows that in the remaining branch `token.value` is definitely a string, and no further null check is needed. This is cleaner than returning `string | undefined` and writing `if (token !== undefined)` everywhere — "is there a claim" and "what is the claim" are two questions, and they are separated in the type.

**Why use a WeakMap instead of a Map?** Because the key is that scope object. When the turn ends and nobody references the object, the entry in the WeakMap disappears automatically. If you used a Map, every turn would permanently leave one record behind — a memory leak that only grows.

**Why does an explicit `claimToken` have higher priority?** Because the cross-reply scenario needs it. When a Teammate auto-claims, the claim token is passed in through `AgentRunner.run(prompt, { claimToken })`. At that time, no `claim_task` call has registered a scope yet. An explicit token is a "recovery credential across replies". A scope is a "short-lived association within one reply". They are at different levels.

**The scope is not cleared when the task completes:**

```typescript
const outcome = await this.#store.completeTask(
  normalizedTaskId,
  context.identity,
  normalizedToken,
);
return outcome;
```

`completeTask` only updates the store, and it leaves `#scopeClaims` as it is. At first glance, this looks counter-intuitive — the lease is complete, so why keep the mapping? Because clearing it is the dangerous side. Once the scope is deleted, `#explicitContextToken()` will reach `return { required: false }`, and later tools in the same reply will be treated as "no claim", and they will **silently fall back to the main directory**. If the mapping is kept, later calls still enter `resolve()` with this token, and `lookupClaim()` finds that the lease is no longer `in_progress` and throws an explicit error.

This is exactly the principle in the next section: an invalid claim must fail. It must not fall back. The lifecycle of the scope mapping is reclaimed naturally by the WeakMap together with the scope object. No manual intervention is needed at completion time.

Experiment 6 uses a scripted model. In one reply, it issues two calls, `claim_task` + `write_file`:

```text
===== routing =====
Final text: done
The cwd resolved for the two tool calls:
  claim_task → <root>
  write_file → <root>\.agent_tutorial\worktrees\alice
config.ts in the worktree: "// alice\n"
config.ts in the main directory: "export const value = 0;\n"
```

**`claim_task` itself resolves to the main directory** (there was no claim at that time), and **the `write_file` immediately after it resolves to the Worktree**. The switch happens between two tool calls in the same assistant reply.

---

## An invalid claim must fail; it must not fall back to the main directory

The complete logic of `resolve()` is as follows ([src/features/worktrees.ts](code/chapters/ch18/src/features/worktrees.ts)):

```typescript
async resolve(context: ToolContext): Promise<ToolContext> {
  const token = this.#explicitContextToken(context);
  if (!token.required) {
    if (context.taskId !== undefined) {
      throw new WorktreeContextError("Explicit task context does not have an active claim");
    }
    return contextForWorkspace(context, this.#workspaceRoot);
  }
  let claim: TaskClaim | undefined;
  try {
    claim = await this.#store.lookupClaim(token.value);
  } catch (error) {
    if (error instanceof TaskError) {
      throw new WorktreeContextError("Execution claim is no longer active", { cause: error });
    }
    throw error;
  }
  if (claim === undefined) {
    throw new WorktreeContextError("Execution claim does not have a known active lease");
  }
  if (claim.task.owner !== context.identity) {
    throw new WorktreeContextError("Execution identity does not own the active Task claim");
  }
  if (context.taskId !== undefined && context.taskId !== claim.task.id) {
    throw new WorktreeContextError("Execution task does not match the active Task claim");
  }
  const binding = await this.#store.getWorktreeBinding(claim.task.id);
  if (binding.status !== WorktreeStatus.ACTIVE) {
    throw new WorktreeContextError("Active Task claim does not have an active worktree binding");
  }
  if (context.worktreeName !== undefined && context.worktreeName !== binding.name) {
    throw new WorktreeContextError("Execution worktree does not match the active Task binding");
  }
  const path = await this.#registeredWorktreePath(binding, true);
  return Object.freeze({
    ...context,
    workspace: path,
    taskId: claim.task.id,
    claimToken: claim.claimToken,
    worktreeName: binding.name,
  });
}
```

The key is the fork at the start:

```text
There is a claim (explicit token or scope mapping)
  → It must pass all 5 validations; only then is a Worktree path given
  → If any validation fails: throw WorktreeContextError, and give no path

There is no claim
  → Return the main workspace (this is normal: the Lead creates tasks and reads files, and it should be in the main directory)
```

**"No claim → main directory" and "invalid claim → error" are two completely different things.** The first is a normal path. The second is fail-closed.

What happens if you also write the second case as "fall back to the main directory"?

```text
Alice's lease has just expired (she does not know it herself)
  → Her next write_file fails to resolve
  → If it falls back to the main directory: she starts writing code into the main directory, and she pollutes the integration ref
  → And there is no error at all, and nobody knows
```

This is the typical harm of "silent degradation": **it turns a detectable failure into an undetectable wrong result.**

The five validations each prevent one thing:

| Validation | Attack / error it prevents |
| --- | --- |
| The token can be found, and it is still an active lease | Using an expired, forged, or completed token |
| `claim.task.owner === context.identity` | Bob takes Alice's token and uses it |
| `context.taskId` matches the task in the claim | The token is correct, but the declared task is wrong |
| The binding must be `active` | Routing with a `reserved` / `kept` / `needs_review` binding |
| `context.worktreeName` matches the binding | The declared directory name does not match the actual binding |

Note the handling of "known but invalid" in `lookupClaim`:

```typescript
const known = queryRows(database, "SELECT task_id FROM task_claim_tokens WHERE token = ?", [
  normalizedToken,
])[0];
if (known === undefined) return undefined;      // It was never generated → undefined
const now = this.#now();
releaseExpired(database, now);
const row = queryRows(
  database,
  "SELECT id, lease_expires_at_utc FROM tasks WHERE claim_token = ? AND status = 'in_progress'",
  [normalizedToken],
)[0];
if (row === undefined) {
  throw new TaskClaimError("claim token is known but no longer active");  // It was generated but is now invalid → throw an error
}
```

**"It never existed" and "it existed once but is invalid now" must be distinguished.** The first may be a string made up at random. The second means that something really happened in the system (the lease expired, or the task completed). The `task_claim_tokens` history table from Chapter 17 makes this distinction possible.

Experiment 7 runs all nine cases once:

```text
===== failclosed =====
Correct identity + token        → <root>\.agent_tutorial\worktrees\alice
Wrong identity                  → WorktreeContextError: Execution identity does not own the active Task claim
Wrong task_id                   → WorktreeContextError: Execution task does not match the active Task claim
Token that was never generated  → WorktreeContextError: Execution claim does not have a known active lease
Token with a wrong format       → WorktreeContextError: Execution claim token is invalid
Wrong worktree name             → WorktreeContextError: Execution worktree does not match the active Task binding
No claim at all                 → <root>
Only task_id, no token          → WorktreeContextError: Explicit task context does not have an active claim
Old token used after completion → WorktreeContextError: Execution claim is no longer active
```

**In nine lines, only two lines return a path.** The first line (everything is correct) gives the Worktree. The seventh line (no claim at all) gives the main directory. The other seven lines are all explicit errors, and each error message is different — during investigation, you can immediately know which link went wrong.

Look especially at the eighth line: "only task_id, no token". This is that `if (context.taskId !== undefined) throw` branch. Why can it not be let through? Because the declaration "I want to execute in the context of task X" itself means that there should be a claim. If there is a declared task but no claim, the caller's state is confused — it is better to fail.

---

## Manual claim and automatic stealing must take the same path

Chapter 17 has two claim entry points: the model explicitly calls `claim_task`, and an idle Teammate automatically calls `claimNext`. This chapter adds a new constraint to claiming ("there must be an active binding"). This constraint **cannot be added to only one of the entry points**.

The code makes `WorktreeRuntime` implement the `TaskClaimService` interface directly:

```typescript
export class WorktreeRuntime implements TaskClaimService, ToolContextProvider {
```

All three methods are on it:

| Method | Who calls it | Which constraint was added |
| --- | --- | --- |
| `claimTask(taskId, context)` | The model calls the `claim_task` tool | The binding must be `active`; there must be an `executionScope` |
| `claimNext(owner)` | The Teammate idle loop | It uses `claimNextBound`, and it scans only `active` bindings |
| `completeTask(taskId, token, context)` | The model calls the `complete_task` tool | It calls `resolve()` first and then checks; on success, it clears the scope |

`claimNext` has only three lines, but it replaces the underlying query:

```typescript
async claimNext(owner: string): Promise<TaskClaim | undefined> {
  // Auto-claim uses claimNextBound: picks only ready tasks with existing active bindings,
  // Prevents idle polling from bypassing Worktree constraints.
  return await this.#store.claimNextBound(owner);
}
```

On top of `claimNext` from Chapter 17, `claimNextBound` adds one more filter layer ([src/adapters/task-sqlite.ts](code/chapters/ch18/src/adapters/task-sqlite.ts)):

```typescript
async claimNextBound(owner: string): Promise<TaskClaim | undefined> {
  const normalizedOwner = normalizeOwner(owner);
  return await this.#transaction(true, (database) => {
    const now = this.#now();
    releaseExpired(database, now);
    const graph = loadGraph(database);
    const active = new Set(
      queryRows(database, "SELECT task_id FROM worktree_bindings WHERE status = 'active'").map(
        (row) => requiredString(row.task_id, "worktree task id"),
      ),
    );
    for (const id of graph.order) {
      const task = graph.tasks.get(id);
      if (task === undefined || !active.has(id) || task.status !== TaskStatus.PENDING) continue;
      if (
        task.blockedBy.some(
          (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
        )
      ) {
        continue;
      }
      return this.#claim(database, graph, task, normalizedOwner, now);
    }
    return undefined;
  });
}
```

Note the `continue` at `!active.has(id)`: **a task with no active binding is skipped. It is not an error. It is skipped.** It is as if it does not exist, and the scan continues.

This choice has a direct consequence: **a ready task that is not bound to a Worktree will stay at `pending` forever.** This is deliberate. The behavior in Chapter 17 was "if there is work, do it". This chapter changes it to "work only if there is territory". If you want it to be claimed, the Lead must create a Worktree for it first.

Experiment 8 verifies this point:

```text
===== auto =====
Task board order: Task with no worktree (pending) / Task with a worktree (pending)
The unbound task comes first, but claimNext will only pick the bound one:
  First claimNext → Task with a worktree
  Unbound task status → pending
  Second claimNext (bob) → undefined (there is no second active binding)

The auto-claim prompt looks like this:
<auto-claimed-task>
{"claim_token":"00000000-0000-4000-8000-000000001811","lease_expires_at_utc":"2026-08-30T10:01:00.000Z","task":{"blocked_by":[],"description":"","id":"00000000-0000-4000-8000-000000001802","owner":"alice","status":"in_progress","subject":"Task with a worktree"}}
</auto-claimed-task>
```

**The unbound task comes earlier, but it was skipped**, and its status was not changed. The second claim returns `undefined` — not "there is no ready task", but "there is no second active binding".

### After auto-claim, how is the claim token passed on

After a Teammate obtains a claim, it passes the token to the Runner as both an idempotency key and a routing credential ([src/features/teammates.ts](code/chapters/ch18/src/features/teammates.ts)):

```typescript
// claim is an atomic SQLite lease; claimToken also acts as an idempotency key so failure replay does not execute the same task repeatedly.
await worker.runner.run(workStealing.renderClaimPrompt(claim), {
  idempotencyKey: claim.claimToken,
  claimToken: claim.claimToken,
  signal,
});
```

One token, three functions:

```text
claim.claimToken
  ├─▶ idempotencyKey  : A replay does not execute again (Chapter 17)
  ├─▶ claimToken      : The explicit credential in ToolContext → resolve() routes to the Worktree (this chapter)
  └─▶ complete_task argument: It must be presented when the task is completed (Chapter 17)
```

This reuse is not a shortcut. It is what it should be in the first place: **the question "which task lease does this run belong to" has only one answer.**

### The composition root forces the three to share the same object

[src/bootstrap.ts](code/chapters/ch18/src/bootstrap.ts) has a validation block that looks verbose but is critical:

```typescript
if (
  dependencies.worktreeRuntime !== undefined &&
  (dependencies.workStealingRuntime === undefined ||
    dependencies.workStealingRuntime.store !== dependencies.worktreeRuntime.store ||
    dependencies.workStealingRuntime.claimService !== dependencies.worktreeRuntime)
) {
  throw new Error(
    "worktreeRuntime must be the WorkStealingRuntime claim service and share its store",
  );
}
```

All three `!==` checks are **reference equality** checks, not content comparisons. They require:

```text
      ┌─────────────────────┐
      │  SqliteTaskStore    │  ← There is only one instance
      └──────┬───────┬──────┘
             │       │
    ┌────────▼──┐  ┌─▼───────────────────┐
    │ Worktree  │  │ WorkStealingRuntime │
    │ Runtime   │◀─┤ .claimService       │  ← It must point to the same WorktreeRuntime
    └───────────┘  └─────────────────────┘
```

**Why use reference equality instead of "the same content is enough"?** Because that `#scopeClaims` WeakMap is **instance-private state**. Even if two `WorktreeRuntime` instances have exactly the same configuration, their WeakMaps are independent — a scope that Alice registered on instance A cannot be found by instance B. This kind of bug appears as "routing fails occasionally", and it is extremely hard to locate. So the composition root rejects it directly with one `!==` line.

There is a symmetric check on the `WorkStealingRuntime` side ([src/features/work-stealing.ts](code/chapters/ch18/src/features/work-stealing.ts)):

```typescript
// Only claimService.store === store is allowed; this prevents the two states from forking
if (!isTaskClaimService(claimService) || claimService.store !== store) {
  throw new Error("claimService must use the leased Task store");
}
```

---

## Three new tools, for the Lead only

The Lead gains three tools. Teammates and Subagents gain none of them. They are defined in `worktreeToolDefinitions`:

| Tool | Arguments | effect | What it does |
| --- | --- | --- | --- |
| `create_worktree` | `task_id`, `name`, `integration_ref` | `external` | Create a bound Worktree for one pending task |
| `keep_worktree` | `task_id` | `write` | Explicitly keep the Worktree of a completed task |
| `remove_worktree` | `task_id` | `external` | Delete a Worktree after safety is proved |

**The `effect` classification is not decoration.** It decides whether this tool will go through approval, and whether it will be blocked by the plan gate (the mechanisms in Chapters 3, 4, and 16). The reasons for the classification:

- `create_worktree` / `remove_worktree` are `external`: they call a Git child process, they change the directory structure on disk, and they change branches; their impact range exceeds a single file;
- `keep_worktree` is `write`: it only changes one row of state in the database, and on the Git side it only reads `HEAD` once.

**Why can a Teammate not get these three tools?** Because the Worktree lifecycle is the Lead's orchestration responsibility. If a teammate could create a Worktree itself, a self-growth loop would appear: "I will first open a directory for myself, and then work" — this is the same reason Chapter 17 does not give a teammate `create_task`. If a teammate could delete one itself, one wrong judgement could delete another person's result that has not been reviewed yet.

Experiment 9 lists the difference. Note that it builds a **minimal registry** (file tools + task tools + the three tools in this chapter). It is not the complete Lead tool surface in P18 — a real Lead also has `todo_write`, `task`, Skill, Cron, `spawn_teammate`, `send_message`, Protocol, and so on. Here we only care about "what this chapter added, and whether a teammate has it":

```text
===== tools =====
Lead:      shell, read_file, write_file, edit_file, glob, create_task, get_task, list_tasks, claim_task, complete_task, create_worktree, keep_worktree, remove_worktree
Teammate:  shell, read_file, write_file, edit_file, glob, get_task, list_tasks, claim_task, complete_task

Effect classification of the three Worktree tools:
  create_worktree  effect=external
  keep_worktree    effect=write
  remove_worktree  effect=external

Does the Lead have create_task:        true
Does a Teammate have create_task:      false
Does a Teammate have create_worktree:  false
```

The difference between the two sides is four tools: `create_task` plus the three Worktree tools. But a teammate still has `claim_task` / `complete_task` — **it can claim and complete. It just cannot create a task, and it cannot create or destroy territory.**

(The real teammate tool surface is narrower than this: the composition root starts with `subset(["shell", "read_file", "write_file"])`, and then adds `send_message`, `submit_plan`, and the four task tools. The experiment uses the complete file tool set so that the comparison focuses only on the task and Worktree tools.)

### What the tool returns to the model

`encodeBinding` serialises a binding to snake_case JSON, with the keys in alphabetical order:

```typescript
function encodeBinding(binding: WorktreeBinding): string {
  // Tool outputs use snake_case; dates are fixed to UTC ISO strings.
  return JSON.stringify({
    baseline_commit: binding.baselineCommit,
    branch: binding.branch,
    branch_tip: binding.branchTip,
    created_at_utc: binding.createdAtUtc.toISOString(),
    integration_ref: binding.integrationRef,
    name: binding.name,
    relative_path: binding.relativePath,
    review_reason: binding.reviewReason,
    status: binding.status,
    task_id: binding.taskId,
    updated_at_utc: binding.updatedAtUtc.toISOString(),
  });
}
```

Experiment 9 will print what the model really sees:

```text
Content returned by create_worktree to the model (isError=false):
  {
    "baseline_commit": "554107b249b070468bd47f5e44a6a6ea53138dec",
    "branch": "wt/alice",
    "branch_tip": "554107b249b070468bd47f5e44a6a6ea53138dec",
    "created_at_utc": "2026-08-30T10:00:00.000Z",
    "integration_ref": "refs/heads/main",
    "name": "alice",
    "relative_path": ".agent_tutorial/worktrees/alice",
    "review_reason": null,
    "status": "active",
    "task_id": "00000000-0000-4000-8000-000000001801",
    "updated_at_utc": "2026-08-30T10:00:00.000Z"
  }
```

When it has just been created, `branch_tip === baseline_commit` — the branch has no new commit yet, and its tip is the baseline. This is a useful observation point: at every later `keep` / `remove`, `branch_tip` will be updated to the real `HEAD` at that time.

(The commit hash you get when you run it yourself will be different from the one above: each experiment run creates a new temporary repository, the timestamp of the initial commit is different, and the hash is naturally different. The IDs and timestamps are fixed, because the experiment injects a deterministic generator and clock.)

**The inside uses camelCase, and the wire format uses snake_case. This boundary is crossed only in the tool definition.** The domain object and the database column names each keep their own style, and the conversion happens in only one place.

The same experiment also verifies the behavior of the unique constraint — the error is **returned in a structured form**, not thrown as an exception:

```text
Create again with the same name → isError=true errorCode=worktree_invalid_state
  Error [worktree_invalid_state]: Worktree task, name, branch, or path is already reserved
```

The model receives an error result with an `errorCode`, and it can decide from it to change the name and retry. If an exception were thrown here, the whole turn would break.

---

## Cleanup must first prove "it can be deleted"

This is the section with the most code in this chapter, and it is also the section most worth reading carefully. Its core position in one sentence:

> **Deletion is not a command. It is a chain of proofs. If it cannot be proved, do not delete.**

`remove_worktree` goes through eight steps in order. If any step fails, it moves to `needs_review`:

```text
        remove_worktree(task_id)
                 │
    ┌────────────▼─────────────┐
    │ ① Is the task completed?  │──No──▶ Throw WorktreeStateError (even the state is wrong; this is not a review matter)
    └────────────┬─────────────┘
    ┌────────────▼─────────────┐
    │ ② Does the binding state  │──No──▶ Throw WorktreeStateError
    │   allow it?               │
    │   (active/kept/           │
    │     needs_review)         │
    └────────────┬─────────────┘
    ┌────────────▼─────────────┐
    │ ③ Does the managed path   │──No──▶ needs_review
    │   really exist, and has   │        "managed worktree path is unavailable or escapes the workspace"
    │   it not escaped the      │
    │   workspace?              │
    └────────────┬─────────────┘
    ┌────────────▼─────────────┐
    │ ④ Do the worktree and     │──No──▶ needs_review
    │   branch registered in    │        "managed path is not the registered worktree and branch"
    │   Git both match?         │
    └────────────┬─────────────┘
    ┌────────────▼─────────────┐
    │ ⑤ Did git status run      │──No──▶ needs_review
    │   successfully?           │        "git status could not prove the worktree is clean"
    └────────────┬─────────────┘
    ┌────────────▼─────────────┐
    │ ⑥ Is the output empty?    │──No──▶ needs_review
    │   (There really are no    │        "worktree has uncommitted changes"
    │   uncommitted changes)    │
    └────────────┬─────────────┘
    ┌────────────▼─────────────┐
    │ ⑦ Were both commits       │──No──▶ needs_review
    │   resolved?               │        "integration ref or branch tip could not be resolved"
    └────────────┬─────────────┘
    ┌────────────▼─────────────┐
    │ ⑧ Is the branch tip an    │──No──▶ needs_review
    │   ancestor of the         │        "worktree branch tip is not contained by the integration ref"
    │   integration ref?        │
    └────────────┬─────────────┘
                 │ All eight steps pass
    ┌────────────▼──────────────────────────────────┐
    │ git switch --detach <tip>   In the worktree    │──Fails──▶ needs_review
    │ git branch -d wt/<name>     In the main directory (not -D) │──Fails──▶ needs_review
    │ git worktree remove <path>  In the main directory (not force) │──Fails──▶ needs_review
    └────────────┬──────────────────────────────────┘
                 ▼
             removed
```

I will explain, one by one, why each step cannot be omitted:

**③ The path check uses `realpath` instead of `existsSync`.** `#registeredWorktreePath` first confirms that `relative_path` is exactly the value the runtime derives. It then resolves the real path with `realpath`. It then confirms that the resolved result **equals** the expected path (this prevents a symlink replacement). It then confirms that it is still inside the workspace.

**④ A directory alone does not count as "managed".** `#isRegisteredWorktree` asks Git three questions at the same time:

```typescript
const [top, common, branch] = await Promise.all([
  this.#runGit(["rev-parse", "--show-toplevel"], path),
  this.#runGit(["rev-parse", "--git-common-dir"], path),
  this.#runGit(["branch", "--show-current"], path),
]);
```

- `--show-toplevel` must equal this path (it is not nested inside another repository);
- `--git-common-dir` must equal the `.git` of the **main repository** (it is not a worktree of another repository);
- `--show-current` must equal `wt/{name}` (the branch has not been switched away).

**Why ask about `--git-common-dir`?** Imagine that someone placed a worktree of another repository at the `.agent_tutorial/worktrees/alice` location, or simply ran `git init` for a new repository there. The directory exists, and the branch name can also match, but it belongs to another object store. Deleting it would delete another person's thing.

**⑤ and ⑥ are two different things.** A non-zero return from `git status` (the command itself failed) and an empty return from `git status` (it really is clean) must not be mixed. The first is "I do not know". The second is "I know it is clean". **"I do not know" must be handled as "there may be changes".**

```typescript
const status = await this.#runGit(["status", "--porcelain=v1", "--untracked-files=all"], path);
if (status.returncode !== 0) {
  return await this.#needsReview(binding, binding.branchTip, "git status could not prove the worktree is clean");
}
if (status.stdout.length > 0) {
  return await this.#needsReview(binding, binding.branchTip, "worktree has uncommitted changes");
}
```

Note `--untracked-files=all`: **a newly created file that has not been added also counts as dirty.** The default `--untracked-files=normal` reports only the directory name for a directory. `all` expands it to every file. Since you must judge "is there a person's work product here", you should use the strictest setting.

**⑧ Use `git merge-base --is-ancestor` instead of something else.**

```typescript
const ancestry = await this.#runGit(
  ["merge-base", "--is-ancestor", branchTip, integrationTip],
  this.#workspaceRoot,
);
```

This command answers one precise question: **"Is the commit `branchTip` already contained in the history of `integrationTip`?"** A return of 0 means "yes". A return of 1 means "no".

It covers several cases at the same time: a normal merge, a fast-forward, after a rebase (if the rebase result was merged in), and a squash merge (it does not cover it — a squash produces a new commit, the original commit is not an ancestor, so it will land in `needs_review`; this is conservative but correct).

**Compare the approaches the code deliberately does not use:**

| Approach not used | Why it is not used |
| --- | --- |
| `git branch --merged` | Its output needs text parsing, and its semantics depend on the current HEAD |
| Compare `@{push}` / upstream | It depends on remote configuration; this chapter does not assume a remote exists |
| Check "are there unpushed commits" | "Pushed" does not equal "merged in"; these are two different things |
| `git branch -D` | It force-deletes, and it will lose commits that have not been merged in |
| `git worktree remove --force` | It will lose uncommitted changes |

The order of the last three steps also matters:

```text
① git switch --detach <tip>   Why detach first?
   Because git branch -d cannot delete a branch that a worktree has checked out.
   Detach makes the worktree HEAD point directly to the commit, and the branch becomes "free".

② git branch -d wt/<name>     Why execute it in the main directory?
   A branch is repository-level. It is the same in any worktree, but the main directory is the authoritative location.
   Use -d, not -D: -d itself checks "delete only if already merged in", which is a second layer of insurance.

③ git worktree remove <path>  Why last?
   After the directory is deleted, you can no longer execute Git commands inside it.
```

Experiment 10 uses a `RecordingGitRunner` to record the real call sequence (these are really executed commands, not a diagram I wrote):

```text
===== cleanup =====
Git commands used by the step-by-step proof in remove_worktree:
  git branch --show-current -> 0
  git rev-parse --show-toplevel -> 0
  git rev-parse --git-common-dir -> 0
  git status --porcelain=v1 --untracked-files=all -> 0
  git rev-parse --verify HEAD^{commit} -> 0
  git rev-parse --verify refs/heads/main^{commit} -> 0
  git merge-base --is-ancestor d504d7df927bd8d6368c5462581f3943b9ab37cc d504d7df927bd8d6368c5462581f3943b9ab37cc -> 0
  git switch --detach d504d7df927bd8d6368c5462581f3943b9ab37cc -> 0
  git branch -d wt/alice -> 0
  git worktree remove C:\Users\<you>\AppData\Local\Temp\probe-ch18-kTskdw\.agent_tutorial\worktrees\alice -> 0
Final binding: status=removed branch_tip=d504d7d review_reason=null
branch_tip matches the last commit on the alice branch: true
Worktrees still in git worktree list: 1
Does the alice branch still exist: ""
Is alice's commit still on main: "export const value = 1;\r\n"
```

Ten commands. **Not one of them carries `--force` or `-D`.**

**The order of the first three may be different when you run it.** Because `#isRegisteredWorktree` sends these three in parallel with `Promise.all`, and `RecordingGitRunner` records them in **completion order**. There is no dependency between them, and it does not affect the conclusion which one returns first — all three answers must be correct before it counts as "a Managed Worktree". From the fourth command, `git status`, onwards, it is strictly serial, because every later step depends on the conclusion of the previous step.

That `--is-ancestor A A` looks strange — the two arguments are the same commit. This is because this time it was a fast-forward merge, and `main` pointed directly to alice's commit. A commit is its own ancestor. It returns 0, and the judgement holds.

The last line, `"export const value = 1;\r\n"`, proves that Alice's change **stayed on main** — the directory was deleted, and the result was not lost.

The same experiment also ran three failure paths:

```text
There are uncommitted changes → status=needs_review
  review_reason: worktree has uncommitted changes
  Directory still exists: true
  Branch still exists: true
  Event sequence: reserve/reserved → create/active → needs_review/needs_review

Not merged into main → status=needs_review
  review_reason: worktree branch tip is not contained by the integration ref
  Directory still exists: true
  Branch still exists: true
  Event sequence: reserve/reserved → create/active → needs_review/needs_review

git status itself reports an error → status=needs_review
  review_reason: git status could not prove the worktree is clean
  Directory still exists: true
  Branch still exists: true
  Event sequence: reserve/reserved → create/active → needs_review/needs_review
```

Three paths, **three different reasons, and in all three cases the directory and the branch are still there**. The third one is especially worth noting: the Git command itself failed, and the runtime did not "retry once" or "assume it is clean". It directly judged "I cannot prove it".

### review_reason does not leak stderr

All ten review reasons are **fixed English short sentences**. Not one of them concatenates Git's stderr:

```typescript
"managed worktree path or branch tip could not be resolved"   // keep_worktree
"managed worktree path is unavailable or escapes the workspace"
"managed path is not the registered worktree and branch"
"git status could not prove the worktree is clean"
"worktree has uncommitted changes"
"integration ref or branch tip could not be resolved"
"worktree branch tip is not contained by the integration ref"
"git could not detach the managed worktree"
"git could not safely delete the integrated branch"
"git could not remove the detached worktree"
```

Three reasons:

**One, stderr may contain sensitive information.** Absolute paths, user names, and remote URLs (which may carry a token). These will be written into the database, returned to the model, and entered into the context.

**Two, a fixed string can be judged by a program.** Do you want to write a script that "counts each type of failure reason"? A fixed enum can be grouped directly. A string with stderr concatenated into it needs a regular expression.

**Three, Git's error text changes with its version.** Code that depends on it for a judgement will fail for no clear reason when Git is upgraded.

### `#needsReview` does not transition repeatedly

One detail that is easy to overlook:

```typescript
async #needsReview(
  binding: WorktreeBinding,
  branchTip: string | null,
  reason: string,
): Promise<WorktreeBinding> {
  // Cleanup failures fall back to needs_review; non-active states stay unchanged to avoid duplicate or fictitious transitions.
  if (binding.status === WorktreeStatus.NEEDS_REVIEW || binding.status === WorktreeStatus.KEPT) {
    return binding;
  }
  return await this.#store.markWorktreeNeedsReview(binding.taskId, {
    branchTip,
    reason,
    occurredAtUtc: this.#now(),
  });
}
```

If the binding is already `kept` or `needs_review`, it returns it as it is, and it **does not write a new event**.

Why? Because both of these states are already "retention states". If you call `remove_worktree` repeatedly on a `kept` binding (and it fails every time), a string of duplicate `needs_review` events should not be left in the audit table. **The audit records state changes, not the number of failed attempts.**

And `kept` is a decision the Lead made actively ("I want to keep this"). A cleanup failure should not overwrite this active decision with "something went wrong".

### `keep_worktree` is simpler than remove, but it must also prove

```typescript
async keepWorktree(taskId: string): Promise<WorktreeBinding> {
  const binding = await this.#completedBinding(taskId, [WorktreeStatus.ACTIVE]);
  let branchTip: string;
  try {
    const path = await this.#registeredWorktreePath(binding, true);
    branchTip = await this.#resolveCommit("HEAD", path);
  } catch (error) {
    if (!(error instanceof WorktreeError)) throw error;
    return await this.#needsReview(
      binding,
      binding.branchTip,
      "managed worktree path or branch tip could not be resolved",
    );
  }
  return await this.#store.keepWorktree(binding.taskId, {
    branchTip,
    occurredAtUtc: this.#now(),
  });
}
```

`keep` does not delete anything. Why must it prove anything? Because it must **record a fact**: which commit was the branch tip when this Worktree was retained.

If even `HEAD` cannot be resolved (the directory was deleted by someone, or the Git metadata is broken), then this fact cannot be recorded. Writing a `kept` at this time would be lying — so it moves to `needs_review`.

Note that `keep` accepts only `active` (`#completedBinding(taskId, [WorktreeStatus.ACTIVE])`), while `remove` accepts three states (`active` / `kept` / `needs_review`). This is because `keep` means "move from a working state to a retention state", while `remove` is the final cleanup, and any retention state may try to enter it.

---

## The audit and the state transition must be in the same transaction

Every state change of a binding is committed together with one audit event in the same SQLite transaction. `#transitionWorktree` is the only entry point for all transitions:

```typescript
return await this.#transaction(true, (database) => {
  const graph = loadGraph(database);
  const task = getExisting(graph, normalized);
  // ① The task status must meet the precondition for this transition
  if (task.status !== options.requiredTaskStatus) {
    throw new WorktreeStateError(
      `Task ${task.id} is ${task.status}; expected ${options.requiredTaskStatus}`,
    );
  }
  const current = loadWorktreeBinding(database, normalized);
  // ② The current binding status must be in the allowed set
  if (!options.expected.includes(current.status)) {
    throw new WorktreeStateError(
      `Worktree binding ${current.taskId} is ${current.status}; transition is not allowed`,
    );
  }
  const updated = new WorktreeBinding({ /* ... */ });
  // ③ Conditional UPDATE: the WHERE clause carries the old status
  const changed = database.run(
    "UPDATE worktree_bindings SET branch_tip = ?, status = ?, review_reason = ?, updated_at_utc = ? WHERE task_id = ? AND status = ?",
    [
      updated.branchTip,
      updated.status,
      updated.reviewReason,
      encodeDate(updated.updatedAtUtc),
      updated.taskId,
      current.status,
    ],
  );
  // ④ Exactly one row must have been changed
  if (changed.getRowsModified() !== 1) {
    throw new WorktreeStateError("Worktree binding could not be atomically transitioned");
  }
  // ⑤ Append the audit in the same transaction
  appendWorktreeEvent(database, options.action, updated);
  return updated;
});
```

**`WHERE task_id = ? AND status = ?` plus `getRowsModified() !== 1` is the same technique as the atomic claim in Chapter 17.** The old status that was read and the old status at UPDATE time must be the same. Otherwise, it means that someone changed it in between — give up, and do not write from a stale read.

The precondition for each transition is declared through `requiredTaskStatus`:

| Transition method | `expected` (old binding status) | `requiredTaskStatus` (task status) |
| --- | --- | --- |
| `activateWorktree` | `reserved` | `pending` |
| `keepWorktree` | `active` | `completed` |
| `markWorktreeNeedsReview` | `active` | `completed` |
| `markWorktreeRemoved` | `active` / `kept` / `needs_review` | `completed` |

`activateWorktree` requires the task to still be `pending` — **during the whole process of creating the Worktree, the task must not be claimed by someone else.** If someone claims this task during `git worktree add`, activation will fail, and the binding will stay at `reserved`.

`reserveWorktree` uses the same transaction pattern:

```typescript
// The binding write and the reserve audit event are placed in the same BEGIN IMMEDIATE transaction;
// if the event write fails, the binding state rolls back together with it, and no intermediate state of "reserved but with no audit" appears.
```

Experiment 5 will run a complete reserve → create → keep, and look at the audit chain:

```text
===== audit =====
worktree_events (append-only):
  #1 reserve       status=reserved     branch_tip=null at=2026-08-30T10:00:00.000Z
  #2 create        status=active       branch_tip=365675c at=2026-08-30T10:00:00.000Z
  #3 keep          status=kept         branch_tip=365675c at=2026-08-30T10:00:00.000Z
```

The timestamps of the three events are exactly the same (the test uses a fixed clock), but `sequence` gives a definite order. The `branch_tip` of `#1` is null — the branch did not exist at that time, and it honestly records null instead of filling in a placeholder value first.

---

## A non-Git directory must fail before any state is created

`validateRepository()` is the precondition gate for all Worktree operations:

```typescript
async validateRepository(): Promise<void> {
  if (this.#repositoryValidated) return;
  let root: string;
  try {
    root = await realpath(this.#workspaceRoot);
    if (!(await stat(root)).isDirectory()) throw new Error("workspace is not a directory");
  } catch (error) {
    throw new WorktreeRepositoryError("workspace is not a Git repository", { cause: error });
  }
  const inside = await this.#runGit(["rev-parse", "--is-inside-work-tree"], root);
  if (inside.returncode !== 0 || inside.stdout.trim() !== "true") {
    throw new WorktreeRepositoryError("workspace is not a Git repository");
  }
  const top = await this.#runGit(["rev-parse", "--show-toplevel"], root);
  if (top.returncode !== 0)
    throw new WorktreeRepositoryError("workspace is not a Git repository");
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(top.stdout.trim());
  } catch (error) {
    throw new WorktreeRepositoryError("Git repository root could not be resolved", { cause: error });
  }
  if (repositoryRoot !== root) {
    throw new WorktreeRepositoryError("workspace is not a Git repository root");
  }
  this.#repositoryValidated = true;
}
```

**Note the last `repositoryRoot !== root` judgement: it must be exactly the repository root. A subdirectory is not allowed.**

Why is it so strict? Because `relative_path` is calculated relative to the repository root (`.agent_tutorial/worktrees/{name}`). If the workspace is `repo/src`, then `.agent_tutorial` will be created in `repo/src/.agent_tutorial`, while the path resolution in `git worktree add`, the comparison of `--git-common-dir`, and the `isWithin` check during cleanup are all based on different coordinate systems. **One set of logic must have only one origin.**

The CLI calls it **before it constructs any runtime state** ([src/cli.ts](code/chapters/ch18/src/cli.ts)):

```typescript
try {
  // Validate that cwd is a Git repository root before creating any runtime state, to avoid leaving a task database in the wrong directory.
  if (worktreeRuntime !== undefined) await worktreeRuntime.validateRepository();
  runner = buildAgent(profile, { /* ... */ });
```

This order exists for a very practical problem: **if you run this chapter's entry point in the wrong directory, it should not leave a `.agent_tutorial/tasks.sqlite3` behind to confuse you.**

Experiment 11 verifies this point:

```text
===== guard =====
Non-Git directory → WorktreeRepositoryError: workspace is not a Git repository root
createWorktree → WorktreeRepositoryError: workspace is not a Git repository root
Number of worktree_bindings rows: 0
Number of worktree_events rows:  0
Repository subdirectory → WorktreeRepositoryError: workspace is not a Git repository root
```

`createWorktree` also calls `validateRepository()` itself (it is on the first line), so even if someone bypasses the CLI and calls the API directly, it is still blocked. The third and fourth lines confirm that **no binding or event was left behind**.

The `#repositoryValidated` boolean flag is a small optimisation: after validation passes, it caches the result, so it does not need to fork two Git processes on every tool call. A repository root does not become a non-repository in the middle of a run.

---

## Two run entry points

First, synchronise and lock the dependencies in the tutorial code directory:

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location $TutorialCode
npm ci
```

Fixed chapter entry point:

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location 'C:\workspace\my-agent-project'
npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch18/src/chapters/ch18.ts" --prompt "Create two tasks and bind separate Worktrees, then start alice and bob to claim one each"
```

General entry point:

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location 'C:\workspace\my-agent-project'
npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch18/src/cli.ts" run --chapter 18 --prompt "Create two tasks and bind separate Worktrees, then start alice and bob to claim one each"
```

`npm exec --prefix` resolves `tsx` only from the tutorial code directory. The Agent's run cwd is still the root directory of your own Git repository. Real file writes, Git commands, and Worktree lifecycle tools still go through the existing Hook, permission, and approval boundaries.

The fixed entry point [src/chapters/ch18.ts](code/chapters/ch18/src/chapters/ch18.ts) has only 5 lines:

```typescript
import { runProfile } from "../cli.js";
import { P18 } from "../core/profiles.js";

// The fixed entry point reuses the general CLI and only fixes the P18 profile, to avoid passing --chapter repeatedly in chapter commands.
process.exitCode = await runProfile(P18, process.argv.slice(2));
```

Both entry points share `execute()` in [src/cli.ts](code/chapters/ch18/src/cli.ts). The assembly order is fixed:

```typescript
// A single SqliteTaskStore is injected into the Lead, Subagent, and Teammate factories at the same time, to avoid multiple databases forking.
const sqliteTaskStore = profile.capabilities.has("task_dag_sqlite")
  ? new SqliteTaskStore(workspace)
  : undefined;
// The P18 WorktreeRuntime acts as both TaskClaimService and ToolContextProvider,
// it reuses the same SQLite store, and it gathers Git child processes into the SubprocessGitRunner adapter layer.
const worktreeRuntime =
  profile.capabilities.has("worktree") && sqliteTaskStore !== undefined
    ? new WorktreeRuntime({
        workspace,
        store: sqliteTaskStore,
        gitRunner: new SubprocessGitRunner(),
      })
    : undefined;
const workStealingRuntime =
  sqliteTaskStore === undefined
    ? undefined
    : new WorkStealingRuntime({
        store: sqliteTaskStore,
        ...(worktreeRuntime === undefined ? {} : { claimService: worktreeRuntime }),
      });
```

One store, one `WorktreeRuntime`, and one `WorkStealingRuntime`. The last two both point to the same store, and the claim service of `WorkStealingRuntime` is that `WorktreeRuntime`. The three `!==` validations in bootstrap earlier verify exactly this structure.

The profile difference is only one line ([src/core/profiles.ts](code/chapters/ch18/src/core/profiles.ts)):

```typescript
// P18 adds controlled Git worktree isolation on top of SQLite work stealing.
export const P18: ChapterProfile = Object.freeze({
  chapter: 18,
  capabilities: new CapabilitySet([...P17.capabilities, "worktree"]),
});
```

---

## Run it step by step

This section assumes that you start from zero, and that you have not read the run instructions in the earlier chapters.

### Step 0: Confirm the tool versions

```powershell
git --version
node --version
npm --version
```

You need Git 2.5 or higher (`git worktree` has existed since 2.5), and Node 22 or higher. If `git --version` reports "not an internal or external command", install Git for Windows first.

### Step 1: Install the tutorial code dependencies

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location $TutorialCode
npm ci
```

`npm ci` installs strictly from `package-lock.json`. It will not secretly upgrade a version. The first run will download tens of megabytes of dependencies. Wait for it to finish.

### Step 2: Prepare a real Git repository

The runtime in this chapter **must** run in a Git repository root directory. Create a new practice repository:

```powershell
New-Item -ItemType Directory -Force 'C:\workspace\my-agent-project' | Out-Null
Set-Location 'C:\workspace\my-agent-project'
git init -b main
git config user.name  'Your Name'
git config user.email 'you@example.com'
Set-Content -Path '.gitignore' -Value '.agent_tutorial/' -Encoding utf8
Set-Content -Path 'config.ts' -Value 'export const value = 0;' -Encoding utf8
git add .
git commit -m 'initial'
```

That `.gitignore` line is important: **a Managed Worktree is created in `.agent_tutorial/worktrees/`. If you do not ignore it, Git will treat the contents of a child Worktree as files to be committed in the main directory.** After you ignore it, `git status` in the main directory always looks clean.

`config.ts` is the target file you will use later to observe the isolation effect.

### Step 3: Confirm that the repository state is acceptable

```powershell
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
git status --porcelain=v1
```

The first command must output `true`. The second command must output `C:/workspace/my-agent-project` (forward slashes are Git's style). The third command must output nothing. Only when all three are correct will `validateRepository()` let it through.

If the third command has output, commit or stash first — although `validateRepository()` does not check whether the main directory is clean, a dirty main directory will make it hard for you to tell which changes the Agent wrote.

### Step 4: Configure the model

```powershell
$env:OPENAI_BASE_URL = 'https://your-endpoint/v1'
$env:OPENAI_API_KEY  = 'sk-...'
$env:OPENAI_MODEL    = 'your-model'
```

If all three are missing, you will get one clear error:

```text
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

**Do you want to see only the Worktree mechanism, and not connect a model?** Jump to the experiment script in Step 6. None of the 11 experiments needs a model (only Experiments 6 and 8 use a replay script to impersonate a model).

### Step 5: Run it once

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location 'C:\workspace\my-agent-project'
npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch18/src/chapters/ch18.ts" --prompt "Change the value in config.ts to 1; first create a worktree named alice for the task"
```

After it runs, look at what it left behind:

```powershell
git worktree list
Get-ChildItem '.agent_tutorial\worktrees'
git branch --list 'wt/*'
```

The three commands give the Git view, the file system view, and the branch view. The three should agree.

### Step 6: Read the database directly

The Worktree state is stored in `.agent_tutorial/tasks.sqlite3`. If you have not installed the sqlite3 command-line tool, read it with sql.js from the tutorial dependencies:

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
npm exec --prefix $TutorialCode -- tsx -e @'
import initSqlJs from "sql.js";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(process.env.TUTORIAL_CODE + "/x.js");
const SQL = await initSqlJs({ locateFile: (f) => join(dirname(require.resolve("sql.js")), f) });
const db = new SQL.Database(await readFile(".agent_tutorial/tasks.sqlite3"));
for (const t of ["worktree_bindings", "worktree_events"]) {
  console.log("--", t);
  const r = db.exec(`SELECT * FROM ${t}`)[0];
  if (r) console.table(r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))));
}
'@
```

(`$env:TUTORIAL_CODE` must be set to the tutorial code directory first. This snippet is only for viewing. If it does not run, it does not affect the experiments that follow.)

### Step 7: Clean up

```powershell
Set-Location 'C:\workspace\my-agent-project'
git worktree list
```

If a Managed Worktree still remains, **first look inside it for anything you want to keep**, and then delete it by the normal process:

```powershell
git worktree remove '.agent_tutorial\worktrees\alice'
git branch -d 'wt/alice'
```

Use `-d`, not `-D`. If `-d` refuses to delete, it means that this branch still has commits that have not been merged in — that is exactly the signal that you should go and look at it.

---

## 11 hands-on experiments

All the experiments below run in a temporary directory. **They do not touch any of your real repositories**, and they clean up automatically when they finish. They import the Chapter 18 source code directly, so the behavior you see is the real behavior.

### First, build the probe script

Create a new file at `F:\笔记\Agent实操\code\scripts\probe-ch18.mts`. First write the common part:

```typescript
// scripts/probe-ch18.mts —— Chapter 18 probe script (temporary; you may delete it after you run it)
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import initSqlJs from "sql.js";

import { SubprocessGitRunner } from "../chapters/ch18/src/adapters/git.js";
import { SqliteTaskStore } from "../chapters/ch18/src/adapters/task-sqlite.js";
import { TaskStatus } from "../chapters/ch18/src/features/tasks.js";
import { WorkStealingRuntime } from "../chapters/ch18/src/features/work-stealing.js";
import type { GitCommandResult, GitRunner } from "../chapters/ch18/src/features/worktrees.js";
import { WorktreeRuntime } from "../chapters/ch18/src/features/worktrees.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const EXPERIMENT = process.argv[2] ?? "all";
const CLOCK_BASE = new Date("2026-08-30T10:00:00.000Z");

// Run only the experiment specified on the command line; if no argument is given, run them all.
function section(name: string): boolean {
  const selected = EXPERIMENT === "all" || EXPERIMENT === name;
  if (selected) console.log(`\n===== ${name} =====`);
  return selected;
}

// One temporary directory per experiment; it is always deleted at the end.
async function withTempDir<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "probe-ch18-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(cwd: string, ...argumentsValue: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...argumentsValue], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}
```

Then add a utility function that "creates a clean repository" — **it does exactly the same thing as the manual work in Step 2**:

```typescript
// Create a clean Git repository: main branch + one initial commit + ignore .agent_tutorial/
async function gitRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Probe");
  await git(root, "config", "user.email", "probe@example.test");
  await writeFile(join(root, ".gitignore"), ".agent_tutorial/\n", "utf8");
  await writeFile(join(root, "config.ts"), "export const value = 0;\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
}
```

Next are the deterministic tools. IDs and time must both be reproducible. Otherwise, the output will be different every time, and you cannot compare it:

```typescript
// Generate incrementing fake UUIDs such as …1801 / …1802, so the output is reproducible.
function seqId(start: number): () => string {
  let next = start;
  return () => {
    const hex = next.toString(16).padStart(12, "0");
    next += 1;
    return `00000000-0000-4000-8000-${hex}`;
  };
}

// Fixed clock: each read advances by 1 second, so timestamps are predictable.
class Clock {
  #current = CLOCK_BASE.getTime();
  now(): Date {
    this.#current += 1_000;
    return new Date(this.#current);
  }
}

function errorLine(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name}: ${error.message}`;
  return String(error);
}

function short(id: string): string {
  return id.slice(-4);
}

// Open tasks.sqlite3 read-only with sql.js, and look directly at the raw table structure and rows.
async function readSqlite(
  path: string,
): Promise<(sql: string) => readonly Record<string, unknown>[]> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(dirname(require.resolve("sql.js")), file),
  });
  const database = new SQL.Database(new Uint8Array(await readFile(path)));
  return (sql: string) => {
    const statement = database.prepare(sql);
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as Record<string, unknown>);
    statement.free();
    return rows;
  };
}
```

Last is the assembly function. **This is the core of the experiments: it is exactly the same as the real assembly in `cli.ts`** — one store, one `WorktreeRuntime` (which also acts as the claim service), and one `WorkStealingRuntime`:

```typescript
async function components(root: string, idBase = 0x1801) {
  await gitRepository(root);
  const clock = new Clock();
  const store = new SqliteTaskStore(root, {
    idGenerator: seqId(idBase),
    claimTokenGenerator: seqId(idBase + 0x10),
    clock,
    leaseDurationMs: 60_000,
  });
  const worktrees = new WorktreeRuntime({
    workspace: root,
    store,
    gitRunner: new SubprocessGitRunner(),
    clock: () => clock.now(),
  });
  await worktrees.validateRepository();
  const workStealing = new WorkStealingRuntime({ store, claimService: worktrees });
  return { clock, store, worktrees, workStealing };
}
```

Then add two fake runners that "deliberately make one Git command fail". They intercept only one command, and they execute the others normally — so the other links in the failure path are still real:

```typescript
// Record every Git command, and really execute it at the same time, to observe the exact call order in the cleanup chain.
class RecordingGitRunner implements GitRunner {
  readonly calls: string[] = [];
  readonly #inner = new SubprocessGitRunner();

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.#inner.run(argumentsValue, cwd);
    this.calls.push(`git ${argumentsValue.join(" ")} -> ${result.returncode}`);
    return result;
  }
}

// Make only `git worktree add` fail, and execute the other commands normally, to observe the retained evidence for reserved.
class FailingAddGitRunner implements GitRunner {
  readonly #inner = new SubprocessGitRunner();

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    if (argumentsValue[0] === "worktree" && argumentsValue[1] === "add") {
      return { returncode: 128, stdout: "", stderr: "fatal: injected failure" };
    }
    return await this.#inner.run(argumentsValue, cwd);
  }
}

// Make only `git status` report an error, to observe that the review reason does not leak the original stderr.
class FailingStatusGitRunner implements GitRunner {
  readonly #inner = new SubprocessGitRunner();

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    if (argumentsValue[0] === "status") {
      return { returncode: 128, stdout: "", stderr: "fatal: injected status failure" };
    }
    return await this.#inner.run(argumentsValue, cwd);
  }
}

// Replay model output from a script; it cares only about the order of tool calls, and it needs no real OpenAI.
class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #replies: ModelReply[];

  constructor(replies: readonly ModelReply[]) {
    this.#replies = [...replies];
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error("The scripted model received an unexpected request");
    return reply;
  }
}
```

Experiment 6 also needs `AgentRunner` and the file tools, so add a few more lines to the imports:

```typescript
import { NodeWorkspaceFileSystem } from "../chapters/ch18/src/adapters/filesystem.js";
import { AgentRunner } from "../chapters/ch18/src/core/loop.js";
import { assistantMessage, toolCall } from "../chapters/ch18/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch18/src/core/model.js";
import type { ToolContext } from "../chapters/ch18/src/core/tools.js";
import { ToolRegistry } from "../chapters/ch18/src/core/tools.js";
import { createChapterTwoTools } from "../chapters/ch18/src/features/builtin-tools.js";
import {
  canonicalIntegrationRef,
  registerWorktreeTools,
} from "../chapters/ch18/src/features/worktrees.js";
import {
  leasedTaskToolDefinitions,
  registerTeammateLeasedTaskTools,
} from "../chapters/ch18/src/features/work-stealing.js";
```

With these in place, each experiment is one `if (section("name")) { ... }` block. The run method is uniform:

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location $TutorialCode
npm exec -- tsx scripts/probe-ch18.mts <experiment name>
```

If you give no experiment name, all 11 run.

### Experiment 1: Walk through one complete isolation trace

The 18-step trace at the start of the article is the output of this experiment. Its core part:

```typescript
if (section("trace")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const a = await store.createTask({ subject: "Refactor the authentication module" });
    const b = await store.createTask({ subject: "Refactor the login page" });

    const alice = await worktrees.createWorktree({
      taskId: a.id, name: "alice", integrationRef: "refs/heads/main",
    });
    const bob = await worktrees.createWorktree({
      taskId: b.id, name: "bob", integrationRef: "refs/heads/main",
    });

    const aliceClaim = await worktrees.claimNext("alice");
    const bobClaim = await worktrees.claimNext("bob");
    if (aliceClaim === undefined || bobClaim === undefined) throw new Error("Both sides should claim successfully");

    // Use resolve() to obtain the directory each one should write to, and then write different content into files with the same name.
    const aliceContext = await worktrees.resolve(
      Object.freeze({ workspace: root, identity: "alice", claimToken: aliceClaim.claimToken }),
    );
    const bobContext = await worktrees.resolve(
      Object.freeze({ workspace: root, identity: "bob", claimToken: bobClaim.claimToken }),
    );
    await writeFile(join(aliceContext.workspace, "config.ts"), "// alice's version\n", "utf8");
    await writeFile(join(bobContext.workspace, "config.ts"), "// bob's version\n", "utf8");

    // alice commits and merges into main; bob only commits, and does not merge.
    await git(aliceContext.workspace, "add", "config.ts");
    await git(aliceContext.workspace, "commit", "-m", "alice: rework config");
    await git(root, "merge", "--ff-only", "wt/alice");
    await git(bobContext.workspace, "add", "config.ts");
    await git(bobContext.workspace, "commit", "-m", "bob: rework config");

    await store.completeTask(a.id, "alice", aliceClaim.claimToken);
    await store.completeTask(b.id, "bob", bobClaim.claimToken);

    // The same cleanup call, two different results.
    console.log(`remove alice → ${(await worktrees.removeWorktree(a.id)).status}`);
    const removedBob = await worktrees.removeWorktree(b.id);
    console.log(`remove bob   → ${removedBob.status} (${removedBob.reviewReason})`);
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts trace
```

**What to verify:** In steps 8–10, the three `config.ts` files have different contents from each other; in step 14, alice is deleted, and in step 15, bob lands in `needs_review`; the audit events in step 18 are strictly ordered by `sequence`, and bob's event carries a reason.

**Try changing the experiment:** Comment out the line `await git(root, "merge", "--ff-only", "wt/alice")` and run it again. Now both will land in `needs_review` — **the cleanup logic shows no favour to alice or bob. The difference comes only from the one fact of "was it merged in".**

### Experiment 2: A file lock cannot save this scenario

```typescript
if (section("lock")) {
  await withTempDir(async (root) => {
    // Group one: two people share the same directory, and writes queue strictly with a "lock".
    const shared = join(root, "shared");
    await mkdir(shared, { recursive: true });
    let held = false;
    const withLock = async (owner: string, work: () => Promise<void>): Promise<void> => {
      if (held) throw new Error("The lock is held concurrently; this will not happen here");
      held = true;
      console.log(`  ${owner} acquired the lock for config.ts`);
      await work();
      held = false;
      console.log(`  ${owner} released the lock`);
    };
    await withLock("alice", async () => {
      await writeFile(join(shared, "config.ts"), "// alice's version\n", "utf8");
    });
    await withLock("bob", async () => {
      await writeFile(join(shared, "config.ts"), "// bob's version\n", "utf8");
    });
    console.log(`Final content of the shared directory: ${JSON.stringify(await readFile(join(shared, "config.ts"), "utf8"))}`);

    // Group two: the same writes, landing in two Managed Worktrees.
    const repository = join(root, "repository");
    await mkdir(repository, { recursive: true });
    const { store, worktrees } = await components(repository);
    const a = await store.createTask({ subject: "alice's work" });
    const b = await store.createTask({ subject: "bob's work" });
    const aliceBinding = await worktrees.createWorktree({
      taskId: a.id, name: "alice", integrationRef: "refs/heads/main",
    });
    const bobBinding = await worktrees.createWorktree({
      taskId: b.id, name: "bob", integrationRef: "refs/heads/main",
    });
    await writeFile(join(repository, aliceBinding.relativePath, "config.ts"), "// alice's version\n", "utf8");
    await writeFile(join(repository, bobBinding.relativePath, "config.ts"), "// bob's version\n", "utf8");
    const commonDir = await git(join(repository, aliceBinding.relativePath), "rev-parse", "--git-common-dir");
    console.log(`The two worktrees share the same object store: ${JSON.stringify(commonDir.replace(repository.replaceAll("\\", "/"), "<root>"))}`);
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts lock
```

**What to verify:** That `if (held) throw` never triggers even once (the lock really was never held concurrently), but alice's content still disappears. In group two, three files have three contents, and `--git-common-dir` points back to the main repository's `.git`.

**Try changing the experiment:** Change the lock in group one to "queue and wait for the lock" instead of writing directly — you will find that no matter how you queue, the one who survives in the end is still the last person who wrote. **Serialisation solves "write it badly", not "write it away".**

### Experiment 3: The three state lines each go their own way

```typescript
if (section("state")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const task = await store.createTask({ subject: "Three state lines" });
    const line = async (label: string): Promise<void> => {
      const current = await store.getTask(task.id);
      let bindingText = "(no binding)";
      try {
        bindingText = (await worktrees.store.getWorktreeBinding(task.id)).status;
      } catch {
        bindingText = "(no binding)";
      }
      // The claim token exists only in a column in the tasks table; the Task domain object has no such field.
      const query = await readSqlite(store.databasePath);
      const raw = query("SELECT claim_token FROM tasks")[0]?.claim_token;
      const token = typeof raw === "string" ? `…${short(raw)}` : "null";
      console.log(
        `${label.padEnd(22, " ")} task=${current.status.padEnd(11, " ")} owner=${String(current.owner).padEnd(6, " ")} token=${token.padEnd(6, " ")} binding=${bindingText}`,
      );
    };
    await line("After createTask");
    await worktrees.createWorktree({ taskId: task.id, name: "alice", integrationRef: "refs/heads/main" });
    await line("After createWorktree");
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("The claim should succeed");
    await line("After claimNext");
    await store.completeTask(task.id, "alice", claim.claimToken);
    await line("After completeTask");
    await worktrees.keepWorktree(task.id);
    await line("After keepWorktree");

    const query = await readSqlite(store.databasePath);
    console.log(`\nThe tasks table has no worktree field: ${query("SELECT * FROM tasks").map((row) => Object.keys(row).join(", "))}`);
    console.log(`The binding is an independent table: ${query("SELECT * FROM worktree_bindings").map((row) => Object.keys(row).join(", "))}`);
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts state
```

**What to verify:** In the line `After createWorktree`, the task is still `pending`, and the owner is still `null` — **creating a Worktree does not advance a task.** The last two lines confirm that the `tasks` table has no worktree column at all.

**Try changing the experiment:** Replace `keepWorktree` with `removeWorktree`, and print one more line. You will see the task stay at `completed` without moving, and only the binding move from `active` to `removed`. **The end points of the two lines are different.**

### Experiment 4: The evidence `reserved` leaves when Git fails

```typescript
if (section("reserve")) {
  await withTempDir(async (root) => {
    await gitRepository(root);
    const clock = new Clock();
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1841), claimTokenGenerator: seqId(0x1851), clock,
    });
    // Only `git worktree add` will fail; the other Git commands are real.
    const worktrees = new WorktreeRuntime({
      workspace: root, store, gitRunner: new FailingAddGitRunner(), clock: () => clock.now(),
    });
    await worktrees.validateRepository();
    const task = await store.createTask({ subject: "git add will fail" });
    try {
      await worktrees.createWorktree({
        taskId: task.id, name: "alice", integrationRef: "refs/heads/main",
      });
      console.log("It should not reach here");
    } catch (error) {
      console.log(`createWorktree throws: ${errorLine(error)}`);
    }
    const binding = await store.getWorktreeBinding(task.id);
    console.log(`The binding status is still: ${binding.status} (branch_tip=${String(binding.branchTip)})`);
    console.log(`The Task status is still:  ${(await store.getTask(task.id)).status}`);
    console.log(
      `Audit events: ${(await store.listWorktreeEvents()).map((event) => `#${event.sequence} ${event.action}->${event.status}`).join(" ")}`,
    );
    console.log(`Will auto-claim pick it up: ${String(await worktrees.claimNext("alice"))} (reserved is not active)`);
    const branches = await git(root, "branch", "--format=%(refname:short)");
    console.log(`Git branches: ${branches.split("\n").join(" ")} (no half wt/alice is left behind)`);
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts reserve
```

**What to verify:** The binding stays at `reserved` and `branch_tip=null`; the task is still `pending`; the audit table has only one event, `#1 reserve->reserved` (there is no `create`); `claimNext` returns `undefined`; `git branch` contains only `main`. **One `reserved` record + clean Git is much better than "no record + one orphan branch".**

**Try changing the experiment:** Change the command intercepted in `FailingAddGitRunner` to `rev-parse`, so that baseline resolution fails. This time, there will not even be a binding — because `reserveWorktree` comes after resolution… Go and look at the code order, and verify whether your guess is correct.

### Experiment 5: The audit table is append-only

```typescript
if (section("audit")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const task = await store.createTask({ subject: "Audit and state in the same transaction" });
    await worktrees.createWorktree({ taskId: task.id, name: "alice", integrationRef: "refs/heads/main" });
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("The claim should succeed");
    await store.completeTask(task.id, "alice", claim.claimToken);
    await worktrees.keepWorktree(task.id);

    const events = await store.listWorktreeEvents();
    console.log("worktree_events (append-only):");
    for (const event of events) {
      console.log(
        `  #${event.sequence} ${event.action.padEnd(13, " ")} status=${event.status.padEnd(12, " ")} branch_tip=${event.branchTip === null ? "null" : event.branchTip.slice(0, 7)} at=${event.createdAtUtc.toISOString()}`,
      );
    }

    // Bypass the runtime and act on SQLite directly: the two triggers will block it.
    const query = await readSqlite(store.databasePath);
    for (const sql of [
      "UPDATE worktree_events SET action = 'remove' WHERE sequence = 1",
      "DELETE FROM worktree_events WHERE sequence = 1",
    ]) {
      try {
        query(sql);
        console.log(`${sql} → It actually succeeded`);
      } catch (error) {
        console.log(`${sql}\n  → ${errorLine(error)}`);
      }
    }
    console.log(`\nThe CHECK constraint also blocks an illegal combination. Try to write a needs_review by hand without giving a reason:`);
    try {
      query("UPDATE worktree_bindings SET status = 'needs_review', review_reason = NULL WHERE name = 'alice'");
      console.log("  → It actually succeeded");
    } catch (error) {
      console.log(`  → ${errorLine(error)}`);
    }
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts audit
```

**What to verify:** Three events, `reserve → create → keep`; both `UPDATE` and `DELETE` are rejected by a trigger, and they report `worktree_events is append-only`; a hand-written illegal combination is rejected by the CHECK constraint.

**Try changing the experiment:** Try to insert a fake event by hand with `INSERT INTO worktree_events`. **It will succeed.** The triggers block only UPDATE and DELETE. They do not block INSERT — this is deliberate. The definition of append-only is "you can only append". Preventing forgery needs other means (for example, a hash chain). That is outside the scope of this chapter.

### Experiment 6: Claim and then write a file in the same reply

This experiment uses `ScriptedModel` to replay one real two-tool reply, and to see what `resolve()` calculated before each call:

```typescript
if (section("routing")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const task = await store.createTask({ subject: "Claim and then write a file in the same reply" });
    const binding = await worktrees.createWorktree({
      taskId: task.id, name: "alice", integrationRef: "refs/heads/main",
    });

    const tools = createChapterTwoTools(
      { run: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false }) },
      new NodeWorkspaceFileSystem(),
    );
    registerTeammateLeasedTaskTools(tools, store, worktrees);
    registerWorktreeTools(tools, worktrees);

    // Two tool calls in one reply: first claim_task, then write_file.
    const seen: string[] = [];
    const model = new ScriptedModel([
      {
        message: assistantMessage(null, [
          toolCall("c1", "claim_task", JSON.stringify({ task_id: task.id })),
          toolCall("w1", "write_file", JSON.stringify({ path: "config.ts", content: "// alice\n" })),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model, tools, systemPrompt: "probe", workspace: root, identity: "alice",
      // Wrap it in one layer, and record the cwd resolved each time.
      toolContextProvider: {
        workspaceRoot: root,
        resolve: async (context: ToolContext) => {
          const resolved = await worktrees.resolve(context);
          seen.push(resolved.workspace.replace(root, "<root>"));
          return resolved;
        },
      },
    });

    const result = await runner.run("claim then write");
    console.log(`The cwd resolved for the two tool calls:\n  claim_task → ${seen[0]}\n  write_file → ${seen[1]}`);
    console.log(`config.ts in the worktree: ${JSON.stringify(await readFile(join(root, binding.relativePath, "config.ts"), "utf8"))}`);
    console.log(`config.ts in the main directory: ${JSON.stringify(await readFile(join(root, "config.ts"), "utf8"))}`);
    await runner.close();
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts routing
```

**What to verify:** `claim_task` resolves to `<root>` (there was no claim at that time), and `write_file` resolves to `<root>\.agent_tutorial\worktrees\alice`. The file really lands in the Worktree, and `config.ts` in the main directory is still `export const value = 0;`.

**Try changing the experiment:** Swap the order of the two tool calls (first `write_file`, then `claim_task`). The write will land in the main directory — because at that moment there really was no claim yet. **This is not a bug. It is the inevitable result of "resolve from the real state at the moment of the call".**

### Experiment 7: Nine claim cases, only one is let through

```typescript
if (section("failclosed")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const bound = await store.createTask({ subject: "Bound" });
    await worktrees.createWorktree({ taskId: bound.id, name: "alice", integrationRef: "refs/heads/main" });
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("The claim should succeed");

    const attempt = async (
      label: string,
      context: Partial<ToolContext> & { readonly identity: string },
    ): Promise<void> => {
      try {
        const resolved = await worktrees.resolve(
          Object.freeze({ workspace: root, ...context }) as ToolContext,
        );
        console.log(`${label.padEnd(26, " ")} → ${resolved.workspace.replace(root, "<root>")}`);
      } catch (error) {
        console.log(`${label.padEnd(26, " ")} → ${errorLine(error)}`);
      }
    };

    await attempt("Correct identity + token", { identity: "alice", claimToken: claim.claimToken });
    await attempt("Wrong identity", { identity: "bob", claimToken: claim.claimToken });
    await attempt("Wrong task_id", {
      identity: "alice", taskId: "00000000-0000-4000-8000-000000009999", claimToken: claim.claimToken,
    });
    await attempt("Token that was never generated", {
      identity: "alice", claimToken: "00000000-0000-4000-8000-000000009999",
    });
    await attempt("Token with a wrong format", { identity: "alice", claimToken: "not-a-token" });
    await attempt("Wrong worktree name", {
      identity: "alice", claimToken: claim.claimToken, worktreeName: "bob",
    });
    await attempt("No claim at all", { identity: "alice" });
    await attempt("Only task_id, no token", { identity: "alice", taskId: bound.id });

    // After the task completes, the old token is no longer a valid routing credential.
    await store.completeTask(bound.id, "alice", claim.claimToken);
    await attempt("Old token used after completion", { identity: "alice", claimToken: claim.claimToken });
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts failclosed
```

**What to verify:** In nine lines, only the first line returns a Worktree path, the seventh line (no claim at all) returns `<root>`, and the other seven lines are all errors. Look especially at "old token used after completion" — after completion, the token becomes invalid immediately.

**Try changing the experiment:** Change the identity in `attempt("Wrong identity", ...)` from `"bob"` to `"Alice"` (capital A). It will still fail, because the owner comparison is an exact string comparison. **A case-insensitive identity judgement is a classic class of vulnerability. No back door is opened here.**

### Experiment 8: Auto-claim touches only bound tasks

```typescript
if (section("auto")) {
  await withTempDir(async (root) => {
    const { store, worktrees, workStealing } = await components(root);
    // The unbound task is created first, so it comes first on the task board.
    const unbound = await store.createTask({ subject: "Task with no worktree" });
    const bound = await store.createTask({ subject: "Task with a worktree" });
    await worktrees.createWorktree({ taskId: bound.id, name: "alice", integrationRef: "refs/heads/main" });
    console.log(`Task board order: ${(await store.listTasks()).map((task) => `${task.subject}(${task.status})`).join(" / ")}`);
    const first = await workStealing.claimNext("alice");
    console.log(`  First claimNext → ${first === undefined ? "undefined" : first.task.subject}`);
    console.log(`  Unbound task status → ${(await store.getTask(unbound.id)).status}`);
    const second = await workStealing.claimNext("bob");
    console.log(`  Second claimNext (bob) → ${String(second)} (there is no second active binding)`);
    if (first !== undefined) {
      console.log(`\nThe auto-claim prompt looks like this:\n${workStealing.renderClaimPrompt(first)}`);
    }
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts auto
```

**What to verify:** The unbound task that comes first is skipped, and its status stays at `pending`; the second claim returns `undefined`.

**Try changing the experiment:** Also create a Worktree called `bob` for `unbound`, and run it again. Both claims will succeed, and each will take one task. **Once the rule "work only if there is territory" is satisfied, work stealing returns to the form it had in Chapter 17.**

### Experiment 9: The three-side tool surface and the wire format

```typescript
if (section("tools")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const names = (registry: ToolRegistry): string => registry.names.join(", ");

    const lead = createChapterTwoTools(
      { run: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false }) },
      new NodeWorkspaceFileSystem(),
    );
    for (const definition of leasedTaskToolDefinitions(store, worktrees)) lead.register(definition);
    registerWorktreeTools(lead, worktrees);
    console.log(`Lead:     ${names(lead)}`);

    const teammate = createChapterTwoTools(
      { run: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false }) },
      new NodeWorkspaceFileSystem(),
    );
    registerTeammateLeasedTaskTools(teammate, store, worktrees);
    console.log(`Teammate: ${names(teammate)}`);

    console.log(`\nEffect classification of the three Worktree tools:`);
    for (const definition of worktrees.leadToolDefinitions) {
      console.log(`  ${definition.name.padEnd(16, " ")} effect=${definition.effect}`);
    }
    console.log(`\nDoes the Lead have create_task:        ${lead.names.includes("create_task")}`);
    console.log(`Does a Teammate have create_task:    ${teammate.names.includes("create_task")}`);
    console.log(`Does a Teammate have create_worktree: ${teammate.names.includes("create_worktree")}`);

    // The return value the model really sees: the wire format of create_worktree.
    const task = await store.createTask({ subject: "Look at the JSON the tool returns" });
    const [create] = worktrees.leadToolDefinitions;
    const result = await create.handler(
      { task_id: task.id, name: "alice", integration_ref: "refs/heads/main" },
      Object.freeze({ workspace: root, identity: "lead" }),
    );
    console.log(`\nContent returned by create_worktree to the model (isError=${result.isError}):`);
    console.log(JSON.stringify(JSON.parse(result.content), null, 2).replace(/^/gmu, "  "));

    // Create again with the same name: the unique constraint blocks it at the SQLite layer, and the tool returns a structured error instead of throwing an exception.
    const duplicate = await store.createTask({ subject: "Duplicate name" });
    const conflict = await create.handler(
      { task_id: duplicate.id, name: "alice", integration_ref: "refs/heads/main" },
      Object.freeze({ workspace: root, identity: "lead" }),
    );
    console.log(`\nCreate again with the same name → isError=${conflict.isError} errorCode=${String(conflict.errorCode)}`);
    console.log(`  ${conflict.content}`);
  });
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts tools
```

**What to verify:** The difference between the two sides is exactly `create_task` plus the three Worktree tools; the three effect classifications match the table earlier; in the JSON, `branch_tip === baseline_commit`; a duplicate name returns `isError=true` instead of throwing.

**Try changing the experiment:** Change the `name` in the duplicate-name call to `"bob"`, but keep `task_id` unchanged (still the first task). It will still fail — because there is a PRIMARY KEY on `task_id`. **Each of the four unique constraints blocks one class of conflict. Whichever one you change, you cannot evade them.**

### Experiment 10: The ten cleanup commands and the three failure paths

The output of this experiment was already shown earlier. Its code structure is "one success scenario + a loop over three scenarios":

```typescript
if (section("cleanup")) {
  // Scenario 1: the commit in the worktree has been merged into main, so the cleanup chain should run to completion and leave removed.
  await withTempDir(async (root) => {
    await gitRepository(root);
    const clock = new Clock();
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1801), claimTokenGenerator: seqId(0x1811), clock, leaseDurationMs: 60_000,
    });
    const recorder = new RecordingGitRunner();
    const worktrees = new WorktreeRuntime({
      workspace: root, store, gitRunner: recorder, clock: () => clock.now(),
    });
    await worktrees.validateRepository();
    const task = await store.createTask({ subject: "Merged; it can be deleted" });
    const binding = await worktrees.createWorktree({
      taskId: task.id, name: "alice", integrationRef: "refs/heads/main",
    });
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("The claim should succeed");
    const worktreePath = join(root, binding.relativePath);
    await writeFile(join(worktreePath, "config.ts"), "export const value = 1;\n", "utf8");
    await git(worktreePath, "commit", "-am", "alice: bump value");
    const aliceTip = await git(worktreePath, "rev-parse", "HEAD");
    await git(root, "merge", "--ff-only", binding.branch);
    await store.completeTask(task.id, "alice", claim.claimToken);

    // Record only the commands in the cleanup stage; the preparation work before it does not count.
    recorder.calls.length = 0;
    const removed = await worktrees.removeWorktree(task.id);
    for (const call of recorder.calls) console.log(`  ${call}`);
    console.log(`branch_tip matches the last commit on the alice branch: ${removed.branchTip === aliceTip}`);
    console.log(`Is alice's commit still on main: ${JSON.stringify(await readFile(join(root, "config.ts"), "utf8"))}`);
  });
```

The three failure paths run with the same code. They change only three boolean switches:

```typescript
  // Scenario 2: not merged / dirty changes / git status reports an error; all three must land in needs_review.
  const scenarios = [
    { label: "There are uncommitted changes", dirty: true, merge: true, failStatus: false },
    { label: "Not merged into main", dirty: false, merge: false, failStatus: false },
    { label: "git status itself reports an error", dirty: false, merge: true, failStatus: true },
  ] as const;
  for (const scenario of scenarios) {
    await withTempDir(async (root) => {
      // …… The same assembly; only gitRunner is replaced with FailingStatusGitRunner
      const worktrees = new WorktreeRuntime({
        workspace: root, store,
        gitRunner: scenario.failStatus ? new FailingStatusGitRunner() : new SubprocessGitRunner(),
        clock: () => clock.now(),
      });
      // …… Create the task, create the worktree, claim, write the file
      if (!scenario.dirty) await git(worktreePath, "commit", "-am", "alice: bump value");
      if (scenario.merge && !scenario.dirty) await git(root, "merge", "--ff-only", binding.branch);
      await store.completeTask(task.id, "alice", claim.claimToken);

      const result = await worktrees.removeWorktree(task.id);
      console.log(`\n${scenario.label} → status=${result.status}`);
      console.log(`  review_reason: ${String(result.reviewReason)}`);
      console.log(`  Directory still exists: ${(await git(root, "worktree", "list", "--porcelain")).includes(binding.relativePath.replaceAll("\\", "/"))}`);
      console.log(`  Branch still exists: ${(await git(root, "branch", "--list", binding.branch)).length > 0}`);
    });
  }
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts cleanup
```

**What to verify:** None of the ten commands on the success path carries `--force` or `-D`; the reasons on the three failure paths are all different, and the directory and the branch are both still there.

**Try changing the experiment:** In scenario 1, change `git merge --ff-only` to `git merge --squash` and then `git commit`. The cleanup will land in `needs_review` — a squash produces a new commit, and the original commit is not an ancestor of `main`. **This is a false alarm caused by a conservative judgement. You now know why it appears, and you know how to handle it (confirm it manually, and then clean it up by hand).**

### Experiment 11: Non-Git directory and ref validation

```typescript
if (section("guard")) {
  // Non-Git directory: it must fail before state creation, and it must not leave a binding.
  await withTempDir(async (root) => {
    const plain = join(root, "not-a-repo");
    await mkdir(plain, { recursive: true });
    const store = new SqliteTaskStore(plain, { idGenerator: seqId(0x1801) });
    const worktrees = new WorktreeRuntime({
      workspace: plain, store, gitRunner: new SubprocessGitRunner(),
    });
    try {
      await worktrees.validateRepository();
      console.log("Non-Git directory → It actually passed");
    } catch (error) {
      console.log(`Non-Git directory → ${errorLine(error)}`);
    }
    const task = await store.createTask({ subject: "Create a worktree in a non-repository" });
    try {
      await worktrees.createWorktree({
        taskId: task.id, name: "alice", integrationRef: "refs/heads/main",
      });
      console.log("createWorktree → It actually passed");
    } catch (error) {
      console.log(`createWorktree → ${errorLine(error)}`);
    }
    const query = await readSqlite(store.databasePath);
    console.log(`Number of worktree_bindings rows: ${String(query("SELECT COUNT(*) AS n FROM worktree_bindings")[0]?.["n"])}`);
    console.log(`Number of worktree_events rows:  ${String(query("SELECT COUNT(*) AS n FROM worktree_events")[0]?.["n"])}`);

    // A subdirectory is also not allowed: workspace must be exactly the repository root.
    await gitRepository(root);
    const nested = join(root, "src");
    await mkdir(nested, { recursive: true });
    const nestedRuntime = new WorktreeRuntime({
      workspace: nested,
      store: new SqliteTaskStore(nested, { idGenerator: seqId(0x1801) }),
      gitRunner: new SubprocessGitRunner(),
    });
    try {
      await nestedRuntime.validateRepository();
      console.log(`Repository subdirectory → It actually passed`);
    } catch (error) {
      console.log(`Repository subdirectory → ${errorLine(error)}`);
    }
  });

  // Nine candidate refs; see which ones pass and which ones are rejected.
  console.log(`\nInput validation in canonicalIntegrationRef:`);
  for (const candidate of [
    "refs/heads/main", "refs/remotes/origin/main", "main", "HEAD",
    "refs/heads/../../etc/passwd", "refs/heads/main@{1}", "refs/heads/feature branch",
    "refs/heads/main/", " refs/heads/main",
  ]) {
    try {
      console.log(`  ${JSON.stringify(candidate).padEnd(34, " ")} → ${canonicalIntegrationRef(candidate)}`);
    } catch (error) {
      console.log(`  ${JSON.stringify(candidate).padEnd(34, " ")} → ${errorLine(error)}`);
    }
  }
}
```

```powershell
npm exec -- tsx scripts/probe-ch18.mts guard
```

**What to verify:** All four failure points report `WorktreeRepositoryError`; both `worktree_bindings` and `worktree_events` have 0 rows; of the nine refs, only the first two pass.

**Try changing the experiment:** Try `"refs/tags/v1.0"`. It will pass validation (the prefix is legal, and the characters are legal), but if this tag does not exist, `git rev-parse --verify` will fail. **Format validation and existence validation are two independent gates, and this chapter sets both.**

### Clean up after the experiments

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Remove-Item "$TutorialCode\scripts\probe-ch18.mts"
```

The temporary directories used by the experiments are deleted by the `finally` block in `withTempDir`. No manual cleanup is needed. If an experiment is interrupted with Ctrl+C in the middle, a residue may remain:

```powershell
Get-ChildItem $env:TEMP -Directory -Filter 'probe-ch18-*'
```

Look once to confirm that there is nothing you want to keep, and then delete it.

---

## What this chapter deliberately did not do

List them clearly, and you will not search everywhere for these things when you read the code.

**It did not put a worktree field into the Task.** There is no `tasks.worktree` column, no JSON blob, and no compatibility layer. The last two lines of Experiment 3 verified this.

**There is no process-level cwd switch.** There is no `process.chdir()`, no thread-local `wt_ctx` dictionary, and no instruction for the model to `cd` manually in the prompt. The working directory is resolved per call only through `ToolContextProvider.resolve()`.

**There is no "fall back to the main directory if unbound".** A claim is declared but the claim is invalid → an error. This is the nine-line output in Experiment 7. The only case that falls back to the main directory is **no claim is declared at all** — that is the Lead's normal state.

**There is no `@{push}`, no `git branch -D`, and no `git worktree remove --force`.** None of them. The ten commands recorded in Experiment 10 can be checked one by one.

**There is no automatic merge, cherry-pick, push, or conflict resolution.** The runtime does only isolation and proof. "How is the code merged" is a person's decision, not the runtime's decision.

**There is no cross-system exactly-once between Git and SQLite.** This cannot be done, and it does not pretend to do it. The method is to order the sequence well (record the intent first, then produce the side effect), so that every failure leaves recoverable evidence.

**There is no background sweep task.** There is no "delete automatically after N days". Deletion is started explicitly only by the Lead. A Worktree that ran for half a day with nobody managing it will stay there — **this is much better than "one morning you find that the changes are gone".**

**There is no lease renewal, and no heartbeat.** This is the boundary from Chapter 17, and this chapter did not change it.

**There is no MCP dynamic tool discovery.** The tool surface is written dead in the composition root. Which tools the Lead has more than a Teammate is decided at startup. This is the content of Chapter 19.

**Symlink defence has code, but its test coverage is limited.** `#registeredWorktreePath` uses `realpath` to resolve the path and then compares it with the expected path. It can block a case where the path is replaced by a symlink. But on Windows, a normal user needs extra permission to create a symlink, so the tests contain no real symlink scenario. **This defence code is real, but you cannot say that it has been verified.**

These non-goals are part of this chapter's boundary. The minimal closed loop Chapter 18 must hold has only four phrases: **directory isolation, per-call routing, fail on invalid claim, proof-based cleanup.**

---

## Differences from Claude Code

Distinguishing these two classes of difference, "we simplified it" and "we are stricter than it", is very helpful for understanding the trade-offs.

### Where we simplified

**Isolation depends on resolve; it depends on chdir.** Claude Code's `EnterWorktree` uses `process.chdir()` to switch the session-level process directory; the worktree isolation in `AgentTool` wraps a subagent with `cwdOverridePath`. We do not move the process cwd. We only resolve it before every tool call. The cost is that every tool handler must honestly use `context.workspace` instead of `process.cwd()` — this is a convention, not a compile-time guarantee.

**There is no runtime lock.** CC runs `git worktree lock` while an agent runs, to prevent another process from deleting a Worktree that is in use. We did not do this. When multiple Agent processes operate on the same repository at the same time, this is a real gap.

**There is no sweep cycle.** CC has `cleanupPeriodDays`. It automatically cleans up temporary worktrees that have no changes or have no unpushed commits. We have only explicit deletion.

**The relation between a Worktree and a session is simpler.** CC uses `PersistedWorktreeSession` to associate a worktree with a transcript, and the session contains no `taskId`. We use one `worktree_bindings` table and associate through `task_id`. The relation is more direct, but it is also more rigid — one task, one Worktree; one Worktree cannot run multiple tasks.

**The baseline source is more rigid.** CC's `git worktree add -B` is based on `origin/<defaultBranch>` by default, and it automatically picks the default branch. We require the caller to give an explicit `integration_ref`, and it must be `refs/heads/*` or `refs/remotes/*`. Less convenience, more certainty.

### Where we are stricter than the teaching version

**Cleanup has no force escape hatch.** CC's remove checks for uncommitted changes, but it allows `discard_changes=true` to bypass them. We have no such argument. All eight proofs must pass before deletion. Otherwise, it is `needs_review`.

**Claiming and Worktrees are bound together.** The CC teaching version uses a `wt_ctx["path"]` dictionary to switch the cwd. Real CC has no claim routing with a task-worktree binding. We let manual `claim_task`, automatic `claim_next`, and `complete_task` share the same `TaskClaimService`, and a claim must have an active binding.

**A claim in the same reply can take effect immediately.** `executionScope` + WeakMap lets "claim, and then immediately write a file" land in the correct directory (Experiment 6). This is not a CC mechanism. This chapter added it to make "finish one thing in one reply" feasible.

**The audit is enforced by the database.** `worktree_events` has triggers that block UPDATE and DELETE, and `needs_review` and `review_reason` have a two-way CHECK constraint. CC's worktree state is written in a transcript, and it is maintained by a code convention.

**The baseline is an immutable commit.** `git rev-parse --verify <ref>^{commit}` first resolves a ref to a 40-character hex value, and only then creates the Worktree. This avoids "the ref was changed by someone between two reads".

In one sentence: **real CC source code is more complete than ours, and the CC teaching version is looser than ours. We chose "the smallest strict set that can be asserted in offline tests".**

---

## What we learn from ai-agent-book: file system isolation and proof-based cleanup

Chapter 10 of ai-agent-book divides shared file system conflicts into two classes: **file-level write conflicts** (two people change the same file) and **cross-file semantic conflicts** (each person changes their own files, but the combination does not work). Its conclusion is: an optimistic lock can handle only the first class; when Coding Agents change a code base in parallel, the mainstream method is to give each Agent an independent branch or Worktree, and to postpone the conflict to the merge point.

This chapter takes exactly the second path. It does not add a per-file version number to `write_file`. Instead, it lets a claim bind a Managed Worktree — outside "who owns the task", it builds one more boundary: "where does this tool write".

Its [Experiment 10-4](https://github.com/bojieli/ai-agent-book/blob/main/chapter10/parallel-web-research/README.md) also shows the convergence method for homogeneous workers: each worker has an independent Playwright Chromium context; the first `target_found` settles only once under an `asyncio.Lock`, and it broadcasts `terminate` only once; a losing worker cancels at a safe point, acks, and closes its resources. The acceptance manifest audits the context creation/closure counts, the ack set, and the measured time.

This chapter translates those four rules, "independent resources, single settlement, cleanup at a safe point, evidence audit", onto the file system:

| Design in ai-agent-book | Method in this chapter | Why this choice |
| --- | --- | --- |
| It divides conflicts into file-level writes and cross-file semantics | A claim does not solve a file overwrite; an active binding routes each task to an independent Worktree, and a semantic conflict is left to merge/review | The two classes of conflict need two mechanisms; if you mix them, neither side is thorough |
| An optimistic lock protects only the version consistency of the same file | A SQLite lock protects only claims and state transitions; file isolation covers the whole Managed directory, and it uses no per-file version number | A per-file version number is meaningless in front of a refactoring that "changed 40 files" |
| Each worker has an independent browser context | Each active claim has an independent Git Worktree + a cwd resolved per call | Resource isolation is easier to prove correct than resource sharing + locking |
| The first success settles once under a lock | `BEGIN IMMEDIATE` + conditional UPDATE + token history; one claim/completion succeeds only once | It reuses the technique already verified in Chapter 17, and it does not start a new set |
| After terminate, wait for a safe-point ack and resource closure | Before remove, prove completed / registered / clean / integrated in order; on failure, move to `needs_review` | "Clean up" and "confirm that it can be cleaned up" are two different things |
| A failure on one website does not affect other workers | One dirty or unintegrated Worktree does not block other bindings; it is retained independently for review | A failure must be localised; one pending review must not drag down the whole pipeline |
| A manifest audits context creation/closure and measured time | Real temporary Git repository tests + an append-only event table | Asserting "what happened" is more useful than asserting "no error was reported" |
| Parallel search needs cascading termination | It does not broadcast terminate; deletion is started explicitly only by the Lead | The cost of an automatic sweep deleting unintegrated changes by mistake is too high |

The last line is the only directional difference between this chapter and ai-agent-book. In parallel search, "when you find the answer, stop the others" is correct, because the intermediate results of the other workers have no value. But in parallel code changes, each Agent's intermediate result is a work product — **it is better to leave a pile of directories waiting for review than to automatically delete anyone's work.**

---

## Changes from the previous version

| Dimension | Chapter 17 | Chapter 18 |
| --- | --- | --- |
| Task ownership | SQLite claim token + half-open lease | Fully retained, unchanged |
| File directory | All executors share the main workspace | An active claim routes to a Managed Worktree |
| Task schema | Task DAG + token history | **Does not add** a worktree field |
| New persistent state | Task, dependency, token history | Adds `worktree_bindings` + append-only `worktree_events` |
| Auto-claim | All ready Tasks | Claims only ready Tasks with an active binding |
| Tool context | Fixed workspace | Resolves a trusted cwd again before every call |
| Lead tool surface | No Worktree management tools | Exactly three more: `create_worktree` / `keep_worktree` / `remove_worktree` |
| Cleanup proof | Not applicable | completed + registered + clean + explicitly integrated |

The actual code difference (`diff chapters/ch17/src chapters/ch18/src`):

| File | Change | Content |
| --- | --- | --- |
| `features/worktrees.ts` | New, 979 lines | All the core logic in this chapter |
| `adapters/git.ts` | New, 74 lines | Git child process adapter layer |
| `chapters/ch18.ts` | New, 5 lines | Fixed entry point |
| `adapters/task-sqlite.ts` | Changed, 530 lines | Two new tables, DDL, triggers, five transition methods, `claimNextBound` |
| `core/loop.ts` | Changed, 136 lines | `ToolContextProvider`, `executionScope`, `#resolveToolContext` |
| `features/teammates.ts` | Changed, 62 lines | Passes `claimToken` into the Runner |
| `bootstrap.ts` | Changed, 57 lines | Three reference-equality validations + three tool registrations |
| `cli.ts` | Changed, 46 lines | Assembles `WorktreeRuntime`, calls `validateRepository()` first |
| `core/tools.ts` | Changed, 39 lines | `ToolContext` gains four optional fields |
| `core/profiles.ts` | Changed, 31 lines | `worktree` capability + `P18` |
| `features/subagents.ts` | Changed, 25 lines | Passes through `toolContextProvider` and `claimToken` |

The Task DAG, Mailbox, typed Protocol, plan gate, permissions, Hooks, background tasks, and recovery logic do not start a new implementation. This chapter only connects "who can execute a task" and "where should this tool execute" to the same boundary.

Among them, those 25 lines in `features/subagents.ts` deserve a separate mention:

```typescript
const result =
  context.claimToken === undefined
    ? await runner.run(input.description)
    : await runner.run(input.description, {
        idempotencyKey: context.claimToken,
        claimToken: context.claimToken,
      });
```

**A Subagent inherits the parent's claim token.** A teammate claimed a task, and while it works in a Worktree, it delegates to a Subagent — that Subagent should write in the same Worktree, not in the main directory. This code is what guarantees this.

---

## Companion code index

The source code for this chapter is in `F:\笔记\Agent实操\code\chapters\ch18\`.

### New in this chapter

| File | Lines | Responsibility |
| --- | --- | --- |
| [src/features/worktrees.ts](code/chapters/ch18/src/features/worktrees.ts) | 979 | Domain objects, state enums, schema validation, `WorktreeRuntime` (claim service + context provider), three tool definitions |
| [src/adapters/git.ts](code/chapters/ch18/src/adapters/git.ts) | 74 | `SubprocessGitRunner`: `execFile` + argv array + timeout + three-category errors |
| [src/chapters/ch18.ts](code/chapters/ch18/src/chapters/ch18.ts) | 5 | Chapter entry point with a fixed P18 profile |

### Changed in this chapter

| File | Lines | Part related to this chapter |
| --- | --- | --- |
| [src/adapters/task-sqlite.ts](code/chapters/ch18/src/adapters/task-sqlite.ts) | 1182 | `worktree_bindings` / `worktree_events` DDL and triggers (738-781), `reserveWorktree`, four transition methods, `#transitionWorktree`, `claimNextBound`, `lookupClaim` |
| [src/core/loop.ts](code/chapters/ch18/src/core/loop.ts) | 789 | `ToolContextProvider` interface, per-turn `executionScope` (~355), `#executeTool` order (528-570), `#resolveToolContext` (621-644) |
| [src/core/tools.ts](code/chapters/ch18/src/core/tools.ts) | 269 | The four optional fields in `ToolContext`: `taskId` / `claimToken` / `worktreeName` / `executionScope` |
| [src/features/work-stealing.ts](code/chapters/ch18/src/features/work-stealing.ts) | 417 | `claimService.store === store` validation, `renderClaimPrompt`, Teammate tool registration |
| [src/features/teammates.ts](code/chapters/ch18/src/features/teammates.ts) | 928 | After auto-claim, the `claimToken` is used as both an idempotency key and a routing credential |
| [src/features/subagents.ts](code/chapters/ch18/src/features/subagents.ts) | — | Passes through `toolContextProvider`, and inherits the parent `claimToken` |
| [src/bootstrap.ts](code/chapters/ch18/src/bootstrap.ts) | 476 | Three reference-equality validations (106-123), Lead/Teammate/Subagent three-side tool registration |
| [src/cli.ts](code/chapters/ch18/src/cli.ts) | 366 | `execute()` assembly order (127-224), two classes of wakeup binding, `validateRepository()` before state creation |
| [src/core/profiles.ts](code/chapters/ch18/src/core/profiles.ts) | 326 | `worktree` capability, `P18` |

### Tests

| File | Lines | What it covers |
| --- | --- | --- |
| [tests/ch18-worktrees.test.ts](code/chapters/ch18/tests/ch18-worktrees.test.ts) | 481 | Real temporary Git repositories: isolation, reservation retention, eight cleanup proofs, append-only audit, non-Git rejection |
| [tests/ch18-bootstrap.test.ts](code/chapters/ch18/tests/ch18-bootstrap.test.ts) | 391 | Three-side tool surface, reference-equality validation, provider injection |
| [tests/ch18-loop-workspace.test.ts](code/chapters/ch18/tests/ch18-loop-workspace.test.ts) | 218 | Provider resolution order, an escape becomes a `tool_context_error`, `executionScope` lifecycle |
| [tests/ch18-claim-routing.test.ts](code/chapters/ch18/tests/ch18-claim-routing.test.ts) | 201 | Same-reply claim→write, cross-reply token recovery, invalid claim failure |
| [tests/ch18-entry.test.ts](code/chapters/ch18/tests/ch18-entry.test.ts) | 53 | Arguments and exit codes for the two entry points |

### Suggested order for reading the code

```text
1. src/features/worktrees.ts   First look at the enums and domain objects (about the first 200 lines)
        │                       —— Understand the five states: reserved/active/kept/needs_review/removed
        ▼
2. createWorktree in the same file  The five-step flow; note that reserve is before Git
        │
        ▼
3. resolve in the same file     The five checks; note that every check failure is a throw
        │
        ▼
4. removeWorktree in the same file  The eight proofs; note that every failure moves to needs_review
        │
        ▼
5. src/adapters/task-sqlite.ts  Jump to line 738 and look at the DDL, then look at #transitionWorktree
        │                       —— The constraints are in the database, not in the application layer
        ▼
6. src/core/loop.ts             #executeTool at 528-570; look at where resolve sits
        │
        ▼
7. src/cli.ts + src/bootstrap.ts  Look at the assembly last, and understand why instances must be shared
```

**First read the state machine, then read the flows, and read the assembly last.** If you read it in reverse, you will keep asking "what does this state mean".

---

## Run and verification

In `F:\笔记\Agent实操\code`, run the five gates in order:

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location $TutorialCode
npm run test:ch18
npm run typecheck
npm run lint
npm run format:check
npm run build
```

`npm run test:ch18` will run all the tests from Chapter 1 to Chapter 18 (not only those in ch18), because it must confirm that the new capability did not break any earlier chapter:

```text
Test Files  59 passed (59)
     Tests  395 passed (395)
  Duration  15.85s
```

Three lines of stderr in the output are **deliberately triggered by tests**. They are not failures:

```text
Run failed: workspace is not a Git repository root
Run failed: CLI execution or cleanup failed
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

If you want to see only the 26 tests in this chapter:

```powershell
npm exec -- vitest run --root . chapters/ch18/tests/ch18-worktrees.test.ts chapters/ch18/tests/ch18-loop-workspace.test.ts chapters/ch18/tests/ch18-claim-routing.test.ts chapters/ch18/tests/ch18-bootstrap.test.ts chapters/ch18/tests/ch18-entry.test.ts
```

```text
Test Files  5 passed (5)
     Tests  26 passed (26)
```

Among these 26 tests, a few are especially worth opening and reading:

| Test name | What it locks down |
| --- | --- |
| `isolates same-named files across two active worktrees` | Files with the same name in two real Worktrees do not affect each other |
| `keeps a reservation and pending task when Git worktree creation fails` | When Git fails, both `reserved` and `pending` stay |
| `keeps dirty worktree for review and only removes an integrated clean worktree` | A dirty one stays; only a clean and already merged one is deleted |
| `turns Git status failures and process errors into needs_review without stderr` | A Git error does not leak stderr |
| `marks a mismatched registered worktree root for review` | The directory exists but it is not a Managed Worktree → review |
| `rolls back a binding transition when audit insertion fails` | When an audit write fails, the state transition rolls back together with it |
| `keeps worktree audit append-only for UPDATE` / `DELETE` | The two triggers really take effect |
| `rejects a non-Git workspace before creating runtime state` | A non-Git directory fails before state is created |
| `same reply claim then write resolves the new workspace before the second tool` | Same-reply claim→write routing is correct |
| `provider escape becomes a paired tool_context_error before the handler` | A provider goes out of bounds → a paired error, and the handler is uncalled |
| `execution scope is shared within one run and replaced before the next run` | The scope lifecycle is exactly one run |
| `keeps a kept binding as kept when removal fails` | A `kept` binding will not be overwritten to `needs_review` by a cleanup failure |

After you run them, confirm that the workspace is clean:

```powershell
git status --porcelain=v1
```

If the experiment script is still there, delete it (the "Clean up after the experiments" section earlier).

---

## Chapter summary

### Three-sentence version

1. **Task ownership and file system isolation are two problems.** Chapter 17 solved the first one (claim token + lease). This chapter solves the second one (Managed Git Worktree). A lock can only make an overwrite ordered. It cannot make an overwrite disappear.
2. **The working directory is not global state. It is the resolution result of every tool call.** `ToolContextProvider.resolve()` runs after schema validation and before Hooks and permissions. Two calls from the same Agent can land in two directories.
3. **Deletion is not a command. It is a proof.** All eight proofs must pass before deletion. If any one fails, it moves to `needs_review`, and the directory, the branch, and the reason are left together.

### 9 points you must remember

1. Task, Claim, and Binding are three independent state lines. Their lifecycles are different, and they cannot be merged into one table.
2. Creation first records `reserved` in SQLite, and then calls Git; after Git succeeds, it transitions to `active` from the readback evidence. **An orphan side effect is much more serious than an extra state record.**
3. An `integration_ref` is first resolved with `rev-parse --verify <ref>^{commit}` to an immutable 40-character hex value, and only then is a Worktree created.
4. Manual claim, automatic stealing, and task completion share the same `TaskClaimService`; the composition root enforces this with reference equality.
5. Every tool call resolves a trusted context again; resolve sits **before** Hooks and permissions, and when it fails, the handler is uncalled.
6. An invalid claim must fail. It must never silently fall back to the main directory. Only "no claim is declared at all" uses the main directory.
7. `remove` accepts only a Worktree that is clean, whose registration matches, and whose branch tip is already contained in the specified integration ref; there is no `--force`, and there is no `-D`.
8. A cleanup failure always moves to `needs_review` and retains the site; a binding that is already `kept` or `needs_review` does not transition repeatedly.
9. A binding transition and an audit event are committed in the same SQLite transaction; a trigger blocks UPDATE and DELETE on the audit table.

### One diagram to review the whole chain

```text
  Lead                    SQLite                      Git file system
   │                        │                              │
   │ create_worktree ──────▶│                              │
   │                        │ ① canonical validation       │
   │                        │ ② rev-parse ref ────────────▶│ Resolve to a 40-character commit
   │                        │ ③ INSERT reserved            │
   │                        │    + reserve event (same transaction) │
   │                        │ ④ worktree add ─────────────▶│ Create the directory + wt/{name} branch
   │                        │ ⑤ Read back branch --show-current ◀│ Prove the branch is correct
   │                        │    UPDATE → active           │
   │                        │    + create event (same transaction) │
   │◀───── binding JSON ────│                              │
   │                        │                              │
  Teammate                  │                              │
   │ claimNext ────────────▶│ Scans only active bindings   │
   │◀──── claim + token ────│                              │
   │                        │                              │
   │ write_file             │                              │
   │  └─ resolve(ctx) ─────▶│ Look up the claim → look up the binding │
   │◀── worktree path ──────│  (It lets it through only if active) │
   │  └─ handler ──────────────────────────────────────────▶│ Write into .agent_tutorial/
   │                        │                              │   worktrees/{name}/
   │ complete_task ────────▶│ task → completed             │
   │                        │ The binding is still active  │
   │                        │                              │
  Lead                      │                              │
   │ remove_worktree ──────▶│ Eight proofs ───────────────▶│ registered? clean?
   │                        │                              │ integrated?
   │                        │ All pass → detach ──────────▶│ switch --detach
   │                        │       branch -d ────────────▶│ (not forced)
   │                        │       worktree remove ──────▶│ (not forced)
   │                        │ UPDATE → removed             │
   │                        │ Any one fails → needs_review │ The directory and the branch both stay
   │◀───── binding JSON ────│  + review_reason             │
```

### Check whether you really understood it

Without looking at the content above, try to answer:

1. Why can adding a file lock to `write_file` not solve Alice and Bob's problem?
2. After `git worktree add` fails, what state is the binding in? What state is the task in? Will auto-claim pick it up?
3. Why does `resolve()` sit **before** the PreToolUse Hook? What happens if it sits after it?
4. An Agent first calls `claim_task` and then `write_file` in the same reply. How does the second call know which directory to write to? If these two calls are in two replies, what does it depend on?
5. Which Git command does `remove_worktree` use to judge "already integrated"? Why does it not use `git branch --merged`?
6. Why must a non-zero return from `git status` and an empty-string return be treated differently?
7. A binding is already `kept`. You call `remove_worktree` again, and it fails. How many records will the audit table gain? Why?
8. Why does `validateRepository()` require the workspace to be exactly the repository root, and why is a subdirectory not allowed?
9. Why does the composition root use `!==` for a reference-equality judgement, instead of comparing configuration content?

If you cannot answer one, go back and run the corresponding experiment — every question has an experiment that can give the answer directly.

---

By this point, Alice and Bob will not only not claim the same task, they will also not overwrite each other in the same file space. Task ownership and the file write location have become two state lines that can each be proved. When a failure happens, what is left is recoverable evidence, not an untraceable result like "the changes are gone".

The next chapter solves another static boundary: the tool surface is still written dead in the composition root, and it cannot change after startup. **How do external capabilities enter and exit the current tool pool at runtime through MCP?** This is the content of Chapter 19.
