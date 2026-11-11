// Fixed chapter entrypoints select the P03 profile containing policy.
import { runProfile } from "../cli.js";
import { P03 } from "../core/profiles.js";

process.exitCode = await runProfile(P03, process.argv.slice(2));
