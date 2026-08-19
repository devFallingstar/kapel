import { mkdtemp, rm } from "node:fs/promises";
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
import type { ConfigWizardDeps } from "../src/config-wizard.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

let configDir: string;
let env: NodeJS.ProcessEnv;
let logged: string[];
let errored: string[];

beforeEach(async () => {
  configDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-config-cmd-"));
  env = { KAPEL_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  logged = [];
  errored = [];
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function deps(overrides: Partial<ConfigCommandDeps> = {}): ConfigCommandDeps {
  return {
    log: (line) => logged.push(line),
    error: (line) => errored.push(line),
    interactive: false,
    env,
    ...overrides,
  };
}

const STORED = {
  backend: "claude-code",
  models: {
    orchestrator: "opus",
    complex: "opus",
    middle: "sonnet",
    low: "haiku",
  },
  updatedAt: 1_700_000_000_000,
} as const;

describe("kapel config --path", () => {
  it("prints just the path, configured or not", async () => {
    expect(await runConfigCommand({ path: true }, deps())).toBe(0);
    expect(logged).toEqual([kapelConfigPath(env)]);
  });
});

describe("kapel config --show", () => {
  it("says the machine is not configured yet, and still exits 0", async () => {
    const code = await runConfigCommand({ show: true }, deps());
    expect(code).toBe(0);
    expect(logged[0]).toBe(NOT_CONFIGURED);
    expect(logged.at(-1)).toBe(`path: ${kapelConfigPath(env)}`);
  });

  it("describes a stored configuration and where it lives", async () => {
    await saveKapelConfig(STORED, env);

    const code = await runConfigCommand({ show: true }, deps());
    expect(code).toBe(0);
    const text = logged.join("\n");
    expect(text).toContain("backend: Claude Code (claude-code)");
    expect(text).toContain("orchestrator model: opus");
    expect(text).toContain(`path: ${kapelConfigPath(env)}`);
    expect(errored).toEqual([]);
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
      backend: "codex",
      models: {
        orchestrator: "default",
        complex: "default",
        middle: "default",
        low: "default",
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
    expect(seen[0]?.current?.backend).toBe("claude-code");
    expect(seen[0]?.env).toBe(env);
  });

  it("succeeds when the wizard is cancelled — nothing was asked to change", async () => {
    const code = await runConfigCommand(
      {},
      deps({ interactive: true, wizard: async () => undefined }),
    );
    expect(code).toBe(0);
  });
});
