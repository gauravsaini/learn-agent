// Move the two ch13 tools query_background_job / cancel_background_job (along with JobSupervisor.getJob,
// zod schema, payload serialization) moved to ch14–ch20 to fix capability regression in cumulative snapshots.
// Idempotent: skip chapters that already contain target text. Throw errors on missing or multiple anchor hits; never drift silently.
import { readFile, writeFile } from "node:fs/promises";

const CHAPTERS = ["ch14", "ch15", "ch16", "ch17", "ch18", "ch19", "ch20"];
const ROOT = new URL("../chapters/", import.meta.url);

function replaceOnce(body, from, to, label) {
  const hits = body.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(`${label}: Anchor hit ${hits} times, expected 1 time`);
  }
  return body.replace(from, to);
}

const ZOD_IMPORT = 'import { randomUUID } from "node:crypto";\n';
const ZOD_IMPORT_TO = 'import { randomUUID } from "node:crypto";\n\nimport { z } from "zod";\n';

const TYPE_IMPORT =
  'import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "../core/tools.js";';
const TYPE_IMPORT_TO = `import type {
  PreparedToolCall,
  ToolContext,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../core/tools.js";`;

const GET_JOB_ANCHOR = "  async cancel(jobId: string): Promise<void> {";
const GET_JOB_TO = `  // Queries read-only persisted state without starting worker; unknown ID is converted to stable domain error by store.
  async getJob(jobId: string): Promise<BackgroundJob> {
    await this.#ready;
    return await this.#store.getJob(canonicalBackgroundId(jobId));
  }

${GET_JOB_ANCHOR}`;

const TOOL_BLOCK = `
const backgroundJobIdSchema = z.string().regex(CANONICAL_UUID, "job_id must be a canonical UUID");
const backgroundJobIdInputSchema = z.object({ job_id: backgroundJobIdSchema }).strict();

// Background tools share style with task tools: strict schema, domain errors convert to stable ToolResults, and payloads use disk field names.
export function registerBackgroundJobTools(
  registry: ToolRegistry,
  supervisor: JobSupervisor,
): void {
  // The background exposes only query and cancel tools; shell Dispatcher automatically handles creation and execution.
  registry.register(queryBackgroundJobDefinition(supervisor));
  registry.register(cancelBackgroundJobDefinition(supervisor));
}

// Query tool definition: read persisted state and terminal results without side effects.
function queryBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "query_background_job",
    description: "Read the persisted status and result of one background job.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "read",
    handler: async (input) => {
      try {
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

// Cancel tool definition: cancel a running job and return its persistent state after cancellation.
function cancelBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "cancel_background_job",
    description: "Cancel a running background job and persist its cancelled status.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "write",
    handler: async (input) => {
      try {
        await supervisor.cancel(input.job_id);
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

function backgroundJobToolError(error: unknown) {
  // Known background domain errors retain stable error codes; throw unknown exceptions upward to avoid swallowing bugs.
  if (error instanceof BackgroundError) {
    return toolError(error.errorCode, error.message);
  }
  throw error;
}

function backgroundJobPayload(job: BackgroundJob): Readonly<Record<string, unknown>> {
  // Model-visible fields match the event payload; result unifies into three fields: content, error_code, and is_error.
  return Object.freeze({
    job_id: job.id,
    status: job.status,
    tool_name: job.toolName,
    source_tool_call_id: job.sourceToolCallId,
    result:
      job.result === null
        ? null
        : {
            content: job.result.content,
            error_code: job.result.errorCode ?? null,
            is_error: job.result.isError,
          },
  });
}
`;

const BOOTSTRAP_IMPORT =
  'import { BackgroundDispatcher, type JobSupervisor } from "./features/background.js";';
const BOOTSTRAP_IMPORT_TO = `import {
  BackgroundDispatcher,
  registerBackgroundJobTools,
  type JobSupervisor,
} from "./features/background.js";`;

const REGISTER_ANCHOR = `  if (dependencies.taskStore !== undefined) {
    // Primary Agent directly registers persistent task tools and shares the same TaskStore with subagents.
    registerTaskTools(tools, dependencies.taskStore);
  }
`;
const REGISTER_ANCHOR_BARE = `  if (dependencies.taskStore !== undefined) {
    registerTaskTools(tools, dependencies.taskStore);
  }
`;
const REGISTER_BLOCK = `  if (dependencies.backgroundSupervisor !== undefined) {
    // Primary Agent registers background query and cancellation tools; subagents receive no background Supervisor, so do not expose these capabilities.
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
`;

for (const chapter of CHAPTERS) {
  const backgroundPath = new URL(`${chapter}/src/features/background.ts`, ROOT);
  let background = await readFile(backgroundPath, "utf8");
  if (background.includes("registerBackgroundJobTools")) {
    console.log(`${chapter} background.ts already contains tools, skipping`);
  } else {
    background = replaceOnce(background, ZOD_IMPORT, ZOD_IMPORT_TO, `${chapter} zod import`);
    background = replaceOnce(background, TYPE_IMPORT, TYPE_IMPORT_TO, `${chapter} type import`);
    background = replaceOnce(background, GET_JOB_ANCHOR, GET_JOB_TO, `${chapter} getJob`);
    if (!background.endsWith("\n")) {
      throw new Error(`${chapter} background.ts missing newline at end of file`);
    }
    background += TOOL_BLOCK;
    await writeFile(backgroundPath, background, "utf8");
    console.log(`${chapter} background.ts backfilled two tools and getJob`);
  }

  const bootstrapPath = new URL(`${chapter}/src/bootstrap.ts`, ROOT);
  let bootstrap = await readFile(bootstrapPath, "utf8");
  if (bootstrap.includes("registerBackgroundJobTools")) {
    console.log(`${chapter} bootstrap.ts already registered, skipping`);
    continue;
  }
  bootstrap = replaceOnce(
    bootstrap,
    BOOTSTRAP_IMPORT,
    BOOTSTRAP_IMPORT_TO,
    `${chapter} bootstrap import`,
  );
  const anchor = bootstrap.includes(REGISTER_ANCHOR) ? REGISTER_ANCHOR : REGISTER_ANCHOR_BARE;
  bootstrap = replaceOnce(bootstrap, anchor, `${anchor}${REGISTER_BLOCK}`, `${chapter} register`);
  await writeFile(bootstrapPath, bootstrap, "utf8");
  console.log(`${chapter} bootstrap.ts already registered background tools`);
}
