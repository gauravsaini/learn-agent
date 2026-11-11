import { runProfile } from "../cli.js";
import { P19 } from "../core/profiles.js";

// Fixed entrypoint enables P19 MCP connection and dynamic tool publishing capabilities.
process.exitCode = await runProfile(P19, process.argv.slice(2));
