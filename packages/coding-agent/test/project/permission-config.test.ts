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

describe("loadProjectConfig - permission block (P1-5)", () => {
  it("reports no permission rules when the key is absent", async () => {
    const config = await withConfig(
      "models: {}\n",
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );
    expect(config?.permission).toEqual({});
  });

  it("parses a flat verdict per tool", async () => {
    const config = await withConfig(
      ["permission:", "  edit_file: allow", "  read_file: allow", ""].join(
        "\n",
      ),
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );
    expect(config?.permission).toEqual({
      edit_file: "allow",
      read_file: "allow",
    });
  });

  it("parses a bash command-prefix pattern map", async () => {
    const config = await withConfig(
      [
        "permission:",
        "  bash:",
        '    "*": ask',
        '    "git *": allow',
        '    "rm *": deny',
        "",
      ].join("\n"),
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );
    expect(config?.permission).toEqual({
      bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
    });
  });

  it("coexists with models, agents and validation", async () => {
    const config = await withConfig(
      [
        "models:",
        "  m1:",
        "    provider: openai",
        "    model: gpt-test",
        "validation:",
        "  - name: test",
        "    command: npm test",
        "permission:",
        "  bash: ask",
        "",
      ].join("\n"),
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );
    expect(config?.models.m1).toEqual({
      provider: "openai",
      model: "gpt-test",
    });
    expect(config?.validators).toHaveLength(1);
    expect(config?.permission).toEqual({ bash: "ask" });
  });

  it("rejects an unrecognised verdict string", async () => {
    expect(await problemsFor("permission:\n  edit_file: sometimes\n")).toMatch(
      /permission/,
    );
  });

  it("rejects a bash pattern map with an unrecognised verdict", async () => {
    expect(
      await problemsFor('permission:\n  bash:\n    "git *": sometimes\n'),
    ).toMatch(/permission/);
  });

  it("rejects a permission value that is neither a verdict nor a map", async () => {
    expect(
      await problemsFor("permission:\n  edit_file:\n    - allow\n"),
    ).toMatch(/permission/);
  });
});
