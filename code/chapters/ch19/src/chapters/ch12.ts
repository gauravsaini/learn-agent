import { runProfile } from "../cli.js";
import { P12 } from "../core/profiles.js";

// Fixed entrypoint enables P12 persistent task DAG tools.
process.exitCode = await runProfile(P12, process.argv.slice(2));
