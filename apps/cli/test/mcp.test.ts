import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceMcpServers } from "../src/mcp.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(SCRATCHPAD, "kapel-mcp-"));
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

async function writeAgentFile(name: string, contents: string): Promise<void> {
  const agentDir = path.join(workspacePath, ".agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, name), contents, "utf8");
}

describe("loadWorkspaceMcpServers", () => {
  it("finds nothing in a directory that was never initialised", async () => {
    expect(await loadWorkspaceMcpServers(workspacePath)).toEqual({
      servers: [],
      problems: [],
    });
  });

  it("reads the committed servers out of .agent/config.yaml", async () => {
    await writeAgentFile(
      "config.yaml",
      ["mcp:", "  docs:", "    command: ./docs-mcp", ""].join("\n"),
    );

    expect((await loadWorkspaceMcpServers(workspacePath)).servers).toEqual([
      { name: "docs", command: "./docs-mcp", args: [], env: {}, enabled: true },
    ]);
  });

  it("layers this checkout's config.local.json on top of config.yaml", async () => {
    await writeAgentFile(
      "config.yaml",
      [
        "mcp:",
        "  github:",
        "    command: npx",
        "    args: ['-y', 'server-github']",
        "    env:",
        "      MODE: shared",
        "",
      ].join("\n"),
    );
    await writeAgentFile(
      "config.local.json",
      `${JSON.stringify({
        mcp: {
          github: { env: { GITHUB_TOKEN: "local-only" } },
          scratch: { command: "./scratch-mcp" },
        },
      })}\n`,
    );

    const { servers } = await loadWorkspaceMcpServers(workspacePath);
    expect(servers).toEqual([
      {
        name: "github",
        command: "npx",
        args: ["-y", "server-github"],
        env: { MODE: "shared", GITHUB_TOKEN: "local-only" },
        enabled: true,
      },
      {
        name: "scratch",
        command: "./scratch-mcp",
        args: [],
        env: {},
        enabled: true,
      },
    ]);
  });

  it("lets the local layer turn a committed server off", async () => {
    await writeAgentFile(
      "config.yaml",
      ["mcp:", "  docs:", "    command: ./docs-mcp", ""].join("\n"),
    );
    await writeAgentFile(
      "config.local.json",
      `${JSON.stringify({ mcp: { docs: { enabled: false } } })}\n`,
    );

    const { servers } = await loadWorkspaceMcpServers(workspacePath);
    expect(servers[0]).toMatchObject({ name: "docs", enabled: false });
  });

  it("reports a malformed config.yaml instead of failing the session", async () => {
    await writeAgentFile("config.yaml", "mcp:\n  a:\n    commnd: npx\n");

    const { servers, problems } = await loadWorkspaceMcpServers(workspacePath);
    expect(servers).toEqual([]);
    expect(problems[0]).toContain(".agent/config.yaml mcp servers");
  });

  it("ignores an unreadable config.local.json, keeping the committed servers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeAgentFile(
        "config.yaml",
        ["mcp:", "  docs:", "    command: ./docs-mcp", ""].join("\n"),
      );
      await writeAgentFile("config.local.json", '{"mcp": {"docs": 3}}\n');

      const { servers } = await loadWorkspaceMcpServers(workspacePath);
      expect(servers.map((server) => server.name)).toEqual(["docs"]);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("names an entry that no layer gave a command", async () => {
    await writeAgentFile("config.yaml", "mcp:\n  ghost:\n    enabled: true\n");

    const { servers, problems } = await loadWorkspaceMcpServers(workspacePath);
    expect(servers).toEqual([]);
    expect(problems).toEqual([
      'mcp.ghost: no "command" in either config layer — ignoring this server.',
    ]);
  });
});
