// Relax the default hang guard value of waitForEventWithin in ch17-runtime.test.ts.
// This guard is a fallback to "prevent tests from hanging forever", not a performance assertion; 1s produces false positives under 65 concurrent files.
// 15s is well below testTimeout 30s in vitest.config.ts, so timeouts hit the custom diagnostic information here first,
// Instead of the generic framework "Test timed out".
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const HEAD = `async function waitForEventWithin(
  runtime: TeammateRuntime,
  timeoutMs = `;
const TAIL = `,
): Promise<readonly RuntimeEvent[]> {`;

for (const chapter of ["ch17", "ch18", "ch19", "ch20"]) {
  const file = join(ROOT, chapter, "tests", "ch17-runtime.test.ts");
  const original = readFileSync(file, "utf8");
  const start = original.indexOf(HEAD);
  if (start === -1) throw new Error(`${chapter}: waitForEventWithin signature not found`);
  const valueStart = start + HEAD.length;
  const valueEnd = original.indexOf(TAIL, valueStart);
  if (valueEnd === -1) throw new Error(`${chapter}: Signature end not found`);
  const current = original.slice(valueStart, valueEnd);
  if (current === "15_000") {
    console.log(`${chapter} Already 15_000, skipping`);
    continue;
  }
  const next = `${original.slice(0, valueStart)}15_000${original.slice(valueEnd)}`;
  writeFileSync(file, next, { encoding: "utf8" });
  console.log(`${chapter}: ${current} -> 15_000`);
}
