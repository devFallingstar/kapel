import { describe, expect, it } from "vitest";
import {
  DEFAULT_VALIDATOR_TIMEOUT_SECONDS,
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

describe("loadProjectConfig - validation list", () => {
  it("parses a validation list in file order", async () => {
    const config = await withConfig(
      [
        "validation:",
        "  - name: typecheck",
        "    command: npm run typecheck",
        "    timeoutSeconds: 300",
        "  - name: test",
        "    command: npm test",
        "",
      ].join("\n"),
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );

    expect(config?.validators).toEqual([
      { name: "typecheck", command: "npm run typecheck", timeoutSeconds: 300 },
      {
        name: "test",
        command: "npm test",
        timeoutSeconds: DEFAULT_VALIDATOR_TIMEOUT_SECONDS,
      },
    ]);
  });

  it("defaults an omitted timeout to 600 seconds", async () => {
    const config = await withConfig(
      "validation:\n  - name: lint\n    command: npm run lint\n",
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );

    expect(DEFAULT_VALIDATOR_TIMEOUT_SECONDS).toBe(600);
    expect(config?.validators[0]?.timeoutSeconds).toBe(600);
  });

  it("reports no validators when the key is absent", async () => {
    const config = await withConfig(
      "models: {}\nagents: {}\n",
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );

    expect(config?.validators).toEqual([]);
  });

  it("reports no validators for an explicitly empty list", async () => {
    const config = await withConfig(
      "validation: []\n",
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );

    expect(config?.validators).toEqual([]);
  });

  it("coexists with models and agents", async () => {
    const config = await withConfig(
      [
        "models:",
        "  m1:",
        "    provider: openai",
        "    model: gpt-test",
        "validation:",
        "  - name: test",
        "    command: npm test",
        "",
      ].join("\n"),
      async (workspacePath) => (await loadAgentProject(workspacePath))?.config,
    );

    expect(config?.models.m1).toEqual({
      provider: "openai",
      model: "gpt-test",
    });
    expect(config?.validators).toHaveLength(1);
  });

  it("rejects a validation value that is not a list", async () => {
    expect(await problemsFor("validation: npm test\n")).toMatch(/validation/);
  });

  it("aggregates problems across malformed entries instead of stopping at the first", async () => {
    const problems = await problemsFor(
      [
        "validation:",
        "  - command: npm test",
        "  - name: lint",
        "  - name: ''",
        "    command: npm run lint",
        "",
      ].join("\n"),
    );

    // Entry 0 has no name, entry 1 has no command, entry 2 has an empty name.
    expect(problems).toMatch(/validation\.0\.name/);
    expect(problems).toMatch(/validation\.1\.command/);
    expect(problems).toMatch(/validation\.2\.name/);
  });

  it("rejects a non-integer or non-positive timeout", async () => {
    expect(
      await problemsFor(
        "validation:\n  - name: t\n    command: npm test\n    timeoutSeconds: 0\n",
      ),
    ).toMatch(/validation\.0\.timeoutSeconds/);
    expect(
      await problemsFor(
        "validation:\n  - name: t\n    command: npm test\n    timeoutSeconds: soon\n",
      ),
    ).toMatch(/validation\.0\.timeoutSeconds/);
  });

  it("rejects unknown keys inside a validator entry", async () => {
    expect(
      await problemsFor(
        "validation:\n  - name: t\n    command: npm test\n    retries: 3\n",
      ),
    ).toMatch(/retries|unrecognized/i);
  });

  it("still rejects unknown top-level keys", async () => {
    expect(
      await problemsFor(
        "validation:\n  - name: t\n    command: npm test\nvalidators: []\n",
      ),
    ).toMatch(/validators|unrecognized/i);
  });
});
