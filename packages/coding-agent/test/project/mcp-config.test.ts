import { describe, expect, it } from "vitest";
import {
  loadAgentProject,
  ProjectConfigError,
} from "../../src/project/index.js";
import {
  cleanupWorkspace,
  makeWorkspace,
  writeAgentFile,
} from "./test-helpers.js";

/** Loads a workspace whose `.agent/config.yaml` holds `yaml`, then cleans up. */
async function withConfig<T>(
  yaml: string,
  use: (workspacePath: string) => Promise<T>,
): Promise<T> {
  const workspacePath = await makeWorkspace();
  try {
    await writeAgentFile(workspacePath, "config.yaml", yaml);
    return await use(workspacePath);
  } finally {
    await cleanupWorkspace(workspacePath);
  }
}

async function problemsFor(yaml: string): Promise<string> {
  return withConfig(yaml, async (workspacePath) => {
    const err = await loadAgentProject(workspacePath).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectConfigError);
    return (err as ProjectConfigError).problems.join("\n");
  });
}

describe("loadProjectConfig — the mcp block", () => {
  it("is empty when the key is absent", async () => {
    const config = await withConfig(
      "models: {}\n",
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );
    expect(config?.mcp).toEqual({});
  });

  it("reads named servers with command, args, env and enabled", async () => {
    const config = await withConfig(
      [
        "mcp:",
        "  github:",
        "    command: npx",
        "    args: ['-y', '@modelcontextprotocol/server-github']",
        "    env:",
        "      GITHUB_TOKEN: from-config",
        "  docs:",
        "    command: ./scripts/docs-mcp",
        "    enabled: false",
        "",
      ].join("\n"),
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );

    expect(config?.mcp).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "from-config" },
      },
      docs: { command: "./scripts/docs-mcp", enabled: false },
    });
  });

  it("rejects a misspelled key inside a server entry", async () => {
    expect(await problemsFor("mcp:\n  a:\n    commnd: npx\n")).toContain(
      "mcp.a",
    );
  });

  it("rejects an args list that is not strings", async () => {
    expect(
      await problemsFor("mcp:\n  a:\n    command: x\n    args: [1]\n"),
    ).toContain("mcp.a.args");
  });

  it("rejects an mcp block that is not a map of servers", async () => {
    expect(await problemsFor("mcp: not-a-map\n")).toContain("mcp");
  });
});
