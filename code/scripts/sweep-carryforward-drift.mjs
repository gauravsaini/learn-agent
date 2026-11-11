// One-time check: whether files that introduce no new capabilities in this chapter had implementations changed silently by later chapters in cumulative snapshots.
// The criterion only inspects non-comment, non-blank lines; comment density differs across chapters by design (known phenomenon, not drift).
// The goal is to find whether other 42c0e6f style cases exist where "a fix was applied only to one chapter without forwarding".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

function listFiles(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Remove full-line comments and empty lines; preserve trailing inline comments to avoid misidentifying // in strings.
function meaningful(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .join("\n");
}

const chapters = Array.from({ length: 20 }, (_v, index) => `ch${String(index + 1).padStart(2, "0")}`);
let drifted = 0;

for (let index = 1; index < chapters.length; index += 1) {
  const previous = chapters[index - 1];
  const current = chapters[index];
  const previousRoot = join(ROOT, previous);
  const currentRoot = join(ROOT, current);

  const previousFiles = new Map(
    listFiles(previousRoot).map((file) => [relative(previousRoot, file), file]),
  );

  for (const [key, previousFile] of previousFiles) {
    const currentFile = join(currentRoot, key);
    let currentBody;
    try {
      currentBody = meaningful(currentFile);
    } catch {
      // The subsequent chapter deleted this file: this is a structural change handled by chapter diff tools, outside these criteria.
      console.log(`[Missing] ${current} does not have ${key}`);
      continue;
    }
    if (meaningful(previousFile) !== currentBody) {
      drifted += 1;
      console.log(`[Drift] ${previous} -> ${current}: ${key}`);
    }
  }
}

console.log(`\nTotal ${drifted} non-comment differences (including valid capability additions, requires manual inspection).`);
