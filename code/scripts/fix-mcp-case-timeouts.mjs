// Let each of the three error mapping test cases in ch19-mcp.test.ts hold its own tool timeout instead of sharing 20ms.
// Measured: When sharing 0.02s, disconnect detection for terminate (subprocess process.exit(17)) is slower than 20ms under high load,
// As a result, mcp_timeout hits before mcp_connection_lost, and the assertion fails.
// Only the delay test case requires a short timeout (100ms delay hits 20ms first); the other two use the default 2s.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const FROM = `    const cases = [
      ["fail", {}, "mcp_remote_error", true],
      ["delay", { milliseconds: 100 }, "mcp_timeout", false],
      ["terminate", {}, "mcp_connection_lost", false],
    ] as const;
    for (const [tool, argumentsValue, errorCode, survives] of cases) {
      const registry = new ToolRegistry();
      const runtime = new McpRuntime({
        servers: [demoSpec("demo_alpha", "alpha", 0.02)],`;

const TO = `    // Each test case provides tool timeout: Only delay needs an extremely short timeout to trigger mcp_timeout;
    // fail and terminate rely on remote errors and disconnects arriving first; short timeouts cause mcp_timeout to hit prematurely.
    const cases = [
      ["fail", {}, "mcp_remote_error", true, 2],
      ["delay", { milliseconds: 100 }, "mcp_timeout", false, 0.02],
      ["terminate", {}, "mcp_connection_lost", false, 2],
    ] as const;
    for (const [tool, argumentsValue, errorCode, survives, toolTimeoutSeconds] of cases) {
      const registry = new ToolRegistry();
      const runtime = new McpRuntime({
        servers: [demoSpec("demo_alpha", "alpha", toolTimeoutSeconds)],`;

for (const chapter of ["ch19", "ch20"]) {
  const file = join(ROOT, chapter, "tests", "ch19-mcp.test.ts");
  const original = readFileSync(file, "utf8");
  const hits = original.split(FROM).length - 1;
  if (hits !== 1) {
    throw new Error(`${chapter}: Expected 1 hit, got ${hits} hits`);
  }
  writeFileSync(file, original.replace(FROM, TO), { encoding: "utf8" });
  console.log(`${chapter} Fixed`);
}
