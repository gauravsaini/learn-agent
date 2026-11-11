import { runProfile } from "../cli.js";
import { P10 } from "../core/profiles.js";

// Fixed entrypoint enables P10 dynamic system prompt rendering.
process.exitCode = await runProfile(P10, process.argv.slice(2));
