import { runProfile } from "../cli.js";
import { P11 } from "../core/profiles.js";

// Fixed entrypoint enables P11 model request recovery boundary.
process.exitCode = await runProfile(P11, process.argv.slice(2));
