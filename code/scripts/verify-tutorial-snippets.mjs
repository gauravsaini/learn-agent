// Verify whether TypeScript code blocks in the tutorial find matching implementations in this chapter snapshot source.
// Approach: take distinctive lines from code blocks (sufficient length, non-comment, not purely brackets),
// Perform substring matching after normalizing whitespace under src/ of this chapter. A low match rate indicates the tutorial and code might be out of sync.
// Usage: node scripts/verify-tutorial-snippets.mjs [chapter-numbers...] [--verbose]
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const codeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(codeRoot);
const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const chapterFilter = argv.filter((a) => !a.startsWith("--")).map(Number);

const articles = (await readdir(repoRoot))
  .filter((name) => /^\d+\.\s/.test(name) && name.endsWith(".md"))
  .map((name) => ({ name, chapter: Number(name.split(".")[0]) }))
  .filter((item) => chapterFilter.length === 0 || chapterFilter.includes(item.chapter))
  .sort((a, b) => a.chapter - b.chapter);

async function readAllSources(chapter) {
  const root = join(codeRoot, "chapters", `ch${String(chapter).padStart(2, "0")}`);
  const chunks = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        chunks.push(await readFile(full, "utf8"));
      }
    }
  }
  await visit(root);
  return normalize(chunks.join("\n"));
}

function normalize(text) {
  return text.replace(/\s+/g, " ");
}

// Determine whether a line has "enough distinction" to use for matching.
function isDistinctive(line) {
  const t = line.trim();
  if (t.length < 24) return false;
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
  if (/^[)}\];,]+$/.test(t)) return false;
  if (t.startsWith("...")) return false; // Ellipsis placeholder
  if (t.includes("…")) return false;
  return true;
}

let grandTotal = 0;
let grandMiss = 0;
for (const article of articles) {
  const text = await readFile(join(repoRoot, article.name), "utf8");
  const sources = await readAllSources(article.chapter);
  if (sources.length === 0) {
    console.log(`### ch${article.chapter}: No snapshot source code, skipping`);
    continue;
  }

  const blocks = [...text.matchAll(/```(ts|typescript)\n([\s\S]*?)```/g)].map((m) => m[2]);
  let checked = 0;
  let missed = 0;
  const missDetail = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter(isDistinctive);
    if (lines.length === 0) continue;
    let blockChecked = 0;
    let blockMiss = 0;
    for (const line of lines) {
      const needle = normalize(line);
      blockChecked += 1;
      if (!sources.includes(needle)) {
        blockMiss += 1;
        if (verbose) missDetail.push(line.trim());
      }
    }
    checked += blockChecked;
    missed += blockMiss;
  }
  grandTotal += checked;
  grandMiss += missed;
  const rate = checked === 0 ? 1 : (checked - missed) / checked;
  console.log(
    `### ch${String(article.chapter).padStart(2, " ")} code blocks ${blocks.length} lines checked ${checked} missed ${missed} hit rate ${(rate * 100).toFixed(1)}%`,
  );
  if (verbose) {
    for (const d of missDetail.slice(0, 40)) console.log(`    ? ${d}`);
    if (missDetail.length > 40) console.log(`    ... total ${missDetail.length} items`);
  }
}
console.log(
  `\nTotal: checked ${grandTotal} lines, missed ${grandMiss}, hit rate ${(((grandTotal - grandMiss) / grandTotal) * 100).toFixed(1)}%`,
);
