import { runProfile } from "../cli.js";
import { P02 } from "../core/profiles.js";

// Fixed to P02, exposing file tools and Tool Registry while skipping Chapter 3 permission policy capabilities.
process.exitCode = await runProfile(P02, process.argv.slice(2));
