import { runProfile } from "../cli.js";
import { P15 } from "../core/profiles.js";

// Fixed entrypoint enables P15 teammate collaboration and mailbox communication.
process.exitCode = await runProfile(P15, process.argv.slice(2));
