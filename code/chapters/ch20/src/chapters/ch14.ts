import { runProfile } from "../cli.js";
import { P14 } from "../core/profiles.js";

// Fixed entrypoint enables P14 persistent Cron scheduling runtime.
process.exitCode = await runProfile(P14, process.argv.slice(2));
