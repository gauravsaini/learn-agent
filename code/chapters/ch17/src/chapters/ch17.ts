import { runProfile } from "../cli.js";
import { P17 } from "../core/profiles.js";

// Fixed entrypoint enables P17 SQLite work-stealing runtime.
process.exitCode = await runProfile(P17, process.argv.slice(2));
