import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  detachedSpawnOptions,
  executableCandidates,
  killProcessTree,
} from "../platform/shell.js";
import type {
  CallToolResult,
  InitializeResult,
  JsonRpcId,
  McpToolDescriptor,
} from "./protocol.js";
import {
  CallToolResultSchema,
  classifyFrame,
  InitializeResultSchema,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_VERSION,
  ListToolsResultSchema,
  MCP_METHOD_INITIALIZE,
  MCP_METHOD_TOOLS_CALL,
  MCP_METHOD_TOOLS_LIST,
  MCP_NOTIFICATION_CANCELLED,
  MCP_NOTIFICATION_INITIALIZED,
  MCP_PROTOCOL_VERSION,
  McpToolDescriptorSchema,
} from "./protocol.js";

/**
 * A JSON-RPC-over-stdio client for one MCP server, hand-rolled.
 *
 * Written rather than taken from `@modelcontextprotocol/sdk` for the same
 * reason `@agent/ai` has its own SSE parser: the part of the protocol kapel
 * uses is three requests and two notifications over newline-delimited JSON, and
 * the house rule for external processes — validate every inbound byte at the
 * boundary, tolerate drift, never let the other end take a run down — is
 * easier to hold when the boundary is code in this repository. It also keeps
 * the published bundle's dependency list where it is.
 *
 * Everything the server sends is treated as untrusted: unparseable lines are
 * dropped, frames that do not correlate to a pending request are dropped,
 * requests *from* the server are answered "method not found" so it is never
 * left waiting, and any way the process can die — exit, spawn failure, a line
 * longer than {@link MAX_LINE_CHARS} — rejects every in-flight request with a
 * printable reason instead of hanging.
 */

/** Spawn plus handshake. Long enough for an `npx -y` first run, short enough to notice a hang. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
/** One `tools/call`. Matches the bash tool's default: a tool may do real work. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** How long a closing server gets to exit on its own before it is signalled. */
const DEFAULT_SHUTDOWN_GRACE_MS = 1000;

/**
 * The most a single frame may be before the connection is declared broken.
 *
 * A server that never writes a newline would otherwise grow this buffer until
 * the process dies; 8 MiB is far past any real tool result and far short of
 * that.
 */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** Stderr kept for diagnostics — enough to explain a failure, not a transcript. */
const MAX_STDERR_CHARS = 8000;

/** Pages of `tools/list` to follow before giving up on a cursor that never ends. */
const MAX_TOOL_LIST_PAGES = 20;

export interface McpStdioClientOptions {
  /** The configured server name, used only in error messages. */
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** Overlaid on `process.env`; see {@link McpServerConfig.env}. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory for the server process — normally the workspace root. */
  readonly cwd: string;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly settle: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Spawns one candidate executable, resolving once the OS has actually started
 * it. Rejects with the spawn error, which the caller inspects for `ENOENT` to
 * decide whether the next candidate is worth trying (Windows `.cmd` shims —
 * see {@link executableCandidates}).
 */
function spawnOnce(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...detachedSpawnOptions(),
    });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve(child);
    });
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export class McpStdioClient {
  readonly #options: McpStdioClientOptions;
  readonly #child: ChildProcess;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #buffer = "";
  #stderr = "";
  #nextId = 1;
  /** Set the moment the connection stops being usable; also the reason why. */
  #failure: string | undefined;
  #exited = false;
  #serverInfo: InitializeResult | undefined;

  private constructor(options: McpStdioClientOptions, child: ChildProcess) {
    this.#options = options;
    this.#child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (this.#stderr.length >= MAX_STDERR_CHARS) return;
      this.#stderr += chunk;
    });
    // `close` rather than `exit`: it fires once the pipes are drained, so a
    // server that printed its answer and immediately exited still gets that
    // answer delivered before everything pending is failed.
    child.on("close", (code, signal) => {
      this.#exited = true;
      const how =
        signal !== null
          ? `signal ${signal}`
          : `exit code ${String(code ?? -1)}`;
      this.#fail(`MCP server "${options.name}" stopped (${how})`);
    });
    child.on("error", (error) => {
      this.#fail(`MCP server "${options.name}" failed: ${errorMessage(error)}`);
    });
  }

  /**
   * Spawns the server and completes the MCP handshake, or throws with a
   * printable reason and nothing left running.
   */
  static async connect(
    options: McpStdioClientOptions,
  ): Promise<McpStdioClient> {
    const args = options.args ?? [];
    // The server's own environment is the parent's plus whatever the config
    // adds, which is how a `command: npx` finds a PATH at all. The config
    // layer wins on a collision, since naming a variable there is an explicit
    // instruction about this server.
    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };

    const candidates = executableCandidates(options.command);
    let child: ChildProcess | undefined;
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        child = await spawnOnce(candidate, args, options.cwd, env);
        break;
      } catch (error) {
        lastError = error;
        if (!isNotFound(error)) break;
      }
    }

    if (child === undefined) {
      throw new Error(
        `could not start "${options.command}": ${errorMessage(lastError)}`,
      );
    }

    const client = new McpStdioClient(options, child);
    try {
      await client.#handshake();
    } catch (error) {
      await client.close();
      throw error;
    }
    return client;
  }

  /** What the server said about itself at `initialize`. */
  serverInfo(): InitializeResult | undefined {
    return this.#serverInfo;
  }

  /**
   * Every tool the server offers, one page at a time.
   *
   * A descriptor that does not validate is dropped rather than failing the
   * listing: one unusable tool must not cost a server all of its others. The
   * count of dropped entries comes back so the caller can report it.
   */
  async listTools(): Promise<{
    readonly tools: readonly McpToolDescriptor[];
    readonly dropped: number;
  }> {
    const tools: McpToolDescriptor[] = [];
    let dropped = 0;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const raw = await this.#request(
        MCP_METHOD_TOOLS_LIST,
        cursor === undefined ? {} : { cursor },
      );
      const parsed = ListToolsResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `MCP server "${this.#options.name}" returned an unusable tools/list result`,
        );
      }

      for (const entry of parsed.data.tools) {
        const descriptor = McpToolDescriptorSchema.safeParse(entry);
        if (descriptor.success) tools.push(descriptor.data);
        else dropped += 1;
      }

      cursor = parsed.data.nextCursor;
      if (cursor === undefined) break;
    }

    return { tools, dropped };
  }

  /**
   * Calls one tool. A server-reported failure (`isError`) comes back in the
   * result rather than as a throw — it is the tool's answer, not a transport
   * problem — while a dead connection, a timeout or an unusable result throws.
   */
  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const raw = await this.#request(
      MCP_METHOD_TOOLS_CALL,
      { name, arguments: args ?? {} },
      signal,
    );
    const parsed = CallToolResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `MCP server "${this.#options.name}" returned an unusable tools/call result`,
      );
    }
    return parsed.data;
  }

  /**
   * Ends the connection and makes sure nothing survives it.
   *
   * The MCP shutdown sequence is "close stdin and let the server exit", so
   * that is tried first; a server still alive after the grace period is
   * signalled through {@link killProcessTree}, which reaps the whole process
   * group rather than just the direct child — an `npx` wrapper's real server
   * lives one level down, and killing only the wrapper would leak it.
   * Idempotent, and never throws: teardown runs from a `finally`.
   */
  async close(): Promise<void> {
    this.#fail(`MCP server "${this.#options.name}" was shut down`);
    if (this.#exited) return;

    const grace = this.#options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    const exited = new Promise<void>((resolve) => {
      if (this.#exited) {
        resolve();
        return;
      }
      this.#child.once("close", () => resolve());
    });

    try {
      this.#child.stdin?.end();
    } catch {
      // Already closed; the signals below are the fallback.
    }

    if (await this.#raceGrace(exited, grace)) return;
    killProcessTree(this.#child, "SIGTERM");
    if (await this.#raceGrace(exited, grace)) return;
    killProcessTree(this.#child, "SIGKILL");
    await this.#raceGrace(exited, grace);
  }

  /** Resolves true when `exited` won the race, false when the timer did. */
  async #raceGrace(exited: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref();
    });
    try {
      return await Promise.race([exited.then(() => true), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #handshake(): Promise<void> {
    const raw = await this.#request(
      MCP_METHOD_INITIALIZE,
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // kapel bridges tools and nothing else: it serves no roots, and it
        // does not offer the server a model to sample from. Declaring that
        // honestly is what lets a server skip features neither side would use.
        capabilities: {},
        clientInfo: { name: "kapel", version: "0.1" },
      },
      undefined,
      this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );

    const parsed = InitializeResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `MCP server "${this.#options.name}" returned an unusable initialize result`,
      );
    }
    this.#serverInfo = parsed.data;
    this.#notify(MCP_NOTIFICATION_INITIALIZED, {});
  }

  #request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    const failure = this.#failure;
    if (failure !== undefined) return Promise.reject(new Error(failure));
    if (signal?.aborted === true) {
      return Promise.reject(new Error(`${method} was cancelled`));
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const budget =
      timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#abandon(id, method);
        reject(
          new Error(
            `MCP server "${this.#options.name}" did not answer ${method} within ${String(budget)}ms`,
          ),
        );
      }, budget);
      timer.unref();

      const onAbort = (): void => {
        this.#abandon(id, method);
        reject(new Error(`${method} was cancelled`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        resolve,
        reject,
        settle: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      });

      try {
        this.#write({ jsonrpc: JSONRPC_VERSION, id, method, params });
      } catch (error) {
        this.#abandon(id, method);
        reject(
          new Error(`could not write to ${method}: ${errorMessage(error)}`),
        );
      }
    });
  }

  /**
   * Drops a pending request the caller has stopped waiting for (timeout or
   * abort) and tells the server so, which is the difference between a
   * cancelled call and a server still doing work nobody will read.
   */
  #abandon(id: JsonRpcId, method: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.settle();
    if (this.#failure !== undefined) return;
    this.#notify(MCP_NOTIFICATION_CANCELLED, {
      requestId: id,
      reason: `kapel stopped waiting for ${method}`,
    });
  }

  #notify(method: string, params: unknown): void {
    try {
      this.#write({ jsonrpc: JSONRPC_VERSION, method, params });
    } catch {
      // A notification nobody can receive changes nothing about the run.
    }
  }

  #write(frame: Record<string, unknown>): void {
    const stdin = this.#child.stdin;
    if (stdin === null || stdin.destroyed) {
      throw new Error(`MCP server "${this.#options.name}" has no open stdin`);
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;

    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#onLine(line);
    }

    if (this.#buffer.length > MAX_LINE_CHARS) {
      this.#buffer = "";
      this.#fail(
        `MCP server "${this.#options.name}" sent a frame over ${String(MAX_LINE_CHARS)} characters with no newline`,
      );
    }
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      // Servers print banners and warnings on stdout more often than they
      // should. A line that is not JSON is not a protocol violation worth
      // ending a session over.
      return;
    }

    const frame = classifyFrame(decoded);
    if (frame === undefined) return;

    switch (frame.kind) {
      case "response": {
        this.#settle(frame.id, (pending) => pending.resolve(frame.result));
        return;
      }
      case "error": {
        const { code, message } = frame.error;
        this.#settle(frame.id, (pending) =>
          pending.reject(new Error(`${message} (JSON-RPC ${String(code)})`)),
        );
        return;
      }
      case "request": {
        // kapel implements no server-to-client methods (see `#handshake`'s
        // empty capabilities). Answering is not optional: a server that asked
        // would otherwise block on a reply that never comes.
        this.#notifyError(frame.id, frame.method);
        return;
      }
      case "notification":
        // Progress, logging, list-changed: nothing kapel acts on today.
        return;
    }
  }

  #notifyError(id: JsonRpcId, method: string): void {
    try {
      this.#write({
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: JSONRPC_METHOD_NOT_FOUND,
          message: `kapel does not implement ${method}`,
        },
      });
    } catch {
      // The connection is going away anyway.
    }
  }

  #settle(id: JsonRpcId, apply: (pending: PendingRequest) => void): void {
    const pending = this.#pending.get(id);
    // An id nobody is waiting on is a late answer to something already
    // abandoned, or a frame we never sent. Either way there is nothing to do.
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.settle();
    apply(pending);
  }

  /**
   * Marks the connection unusable and fails everything in flight. The first
   * reason wins: a server that crashes mid-call should be reported as having
   * crashed, not as having been shut down by the teardown that followed.
   */
  #fail(reason: string): void {
    if (this.#failure === undefined) {
      const tail = this.#stderr.trim();
      this.#failure = tail === "" ? reason : `${reason}: ${tail}`;
    }
    const failure = this.#failure;

    const pending = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, request] of pending) {
      request.settle();
      request.reject(new Error(failure));
    }
  }
}
