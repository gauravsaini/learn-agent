import { runProfile } from "../cli.js";
import { P08 } from "../core/profiles.js";

// Fixed entrypoint enables P08 artifact and context compaction capabilities.
// Fixed entrypoint selects P08: composition root creates CompactionManager and connects it to request history processor
// And tool result handler; common Loop drives large result persistence and request-level compaction, without duplicating the Agent Loop at entry points.
process.exitCode = await runProfile(P08, process.argv.slice(2));
