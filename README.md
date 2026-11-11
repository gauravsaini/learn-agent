# Agent Architecture in Practice

A 20-chapter tutorial that builds a production-grade AI Agent Harness from zero. This is the English edition.

This tutorial does not reduce an Agent to "call a model API once". It starts from the smallest Agent Loop. It then adds one capability per chapter: tools, files, permission, Hook, planning, context, memory, reliability, task scheduling, multi-Agent collaboration, Worktree isolation, and MCP. At the end, it connects all capabilities back into one complete Harness. Each chapter has one article and one runnable TypeScript snapshot. The reader can read and run at the same time, and can test while they learn the design boundaries.

## What problem this tutorial solves

The model handles reasoning and decides the next step. The Harness lands the decision safely in the real environment. The tutorial progresses around four questions:

1. **How does an Agent act?** Use one stable loop to read the model reply, execute tools, and append results.
2. **How is an Agent constrained?** Use file boundaries, permission policy, Hook, and structured protocols to control side effects.
3. **How does an Agent handle long tasks?** Use TODO, subagents, Skill, context compaction, memory, recovery, background tasks, and Cron to extend the effective working time.
4. **How do multiple Agents collaborate and connect to external capabilities?** Use Task Claim, Mailbox, protocol approval, SQLite, Worktree, and MCP to form a recoverable, auditable collaboration runtime.

Core principle: **Each chapter adds only one main capability. The previous chapter's behavior stays. P20 does not build a separate loop. It verifies that the capabilities of the first 19 chapters work together in the same AgentRunner.**

## Tutorial outline

```text
Agent Loop
  -> Tool and file boundaries
  -> Permission and Hook
  -> Planning, subagent, Skill
  -> Artifact persistence, context compaction, cross-session memory
  -> Dynamic Prompt, API recovery, task DAG
  -> Background task, Cron
  -> Teammate, Mailbox, protocol and plan approval
  -> SQLite claiming, Worktree isolation
  -> MCP dynamic tool pool
  -> Complete Harness
```

You can read it in five stages:

| Stage | Chapters | Problem it solves |
| --- | --- | --- |
| Execution basics | 1–4 | From the loop, tools, and file boundaries to permission and the Hook lifecycle |
| Context and knowledge | 5–10 | Let the Agent plan, delegate, load knowledge on demand, compact context, persist memory, and decouple runtime assembly |
| Reliable execution and the task system | 11–14 | Handle truncation, overlong input, rate limit, retry, task dependencies, background jobs, and timed triggers |
| Multi-Agent collaboration and isolation | 15–18 | From message delivery to the closed protocol loop, decentralised claiming, and parallel development with Git Worktree |
| Dynamic extension and final assembly | 19–20 | Connect external MCP tools safely to a dynamic tool pool, then verify the unified boundary of the complete Harness |

## The 20-chapter map

| Chapter | Topic | Key capability this chapter adds |
| ---: | --- | --- |
| [1](<./01-agent-loop.md>) | Agent Loop | `loop`, `powershell`: the smallest loop for model requests, tool results, and continue/stop |
| [2](<./02-adding-a-tool.md>) | Tools and files | `tool_registry`, `files`: registry, Zod input, workspace safe paths, read and write files |
| [3](<./03-permission-system.md>) | Permission system | `policy`: approval, audit, four-state permission decision, and a unified tool error boundary |
| [4](<./04-hooks.md>) | Hook decoupling | `hooks`: the four lifecycle points UserPromptSubmit, PreToolUse, PostToolUse, and Stop |
| [5](<./05-todo-and-session-planning.md>) | Session planning | `todo`: full snapshot, state validation, stale plan reminder, to stop long tasks from drifting |
| [6](<./06-subagents.md>) | Subagent | `subagent`: isolated history, shared run boundary, no recursive delegation, turn limit |
| [7](<./07-skill-system.md>) | Skill system | `skills`: scan summaries first, then load the body by name, so knowledge enters the context on demand |
| [8](<./08-context-compaction.md>) | Context compaction | `artifacts`, `compaction`: persist results, trim in layers, restore the context budget with summaries |
| [9](<./09-file-memory.md>) | File memory | `memory`: extract from the canonical history, organise it, and retrieve persistent memory across sessions |
| [10](<./10-modular-architecture.md>) | Dynamic context | `dynamic_prompt`: a Provider generates the runtime system prompt in a fixed order and avoids copying the Loop |
| [11](<./11-api-resilience.md>) | API recovery | `recovery`: truncation, overlong input, 429/529, Retry-After, fallback, cancellation, and a total time limit |
| [12](<./12-task-engine-dag.md>) | Task DAG | `task_dag_json`: task dependencies, atomic JSON persistence, DAG validation, and owner forgery protection |
| [13](<./13-background-tasks.md>) | Background task | `background`: persist first, then start the worker, and connect the asynchronous job with a placeholder result and a completion event |
| [14](<./14-cron-scheduler.md>) | Cron scheduling | `cron`: timezone calculation, UTC persistence, durable/session-only lifecycle, and outbox trigger |
| [15](<./15-teammate-mailbox.md>) | Teammate and Mailbox | `teammate`, `mailbox`: persistent teammates, FIFO messages, recovery, bad message isolation, and Inbox injection |
| [16](<./16-multi-agent-protocol.md>) | Collaboration protocol | `protocol`, `plan_gate`: register before you send, match responses completely, plan approval, and deterministic shutdown |
| [17](<./17-sqlite-task-claiming.md>) | SQLite claiming | `task_dag_sqlite`, `work_stealing`: atomic claim inside a transaction, lease, token history, and role-based tool trimming |
| [18](<./18-worktree-isolation.md>) | Worktree isolation | `worktree`: reservation, binding, Execution Context, claim routing, and the `needs_review` cleanup boundary |
| [19](<./19-mcp-dynamic-tools.md>) | MCP tool pool | `mcp`: allowlist, connection, published tools, name isolation, policy classification, and the next-turn Registry Snapshot |
| [20](<./20-full-harness.md>) | Complete Harness | `full_harness`: one unified composition root, a single AgentRunner, dynamic context, MCP boundary, and resource shutdown |

## How the companion code is organised

The code lives in [`code/`](./code/). Each chapter has an independent snapshot:

```text
code/
├─ chapters/
│  ├─ ch01/
│  │  ├─ src/       # TypeScript implementation of this chapter and all previous capabilities
│  │  └─ tests/     # Cumulative behavior tests for this chapter
│  ├─ ...
│  └─ ch20/
│     ├─ src/       # The complete Harness
│     └─ tests/
├─ skills/          # Example Skill content
├─ scripts/         # Build and snapshot drift checks
├─ package.json
└─ .env.example
```

The chapters are not independent toy projects. A later snapshot keeps the behavior of the earlier chapters. It adds capabilities in the composition root according to the `P01`–`P20` profile. The current source code and tests are the authority for implementation details. Do not treat "the file exists" or "the import works" as proof that a chapter is complete.

From chapter 15 on, the CLI connects two kinds of wakeup at the same time: Teammate and Cron. It hands both to the `runEvents()` entry of the same `AgentRunner`. Teammate messages, scheduled tasks, and background events can then enter the Lead context in an explicit event turn. The entry regression tests for this wiring stop the wiring from degrading.

## Start reading and running

### 1. Prepare the environment

- The Windows 11 example commands all use PowerShell.
- Node.js `>=20.12`.
- Install the dependencies in `code/`:

```powershell
Set-Location '.\code'
npm ci
```

A real model run needs a configured `.env`. Copy the template first, then fill in the four variables:

```powershell
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
}
```

```text
OPENAI_BASE_URL=
OPENAI_API_KEY=
OPENAI_MODEL=
OPENAI_FALLBACK_MODEL=
```

Offline tests inject the model and other external boundaries. They need no key and no network. If you have no credentials, run the tests, the type check, and the build first. Do not treat a real OpenAI smoke test as a required gate.

### 2. Run a single chapter

Each chapter has a fixed npm script. The examples below use chapter 1 and chapter 20:

```powershell
npm run ch01 -- --prompt "List the current directory"
npm run ch20 -- --prompt "Verify the dynamic context, MCP boundary and resource shutdown of the complete Harness"
```

You can also select a chapter through the unified entry:

```powershell
npm run agent-tutorial -- run --chapter 12 --prompt "Build task dependencies for schema, endpoints, tests and docs"
```

### 3. Verify the implementation

Run these commands from `code/`:

```powershell
npm run typecheck
npm run test:ch01
npm run test:ch20
npm test
npm run lint
npm run format:check
npm run build
npm run verify:snapshot-drift
```

For a chapter-by-chapter review, run at least the matching `test:chNN` and `typecheck`. After a shared runtime change, run the full tests, lint, format, build, and the snapshot drift check. You can mark a chapter as "passed" only after a direct verification passes.

The current code baseline has passed serial verification: `npm test` covers 65 test files and 429 tests. `typecheck`, `lint`, `format:check`, `build`, and `verify:snapshot-drift` all pass. A real model smoke test needs the user to configure `.env`. It is not part of the offline gates.

## Recommended reading method

1. First read the "acceptance result / problem essence" in the article. Be clear about what this chapter must prove.
2. Then read the composition root, the core types, and the tool handlers in `code/chapters/chNN/src/`.
3. Run the chapter tests. Observe the state, events, permission, files, and error branches.
4. Compare the next chapter with the previous chapter. Look only for the new capability, and for why the new capability cannot go back into the old module.
5. When you reach chapter 20, look back at the same `AgentRunner`. Check its execution order, the Registry Snapshot, the tool result pairing, the permission boundary, and the resource shutdown.

## Reference sources and their relationship

This tutorial refers to the ideas, chapter organisation, and engineering discussions of the public projects below. The code, the chapter numbering, the TypeScript implementation, and the acceptance criteria belong to this repository itself. They are not an official translation of those projects, and they do not copy them chapter by chapter.

- [`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book): *Understanding AI Agents in Depth: Design Principles and Engineering Practice*. It uses "Agent = LLM + context + tools" as its main line. It provides 10 chapters of text and a large set of companion experiments. This tutorial borrows its method: move from principles to engineering practice, define the evaluation first, and only then implement the constraints. Articles such as chapters 9, 10, 14, and 15 also discuss the related trade-offs explicitly.
- [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code): a progressive tutorial that builds a Claude Code style agent harness from zero. It puts tools, knowledge, observation, action interfaces, permission, and a single Agent Loop under the same Harness view. This tutorial borrows its teaching method: "each lesson adds only one mechanism, and the last lesson integrates them again". It re-implements the method with TypeScript, strict contracts, and this repository's test gates.

The two reference projects focus on different things. The first gives a wider view of Agent principles, context, memory, tools, and multiple Agents. The second goes deep into the internal mechanisms of a Claude Code style Harness. This tutorial converges the two views into one runnable 20-chapter engineering route.

## Discussion and feedback

You are welcome to discuss reading questions, architecture trade-offs, run problems, and improvement suggestions at [LINUX DO](https://linux.do/). Please follow the community rules before you post. This README only provides the discussion entry. It does not replace the community rules.

## Licence and contributions

The articles and the code in this repository follow the declarations in the actual files in the repository. When you improve the tutorial, keep this rhythm: "one chapter, one topic; code and article in sync; verify first, then claim completion". In your commit, state the affected chapters and the verification commands.
