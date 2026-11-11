/**
 * P02 fixed entry point: locks the chapter profile to P02,
 * Ensure shell and the four file tools are prepared at once under this entry point.
 */
import { runProfile } from "../cli.js";
import { P02 } from "../core/profiles.js";

// Fixed entrypoint locks P02 to prevent generic CLI from selecting capability sets outside this snapshot.
process.exitCode = await runProfile(P02, process.argv.slice(2));
