import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import { KAPEL_CONFIG_VERSION } from "../src/config.js";
import type { KapelProjectConfig } from "../src/config-project.js";
import {
  describeEffectiveConfig,
  hasProjectAgentDir,
  loadProjectConfig,
  MissingAgentDirError,
  mergeKapelConfigs,
  PROJECT_CONFIG_RELATIVE,
  parseProjectConfig,
  projectConfigPath,
  saveProjectConfig,
} from "../src/config-project.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(SCRATCHPAD, "kapel-project-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const cc = (model: string) => ({ backend: "claude-code", model }) as const;
const gpt = (model: string) => ({ backend: "codex", model }) as const;

function machineConfig(overrides: Partial<KapelConfig> = {}): KapelConfig {
  return {
    version: KAPEL_CONFIG_VERSION,
    backends: ["claude-code"],
    models: {
      orchestrator: cc("opus"),
      complex: cc("opus"),
      middle: cc("sonnet"),
      low: cc("haiku"),
    },
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function writeLocal(body: unknown): Promise<void> {
  await mkdir(path.join(workspace, ".agent"), { recursive: true });
  await writeFile(
    projectConfigPath(workspace),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

// --- location ---------------------------------------------------------------

describe("projectConfigPath", () => {
  it("is <workspace>/.agent/config.local.json", () => {
    expect(PROJECT_CONFIG_RELATIVE).toBe(
      path.join(".agent", "config.local.json"),
    );
    expect(projectConfigPath("/repo")).toBe(
      path.join("/repo", ".agent", "config.local.json"),
    );
  });

  it("reports whether the directory has been kapel init-ed", async () => {
    expect(await hasProjectAgentDir(workspace)).toBe(false);
    await mkdir(path.join(workspace, ".agent"));
    expect(await hasProjectAgentDir(workspace)).toBe(true);
  });
});

// --- parsing ----------------------------------------------------------------

describe("parseProjectConfig", () => {
  it("accepts a backends-only override", () => {
    expect(parseProjectConfig({ backends: ["codex"] })).toEqual({
      backends: ["codex"],
    });
  });

  it("accepts a models-only, partial override", () => {
    expect(parseProjectConfig({ models: { middle: gpt("gpt-5.1") } })).toEqual({
      models: { middle: gpt("gpt-5.1") },
    });
  });

  it("accepts an empty object and ignores unknown keys", () => {
    expect(parseProjectConfig({})).toEqual({});
    expect(parseProjectConfig({ future: "thing" })).toEqual({});
  });

  it("refuses a role naming a backend the same file does not enable", () => {
    expect(
      parseProjectConfig({
        backends: ["claude-code"],
        models: { middle: gpt("gpt-5.1") },
      }),
    ).toBeUndefined();
  });

  it("refuses a malformed shape outright", () => {
    expect(parseProjectConfig("nope")).toBeUndefined();
    expect(parseProjectConfig([])).toBeUndefined();
    expect(parseProjectConfig({ backends: [] })).toBeUndefined();
    expect(parseProjectConfig({ backends: ["telepathy"] })).toBeUndefined();
    expect(parseProjectConfig({ models: "sonnet" })).toBeUndefined();
    expect(
      parseProjectConfig({ models: { middle: "sonnet" } }),
    ).toBeUndefined();
    expect(
      parseProjectConfig({ models: { middle: { backend: "codex" } } }),
    ).toBeUndefined();
  });
});

// --- loading ----------------------------------------------------------------

describe("loadProjectConfig", () => {
  it("returns undefined and says nothing when there is no file", async () => {
    const warnings: string[] = [];
    expect(
      await loadProjectConfig(workspace, (line) => warnings.push(line)),
    ).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("reads a valid override", async () => {
    await writeLocal({
      backends: ["codex"],
      models: { middle: gpt("gpt-5.1") },
    });
    expect(await loadProjectConfig(workspace)).toEqual({
      backends: ["codex"],
      models: { middle: gpt("gpt-5.1") },
    });
  });

  it("warns exactly once and ignores a malformed file", async () => {
    const warnings: string[] = [];
    await writeLocal("{ not json");
    expect(
      await loadProjectConfig(workspace, (line) => warnings.push(line)),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath(workspace));
  });

  it("never throws on a file with an impossible shape", async () => {
    const warnings: string[] = [];
    await writeLocal({ backends: ["codex"], models: { low: cc("opus") } });
    await expect(
      loadProjectConfig(workspace, (line) => warnings.push(line)),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

// --- saving -----------------------------------------------------------------

describe("saveProjectConfig", () => {
  it("writes only the keys it was given, with no version", async () => {
    await mkdir(path.join(workspace, ".agent"));
    const written = await saveProjectConfig(workspace, {
      backends: ["codex"],
    });
    expect(written).toBe(projectConfigPath(workspace));
    expect(JSON.parse(await readFile(written, "utf8"))).toEqual({
      backends: ["codex"],
    });
  });

  it("round-trips through the loader", async () => {
    await mkdir(path.join(workspace, ".agent"));
    const config: KapelProjectConfig = {
      backends: ["codex", "claude-code"],
      models: { orchestrator: cc("opus"), low: gpt("gpt-5-mini") },
    };
    await saveProjectConfig(workspace, config);
    expect(await loadProjectConfig(workspace)).toEqual(config);
  });

  it("refuses to scaffold .agent itself", async () => {
    await expect(
      saveProjectConfig(workspace, { backends: ["codex"] }),
    ).rejects.toBeInstanceOf(MissingAgentDirError);
    await expect(
      saveProjectConfig(workspace, { backends: ["codex"] }),
    ).rejects.toThrow(/kapel init/);
  });
});

// --- merging ----------------------------------------------------------------

describe("mergeKapelConfigs", () => {
  it("is undefined when neither layer says anything", () => {
    expect(mergeKapelConfigs(undefined, undefined)).toBeUndefined();
    expect(mergeKapelConfigs(undefined, {})).toBeUndefined();
  });

  it("passes the machine config through untouched with no override", () => {
    const machine = machineConfig();
    const merged = mergeKapelConfigs(machine, undefined);
    expect(merged?.config).toEqual(machine);
    expect(merged?.sources).toEqual({
      backends: "machine",
      models: {
        orchestrator: "machine",
        complex: "machine",
        middle: "machine",
        low: "machine",
      },
    });
  });

  it("overrides one role and leaves the other three alone", () => {
    const merged = mergeKapelConfigs(
      machineConfig({ backends: ["claude-code", "codex"] }),
      { models: { middle: gpt("gpt-5.1") } },
    );
    expect(merged?.config.models.middle).toEqual(gpt("gpt-5.1"));
    expect(merged?.config.models.low).toEqual(cc("haiku"));
    expect(merged?.sources.models).toEqual({
      orchestrator: "machine",
      complex: "machine",
      middle: "project",
      low: "machine",
    });
  });

  it("replaces the backend list wholesale, keeping roles that still fit", () => {
    const merged = mergeKapelConfigs(
      machineConfig({ backends: ["claude-code", "codex"] }),
      { backends: ["claude-code"] },
    );
    expect(merged?.config.backends).toEqual(["claude-code"]);
    expect(merged?.sources.backends).toBe("project");
    expect(merged?.config.models.orchestrator).toEqual(cc("opus"));
  });

  it("falls back to the default for a role whose backend is no longer enabled", () => {
    const machine = machineConfig({
      backends: ["claude-code", "codex"],
      models: {
        orchestrator: cc("opus"),
        complex: cc("opus"),
        middle: gpt("gpt-5.1"),
        low: gpt("gpt-5-mini"),
      },
    });
    const merged = mergeKapelConfigs(machine, { backends: ["claude-code"] });
    expect(merged?.config.models.middle).toEqual(cc("sonnet"));
    expect(merged?.sources.models.middle).toBe("default");
    expect(merged?.config.models.orchestrator).toEqual(cc("opus"));
    expect(merged?.sources.models.orchestrator).toBe("machine");
  });

  it("derives the backend list from a models-only override with no machine config", () => {
    const merged = mergeKapelConfigs(undefined, {
      models: { orchestrator: gpt("gpt-5.1") },
    });
    expect(merged?.config.backends).toEqual(["codex"]);
    expect(merged?.sources.backends).toBe("default");
    expect(merged?.config.models.orchestrator).toEqual(gpt("gpt-5.1"));
    // Everything the project did not name gets that backend's suggestion.
    expect(merged?.config.models.low).toEqual(gpt("default"));
    expect(merged?.sources.models.low).toBe("default");
  });

  it("keeps the machine's permission block and write time", () => {
    const merged = mergeKapelConfigs(
      machineConfig({ permission: { edit_file: "allow" } }),
      { backends: ["codex"] },
    );
    expect(merged?.config.permission).toEqual({ edit_file: "allow" });
    expect(merged?.config.updatedAt).toBe(1_700_000_000_000);
  });
});

// --- display ----------------------------------------------------------------

describe("describeEffectiveConfig", () => {
  it("names the file each value came from", () => {
    const merged = mergeKapelConfigs(
      machineConfig({ backends: ["claude-code", "codex"] }),
      { models: { middle: gpt("gpt-5.1") } },
    );
    if (merged === undefined) throw new Error("merge failed");
    expect(
      describeEffectiveConfig(merged, {
        machine: "/home/me/.kapel/config.json",
        project: "/repo/.agent/config.local.json",
      }),
    ).toEqual([
      "backends: Claude Code (claude-code), Codex (codex)  (from /home/me/.kapel/config.json)",
      "orchestrator model: opus (claude-code)  (from /home/me/.kapel/config.json)",
      "worker model (complex tasks): opus (claude-code)  (from /home/me/.kapel/config.json)",
      "worker model (routine, non-trivial tasks): gpt-5.1 (codex)  (from /repo/.agent/config.local.json)",
      "worker model (small tasks): haiku (claude-code)  (from /home/me/.kapel/config.json)",
      "updated: 2023-11-14T22:13:20.000Z",
    ]);
  });

  it("says so when a value is neither file's", () => {
    const merged = mergeKapelConfigs(undefined, { backends: ["codex"] });
    if (merged === undefined) throw new Error("merge failed");
    const lines = describeEffectiveConfig(merged, {
      machine: "/m.json",
      project: "/p.json",
    });
    expect(lines[1]).toBe(
      "orchestrator model: default (codex)  (built-in default)",
    );
  });
});
