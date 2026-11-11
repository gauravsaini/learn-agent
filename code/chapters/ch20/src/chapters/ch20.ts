import { runProfile } from "../cli.js";
import { P20 } from "../core/profiles.js";

// Fixed entrypoint runs P20 Full Harness; CLI handles resource cleanup and error code returns upon exit.
process.exitCode = await runProfile(P20, process.argv.slice(2));
