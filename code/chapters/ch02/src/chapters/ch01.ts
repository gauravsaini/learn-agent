/**
 * P01 fixed entry point: locks the chapter profile to P01,
 * Block callers from enabling P02 file capabilities prematurely via general CLI arguments.
 */
import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

// Standalone scripts are fixed to P01 to prevent callers from escalating to P02 file capabilities through arguments.
process.exitCode = await runProfile(P01, process.argv.slice(2));
