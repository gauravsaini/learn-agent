import { runProfile } from "../cli.js";
import { P07 } from "../core/profiles.js";

// Fixed entrypoint selects P07: composition root scans workspace skills/ and adds catalog snapshots to System Prompt,
// Register load_skill as well; content enters history only after explicit model invocation.
process.exitCode = await runProfile(P07, process.argv.slice(2));
