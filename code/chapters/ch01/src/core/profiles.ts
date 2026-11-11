// Profile is a chapter capability allowlist, preventing fixed chapter scripts from inheriting untaught capabilities.
// Capability enum defines the capability types this chapter exposes to the composition root:
//   - "loop": Agent core loop (AgentRunner), included in all chapters
//   - "powershell": PowerShell command execution tool (Chapter 1 only)
// Subsequent chapters expand this union type to add new capabilities like file operations and search.
export type Capability = "loop" | "powershell";

// Capability boundary of fixed chapters; composition root can assemble only components taught up to that stage based on this allowlist.
export interface ChapterProfile {
  // Fixed chapter numbers and immutable capability sets jointly restrict capabilities assembled by the composition root.
  // The composition root (bootstrap.ts) determines which components to inject based on the profile.
  readonly chapter: number;
  readonly capabilities: ReadonlySet<Capability>;
}

// Minimal implementation for read-only capability sets, hiding mutable Sets to keep profiles immutable after export.
class CapabilitySet implements ReadonlySet<Capability> {
  // Implement a read-only interface with a private Set to prevent callers from modifying capability sets via profiles.
  // CapabilitySet ensures external code cannot add/delete; a profile is immutable once defined.
  readonly #values: Set<Capability>;

  // Creates private copy from literal capability list; subsequent modifications to original array by callers do not affect the profile.
  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  // Expose capability count without leaking the underlying mutable collection.
  get size(): number {
    return this.#values.size;
  }

  // Determine whether a specific capability is in the current chapter allowlist.
  has(value: Capability): boolean {
    return this.#values.has(value);
  }

  // Return a key-value pair iterator following native Set conventions to maintain ReadonlySet compatibility.
  entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  // Returns an iterator of capability names.
  keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  // Returns an iterator of capability values; keys and values of Set are identical, but this method satisfies the ReadonlySet contract.
  values(): SetIterator<Capability> {
    return this.#values.values();
  }

  // Iterates capabilities with native Set callback signature; second value parameter maintains protocol compatibility.
  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    // Pass value twice following the standard Set callback signature to maintain ReadonlySet compatibility.
    // The second argument value2 of forEach matches the first, aligning with native Set.forEach signatures.
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  // Make capability sets iterable via for...of and spread syntax without providing any write entries.
  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

// Chapter 1 frozen profile; opens only minimal Agent Loop and PowerShell execution capability.
export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  // "loop" + "powershell": Chapter 1 has only the core loop and PowerShell tool.
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

// Resolve generic CLI chapter numbers to profiles actually present in this snapshot; reject unmigrated chapters.
export function profileForChapter(chapter: number): ChapterProfile {
  // The general entry point can parse only chapters actually provided in this snapshot, rejecting unmigrated requests.
  // Provide explicit errors when generic CLI requests unmigrated chapters to avoid silent runtime failures.
  if (chapter !== 1) {
    throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
  }
  return P01;
}
