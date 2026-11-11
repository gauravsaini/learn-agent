// registerLeasedTaskTools registers the five task tools for ch17–ch20 (the taskStore path does not produce five tools for P17+),
// Therefore the two background tools must move after the workStealingRuntime block to stay "immediately following complete_task".
// Idempotent: skip chapters already in the correct position. Throw errors on missing or multiple anchor hits.
import { readFile, writeFile } from "node:fs/promises";

const CHAPTERS = ["ch17", "ch18", "ch19", "ch20"];
const ROOT = new URL("../chapters/", import.meta.url);

const BACKGROUND_BLOCK = `  if (dependencies.backgroundSupervisor !== undefined) {
    // Primary Agent registers background query and cancellation tools; subagents receive no background Supervisor, so do not expose these capabilities.
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
`;

for (const chapter of CHAPTERS) {
  const path = new URL(`${chapter}/src/bootstrap.ts`, ROOT);
  let body = await readFile(path, "utf8");

  const blockHits = body.split(BACKGROUND_BLOCK).length - 1;
  if (blockHits !== 1) {
    throw new Error(`${chapter}: Background registration block hit ${blockHits} times, expected 1 time`);
  }

  // workStealingRuntime also appears once in child Agent factories, accepting only the primary registration path after background blocks.
  const backgroundAt = body.indexOf(BACKGROUND_BLOCK);
  const stealStart = body.indexOf(
    "  if (dependencies.workStealingRuntime !== undefined) {",
    backgroundAt,
  );
  if (stealStart === -1) {
    throw new Error(`${chapter}: workStealingRuntime block not found`);
  }
  const stealEnd = body.indexOf("\n  }\n", stealStart);
  if (stealEnd === -1) {
    throw new Error(`${chapter}: workStealingRuntime block has no end marker`);
  }
  const insertAt = stealEnd + "\n  }\n".length;

  if (body.slice(insertAt).startsWith(BACKGROUND_BLOCK)) {
    console.log(`${chapter} Already in correct position, skipping`);
    continue;
  }
  if (backgroundAt > insertAt) {
    throw new Error(`${chapter}: Background block is after workStealingRuntime but not adjacent, please confirm manually`);
  }

  const removed = body.replace(BACKGROUND_BLOCK, "");
  const shift = body.length - removed.length;
  const target = insertAt - shift;
  body = removed.slice(0, target) + BACKGROUND_BLOCK + removed.slice(target);
  await writeFile(path, body, "utf8");
  console.log(`${chapter} Background registration block moved after registerLeasedTaskTools`);
}
