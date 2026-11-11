import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ConfigurationError, settingsFromMapping } from "../src/config.js";
import { runCli } from "../src/cli.js";

describe("OpenAI settings", () => {
  test("the unified CLI exits with code 2 before network access when config is missing", async () => {
    // CLI resolves .env from process.cwd(), so switching to a temporary directory without .env asserts missing configuration;
    // Cannot delete the real .env at the repository root: 20 chapters share the same file, and concurrent test cases would remove each other's credentials.
    const originalCwd = process.cwd();
    const isolated = mkdtempSync(join(tmpdir(), "agent-tutorial-config-"));
    process.chdir(isolated);
    try {
      await expect(runCli(["run", "--chapter", "1", "--prompt", "test"])).resolves.toBe(2);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("lists every missing required field before a client can be created", () => {
    try {
      settingsFromMapping({ OPENAI_API_KEY: " " });
      throw new Error("expected settingsFromMapping to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).missingFields).toEqual([
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
      ]);
    }
  });

  test.each(["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const)(
    "reports %s when that individual field is blank",
    (field) => {
      const values = {
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
        [field]: " ",
      };
      try {
        settingsFromMapping(values);
        throw new Error("expected settingsFromMapping to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).missingFields).toEqual([field]);
      }
    },
  );

  test("keeps explicit values and does not invent a fallback model", () => {
    expect(
      settingsFromMapping({
        OPENAI_BASE_URL: " https://example.test/v1 ",
        OPENAI_API_KEY: " test-key ",
        OPENAI_MODEL: " test-model ",
      }),
    ).toEqual({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
  });

  test("rejects a non-HTTP base URL before client construction", () => {
    expect(() =>
      settingsFromMapping({
        OPENAI_BASE_URL: "file:///tmp/model",
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
      }),
    ).toThrow(ConfigurationError);
  });

  test("rejects a Chat Completions endpoint instead of letting the SDK append it twice", () => {
    expect(() =>
      settingsFromMapping({
        OPENAI_BASE_URL: "https://example.test/v1/chat/completions",
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
      }),
    ).toThrow(ConfigurationError);
  });
});
