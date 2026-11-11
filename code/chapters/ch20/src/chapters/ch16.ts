import { runProfile } from "../cli.js";
import { P16 } from "../core/profiles.js";

// Fixed entrypoint enables P16 plan approval protocol and execution gating.
process.exitCode = await runProfile(P16, process.argv.slice(2));
