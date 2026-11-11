import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

// Fixed to P01, containing only loop and PowerShell capabilities without Tool Registry or file tools.
process.exitCode = await runProfile(P01, process.argv.slice(2));
