import { runProfile } from "../cli.js";
import { P05 } from "../core/profiles.js";

// Fixed entrypoint enables P05 TODO planning capabilities.
process.exitCode = await runProfile(P05, process.argv.slice(2));
