// MCP stdio client adapter: encapsulates SDK initialization, paginated discovery, serial calls, timeout mapping, and child process terminal state propagation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  McpCallResult,
  McpContractError,
  McpPublishedTool,
  McpTimeoutError,
  McpTransportError,
} from "../features/mcp-tools.js";
import type { McpConnection, McpConnectionFactory, McpServerSpec } from "../features/mcp-tools.js";

const CLIENT_INFO = Object.freeze({ name: "agent-tutorial", version: "0.1.0" });
// Observe child process state briefly after request timeout to distinguish pure timeouts from transport exits.
const TRANSPORT_EXIT_GRACE_MS = 100;

// stdio factory delivers instances only after successful connection; close child process resources first if initialization fails.
export class StdioMcpConnectionFactory implements McpConnectionFactory {
  async open(spec: McpServerSpec, signal?: AbortSignal): Promise<McpConnection> {
    // Successful start is the factory delivery boundary; on failure, close client/transport with best effort to avoid orphan child processes.
    const connection = new StdioMcpConnection(spec);
    try {
      await connection.start(signal);
      return connection;
    } catch (error) {
      await connection.closeAfterFailedStart();
      throw error;
    }
  }
}

// A single connection serializes requests and propagates transport termination to queued and active MCP calls.
class StdioMcpConnection implements McpConnection {
  // spec determines startup command and timeout; transport/client lifecycles map one-to-one with this connection instance.
  readonly #spec: McpServerSpec;
  readonly #transport: StdioClientTransport;
  readonly #client: Client;
  // Serial queue tail-chain: new operations on the same connection always queue behind existing operations.
  #tail: Promise<void> = Promise.resolve();
  // The first irreversible transport error is recorded only once, terminating all current waiters and failing subsequent operations directly.
  #terminalError: McpTransportError | undefined;
  // terminalFailure joins the Promise.race of executing requests; terminalSignal notifies Watchdog only.
  #rejectTerminal: (error: McpTransportError) => void = () => {};
  #resolveTerminal: () => void = () => {};
  readonly #terminalFailure = new Promise<never>((_, reject) => {
    this.#rejectTerminal = (error) => reject(error);
  });
  readonly #terminalSignal = new Promise<void>((resolve) => {
    this.#resolveTerminal = resolve;
  });
  #closing = false;
  // closed is the final resource state; started prevents the same SDK client from initializing repeatedly.
  #closed = false;
  #started = false;

  constructor(spec: McpServerSpec) {
    // The construction stage only creates transport/client and binds terminal callbacks without starting subprocess protocol handshakes.
    this.#spec = spec;
    this.#transport = new StdioClientTransport({
      command: spec.command,
      args: [...spec.args],
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      stderr: "ignore",
    });
    this.#client = new Client(CLIENT_INFO, { capabilities: {} });
    // Consume terminal rejection early to prevent unhandled rejection on unwatched Promises.
    void this.#terminalFailure.catch(() => undefined);
    this.#transport.onclose = () => {
      if (!this.#closing && !this.#closed) {
        this.#markTerminal(new McpTransportError("MCP stdio transport closed"));
      }
    };
    this.#transport.onerror = (error: Error) => {
      if (!this.#closing && !this.#closed) {
        this.#markTerminal(new McpTransportError("MCP stdio transport failed", { cause: error }));
      }
    };
  }

  // Start connection: wait for initialize to complete, and confirm transport has not already failed after establishing the connection.
  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) {
      throw new McpTransportError("MCP stdio connection was already started");
    }
    this.#started = true;
    try {
      await this.#client.connect(this.#transport, {
        ...(signal === undefined ? {} : { signal }),
        timeout: milliseconds(this.#spec.startupTimeoutSeconds),
        maxTotalTimeout: milliseconds(this.#spec.startupTimeoutSeconds),
      });
    } catch (error) {
      throw mapSdkError(error, "MCP stdio initialize failed");
    }
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
  }

  // Reads tools/list with pagination, validating name, description, and input schema contracts declared remotely.
  async listTools(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly McpPublishedTool[]> {
    return await this.#enqueue(async () => {
      const tools: McpPublishedTool[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      while (true) {
        const result = await this.#client.listTools(
          cursor === undefined ? undefined : { cursor },
          requestOptions(this.#spec.startupTimeoutSeconds, options.signal),
        );
        for (const tool of result.tools) {
          if (!isRecord(tool.inputSchema)) {
            throw new McpContractError("MCP tools/list returned a non-object input schema");
          }
          tools.push(
            new McpPublishedTool({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              inputSchema: tool.inputSchema,
            }),
          );
        }
        cursor = result.nextCursor;
        if (cursor === undefined) return Object.freeze(tools);
        if (seenCursors.has(cursor)) {
          throw new McpTransportError("MCP tools/list repeated a pagination cursor");
        }
        seenCursors.add(cursor);
      }
    }, options.signal);
  }

  // Call remote tools, returning only contract-validated content, structuredContent, and isError to upper layers.
  async callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    options: { readonly timeoutSeconds: number; readonly signal?: AbortSignal },
  ): Promise<McpCallResult> {
    return await this.#enqueue(async () => {
      const result = await this.#client.callTool(
        { name, arguments: { ...argumentsValue } },
        undefined,
        requestOptions(options.timeoutSeconds, options.signal),
      );
      if (!isRecord(result)) {
        throw new McpContractError("MCP tools/call returned an invalid result");
      }
      const rawContent = Reflect.get(result, "content");
      if (!Array.isArray(rawContent) || !rawContent.every(isRecord)) {
        throw new McpContractError("MCP tools/call content is invalid");
      }
      const rawStructuredContent = Reflect.get(result, "structuredContent");
      if (
        rawStructuredContent !== undefined &&
        rawStructuredContent !== null &&
        !isRecord(rawStructuredContent)
      ) {
        throw new McpContractError("MCP tools/call structured content is invalid");
      }
      const rawIsError = Reflect.get(result, "isError");
      if (rawIsError !== undefined && typeof rawIsError !== "boolean") {
        throw new McpContractError("MCP tools/call isError is invalid");
      }
      return new McpCallResult({
        content: rawContent,
        structuredContent: rawStructuredContent === undefined ? null : rawStructuredContent,
        isError: rawIsError === true,
      });
    }, options.signal);
  }

  // Normal shutdown: wait for existing queue operations to end before closing the SDK client, avoiding interrupting active requests.
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try {
      await this.#tail;
      await this.#client.close();
    } catch (error) {
      this.#closing = false;
      throw mapSdkError(error, "MCP stdio connection close failed");
    }
    this.#closed = true;
    this.#terminalError = undefined;
    this.#resolveTerminal();
  }

  // Fallback close on startup failure; close transport directly if client close fails, reclaiming child processes where possible.
  async closeAfterFailedStart(): Promise<void> {
    this.#closing = true;
    try {
      await this.#client.close();
    } catch {
      await this.#transport.close();
    } finally {
      this.#closed = true;
      this.#resolveTerminal();
    }
  }

  // Expose the "connection terminated" signal to runtime so Watchdog revokes dynamic tools for this alias.
  waitForFailure(): Promise<void> {
    return this.#terminalSignal;
  }

  // Single-connection serial queue: operations execute sequentially while racing transport termination and caller aborts.
  async #enqueue<Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    if (!this.#started) throw new McpTransportError("MCP stdio connection was not started");
    if (this.#closed) throw new McpTransportError("MCP stdio connection is closed");
    if (this.#terminalError !== undefined) throw this.#terminalError;
    const queued = this.#tail.then(async () => {
      if (signal?.aborted) throw abortReason(signal);
      if (this.#terminalError !== undefined) throw this.#terminalError;
      try {
        return await Promise.race([operation(), this.#terminalFailure]);
      } catch (error) {
        if (error instanceof McpContractError || isAbortError(error)) throw error;
        if (isRequestTimeout(error) && (await this.#waitForTransportClosure())) {
          throw new McpTransportError("MCP stdio process exited during request", { cause: error });
        }
        throw mapSdkError(error, "MCP stdio request failed");
      }
    });
    // Regardless of queued outcome, resolve tail to undefined. This ensures the next operation queues after the current batch finishes.
    this.#tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return await waitForAbort(queued, signal);
  }

  // Record the first irreversible transport error and wake up all waiting calls; subsequent operations fail immediately.
  #markTerminal(error: McpTransportError): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error;
    this.#rejectTerminal(error);
    this.#resolveTerminal();
  }

  // Provide a short observation window for RequestTimeout to check whether the child process exited or protocol timed out.
  async #waitForTransportClosure(): Promise<boolean> {
    if (this.#transport.pid === null || this.#terminalError !== undefined) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (closed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(closed);
      };
      const timer = setTimeout(
        () => finish(this.#transport.pid === null || this.#terminalError !== undefined),
        TRANSPORT_EXIT_GRACE_MS,
      );
      void this.#terminalFailure.then(
        () => finish(true),
        () => finish(true),
      );
    });
  }
}

// Uniformly convert second-based configuration to SDK single-request timeout and total timeout.
function requestOptions(
  seconds: number,
  signal?: AbortSignal,
): {
  readonly timeout: number;
  readonly maxTotalTimeout: number;
  readonly signal?: AbortSignal;
} {
  // Single and cumulative SDK timeouts use the same budget to prevent internal retries from exceeding local policy caps.
  const timeout = milliseconds(seconds);
  return Object.freeze({
    timeout,
    maxTotalTimeout: timeout,
    ...(signal === undefined ? {} : { signal }),
  });
}

// Convert seconds to milliseconds, and reject NaN, zero, or configurations exceeding SDK integer limits.
function milliseconds(seconds: number): number {
  const value = seconds * 1000;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new McpContractError("MCP timeout is outside the supported millisecond range");
  }
  return Math.max(1, Math.ceil(value));
}

// Map SDK exceptions to local error types, preserving abort as-is to avoid mistaking business errors for protocol errors.
function mapSdkError(error: unknown, message: string): Error {
  if (isAbortError(error)) return error;
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new McpTimeoutError(message, { cause: error });
  }
  if (error instanceof McpError || error instanceof Error) {
    return new McpTransportError(message, { cause: error });
  }
  return new McpTransportError(message, { cause: error });
}

// Identify RequestTimeout error code in the MCP SDK to distinguish timeouts from connection loss.
function isRequestTimeout(error: unknown): error is McpError {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

// Attach caller abort listeners to async results, rejecting only current waiters on cancellation.
function waitForAbort<Result>(promise: Promise<Result>, signal?: AbortSignal): Promise<Result> {
  // AbortSignal cancels only current caller wait; the underlying serial queue still settles actual SDK operations.
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// Generate a unified, recognizable AbortError cause.
function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

// Determine whether the object thrown by the SDK is an AbortError.
function isAbortError(value: unknown): value is Error {
  return value instanceof Error && value.name === "AbortError";
}

// Type guard: checks if an unknown value is a plain object that is non-null and non-array.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
