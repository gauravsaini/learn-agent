# Repository Guidelines

## Project Structure & Module Organization

This repository contains a 20-part series about building AI agents. This is the English edition. Each numbered Markdown file at the repository root is one article; the numeric prefix defines the reading order. Keep an article's prose, diagrams, tables, and code samples together in that file. Images are currently referenced by remote Markdown URLs rather than stored locally.

Runnable companion code lives in `code/`. Each chapter owns a complete runnable TypeScript snapshot under `code/chapters/chNN/src/`, with its cumulative behavioral tests under `code/chapters/chNN/tests/`; do not reintroduce shared root `code/src/` or `code/tests/` copies. Treat each chapter's own `src/` snapshot plus its `tests/` suite as the implementation and acceptance sources of truth; `code/package.json` scripts (`test:chNN`, `lint`, `format:check`, `verify:snapshot-drift`) are the gates.

## Build, Test, and Development Commands

The migrated TypeScript project uses npm, Vitest, Biome, and strict TypeScript. Run project commands from `code/`:

```powershell
rtk npm ci
rtk npm run typecheck
rtk npm test
rtk npm run lint
rtk npm run format:check
rtk npm run build
```

Run a migrated chapter from `code/` with either entry form:

```powershell
rtk npm run ch01 -- --prompt "List the current directory"
rtk npm run ch02 -- --prompt "Read package.json"
rtk npm run ch03 -- --prompt "Read README.md, then write chapter3-note.txt"
rtk npm run ch04 -- --prompt "Read README.md and summarise how to run it"
rtk npm run ch05 -- --prompt "First build the complete TODO, then read README.md and summarise the run and verification steps"
rtk npm run ch06 -- --prompt "Use task to independently check which test framework this project uses, and return only conclusions with file evidence"
rtk npm run ch07 -- --prompt "First use load_skill to load typescript-style, then summarise two of its conventions"
rtk npm run ch08 -- --prompt "Read a large file and summarise it, and observe the path and preview after the complete result is persisted"
rtk npm run ch09 -- --prompt "Remember: the examples in this project use PowerShell only"
rtk npm run ch10 -- --prompt "List the tools available to the current Agent"
rtk npm run ch11 -- --prompt "Check the current workspace and give a conclusion"
rtk npm run ch12 -- --prompt "Build task dependencies for schema, endpoints, tests and docs"
rtk npm run ch13 -- --prompt "Run npm install in the background while reading README.md; summarise after you get the result"
rtk npm run ch14 -- --prompt "Check CI every day at 9 am Shanghai time, run it on a cycle and persist it"
rtk npm run ch15 -- --prompt "Create a writer teammate, let her read the README and report the gaps"
rtk npm run ch16 -- --prompt "Create a writer teammate, let her submit a plan first, execute after approval, and shut down gracefully"
rtk npm run ch17 -- --prompt "Use task to independently check which test framework this project uses, and return only conclusions with file evidence"
rtk npm run ch18 -- --prompt "Create two tasks and bind separate Worktrees, then start alice and bob to claim one each"
rtk npm run ch19 -- --prompt "First connect demo_alpha and demo_beta, in the next turn call lookup separately to query needle, then disconnect demo_alpha"
rtk npm run ch20 -- --prompt "Verify the dynamic context, MCP boundary and resource shutdown of the complete Harness"
rtk npm run agent-tutorial -- run --chapter 1 --prompt "List the current directory"
rtk npm run agent-tutorial -- run --chapter 2 --prompt "Read package.json"
rtk npm run agent-tutorial -- run --chapter 3 --prompt "Read README.md, then write chapter3-note.txt"
rtk npm run agent-tutorial -- run --chapter 4 --prompt "Read README.md and summarise how to run it"
rtk npm run agent-tutorial -- run --chapter 5 --prompt "First build the complete TODO, then read README.md and summarise the run and verification steps"
rtk npm run agent-tutorial -- run --chapter 6 --prompt "Use task to summarise the responsibilities of the chapters/ch06/src/core directory, then let the parent Agent give the conclusion"
rtk npm run agent-tutorial -- run --chapter 7 --prompt "First use load_skill to load typescript-style, then summarise its key conventions"
rtk npm run agent-tutorial -- run --chapter 8 --prompt "Read a large file and summarise it, and observe the path and preview after the complete result is persisted"
rtk npm run agent-tutorial -- run --chapter 9 --prompt "What constraints apply to the command examples in this project?"
rtk npm run agent-tutorial -- run --chapter 10 --prompt "List the tools available to the current Agent"
rtk npm run agent-tutorial -- run --chapter 11 --prompt "Check the current workspace and give a conclusion"
rtk npm run agent-tutorial -- run --chapter 12 --prompt "List the current project tasks and claim one ready task"
rtk npm run agent-tutorial -- run --chapter 13 --prompt "Run npm install in the background while reading README.md; summarise after you get the result"
rtk npm run agent-tutorial -- run --chapter 14 --prompt "Check CI every day at 9 am Shanghai time, run it on a cycle and persist it"
rtk npm run agent-tutorial -- run --chapter 15 --prompt "Create a writer teammate, let her read the README and report the gaps"
rtk npm run agent-tutorial -- run --chapter 16 --prompt "Create a writer teammate, let her submit a plan first, execute after approval, and shut down gracefully"
rtk npm run agent-tutorial -- run --chapter 17 --prompt "Use task to independently check which test framework this project uses, and return only conclusions with file evidence"
rtk npm run agent-tutorial -- run --chapter 18 --prompt "Create two tasks and bind separate Worktrees, then start alice and bob to claim one each"
rtk npm run agent-tutorial -- run --chapter 19 --prompt "First connect demo_alpha and demo_beta, in the next turn call lookup separately to query needle, then disconnect demo_alpha"
rtk npm run agent-tutorial -- run --chapter 20 --prompt "Verify the dynamic context, MCP boundary and resource shutdown of the complete Harness"
```

Real runs require a local `.env` copied from `code/.env.example`; chapter 11 and later also require `OPENAI_FALLBACK_MODEL`. Offline tests must inject the model and other external boundaries; do not require secrets or network access. Use the fixed script for each migrated chapter, currently `ch01` through `ch20`; do not claim a later TypeScript chapter is runnable until its script, profile, implementation, tests, and tutorial have all passed review.

## Coding Style & Naming Conventions

Write article prose in English and preserve the established conversational, technical tone. This repository is the English edition, so new and edited prose uses English throughout. Name new installments as `<sequence>-<descriptive-slug>.md` (for example `03-permission-system.md`); do not renumber unrelated files. Separate major passages with blank lines and `---` where the surrounding article does so. Give fenced code blocks a language tag. User-facing commands must be PowerShell. TypeScript uses ESM, strict checking, explicit exported contracts, `unknown` at untrusted boundaries, and must pass the configured TypeScript, Biome, Vitest, and build checks. Keep identifiers, API fields, commands, and error text in their original language. Code comments and documentation comments use English unless an external protocol term is clearer in another form.

## Testing Guidelines

For TypeScript behavior changes, add focused Vitest tests that assert concrete results, state, side effects, or failure branches. Run `typecheck` plus the focused test before each chapter review; run the full suite when shared runtime code changes. Run Biome and build before claiming a chapter is verified. Real OpenAI smoke tests are additional evidence only when all required credentials are available; otherwise report `Blocked, not run`.

For every article edit, read back the complete changed article, confirm fenced blocks are paired, verify tables and local code paths, and open every added or changed link or image URL. Trace technical examples from input through expected output and keep snippets consistent with the runnable companion code.

## Commit & Pull Request Guidelines

This directory is a Git repository. Its history uses Conventional Commit types with a chapter scope and an English subject, for example `docs(ch20): rewrite the Full Harness integration tutorial`. Follow that convention. Keep each commit focused on one article or one shared correction. Pull requests should identify affected article numbers, summarize substantive changes, explain technical corrections, and link the relevant issue when one exists. Include a rendered screenshot only when formatting, tables, or image placement changed.
