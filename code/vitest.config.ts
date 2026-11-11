import { defineConfig } from "vitest/config";

// Tests in this repository make heavy use of real file systems and proper-lockfile directory locks (100 retries x 10ms),
// sql.js disk writes and git child processes; running 65 test files in parallel makes wall-clock time for a single case exceed vitest's default 5s.
// These timeouts are safety nets to prevent test cases from hanging permanently, not performance assertions. They are relaxed uniformly rather than per test case.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
