import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { defaultModelCatalog } from "@agent/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KapelConfig, KapelModels } from "../src/config.js";
import {
  backendChoices,
  decodeRoleModel,
  defaultModelsFor,
  defaultRoleModel,
  describeConfig,
  encodeRoleModel,
  KAPEL_CONFIG_VERSION,
  kapelConfigDir,
  kapelConfigPath,
  loadKapelConfig,
  modelChoicesFor,
  saveKapelConfig,
  soleExecutionBackend,
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

/** `{backend: "claude-code", model}` — the common case, spelled short. */
const cc = (model: string) => ({ backend: "claude-code", model }) as const;

const MODELS: KapelModels = {
  orchestrator: cc("opus"),
  complex: cc("opus"),
  middle: cc("sonnet"),
  low: cc("haiku"),
};

const CODEX_MODELS: KapelModels = {
  orchestrator: { backend: "codex", model: "gpt-5.1" },
  complex: { backend: "codex", model: "gpt-5.1" },
  middle: { backend: "codex", model: "gpt-5-mini" },
  low: { backend: "codex", model: "gpt-5-mini" },
};

describe("saveKapelConfig / loadKapelConfig", () => {
  it("round-trips a config through disk", async () => {
    const filePath = await saveKapelConfig(
      {
        backends: ["claude-code"],
        models: MODELS,
        updatedAt: 1_700_000_000_000,
      },
      env,
    );
    expect(filePath).toBe(kapelConfigPath(env));

    const loaded = await loadKapelConfig(env);
    expect(loaded).toEqual({
      version: KAPEL_CONFIG_VERSION,
      backends: ["claude-code"],
      models: MODELS,
      updatedAt: 1_700_000_000_000,
    });
  });

  it("round-trips a mixed-backend config", async () => {
    await saveKapelConfig(
      {
        backends: ["claude-code", "codex"],
        models: {
          orchestrator: cc("opus"),
          complex: cc("opus"),
          middle: { backend: "codex", model: "gpt-5.1" },
          low: { backend: "codex", model: "gpt-5-mini" },
        },
        updatedAt: 3,
      },
      env,
    );
    const loaded = await loadKapelConfig(env);
    expect(loaded?.backends).toEqual(["claude-code", "codex"]);
    expect(loaded?.models.middle).toEqual({
      backend: "codex",
      model: "gpt-5.1",
    });
    expect(loaded?.models.orchestrator).toEqual(cc("opus"));
  });

  it("creates the config directory when it does not exist", async () => {
    const nested = path.join(configDir, "deep", "deeper");
    const nestedEnv = { KAPEL_CONFIG_DIR: nested } as NodeJS.ProcessEnv;
    await saveKapelConfig(
      { backends: ["codex"], models: CODEX_MODELS },
      nestedEnv,
    );
    expect((await loadKapelConfig(nestedEnv))?.backends).toEqual(["codex"]);
  });

  it("writes pretty JSON with a trailing newline", async () => {
    const filePath = await saveKapelConfig(
      {
        backends: ["native"],
        models: {
          orchestrator: { backend: "native", model: "claude-opus-5" },
          complex: { backend: "native", model: "claude-opus-5" },
          middle: { backend: "native", model: "claude-sonnet-5" },
          low: { backend: "native", model: "claude-haiku-4-5" },
        },
        updatedAt: 1,
      },
      env,
    );
    const text = await readFile(filePath, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "backends": [\n    "native"\n  ]');
  });

  it("stamps updatedAt with the current time when none is given", async () => {
    const before = Date.now();
    await saveKapelConfig({ backends: ["codex"], models: CODEX_MODELS }, env);
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
        backends: ["codex"],
        models: CODEX_MODELS,
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("returns undefined for an unknown backend in the list", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: KAPEL_CONFIG_VERSION,
        backends: ["telepathy"],
        models: CODEX_MODELS,
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("returns undefined for an empty or repeating backend list", async () => {
    for (const backends of [[], ["codex", "codex"], "codex", {}]) {
      await writeFile(
        kapelConfigPath(env),
        JSON.stringify({
          version: KAPEL_CONFIG_VERSION,
          backends,
          models: CODEX_MODELS,
          updatedAt: 1,
        }),
        "utf8",
      );
      expect(await loadKapelConfig(env)).toBeUndefined();
    }
  });

  it("returns undefined when a role names a backend the config does not enable", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: KAPEL_CONFIG_VERSION,
        backends: ["claude-code"],
        models: { ...MODELS, middle: { backend: "codex", model: "gpt-5.1" } },
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("returns undefined when a role model is missing or malformed", async () => {
    const broken: unknown[] = [
      { ...MODELS, low: undefined },
      { ...MODELS, low: "haiku" },
      { ...MODELS, low: { backend: "claude-code" } },
      { ...MODELS, low: { backend: "claude-code", model: "" } },
    ];
    for (const models of broken) {
      await writeFile(
        kapelConfigPath(env),
        JSON.stringify({
          version: KAPEL_CONFIG_VERSION,
          backends: ["claude-code"],
          models,
          updatedAt: 1,
        }),
        "utf8",
      );
      expect(await loadKapelConfig(env)).toBeUndefined();
    }
  });

  it("migrates a version-1 file onto the three worker tiers and one backend", async () => {
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
      backends: ["claude-code"],
      models: {
        orchestrator: cc("opus"),
        // `complex` approximates from the one worker model v1 asked about.
        complex: cc("sonnet"),
        middle: cc("sonnet"),
        low: cc("haiku"),
      },
      updatedAt: 7,
    });
  });

  it("migrates a version-2 file onto the one backend it named", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: 2,
        backend: "claude-code",
        models: {
          orchestrator: "opus",
          complex: "opus",
          middle: "sonnet",
          low: "haiku",
        },
        updatedAt: 11,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toEqual({
      version: KAPEL_CONFIG_VERSION,
      backends: ["claude-code"],
      models: MODELS,
      updatedAt: 11,
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

  it("returns undefined for a legacy file with an unknown backend", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: 2,
        backend: "telepathy",
        models: {
          orchestrator: "opus",
          complex: "opus",
          middle: "sonnet",
          low: "haiku",
        },
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("re-saves a migrated config as version 3", async () => {
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
      { backends: migrated.backends, models: migrated.models, updatedAt: 9 },
      env,
    );
    const written = JSON.parse(await readFile(kapelConfigPath(env), "utf8"));
    expect(written.version).toBe(3);
    expect(written.backends).toEqual(["claude-code"]);
    expect(written.models).toEqual({
      orchestrator: cc("opus"),
      complex: cc("sonnet"),
      middle: cc("sonnet"),
      low: cc("haiku"),
    });
  });

  it("returns undefined for a JSON document that is not an object", async () => {
    await writeFile(kapelConfigPath(env), '"nope"', "utf8");
    expect(await loadKapelConfig(env)).toBeUndefined();
  });
});

// --- P1-5: the machine-level `permission` block ------------------------------

async function writeRawConfig(
  filePath: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify({
      version: KAPEL_CONFIG_VERSION,
      backends: ["codex"],
      models: CODEX_MODELS,
      updatedAt: 1,
      ...overrides,
    }),
    "utf8",
  );
}

describe("loadKapelConfig - permission block", () => {
  it("round-trips a valid permission block, flat and pattern-map alike", async () => {
    await writeRawConfig(kapelConfigPath(env), {
      permission: {
        edit_file: "allow",
        bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
      },
    });

    const loaded = await loadKapelConfig(env);
    expect(loaded?.permission).toEqual({
      edit_file: "allow",
      bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
    });
  });

  it("omits the key entirely when there is no permission block", async () => {
    await writeRawConfig(kapelConfigPath(env), {});
    const loaded = await loadKapelConfig(env);
    expect(loaded).not.toHaveProperty("permission");
  });

  it("keeps a migrated version-2 file's permission block", async () => {
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: 2,
        backend: "codex",
        models: {
          orchestrator: "gpt-5.1",
          complex: "gpt-5.1",
          middle: "gpt-5-mini",
          low: "gpt-5-mini",
        },
        updatedAt: 1,
        permission: { edit_file: "allow" },
      }),
      "utf8",
    );
    expect((await loadKapelConfig(env))?.permission).toEqual({
      edit_file: "allow",
    });
  });

  it("drops an invalid tool verdict and warns, but keeps the rest of the config", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeRawConfig(kapelConfigPath(env), {
        permission: { edit_file: "maybe", read_file: "allow" },
      });

      const loaded = await loadKapelConfig(env);
      expect(loaded?.backends).toEqual(["codex"]);
      expect(loaded?.permission).toEqual({ read_file: "allow" });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("drops an invalid bash pattern verdict and warns", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeRawConfig(kapelConfigPath(env), {
        permission: { bash: { "*": "ask", "git *": "sometimes" } },
      });

      const loaded = await loadKapelConfig(env);
      expect(loaded?.permission).toEqual({ bash: { "*": "ask" } });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("ignores a permission block that isn't an object, warns, keeps the config", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeRawConfig(kapelConfigPath(env), { permission: "allow" });

      const loaded = await loadKapelConfig(env);
      expect(loaded?.backends).toEqual(["codex"]);
      expect(loaded).not.toHaveProperty("permission");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("drops a bash entry left with no valid patterns at all", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeRawConfig(kapelConfigPath(env), {
        permission: { bash: { "git *": "sometimes" } },
      });

      const loaded = await loadKapelConfig(env);
      expect(loaded).not.toHaveProperty("permission");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never crashes on a malformed permission block", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeRawConfig(kapelConfigPath(env), {
        permission: { bash: 42, edit_file: [] },
      });
      await expect(loadKapelConfig(env)).resolves.toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("saveKapelConfig - permission preservation", () => {
  it("writes a permission block when one is passed", async () => {
    await saveKapelConfig(
      {
        backends: ["codex"],
        models: CODEX_MODELS,
        updatedAt: 1,
        permission: { edit_file: "allow" },
      },
      env,
    );
    const loaded = await loadKapelConfig(env);
    expect(loaded?.permission).toEqual({ edit_file: "allow" });
  });

  it("writes no permission key when none is passed", async () => {
    await saveKapelConfig({ backends: ["codex"], models: CODEX_MODELS }, env);
    const loaded = await loadKapelConfig(env);
    expect(loaded).not.toHaveProperty("permission");
  });
});

// --- role-model encoding -----------------------------------------------------

describe("encodeRoleModel / decodeRoleModel", () => {
  it("round-trips every backend", () => {
    for (const backend of ["claude-code", "codex", "native"] as const) {
      const entry = { backend, model: "some-model" };
      expect(decodeRoleModel(encodeRoleModel(entry))).toEqual(entry);
    }
  });

  it("splits at the first colon only", () => {
    expect(decodeRoleModel("codex:gpt:5")).toEqual({
      backend: "codex",
      model: "gpt:5",
    });
  });

  it("refuses a missing prefix, an unknown backend or an empty model", () => {
    expect(decodeRoleModel("opus")).toBeUndefined();
    expect(decodeRoleModel("telepathy:opus")).toBeUndefined();
    expect(decodeRoleModel("codex:")).toBeUndefined();
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
      modelChoicesFor(["claude-code"], "orchestrator").map(
        (choice) => choice.value,
      ),
    ).toEqual(
      ["opus", "sonnet", "haiku", ...anthropicCatalogIds, "default"].map(
        (model) => `claude-code:${model}`,
      ),
    );
  });

  it("labels each choice with the bare model id", () => {
    expect(
      modelChoicesFor(["claude-code"], "orchestrator").map(
        (choice) => choice.label,
      ),
    ).toEqual(["opus", "sonnet", "haiku", ...anthropicCatalogIds, "default"]);
  });

  it("does not gate the Claude Code catalog ids behind an account guess", () => {
    for (const choice of modelChoicesFor(["claude-code"], "middle")) {
      expect(choice.hint).not.toContain("only if your account has it");
    }
  });

  it("marks the role's suggestion in the Claude Code list", () => {
    const hintOf = (
      role: "orchestrator" | "complex" | "middle" | "low",
      value: string,
    ): string | undefined =>
      modelChoicesFor(["claude-code"], role).find(
        (choice) => choice.value === `claude-code:${value}`,
      )?.hint;

    expect(hintOf("orchestrator", "opus")).toContain("suggested for this role");
    expect(hintOf("orchestrator", "sonnet")).not.toContain("suggested");
    expect(hintOf("complex", "opus")).toContain("suggested for this role");
    expect(hintOf("middle", "sonnet")).toContain("suggested for this role");
    expect(hintOf("low", "haiku")).toContain("suggested for this role");
  });

  it("leaves a single backend's hints unqualified", () => {
    const opus = modelChoicesFor(["claude-code"], "middle").find(
      (choice) => choice.value === "claude-code:opus",
    );
    expect(opus?.hint).toBe("Claude Opus — highest capability");
  });

  it("leads the Codex list with `default` and offers every catalog id", () => {
    const expectedNamed = Array.from(
      new Set(["gpt-5.1-codex", ...openaiCatalogIds]),
    ).sort();
    for (const role of ["orchestrator", "complex", "middle", "low"] as const) {
      const choices = modelChoicesFor(["codex"], role);
      expect(choices[0]?.value).toBe("codex:default");
      expect(choices[0]?.hint).toContain("suggested for this role");
      expect(choices.map((choice) => choice.value)).toEqual(
        ["default", ...expectedNamed].map((model) => `codex:${model}`),
      );
    }
  });

  it("does not gate the named Codex ids behind an account guess", () => {
    const named = modelChoicesFor(["codex"], "middle").filter(
      (choice) => choice.value !== "codex:default",
    );
    expect(named.length).toBeGreaterThan(0);
    for (const choice of named) {
      expect(choice.hint).not.toContain("only if your account has it");
      expect(choice.hint).toContain("errors at run time");
    }
  });

  it("builds the native list from the model catalog, sorted", () => {
    const aliases = Object.keys(defaultModelCatalog()).sort();
    const choices = modelChoicesFor(["native"], "orchestrator");
    expect(choices.map((choice) => choice.value)).toEqual(
      aliases.map((alias) => `native:${alias}`),
    );
    expect(choices.map((choice) => choice.label)).toEqual(aliases);
  });

  it("hints the provider, and pricing where the catalog has it", () => {
    const catalog = defaultModelCatalog();
    const choices = modelChoicesFor(["native"], "middle");
    const sonnet = choices.find(
      (choice) => choice.value === "native:claude-sonnet-5",
    );
    expect(sonnet?.hint).toContain("anthropic");
    expect(sonnet?.hint).toContain("pricing available");

    const openai = choices.find(
      (choice) => choice.value === "native:gpt-5-mini",
    );
    expect(catalog["gpt-5-mini"]?.pricing).toBeUndefined();
    expect(openai?.hint).toBe("openai");
  });

  it("concatenates several backends' lists in the order they were chosen", () => {
    const choices = modelChoicesFor(["codex", "claude-code"], "middle");
    const values = choices.map((choice) => choice.value);
    expect(values[0]).toBe("codex:default");
    expect(values).toContain("claude-code:sonnet");
    // Every Codex entry comes before every Claude Code one.
    const firstClaude = values.findIndex((value) =>
      value.startsWith("claude-code:"),
    );
    expect(
      values.slice(0, firstClaude).every((value) => value.startsWith("codex:")),
    ).toBe(true);
  });

  it("names the backend in every hint once more than one is selected", () => {
    for (const choice of modelChoicesFor(["claude-code", "codex"], "low")) {
      const expected = choice.value.startsWith("codex:")
        ? "Codex"
        : "Claude Code";
      expect(choice.hint?.startsWith(expected)).toBe(true);
    }
  });

  it("suggests Claude Code's tier default when it is one of the selection", () => {
    const suggested = modelChoicesFor(
      ["codex", "claude-code"],
      "middle",
    ).filter(
      (choice) => choice.hint?.includes("suggested for this role") === true,
    );
    expect(suggested.map((choice) => choice.value)).toEqual([
      "claude-code:sonnet",
    ]);
  });

  it("suggests Codex's default when Claude Code is not selected", () => {
    const suggested = modelChoicesFor(["native", "codex"], "low").filter(
      (choice) => choice.hint?.includes("suggested for this role") === true,
    );
    expect(suggested.map((choice) => choice.value)).toEqual(["codex:default"]);
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

describe("defaultRoleModel", () => {
  it("prefers Claude Code's tier defaults, then Codex's, then native's", () => {
    expect(defaultRoleModel(["codex", "claude-code"], "middle")).toEqual(
      cc("sonnet"),
    );
    expect(defaultRoleModel(["native", "codex"], "middle")).toEqual({
      backend: "codex",
      model: "default",
    });
    expect(defaultRoleModel(["native"], "middle")).toEqual({
      backend: "native",
      model: "claude-sonnet-5",
    });
  });
});

// --- the one backend a single-backend consumer runs on ----------------------

describe("soleExecutionBackend", () => {
  it("is the orchestrator role's backend, not the first of the list", () => {
    const config: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["codex", "claude-code"],
      models: {
        orchestrator: cc("opus"),
        complex: cc("opus"),
        middle: { backend: "codex", model: "gpt-5.1" },
        low: { backend: "codex", model: "gpt-5-mini" },
      },
      updatedAt: 0,
    };
    expect(soleExecutionBackend(config)).toBe("claude-code");
  });
});

// --- display ----------------------------------------------------------------

describe("describeConfig", () => {
  it("names the backends, every role's model and backend, and the write time", () => {
    const config: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["claude-code"],
      models: MODELS,
      updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    };
    expect(describeConfig(config)).toEqual([
      "backends: Claude Code (claude-code)",
      "orchestrator model: opus (claude-code)",
      "worker model (complex tasks): opus (claude-code)",
      "worker model (everyday tasks): sonnet (claude-code)",
      "worker model (small tasks): haiku (claude-code)",
      "updated: 2026-01-02T03:04:05.000Z",
    ]);
  });

  it("lists every configured backend, in order", () => {
    const config: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["claude-code", "codex"],
      models: { ...MODELS, middle: { backend: "codex", model: "gpt-5.1" } },
      updatedAt: 0,
    };
    const lines = describeConfig(config);
    expect(lines[0]).toBe("backends: Claude Code (claude-code), Codex (codex)");
    expect(lines[3]).toBe("worker model (everyday tasks): gpt-5.1 (codex)");
  });
});
