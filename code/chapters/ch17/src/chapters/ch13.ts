import { runProfile } from "../cli.js";
import { P13 } from "../core/profiles.js";

// Fixed entrypoint enables P13 background task event runtime.
process.exitCode = await runProfile(P13, process.argv.slice(2));
