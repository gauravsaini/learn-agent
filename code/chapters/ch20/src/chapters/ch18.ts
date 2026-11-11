import { runProfile } from "../cli.js";
import { P18 } from "../core/profiles.js";

// Fixed entrypoint enables P18 task-to-Git worktree isolation runtime.
process.exitCode = await runProfile(P18, process.argv.slice(2));
