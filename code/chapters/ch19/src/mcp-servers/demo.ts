// Chapter built-in MCP test service: provides four deterministic behaviors: success, business failure, timeout, and process termination.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const label = process.argv[process.argv.indexOf("--label") + 1];
// label distinguishes two isomorphic servers; testing alias isolation can verify actual routing targets from results.
if (label === undefined || label.trim().length === 0) {
  throw new Error("--label must not be empty");
}

// Each demo process launches an MCP server independently and communicates with clients through stdin/stdout.
const server = new McpServer({ name: `agent-tutorial-${label}`, version: "0.1.0" });

// lookup returns structured results to verify same-named remote tools do not cross paths after alias isolation.
server.registerTool(
  "lookup",
  {
    description: "Look up one value in this demo server.",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => ({
    content: [{ type: "text", text: JSON.stringify({ label, query }) }],
    structuredContent: { label, query },
  }),
);

// fail returns isError: true to verify remote errors enter the Agent only as fixed, sanitized results.
server.registerTool(
  "fail",
  { description: "Return a deterministic remote tool error." },
  async () => ({
    content: [{ type: "text", text: "server-private-detail" }],
    isError: true,
  }),
);

// delay blocks responses in milliseconds to verify tools/call timeouts and subsequent connection teardown.
server.registerTool(
  "delay",
  {
    description: "Delay a response for timeout testing.",
    inputSchema: { milliseconds: z.number().int().nonnegative() },
  },
  async ({ milliseconds }) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return {
      content: [{ type: "text", text: JSON.stringify({ label, milliseconds }) }],
      structuredContent: { label, milliseconds },
    };
  },
);

// terminate exits child processes actively to verify that transport failures trigger connection-level Watchdog cleanup.
server.registerTool(
  "terminate",
  { description: "Terminate this demo server process." },
  async () => {
    process.exit(17);
  },
);

await server.connect(new StdioServerTransport());
