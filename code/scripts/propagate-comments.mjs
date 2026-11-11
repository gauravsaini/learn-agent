#!/usr/bin/env node
// Forward-propagate comments: insert full-line // comments from the source file into target based on "anchor logical lines".
// Rules:
//   1. Insert only full-line // comments—the logical line sequence of target stripped of comments remains byte-identical;
//   2. Attach comments to the first logical line after it; skip and record if the anchor is not found in target (source-chapter-only code);
//   3. Idempotent: skip if the comment text already exists anywhere in target;
//   4. Output preserves the original line ending style of target (CRLF/LF).
// usage: node propagate-comments.mjs <source.ts> <target.ts> [more targets...]
import { readFileSync, writeFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error("usage: node propagate-comments.mjs <source> <target>...");
  process.exit(1);
}

const readLines = (p) => {
  const raw = readFileSync(p, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { lines, eol };
};

const isComment = (line) => /^\s*\/\//.test(line);
const isBlank = (line) => line.trim() === "";

// Parse sequence of logical lines and comment groups attached to each logical line index.
function parse(lines) {
  const logical = [];
  const rawIndexOf = [];
  const commentGroups = new Map();
  let pending = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isComment(line)) {
      pending.push(line);
      continue;
    }
    if (isBlank(line)) continue;
    const idx = logical.length;
    if (pending.length > 0) {
      commentGroups.set(idx, pending);
      pending = [];
    }
    logical.push(line);
    rawIndexOf.push(i);
  }
  return { logical, rawIndexOf, commentGroups };
}

// LCS alignment: returns Map<sourceIdx, targetIdx>.
// Alignment keys strip leading export prefixes, treating `function f` and `export function f` as the same logical line.
function alignLcs(a, b) {
  const key = (line) => line.replace(/^(\s*)export (?=(function|class|const|interface|type|enum)\s)/, "$1");
  const ka = a.map(key);
  const kb = b.map(key);
  const n = ka.length;
  const m = kb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map = new Map();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      map.set(i, j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return map;
}

function propagate(sourcePath, targetPath) {
  const src = readLines(sourcePath);
  const tgt = readLines(targetPath);
  const s = parse(src.lines);
  const t = parse(tgt.lines);

  const before = t.logical.join("\n");

  const targetCommentTexts = new Set(
    tgt.lines.filter(isComment).map((line) => line.trim()),
  );

  const alignment = alignLcs(s.logical, t.logical);

  // targetIdx -> comment groups to insert (preserving source order)
  const insertions = new Map();
  let inserted = 0;
  let skippedDup = 0;
  const skippedNoAnchor = [];
  for (const [srcIdx, group] of s.commentGroups) {
    const targetIdx = alignment.get(srcIdx);
    if (targetIdx === undefined) {
      skippedNoAnchor.push(...group);
      continue;
    }
    const fresh = group.filter((line) => !targetCommentTexts.has(line.trim()));
    if (fresh.length === 0) {
      skippedDup += group.length;
      continue;
    }
    skippedDup += group.length - fresh.length;
    const merged = [...(insertions.get(targetIdx) ?? []), ...fresh];
    insertions.set(targetIdx, merged);
    inserted += fresh.length;
  }

  // Inserts from back to front to avoid raw index displacement.
  let out = [...tgt.lines];
  for (const targetIdx of [...insertions.keys()].sort((x, y) => y - x)) {
    const rawIdx = t.rawIndexOf[targetIdx];
    out.splice(rawIdx, 0, ...insertions.get(targetIdx));
  }

  // Verification: Logical lines remain unchanged after stripping comments.
  const afterLogical = out.filter((line) => !isComment(line) && !isBlank(line));
  if (afterLogical.join("\n") !== before) {
    console.error(`[${targetPath}] Logical lines changed; refused to write out`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(targetPath, out.join(tgt.eol) + tgt.eol);
  console.log(
    `[${targetPath}] inserted ${inserted} comment lines; skipped existing ${skippedDup} lines; skipped without anchor ${skippedNoAnchor.length} lines` +
      (skippedNoAnchor.length > 0
        ? ` (e.g.: ${skippedNoAnchor[0].trim().slice(0, 40)}...)`
        : ""),
  );
}

const [sourcePath, ...targets] = paths;
for (const target of targets) {
  propagate(sourcePath, target);
}
