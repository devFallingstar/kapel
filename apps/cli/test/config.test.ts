import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { defaultModelCatalog } from "@agent/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  worker: "sonnet",
  cheap: "haiku",
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

  it("returns undefined for a config from another version", async () => {
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
        models: { orchestrator: "opus", worker: "sonnet" },
        updatedAt: 1,
      }),
      "utf8",
    );
    expect(await loadKapelConfig(env)).toBeUndefined();
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
      backend: "codex",
      models: MODELS,
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

  it("drops an invalid tool verdict and warns, but keeps the rest of the config", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeRawConfig(kapelConfigPath(env), {
        permission: { edit_file: "maybe", read_file: "allow" },
      });

      const loaded = await loadKapelConfig(env);
      expect(loaded?.backend).toBe("codex");
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
      expect(loaded?.backend).toBe("codex");
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
        backend: "codex",
        models: MODELS,
        updatedAt: 1,
        permission: { edit_file: "allow" },
      },
      env,
    );
    const loaded = await loadKapelConfig(env);
    expect(loaded?.permission).toEqual({ edit_file: "allow" });
  });

  it("writes no permission key when none is passed", async () => {
    await saveKapelConfig({ backend: "codex", models: MODELS }, env);
    const loaded = await loadKapelConfig(env);
    expect(loaded).not.toHaveProperty("permission");
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
  it("offers the Claude Code aliases", () => {
    expect(
      modelChoicesFor("claude-code", "orchestrator").map(
        (choice) => choice.value,
      ),
    ).toEqual(["opus", "sonnet", "haiku", "default"]);
  });

  it("marks the role's suggestion in the Claude Code list", () => {
    const hintOf = (
      role: "orchestrator" | "worker" | "cheap",
      value: string,
    ): string | undefined =>
      modelChoicesFor("claude-code", role).find(
        (choice) => choice.value === value,
      )?.hint;

    expect(hintOf("orchestrator", "opus")).toContain("suggested for this role");
    expect(hintOf("orchestrator", "sonnet")).not.toContain("suggested");
    expect(hintOf("worker", "sonnet")).toContain("suggested for this role");
    expect(hintOf("cheap", "haiku")).toContain("suggested for this role");
  });

  it("leads the Codex list with `default` for every role", () => {
    for (const role of ["orchestrator", "worker", "cheap"] as const) {
      const choices = modelChoicesFor("codex", role);
      expect(choices[0]?.value).toBe("default");
      expect(choices[0]?.hint).toContain("suggested for this role");
      expect(choices.map((choice) => choice.value)).toEqual([
        "default",
        "gpt-5.1-codex",
        "gpt-5.1",
        "gpt-5-mini",
      ]);
    }
  });

  it("warns that the named Codex ids depend on the account", () => {
    const named = modelChoicesFor("codex", "worker").filter(
      (choice) => choice.value !== "default",
    );
    expect(named).toHaveLength(3);
    for (const choice of named) {
      expect(choice.hint).toContain("account");
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
    const choices = modelChoicesFor("native", "worker");
    const sonnet = choices.find((choice) => choice.value === "claude-sonnet-5");
    expect(sonnet?.hint).toContain("anthropic");
    expect(sonnet?.hint).toContain("pricing available");

    const openai = choices.find((choice) => choice.value === "gpt-5-mini");
    expect(catalog["gpt-5-mini"]?.pricing).toBeUndefined();
    expect(openai?.hint).toBe("openai");
  });
});

describe("defaultModelsFor", () => {
  it("spreads Claude Code across opus / sonnet / haiku", () => {
    expect(defaultModelsFor("claude-code")).toEqual({
      orchestrator: "opus",
      worker: "sonnet",
      cheap: "haiku",
    });
  });

  it("lets Codex pick for every role", () => {
    expect(defaultModelsFor("codex")).toEqual({
      orchestrator: "default",
      worker: "default",
      cheap: "default",
    });
  });

  it("picks catalog aliases for the native backend", () => {
    const catalog = defaultModelCatalog();
    const models = defaultModelsFor("native");
    expect(models).toEqual({
      orchestrator: "claude-opus-5",
      worker: "claude-sonnet-5",
      cheap: "claude-haiku-4-5",
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
      "worker model (normal complexity): sonnet",
      "worker model (low complexity): haiku",
      "updated: 2026-01-02T03:04:05.000Z",
    ]);
  });
});
