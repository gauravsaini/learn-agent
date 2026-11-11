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
  // worktree indicates controlled Git worktree isolation; mcp indicates remote MCP tool boundaries that can be dynamically published and revoked.
  | "worktree"
  | "mcp"
  // full_harness marks the complete P20 capability profile without adding an independent runtime.
  | "full_harness";

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

// Each chapter declares only new capabilities; subsequent chapters obtain complete profiles through cumulative PROFILE_DELTAS.
const PROFILE_DELTAS = [
  ["loop", "powershell"],
  ["tool_registry", "files"],
  ["policy"],
  ["hooks"],
  ["todo"],
  ["subagent"],
  ["skills"],
  ["artifacts", "compaction"],
  ["memory"],
  ["dynamic_prompt"],
  ["recovery"],
  ["task_dag_json"],
  ["background"],
  ["cron"],
  ["teammate", "mailbox"],
  ["protocol", "plan_gate"],
  ["task_dag_sqlite", "work_stealing"],
  ["worktree"],
  ["mcp"],
  // full_harness is the P20 marker capability: adds no specific runtime, only declares capabilities from the previous 19 chapters are active.
  ["full_harness"],
] as const satisfies readonly (readonly Capability[])[];

// PROFILES is derived from incremental capability arrays, ensuring each chapter profile is a strict superset of the previous one.
const PROFILES: readonly ChapterProfile[] = Object.freeze(
  PROFILE_DELTAS.map((_, index) =>
    Object.freeze({
      chapter: index + 1,
      capabilities: new CapabilitySet(PROFILE_DELTAS.slice(0, index + 1).flat()),
    }),
  ),
);

export const P01 = profileAt(1);
export const P02 = profileAt(2);
export const P03 = profileAt(3);
export const P04 = profileAt(4);
export const P05 = profileAt(5);
export const P06 = profileAt(6);
export const P07 = profileAt(7);
export const P08 = profileAt(8);
export const P09 = profileAt(9);
export const P10 = profileAt(10);
export const P11 = profileAt(11);
export const P12 = profileAt(12);
export const P13 = profileAt(13);
export const P14 = profileAt(14);
export const P15 = profileAt(15);
export const P16 = profileAt(16);
export const P17 = profileAt(17);
export const P18 = profileAt(18);
export const P19 = profileAt(19);
// P20 is the complete Harness profile, uniformly enabling cumulative capabilities verified across the previous nineteen chapters.
export const P20 = profileAt(20);

export function profileForChapter(chapter: number): ChapterProfile {
  // Only fixed chapters 1 through 20 are queryable; fail immediately on out-of-bounds queries to prevent unknown profiles.
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > PROFILES.length) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  return profileAt(chapter);
}

function profileAt(chapter: number): ChapterProfile {
  const profile = PROFILES[chapter - 1];
  // Unmigrated chapters fail explicitly before execution instead of returning empty capability sets.
  if (profile === undefined) {
    throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
  }
  return profile;
}
