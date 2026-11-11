import { runProfile } from "../cli.js";
import { P18 } from "../core/profiles.js";

// Fixed entrypoint reuses generic CLI, fixing only P18 profile to avoid passing --chapter repeatedly in chapter commands.
process.exitCode = await runProfile(P18, process.argv.slice(2));
