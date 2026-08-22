import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/mcp/config.js";
import { describeMcpStatuses, McpSession } from "../../src/mcp/session.js";
import type { FakeMcpSpec } from "./fake-server.js";
import {
  cleanup,
  fakeMcpArgs,
  isGone,
  makeTempDir,
  RecordingSink,
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

/** A configured server backed by a fresh fake script under `<dir>/<name>.cjs`. */
async function fakeServer(
  name: string,
  spec: FakeMcpSpec,
): Promise<McpServerConfig> {
  const script = `${name}.cjs`;
  const { command, env } = await writeFakeMcpServer(dir, spec, script);
  return {
    name,
    command,
    args: fakeMcpArgs(dir, script),
    env,
    enabled: true,
  };
}

function start(
  servers: readonly McpServerConfig[],
  events?: RecordingSink,
): Promise<McpSession> {
  return McpSession.start({
    servers,
    workspacePath: dir,
    context: { runId: "run-1" },
    startupTimeoutMs: 10_000,
    shutdownGraceMs: 200,
    ...(events === undefined ? {} : { events }),
  });
}

describe("McpSession", () => {
  it("bridges every server's tools under mcp__<server>__<tool>", async () => {
    const events = new RecordingSink();
    const session = await start(
      [
        await fakeServer("github", {
          tools: [{ name: "search_code" }, { name: "list_issues" }],
        }),
        await fakeServer("docs", { tools: [{ name: "lookup" }] }),
      ],
      events,
    );
    try {
      expect(session.tools().map((tool) => tool.name)).toEqual([
        "mcp__github__search_code",
        "mcp__github__list_issues",
        "mcp__docs__lookup",
      ]);
      expect(events.types()).toEqual([
        "mcp.server.started",
        "mcp.server.started",
      ]);
      // Servers connect in parallel, so the events arrive in whatever order
      // the handshakes finished — the tool list is the ordered one, not this.
      const started = events.events.find(
        (event) =>
          event.type === "mcp.server.started" && event.data.server === "github",
      );
      expect(started?.data).toMatchObject({
        server: "github",
        tools: 2,
        implementation: "fake-mcp",
      });
    } finally {
      await session.close();
    }
  });

  it("keeps working servers when one of them cannot start", async () => {
    const events = new RecordingSink();
    const session = await start(
      [
        {
          name: "broken",
          command: join(dir, "nope"),
          args: [],
          env: {},
          enabled: true,
        },
        await fakeServer("good", { tools: [{ name: "ping" }] }),
      ],
      events,
    );
    try {
      expect(session.tools().map((tool) => tool.name)).toEqual([
        "mcp__good__ping",
      ]);
      const failed = events.events.find(
        (event) => event.type === "mcp.server.failed",
      );
      expect(failed?.data).toMatchObject({ server: "broken" });
      expect(session.statuses()).toEqual([
        {
          name: "broken",
          connected: false,
          tools: 0,
          error: expect.stringContaining("could not start"),
        },
        { name: "good", connected: true, tools: 1 },
      ]);
    } finally {
      await session.close();
    }
  });

  it("reports a handshake that never lands as a failure, not a crash", async () => {
    const events = new RecordingSink();
    const session = await McpSession.start({
      servers: [
        await fakeServer("silent", {
          silentInitialize: true,
          ignoreStdinEnd: true,
        }),
      ],
      workspacePath: dir,
      context: { runId: "run-1" },
      startupTimeoutMs: 200,
      shutdownGraceMs: 200,
      events,
    });
    try {
      expect(session.tools()).toEqual([]);
      expect(events.types()).toEqual(["mcp.server.failed"]);
    } finally {
      await session.close();
    }
  });

  it("never spawns a server that is turned off", async () => {
    const pidFile = join(dir, "off.pid");
    const off = await fakeServer("off", { tools: [{ name: "x" }], pidFile });
    const session = await start([{ ...off, enabled: false }]);
    try {
      expect(session.tools()).toEqual([]);
      expect(session.statuses()).toEqual([]);
      await expect(readFile(pidFile, "utf8")).rejects.toThrow();
    } finally {
      await session.close();
    }
  });

  it("skips a tool whose bridged name would exceed the provider cap", async () => {
    const events = new RecordingSink();
    const session = await start(
      [
        await fakeServer("srv", {
          tools: [{ name: "ok" }, { name: "x".repeat(80) }],
        }),
      ],
      events,
    );
    try {
      expect(session.tools().map((tool) => tool.name)).toEqual([
        "mcp__srv__ok",
      ]);
      expect(events.events[0]?.data).toMatchObject({
        tools: 1,
        skippedTools: 1,
      });
    } finally {
      await session.close();
    }
  });

  it("stops every server it started, and stays idempotent", async () => {
    const pidFile = join(dir, "one.pid");
    const session = await start([
      await fakeServer("one", { tools: [{ name: "x" }], pidFile }),
    ]);
    const pid = Number(await readFile(pidFile, "utf8"));

    await session.close();
    await session.close();
    await waitForExit(pid);
    expect(isGone(pid)).toBe(true);
  });

  it("does nothing at all when nothing is configured", async () => {
    const events = new RecordingSink();
    const session = await start([], events);
    expect(session.tools()).toEqual([]);
    expect(events.events).toEqual([]);
    await session.close();
  });
});

describe("describeMcpStatuses", () => {
  it("says nothing when no server is configured", () => {
    expect(describeMcpStatuses([])).toBeUndefined();
  });

  it("names each server, and why a failed one failed", () => {
    expect(
      describeMcpStatuses([
        { name: "github", connected: true, tools: 3 },
        { name: "docs", connected: true, tools: 1 },
        { name: "broken", connected: false, tools: 0, error: "no such file" },
      ]),
    ).toBe(
      "mcp: github (3 tools), docs (1 tool), broken (failed: no such file)",
    );
  });
});
