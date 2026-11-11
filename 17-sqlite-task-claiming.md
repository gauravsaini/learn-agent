After teammates can run persistently, exchange messages and submit plans, the Lead can still get stuck on a very plain bottleneck: handing out the work.

Dispatching 10 tasks by hand 10 times is barely acceptable. Once the tasks have dependencies, the Lead must also watch who finished, who became unblocked, and who should get the next item. The more teammates there are, the busier the central coordinator becomes.

Real autonomy is not "executes after it receives an order". It is "when idle, it can find the currently doable work on a shared task board, and let only one worker obtain it".

One sentence states the mechanism that this chapter implements:

```text
Tasks are no longer dispatched by the Lead one by one. They are written into a shared SQLite task board.
An idle teammate polls this board itself. It finds the first task whose "dependencies are completed", in creation order.
It uses one conditional UPDATE to change that task from pending to in_progress —— whoever changes it successfully gets it.
A successful claim returns a claim token (the claim credential) and a lease (the lease expiry time).
To complete the task, the worker must present this token. A wrong token, or an expired lease, cannot complete it.
```

On top of Chapter 16's persistent Teammates, typed Protocol and hard plan gate, Chapter 17 adds only two capabilities:

- `TASK_DAG_SQLITE`: switch this chapter's task graph to an independent SQLite store;
- `WORK_STEALING`: let an idle Teammate claim unblocked tasks atomically, in a stable order.

![image](https://mmbiz.qpic.cn/sz_mmbiz_png/1z26fJxNuiaEsibIxNKicV8v8bQOOYo1QvuRbQt26BPeHysflic1oBvhICiasagAgb96HpxFUPX7MZjQrpk7YqHIHWLOt4IF4l1LnJUhwgibk1xsU/640?from=appmsg&watermark=1&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=0)

---

## Chapter Guide

### What you can do after you read this chapter

- State clearly why "scan first, then write the owner" inevitably dispatches work twice under concurrency, and on which line the TOCTOU race happens;
- Use SQLite's `BEGIN IMMEDIATE` plus one conditional `UPDATE` to compress "select the task + change the state" into one atomic step;
- Explain what each of the three mutual-exclusion layers blocks (in-process serialisation, the cross-process file lock, the database write transaction), and what leaks if one layer is missing;
- State clearly why the claim token must be "unique for the whole life cycle", not only "currently unique";
- Read and understand why the lease is a half-open interval `[claimed_at, lease_expires_at)`, and who owns the boundary millisecond;
- State clearly the fixed priority of the four things in the idle loop, and why shutdown is never starved by a ready task;
- Run Chapter 17 yourself, and verify every conclusion above one by one with 11 experiments that need no API key.

### What you need first

| Prerequisite | Specific requirement | What happens if you do not meet it |
| --- | --- | --- |
| The mechanisms of Chapters 15 and 16 | You know that a Teammate is a resident worker, that the Mailbox is a claim/ack queue, and that the plan gate blocks tools with side effects | You will not understand the idle loop's priority in this chapter |
| Chapter 12's task DAG | You know that a task has `blocked_by` dependencies, and that completing one unblocks its downstream tasks | You cannot tell whether this chapter adds a "storage back-end" or a "task model" |
| Node.js 22+ | This article was tested with v25.7.0 | The dependencies will not install, or `tsx` will not run |
| Windows PowerShell | All commands in this article are written in PowerShell form | You must translate the commands into bash yourself |
| A little SQL common knowledge | You can read `UPDATE ... WHERE ...` and transactions | You need to read the atomic claim section two more times |
| Model credentials (optional) | Only the "run it for real once" step needs them | Steps 0–4 and all 11 experiments do not need them |

### Quick term reference (terms that first appear in this chapter)

| Term | One-sentence explanation |
| --- | --- |
| **work stealing** | An idle worker takes work from the shared task board itself, instead of waiting for a central coordinator to dispatch it |
| **shared task board** | In this chapter, the SQLite database file `tasks.sqlite3`; several processes can read and write it |
| **ready task** | A task whose status is `pending` and whose `blocked_by` dependencies are all `completed` |
| **TOCTOU** | Time-Of-Check To Time-Of-Use: between "the check finished" and "the actual use", somebody else changed the state |
| **atomic claim** | Task selection and state change complete inside the same transaction; nobody gets a chance to cut in between |
| **`BEGIN IMMEDIATE`** | A SQLite write transaction; it takes the reserved lock at the start, instead of waiting until the first write |
| **conditional UPDATE** | `UPDATE ... WHERE status='pending' AND owner IS NULL`; only the side that finds the state unchanged can change it successfully |
| **`getRowsModified()`** | How many rows the previous statement really changed; at claim time it must equal 1, otherwise somebody was faster |
| **claim token** | The claim credential, a UUID; at completion time, the worker must present it exactly as-is |
| **lease** | The claim's validity deadline; after it expires, the task automatically returns to `pending` and can be claimed by somebody else |
| **half-open interval** | `[claimed_at, lease_expires_at)`; the moment at the right endpoint counts as expired, not as valid |
| **three-layer mutual exclusion** | In-process tail-chain → cross-process file lock → `BEGIN IMMEDIATE`; each layer narrows the scope |
| **bounded polling** | The number of empty spins has an upper limit (default 12); at the limit, the loop exits instead of spinning forever |
| **interruptible wait** | A new message can interrupt the polling interval early; the worker does not have to wait the full 5 seconds |
| **idempotency key (idempotencyKey)** | The deduplication identifier of one run; this chapter reuses the claim token directly |

### Suggested reading route

```text
[1] Look at one complete claim trace first      | You get a picture, and you know what the final run looks like
      ↓
[2] Why you cannot "scan first, then write the owner" | The reason this chapter exists; three wrong ways to write it
      ↓
[3] The independent SQLite back-end and the table schema | What the data looks like, and what the constraints block
      ↓
[4] Atomic claim: three-layer mutual exclusion          | The most core section of this chapter
      ↓
[5] Claim token and lease        | The credential and the validity period; the two checks at completion
      ↓
[6] Five tools and role cut-down          | The Lead and the teammates get different tool sets
      ↓
[7] The idle loop's real priority       | The exact position of self-driven polling in the code
      ↓
[8] Bounded polling, no fake shutdown | How the empty spin converges, and how it is observed
      ↓
[9] Run Chapter 17                | Get it running from zero; steps 0–3 need no API key
      ↓
[10] 11 hands-on experiments            | None needs an API key; verify the conclusions above one by one
```

If you have only 10 minutes, read sections `[1]`, `[4]` and `[7]`, then run Experiment 5 and Experiment 10.

---
## Look at One Complete Claim Trace First

The output below comes from Experiment 1 in this chapter (the script `scripts/probe-ch17.mts`; I will walk you through building it step by step later). Three tasks, three workers, and no Lead dispatch anywhere:

```text
===== trace =====
[1] The Lead created three tasks: A=…1701 B=…1702 C=…1703 (C depends on A and B)
[2] The task board now: Fetch data(pending) Clean data(pending) Generate the report(pending)
[3] alice polls and finds work: Fetch data token=…1711 lease until 2026-07-27T14:01:00.000Z
[4] bob polls at the same time, and gets a different one: Clean data token=…1712
[5] carol polls too: claimNext → undefined (C's dependencies are not complete yet)
[6] alice presents the token and completes A → unblocked=[] (C still lacks B)
[7] bob completes B → unblocked=[Generate the report] (C is unblocked)
[8] On her next polling round, carol gets it: Generate the report token=…1713
[9] carol completes C, the task board is empty: Fetch data(completed) Clean data(completed) Generate the report(completed)
[10] The token history table holds 3 entries in total; they cannot be reused for the whole life cycle
```

Look one by one at what these ten lines hide:

`[1]` `[2]` The Lead's only action is to write the tasks into the task board. It does not need to know how many workers there are, or who is free. All three tasks are `pending`, and the `owner` is `null`.

`[3]` `[4]` **This is the core picture of this chapter**: alice and bob each call `claimNext`. One gets A, the other gets B. Note that they do not get the same one — not because "the Lead assigned it in advance", but because of that one conditional `UPDATE` in the database: whoever changes a row from `pending` to `in_progress` first owns that row. The other one comes in, finds it cannot change the row, and automatically looks for the next one.

`[3]` also contains two things that Chapter 12's task model did not have: `token=…1711` is the claim credential, and `lease until 14:01:00` is this claim's validity period (default 60 seconds; the experiment sets it explicitly to 60000ms).

`[5]` carol is also polling, but she gets `undefined`. C depends on A and B, and neither is complete, so C is not a ready task. `undefined` is not an error. It is the normal signal for "no work right now". The worker that receives it sleeps for a while and comes back.

`[6]` `[7]` To complete a task, the worker must present the token. `unblocked` lists which downstream tasks this completion unblocked: when A completes, C still lacks B, so the list is empty; when B completes, C's dependencies are complete, so `unblocked=[Generate the report]`. **Note that unblocking is not dispatching** — the system does not push C to anybody. It only turns C into a ready task.

`[8]` On her next polling round, carol naturally sees C. In the whole dependency progression, nobody is "watching who finished, and who should get the next item".

`[10]` The three claims produced three tokens. All of them stay in the history table `task_claim_tokens`. This table's job is not bookkeeping. Its job is to **guarantee that the same token cannot appear a second time in the whole database life cycle** — later I will explain why "currently unique" is not enough.

See the whole chain in one diagram:

```text
        Lead                      Shared task board (tasks.sqlite3)              Idle teammates
         │                                                                  │
  create_task ────────────►  ┌──────────────────────────┐                    │
    A B C(depends on A,B)    │ A pending  owner=null    │                    │
                             │ B pending  owner=null    │  ◄──── claimNext ──┤ alice
                             │ C pending  owner=null    │                    │
                             └──────────────────────────┘  ──── A + token ──►│
                                                                             │
                             ┌──────────────────────────┐  ◄──── claimNext ──┤ bob
                             │ A in_progress owner=alice│                    │
                             │ B in_progress owner=bob  │  ──── B + token ──►│
                             │ C pending                │                    │
                             └──────────────────────────┘  ◄──── claimNext ──┤ carol
                                                            ──── undefined ─►│ (sleep 5s, then come back)
```

---

## Why You Cannot "Scan First, Then Write the Owner"

Chapter 12's task graph can already express dependencies. A natural idea is: add a loop to the worker; scan the task list once; find a ready task; write `owner` as itself.

This way of writing works completely normally with a single worker. With two workers, it **dispatches work twice**. The problem sits between the "scan" and the "write".

### Three ways to write it wrong

**❌ Way 1: read the list first, then write the owner**

```typescript
// Wrong example
const tasks = await store.listTasks();                    // ①
const ready = tasks.find((t) => t.status === "pending" && depsDone(t));
if (ready !== undefined) {
  await store.assign(ready.id, myName);                   // ②
}
```

`①` and `②` are two independent storage accesses. At `①`, alice reads "A is pending". Before she reaches `②`, bob also executes `①`, and also reads "A is pending". Both reach `②`. Both believe they got A.

This is **TOCTOU** (Time-Of-Check To Time-Of-Use): at the moment of the check, the state was true. At the moment of use, the state has already changed. It does not matter how short the interval is — execution can switch at any time between asynchronous I/O calls.

**❌ Way 2: add an in-memory lock**

```typescript
// Wrong example
await mutex.runExclusive(async () => {
  const ready = (await store.listTasks()).find(isReady);
  if (ready !== undefined) await store.assign(ready.id, myName);
});
```

Inside one process, this really does not duplicate. But teammates can run in different processes (from Chapter 13 on, there are background jobs and independent entries). An in-memory lock cannot cross the process boundary. Experiment 5 verifies this with two real child processes.

**❌ Way 3: write it first, then check; roll back when you find a conflict**

```typescript
// Wrong example
await store.assign(taskId, myName);
const current = await store.getTask(taskId);
if (current.owner !== myName) {
  await store.unassign(taskId);   // roll back
}
```

The "roll back" itself is one non-atomic write. Two workers can roll back at the same time, and the task ends up done by nobody. Or the rollback overwrites the other side's legitimate owner that it just wrote in. Fixing a race with compensation logic usually introduces a second race.

### The correct shape: put "selection" and "state transition" in the same transaction

The conclusion is short: **there must be no "look first, then decide" gap**. The judgement "is this one pending" and "change it to in_progress" must be part of the same statement. The storage layer guarantees the atomicity:

```sql
UPDATE tasks
   SET status = 'in_progress', owner = ?, claim_token = ?, lease_expires_at_utc = ?
 WHERE id = ? AND status = 'pending' AND owner IS NULL
```

The `status = 'pending' AND owner IS NULL` inside the `WHERE` is that "check". It sits in the same SQL statement as the "write". Whoever executes successfully gets `getRowsModified()` = 1. Whoever is one step slower finds that the `WHERE` matches no row, and gets 0 — it knows it did not win, and continues to look for the next one.

This is also why this chapter changes the storage back-end: a JSON file cannot do a "conditional atomic update". SQLite can.

---
## An Independent SQLite Back-End: No Migration, No Dual Write

This chapter adds `SqliteTaskStore`. But it does **not** move Chapter 12's `JsonTaskStore` data over, and it does not make the two synchronise. This is deliberate:

| Approach | Why it is not chosen |
| --- | --- |
| Write a migration script, and import the JSON graph into SQLite | Migration logic must handle all kinds of historical dirty data. For teaching, that is noise. And this chapter talks about concurrency, not migration |
| Write to both, and treat SQLite as authoritative on read | Dual write has a consistency window. Once the two disagree, you need extra rules to arbitrate. That moves the complexity into the business code |
| Add an adapter layer, and choose one of the two at runtime | Then you must maintain two sets of concurrency semantics (JSON has no atomic claim), and the test surface doubles |
| **This chapter: two independent back-ends, select one by capability bit** | One problem, one source of truth. P17 uses only SQLite. P12–P16 use only JSON. Neither knows about the other |

Experiment 2's measured output directly proves that they are invisible to each other:

```text
===== backend =====
SQLite database path: <root>\.agent_tutorial\tasks.sqlite3
SQLite listTasks(): 1 entry
JSON  listTasks(): 0 entries
The task in SQLite: 1701 / written only into SQLite
--- after JSON also writes one ---
SQLite listTasks(): 1 entry
JSON  listTasks(): 1 entry
```

At the composition root level, the capability bit enforces it: P17 requires `workStealingRuntime`, and at the same time **refuses** a passed-in JSON `taskStore`. If you pass the wrong one, the system errors at startup, instead of discovering halfway through the run that the claim is not atomic (`src/bootstrap.ts`):

```typescript
const usesJsonTaskStore =
  profile.capabilities.has("task_dag_json") && !profile.capabilities.has("task_dag_sqlite");
```

---

## Table Schema: Stable Order, Dependencies, Token History

The database file is at `<workspace>/.agent_tutorial/tasks.sqlite3`. It has four tables. Every open executes `CREATE TABLE IF NOT EXISTS` (`src/adapters/task-sqlite.ts:456`).

Experiment 3 prints the table schema and the real rows directly:

```text
===== schema =====
Table list:
  sqlite_sequence
  task_claim_tokens
  task_dependencies
  task_metadata
  tasks
schema_version: 1
tasks rows (by sequence):
  seq=1 id=…1701 status=in_progress owner=alice token=…1711 lease=2026-07-27T14:00:30.000Z
  seq=2 id=…1702 status=pending owner=null token=null lease=null
task_dependencies rows:
  task=…1702 dep=…1701 position=0
task_claim_tokens rows:
  token=…1711 task=…1701
```

Each of the four tables manages one thing:

| Table | Job | Key design |
| --- | --- | --- |
| `task_metadata` | Stores only `schema_version = '1'` | On open, if the version is not `'1'`, the system errors directly. It does not upgrade implicitly |
| `tasks` | The task body | `sequence INTEGER PRIMARY KEY AUTOINCREMENT` provides a stable creation order |
| `task_dependencies` | The dependency edges | Carries `position`, so the `blocked_by` array order is reproducible |
| `task_claim_tokens` | The token history | `token TEXT PRIMARY KEY`; the same token can appear only once in the whole life cycle |

### Why `sequence`, and not sorting by `id`

`claimNext` must scan the candidates in a **deterministic order**. Otherwise two workers can repeatedly collide on the same one because their orders differ. A task ID is a UUID. Its lexicographic order has nothing to do with creation order. `sequence` is an auto-incrementing integer. `ORDER BY sequence ASC` is creation order. It is the same across processes and across restarts.

### The three-state consistency is written into a CHECK constraint

The `tasks` table carries one three-way `CHECK`. It pins "the state and the fields must match" at the database layer:

```sql
CHECK(
  (status = 'pending'     AND owner IS NULL     AND claim_token IS NULL     AND lease_expires_at_utc IS NULL)
  OR (status = 'in_progress' AND owner IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
  OR (status = 'completed'   AND owner IS NOT NULL AND claim_token IS NULL     AND lease_expires_at_utc IS NULL)
)
```

Compare Experiment 3's output above: `seq=1` is `in_progress`, and owner/token/lease are all present; `seq=2` is `pending`, and all three are `null`. This constraint's value is: **even if the code writes wrongly, it cannot write in a self-contradictory state**. For example, "it has an owner but the status is still pending" is rejected by the database directly.

The `completed` row deserves a separate look: after completion, the owner is kept (so you know who did it), but the token and the lease are cleared (the credential is spent; the lease no longer means anything).

---

## Atomic Claim: Three-Layer Mutual Exclusion

Above, I said clearly that "one conditional UPDATE is enough". But a real run must also handle three concurrency scenarios. So the code has three mutual-exclusion layers. Each layer blocks one case.

```text
  Two teammates in the same process claim at the same time
        │
        ▼
  ┌─────────────────────────────────────────┐
  │ Layer 1: withProcessMutex(database path)  │  Serial queueing inside the process; no fight over the file lock
  └─────────────────────────────────────────┘
        │
        ▼   Different processes claim at the same time
  ┌─────────────────────────────────────────┐
  │ Layer 2: a proper-lockfile lock on the .lock file   │  Cross-process mutual exclusion; Windows races retry
  └─────────────────────────────────────────┘
        │
        ▼   Inside one process, while the lock is held, the transaction atomicity must still hold
  ┌─────────────────────────────────────────┐
  │ Layer 3: the BEGIN IMMEDIATE write transaction           │  Scan + UPDATE inside one transaction
  └─────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────┐
  │ The final mutual-exclusion point: UPDATE ... WHERE status=     │  getRowsModified() must equal 1
  │ 'pending' AND owner IS NULL              │
  └─────────────────────────────────────────┘
```
What leaks if you remove one layer:

| Layer | What it blocks | What happens if you remove it |
| --- | --- | --- |
| `withProcessMutex` | Several teammates in the same process hit the file lock at the same time | Nothing errors. But the inside of one process first fights over the file lock among itself, with pointless retries |
| File lock | Different processes enter a write transaction at the same time | Two processes each open their own sql.js in-memory database, and each exports it to disk. **The later write overwrites the earlier write.** One claim vanishes into thin air |
| `BEGIN IMMEDIATE` | The graph read inside the transaction disagrees with the state written back | The DAG you read can be stale. The dependency judgement is based on expired data |
| Conditional `UPDATE` | Two transactions change the same row | Even with the first three layers present, a TOCTOU still exists between the logical judgement and the write |

### Why `BEGIN IMMEDIATE` and not `BEGIN`

SQLite's default `BEGIN` (deferred) takes the write lock only at the **first real write**. That is, the `SELECT` statements at the start of the transaction read without a write lock. After they read, when the transaction prepares to write, it discovers that it cannot get the lock. `BEGIN IMMEDIATE` takes the reserved lock at the very start. The whole "scan + update" segment sits under write-lock protection.

### The complete logic of `claimNext`

`src/adapters/task-sqlite.ts:198`:

```typescript
async claimNext(owner: string): Promise<TaskClaim | undefined> {
  // Automatic claiming selects the first ready task in stable creation order; with no candidate, it returns undefined and enters idle polling.
  const normalizedOwner = normalizeOwner(owner);
  return await this.#transaction(true, (database) => {
    // Release expired leases first, then load the complete DAG, and find the first pending task with no incomplete dependency, in creation order.
    const now = this.#now();
    releaseExpired(database, now);
    const graph = loadGraph(database);
    for (const id of graph.order) {
      const task = graph.tasks.get(id);
      if (task === undefined || task.status !== TaskStatus.PENDING) continue;
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

The order of the four things matters:

1. **`releaseExpired`**: first put the tasks with expired leases back into `pending`. Otherwise, a crashed worker holds a task forever;
2. **`loadGraph`**: read the whole DAG into memory at once. The dependency judgement is based on the same snapshot;
3. **Iterate by `graph.order`**: that is, creation order. Skip non-`pending` tasks and tasks with incomplete dependencies;
4. **`#claim`**: on a hit, complete the claim inside the same transaction, then `return` immediately — one call claims only one task.

The whole function body sits inside the `#transaction(true, ...)` callback. That is, inside the three-layer mutual exclusion. `true` means this is a write operation, and it may create the storage directory.

### `#claim`: register the token first, then update conditionally

`src/adapters/task-sqlite.ts:278`. This is the claim's last step:

```typescript
const token = this.#nextClaimToken();
const expiresAt = new Date(now.getTime() + this.#leaseDurationMs);
// The historical token table guarantees that the same token cannot be reused in the whole life cycle; a conflict rolls the whole claim transaction back.
try {
  database.run("INSERT INTO task_claim_tokens(token, task_id) VALUES (?, ?)", [token, task.id]);
} catch (error) {
  throw new TaskStorageError("Generated claim token already exists", { cause: error });
}
// The conditional UPDATE is the final mutual-exclusion point: even if concurrent scans see the same pending task, only one transaction can change it to in_progress.
const changed = database.run(
  "UPDATE tasks SET status = 'in_progress', owner = ?, claim_token = ?, lease_expires_at_utc = ? WHERE id = ? AND status = 'pending' AND owner IS NULL",
  [owner, token, encodeDate(expiresAt), task.id],
);
if (changed.getRowsModified() !== 1) {
  throw new TaskStateError(`Task ${task.id} could not be atomically claimed`);
}
```

Two order details:

**The token INSERT comes before the UPDATE.** If it were the other way round — first change the task to `in_progress`, then register the token — then on a token conflict, the task was already changed. You would need compensation logic to roll it back. Put the INSERT first, and a conflict throws directly. The whole transaction does a `ROLLBACK`. The task does not move at all. Experiment 7 verifies this.

**`getRowsModified() !== 1` throws an error. It does not return undefined.** Reaching this line means the code just judged that this task is `pending`, and then could not change it. That means another path bypassed the mutual exclusion. This is a real anomaly. It should blow up, not continue silently.

### The transaction shell: `#transaction`

`src/adapters/task-sqlite.ts:310` is the common entry for all public operations. The three-layer mutual exclusion is orchestrated here:

```typescript
return await withProcessMutex(paths.database, async () => {          // Layer 1
  let release: (() => Promise<void>) | undefined;
  let raceRetries = 0;
  try {
    while (release === undefined) {
      try {
        release = await acquireFileLock(paths.root, {                // Layer 2
          lockfilePath: paths.lock, realpath: true,
          stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS, retries: 0,
        });
      } catch (error) {
        if (isWindowsLockRace(error) && raceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
          raceRetries += 1;
          await delay(LOCK_RETRY_MS);
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
    const database = await openDatabase(paths);
    try {
      database.run("BEGIN IMMEDIATE");                              // Layer 3
      try {
        const result = operation(database);
        database.run("COMMIT");
        // sql.js is an in-memory database; after the commit, you must export it and persist it to disk by atomically replacing the file through a temporary file.
        await persistDatabase(paths.database, database.export());
        return result;
      } catch (error) { /* Wrap the error after ROLLBACK */ }
    } finally {
      database.close();
    }
  } finally {
    if (release !== undefined) await release();
  }
});
```

Three points deserve attention:

**`retries: 0` plus a hand-written retry loop.** `proper-lockfile` has its own retry, but here it is switched off. The code judges the error type itself instead. The reason: on Windows, while a lock file is being deleted or renamed, the call briefly returns `EBUSY` / `ENOTEMPTY` / `EPERM`. These are races, not failures, and they are worth a retry (upper limit 100 times, wait 10ms each time). Other errors should be thrown up immediately. A generic retry must not cover them up.

**After `COMMIT`, it must still persist to disk.** `sql.js` is SQLite compiled to WASM. The whole database is in memory. `COMMIT` only makes the in-memory transaction take effect. The code must then call `export()` to get the bytes, and write them back to the file.

**Persistence uses a temporary file + rename.** `persistDatabase` does this: in the same directory, create `.{uuid}.tmp`; create it exclusively with `open(temporary, "wx")`; `writeFile`; `sync()` to flush to disk; `close()`; and finally `rename()` to overwrite. `rename` is atomic within the same file system. So at any moment, another process reads either the complete old version or the complete new version. It never reads a half-written file.

---
## Claim Token and Lease: The Two Checks at Task Completion

### The claim result is not a string

After a successful `claimNext`, the return value is a three-field structure (`src/features/work-stealing.ts`):

```typescript
export interface TaskClaim {
  readonly task: Task;
  readonly claimToken: string;
  readonly leaseExpiresAtUtc: Date;
}
```

If it returned only the `Task`, the worker could only say, at completion time, "I finished task X". Why should the system believe it? It might be an old holder whose lease already expired. Or it might be another worker that never claimed anything.

So `completeTask` has a three-parameter signature:

```typescript
async completeTask(taskId: string, owner: string, claimToken: string): Promise<TaskCompletion>
```

The owner and the token **must both match** the current row. Compare Chapter 12's `complete_task`, which needed only the `task_id`. This is the most direct change to the tool contract in this chapter.

### Why the token must be "unique for the whole life cycle"

The `tasks.claim_token` column already has a `UNIQUE` constraint. Why does it still need a `task_claim_tokens` history table?

Because when a task completes, `tasks.claim_token` is cleared to `NULL`. Once it is cleared, the same token value can be inserted into `tasks` again — the `UNIQUE` constraint only governs "values that exist at the same time". Suppose the UUID generator has a problem (it is injected with a fixed value, or the random source is defective). A token that a completed task used could be reused by the next claim. Then the old completion request could complete the new claim with the old token.

The history table records **all tokens that ever appeared**, with `token TEXT PRIMARY KEY`. It never deletes. On a conflict, the `INSERT` fails, and the whole claim transaction rolls back.

Experiment 7 verifies this with a generator that "always returns the same token":

```text
===== token-history =====
First claim, token obtained: …1711
Second claim (the same token) → TaskStorageError: Generated claim token already exists
The second task is still: status=pending owner=null
Note: the token conflict rolled the whole claim transaction back. It left no half state.
```

The second task stays `pending` / `owner=null`. That is the payoff of "the token INSERT sits before the UPDATE".

### The lease is a half-open interval

At claim time, the lease hardens into an **absolute time**: `lease_expires_at_utc = the claim moment + leaseDurationMs` (default `60_000`). The system stores the deadline moment, not the duration. So a later configuration change does not retroactively affect leases that were already issued.

The validity period is the half-open interval `[claimed_at_utc, lease_expires_at_utc)`: at the right endpoint moment, the lease is **already expired**. The judgement code is a single `>=` (`src/adapters/task-sqlite.ts:237`):

```typescript
if (current.status === TaskStatus.IN_PROGRESS && lease !== null && now >= lease) {
  releaseExpired(database, now);
  expired = true;
  return undefined;
}
```

The `WHERE` in `releaseExpired` also uses `<=`. The two places agree:

```sql
UPDATE tasks SET ... WHERE status = 'in_progress'
  AND lease_expires_at_utc IS NOT NULL
  AND lease_expires_at_utc <= ?
```

Why half-open, and not a closed interval? Because the boundary must have exactly one owner. If `now == lease` counted both as "still valid" and as "releasable", then in that one millisecond, the original holder could complete the task, and another worker could also claim it — both would hold legitimate ownership of the same task. The half-open interval gives that moment exactly one answer: expired.

Experiment 6 tests exactly on this boundary:

```text
===== lease =====
Claim moment:     2026-07-27T14:00:00.000Z
Lease deadline:   2026-07-27T14:00:30.000Z
claim token:  …1711

--- Time pushed to +29999ms (inside the lease) ---
Current moment: 2026-07-27T14:00:29.999Z
claimNext("bob") → undefined (cannot get it)

--- Time pushed to +30000ms (exactly equal to the deadline) ---
Current moment: 2026-07-27T14:00:30.000Z
alice completes with the original token → TaskLeaseExpiredError: Task 00000000-0000-4000-8000-000000001701 claim lease expired
The task is back at: status=pending owner=null
bob claims it again → token=…1712 deadline=2026-07-27T14:01:00.000Z
alice completes again with the old token → TaskClaimError: Task 00000000-0000-4000-8000-000000001701 owner or claim token does not match the active claim
bob completes with the new token → status=completed
```

At `+29999ms` he cannot get it. At `+30000ms` it is expired. The boundary behavior matches the `>=` exactly.

The last three lines also show two different errors:

| Scenario | Error type | Meaning |
| --- | --- | --- |
| The lease just expired, and the original holder comes to complete | `TaskLeaseExpiredError` | Your lease is up. The task has been put back into pending |
| The task has been claimed again by somebody else, and you come to complete with the old token | `TaskClaimError` | Your credential is not the current credential |

`TaskLeaseExpiredError extends TaskClaimError`. So if you only want to handle "claim-related failures" uniformly, catching the parent class is enough. Judge the subclass only when you need to distinguish "expired" from "wrong credential". Note that `TaskLeaseExpiredError` is thrown **outside** the transaction — inside the transaction, the code first releases the expired lease and commits normally. Only then does it throw, based on the `expired` flag. This way, the "release" side effect is not withdrawn together with a `ROLLBACK`.

### The owner cannot be forged through a tool argument

A worker is model-driven. The model can fabricate any tool argument. If the `claim_task` arguments contained an `owner` field, the model could claim work under somebody else's identity.

So the schemas of `claim_task` and `complete_task` **have no owner field at all**. The owner comes from `ToolContext.identity` — the composition root writes it fixedly when it creates each teammate Runner (`identity: name`). The model cannot touch it. `DirectTaskClaimService` handles this conversion layer.

Experiment 9 verifies it directly:

```text
===== identity =====
claim_task returns (identity=alice):
  {"claim_token":"00000000-0000-4000-8000-000000001711","lease_expires_at_utc":"...","task":{"blocked_by":[],"description":"","id":"00000000-0000-4000-8000-000000001701","owner":"alice","status":"in_progress","subject":"See where the owner comes from"}}

There is no owner field in the tool arguments. The identity decides the owner → alice

bob completes with alice's token → Error [task_claim_mismatch]: Task ...1701 owner or claim token does not match the active claim
alice completes with her own token → {"task":{...,"owner":"alice","status":"completed",...},"unblocked":[]}

Trying to stuff an owner into the arguments → Error [invalid_arguments]: Tool arguments failed schema validation
```

The last line is the effect of `z.strictObject`: fields outside the schema are all rejected, not ignored. **Ignoring unknown fields is a dangerous default behavior** — if the model passes an `owner` and it is silently dropped, it will believe that it successfully specified the owner.

Note bob's line: even though bob obtained alice's token (the token is correct), an owner mismatch still cannot complete the task. The two conditions are an "AND" relationship.

---

## Five Tools, and the Lead and the Teammates Get Different Sets

`leasedTaskToolDefinitions` returns a fixed-order quintuple. Experiment 8's measurement:

```text
===== tools =====
Lead   tool set: create_task, get_task, list_tasks, claim_task, complete_task
Teammate   tool set: get_task, list_tasks, claim_task, complete_task
The teammate lacks: create_task

Each tool's effect and parameters:
  create_task   effect=write parameters=[subject, description, blocked_by] required=[subject, description, blocked_by]
  get_task      effect=read  parameters=[task_id] required=[task_id]
  list_tasks    effect=read  parameters=[] required=[]
  claim_task    effect=write parameters=[task_id] required=[task_id]
  complete_task effect=write parameters=[task_id, claim_token] required=[task_id, claim_token]

maxIdlePolls default = 12
Call create_task with only a subject → isError=false
  {"blocked_by":[],"description":"","id":"...1701","owner":null,"status":"pending","subject":"passed only a subject"}
```

The cut-down is implemented as an array slice (`src/features/work-stealing.ts`):

```typescript
const definitions = leasedTaskToolDefinitions(this.#store, this.#claimService);
this.#leadToolDefinitions = definitions;
this.#teammateToolDefinitions = Object.freeze(definitions.slice(1));
```

What `slice(1)` removes is exactly the first one, `create_task`. A teammate cannot create tasks. It can only do existing tasks — **this prevents task self-reproduction**: if a teammate could create tasks, a model in a loop could keep manufacturing work for itself, and the task board would never converge. To decompose a task, go through the Lead, or go through plan approval.

One place in the output above is easy to misread: `create_task`'s "required" list contains `description` and `blocked_by`. That is how `z.toJSONSchema` represents fields that carry a `.default()`. **At runtime they are not really required** — the last two lines verify that passing only a `subject` also succeeds. The `description` is filled in as `""`, and `blocked_by` is filled in as `[]`.

### Wire format: the camelCase and snake_case boundary

The internal domain model uses camelCase (`blockedBy`, `claimToken`, `leaseExpiresAtUtc`). The JSON exposed to the model uses snake_case (`blocked_by`, `claim_token`, `lease_expires_at_utc`). The conversion happens in only two functions:

```typescript
// Outbound: Task → the JSON the model sees
function taskPayload(task: Task) {
  return { blocked_by: ..., description: ..., id: ..., owner: ..., status: ..., subject: ... };
}
// Outbound: TaskClaim → the JSON the model sees
function claimPayload(claim: TaskClaim) {
  return { claim_token: ..., lease_expires_at_utc: ..., task: taskPayload(claim.task) };
}
```

The fields are sorted alphabetically. That is not written casually: **the JSON order that the model sees is stable, so the prompt prefix can hit the cache**.

The inbound direction is handled by the zod schema. The `blocked_by` of `create_task` maps to the internal `blockedBy` — `tests/ch17-work-stealing.test.ts` has a test that asserts exactly this mapping.

---

## The Idle Loop's Real Priority

Everything above is the storage layer. Now look at when a teammate calls `claimNext`.

The core is `#runWorker` at `src/features/teammates.ts:573`. At the start of each loop round there is a `scan`. The priority is fixed at four levels:

```text
Scan in each round (completed inside the #withRegistry lock):

  ① The Mailbox has a message? ──── yes ──► Process the message (shutdown / plan reply / ordinary task), this round ends
        │ no
        ▼
  ② Is work stealing configured? ── not configured ──► Set the status to Idle, and exit the worker
        │ configured
        ▼
  ③ planAllowsEffectful? ──── false ──► Skip the claim, and go directly to the wait in step 4
        │ true
        ▼
  ④ claimNext(its own name) ─── got one ──► Run the task, report to the Lead, continue
        │ undefined
        ▼
     waitForPoll (interruptible) ──► woken up? continue (does not count as an empty spin)
                            └► woke up normally? empty spins +1; at the upper limit, exit
```

The original code:

```typescript
const scan = await this.#withRegistry(async () => {
  this.#ensureAvailable();
  const message = await this.#store.claim(worker.teammate.name);
  if (message !== undefined) {
    return { message, workStealing: undefined, claim: undefined };
  }
  const workStealing = this.#workStealingRuntime;
  if (workStealing === undefined) {
    return { message: undefined, workStealing: undefined, claim: undefined };
  }
  const protocol = this.#protocolRuntime;
  if (protocol === undefined) {
    throw new TeammateStateError("Work-stealing runtime requires Protocol runtime");
  }
  if (!(await protocol.planAllowsEffectful(worker.teammate.name))) {
    return { message: undefined, workStealing, claim: undefined };
  }
  return {
    message: undefined,
    workStealing,
    claim: await workStealing.claimNext(worker.teammate.name),
  };
});
```

### Why the Mailbox must come first

If the worker claimed a task first and looked at the Mailbox after that, then as long as the task board still has work, the teammate keeps doing tasks. A `shutdown` request waits in the queue forever, unprocessed — **a ready task starves the control messages**. The Lead wants to shut a teammate down gracefully, and has to wait until the task board is empty. That is clearly wrong.

`tests/ch17-runtime.test.ts` has a test that locks this order in: the task board has a ready task, and a shutdown protocol message is delivered at the same time. The test asserts that `response[0].toPayload().kind === "protocol"`, that the task stays `PENDING`, and that `model.requests` has length 1 (the model was called only once — for processing the protocol message, not for running the task).

### Why the plan gate sits before the claim

Chapter 16's rule is: without an approved plan, a teammate cannot execute tools with side effects. Claiming a task is itself a write operation (it changes the database state). And right after the claim, the worker starts doing the real work. So the gate must check **before** `claimNext`, not wait until the model calls a tool.

Note the semantics of `planAllowsEffectful`: when no plan was ever submitted, it returns `true` (it keeps Chapter 15's existing collaboration behavior). It returns `false` only when the latest plan is `Pending` or `Rejected`.

Experiment 11 verifies the blocking effect of `Pending`:

```text
===== plan-gate =====
Task state (plan not approved): pending owner=null
sleeper.calls = [5,5]  ← each element is the seconds of one polling wait
idleTimeoutCount("alice") = 1
Auto-claim prompt entries = 0
The task never left pending: true
```

`sleeper.calls = [5,5]` shows that it honestly spun empty for two rounds (`maxIdlePolls` was set to 2), waiting 5 seconds each round. `Auto-claim prompt entries = 0` shows that `claimNext` was never called even once — the task was not "rejected after claiming". It **never entered the claim at all**.

### After an automatic claim, the model must still complete the task explicitly

After it gets a claim, the teammate does not automatically mark the task complete when it finishes running. It receives a structured prompt (`renderClaimPrompt`):

```typescript
renderClaimPrompt(claim: TaskClaim): string {
  const payload = {
    claim_token: claim.claimToken,
    lease_expires_at_utc: claim.leaseExpiresAtUtc.toISOString(),
    task: taskPayload(claim.task),
  };
  return `<auto-claimed-task>\n${JSON.stringify(payload)}\n</auto-claimed-task>`;
}
```

Experiment 10 prints what the teammate really received:

```text
===== idle-loop =====
Events received: 2

The auto-claim prompt the teammate received (1 entry in total):
  <auto-claimed-task>
  {"claim_token":"00000000-0000-4000-8000-000000001731","lease_expires_at_utc":"...","task":{"blocked_by":[],"description":"","id":"00000000-0000-4000-8000-000000001721","owner":"alice","status":"in_progress","subject":"autonomous"}}
  </auto-claimed-task>

Task final state: autonomous=completed
idleTimeoutCount("alice") = 1
drainEvents() = []
```

**Why no automatic completion?** Because "the Runner finished running" and "the task was accomplished" are two different things. The model may discover halfway that it cannot do it. It may have done only half. It may need to ask the Lead first. Letting it call `complete_task` itself, and present the token, makes "completion" an explicit, evidence-backed decision. The prompt attaches the token and the lease deadline exactly so the model has evidence to act on.

### The claim token is reused as the idempotency key

When this round's Runner starts, the claim token serves as the `idempotencyKey`:

```typescript
const finalText = (
  await worker.runner.run(workStealing.renderClaimPrompt(claim), {
    idempotencyKey: claim.claimToken,
    signal,
  })
).finalText;
```

One claim corresponds to one token. And the token is naturally unique. So it exactly meets the idempotency key's requirement. If the Runner resubmits because of a network retry, the recovery layer can use this key to recognise that it is the same run. It does not execute twice. No new ID is invented here — **the token already is this round of work's identity**.

---
## Bounded Polling, No Fake Shutdown

"Polling while idle" sounds simple. But an infinitely polling loop is a process that never ends, inside a test. This chapter's approach sets an upper limit on the number of empty spins. And it turns "the limit was reached" into an observable event.

`WorkStealingRuntime`'s two defaults:

| Parameter | Default | Job |
| --- | --- | --- |
| `pollIntervalSeconds` | `5` | How long to wait before coming back, when there is no work |
| `maxIdlePolls` | `12` | After how many consecutive empty spins the worker loop exits |

Both are validated at construction time. A non-positive or non-integer value directly raises a `RangeError`.

The counting logic (`src/features/teammates.ts:632`):

```typescript
this.#setStatus(worker, TeammateStatus.Idle);
const wakeup = new AbortController();
worker.pollWakeup = wakeup;
// waitForPoll can be aborted early by #wakeWorker, so an idle teammate restarts its scan immediately when a new message arrives.
await workStealing.waitForPoll(wakeup.signal);
if (worker.pollWakeup === wakeup) worker.pollWakeup = undefined;
if (wakeup.signal.aborted) continue;
worker.idlePolls += 1;
if (worker.idlePolls >= workStealing.maxIdlePolls) {
  worker.idleTimeoutCount += 1;
  worker.idleTimeout.resolve();
  return;
}
```

Three design points:

**`if (wakeup.signal.aborted) continue;` sits before the counting.** Being woken by a new message does not count as an empty spin. This matters: a busy teammate can be woken repeatedly. If every wake-up consumed budget, it would exit the loop early because it is "too busy". That is exactly backwards. `tests/ch17-runtime.test.ts` has a test that covers exactly this: it uses `TwoWakeSleeper(1)` with `maxIdlePolls: 1`, wakes the worker once in the middle, and asserts `idleTimeoutCount === 1` — if a wake-up consumed budget, this number would be wrong.

**Reaching the empty-spin limit is a `return`. It is not a fake shutdown.** At exit, the code does only two things: `idleTimeoutCount += 1` and `idleTimeout.resolve()`. It does **not** send a shutdown event. It does not change the state to `Shutdown`. It does not stuff a message into the Lead's Mailbox. Because "temporarily no work" and "ordered to shut down" are two completely different things. Mixed together, they make the Lead receive fake shutdown signals.

**`idlePolls` resets to zero when the worker gets work or receives a message.** On a claim, `worker.idlePolls = 0`. When it processes a Mailbox message, also `worker.idlePolls = 0`. So the meaning of "12 times" is 12 **consecutive** empty spins, not a cumulative count. `tests/ch17-runtime.test.ts` uses `maxIdlePolls: 2` with three deliveries to verify: in the end, `sleeper.calls === 4` — without the reset, it would have exited before the third delivery.

### How the outside knows that the worker exited

Two observation interfaces:

```typescript
teammates.idleTimeoutCount(name)      // How many times this teammate exited because of empty spins
await teammates.waitForIdleTimeout(name)  // Wait until this teammate's current empty-spin exit
```

These two are the key to stable convergence in this chapter's tests and experiments — you do not need a `sleep(60000)` and then a guess whether the process exited. You `await` an explicit signal directly. When a `send()` finds the teammate in the Idle state, it calls `#wakeWorker` (which internally only does `worker.pollWakeup?.abort()`), interrupts the wait, and restarts the worker.

### The wake-up and sleep implementation

The default `AsyncioWorkStealingSleeper.sleep()` logic: if the `wakeup` is already aborted, return immediately. Otherwise, let `setTimeout` race against the `wakeup` abort event. Whoever arrives first ends the wait. This way, the 5-second interval can sleep in full normally, and a new message can also interrupt it immediately.

---

## Composition Root: It Must Share the Same Runtime

At construction time, `WorkStealingRuntime` checks whether the `claimService.store` is its own store:

```typescript
if (claimService.store !== options.store) {
  throw new Error("claimService must use the WorkStealingRuntime store");
}
```

Why so strict? Because if the Lead's tools point at store A, and the teammates' automatic claim points at store B, then the teammates never see the tasks that the Lead creates. And the Lead never knows about the tasks that the teammates complete. This mismatch does not produce an error. It only shows up as "the system seems not to work" — extremely hard to debug. Prefer to blow up at startup.

In `src/bootstrap.ts`, the Lead tools, the subagent tools and the teammate tools all take from the same `deps.workStealingRuntime`:

```typescript
registerLeasedTaskTools(tools, deps.workStealingRuntime.store, deps.workStealingRuntime.claimService);
```

The configuration order is also fixed:

```text
configureProtocol(protocolRuntime)      ← The protocol must be configured first
        ↓
configureWorkStealing(workStealingRuntime)  ← It depends on the protocol for the plan gate
        ↓
configureRunnerFactory(...)             ← The Runner factory is configured last
```

`configureWorkStealing` carries two explicit checks (`src/features/teammates.ts:231`):

| Check | Throws |
| --- | --- |
| It was already configured, or the runtime already started | `TeammateStateError("Work-stealing runtime must be configured once before start")` |
| The protocol runtime is not configured yet | `TeammateStateError("Work-stealing runtime requires Protocol runtime")` |

The second one corresponds to the `if (protocol === undefined) throw` branch in the idle loop — the gate check must not be skippable, so the protocol must be in place first. The first test in `tests/ch17-runtime.test.ts` verifies exactly this: call `configureWorkStealing` without configuring the protocol, and expect a `TeammateStateError`.

### Two run entries

| Entry | Command | Note |
| --- | --- | --- |
| Chapter-specific | `npm run ch17 -- --prompt "..."` | Always runs P17 |
| General CLI | `npm run agent-tutorial -- run --chapter 17 --prompt "..."` | `--chapter` decides the capability bits |

In the general CLI, the SQLite store is constructed conditionally, by capability bit (`src/cli.ts`):

```typescript
const workStealingRuntime = profile.capabilities.has("task_dag_sqlite")
  ? new WorkStealingRuntime({ store: new SqliteTaskStore(workspace) })
  : undefined;
```

---

## Run Chapter 17

This section starts from zero and runs it step by step. **Steps 0 to 3 need no API key**.

### Step 0: confirm the environment

```powershell
node --version
npm --version
```

Node must be 22 or higher. Measured in this article:

```text
v25.7.0
11.19.0
```

### Step 1: enter the code directory

```powershell
Set-Location 'F:\笔记\Agent实操\code'
Test-Path package.json
```

It should output:

```text
True
```

If it outputs `False`, the path is wrong. This repo's code directory is `code`. All npm commands run here.

### Step 2: install the dependencies

```powershell
npm install
```

This chapter adds two runtime dependencies: `sql.js` (the WASM version of SQLite) and `proper-lockfile` (the cross-process file lock). They install together with `npm install`. You do not need to install SQLite separately.

### Step 3: run the tests first, and confirm the baseline is good

```powershell
npm run test:ch17
```

Measured output:

```text
> agent-tutorial@0.1.0 test:ch17
> vitest run chapters/ch17/tests

 RUN  v4.1.10 F:/笔记/Agent实操/code

Runtime Failure: CLI execution or cleanup failed
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL

 Test Files  54 passed (54)
      Tests  369 passed (369)
   Start at  22:33:02
   Duration  6.61s
```

Two lines like these will be mixed into the output. **This is normal**:

```text
Runtime Failure: CLI execution or cleanup failed
Configuration Error: Missing required settings: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
```

The entry test is verifying that "with no credentials configured, the program should fail cleanly and return exit code 2". It deliberately triggers these two error outputs. As long as `Test Files` and `Tests` are all green in the end, there is no problem.

Of the 54 test files, Chapter 17's own are 5 (20 tests in total). To run only this chapter's:

```powershell
npx vitest run chapters/ch17/tests/ch17-task-sqlite.test.ts chapters/ch17/tests/ch17-work-stealing.test.ts chapters/ch17/tests/ch17-runtime.test.ts chapters/ch17/tests/ch17-bootstrap.test.ts chapters/ch17/tests/ch17-entry.test.ts
```

Measured:

```text
 Test Files  5 passed (5)
      Tests  20 passed (20)
   Duration  2.33s
```

### Step 4: configure the model credentials

```powershell
New-Item -ItemType File -Path .env -Force
```

Then write three lines into `.env`:

```text
OPENAI_BASE_URL=https://your-endpoint/v1
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=your-model-name
```

All three are required. If any one is missing, the startup fails with exit code 2, and prints which ones are missing — that is the `Configuration Error:` line you saw in step 3.
### Step 5: run it for real once

```powershell
npm run ch17 -- --prompt "Create three tasks: Fetch data, Clean data, Generate the report (depends on the first two), then send a teammate to do them"
```

#### What you should see

The Lead first calls `create_task` to build the tasks, then `spawn_teammate` to start a teammate. After the teammate starts, if it has an approved plan (or never submitted a plan), it calls `claimNext` itself when idle, to claim a task. In its context you will see a prompt that starts with `<auto-claimed-task>`.

The specific trace depends on the model. But the following things are guaranteed by the mechanism:

- The same task is not obtained by two teammates at the same time;
- `Generate the report` is not claimed before the first two complete;
- Every completion must present the token.

### Step 6: look at what remains on disk

```powershell
Get-ChildItem -Recurse .agent_tutorial | Select-Object FullName
```

This chapter adds one `tasks.sqlite3`. It is a binary file. `Get-Content` cannot read it. To see the content, use the `sql.js` that step 3 already installed, or use Experiment 3's probe script later directly.

During the run, `tasks.sqlite3.lock` and `.{uuid}.tmp` also appear briefly: the first is the cross-process write lock, the second is the temporary file for persistence. After a normal end, neither remains. **If you see a leftover `.lock`**, a process exited abnormally. The `stale` setting is 30 seconds. After 30 seconds, the next process judges it invalid, and takes over.

### Step 7: clean up and do it again

```powershell
Remove-Item -Recurse -Force .agent_tutorial
```

⚠️ This command deletes all local state: the task board, the Mailbox, protocol requests, background jobs, Cron records. Execute it only when you are sure you do not need the scene.

After you delete it and run step 5 again, you get a completely new, empty task board.

### The general entry

```powershell
npm run agent-tutorial -- run --chapter 17 --prompt "Create two tasks and let the teammates claim them themselves"
```

Both `--chapter` and `--prompt` are required. If one is missing, the program reports `Both --chapter and --prompt are required`. If you write an argument name wrongly, it reports `Unknown argument: xxx`.

### The wakeup loop: teammate results and Cron both connect to the Runner

The current `src/cli.ts` already binds `teammateRuntime.bindWakeup(...)` and `cronRuntime.bindWakeup(...)` at the same time. After a teammate result reaches the Lead, it requests an independent event turn. A teammate's own polling still keeps `pollIntervalSeconds` as a fallback. A wakeup signal ends the wait early when a new result exists.

When you assemble a host by hand, you must keep this binding. If you want to verify the polling wakeup separately, you can still drive the `TeammateRuntime` directly, in the experiments' way.

### Troubleshooting common errors

| Error | Cause | How to solve it |
| --- | --- | --- |
| `Configuration Error: Missing required settings: ...` | `.env` lacks a field | Fill in `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` |
| `Both --chapter and --prompt are required` | The general CLI got too few arguments | Pass both |
| `Unknown argument: --promt` | The argument name is misspelled | Change it to `--prompt` |
| `workStealingRuntime is required for chapter 17 or later` | You built your own composition root and missed it | Pass the `workStealingRuntime` in |
| `taskStore requires chapter 12 or later` / `taskStore is required...` | P17 got a JSON `taskStore` | P17 uses only the `workStealingRuntime`. Do not pass a `taskStore` |
| `claimService must use the WorkStealingRuntime store` | The `claimService` and the runtime use different stores | Let both share the same `SqliteTaskStore` instance |
| `Work-stealing runtime requires Protocol runtime` | You did not `configureProtocol` first | Configure in the order protocol → workStealing → runnerFactory |
| `Work-stealing runtime must be configured once before start` | You configured it twice, or only after start | Configure it once, before start |
| `TaskStorageError: SQLite Task database escapes workspace or is not a regular file` | The database path is a link / not a regular file | Delete the abnormal file at that path, and let it regenerate |
| `TaskStorageError: Unsupported SQLite Task schema version` | The database is at another schema version | This chapter does no migration. Delete `tasks.sqlite3` and rebuild |
| `TaskLeaseExpiredError: ... claim lease expired` | The task ran too long; the lease expired | Normal behavior; the task is back in pending, so claim it again |
| `Error [invalid_arguments]: Tool arguments failed schema validation` | You passed a field outside the schema | `strictObject` does not accept unknown fields. Check the argument names |
| A leftover `.lock` file | A process exited abnormally | Wait 30 seconds for automatic invalidation, or delete it by hand |

---
## 11 Hands-On Experiments

Do not take my word for any conclusion above. This section walks you through building a probe script, and runs the conclusions out one by one.

**No experiment needs an API key**, because they call the library directly. They do not go through a real model.

### Preparation: create a probe script first

```powershell
Set-Location 'F:\笔记\Agent实操\code'
New-Item -ItemType File -Path scripts\probe-ch17.mts -Force
```

First write the common header. This block is the tool functions that all experiments share. Paste it in once:

```typescript
// scripts/probe-ch17.mts —— the Chapter 17 probe script (temporary; you can delete it after the run)
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import initSqlJs from "sql.js";

import { JsonBackgroundJobStore } from "../chapters/ch17/src/adapters/background-json.js";
import { JsonCronStore } from "../chapters/ch17/src/adapters/cron-json.js";
import { FileMailboxStore } from "../chapters/ch17/src/adapters/mailbox-json.js";
import { JsonProtocolStore } from "../chapters/ch17/src/adapters/protocol-json.js";
import { JsonTaskStore } from "../chapters/ch17/src/adapters/task-json.js";
import { SqliteTaskStore } from "../chapters/ch17/src/adapters/task-sqlite.js";
import { EventInbox } from "../chapters/ch17/src/core/events.js";
import { AgentRunner } from "../chapters/ch17/src/core/loop.js";
import { assistantMessage, toolCall } from "../chapters/ch17/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch17/src/core/model.js";
import { ToolRegistry } from "../chapters/ch17/src/core/tools.js";
import { JobSupervisor } from "../chapters/ch17/src/features/background.js";
import { CronRuntime } from "../chapters/ch17/src/features/cron.js";
import {
  createProtocolMailboxMessage,
  ProtocolMessageKind,
} from "../chapters/ch17/src/features/mailbox.js";
import { ProtocolRequestKind, ProtocolRuntime } from "../chapters/ch17/src/features/protocol.js";
import { TaskStatus } from "../chapters/ch17/src/features/tasks.js";
import { TeammateRuntime } from "../chapters/ch17/src/features/teammates.js";
import {
  leasedTaskToolDefinitions,
  registerTeammateLeasedTaskTools,
  WorkStealingRuntime,
  type WorkStealingSleeper,
} from "../chapters/ch17/src/features/work-stealing.js";

const require = createRequire(import.meta.url);
const EXPERIMENT = process.argv[2] ?? "all";
const CLOCK_BASE = new Date("2026-07-27T14:00:00.000Z");

function section(name: string): boolean {
  const selected = EXPERIMENT === "all" || EXPERIMENT === name;
  if (selected) console.log(`\n===== ${name} =====`);
  return selected;
}

async function withTempDir<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "probe-ch17-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function seqId(start = 0x1701): () => string {
  let next = start;
  return () => {
    const hex = next.toString(16).padStart(12, "0");
    next += 1;
    return `00000000-0000-4000-8000-${hex}`;
  };
}

class Clock {
  value = new Date(CLOCK_BASE);
  now(): Date {
    return new Date(this.value);
  }
}

function errorLine(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name}: ${error.message}`;
  return `unknown error: ${String(error)}`;
}

function short(id: string): string {
  return id.slice(-4);
}

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

class ImmediateSleeper implements WorkStealingSleeper {
  readonly calls: number[] = [];
  async sleep(seconds: number, _wakeup: AbortSignal): Promise<void> {
    this.calls.push(seconds);
  }
}

class PromptRecordingModel implements ModelClient {
  readonly prompts: string[] = [];
  async complete(request: ModelRequest): Promise<ModelReply> {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content.startsWith("<auto-claimed-task>")) {
      this.prompts.push(last.content);
      const payload = JSON.parse(last.content.split("\n")[1] ?? "{}") as {
        readonly claim_token?: string;
        readonly task?: { readonly id?: string };
      };
      return {
        message: assistantMessage(null, [
          toolCall(
            "auto-complete",
            "complete_task",
            JSON.stringify({ task_id: payload.task?.id, claim_token: payload.claim_token }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (last?.role === "tool") {
      return { message: assistantMessage("auto task completed"), finishReason: "stop" };
    }
    return { message: assistantMessage("ready"), finishReason: "stop" };
  }
}

interface TeamHarness {
  readonly teammates: TeammateRuntime;
  readonly protocol: ProtocolRuntime;
  readonly tasks: SqliteTaskStore;
  readonly workStealing: WorkStealingRuntime;
  readonly model: PromptRecordingModel;
  close(): Promise<void>;
}

async function makeTeam(
  root: string,
  options: { readonly maxIdlePolls?: number; readonly sleeper?: WorkStealingSleeper } = {},
): Promise<TeamHarness> {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root),
    inbox,
    supervisor,
    clock: { now: () => new Date(CLOCK_BASE) },
  });
  const teammates = new TeammateRuntime({
    store: new FileMailboxStore(root),
    inbox,
    supervisor,
    cronRuntime: cron,
  });
  const tasks = new SqliteTaskStore(root, {
    idGenerator: seqId(0x1721),
    claimTokenGenerator: seqId(0x1731),
  });
  const workStealing = new WorkStealingRuntime({
    store: tasks,
    sleeper: options.sleeper ?? new ImmediateSleeper(),
    maxIdlePolls: options.maxIdlePolls ?? 2,
  });
  const model = new PromptRecordingModel();
  const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
  teammates.configureProtocol(protocol);
  teammates.configureWorkStealing(workStealing);
  teammates.configureRunnerFactory((name, role, sendDefinition) => {
    const tools = new ToolRegistry();
    tools.register(sendDefinition);
    registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
    return new AgentRunner({
      model,
      tools,
      systemPrompt: `You are ${name}, serving as ${role}.`,
      workspace: root,
      identity: name,
    });
  });
  return {
    teammates,
    protocol,
    tasks,
    workStealing,
    model,
    async close() {
      await teammates.close();
      await cron.close();
      await supervisor.close();
    },
  };
}

async function approvePlan(protocol: ProtocolRuntime, teammate: string): Promise<void> {
  const plan = await protocol.store.createRequest({
    kind: ProtocolRequestKind.PlanApproval,
    sender: teammate,
    target: "lead",
    content: "Complete the SQLite task.",
  });
  await protocol.store.consumeResponse(
    createProtocolMailboxMessage({
      id: "00000000-0000-4000-8000-000000001741",
      sender: "lead",
      recipient: teammate,
      kind: ProtocolMessageKind.PlanApprovalResponse,
      requestId: plan.id,
      content: "Approved",
      approved: true,
      createdAtUtc: new Date(CLOCK_BASE),
    }),
  );
}

function claimInSpawnedProcess(workspace: string, owner: string): Promise<string | undefined> {
  const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
  const program = join(
    process.cwd(),
    "chapters",
    "ch17",
    "tests",
    "fixtures",
    "ch17-claim-child.ts",
  );
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [tsxCli, program, workspace, owner], {
      cwd: join(process.cwd(), "chapters", "ch17"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectResult);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`child process failed (${String(code)}): ${stderr}`));
        return;
      }
      const claim = stdout.trim();
      resolveResult(claim.length === 0 ? undefined : claim);
    });
  });
}
```

Six things in the header deserve an explanation first:

**`section(name)`** lets one script hold all experiments. `npx tsx scripts/probe-ch17.mts lease` runs only the `lease` block. With no argument, it runs everything.

**`withTempDir`** opens a brand-new workspace in the system temporary directory for each experiment, and deletes it after the run. So the experiments do not affect each other, and they do not pollute your repo.

**`seqId(start)`** generates predictable UUIDs: `seqId(0x1701)` produces `...1701`, `...1702`, … in sequence. The real code uses `randomUUID`. But the experiments need IDs that they can match up, so they inject this generator. The `…1701` in the output is its last four digits.

**`Clock`** is a clock that you can advance by hand. The `clock` parameter of `SqliteTaskStore` exists for this — to test lease expiry, you do not need to really wait 30 seconds. Just turn `clock.value` forward.

**`readSqlite`** reads the database file directly with `sql.js`. Because `tasks.sqlite3` is binary, this is the only way to see the rows inside.

**`makeTeam`** assembles the runtimes of Chapters 15, 16 and 17 into a minimal runnable team: the Mailbox, the protocol, the background supervisor, Cron, the SQLite task board, and the work stealing runtime. `PromptRecordingModel` is a fake model. When it recognises an `<auto-claimed-task>` prompt, it calls `complete_task`. At the same time, it records the prompts it received.

**How to run it** is `npx tsx scripts/probe-ch17.mts <experiment name>`. Each experiment below tells you its name.

---

### Experiment 1 (trace): one complete self-driven claim

Append:

```typescript
if (section("trace")) {
  await withTempDir(async (root) => {
    const clock = new Clock();
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1701),
      claimTokenGenerator: seqId(0x1711),
      clock,
      leaseDurationMs: 60_000,
    });
    const step = (index: number, text: string): void => console.log(`[${index}] ${text}`);
    const a = await store.createTask({ subject: "Fetch data" });
    const b = await store.createTask({ subject: "Clean data" });
    const c = await store.createTask({ subject: "Generate the report", blockedBy: [a.id, b.id] });
    step(1, `The Lead created three tasks: A=…${short(a.id)} B=…${short(b.id)} C=…${short(c.id)} (C depends on A and B)`);
    step(2, `The task board now: ${(await store.listTasks()).map((task) => `${task.subject}(${task.status})`).join(" ")}`);
    const alice = await store.claimNext("alice");
    if (alice === undefined) throw new Error("alice should have claimed successfully");
    step(
      3,
      `alice polls and finds work: ${alice.task.subject} token=…${short(alice.claimToken)} lease until ${alice.leaseExpiresAtUtc.toISOString()}`,
    );
    const bob = await store.claimNext("bob");
    if (bob === undefined) throw new Error("bob should have claimed successfully");
    step(4, `bob polls at the same time, and gets a different one: ${bob.task.subject} token=…${short(bob.claimToken)}`);
    step(5, `carol polls too: claimNext → ${String(await store.claimNext("carol"))} (C's dependencies are not complete yet)`);
    clock.value = new Date(CLOCK_BASE.getTime() + 5_000);
    const doneA = await store.completeTask(a.id, "alice", alice.claimToken);
    step(
      6,
      `alice presents the token and completes A → unblocked=[${doneA.unblocked.map((task) => task.subject).join(", ")}] (C still lacks B)`,
    );
    const doneB = await store.completeTask(b.id, "bob", bob.claimToken);
    step(
      7,
      `bob completes B → unblocked=[${doneB.unblocked.map((task) => task.subject).join(", ")}] (C is unblocked)`,
    );
    const carol = await store.claimNext("carol");
    if (carol === undefined) throw new Error("carol should have claimed successfully");
    step(8, `On her next polling round, carol gets it: ${carol.task.subject} token=…${short(carol.claimToken)}`);
    await store.completeTask(c.id, "carol", carol.claimToken);
    step(9, `carol completes C, the task board is empty: ${(await store.listTasks()).map((task) => `${task.subject}(${task.status})`).join(" ")}`);
    const query = await readSqlite(store.databasePath);
    step(10, `The token history table holds ${query("SELECT token FROM task_claim_tokens").length} entries in total; they cannot be reused for the whole life cycle`);
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts trace
```

Real output:

```text
===== trace =====
[1] The Lead created three tasks: A=…1701 B=…1702 C=…1703 (C depends on A and B)
[2] The task board now: Fetch data(pending) Clean data(pending) Generate the report(pending)
[3] alice polls and finds work: Fetch data token=…1711 lease until 2026-07-27T14:01:00.000Z
[4] bob polls at the same time, and gets a different one: Clean data token=…1712
[5] carol polls too: claimNext → undefined (C's dependencies are not complete yet)
[6] alice presents the token and completes A → unblocked=[] (C still lacks B)
[7] bob completes B → unblocked=[Generate the report] (C is unblocked)
[8] On her next polling round, carol gets it: Generate the report token=…1713
[9] carol completes C, the task board is empty: Fetch data(completed) Clean data(completed) Generate the report(completed)
[10] The token history table holds 3 entries in total; they cannot be reused for the whole life cycle
```

**What to verify:** alice and bob get different tasks; carol gets `undefined` while the dependencies are incomplete; when A completes, `unblocked` is empty; only when B completes is C unblocked.

**A quick variation:** change `blockedBy: [a.id, b.id]` to `blockedBy: [a.id]`, and look at whether the `unblocked` on line `[6]` immediately becomes `[Generate the report]`.

---

### Experiment 2 (backend): the SQLite and JSON back-ends are invisible to each other

Append:

```typescript
if (section("backend")) {
  await withTempDir(async (root) => {
    const sqlite = new SqliteTaskStore(root, { idGenerator: seqId(0x1701) });
    const json = new JsonTaskStore(root);
    const created = await sqlite.createTask({ subject: "written only into SQLite" });
    console.log(`SQLite database path: ${sqlite.databasePath.replace(root, "<root>")}`);
    console.log(`SQLite listTasks(): ${(await sqlite.listTasks()).length} entries`);
    console.log(`JSON  listTasks(): ${(await json.listTasks()).length} entries`);
    console.log(`The task in SQLite: ${short(created.id)} / ${created.subject}`);
    await json.createTask({ subject: "written only into JSON" });
    console.log(`--- after JSON also writes one ---`);
    console.log(`SQLite listTasks(): ${(await sqlite.listTasks()).length} entries`);
    console.log(`JSON  listTasks(): ${(await json.listTasks()).length} entries`);
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts backend
```

Real output:

```text
===== backend =====
SQLite database path: <root>\.agent_tutorial\tasks.sqlite3
SQLite listTasks(): 1 entry
JSON  listTasks(): 0 entries
The task in SQLite: 1701 / written only into SQLite
--- after JSON also writes one ---
SQLite listTasks(): 1 entry
JSON  listTasks(): 1 entry
```

**What to verify:** the two stores use the same workspace directory, but each writes its own file. Neither side can see the other's tasks. This is the actual meaning of "no migration, no dual write".

---

### Experiment 3 (schema): the table schema and the real rows

Append:

```typescript
if (section("schema")) {
  await withTempDir(async (root) => {
    const clock = new Clock();
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1701),
      claimTokenGenerator: seqId(0x1711),
      clock,
      leaseDurationMs: 30_000,
    });
    const a = await store.createTask({ subject: "Task A" });
    await store.createTask({ subject: "Task B", blockedBy: [a.id] });
    await store.claimTask(a.id, "alice");
    const query = await readSqlite(store.databasePath);
    console.log("Table list:");
    for (const row of query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")) {
      console.log(`  ${String(row.name)}`);
    }
    console.log(`schema_version: ${String(query("SELECT value FROM task_metadata")[0]?.value)}`);
    console.log("tasks rows (by sequence):");
    for (const row of query(
      "SELECT sequence, id, status, owner, claim_token, lease_expires_at_utc FROM tasks ORDER BY sequence",
    )) {
      console.log(
        `  seq=${String(row.sequence)} id=…${short(String(row.id))} status=${String(row.status)}` +
          ` owner=${String(row.owner)} token=${row.claim_token === null ? "null" : `…${short(String(row.claim_token))}`}` +
          ` lease=${String(row.lease_expires_at_utc)}`,
      );
    }
    console.log("task_dependencies rows:");
    for (const row of query("SELECT task_id, dependency_id, position FROM task_dependencies")) {
      console.log(
        `  task=…${short(String(row.task_id))} dep=…${short(String(row.dependency_id))} position=${String(row.position)}`,
      );
    }
    console.log("task_claim_tokens rows:");
    for (const row of query("SELECT token, task_id FROM task_claim_tokens")) {
      console.log(`  token=…${short(String(row.token))} task=…${short(String(row.task_id))}`);
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts schema
```

Real output:

```text
===== schema =====
Table list:
  sqlite_sequence
  task_claim_tokens
  task_dependencies
  task_metadata
  tasks
schema_version: 1
tasks rows (by sequence):
  seq=1 id=…1701 status=in_progress owner=alice token=…1711 lease=2026-07-27T14:00:30.000Z
  seq=2 id=…1702 status=pending owner=null token=null lease=null
task_dependencies rows:
  task=…1702 dep=…1701 position=0
task_claim_tokens rows:
  token=…1711 task=…1701
```

**What to verify:** `sqlite_sequence` is created automatically by SQLite for `AUTOINCREMENT`; `seq` is the creation order; the `in_progress` row has owner/token/lease all present, and the `pending` row has all three as `null` (the effect of the CHECK constraint).

**A quick variation:** delete the `claimTask` line and run again. Look at whether both rows become `pending`, and whether `task_claim_tokens` is empty.

---

### Experiment 4 (order): creation order, dependency gating, and a three-way contest

Append:

```typescript
if (section("order")) {
  await withTempDir(async (root) => {
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1701),
      claimTokenGenerator: seqId(0x1711),
    });
    const a = await store.createTask({ subject: "A (no dependencies)" });
    const b = await store.createTask({ subject: "B (no dependencies)" });
    const c = await store.createTask({ subject: "C (depends on A, B)", blockedBy: [a.id, b.id] });
    console.log(`Creation order: ${(await store.listTasks()).map((task) => task.subject).join(" → ")}`);
    const first = await store.claimNext("alice");
    const second = await store.claimNext("bob");
    const third = await store.claimNext("charlie");
    console.log(`alice   claimNext → ${first === undefined ? "undefined" : first.task.subject}`);
    console.log(`bob     claimNext → ${second === undefined ? "undefined" : second.task.subject}`);
    console.log(`charlie claimNext → ${third === undefined ? "undefined" : String(third)}`);
    if (first === undefined || second === undefined) throw new Error("the first two claims should succeed");
    await store.completeTask(a.id, "alice", first.claimToken);
    const afterA = await store.claimNext("charlie");
    console.log(`After only A completes, charlie claimNext → ${afterA === undefined ? "undefined" : "got one"}`);
    const completion = await store.completeTask(b.id, "bob", second.claimToken);
    console.log(`After B completes, unblocked: ${completion.unblocked.map((task) => task.subject).join(", ")}`);
    const afterBoth = await store.claimNext("charlie");
    console.log(
      `After both A and B complete, charlie claimNext → ${afterBoth === undefined ? "undefined" : afterBoth.task.subject}`,
    );
    console.log(`C's current status: ${(await store.getTask(c.id)).status}`);
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts order
```

Real output:

```text
===== order =====
Creation order: A (no dependencies) → B (no dependencies) → C (depends on A, B)
alice   claimNext → A (no dependencies)
bob     claimNext → B (no dependencies)
charlie claimNext → undefined
After only A completes, charlie claimNext → undefined
After B completes, unblocked: C (depends on A, B)
After both A and B complete, charlie claimNext → C (depends on A, B)
C's current status: in_progress
```

**What to verify:** alice gets A, bob gets B. The order strictly follows creation order. When only one dependency completes, charlie still cannot get C. `unblocked` contains C only when the last dependency completes.

---

### Experiment 5 (cross-process): two real processes, only one can claim

This experiment spawns two independent Node processes. Each runs `claimNext` once. It uses the repo's existing test fixture `chapters/ch17/tests/fixtures/ch17-claim-child.ts` (10 lines; it does one thing: on a successful claim, it prints the task ID to stdout).

Append:

```typescript
if (section("cross-process")) {
  await withTempDir(async (root) => {
    const store = new SqliteTaskStore(root, { idGenerator: seqId(0x1701) });
    const task = await store.createTask({ subject: "only one process can get it" });
    const [left, right] = await Promise.all([
      claimInSpawnedProcess(root, "alice"),
      claimInSpawnedProcess(root, "bob"),
    ]);
    console.log(`Child process 1 stdout: ${left === undefined ? "(empty)" : `…${short(left)}`}`);
    console.log(`Child process 2 stdout: ${right === undefined ? "(empty)" : `…${short(right)}`}`);
    const winners = [left, right].filter((value) => value !== undefined);
    console.log(`Processes that got the task: ${winners.length}`);
    console.log(`What they got is that task: ${winners[0] === task.id}`);
    const current = await store.getTask(task.id);
    console.log(`Task final state: status=${current.status} owner=${String(current.owner)}`);
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts cross-process
```

Real output:

```text
===== cross-process =====
Child process 1 stdout: …1701
Child process 2 stdout: (empty)
Processes that got the task: 1
What they got is that task: true
Task final state: status=in_progress owner=alice
```

**What to verify:** this is the thing that an in-memory lock cannot do. Two real processes claim concurrently. Only one gets the task. The other's stdout is empty (its `claimNext` returned `undefined`). It does not error. Cross-process mutual exclusion relies on the `.lock` file + `BEGIN IMMEDIATE`.

Which process wins is not deterministic (this time it was alice). But "only one wins" is deterministic. Run it a few more times and look.

---

### Experiment 6 (lease): the boundary of the half-open interval

Append:

```typescript
if (section("lease")) {
  await withTempDir(async (root) => {
    const clock = new Clock();
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1701),
      claimTokenGenerator: seqId(0x1711),
      clock,
      leaseDurationMs: 30_000,
    });
    const task = await store.createTask({ subject: "a task that will expire" });
    const claim = await store.claimTask(task.id, "alice");
    console.log(`Claim moment:     ${clock.now().toISOString()}`);
    console.log(`Lease deadline:   ${claim.leaseExpiresAtUtc.toISOString()}`);
    console.log(`claim token:  …${short(claim.claimToken)}`);

    clock.value = new Date(CLOCK_BASE.getTime() + 29_999);
    console.log(`\n--- Time pushed to +29999ms (inside the lease) ---`);
    console.log(`Current moment: ${clock.now().toISOString()}`);
    console.log(`claimNext("bob") → ${(await store.claimNext("bob")) === undefined ? "undefined (cannot get it)" : "got it"}`);

    clock.value = new Date(CLOCK_BASE.getTime() + 30_000);
    console.log(`\n--- Time pushed to +30000ms (exactly equal to the deadline) ---`);
    console.log(`Current moment: ${clock.now().toISOString()}`);
    try {
      await store.completeTask(task.id, "alice", claim.claimToken);
      console.log("Completion succeeded (should not appear)");
    } catch (error) {
      console.log(`alice completes with the original token → ${errorLine(error)}`);
    }
    const back = await store.getTask(task.id);
    console.log(`The task is back at: status=${back.status} owner=${String(back.owner)}`);
    const replacement = await store.claimNext("bob");
    if (replacement === undefined) throw new Error("after expiry, it should be claimable again");
    console.log(`bob claims it again → token=…${short(replacement.claimToken)} deadline=${replacement.leaseExpiresAtUtc.toISOString()}`);
    try {
      await store.completeTask(task.id, "alice", claim.claimToken);
      console.log("Completion with the old token succeeded (should not appear)");
    } catch (error) {
      console.log(`alice completes again with the old token → ${errorLine(error)}`);
    }
    const done = await store.completeTask(task.id, "bob", replacement.claimToken);
    console.log(`bob completes with the new token → status=${done.task.status}`);
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts lease
```

Real output:

```text
===== lease =====
Claim moment:     2026-07-27T14:00:00.000Z
Lease deadline:   2026-07-27T14:00:30.000Z
claim token:  …1711

--- Time pushed to +29999ms (inside the lease) ---
Current moment: 2026-07-27T14:00:29.999Z
claimNext("bob") → undefined (cannot get it)

--- Time pushed to +30000ms (exactly equal to the deadline) ---
Current moment: 2026-07-27T14:00:30.000Z
alice completes with the original token → TaskLeaseExpiredError: Task 00000000-0000-4000-8000-000000001701 claim lease expired
The task is back at: status=pending owner=null
bob claims it again → token=…1712 deadline=2026-07-27T14:01:00.000Z
alice completes again with the old token → TaskClaimError: Task 00000000-0000-4000-8000-000000001701 owner or claim token does not match the active claim
bob completes with the new token → status=completed
```

**What to verify:** at `+29999ms`, bob cannot get it (the lease is still valid). At `+30000ms`, alice cannot complete it (the lease has expired) — the boundary of the half-open interval is exactly this millisecond. After expiry, the task automatically returns to `pending`/`owner=null`. When bob claims it again, he gets a **new** token. alice's old token is invalid from then on.

**A quick variation:** change `29_999` to `30_000`, and look at whether bob can grab the task at that moment.

---

### Experiment 7 (token-history): the token is unique for the whole life cycle

Append:

```typescript
if (section("token-history")) {
  await withTempDir(async (root) => {
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1701),
      // Deliberately make the token generator return the same value every time, to simulate a collision.
      claimTokenGenerator: () => "00000000-0000-4000-8000-000000001711",
    });
    const first = await store.createTask({ subject: "first one" });
    const second = await store.createTask({ subject: "second one" });
    const claim = await store.claimTask(first.id, "alice");
    console.log(`First claim, token obtained: …${short(claim.claimToken)}`);
    try {
      await store.claimTask(second.id, "bob");
      console.log("Second claim succeeded (should not appear)");
    } catch (error) {
      console.log(`Second claim (the same token) → ${errorLine(error)}`);
    }
    const untouched = await store.getTask(second.id);
    console.log(`The second task is still: status=${untouched.status} owner=${String(untouched.owner)}`);
    console.log("Note: the token conflict rolled the whole claim transaction back. It left no half state.");
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts token-history
```

Real output:

```text
===== token-history =====
First claim, token obtained: …1711
Second claim (the same token) → TaskStorageError: Generated claim token already exists
The second task is still: status=pending owner=null
Note: the token conflict rolled the whole claim transaction back. It left no half state.
```

**What to verify:** the second task **did not change at all**. This is the payoff of putting the `INSERT INTO task_claim_tokens` before the conditional `UPDATE` — the conflict happens before any state is modified. The `ROLLBACK` needs to compensate for nothing.

**A quick variation:** first complete the first task with `completeTask` (this clears `tasks.claim_token` to `NULL`), then claim the second one. You will see that it **still** reports `Generated claim token already exists` — because the record in the history table is never deleted. This is exactly why the history table exists: the `UNIQUE` constraint on `tasks.claim_token` loses its grip after the value is cleared.

---

### Experiment 8 (tools): the five tools and the role cut-down

Append:

```typescript
if (section("tools")) {
  await withTempDir(async (root) => {
    const store = new SqliteTaskStore(root, { idGenerator: seqId(0x1701) });
    const runtime = new WorkStealingRuntime({ store });
    const tools = new ToolRegistry();
    for (const tool of runtime.leadToolDefinitions) tools.register(tool);
    console.log(`Lead   tool set: ${runtime.leadToolDefinitions.map((tool) => tool.name).join(", ")}`);
    console.log(`Teammate   tool set: ${runtime.teammateToolDefinitions.map((tool) => tool.name).join(", ")}`);
    console.log(`The teammate lacks: ${
      runtime.leadToolDefinitions
        .map((tool) => tool.name)
        .filter((name) => !runtime.teammateToolDefinitions.some((tool) => tool.name === name))
        .join(", ")
    }`);
    console.log("\nEach tool's effect and parameters:");
    const effects = new Map(
      leasedTaskToolDefinitions(store).map((tool) => [tool.name, tool.effect]),
    );
    for (const schema of tools.openAITools()) {
      const parameters = schema.function.parameters as {
        readonly required?: readonly string[];
        readonly properties?: Readonly<Record<string, unknown>>;
      };
      console.log(
        `  ${schema.function.name.padEnd(13)} effect=${String(effects.get(schema.function.name)).padEnd(5)}` +
          ` parameters=[${Object.keys(parameters.properties ?? {}).join(", ")}]` +
          ` required=[${(parameters.required ?? []).join(", ")}]`,
      );
    }
    console.log(`\nmaxIdlePolls default = ${runtime.maxIdlePolls}`);
    // description / blocked_by appear in required because they carry a .default() in the schema;
    // at runtime, passing only a subject still succeeds; the line below verifies this.
    const onlySubject = tools.prepare({
      id: "t1",
      name: "create_task",
      arguments: JSON.stringify({ subject: "passed only a subject" }),
    });
    const created = await tools.invoke(onlySubject, { workspace: root, identity: "lead" });
    console.log(`Call create_task with only a subject → isError=${created.isError}`);
    console.log(`  ${created.content}`);
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts tools
```

Real output:

```text
===== tools =====
Lead   tool set: create_task, get_task, list_tasks, claim_task, complete_task
Teammate   tool set: get_task, list_tasks, claim_task, complete_task
The teammate lacks: create_task

Each tool's effect and parameters:
  create_task   effect=write parameters=[subject, description, blocked_by] required=[subject, description, blocked_by]
  get_task      effect=read  parameters=[task_id] required=[task_id]
  list_tasks    effect=read  parameters=[] required=[]
  claim_task    effect=write parameters=[task_id] required=[task_id]
  complete_task effect=write parameters=[task_id, claim_token] required=[task_id, claim_token]

maxIdlePolls default = 12
Call create_task with only a subject → isError=false
  {"blocked_by":[],"description":"","id":"00000000-0000-4000-8000-000000001701","owner":null,"status":"pending","subject":"passed only a subject"}
```

**What to verify:** the teammate's tool set has one fewer tool than the Lead's: `create_task`; `complete_task`'s required parameters are two — `task_id` + `claim_token` (Chapter 12 had only `task_id`); the `claim_task` parameters contain **no** owner.

The last two lines explain that `create_task`'s `description` / `blocked_by`, although they appear in the JSON Schema's `required` (because they carry a `.default()`), are not really required at runtime.

---

### Experiment 9 (identity): the owner comes from the identity, and cannot be forged

Append:

```typescript
if (section("identity")) {
  await withTempDir(async (root) => {
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1701),
      claimTokenGenerator: seqId(0x1711),
    });
    const runtime = new WorkStealingRuntime({ store });
    const tools = new ToolRegistry();
    registerTeammateLeasedTaskTools(tools, runtime.store, runtime.claimService);
    const call = async (
      id: string,
      name: string,
      args: Readonly<Record<string, unknown>>,
      identity: string,
    ): Promise<string> => {
      const prepared = tools.prepare({ id, name, arguments: JSON.stringify(args) });
      const result = await tools.invoke(prepared, { workspace: root, identity });
      return result.content;
    };
    const task = await store.createTask({ subject: "See where the owner comes from" });
    const claimed = await call("c1", "claim_task", { task_id: task.id }, "alice");
    console.log("claim_task returns (identity=alice):");
    console.log(`  ${claimed}`);
    const parsed = JSON.parse(claimed) as {
      readonly claim_token: string;
      readonly task: { readonly owner: string };
    };
    console.log(`\nThere is no owner field in the tool arguments. The identity decides the owner → ${parsed.task.owner}`);
    console.log(
      `\nbob completes with alice's token → ${await call("c2", "complete_task", { task_id: task.id, claim_token: parsed.claim_token }, "bob")}`,
    );
    console.log(
      `alice completes with her own token → ${await call("c3", "complete_task", { task_id: task.id, claim_token: parsed.claim_token }, "alice")}`,
    );
    console.log(
      `\nTrying to stuff an owner into the arguments → ${await call("c4", "claim_task", { task_id: task.id, owner: "carol" }, "bob")}`,
    );
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts identity
```

Real output (`lease_expires_at_utc` uses real time, so it differs on every run):

```text
===== identity =====
claim_task returns (identity=alice):
  {"claim_token":"00000000-0000-4000-8000-000000001711","lease_expires_at_utc":"2026-08-30T14:49:20.362Z","task":{"blocked_by":[],"description":"","id":"00000000-0000-4000-8000-000000001701","owner":"alice","status":"in_progress","subject":"See where the owner comes from"}}

There is no owner field in the tool arguments. The identity decides the owner → alice

bob completes with alice's token → Error [task_claim_mismatch]: Task 00000000-0000-4000-8000-000000001701 owner or claim token does not match the active claim
alice completes with her own token → {"task":{"blocked_by":[],"description":"","id":"00000000-0000-4000-8000-000000001701","owner":"alice","status":"completed","subject":"See where the owner comes from"},"unblocked":[]}

Trying to stuff an owner into the arguments → Error [invalid_arguments]: Tool arguments failed schema validation
```

**What to verify:** four things. The `claim_task` arguments contain only `task_id`. The owner is `alice` because of `identity: "alice"`. bob cannot complete the task even with the correct token (the owner does not match). alice completes it normally with her own token. An attempt to stuff an `owner` into the arguments is rejected directly by `strictObject`, not silently ignored.

**A quick variation:** change the `identity` of the `c2` call from `"bob"` to `"alice"`, and look at whether it then succeeds — this shows that what blocked bob really was the identity, not the token.

---

### Experiment 10 (idle-loop): the complete idle loop claims and completes automatically

This experiment starts a real `TeammateRuntime`, configures the protocol, approves the plan, and then lets the teammate claim work itself.

Append:

```typescript
if (section("idle-loop")) {
  await withTempDir(async (root) => {
    const team = await makeTeam(root, { maxIdlePolls: 2 });
    try {
      await team.tasks.createTask({ subject: "autonomous" });
      await approvePlan(team.protocol, "alice");
      await team.teammates.start();
      await team.teammates.spawn({
        name: "alice",
        role: "worker",
        prompt: "be ready",
        sender: "lead",
      });
      const events = [
        ...(await team.teammates.waitForEvents(1)),
        ...(await team.teammates.waitForEvents(1)),
      ];
      console.log(`Events received: ${events.length}`);
      console.log(`\nThe auto-claim prompt the teammate received (${team.model.prompts.length} entry in total):`);
      for (const prompt of team.model.prompts) {
        for (const line of prompt.split("\n")) console.log(`  ${line.replace(root, "<root>")}`);
      }
      const tasks = await team.tasks.listTasks();
      console.log(`\nTask final state: ${tasks.map((task) => `${task.subject}=${task.status}`).join(", ")}`);
      await team.teammates.acknowledgeEvents(events);
      await team.teammates.waitForIdleTimeout("alice");
      console.log(`idleTimeoutCount("alice") = ${team.teammates.idleTimeoutCount("alice")}`);
      console.log(`drainEvents() = ${JSON.stringify(team.teammates.drainEvents())}`);
    } finally {
      await team.close();
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts idle-loop
```

Real output:

```text
===== idle-loop =====
Events received: 2

The auto-claim prompt the teammate received (1 entry in total):
  <auto-claimed-task>
  {"claim_token":"00000000-0000-4000-8000-000000001731","lease_expires_at_utc":"2026-08-30T14:51:51.694Z","task":{"blocked_by":[],"description":"","id":"00000000-0000-4000-8000-000000001721","owner":"alice","status":"in_progress","subject":"autonomous"}}
  </auto-claimed-task>

Task final state: autonomous=completed
idleTimeoutCount("alice") = 1
drainEvents() = []
```

**What to verify:** five things. The teammate received no "go and do this task" message at all. It claimed the task itself. The prompt is in the three-line `<auto-claimed-task>` format. The middle line is JSON. The JSON carries the token and the lease deadline, so the model can call `complete_task`. The task is finally `completed` (the model completed it explicitly). After the empty spins reach the limit, `idleTimeoutCount` becomes 1, and `drainEvents()` is empty — **no shutdown event was faked**.

The two events are: the result of the `prompt: "be ready"` at spawn time, and the result reported to the Lead after the automatically claimed task completed.

---

### Experiment 11 (plan-gate): without an approved plan, the worker never enters the claim

Append:

```typescript
if (section("plan-gate")) {
  await withTempDir(async (root) => {
    const sleeper = new ImmediateSleeper();
    const team = await makeTeam(root, { maxIdlePolls: 2, sleeper });
    try {
      const task = await team.tasks.createTask({ subject: "no claiming before the plan is approved" });
      // Only create the plan request, and do not consume the response: the latest plan stays at Pending.
      await team.protocol.store.createRequest({
        kind: ProtocolRequestKind.PlanApproval,
        sender: "alice",
        target: "lead",
        content: "Wait for the Lead to approve",
      });
      await team.teammates.start();
      await team.teammates.spawn({
        name: "alice",
        role: "worker",
        prompt: "be ready",
        sender: "lead",
      });
      const events = await team.teammates.waitForEvents(1);
      await team.teammates.acknowledgeEvents(events);
      await team.teammates.waitForIdleTimeout("alice");
      const current = await team.tasks.getTask(task.id);
      console.log(`Task state (plan not approved): ${current.status} owner=${String(current.owner)}`);
      console.log(`sleeper.calls = ${JSON.stringify(sleeper.calls)}  ← each element is the seconds of one polling wait`);
      console.log(`idleTimeoutCount("alice") = ${team.teammates.idleTimeoutCount("alice")}`);
      console.log(`Auto-claim prompt entries = ${team.model.prompts.length}`);
      console.log(`The task never left pending: ${current.status === TaskStatus.PENDING}`);
    } finally {
      await team.close();
    }
  });
}
```

Run:

```powershell
npx tsx scripts/probe-ch17.mts plan-gate
```

Real output:

```text
===== plan-gate =====
Task state (plan not approved): pending owner=null
sleeper.calls = [5,5]  ← each element is the seconds of one polling wait
idleTimeoutCount("alice") = 1
Auto-claim prompt entries = 0
The task never left pending: true
```

**What to verify:** the task board clearly has a ready task, yet the teammate never claimed it once. `Auto-claim prompt entries = 0` shows that `claimNext` was never called at all — the gate blocks **before** the claim, not with a rollback after the claim. `sleeper.calls = [5,5]` shows that it honestly spun empty for two rounds (`maxIdlePolls: 2`), 5 seconds per round — the default value of `pollIntervalSeconds`.

**A quick variation:** replace the block that creates the plan request with `await approvePlan(team.protocol, "alice");`. You will see the task claimed and completed immediately — that is Experiment 10.

---

### Clean up after the experiments

```powershell
Remove-Item scripts\probe-ch17.mts
git status --short
```

`git status --short` should have no output (or only changes that were yours anyway). The probe script is temporary. Do not leave it in the repo.

---
## What This Chapter Deliberately Does Not Do

By now you can probably guess what could "conveniently" be added next. I list it clearly, so that when you read the code you do not hunt for these things everywhere.

**No automatic migration, read fallback, or dual write from JSON to SQLite.** Experiment 2 verified this: the two stores write their own files in the same workspace, and cannot see each other. If you want to switch between P16 and P17, you change the profile and rebuild the tasks. It is not a "smooth upgrade".

**No lease renewal tool, and no heartbeat.** The five tools contain no `renew_lease`. When the lease expires, it expires. The task returns to `pending` and lets somebody else take over. If your task really needs to run for 10 minutes, the correct approach is to configure a larger `leaseDurationMs`, or to split the task smaller — not to add an "I am still alive" heartbeat interface.

**No exactly-once promise for external side effects.** The SQLite transaction guarantees "the task state transitions only once". The claim token is passed to `AgentRunner.run()` as the idempotencyKey. That lets the model retries **within the same round** avoid duplicate execution. But if a teammate already sent an email before its lease expired, and the task then returns to `pending` and is claimed again by somebody else, that email is not withdrawn. Side-effect deduplication is the business layer's business.

**No fake graceful shutdown after a timeout.** Experiments 10 and 11 both verified it: after the empty spins reach the limit, `idleTimeoutCount` increases by one, and `drainEvents()` is empty. The worker exits quietly. It does not fabricate a `shutdown_response` for the Lead.

**No worktree isolation.** The teammates no longer claim the same task. But they still change files in the same working directory. **Task ownership is not file system isolation.** That is Chapter 18's content.

**No dynamic MCP tool discovery.** The tool surface is hard-coded in the composition root: five for the Lead, four for a teammate.

**No daemon thread, no process-level global BUS, and no async task that nobody holds.** The polling sleep is held by the `WorkStealingRuntime`. At `close()`, it can stop cleanly.

**The symbolic-link defence has code, but this chapter has no test coverage for it.** This one must be stated clearly, because it is the only place in this chapter where "the implementation is stricter than the tests". `src/adapters/task-sqlite.ts` has four layers of path-escape defence: `realpath` normalisation, symbolic-link rejection (`:410`, `:420`, `:551`), `nlink !== 1` hard-link rejection (`:565`), and a `pathIsInside` boundary check. But in `tests/ch17-*.test.ts` there is **only a hard-link test** (`ch17-task-sqlite.test.ts:223`, "rejects a database hardlink before changing the outside file"), and no symbolic-link test at all. The reason: an ordinary Windows user needs extra permission to create a file symbolic link, so such a test would skip on most machines. So: the symbolic-link defence code is real, but you cannot say "it has been verified".

These "not done" items are not a TODO list for "later". They are part of this chapter's boundary. The minimal loop that Chapter 17 must hold has only four words: **shared task board, atomic claim, lease recovery, bounded polling**.

---

## Differences from Claude Code

Distinguishing the two kinds of difference — "we simplified" and "we are stricter than the teaching version" — helps a lot in understanding the design trade-offs.

### Where we simplified

**There is only one idle mechanism.** Ours is 5-second polling + `AbortSignal` wake-up, with an observable idle timeout after 12 polls by default. CC is not a single `idle_poll()`. It is a combination of four things: `sendIdleNotification()` actively tells the Lead "I am idle"; `waitForNextPromptOrShutdown()` polls the mailbox every 500ms; `useTaskListWatcher` watches the file system; and `tryClaimNextTask()` claims actively. Our teammate enters idle silently. The Lead does not know.

**No task-level fine-grained lock.** The real CC source uses `proper-lockfile` to manage both a task-level lock and a task-list lock, and completes read-check-change-write inside the lock. We have only one database-level lock (`tasks.sqlite3.lock`). The granularity is coarser — at any moment, the whole task board has only one writer. That is enough at the scale of a few dozen teammates. At a few hundred, it becomes a bottleneck.

**Teammates cannot create tasks.** In the real CC source, teammates can also use task creation and update tools. We deliberately do not give teammates `create_task`. This stops them from expanding the task graph without limit inside an autonomy loop ("I need to create a sub-task first" → claim → "this one needs splitting too" → …).

**No special handling for `<identity>` re-injection.** The CC teaching version manually re-injects the identity when `len(messages) <= 3`. In our version, the Runner injects a stable system prompt on every `run()`. On an automatic claim, it additionally passes the claim payload as this round's input.

### Where we are stricter than the teaching version

These items go the other way — the CC **teaching version s17** did not do them, and we did:

**Three-layer mutual exclusion, not zero layers.** The CC teaching version's scan + claim uses a JSON file, **with no file lock**. Its correctness depends on "in practice there is no real concurrency". We use the in-process tail-chain + `proper-lockfile` + `BEGIN IMMEDIATE`. Experiment 5 verified it with two real processes.

**The claim semantics are structured.** The CC teaching version's `claim_task` returns one text sentence: `"Claimed {id} ({subject})"`. We return a `TaskClaim`, with `task`, `claimToken` and `leaseExpiresAtUtc`. The problem with the text form is not that it looks bad — it is that, without a token, the model has no way to prove "this task is mine".

**There is a lease.** CC's claim has no lease. A stuck task needs manual intervention. Our half-open interval `[claimed_at, lease_expires_at)` automatically returns to `pending` on expiry, and clears the owner/token (Experiment 6).

**The token is unique for the whole life cycle.** The `task_claim_tokens` history table makes a token non-reusable for the whole database life cycle — after task completion and after lease expiry, the old token is invalid (Experiment 7). CC's owner string has no token history. It can only rely on the file lock and state checks to avoid a wrong completion.

**The plan gate and the claim are bound into one deterministic boundary.** We check `planAllowsEffectful()` **before** `claimNext()`. A pending/rejected plan keeps the automatic claim at zero writes (Experiment 11). The CC teaching version relies on command semantics and tool checks. It does not bind these two things together.

One sentence summarises this comparison: **The real CC source is more complete than ours. The CC teaching version is looser than ours.** We picked "the minimal strict set that can be asserted in offline tests".

---

## What We Learn from ai-agent-book: Shared Task Boards and Atomic Claims

Chapter 10 of ai-agent-book matches this chapter exactly: it distinguishes shared context / non-shared context, and three collaboration forms — Orchestration, Choreography, and Decentralized. What this chapter does is exactly the move from the first form to the third. The companion [Experiment 10-4](https://github.com/bojieli/ai-agent-book/blob/main/chapter10/parallel-web-research/README.md) shows a real parallel search system. The implementation is in [agents.py](https://github.com/bojieli/ai-agent-book/blob/main/chapter10/parallel-web-research/agents.py) and [message_bus.py](https://github.com/bojieli/ai-agent-book/blob/main/chapter10/parallel-web-research/message_bus.py).

### How it is designed

The Manager allocates pages. Several homogeneous workers each hold an independent browser context. The first `target_found` settles through the idempotent `settle_once` under an `asyncio.Lock`. It **broadcasts `terminate` only once**. Later hits are only recorded. They do not settle again. After a loser receives the terminate, it cancels at a safe point, sends an ack, and closes its own browser context.

Three principles in it directly decided this chapter's shape:

First, **the shared file system is a high-incidence area for concurrency conflicts**. It needs an optimistic lock or worktree isolation. It states this explicitly. In this chapter we solved the task-layer conflict. The file layer is left to Chapter 18.

Second, **`settle_once` must be idempotent, and protected by a lock or a transaction.** It is not "check whether somebody settled before". The settlement action itself must sit inside the critical section. That is exactly the shape of `BEGIN IMMEDIATE` + the conditional UPDATE.

Third, **the first "verified success" settles, not the first "claimed success".** The model can propose completion. It cannot approve completion itself.

### Our comparison and trade-offs

This chapter does not copy the centralised MessageBus. It translates its principles onto the task board:

| ai-agent-book's design | This chapter's approach | Why this choice |
| --- | --- | --- |
| The shared file system needs an optimistic lock or worktree isolation | `tasks.sqlite3` is the single task-state source; three-layer mutual exclusion guarantees that only one worker can claim | Solve the task-layer conflict first; the file isolation in the same workspace is left to Chapter 18 |
| The data plane and the control plane are separate; a message bus carries the control events | The Mailbox and the typed Protocol remain the control plane; SQLite stores only task state | The task board does not play the broadcast bus; in the idle loop, the Mailbox has priority over the task board |
| `settle_once` is idempotent and protected by a lock or a transaction | `BEGIN IMMEDIATE` + conditional UPDATE + the `task_claim_tokens` history table | Put "selection" and "transition" in the same transaction, instead of selecting first and changing after |
| The first "verified success" settles | A teammate must call `complete_task` explicitly, with the current `claim_token` | But honestly: we have no independent verifier. The verification still comes from the tool call itself |
| terminate → clean up at a safe point → ack → exit | Chapter 16's typed shutdown has priority over a ready task; an idle timeout does not fake a shutdown | Shutdown is the control plane's business. It must not be overtaken by a task claim |
| A runaway loop needs a budget and a cancellation mechanism | `maxIdlePolls` is the bounded polling budget; the lease stops a worker from stuck-holding a task | This chapter does no global quota and no heartbeat |
| Parallel coordination suits a message bus for broadcast | We deliberately do not implement `BROADCAST` | One-to-many notification and A2A state synchronisation are left to later chapters |

**What it does, and we explicitly do not:** a central MessageBus, `BROADCAST` broadcast, active `status_update` reporting, a dynamic worker pool, and real browser context counts as evidence.

One sentence deserves to be quoted on its own: work stealing moves the scheduling from the Lead's judgement onto the shared task board. But it **is still not a self-organising network without a control plane**. How tasks are claimed can be decentralised. But messages, plan approval and shutdown still need a deterministic typed state machine. That is the whole reason for the four priority levels in the idle loop.

---

## Companion Code Index

All of this chapter's code is under `code/chapters/ch17/`. The line counts are there to help you estimate the workload — do not panic when you see 768 lines. More than half of `task-sqlite.ts` is path-safety validation and error classification.

**Files that are new, or that this chapter changes with focus:**

| File | Lines | What this chapter is responsible for |
| --- | --- | --- |
| [src/features/work-stealing.ts](code/chapters/ch17/src/features/work-stealing.ts) | 417 | `WorkStealingRuntime`, `DirectTaskClaimService`, the five leased tool definitions, the `taskPayload` / `claimPayload` wire format, `WorkStealingSleeper` |
| [src/adapters/task-sqlite.ts](code/chapters/ch17/src/adapters/task-sqlite.ts) | 768 | `SqliteTaskStore`: the schema DDL, the atomic claim in `claimNext`, the three-layer mutual exclusion in `#transaction`, lease recovery, path-escape defence, persistence by temporary file + rename |
| [src/features/teammates.ts](code/chapters/ch17/src/features/teammates.ts) | 884 | The four-level priority in `#runWorker`, the auto-claim prompt, the claim token reused as idempotencyKey, bounded polling and `idleTimeoutCount` |
| [src/features/tasks.ts](code/chapters/ch17/src/features/tasks.ts) | 375 | The `TaskStore` interface, `TaskStatus`, `TaskClaim`, and error types such as `TaskClaimError` / `TaskLeaseExpiredError` |
| [src/features/protocol.ts](code/chapters/ch17/src/features/protocol.ts) | 463 | `planAllowsEffectful` (from Chapter 16; reused by this chapter's claim gate) |
| [src/bootstrap.ts](code/chapters/ch17/src/bootstrap.ts) | 445 | The composition root: capability bit dispatch, store identity validation, Lead / teammate tool surface cut-down |
| [src/config.ts](code/chapters/ch17/src/config.ts) | 78 | The `taskStore` / `workStealingRuntime` configuration items |
| [src/cli.ts](code/chapters/ch17/src/cli.ts) | 342 | The argument parsing of the two entries, the two kinds of wakeup binding, and resource shutdown |
| [src/chapters/ch17.ts](code/chapters/ch17/src/chapters/ch17.ts) | 5 | The fixed chapter entry; only 5 lines |

**Tests (this chapter: 5 files, 20 tests in total):**

| File | Lines | What it asserts |
| --- | --- | --- |
| [tests/ch17-task-sqlite.test.ts](code/chapters/ch17/tests/ch17-task-sqlite.test.ts) | 240 | Back-end independence, sorting by sequence, dependency gating, exactly one success across processes, the lease boundary, token collision rollback, hard-link rejection |
| [tests/ch17-work-stealing.test.ts](code/chapters/ch17/tests/ch17-work-stealing.test.ts) | 103 | The tool surface contract, the owner coming from the identity, the wire format field names, the required schema of `complete_task` |
| [tests/ch17-runtime.test.ts](code/chapters/ch17/tests/ch17-runtime.test.ts) | 806 | The four-level priority, the protocol not entering the model, the plan gate's zero writes, explicit completion after an automatic claim, an observable idle timeout that does not fake a shutdown |
| [tests/ch17-bootstrap.test.ts](code/chapters/ch17/tests/ch17-bootstrap.test.ts) | 101 | The P16/P17 capability delta, refusal of a JSON taskStore, store identity, the exact tool surfaces on three sides |
| [tests/ch17-entry.test.ts](code/chapters/ch17/tests/ch17-entry.test.ts) | 28 | The two entries share the same runtime; no state directory is created before a configuration failure |
| [tests/fixtures/ch17-claim-child.ts](code/chapters/ch17/tests/fixtures/ch17-claim-child.ts) | 10 | The child-process program for cross-process claiming (Experiment 5 uses it too) |

### Suggested reading order for the code

Do not start reading at the top of the 768-line `task-sqlite.ts`. Follow this order. Each step can continue from the previous step's question:

1. **`P17` in `src/core/profiles.ts`** —— first confirm that the delta really is only two capability bits: `task_dag_sqlite` and `work_stealing`. One minute.
2. **`TaskClaim` and the error types in `src/features/tasks.ts`** —— three fields, four error classes. This is the whole chapter's vocabulary.
3. **`claimNext` in `src/adapters/task-sqlite.ts` (from line 198)** —— only twenty-odd lines, but it demonstrates the whole chain "release the expired → find a ready one → claim atomically".
4. **`#claim` in `src/adapters/task-sqlite.ts` (from line 278)** —— now look at the conditional UPDATE and `getRowsModified() === 1`. You already know what it defends against. Note that the `INSERT INTO task_claim_tokens` sits **before** the UPDATE.
5. **`#transaction` in `src/adapters/task-sqlite.ts` (from line 310)** —— the shell of the three-layer mutual exclusion. Focus on three things: `retries: 0`, persistence only after COMMIT, and temporary file + rename.
6. **`DirectTaskClaimService` and `claimPayload` in `src/features/work-stealing.ts`** —— where the owner comes from, and where the wire format is converted.
7. **`#runWorker` in `src/features/teammates.ts` (from line 573)** —— the actual code of the four-level priority. See clearly why the Mailbox and the protocol come before the claim.
8. **Lines 632-645 of `src/features/teammates.ts`** —— the bounded polling counting logic. The focus: a wake-up does **not** consume the empty-spin budget.
9. **The store identity validation and tool surface cut-down in `src/bootstrap.ts`** —— read this last. It explains "why the two places must be the same object". It belongs to the wrap-up details.

Skip the path validation part of `task-sqlite.ts` (lines 375-570) and most of `cli.ts` — the first is a security boundary, with independent logic; the second is argument parsing.

---

## Run and Verify

Five gates, in order. All run under `F:\笔记\Agent实操\code`:

```powershell
Set-Location 'F:\笔记\Agent实操\code'
npm run test:ch17
npm run typecheck
npm run lint
npm run format:check
npm run build
```

My measured results:

```text
Test Files  54 passed (54)
      Tests  369 passed (369)
```

`test:ch17` also runs all the earlier chapters' tests. So it is 54 files and 369 tests, not only ch17's 5 files. This is deliberate — one requirement of Chapter 17 is that it must not break the behavior of P16 and earlier. In particular, the rule "the old JSON `TaskStore` behavior is completely unchanged".

To see only this chapter's 20 tests:

```powershell
npx vitest run --root chapters/ch17 tests/ch17-task-sqlite.test.ts tests/ch17-work-stealing.test.ts tests/ch17-runtime.test.ts tests/ch17-bootstrap.test.ts tests/ch17-entry.test.ts
```

```text
Test Files  5 passed (5)
     Tests  20 passed (20)
```

On my side, `typecheck`, `lint` (1367 files), `format:check` (1367 files) and `build` all passed cleanly.

All of this chapter's tests inject deterministic UUIDs, a UTC clock, a controllable sleeper and a model stand-in. **They do not depend on a real OpenAI, on the network, or on a real sleep.** The only exception is Experiment 5's cross-process test — it must spawn real processes, because cross-process mutual exclusion cannot be simulated inside one process.

The key assertions are all concrete business results, not filler assertions like "it did not throw":

- SQLite and the old JSON back-end are independent of each other. The order follows `sequence`, not UUID size;
- A and B are claimed concurrently by two teammates. C becomes claimable only after **both** complete;
- When two processes spawned on Windows compete for the same task, **exactly one** succeeds. The other gets `undefined`, not an error;
- At the moment of `lease_expires_at_utc`, the lease is already expired. The old owner/token cannot complete the new lease;
- A collision of an active token and of a historical token both roll back the whole transaction. No half-claimed state is produced;
- A database hard link cannot write state outside the workspace. And it is rejected **before** the outside file is modified;
- When a shutdown has been delivered, the task stays `pending`. The protocol request does not enter the model;
- A `pending`/`rejected` latest plan keeps the automatic claim at **zero writes**. An approved response first updates the gate, then lets it through;
- The idle timeout is observable (`idleTimeoutCount`), but it generates no fake protocol message or summary;
- The tool sets of the Lead, the Subagent and the Teammate, and the required schema of `complete_task`, match exactly;
- The CLI constructs only **one** SQLite store. It creates no state directory before a configuration failure.

---

## Chapter Summary

### The three-sentence version

First, what work stealing adds is not a `while True`. It is **making "select the task" and "change the state" one atomic action**. Split it into two steps, and no matter how many checks you add in between, a TOCTOU window exists.

Second, a claim must leave behind **a presentable credential**. An owner string can only state "whose it once was". A claim token proves "it is still mine now".

Third, autonomy is not indulgence. A teammate can find work itself. But the Mailbox, the protocol and the plan gate all rank before the claim. The empty spins have a budget. The lease has a deadline.

### Seven points you must remember

1. **Selection and transition must be in the same transaction.** `BEGIN IMMEDIATE` opens the write transaction. The conditional `UPDATE ... WHERE status='pending' AND owner IS NULL` is the final mutual-exclusion point. Only `getRowsModified() === 1` counts (Atomic Claim, Experiments 4 and 5).
2. **The three mutual-exclusion layers each guard one segment.** The in-process tail-chain guards same-process concurrency. `proper-lockfile` guards across processes. `BEGIN IMMEDIATE` guards inside the database. Remove any layer, and there is a matching failure scenario (Three-Layer Mutual Exclusion, Experiment 5).
3. **The token is unique for the whole life cycle.** The history table `task_claim_tokens` makes a token non-reusable after task completion and after lease expiry. A conflict happens before the UPDATE. The rollback needs no compensation (Experiment 7).
4. **The lease is a half-open interval.** `[claimed_at, lease_expires_at)`. Release uses `<=`. The completion check uses `>=`. The boundary is exactly one millisecond apart (Experiment 6).
5. **The owner comes from the identity, not from an argument.** The `claim_task` schema has no owner field at all. `strictObject` makes a forgery attempt fail directly (Experiment 9).
6. **The Mailbox and the protocol have priority over the task board.** The plan gate ranks before `claimNext`. In the pending/rejected state there are zero writes — not a rollback after claiming (The Idle Loop, Experiment 11).
7. **Bounded polling, no fake shutdown.** At `maxIdlePolls`, the loop exits. `idleTimeoutCount` is observable. `drainEvents()` is empty. A wake-up does not consume the empty-spin budget (Experiments 10 and 11).

### One diagram to review the whole chain

```text
  ① Build the graph          The Lead's tools               The teammate's tools
  ────────                   create_task                  (no create_task)
                             get_task / list_tasks        get_task / list_tasks
                             claim_task / complete_task   claim_task / complete_task
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │   WorkStealingRuntime  │
                        │   (Lead / Subagent /   │
                        │    Teammate share one)  │
                        └────────────┬───────────┘
                                     │
  ② Persist                          ▼
  ────────      ┌──────────────────────────────────────────┐
                │  .agent_tutorial/tasks.sqlite3            │
                │                                          │
                │  tasks (sequence / status / owner /       │
                │         claim_token / lease_expires)     │
                │  task_dependencies (DAG edges + position)   │
                │  task_claim_tokens (unique for the whole life cycle)      │
                │  task_metadata (schema_version = 1)      │
                │                                          │
                │  CHECK constraint: owner / token / lease        │
                │  The three must be present together, or absent together                   │
                └──────────────────────────────────────────┘
                                     │
  ③ Mutual exclusion                 ▼
  ────────      ┌──────────────────────────────────────────┐
                │  Layer 1  In-process tail-chain (by db path)  │
                │  Layer 2  proper-lockfile (the .lock file)    │
                │  Layer 3  BEGIN IMMEDIATE + conditional UPDATE    │
                │                                          │
                │  There is only one final mutual-exclusion point:                     │
                │  UPDATE ... WHERE status='pending'        │
                │              AND owner IS NULL           │
                │  → Only getRowsModified() === 1 counts as a successful claim   │
                └──────────────────────────────────────────┘
                                     │
  ④ Priority                         ▼
  ────────      ┌──────────────────────────────────────────┐
                │  The four-level order in the teammate idle loop                │
                │                                          │
                │  1. The Mailbox has a message    ──▶ Process the message first      │
                │  2. A typed protocol request    ──▶ Does not enter the model; reply with a response │
                │  3. planAllowsEffectful() is false ──▶ Only sleep │
                │  4. claimNext() ──▶ Work if there is work; sleep if there is none    │
                └──────────────────────────────────────────┘
                                     │
  ⑤ Completion                       ▼
  ────────      ┌──────────────────────────────────────────┐
                │  complete_task(task_id, claim_token)     │
                │                                          │
                │  Two checks: owner+token match, the lease has not expired   │
                │  Returns unblocked (which downstream tasks this completion unblocked)     │
                │  The claim token is also the Runner's idempotency key       │
                └──────────────────────────────────────────┘
```

The five numbers are the positions of this chapter's five hard rules: ① only the Lead builds the graph ② the state lands in an independent SQLite ③ three-layer mutual exclusion guarantees a single claimer ④ the control plane has priority over the task board ⑤ completion requires presenting the credential.

### Check whether you really understood it

Do not look at the text above. Try to answer. If you cannot answer one, the section is named in brackets:

1. In the way of writing "scan first to find a ready task, then write the owner", between exactly which lines is the TOCTOU window? (Why You Cannot "Scan First, Then Write the Owner")
2. Why is an in-memory lock not enough? In exactly which scenario does it fail? (Three-Layer Mutual Exclusion, Experiment 5)
3. What is the difference between `BEGIN` and `BEGIN IMMEDIATE`? With the first one, when does an error occur? (Why `BEGIN IMMEDIATE` and Not `BEGIN`)
4. Why must the conditional `UPDATE` write both conditions, `status='pending'` and `owner IS NULL`? Would only one of them work? (The Complete Logic of `claimNext`)
5. When `getRowsModified() === 1` returns 0, does the code throw, or return `undefined`? Why this choice? (The Complete Logic of `claimNext`, Experiment 5)
6. What is the reason the `task_claim_tokens` history table exists? Why is the `UNIQUE` constraint on `tasks.claim_token` not enough? (Why the Token Must Be "Unique for the Whole Life Cycle", Experiment 7)
7. Why must the `INSERT INTO task_claim_tokens` sit **before** the conditional `UPDATE`? (Experiment 7)
8. Lease release uses `lease_expires_at_utc <= now`. The completion check uses `now >= lease`. Why are these two directions consistent? (The Lease Is a Half-Open Interval, Experiment 6)
9. Why do the `claim_task` tool's arguments contain no owner? If the model forces one in, what happens? (The Owner Cannot Be Forged Through a Tool Argument, Experiment 9)
10. Which tool does the teammate's tool set have one fewer of, compared with the Lead's? Why one fewer? (Five Tools, Experiment 8)
11. What is the idle loop's four-level priority? Why does the plan gate rank **before** the claim, and not after it? (The Idle Loop's Real Priority, Experiment 11)
12. After a teammate automatically claims a task, does the task become `completed` by itself? If the model does not call `complete_task`, what happens? (After an Automatic Claim, the Model Must Still Complete the Task Explicitly, Experiment 10)
13. After the empty spins reach the `maxIdlePolls` limit, what is inside `drainEvents()`? (Bounded Polling, Experiment 10)
14. Does this chapter promise exactly-once? What is the difference between "the task state transitions only once" and "an external side effect happens only once"? (What This Chapter Deliberately Does Not Do)

After you do all this, the Lead can just build the DAG and start the teammates. Dependency unblocking, stable selection and concurrent claiming are completed autonomously by the teammates. The human is no longer the scheduler.

But one problem is still unsolved: Alice and Bob no longer claim the same task. But they still change files in the same working directory. **Task ownership is not file system isolation.** In the next chapter, we use a Git Worktree to mark out each teammate's own territory.
