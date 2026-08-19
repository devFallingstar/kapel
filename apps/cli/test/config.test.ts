import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { defaultModelCatalog } from "@agent/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import {
  backendChoices,
  defaultModelsFor,
  describeConfig,
  KAPEL_CONFIG_VERSION,
  kapelConfigDir,
  kapelConfigPath,
  loadKapelConfig,
  modelChoicesFor,
  saveKapelConfig,
} from "../src/config.js";

// Session-provided scratch dir when set (keeps CI and local machines on the
// OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-config-"));
  env = { KAPEL_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

// --- location ---------------------------------------------------------------

describe("kapelConfigDir", () => {
  it("honours KAPEL_CONFIG_DIR", () => {
    expect(kapelConfigDir(env)).toBe(configDir);
  });

  it("falls back to ~/.kapel", () => {
    expect(kapelConfigDir({} as NodeJS.ProcessEnv)).toBe(
      path.join(homedir(), ".kapel"),
    );
  });

  it("treats an empty KAPEL_CONFIG_DIR as unset", () => {
    expect(kapelConfigDir({ KAPEL_CONFIG_DIR: "" } as NodeJS.ProcessEnv)).toBe(
      path.join(homedir(), ".kapel"),
    );
  });

  it("puts config.json inside the directory", () => {
    expect(kapelConfigPath(env)).toBe(path.join(configDir, "config.json"));
  });
});

// --- persistence ------------------------------------------------------------

const MODELS = {
  orchestrator: "opus",
  complex: "opus",
  middle: "sonnet",
  low: "haiku",
} as const;

describe("saveKapelConfig / loadKapelConfig", () => {
  it("round-trips a config through disk", async () => {
    const filePath = await saveKapelConfig(
      { backend: "claude-code", models: MODELS, updatedAt: 1_700_000_000_000 },
      env,
    );
    expect(filePath).toBe(kapelConfigPath(env));

    const loaded = await loadKapelConfig(env);
    expect(loaded).toEqual({
      version: KAPEL_CONFIG_VERSION,
      backend: "claude-code",
      models: MODELS,
      updatedAt: 1_700_000_000_000,
    });
  });

  it("creates the config directory when it does not exist", async () => {
    const nested = path.join(configDir, "deep", "deeper");
    const nestedEnv = { KAPEL_CONFIG_DIR: nested } as NodeJS.ProcessEnv;
    await saveKapelConfig({ backend: "codex", models: MODELS }, nestedEnv);
    expect((await loadKapelConfig(nestedEnv))?.backend).toBe("codex");
  });

  it("writes pretty JSON with a trailing newline", async () => {
    const filePath = await saveKapelConfig(
      { backend: "native", models: MODELS, updatedAt: 1 },
      env,
    );
    const text = await readFile(filePath, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "backend": "native"');
  });

  it("stamps updatedAt with the current time when none is given", async () => {
    const before = Date.now();
    await saveKapelConfig({ backend: "codex", models: MODELS }, env);
    const loaded = await loadKapelConfig(env);
    expect(loaded?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("returns undefined when no config has been written", async () => {
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("returns undefined for unparseable JSON instead of throwing", async () => {
    await writeFile(kapelConfigPath(env), "{ not json", "utf8");
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("returns undefined for a config from an unknown version", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: KAPEL_CONFIG_VERSION + 1,
        backend: "codex",
        models: MODELS,
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("returns undefined for an unknown backend", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: KAPEL_CONFIG_VERSION,
        backend: "telepathy",
        models: MODELS,
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("returns undefined when a model role is missing", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: KAPEL_CONFIG_VERSION,
        backend: "codex",
        models: { orchestrator: "opus", complex: "opus", middle: "sonnet" },
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("migrates a version-1 file onto the three worker tiers", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: 1,
        backend: "claude-code",
        models: { orchestrator: "opus", worker: "sonnet", cheap: "haiku" },
        updatedAt: 7,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toEqual({
      version: KAPEL_CONFIG_VERSION,
      backend: "claude-code",
      models: {
        orchestrator: "opus",
        // `complex` approximates from the one worker model v1 asked about.
        complex: "sonnet",
        middle: "sonnet",
        low: "haiku",
      },
      updatedAt: 7,
    });
  });

  it("leaves a migrated version-1 file on disk until something saves", async () => {
    const v1 = JSON.stringify({
      version: 1,
      backend: "codex",
      models: {
        orchestrator: "gpt-5.1",
        worker: "gpt-5.1",
        cheap: "gpt-5-mini",
      },
      updatedAt: 3,
    });
    await writeFile(kapelConfigPath(env), v1, "utf8");
    await loadKapelConfig(env);
    expect(await readFile(kapelConfigPath(env), "utf8")).toBe(v1);
  });

  it("returns undefined for a version-1 file missing a v1 role", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: 1,
        backend: "codex",
        models: { orchestrator: "opus", worker: "sonnet" },
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("re-saves a migrated config as version 2", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: 1,
        backend: "claude-code",
        models: { orchestrator: "opus", worker: "sonnet", cheap: "haiku" },
        updatedAt: 7,
      }),
      "utf8",
    );
    const migrated = await loadKapelConfig(env);
    if (migrated === undefined) throw new Error("migration failed");
    await saveKapelConfig(
      { backend: migrated.backend, models: migrated.models, updatedAt: 9 },
      env,
    );
    const written = JSON.parse(await readFile(kapelConfigPath(env), "utf8"));
    expect(written.version).toBe(2);
    expect(written.models).toEqual({
      orchestrator: "opus",
      complex: "sonnet",
      middle: "sonnet",
      low: "haiku",
    });
  });

  it("returns undefined for a JSON document that is not an object", async () => {
    await writeFile(kapelConfigPath(env), '"nope"', "utf8");
    expect(await loadKapelConfig(env)).toBeUndefined();
  });
});

// --- choice lists -----------------------------------------------------------

describe("backendChoices", () => {
  it("offers the two subscription logins and the API-key path", () => {
    const choices = backendChoices();
    expect(choices.map((choice) => choice.value)).toEqual([
      "claude-code",
      "codex",
      "native",
    ]);
    expect(choices[0]?.label).toBe("Claude Code");
    expect(choices[0]?.hint).toContain("no API key");
    expect(choices[1]?.hint).toContain("Codex CLI");
    expect(choices[2]?.label).toBe("API key (Anthropic/OpenAI)");
  });
});

describe("modelChoicesFor", () => {
  const anthropicCatalogIds = Object.keys(defaultModelCatalog())
    .filter((id) => defaultModelCatalog()[id]?.provider === "anthropic")
    .sort();
  const openaiCatalogIds = Object.keys(defaultModelCatalog())
    .filter((id) => defaultModelCatalog()[id]?.provider === "openai")
    .sort();

  it("offers the Claude Code aliases, every catalog id, and default", () => {
    expect(
      modelChoicesFor("claude-code", "orchestrator").map(
        (choice) => choice.value,
      ),
    ).toEqual(["opus", "sonnet", "haiku", ...anthropicCatalogIds, "default"]);
  });

  it("does not gate the Claude Code catalog ids behind an account guess", () => {
    for (const choice of modelChoicesFor("claude-code", "middle")) {
      expect(choice.hint).not.toContain("only if your account has it");
    }
  });

  it("marks the role's suggestion in the Claude Code list", () => {
    const hintOf = (
      role: "orchestrator" | "complex" | "middle" | "low",
      value: string,
    ): string | undefined =>
      modelChoicesFor("claude-code", role).find(
        (choice) => choice.value === value,
      )?.hint;

    expect(hintOf("orchestrator", "opus")).toContain("suggested for this role");
    expect(hintOf("orchestrator", "sonnet")).not.toContain("suggested");
    expect(hintOf("complex", "opus")).toContain("suggested for this role");
    expect(hintOf("middle", "sonnet")).toContain("suggested for this role");
    expect(hintOf("low", "haiku")).toContain("suggested for this role");
  });

  it("leads the Codex list with `default` and offers every catalog id", () => {
    const expectedNamed = Array.from(
      new Set(["gpt-5.1-codex", ...openaiCatalogIds]),
    ).sort();
    for (const role of ["orchestrator", "complex", "middle", "low"] as const) {
      const choices = modelChoicesFor("codex", role);
      expect(choices[0]?.value).toBe("default");
      expect(choices[0]?.hint).toContain("suggested for this role");
      expect(choices.map((choice) => choice.value)).toEqual([
        "default",
        ...expectedNamed,
      ]);
    }
  });

  it("does not gate the named Codex ids behind an account guess", () => {
    const named = modelChoicesFor("codex", "middle").filter(
      (choice) => choice.value !== "default",
    );
    expect(named.length).toBeGreaterThan(0);
    for (const choice of named) {
      expect(choice.hint).not.toContain("only if your account has it");
      expect(choice.hint).toContain("errors at run time");
    }
  });

  it("builds the native list from the model catalog, sorted", () => {
    const aliases = Object.keys(defaultModelCatalog()).sort();
    const choices = modelChoicesFor("native", "orchestrator");
    expect(choices.map((choice) => choice.value)).toEqual(aliases);
    expect(choices.map((choice) => choice.label)).toEqual(aliases);
  });

  it("hints the provider, and pricing where the catalog has it", () => {
    const catalog = defaultModelCatalog();
    const choices = modelChoicesFor("native", "middle");
    const sonnet = choices.find((choice) => choice.value === "claude-sonnet-5");
    expect(sonnet?.hint).toContain("anthropic");
    expect(sonnet?.hint).toContain("pricing available");

    const openai = choices.find((choice) => choice.value === "gpt-5-mini");
    expect(catalog["gpt-5-mini"]?.pricing).toBeUndefined();
    expect(openai?.hint).toBe("openai");
  });
});

describe("defaultModelsFor", () => {
  it("spreads Claude Code across opus / opus / sonnet / haiku", () => {
    expect(defaultModelsFor("claude-code")).toEqual({
      orchestrator: "opus",
      complex: "opus",
      middle: "sonnet",
      low: "haiku",
    });
  });

  it("lets Codex pick for every role", () => {
    expect(defaultModelsFor("codex")).toEqual({
      orchestrator: "default",
      complex: "default",
      middle: "default",
      low: "default",
    });
  });

  it("picks catalog aliases for the native backend", () => {
    const catalog = defaultModelCatalog();
    const models = defaultModelsFor("native");
    expect(models).toEqual({
      orchestrator: "claude-opus-5",
      complex: "claude-opus-5",
      middle: "claude-sonnet-5",
      low: "claude-haiku-4-5",
    });
    for (const alias of Object.values(models)) {
      expect(catalog[alias]).toBeDefined();
    }
  });
});

// --- display ----------------------------------------------------------------

describe("describeConfig", () => {
  it("names the backend, every role and the write time", () => {
    const config: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backend: "claude-code",
      models: MODELS,
      updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    };
    expect(describeConfig(config)).toEqual([
      "backend: Claude Code (claude-code)",
      "orchestrator model: opus",
      "worker model (complex tasks): opus",
      "worker model (everyday tasks): sonnet",
      "worker model (small tasks): haiku",
      "updated: 2026-01-02T03:04:05.000Z",
    ]);
  });
});
