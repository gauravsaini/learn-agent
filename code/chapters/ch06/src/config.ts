// Model configuration: read OpenAI-compatible settings from environment variables or .env, and validate missing fields all at once.
import { readFileSync } from "node:fs";

// Reads model configuration from environment variables or .env file; reports all missing fields at once.
import { parse } from "dotenv";

// Reads model configuration from environment variables or .env file; reports all missing fields at once.
// Base model configuration; subsequent chapters can explicitly require fallback models.
// Reads model configuration from environment variables or .env file; collectAllMissing mode reports all missing fields at once.
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

export class ConfigurationError extends Error {
  // Configuration errors carry all missing fields; CLI process boundary returns exit code 2 accordingly.
  override readonly name = "ConfigurationError";
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

export interface OpenAISettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fallbackModel?: string;
}

export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  // Collects all missing fields first to prevent users from fixing one field only to discover the next.
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  // Collects all missing fields first to prevent users from fixing one field only to discover the next.
  const missing = fields.filter((field) => {
    const value = mapping[field];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }

  // Fields are non-empty, but baseUrl still requires protocol and path validation to prevent SDK from constructing incorrect request addresses.
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
  // SDK appends Chat Completions path; passing a full endpoint leads to duplicate request paths.
  const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/chat/completions")) {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  const fallbackModel = mapping.OPENAI_FALLBACK_MODEL;
  // Returns a frozen snapshot to prevent configuration from being overwritten by callers during execution.
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
  // .env parsing also uses mapping validation. Offline tests can inject fake files or inject mappings directly.
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
