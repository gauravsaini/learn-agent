// Backfill ch09 fix 42c0e6f (NO_FENCE_INSTRUCTION + extractor slug rules) into accumulated snapshots of ch10–ch20.
// Cumulative snapshot invariant: Chapter N = Chapter N-1 + exactly one new capability, so the ch09 prompt fix must exist in all later chapters.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const NO_FENCE_BLOCK = `// All three side-query outputs go directly into JSON.parse(), without fence stripping or substring slicing;
// Therefore the system prompt must explicitly forbid Markdown code fences and explanations to reduce the likelihood of models adding fences.
const NO_FENCE_INSTRUCTION =
  "Output pure JSON text directly. Do not wrap with Markdown code blocks or backticks. Do not output any explanatory text.";
`;

const SLUG_RULE =
  "name must be a safe lowercase slug: only lowercase letters and digits are allowed; separate multiple words with a single hyphen -; no underscores, spaces, uppercase letters, or Chinese characters.";

// "Old closing line" -> "new closing line" for each of the three prompts; order does not matter, each must match exactly once.
const REPLACEMENTS = [
  {
    from: "Must return only a JSON array of strings, do not call tools; returns [] when there are no relevant items.`;",
    to: "Must return only a JSON array of strings, do not call tools; returns [] when there are no relevant items.\n${NO_FENCE_INSTRUCTION}`;",
  },
  {
    from: "type can only be user, feedback, project, or reference; returns [] when there are no new memories.`;",
    to: `type can only be user, feedback, project, or reference; returns [] when there are no new memories.\n${SLUG_RULE}\n\${NO_FENCE_INSTRUCTION}\`;`,
  },
  {
    from: "source_names are replaced original memory names, and records is a non-empty array of new memories.`;",
    to: "source_names are replaced original memory names, and records is a non-empty array of new memories.\n${NO_FENCE_INSTRUCTION}`;",
  },
];

const ANCHOR = "const SELECTOR_SYSTEM_PROMPT = `";

for (let n = 10; n <= 20; n += 1) {
  const chapter = `ch${String(n).padStart(2, "0")}`;
  const file = join(ROOT, chapter, "src", "features", "memory.ts");
  const original = readFileSync(file, "utf8");

  if (original.includes("NO_FENCE_INSTRUCTION")) {
    console.log(`${chapter} Already exists, skipping`);
    continue;
  }

  let next = original;
  for (const { from, to } of REPLACEMENTS) {
    const hits = next.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`${chapter}: Expected 1 hit, got ${hits} hits -> ${from}`);
    }
    next = next.replace(from, to);
  }

  const anchorHits = next.split(ANCHOR).length - 1;
  if (anchorHits !== 1) {
    throw new Error(`${chapter}: SELECTOR anchor hit ${anchorHits} times`);
  }
  next = next.replace(ANCHOR, `${NO_FENCE_BLOCK}${ANCHOR}`);

  writeFileSync(file, next, { encoding: "utf8" });
  console.log(`${chapter} Backfilled`);
}
