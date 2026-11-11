import { runProfile } from "../cli.js";
import { P03 } from "../core/profiles.js";

// Fixed chapter entrypoints select policy capability; composition root injects approval, audit, and workspace write boundaries accordingly.
process.exitCode = await runProfile(P03, process.argv.slice(2));
