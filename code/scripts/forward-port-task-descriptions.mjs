// Move descriptions of the five ch12 task tools forward into ch13–ch20.
//
// Context: tasks.ts in ch12 carries a long description to "give the model enough context" (stating that runtime decides owner,
// blocked_by must be a canonical UUID returned by list_tasks/get_task); ch13 reverted to a short description.
// The cumulative snapshot invariant is "Chapter N = Chapter N-1 + exactly one new capability"; description degradation violates it.
//
// This is not "fixed in one chapter and not propagated"; the two versions already diverged in initial commit f9794e6.
// But direction is clear: line 1270 of the ch12 tutorial originally quoted `Owner is set by the runtime identity;`
// do not pass an owner argument.`, readers searching ch13 code will not find this sentence.
//
// Confirmed safe to change: no tests in the repository assert these descriptions, and no other tutorials reference either version.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const REPLACEMENTS = [
  {
    label: "get_task",
    from: `    taskIdDefinition("get_task", "Read one persistent project task by ID.", "read", store),`,
    to: `    taskIdDefinition(
      "get_task",
      "Read one persistent project task by canonical UUID. Read-only; it does not change status or owner.",
      "read",
      store,
    ),`,
  },
  {
    label: "list_tasks",
    from: `    description: "List the complete persistent project task graph.",`,
    to: `    description:
      "List the complete persistent project task graph sorted by ID. Use it before create_task to find canonical UUIDs or before claim_task to find ready tasks.",`,
  },
  {
    label: "claim_task",
    from: `      "Atomically claim a ready pending task as the current identity.",`,
    to: `      "Atomically claim a ready pending task as the current identity. Owner is set by the runtime identity; do not pass an owner argument.",`,
  },
  {
    label: "complete_task",
    from: `    description: "Complete a claimed task owned by the current identity.",`,
    to: `    description:
      "Complete a claimed task owned by the current identity. Returns the completed task and any pending tasks directly unblocked by this completion.",`,
  },
  {
    label: "create_task",
    from: `    description: "Create a persistent project task with explicit dependencies.",`,
    to: `    description:
      "Create a persistent project task after planning. blocked_by must contain canonical task UUIDs returned by list_tasks or get_task.",`,
  },
];

const CHAPTERS = ["ch13", "ch14", "ch15", "ch16", "ch17", "ch18", "ch19", "ch20"];

for (const chapter of CHAPTERS) {
  const file = join(ROOT, chapter, "src", "features", "tasks.ts");
  let body = readFileSync(file, "utf8");
  const applied = [];
  for (const { label, from, to } of REPLACEMENTS) {
    if (body.includes(to)) {
      continue; // Already long description, skipping idempotently
    }
    const hits = body.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`${chapter} ${label}: Expected 1 hit, got ${hits}`);
    }
    body = body.replace(from, to);
    applied.push(label);
  }
  if (applied.length === 0) {
    console.log(`${chapter} Already long description, skipping`);
    continue;
  }
  writeFileSync(file, body, { encoding: "utf8" });
  console.log(`${chapter} Modified: ${applied.join(", ")}`);
}
