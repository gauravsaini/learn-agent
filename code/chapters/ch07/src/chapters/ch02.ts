// Fixed to P02, exposing file tools without connecting subsequent permission and Hook capabilities.
import { runProfile } from "../cli.js";
import { P02 } from "../core/profiles.js";

process.exitCode = await runProfile(P02, process.argv.slice(2));
