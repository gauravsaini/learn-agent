// Fixed to P01 to prevent this entrypoint from accidentally enabling capabilities from subsequent chapters.
import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

process.exitCode = await runProfile(P01, process.argv.slice(2));
