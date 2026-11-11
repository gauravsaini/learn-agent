// Chapter capability list: each profile is a frozen singleton; the composition root determines enabled runtime boundaries from it.
export type Capability =
  | "loop"
  | "powershell"
  | "tool_registry"
  | "files"
  | "policy"
  | "hooks"
  | "todo"
  | "subagent"
  | "skills"
  | "artifacts"
  | "compaction"
  | "memory"
  | "dynamic_prompt"
  | "recovery"
  | "task_dag_json"
  | "background"
  | "cron"
  | "teammate"
  | "mailbox"
  // protocol and plan_gate together represent structured approval messages and side-effect execution gating.
  | "protocol"
  | "plan_gate"
  // task_dag_sqlite and work_stealing indicate leased SQLite task graphs and decentralized claims.
  | "task_dag_sqlite"
  | "work_stealing"
  | "worktree"
  // mcp indicates remote MCP tool boundaries that can be dynamically published and revoked.
  | "mcp";

export interface ChapterProfile {
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

class CapabilitySet implements ReadonlySet<Capability> {
  readonly #values: Set<Capability>;

  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: Capability): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  values(): SetIterator<Capability> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

export const P02: ChapterProfile = Object.freeze({
  chapter: 2,
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files"]),
});

export const P03: ChapterProfile = Object.freeze({
  chapter: 3,
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files", "policy"]),
});

export const P04: ChapterProfile = Object.freeze({
  chapter: 4,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
  ]),
});

export const P05: ChapterProfile = Object.freeze({
  chapter: 5,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
  ]),
});

export const P06: ChapterProfile = Object.freeze({
  chapter: 6,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
  ]),
});

export const P07: ChapterProfile = Object.freeze({
  chapter: 7,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
  ]),
});

export const P08: ChapterProfile = Object.freeze({
  chapter: 8,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
  ]),
});

export const P09: ChapterProfile = Object.freeze({
  chapter: 9,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
    "memory",
  ]),
});

export const P10: ChapterProfile = Object.freeze({
  chapter: 10,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
    "memory",
    "dynamic_prompt",
  ]),
});

export const P11: ChapterProfile = Object.freeze({
  chapter: 11,
  capabilities: new CapabilitySet([
    "loop",
    "powershell",
    "tool_registry",
    "files",
    "policy",
    "hooks",
    "todo",
    "subagent",
    "skills",
    "artifacts",
    "compaction",
    "memory",
    "dynamic_prompt",
    "recovery",
  ]),
});

export const P12: ChapterProfile = Object.freeze({
  chapter: 12,
  capabilities: new CapabilitySet([...P11.capabilities, "task_dag_json"]),
});

export const P13: ChapterProfile = Object.freeze({
  chapter: 13,
  capabilities: new CapabilitySet([...P12.capabilities, "background"]),
});

export const P14: ChapterProfile = Object.freeze({
  chapter: 14,
  capabilities: new CapabilitySet([...P13.capabilities, "cron"]),
});

export const P15: ChapterProfile = Object.freeze({
  chapter: 15,
  capabilities: new CapabilitySet([...P14.capabilities, "teammate", "mailbox"]),
});

export const P16: ChapterProfile = Object.freeze({
  chapter: 16,
  capabilities: new CapabilitySet([...P15.capabilities, "protocol", "plan_gate"]),
});

// P17 appends SQLite task graph and work stealing to P16, letting Lead, subagents, and teammates share the same claim path.
export const P17: ChapterProfile = Object.freeze({
  chapter: 17,
  capabilities: new CapabilitySet([...P16.capabilities, "task_dag_sqlite", "work_stealing"]),
});

// P18 adds controlled Git worktree isolation on top of SQLite work stealing.
export const P18: ChapterProfile = Object.freeze({
  chapter: 18,
  capabilities: new CapabilitySet([...P17.capabilities, "worktree"]),
});

// P19 adds connectable, discoverable, and closeable MCP tool boundaries on top of worktree isolation.
export const P19: ChapterProfile = Object.freeze({
  chapter: 19,
  capabilities: new CapabilitySet([...P18.capabilities, "mcp"]),
});

export function profileForChapter(chapter: number): ChapterProfile {
  if (chapter === 1) {
    return P01;
  }
  if (chapter === 2) {
    return P02;
  }
  if (chapter === 3) {
    return P03;
  }
  if (chapter === 4) {
    return P04;
  }
  if (chapter === 5) {
    return P05;
  }
  if (chapter === 6) {
    return P06;
  }
  if (chapter === 7) {
    return P07;
  }
  if (chapter === 8) {
    return P08;
  }
  if (chapter === 9) {
    return P09;
  }
  if (chapter === 10) {
    return P10;
  }
  if (chapter === 11) {
    return P11;
  }
  if (chapter === 12) {
    return P12;
  }
  if (chapter === 13) {
    return P13;
  }
  if (chapter === 14) {
    return P14;
  }
  if (chapter === 15) {
    return P15;
  }
  if (chapter === 16) {
    return P16;
  }
  if (chapter === 17) {
    return P17;
  }
  if (chapter === 18) {
    return P18;
  }
  if (chapter === 19) {
    return P19;
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
