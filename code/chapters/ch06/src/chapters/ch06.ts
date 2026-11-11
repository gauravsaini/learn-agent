// Fixed entrypoint enables P06 controlled subagent delegation capabilities.
import { runProfile } from "../cli.js";
import { P06 } from "../core/profiles.js";

process.exitCode = await runProfile(P06, process.argv.slice(2));
