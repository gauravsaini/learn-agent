import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// Configuration validation layer: Validates environment variables and API endpoints once before network requests.
//
// ConfigurationError brings the missing field list to the CLI boundary so callers provide actionable startup errors.
// Both settingsFromMapping and settingsFromEnvFile entry points resolve to immutable OpenAISettings.
// No default values are provided here for keys, models, or addresses: Missing or empty fields fail directly instead of hiding issues with implicit defaults.
//
// Three environment variables required for real model calls in Chapter 1; no implicit defaults are provided for keys and models.
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

// Configuration is validated once before network requests, allowing callers to provide actionable startup errors.
export class ConfigurationError extends Error {
  // Stable error name; the CLI uses it to select the configuration error exit code.
  override readonly name = "ConfigurationError";
  // Missing, blank, or invalid environment variable names; freeze the copy to prevent tampering after error creation.
  readonly missingFields: readonly string[];

  // Builds a single actionable error from all invalid fields, with optional cause preserving underlying URL/file failure reason.
  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

// OpenAI connection information validated through configuration boundary; subsequent layers no longer handle null or blank strings.
export interface OpenAISettings {
  // Validated and trimmed connection configuration required by OpenAI SDK.
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  // Fallback model used by Chapter 11 recovery policy; Chapter 1 does not require its presence.
  readonly fallbackModel?: string;
}

// Validates and normalizes configuration from environment variable mapping; requireFallback is enabled only in chapters with recovery capability.
export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  // Do not provide default values for key fields; empty strings and missing fields count as invalid configuration.
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  const missing = fields.filter((field) => {
    const value = mapping[field];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }

  // Prior missing checks narrowed required fields; this branch only defends against unexpected mapping changes after the check.
  const baseUrl = mapping.OPENAI_BASE_URL;
  const apiKey = mapping.OPENAI_API_KEY;
  const model = mapping.OPENAI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new Error("validated OpenAI settings are incomplete");
  }
  // Uses URL parser to confirm address validity, restricted to HTTP(S) protocols accessible by SDK.
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl.trim());
  } catch (error) {
    throw new ConfigurationError(["OPENAI_BASE_URL"], { cause: error });
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  // SDK appends Chat Completions path; a full endpoint leads to duplicate request paths.
  const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/chat/completions")) {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  const fallbackModel = mapping.OPENAI_FALLBACK_MODEL;
  return Object.freeze({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    ...(fallbackModel === undefined || fallbackModel.trim().length === 0
      ? {}
      : { fallbackModel: fallbackModel.trim() }),
  });
}

// Reuse the same mapping validation path after reading dotenv files to prevent diverging rules between files and process environments.
export function settingsFromEnvFile(path: string, requireFallback = false): OpenAISettings {
  // dotenv handles only file syntax parsing; settingsFromMapping validates field integrity.
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
