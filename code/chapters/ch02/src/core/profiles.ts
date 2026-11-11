/**
 * Chapter capability profile: each migrated chapter maps to a fixed profile.
 * P02 adds only tool_registry and files capabilities to P01. bootstrap selects the tool set by chapter.
 * CapabilitySet exposes only a read-only interface to prevent callers from modifying the profile via type assertions.
 */
// Profile is a chapter capability allowlist; P02 adds only tool registration and file access over P01.
export type Capability = "loop" | "powershell" | "tool_registry" | "files";

export interface ChapterProfile {
  // Fixed chapter number; the composition root rejects capability escalations based on this.
  readonly chapter: number;
  // Immutable profile, determines components permitted for assembly.
  readonly capabilities: ReadonlySet<Capability>;
}

// Read-only wrapper of Set prevents callers from modifying profile.capabilities via type assertions.
class CapabilitySet implements ReadonlySet<Capability> {
  readonly #values: Set<Capability>;

  // Copy input arrays to prevent subsequent external modifications from affecting profiles.
  constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  // Returns the number of enabled capabilities without exposing the mutable set.
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

  // Iterates capabilities with native Set callback signature; second value parameter matches the first.
  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  // Support for...of iteration without providing entry points to add or remove capabilities.
  [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }
}

// Chapter 1 frozen profile, containing only the loop and PowerShell.
export const P01: ChapterProfile = Object.freeze({
  chapter: 1,
  capabilities: new CapabilitySet(["loop", "powershell"]),
});

// Chapter 2 enables the registry and file system tools on top of P01.
export const P02: ChapterProfile = Object.freeze({
  chapter: 2,
  capabilities: new CapabilitySet(["loop", "powershell", "tool_registry", "files"]),
});

// Returns a unique frozen profile, rejecting invalid or unmigrated chapter numbers.
export function profileForChapter(chapter: number): ChapterProfile {
  // Migrated chapters return singletons so assembly layers can reject forged profiles using object identities.
  if (chapter === 1) {
    return P01;
  }
  if (chapter === 2) {
    return P02;
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 20) {
    throw new Error("chapter must be an integer from 1 to 20");
  }
  throw new Error(`Chapter ${chapter} has not been migrated to TypeScript yet`);
}
