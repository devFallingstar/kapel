import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import {
  KAPEL_CONFIG_VERSION,
  kapelConfigPath,
  saveKapelConfig,
} from "../src/config.js";
import type { ConfigCommandDeps } from "../src/config-cmd.js";
import { NOT_CONFIGURED, runConfigCommand } from "../src/config-cmd.js";
import { projectConfigPath } from "../src/config-project.js";
import type { ConfigWizardDeps } from "../src/config-wizard.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

let configDir: string;
let workspace: string;
let env: NodeJS.ProcessEnv;
let logged: string[];
let errored: string[];

beforeEach(async () => {
  configDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-config-cmd-"));
  workspace = await mkdtemp(path.join(SCRATCHPAD, "kapel-config-ws-"));
  env = { KAPEL_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  logged = [];
  errored = [];
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function deps(overrides: Partial<ConfigCommandDeps> = {}): ConfigCommandDeps {
  return {
    log: (line) => logged.push(line),
    error: (line) => errored.push(line),
    interactive: false,
    cwd: workspace,
    env,
    ...overrides,
  };
}

const cc = (model: string) => ({ backend: "claude-code", model }) as const;

const STORED = {
  backends: ["claude-code"],
  models: {
    orchestrator: cc("opus"),
    complex: cc("opus"),
    middle: cc("sonnet"),
    low: cc("haiku"),
  },
  updatedAt: 1_700_000_000_000,
} as const;

async function writeProjectConfig(body: unknown): Promise<void> {
  await mkdir(path.join(workspace, ".agent"), { recursive: true });
  await writeFile(
    projectConfigPath(workspace),
    JSON.stringify(body, null, 2),
    "utf8",
  );
}

describe("kapel config --path", () => {
  it("prints just the path, configured or not", async () => {
    expect(await runConfigCommand({ path: true }, deps())).toBe(0);
    expect(logged).toEqual([kapelConfigPath(env)]);
  });

  it("prints this directory's file under --project", async () => {
    expect(await runConfigCommand({ path: true, project: true }, deps())).toBe(
      0,
    );
    expect(logged).toEqual([projectConfigPath(workspace)]);
  });
});

describe("kapel config --show", () => {
  it("says the machine is not configured yet, and still exits 0", async () => {
    const code = await runConfigCommand({ show: true }, deps());
    expect(code).toBe(0);
    expect(logged[0]).toBe(NOT_CONFIGURED);
    expect(logged).toContain(`path: ${kapelConfigPath(env)}`);
  });

  it("describes a stored configuration and where it lives", async () => {
    await saveKapelConfig(STORED, env);

    const code = await runConfigCommand({ show: true }, deps());
    expect(code).toBe(0);
    const text = logged.join("\n");
    expect(text).toContain("backends: Claude Code (claude-code)");
    expect(text).toContain("orchestrator model: opus (claude-code)");
    expect(text).toContain(`path: ${kapelConfigPath(env)}`);
    expect(errored).toEqual([]);
  });

  it("names the file every effective value came from", async () => {
    await saveKapelConfig(STORED, env);
    await writeProjectConfig({
      backends: ["claude-code", "codex"],
      models: { middle: { backend: "codex", model: "gpt-5.1" } },
    });

    expect(await runConfigCommand({ show: true }, deps())).toBe(0);
    const text = logged.join("\n");
    expect(text).toContain(
      `backends: Claude Code (claude-code), Codex (codex)  (from ${projectConfigPath(workspace)})`,
    );
    expect(text).toContain(
      `worker model (routine, non-trivial tasks): gpt-5.1 (codex)  (from ${projectConfigPath(workspace)})`,
    );
    expect(text).toContain(
      `orchestrator model: opus (claude-code)  (from ${kapelConfigPath(env)})`,
    );
    expect(text).toContain(`project path: ${projectConfigPath(workspace)}`);
  });

  it("marks the project file as absent when there is none", async () => {
    await saveKapelConfig(STORED, env);
    expect(await runConfigCommand({ show: true }, deps())).toBe(0);
    expect(logged).toContain(
      `project path: ${projectConfigPath(workspace)} (none)`,
    );
  });

  it("shows a project-only configuration with no machine config at all", async () => {
    await writeProjectConfig({
      models: { orchestrator: { backend: "codex", model: "gpt-5.1" } },
    });
    expect(await runConfigCommand({ show: true }, deps())).toBe(0);
    const text = logged.join("\n");
    expect(text).toContain("backends: Codex (codex)");
    expect(text).toContain(
      `orchestrator model: gpt-5.1 (codex)  (from ${projectConfigPath(workspace)})`,
    );
    expect(text).toContain("worker model (small tasks): default (codex)");
  });
});

describe("kapel config", () => {
  it("refuses to run the wizard without a terminal", async () => {
    const code = await runConfigCommand({}, deps({ interactive: false }));
    expect(code).toBe(1);
    expect(errored.join("\n")).toContain("needs an interactive terminal");
  });

  it("runs the wizard on a terminal, seeded with the current config", async () => {
    await saveKapelConfig(STORED, env);
    const seen: ConfigWizardDeps[] = [];
    const written: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["codex"],
      models: {
        orchestrator: { backend: "codex", model: "default" },
        complex: { backend: "codex", model: "default" },
        middle: { backend: "codex", model: "default" },
        low: { backend: "codex", model: "default" },
      },
      updatedAt: 2,
    };

    const code = await runConfigCommand(
      {},
      deps({
        interactive: true,
        wizard: async (wizardDeps) => {
          seen.push(wizardDeps);
          return written;
        },
      }),
    );

    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.current?.backends).toEqual(["claude-code"]);
    expect(seen[0]?.env).toBe(env);
    // The machine wizard saves itself; no override is installed.
    expect(seen[0]?.writeConfig).toBeUndefined();
  });

  it("succeeds when the wizard is cancelled — nothing was asked to change", async () => {
    const code = await runConfigCommand(
      {},
      deps({ interactive: true, wizard: async () => undefined }),
    );
    expect(code).toBe(0);
  });
});

describe("kapel config --project", () => {
  it("writes the answers to <cwd>/.agent/config.local.json", async () => {
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    const code = await runConfigCommand(
      { project: true },
      deps({
        interactive: true,
        wizard: async (wizardDeps) => {
          const saved = await wizardDeps.writeConfig?.({
            backends: ["codex"],
            models: {
              orchestrator: { backend: "codex", model: "gpt-5.1" },
              complex: { backend: "codex", model: "gpt-5.1" },
              middle: { backend: "codex", model: "gpt-5-mini" },
              low: { backend: "codex", model: "gpt-5-mini" },
            },
          });
          expect(saved).toBe(projectConfigPath(workspace));
          return undefined;
        },
      }),
    );

    expect(code).toBe(0);
    const written = JSON.parse(
      await readFile(projectConfigPath(workspace), "utf8"),
    );
    expect(written).toEqual({
      backends: ["codex"],
      models: {
        orchestrator: { backend: "codex", model: "gpt-5.1" },
        complex: { backend: "codex", model: "gpt-5.1" },
        middle: { backend: "codex", model: "gpt-5-mini" },
        low: { backend: "codex", model: "gpt-5-mini" },
      },
    });
    // No version key: the project file is a partial override, not a config
    // format with its own migrations.
    expect(written).not.toHaveProperty("version");
  });

  it("seeds the wizard from the effective view, project override included", async () => {
    await saveKapelConfig(STORED, env);
    await writeProjectConfig({
      backends: ["claude-code", "codex"],
      models: { middle: { backend: "codex", model: "gpt-5.1" } },
    });

    const seen: ConfigWizardDeps[] = [];
    await runConfigCommand(
      { project: true },
      deps({
        interactive: true,
        wizard: async (wizardDeps) => {
          seen.push(wizardDeps);
          return undefined;
        },
      }),
    );

    expect(seen[0]?.current?.backends).toEqual(["claude-code", "codex"]);
    expect(seen[0]?.current?.models.middle).toEqual({
      backend: "codex",
      model: "gpt-5.1",
    });
    expect(seen[0]?.current?.models.low).toEqual(cc("haiku"));
  });

  it("asks nothing and points at `kapel init` when there is no .agent", async () => {
    let asked = false;
    const code = await runConfigCommand(
      { project: true },
      deps({
        interactive: true,
        wizard: async () => {
          asked = true;
          return undefined;
        },
      }),
    );

    expect(code).toBe(1);
    expect(asked).toBe(false);
    expect(errored.join("\n")).toContain("run `kapel init`");
  });
});
