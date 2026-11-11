// Runtime configuration: Read OpenAI parameters from .env or explicit mapping, and centrally validate missing fields, URL protocols, and fallback before creating network clients.
import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// Three fields are hard prerequisites before network client creation; missing fields prevent generating an incomplete client.
// File responsibility: centrally load and validate OpenAI-compatible settings. Catch missing, blank, or invalid URLs before creating the network client.
// Fail, cannot pass unvalidated configurations to SDK, recovery layer, or subsequent callers.
// Base model configuration; subsequent chapters can explicitly require fallback models.
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

// Configuration errors retain all missing fields, allowing callers to fix them at once rather than reporting field by field.
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

// Validated configuration snapshot: baseUrl is resolvable http/https, fields are trimmed, and the object is immutable.
export interface OpenAISettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fallbackModel?: string;
}

// Constructs configuration from any mapping. Values in mapping can be string | undefined, so this must explicitly validate whitespace,
// URL protocol and frozen results: do not assume the caller cleaned environment variables.
export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  // Collects all missing fields first to prevent users from fixing one field only to discover the next.
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
    // Parses with URL first, then checks protocol separately; SDK might accept non-HTTP URLs, but Agent configuration forbids file/data protocols.
    parsedBaseUrl = new URL(baseUrl.trim());
  } catch (error) {
    throw new ConfigurationError(["OPENAI_BASE_URL"], { cause: error });
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  const fallbackModel = mapping.OPENAI_FALLBACK_MODEL;
  // Returns a frozen snapshot to prevent configuration from being overwritten by callers during execution.
  // Returns a frozen snapshot to prevent configuration from being overwritten by callers during execution; trims all values to avoid leading or trailing whitespace in network requests.
  return Object.freeze({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    ...(fallbackModel === undefined || fallbackModel.trim().length === 0
      ? {}
      : { fallbackModel: fallbackModel.trim() }),
  });
}

export function settingsFromEnvFile(path: string, requireFallback = false): OpenAISettings {
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
