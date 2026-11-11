// Fixed chapter entrypoints bind only P01, reusing CLI configuration, authorization, and error handling boundaries.
import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

// Chapter 1 fixed entry: binds only P01 profile, and reuses CLI configuration, authorization, and error handling boundaries.
//
// This file contains no agent logic; it passes command-line arguments to runProfile,
// runProfile implicitly fixes --chapter to 1 to prevent users from overriding chapter numbers from fixed entries.
//
// Fixed chapter scripts always run with the P01 profile, while generic CLI still parses command-line arguments.
// Forward command-line arguments; runProfile implicitly fixes --chapter to 1.
process.exitCode = await runProfile(P01, process.argv.slice(2));
