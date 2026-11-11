// Fixed chapter entrypoint: starts with P04 profile, enabling the Hook lifecycle.
import { runProfile } from "../cli.js";
import { P04 } from "../core/profiles.js";

process.exitCode = await runProfile(P04, process.argv.slice(2));
