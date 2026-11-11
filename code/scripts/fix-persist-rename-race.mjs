// Add Windows rename race retries to persistDatabase in ch17–ch20.
// Measured: Under full parallelism, rename(temp -> tasks.sqlite3) returns EPERM; transaction is COMMITted but disk flush fails,
// Subsequent lookupClaim becomes "claim token is known but no longer active", presenting as tool_context_error.
// The lock acquisition path for the same file already handles similar errors using isWindowsLockRace + LOCK_RETRY_MS + MAX_WINDOWS_LOCK_RACE_RETRIES,
// Reuses the same constants and semantics here without adding new mechanisms.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const FROM = `    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}`;

const TO = `    handle = undefined;
    // On Windows, antivirus, indexers, or concurrent read handles can briefly hold the target database, and rename returns EPERM;
    // Transaction has committed; must retry here instead of discarding committed state.
    let raceRetries = 0;
    for (;;) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (isWindowsLockRace(error) && raceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
          raceRetries += 1;
          await delay(LOCK_RETRY_MS);
          continue;
        }
        throw error;
      }
    }
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}`;

for (const chapter of ["ch17", "ch18", "ch19", "ch20"]) {
  const file = join(ROOT, chapter, "src", "adapters", "task-sqlite.ts");
  const original = readFileSync(file, "utf8");

  // Three dependent helpers must already exist in the same file, otherwise the chapter structure does not match expectations.
  for (const helper of ["isWindowsLockRace", "MAX_WINDOWS_LOCK_RACE_RETRIES", "LOCK_RETRY_MS"]) {
    if (!original.includes(helper)) {
      throw new Error(`${chapter}: Missing ${helper}`);
    }
  }

  const hits = original.split(FROM).length - 1;
  if (hits !== 1) {
    throw new Error(`${chapter}: Expected 1 hit, got ${hits} hits`);
  }
  writeFileSync(file, original.replace(FROM, TO), { encoding: "utf8" });
  console.log(`${chapter} Fixed`);
}
