import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanup,
  isGone,
  makeTempDir as makeScratchDir,
  RecordingSink,
  waitForExit,
} from "../backends/test-helpers.js";

/**
 * A scripted MCP server, in the same spirit as `test/backends/test-helpers.ts`'s
 * fake `codex`/`claude` CLIs: a real executable, spawned by the real client,
 * speaking real JSON-RPC over a real pipe. Everything about the connection —
 * framing, the handshake, correlation, a crash mid-call — is therefore
 * exercised end to end rather than stubbed.
 *
 * The script's behaviour is a JSON spec handed over in an environment
 * variable, so one file covers every scenario and the tests read as data.
 *
 * The scratch-directory, event-recording and pid helpers are the ones the
 * backend fakes already use — same needs, so the same code rather than a
 * second copy of it.
 */

export { cleanup, isGone, RecordingSink, waitForExit };

export function makeTempDir(prefix = "mcp-test-"): Promise<string> {
  return makeScratchDir(prefix);
}

/** One tool as `tools/list` should report it. */
export interface FakeToolSpec {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/** How the fake answers one `tools/call`. Exactly one field applies. */
export interface FakeCallSpec {
  /** The `tools/call` result to return verbatim. */
  readonly result?: Record<string, unknown>;
  /** Answer with a JSON-RPC error frame instead of a result. */
  readonly error?: { readonly code: number; readonly message: string };
  /** Exit the process with this code instead of answering — a crash mid-call. */
  readonly exit?: number;
  /** Accept the call and never answer it — for timeout coverage. */
  readonly hang?: true;
}

export interface FakeMcpSpec {
  /** Tools for a single-page `tools/list`. */
  readonly tools?: readonly (FakeToolSpec | Record<string, unknown>)[];
  /** Multi-page `tools/list`; each page but the last carries a `nextCursor`. */
  readonly toolPages?: readonly (readonly (
    | FakeToolSpec
    | Record<string, unknown>
  )[])[];
  /** Per-tool call behaviour; a tool with no entry answers `"ok"`. */
  readonly calls?: Readonly<Record<string, FakeCallSpec>>;
  /** Raw lines written to stdout before the handshake is answered. */
  readonly noise?: readonly string[];
  /** Answer `initialize` with a result that does not validate. */
  readonly badInitialize?: true;
  /** Never answer `initialize` at all. */
  readonly silentInitialize?: true;
  /** Answer `tools/list` with a result that does not validate. */
  readonly badToolsList?: true;
  /** Write the server's own pid here, so a test can prove it was reaped. */
  readonly pidFile?: string;
  /** Ignore stdin closing, so only a signal can stop this server. */
  readonly ignoreStdinEnd?: true;
  /**
   * After the handshake, call *the client* with `sampling/createMessage` and
   * append whatever answer arrives to this file. Proves kapel never leaves a
   * server waiting on a method it does not implement.
   */
  readonly askClientTo?: string;
}

const SERVER_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const spec = JSON.parse(process.env.FAKE_MCP_SPEC || "{}");

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\\n");
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

if (spec.pidFile) fs.writeFileSync(spec.pidFile, String(process.pid));

const pages = spec.toolPages || [spec.tools || []];

function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    for (const line of spec.noise || []) process.stdout.write(line + "\\n");
    if (spec.silentInitialize) return;
    if (spec.badInitialize) {
      ok(id, { nothing: "useful" });
      return;
    }
    ok(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    if (spec.askClientTo) {
      send({ jsonrpc: "2.0", id: "server-1", method: "sampling/createMessage", params: {} });
    }
    return;
  }

  if (method === "tools/list") {
    if (spec.badToolsList) {
      ok(id, { tools: "not an array" });
      return;
    }
    const index = params && params.cursor ? Number(params.cursor) : 0;
    const page = pages[index] || [];
    const more = index + 1 < pages.length;
    ok(id, more ? { tools: page, nextCursor: String(index + 1) } : { tools: page });
    return;
  }

  if (method === "tools/call") {
    const behaviour = (spec.calls || {})[params && params.name] || {};
    if (behaviour.hang) return;
    if (typeof behaviour.exit === "number") {
      process.exit(behaviour.exit);
      return;
    }
    if (behaviour.error) {
      fail(id, behaviour.error.code, behaviour.error.message);
      return;
    }
    ok(id, behaviour.result || { content: [{ type: "text", text: "ok" }] });
    return;
  }

  if (method === undefined) return;
  fail(id, -32601, "unknown method " + method);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (spec.askClientTo && message.id === "server-1") {
      fs.appendFileSync(spec.askClientTo, line + "\\n");
      continue;
    }
    handle(message);
  }
});
process.stdin.on("end", () => {
  if (!spec.ignoreStdinEnd) process.exit(0);
});
// A server that ignores stdin closing needs something to outlive it, so that
// only a signal can end this process — which is the escalation path under test.
if (spec.ignoreStdinEnd) setInterval(() => {}, 1000000);
`;

/**
 * Writes the fake server script into `dir` and returns the command and
 * environment that run it under `spec`.
 */
export async function writeFakeMcpServer(
  dir: string,
  spec: FakeMcpSpec = {},
  name = "fake-mcp-server.cjs",
): Promise<{
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}> {
  const scriptPath = join(dir, name);
  await writeFile(scriptPath, SERVER_SOURCE, "utf8");
  await chmod(scriptPath, 0o755);
  return {
    command: process.execPath,
    env: { FAKE_MCP_SPEC: JSON.stringify(spec) },
  };
}

/** The `args` that go with {@link writeFakeMcpServer}'s command. */
export function fakeMcpArgs(
  dir: string,
  name = "fake-mcp-server.cjs",
): string[] {
  return [join(dir, name)];
}
