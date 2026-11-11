# Agent Tutorial Domain Language

This document defines confusing domain terms in the tutorial runtime. It ensures that task collaboration, execution isolation, and cleanup decisions use the same language.

## Language

**Project Task**:
A unit of work in the workspace. It persists across recovery and can declare dependencies. One executor claims it.
_Avoid_: TODO, background task, Cron task

**Task Claim**:
A record that an executor holds execution rights for a Project Task during a limited lease. A claim token proves current ownership.
_Avoid_: task binding, task assignment

**Managed Worktree**:
A Git working directory and branch whose lifecycle the runtime controls. It isolates file changes for one Project Task.
_Avoid_: workspace, clone, temporary directory

**Worktree Reservation**:
A persistent, unique placeholder for a combination of task, name, path, and branch before Git creation completes.
_Avoid_: Task Claim, Worktree Binding

**Worktree Binding**:
A persistent association between a Project Task and a Managed Worktree. It is independent of task status. It does not mean the task is claimed or completed.
_Avoid_: Task Claim, current working directory

**Integration Ref**:
A Git reference that the caller explicitly specifies. The runtime allows automatic cleanup only when its current commit contains the Worktree branch tip.
_Avoid_: upstream, push ref, default branch

**Execution Context**:
A trusted scope that the runtime resolves for one tool execution. It contains the executor, working directory, and current Task Claim information.
_Avoid_: process cwd, prompt context

**Needs Review**:
A Worktree lifecycle state. The runtime uses this state when it cannot prove automatic cleanup is safe or cannot complete cleanup. It must retain related resources for manual handling.
_Avoid_: delete on failure, forced cleanup

**MCP Server Alias**:
A stable name in the local allowlist that represents an MCP Server and its trusted policy.
_Avoid_: remote server name, arbitrary command

**MCP Connection**:
An active protocol session that is currently initialized for an MCP Server Alias.
_Avoid_: Tool Registry, process handle

**Published MCP Tool**:
A remote tool declaration that an MCP Server publishes through the protocol. Its name, description, schema, and results are external data.
_Avoid_: built-in tool, local authorization

**MCP Tool Policy**:
A trusted effect classification that the local system assigns to a Published MCP Tool.
_Avoid_: remote description, remote readOnly annotation

**Exposed MCP Tool**:
A capability that enters the local tool pool. Server Alias, name isolation, and MCP Tool Policy transform a Published MCP Tool into this capability.
_Avoid_: Published MCP Tool, original remote name

**Registry Snapshot**:
An immutable set of tools that one model request and its corresponding reply use together.
_Avoid_: live tool pool, static list at startup
