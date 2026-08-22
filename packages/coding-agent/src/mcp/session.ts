import type { Tool } from "@agent/core";
import type { AgentEventBody, EventSink } from "@agent/protocol";
import { agentEvent } from "@agent/protocol";
import { McpStdioClient } from "./client.js";
import type { McpServerConfig } from "./config.js";
import { enabledMcpServers } from "./config.js";
import { MAX_TOOL_NAME_CHARS, McpTool, mcpToolName } from "./tool.js";

/**
 * Every configured MCP server for the lifetime of one native loop or chat
 * session: connected, listed, bridged into {@link Tool}s, and torn down
 * together.
 *
 * **Lifecycle.** Servers are started when a session that can use them is built
 * — lazily, not at process start — and stopped when that session ends. The
 * laziness is the point: a REPL opened on `--backend codex` delegates the whole
 * agent loop to somebody else's CLI and would never call one of these tools, so
 * spawning its servers would be pure cost, and the backend a conversation runs
 * on can change mid-session anyway (`/config`), so "at startup" is not a single
 * moment. The first native session to be built pays for the connections; every
 * rebuild after it reuses them.
 *
 * **Scope.** These tools reach kapel's *own* agent loop only. A task routed to
 * the Claude Code or Codex CLI runs that CLI's agent loop, which reads that
 * CLI's own MCP configuration — kapel neither forwards this block to them nor
 * pretends to.
 *
 * **Failure.** A server that will not start, will not handshake or will not
 * list its tools costs exactly its own tools: the session reports it on
 * `mcp.server.failed` and carries on with whatever else came up. Nothing here
 * throws at a caller, because a broken MCP server is not a reason to refuse
 * someone a coding session.
 */

export interface McpSessionContext {
  readonly runId: string;
  readonly taskId?: string;
}

export interface McpSessionOptions {
  readonly servers: readonly McpServerConfig[];
  /** Working directory the servers are spawned in. */
  readonly workspacePath: string;
  readonly events?: EventSink;
  readonly context: McpSessionContext;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

/** What became of one configured server, for a banner line or a status command. */
export interface McpServerStatus {
  readonly name: string;
  readonly connected: boolean;
  /** Tools bridged into the loop. Zero for a server that failed. */
  readonly tools: number;
  /** Why it is not connected, when it is not. */
  readonly error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What one server's connection attempt produced, connected or not. */
type ConnectionOutcome =
  | {
      readonly client: McpStdioClient;
      readonly tools: readonly McpTool[];
      readonly status: McpServerStatus;
    }
  | { readonly client?: undefined; readonly status: McpServerStatus };

export class McpSession {
  readonly #clients: readonly McpStdioClient[];
  readonly #tools: readonly Tool[];
  readonly #statuses: readonly McpServerStatus[];
  #closed = false;

  private constructor(
    clients: readonly McpStdioClient[],
    tools: readonly Tool[],
    statuses: readonly McpServerStatus[],
  ) {
    this.#clients = clients;
    this.#tools = tools;
    this.#statuses = statuses;
  }

  /**
   * Connects every enabled server in parallel and bridges their tools.
   *
   * Parallel because a session waits for all of them before its first turn, and
   * serialising the wait would add up every server's startup latency for no
   * benefit — they share nothing.
   */
  static async start(options: McpSessionOptions): Promise<McpSession> {
    const wanted = enabledMcpServers(options.servers);
    if (wanted.length === 0) return new McpSession([], [], []);

    const connected = await Promise.all(
      wanted.map((server) => McpSession.#connectOne(server, options)),
    );

    const clients: McpStdioClient[] = [];
    const tools: Tool[] = [];
    const statuses: McpServerStatus[] = [];
    for (const entry of connected) {
      statuses.push(entry.status);
      if (entry.client === undefined) continue;
      clients.push(entry.client);
      tools.push(...entry.tools);
    }

    return new McpSession(clients, tools, statuses);
  }

  static async #connectOne(
    server: McpServerConfig,
    options: McpSessionOptions,
  ): Promise<ConnectionOutcome> {
    const emit = async (body: AgentEventBody): Promise<void> => {
      const sink = options.events;
      if (sink === undefined) return;
      try {
        await sink.emit(
          agentEvent(
            {
              runId: options.context.runId,
              ...(options.context.taskId === undefined
                ? {}
                : { taskId: options.context.taskId }),
            },
            body,
          ),
        );
      } catch {
        // Event emission is best-effort, exactly as it is in the agent loop.
      }
    };

    let client: McpStdioClient | undefined;
    try {
      client = await McpStdioClient.connect({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: options.workspacePath,
        ...(options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: options.startupTimeoutMs }),
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.shutdownGraceMs === undefined
          ? {}
          : { shutdownGraceMs: options.shutdownGraceMs }),
      });

      const listed = await client.listTools();

      const tools: McpTool[] = [];
      let skipped = listed.dropped;
      for (const descriptor of listed.tools) {
        // Over-long names are dropped rather than truncated; see
        // `MAX_TOOL_NAME_CHARS` for why a collision would be worse.
        if (
          mcpToolName(server.name, descriptor.name).length > MAX_TOOL_NAME_CHARS
        ) {
          skipped += 1;
          continue;
        }
        tools.push(new McpTool(server.name, descriptor, client));
      }

      const implementation = client.serverInfo()?.serverInfo?.name;
      await emit({
        type: "mcp.server.started",
        data: {
          server: server.name,
          tools: tools.length,
          ...(skipped === 0 ? {} : { skippedTools: skipped }),
          ...(implementation === undefined ? {} : { implementation }),
        },
      });

      return {
        client,
        tools,
        status: { name: server.name, connected: true, tools: tools.length },
      };
    } catch (error) {
      const reason = errorMessage(error);
      // A client that connected but failed to list its tools is still a live
      // child process, and leaving it running would be the leak this whole
      // class exists to prevent.
      if (client !== undefined) await client.close();
      await emit({
        type: "mcp.server.failed",
        data: { server: server.name, reason },
      });
      return {
        status: {
          name: server.name,
          connected: false,
          tools: 0,
          error: reason,
        },
      };
    }
  }

  /** The bridged tools, in configured-server order. Empty when nothing connected. */
  tools(): readonly Tool[] {
    return this.#tools;
  }

  /** One entry per enabled server, connected or not. */
  statuses(): readonly McpServerStatus[] {
    return this.#statuses;
  }

  /** Shuts every server down. Idempotent, and never throws. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all(this.#clients.map((client) => client.close()));
  }
}

/**
 * The one-line summary a REPL prints under its banner, or `undefined` when
 * nothing is configured and there is nothing to say.
 *
 * A failed server is named with its reason: a server that did not come up is
 * the single thing about this subsystem a user has to be told without asking.
 */
export function describeMcpStatuses(
  statuses: readonly McpServerStatus[],
): string | undefined {
  if (statuses.length === 0) return undefined;
  const parts = statuses.map((status) =>
    status.connected
      ? `${status.name} (${String(status.tools)} tool${status.tools === 1 ? "" : "s"})`
      : `${status.name} (failed: ${status.error ?? "unknown error"})`,
  );
  return `mcp: ${parts.join(", ")}`;
}
