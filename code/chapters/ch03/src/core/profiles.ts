// P03 adds policy on top of file tools as a pre-execution boundary for external side effects.
export type Capability = "loop" | "powershell" | "tool_registry" | "files" | "policy";

export interface ChapterProfile {
  // Fixed chapter number; the composition root rejects capability privilege escalations based on this.
  readonly chapter: number;
  // Immutable profile, determines components that can be assembled in this chapter.
  readonly capabilities: ReadonlySet<Capability>;
}

class CapabilitySet implements ReadonlySet<Capability> {
  // Implement ReadonlySet using a wrapper that hides the underlying Set to prevent external modification of profile capabilities.
  readonly #values: Set<Capability>;

  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  // Returns the number of capabilities without exposing the mutable Set.
  get size(): number {
    return this.#values.size;
  }

  // Determine whether a capability belongs to the current chapter allowlist.
  has(value: Capability): boolean {
    return this.#values.has(value);
  }

  // Returns a key-value pair iterator for compatibility with ReadonlySet.
  entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  // Returns an iterator of capability names.
  keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  // Returns an iterator of capability values; keys and values of Set are identical.
  values(): SetIterator<Capability> {
    return this.#values.values();
  }

  // Iterates capabilities with native Set callback signature.
  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  // Support for...of without exposing a write entry point.
  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  // P01 has only loop and PowerShell, without Tool Registry or file capabilities.
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

export const P02: ChapterProfile = Object.freeze({
  chapter: 2,
  // P02 adds Tool Registry and file capabilities here, but lacks permission policies.
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files"]),
});

export const P03: ChapterProfile = Object.freeze({
  chapter: 3,
  // P03 adds policy; bootstrap forcibly injects approval and audit when detecting this capability.
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files", "policy"]),
});

// Returns a frozen module singleton, rejecting invalid or unmigrated chapter numbers.
export function profileForChapter(chapter: number): ChapterProfile {
  // Returns only the frozen singleton in the module, so the composition root can verify profile origin by reference equality.
  if (chapter === 1) {
    return P01;
  }
  if (chapter === 2) {
    return P02;
  }
  if (chapter === 3) {
    return P03;
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
