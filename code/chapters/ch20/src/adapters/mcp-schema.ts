// MCP JSON Schema adapter: selects corresponding Ajv dialect and forbids remote schemas from loading external resources via references.
import { Ajv, type AnySchema } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";

import { McpContractError } from "../features/mcp-tools.js";
import type { McpSchemaValidator } from "../features/mcp-tools.js";

// JSON Schema reference keyword set: checks whether references in schema point to intra-document # fragments.
const SCHEMA_REFERENCE_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

// Ajv schema validator: compiles remote JSON Schema at publish time, rejecting external references and non-serializable schemas.
export class AjvMcpSchemaValidator implements McpSchemaValidator {
  compile(
    exposedName: string,
    inputSchema: Readonly<Record<string, unknown>>,
  ): (value: unknown) => boolean {
    // Compilation occurs during tool publishing; return predicates report pass/fail only, and Ajv details do not enter model context.
    try {
      if (inputSchema.type !== "object") {
        throw new McpContractError(`MCP tool input schema must have type object: ${exposedName}`);
      }
      // Performs a JSON round-trip first to eliminate circular references, functions, and non-serializable objects before passing to Ajv.
      const serialized = JSON.stringify(inputSchema);
      if (serialized === undefined) {
        throw new McpContractError(
          `MCP tool input schema is not JSON serializable: ${exposedName}`,
        );
      }
      const parsed: unknown = JSON.parse(serialized);
      if (!isRecord(parsed)) {
        throw new McpContractError(`MCP tool input schema must be an object: ${exposedName}`);
      }
      requireLocalReferences(parsed, exposedName);
      const validator = selectAjv(parsed).compile(parsed as AnySchema);
      return (value: unknown) => validator(value) === true;
    } catch (error) {
      if (error instanceof McpContractError) throw error;
      throw new McpContractError(`MCP tool input schema is invalid: ${exposedName}`);
    }
  }
}

// Select the matching Ajv compiler (draft-07 / 2019-09 / 2020-12) by $schema version tag.
function selectAjv(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const dialect = schema.$schema;
  if (typeof dialect === "string" && dialect.includes("2020-12")) {
    return new Ajv2020({ strict: true });
  }
  if (typeof dialect === "string" && dialect.includes("2019-09")) {
    return new Ajv2019({ strict: true });
  }
  return new Ajv({ strict: true });
}

// Recursively checks whether $ref/$dynamicRef/$recursiveRef in schema starts with #, rejecting external references.
function requireLocalReferences(value: unknown, exposedName: string): void {
  if (Array.isArray(value)) {
    for (const item of value) requireLocalReferences(item, exposedName);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SCHEMA_REFERENCE_KEYS.has(key) && (typeof nested !== "string" || !nested.startsWith("#"))) {
      throw new McpContractError(
        `MCP tool input schema contains an external reference: ${exposedName}`,
      );
    }
    requireLocalReferences(nested, exposedName);
  }
}

// Type guard: checks if an unknown value is a plain object that is non-null and non-array.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
