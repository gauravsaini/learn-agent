import { runProfile } from "../cli.js";
import { P09 } from "../core/profiles.js";

// Fixed entrypoint enables P09 file-level persistent memory lifecycle.
process.exitCode = await runProfile(P09, process.argv.slice(2));
