// After restoring two background tools to ch14–ch20, synchronize 8 exact tool table assertions.
// Idempotent; throw errors on missing or multiple anchor hits.
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../chapters/", import.meta.url);
const CHAPTERS = ["ch14", "ch15", "ch16", "ch17", "ch18", "ch19", "ch20"];
const INSERT = '        "query_background_job",\n        "cancel_background_job",\n';
const ANCHOR = '        "complete_task",\n';

for (const chapter of CHAPTERS) {
  const path = new URL(`${chapter}/tests/ch14-bootstrap.test.ts`, ROOT);
  let body = await readFile(path, "utf8");
  if (body.includes("query_background_job")) {
    console.log(`${chapter} ch14-bootstrap already contains assertions, skipping`);
    continue;
  }
  const hits = body.split(ANCHOR).length - 1;
  if (hits !== 1) {
    throw new Error(`${chapter} ch14-bootstrap: complete_task anchor hit ${hits} times, expected 1 time`);
  }
  body = body.replace(ANCHOR, `${ANCHOR}${INSERT}`);
  await writeFile(path, body, "utf8");
  console.log(`${chapter} ch14-bootstrap assertions backfilled two tools`);
}

// LEAD_TOOLS array indents two spaces in the ch20 full-link harness, and complete_task appears twice in the file,
// Therefore anchor to this adjacent pair inside the LEAD_TOOLS block: "complete_task",\n  "create_worktree",.
const harnessPath = new URL("ch20/tests/ch20-full-harness.test.ts", ROOT);
let harness = await readFile(harnessPath, "utf8");
if (harness.includes("query_background_job")) {
  console.log("ch20 harness already contains assertions, skipping");
} else {
  const anchor = '  "complete_task",\n  "create_worktree",\n';
  const hits = harness.split(anchor).length - 1;
  if (hits !== 1) {
    throw new Error(`ch20 harness: LEAD_TOOLS anchor hit ${hits} times, expected 1 time`);
  }
  harness = harness.replace(
    anchor,
    '  "complete_task",\n  "query_background_job",\n  "cancel_background_job",\n  "create_worktree",\n',
  );
  await writeFile(harnessPath, harness, "utf8");
  console.log("ch20 harness LEAD_TOOLS added two tools");
}
