import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { defaultModelCatalog } from "@agent/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KapelConfig, KapelModels } from "../src/config.js";
import {
  backendChoices,
  canonicalRoleModel,
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

// --- the machine-level `notify` setting --------------------------------------

describe("loadKapelConfig - notify setting", () => {
  it("round-trips each valid value", async () => {
    for (const notify of ["off", "bell", "osc9", "auto"] as const) {
      await writeRawConfig(kapelConfigPath(env), { notify });
      expect((await loadKapelConfig(env))?.notify).toBe(notify);
    }
  });

  it("omits the key entirely when there is no notify setting", async () => {
    await writeRawConfig(kapelConfigPath(env), {});
    const loaded = await loadKapelConfig(env);
    expect(loaded).not.toHaveProperty("notify");
  });

  it("drops an unrecognised value, warns, but keeps the rest of the config", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeRawConfig(kapelConfigPath(env), { notify: "loud" });
      const loaded = await loadKapelConfig(env);
      expect(loaded?.backends).toEqual(["codex"]);
      expect(loaded).not.toHaveProperty("notify");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps a migrated version-2 file's notify setting", async () => {
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
        notify: "bell",
      }),
      "utf8",
    );
    expect((await loadKapelConfig(env))?.notify).toBe("bell");
  });
});

describe("saveKapelConfig - notify preservation", () => {
  it("writes a notify key when one is passed", async () => {
    await saveKapelConfig(
      {
        backends: ["codex"],
        models: CODEX_MODELS,
        updatedAt: 1,
        notify: "osc9",
      },
      env,
    );
    const loaded = await loadKapelConfig(env);
    expect(loaded?.notify).toBe("osc9");
  });

  it("writes no notify key when none is passed", async () => {
    await saveKapelConfig({ backends: ["codex"], models: CODEX_MODELS }, env);
    const loaded = await loadKapelConfig(env);
    expect(loaded).not.toHaveProperty("notify");
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

  // The pinned "recommended" block per role — mirrors
  // `PINNED_MODELS_BY_ROLE` in `src/config.ts`. Kept alongside the tests
  // (rather than imported) so a test failure here means the exported
  // behaviour actually moved, not just this fixture.
  const PINNED: Record<string, readonly string[]> = {
    orchestrator: ["claude-fable-5", "claude-opus-5", "sol-5.6", "terra-5.6"],
    complex: ["claude-fable-5", "claude-opus-5", "sol-5.6", "terra-5.6"],
    middle: ["claude-opus-5", "claude-sonnet-5", "terra-5.6", "luna-5.6"],
    low: ["claude-sonnet-5", "claude-haiku-4-5", "terra-5.6", "luna-5.6"],
  };

  it("pins the recommended block on top, then every other catalog id, then default", () => {
    const pinned = PINNED.orchestrator?.filter((id) => id.startsWith("claude"));
    const rest = anthropicCatalogIds.filter((id) => !pinned?.includes(id));
    expect(
      modelChoicesFor(["claude-code"], "orchestrator").map(
        (choice) => choice.value,
      ),
    ).toEqual(
      [...(pinned ?? []), ...rest, "default"].map(
        (model) => `claude-code:${model}`,
      ),
    );
  });

  it("labels the pinned entries with their curated names, everything else with the bare id", () => {
    const choices = modelChoicesFor(["claude-code"], "orchestrator");
    expect(choices[0]).toMatchObject({
      value: "claude-code:claude-fable-5",
      label: "Fable 5",
    });
    expect(choices[1]).toMatchObject({
      value: "claude-code:claude-opus-5",
      label: "Opus 5",
    });
    expect(
      choices.find((choice) => choice.value === "claude-code:claude-sonnet-5"),
    ).toMatchObject({ label: "claude-sonnet-5" });
  });

  it("never repeats a model between the pinned block and the rest", () => {
    for (const role of ["orchestrator", "complex", "middle", "low"] as const) {
      const values = modelChoicesFor(["claude-code", "codex"], role).map(
        (choice) => choice.value,
      );
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("only pins entries whose backend was actually ticked", () => {
    const claudeOnly = modelChoicesFor(["claude-code"], "orchestrator");
    expect(claudeOnly.some((choice) => choice.value.startsWith("codex:"))).toBe(
      false,
    );
    expect(claudeOnly.slice(0, 2).map((choice) => choice.value)).toEqual([
      "claude-code:claude-fable-5",
      "claude-code:claude-opus-5",
    ]);

    const codexOnly = modelChoicesFor(["codex"], "orchestrator");
    expect(codexOnly.slice(0, 2).map((choice) => choice.value)).toEqual([
      "codex:sol-5.6",
      "codex:terra-5.6",
    ]);
  });

  it("drops the alias entries: opus/sonnet/haiku no longer appear as their own rows", () => {
    for (const role of ["orchestrator", "complex", "middle", "low"] as const) {
      const values = modelChoicesFor(["claude-code"], role).map(
        (choice) => choice.value,
      );
      expect(values).not.toContain("claude-code:opus");
      expect(values).not.toContain("claude-code:sonnet");
      expect(values).not.toContain("claude-code:haiku");
    }
  });

  it("hints every pinned entry with its backend, `recommended · <Backend>`", () => {
    const choices = modelChoicesFor(["claude-code", "codex"], "orchestrator");
    for (const model of PINNED.orchestrator ?? []) {
      const backend = model.startsWith("claude") ? "claude-code" : "codex";
      const label = backend === "claude-code" ? "Claude Code" : "Codex";
      expect(
        choices.find((choice) => choice.value === `${backend}:${model}`)?.hint,
      ).toBe(`recommended · ${label}`);
    }
  });

  it("does not gate the Claude Code catalog ids behind an account guess", () => {
    for (const choice of modelChoicesFor(["claude-code"], "middle")) {
      expect(choice.hint).not.toContain("only if your account has it");
    }
  });

  it("leaves a single backend's hints unqualified", () => {
    // `claude-haiku-4-5` is not pinned for `middle`, so it stays in the
    // plain "rest" section with an unqualified, un-tagged hint.
    const haiku = modelChoicesFor(["claude-code"], "middle").find(
      (choice) => choice.value === "claude-code:claude-haiku-4-5",
    );
    expect(haiku?.hint).toBe("errors at run time if your plan lacks it");
  });

  it("puts codex's `default` at the very bottom, after the pinned block and the rest", () => {
    for (const role of ["orchestrator", "complex", "middle", "low"] as const) {
      const pinned = PINNED[role]?.filter((id) => !id.startsWith("claude"));
      const named = Array.from(
        new Set(["gpt-5.1-codex", ...openaiCatalogIds]),
      ).sort();
      const rest = named.filter((id) => !pinned?.includes(id));
      const choices = modelChoicesFor(["codex"], role);
      expect(choices.map((choice) => choice.value)).toEqual(
        [...(pinned ?? []), ...rest, "default"].map(
          (model) => `codex:${model}`,
        ),
      );
      // codex's default is still every role's suggestion — it is simply no
      // longer first.
      expect(choices.at(-1)?.hint).toContain("suggested for this role");
    }
  });

  it("does not gate the named Codex ids behind an account guess", () => {
    const named = modelChoicesFor(["codex"], "middle").filter(
      (choice) =>
        choice.value !== "codex:default" &&
        choice.hint?.startsWith("recommended") !== true,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const choice of named) {
      expect(choice.hint).not.toContain("only if your account has it");
      expect(choice.hint).toContain("errors at run time");
    }
  });

  it("registers sol-5.6/terra-5.6/luna-5.6 as real Codex choices", () => {
    const values = modelChoicesFor(["codex"], "orchestrator").map(
      (choice) => choice.value,
    );
    for (const model of ["sol-5.6", "terra-5.6", "luna-5.6"]) {
      expect(values).toContain(`codex:${model}`);
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

  it("puts the pinned block first regardless of the order backends were ticked", () => {
    const choices = modelChoicesFor(["codex", "claude-code"], "middle");
    const values = choices.map((choice) => choice.value);
    expect(values.slice(0, 4)).toEqual([
      "claude-code:claude-opus-5",
      "claude-code:claude-sonnet-5",
      "codex:terra-5.6",
      "codex:luna-5.6",
    ]);
    expect(values).toContain("claude-code:claude-sonnet-4-6");
    expect(values).toContain("codex:gpt-5.1");
    // Every `default` — one per ticked backend — trails everything else,
    // never repeating a model and never leaking into the middle of the list.
    const tailDefaults = values.slice(-2);
    expect(tailDefaults.sort()).toEqual([
      "claude-code:default",
      "codex:default",
    ]);
    expect(
      values.slice(0, -2).some((value) => value.endsWith(":default")),
    ).toBe(false);
  });

  it("names the backend in every non-pinned hint once more than one is selected", () => {
    for (const choice of modelChoicesFor(["claude-code", "codex"], "low")) {
      const backend = choice.value.startsWith("codex:")
        ? "Codex"
        : "Claude Code";
      if (choice.hint?.startsWith("recommended")) {
        expect(choice.hint).toBe(`recommended · ${backend}`);
      } else {
        expect(choice.hint?.startsWith(backend)).toBe(true);
      }
    }
  });

  it("marks a claude-code tier default as pinned rather than tagging it 'suggested' a second time", () => {
    const choices = modelChoicesFor(["codex", "claude-code"], "middle");
    const sonnet = choices.find(
      (choice) => choice.value === "claude-code:claude-sonnet-5",
    );
    expect(sonnet?.hint).toBe("recommended · Claude Code");
    expect(
      choices.some((choice) =>
        choice.hint?.includes("suggested for this role"),
      ),
    ).toBe(false);
  });

  it("suggests Codex's default when Claude Code is not selected", () => {
    const suggested = modelChoicesFor(["native", "codex"], "low").filter(
      (choice) => choice.hint?.includes("suggested for this role") === true,
    );
    expect(suggested.map((choice) => choice.value)).toEqual(["codex:default"]);
  });
});

describe("canonicalRoleModel", () => {
  it("maps every Claude Code alias to the full id its choice list actually shows", () => {
    expect(canonicalRoleModel(cc("opus"))).toEqual(cc("claude-opus-5"));
    expect(canonicalRoleModel(cc("sonnet"))).toEqual(cc("claude-sonnet-5"));
    expect(canonicalRoleModel(cc("haiku"))).toEqual(cc("claude-haiku-4-5"));
  });

  it("leaves a Claude Code full id unchanged", () => {
    expect(canonicalRoleModel(cc("claude-opus-5"))).toEqual(
      cc("claude-opus-5"),
    );
  });

  it("leaves every other backend untouched, alias-shaped model string or not", () => {
    expect(canonicalRoleModel({ backend: "codex", model: "opus" })).toEqual({
      backend: "codex",
      model: "opus",
    });
    expect(canonicalRoleModel({ backend: "native", model: "sonnet" })).toEqual({
      backend: "native",
      model: "sonnet",
    });
  });

  it("every canonical id it can produce is a real entry on the Claude Code list", () => {
    const values = new Set(
      modelChoicesFor(["claude-code"], "middle").map((choice) => choice.value),
    );
    for (const alias of ["opus", "sonnet", "haiku"]) {
      const canonical = canonicalRoleModel(cc(alias));
      expect(values.has(encodeRoleModel(canonical))).toBe(true);
    }
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
      "worker model (routine, non-trivial tasks): sonnet (claude-code)",
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
    expect(lines[3]).toBe(
      "worker model (routine, non-trivial tasks): gpt-5.1 (codex)",
    );
  });
});
