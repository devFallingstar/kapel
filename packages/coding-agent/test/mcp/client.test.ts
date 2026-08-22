import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpStdioClient } from "../../src/mcp/client.js";
import type { FakeMcpSpec } from "./fake-server.js";
import {
  cleanup,
  fakeMcpArgs,
  isGone,
  makeTempDir,
  waitForExit,
  writeFakeMcpServer,
} from "./fake-server.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanup(dir);
});

/** Connects a client to a fake server running `spec`, in this test's temp dir. */
async function connect(
  spec: FakeMcpSpec,
  overrides: {
    readonly requestTimeoutMs?: number;
    readonly startupTimeoutMs?: number;
  } = {},
): Promise<McpStdioClient> {
  const { command, env } = await writeFakeMcpServer(dir, spec);
  return McpStdioClient.connect({
    name: "fake",
    command,
    args: fakeMcpArgs(dir),
    env,
    cwd: dir,
    startupTimeoutMs: 10_000,
    shutdownGraceMs: 200,
    ...overrides,
  });
}

describe("McpStdioClient — handshake", () => {
  it("completes initialize and records what the server said about itself", async () => {
    const client = await connect({ tools: [] });
    try {
      expect(client.serverInfo()?.protocolVersion).toBe("2025-06-18");
      expect(client.serverInfo()?.serverInfo?.name).toBe("fake-mcp");
    } finally {
      await client.close();
    }
  });

  it("tolerates non-JSON noise on stdout around the handshake", async () => {
    const client = await connect({
      noise: ["starting up…", "{not json", "[]"],
      tools: [{ name: "ping" }],
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["ping"]);
    } finally {
      await client.close();
    }
  });

  it("fails with a printable reason when the command does not exist", async () => {
    await expect(
      McpStdioClient.connect({
        name: "missing",
        command: join(dir, "definitely-not-here"),
        cwd: dir,
        startupTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/could not start/);
  });

  it("fails when the server never answers initialize, and leaves nothing running", async () => {
    const pidFile = join(dir, "pid");
    await expect(
      connect(
        { silentInitialize: true, ignoreStdinEnd: true, pidFile },
        { startupTimeoutMs: 200 },
      ),
    ).rejects.toThrow(/did not answer initialize within/);

    const pid = Number(await readFile(pidFile, "utf8"));
    await waitForExit(pid);
    expect(isGone(pid)).toBe(true);
  });

  it("fails when the initialize result does not validate", async () => {
    await expect(connect({ badInitialize: true })).rejects.toThrow(
      /unusable initialize result/,
    );
  });

  it("answers a server-to-client request instead of leaving it hanging", async () => {
    const answerFile = join(dir, "answers.jsonl");
    const client = await connect({ askClientTo: answerFile, tools: [] });
    try {
      await client.listTools();
      // The answer travels the other way down the same pipe, so it lands
      // whenever the server gets round to reading it — poll rather than
      // assume it beat the `tools/list` result back.
      await expect
        .poll(() => readFile(answerFile, "utf8").catch(() => ""), {
          timeout: 5000,
        })
        .toContain("-32601");
    } finally {
      await client.close();
    }
  });
});

describe("McpStdioClient — tools/list", () => {
  it("lists tools with their descriptions and schemas", async () => {
    const client = await connect({
      tools: [
        {
          name: "search",
          description: "Searches things",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      ],
    });
    try {
      const listed = await client.listTools();
      expect(listed.dropped).toBe(0);
      expect(listed.tools[0]?.description).toBe("Searches things");
      expect(listed.tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: { q: { type: "string" } },
      });
    } finally {
      await client.close();
    }
  });

  it("follows nextCursor across pages", async () => {
    const client = await connect({
      toolPages: [[{ name: "one" }], [{ name: "two" }], [{ name: "three" }]],
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "one",
        "two",
        "three",
      ]);
    } finally {
      await client.close();
    }
  });

  it("drops a descriptor that does not validate and keeps the rest", async () => {
    const client = await connect({
      tools: [{ name: "good" }, { description: "no name" }, { name: "" }],
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["good"]);
      expect(listed.dropped).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("throws when the whole result is unusable", async () => {
    const client = await connect({ badToolsList: true });
    try {
      await expect(client.listTools()).rejects.toThrow(
        /unusable tools\/list result/,
      );
    } finally {
      await client.close();
    }
  });
});

describe("McpStdioClient — tools/call", () => {
  it("returns the server's result", async () => {
    const client = await connect({
      tools: [{ name: "echo" }],
      calls: {
        echo: { result: { content: [{ type: "text", text: "hello" }] } },
      },
    });
    try {
      const result = await client.callTool("echo", { a: 1 });
      expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    } finally {
      await client.close();
    }
  });

  it("keeps a tool-reported failure in the result rather than throwing", async () => {
    const client = await connect({
      tools: [{ name: "boom" }],
      calls: {
        boom: {
          result: { isError: true, content: [{ type: "text", text: "nope" }] },
        },
      },
    });
    try {
      const result = await client.callTool("boom", {});
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("throws on a JSON-RPC error frame", async () => {
    const client = await connect({
      tools: [{ name: "bad" }],
      calls: { bad: { error: { code: -32602, message: "invalid params" } } },
    });
    try {
      await expect(client.callTool("bad", {})).rejects.toThrow(
        /invalid params \(JSON-RPC -32602\)/,
      );
    } finally {
      await client.close();
    }
  });

  it("rejects the in-flight call when the server crashes mid-call", async () => {
    const client = await connect({
      tools: [{ name: "crash" }],
      calls: { crash: { exit: 3 } },
    });
    try {
      await expect(client.callTool("crash", {})).rejects.toThrow(
        /stopped \(exit code 3\)/,
      );
      // …and every later call fails immediately rather than hanging.
      await expect(client.callTool("crash", {})).rejects.toThrow(/stopped/);
    } finally {
      await client.close();
    }
  });

  it("times out a call the server never answers", async () => {
    const client = await connect(
      { tools: [{ name: "sleepy" }], calls: { sleepy: { hang: true } } },
      { requestTimeoutMs: 150 },
    );
    try {
      await expect(client.callTool("sleepy", {})).rejects.toThrow(
        /did not answer tools\/call within 150ms/,
      );
    } finally {
      await client.close();
    }
  });

  it("rejects a call whose abort signal fires", async () => {
    const client = await connect({
      tools: [{ name: "sleepy" }],
      calls: { sleepy: { hang: true } },
    });
    const controller = new AbortController();
    try {
      const pending = client.callTool("sleepy", {}, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow(/cancelled/);
    } finally {
      await client.close();
    }
  });
});

describe("McpStdioClient — teardown", () => {
  it("reaps a server that exits when stdin closes", async () => {
    const pidFile = join(dir, "pid");
    const client = await connect({ tools: [], pidFile });
    await client.listTools();
    const pid = Number(await readFile(pidFile, "utf8"));

    await client.close();
    await waitForExit(pid);
    expect(isGone(pid)).toBe(true);
  });

  it("signals a server that ignores stdin closing", async () => {
    const pidFile = join(dir, "pid");
    const client = await connect({ tools: [], pidFile, ignoreStdinEnd: true });
    await client.listTools();
    const pid = Number(await readFile(pidFile, "utf8"));

    await client.close();
    await waitForExit(pid);
    expect(isGone(pid)).toBe(true);
  });

  it("is idempotent and fails anything attempted afterwards", async () => {
    const client = await connect({ tools: [{ name: "ping" }] });
    await client.close();
    await client.close();
    await expect(client.callTool("ping", {})).rejects.toThrow(/shut down/);
  });
});
