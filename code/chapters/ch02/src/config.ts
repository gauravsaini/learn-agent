/**
 * Configuration module: reads OpenAI connection parameters from .env file or process environment variables.
 * settingsFromMapping is a pure function. Tests can call it directly after validating and normalizing configuration;
 * settingsFromEnvFile reads local .env at the process boundary and reuses the same validation.
 * baseUrl must not end with /chat/completions. Otherwise the SDK constructs an invalid path.
 */
import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// Minimal environment variable set for model connection; later chapters promote fallback to required as needed.
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

// Retains missing fields so CLI can distinguish configuration issues from runtime failures.
export class ConfigurationError extends Error {
  // Stable error name; the CLI uses it to select the configuration error exit code.
  override readonly name = "ConfigurationError";
  // Missing or invalid environment variable name; freeze the copy to prevent tampering with the error object.
  readonly missingFields: readonly string[];

  // Create an actionable error from all invalid fields, with an optional cause preserving the URL parsing failure reason.
  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

export interface OpenAISettings {
  // Validated SDK base address; cannot be a full Chat Completions endpoint.
  readonly baseUrl: string;
  // Access key with leading and trailing whitespace trimmed.
  readonly apiKey: string;
  // Default model identifier.
  readonly model: string;
  // Fallback model used by subsequent recovery capabilities; P02 does not mandate it.
  readonly fallbackModel?: string;
}

// Validates completely before reading fields, avoiding masking missing connection configuration with default values.
export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  const missing = fields.filter((field) => {
    const value = mapping[field];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }

  const baseUrl = mapping.OPENAI_BASE_URL;
  const apiKey = mapping.OPENAI_API_KEY;
  const model = mapping.OPENAI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new Error("validated OpenAI settings are incomplete");
  }
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

// .env parsing belongs to the process boundary; other validations reuse pure mapping functions for testing.
export function settingsFromEnvFile(path: string, requireFallback = false): OpenAISettings {
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
