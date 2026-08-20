import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import { KAPEL_CONFIG_VERSION } from "../src/config.js";
import type { BackendDetectionProbe, Suspend } from "../src/config-runtime.js";
import {
  checkBackendAvailability,
  codexLoginRunner,
  defaultBackendDetectionProbe,
  delegatedModelOverride,
  detectBackendSetting,
  ensureFirstRunConfig,
  FIRST_RUN_INTRO,
  resetBackendDetection,
  resolveBackendSetting,
  resolveOrchestratorModel,
  resolveRoleModel,
  ttyWizardPrompt,
} from "../src/config-runtime.js";
import type { ConfigWizardDeps } from "../src/config-wizard.js";
import { DEFAULT_MODEL_ALIAS } from "../src/models.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

const cc = (model: string) => ({ backend: "claude-code", model }) as const;

function config(overrides: Partial<KapelConfig> = {}): KapelConfig {
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

/** A single-backend config, spelled the way the wizard would have written it. */
function configOn(backend: "codex" | "native"): KapelConfig {
  const model = backend === "codex" ? "gpt-5.1" : "claude-sonnet-5";
  return {
    version: KAPEL_CONFIG_VERSION,
    backends: [backend],
    models: {
      orchestrator: { backend, model },
      complex: { backend, model },
      middle: { backend, model },
      low: { backend, model },
    },
    updatedAt: 1,
  };
}

// --- precedence -------------------------------------------------------------

describe("resolveBackendSetting", () => {
  it("prefers the flag over the environment, the config and the default", () => {
    expect(
      resolveBackendSetting("codex", { AGENT_BACKEND: "native" }, config()),
    ).toEqual({ value: "codex", source: "flag" });
  });

  it("falls back to AGENT_BACKEND when no flag was passed", () => {
    expect(
      resolveBackendSetting(undefined, { AGENT_BACKEND: "codex" }, config()),
    ).toEqual({ value: "codex", source: "env" });
  });

  it("falls back to the stored config when neither is set", () => {
    expect(resolveBackendSetting(undefined, {}, config())).toEqual({
      value: "claude-code",
      source: "config",
    });
  });

  it("reads the orchestrator role's backend, not the first of the list", () => {
    const mixed = config({
      backends: ["codex", "claude-code"],
      models: {
        orchestrator: cc("opus"),
        complex: cc("opus"),
        middle: { backend: "codex", model: "gpt-5.1" },
        low: { backend: "codex", model: "gpt-5-mini" },
      },
    });
    expect(resolveBackendSetting(undefined, {}, mixed)).toEqual({
      value: "claude-code",
      source: "config",
    });
  });

  it("lets a project override outrank the machine config", () => {
    expect(
      resolveBackendSetting(undefined, {}, config(), {
        backends: ["codex"],
        models: { orchestrator: { backend: "codex", model: "gpt-5.1" } },
      }),
    ).toEqual({ value: "codex", source: "project" });
  });

  it("still loses to the flag and the environment", () => {
    const project = {
      backends: ["codex"] as const,
      models: { orchestrator: { backend: "codex", model: "gpt-5.1" } as const },
    };
    expect(resolveBackendSetting("native", {}, config(), project)).toEqual({
      value: "native",
      source: "flag",
    });
    expect(
      resolveBackendSetting(
        undefined,
        { AGENT_BACKEND: "native" },
        config(),
        project,
      ),
    ).toEqual({ value: "native", source: "env" });
  });

  it("falls back to the built-in default with no config at all", () => {
    expect(resolveBackendSetting(undefined, {}, undefined)).toEqual({
      value: "native",
      source: "default",
    });
  });

  it("treats an empty flag or variable as absent", () => {
    expect(resolveBackendSetting("", { AGENT_BACKEND: "" }, config())).toEqual({
      value: "claude-code",
      source: "config",
    });
  });

  it("rejects an unknown name from either the flag or the environment", () => {
    expect(() => resolveBackendSetting("bogus", {}, undefined)).toThrow(
      /--backend/,
    );
    expect(() =>
      resolveBackendSetting(undefined, { AGENT_BACKEND: "bogus" }, undefined),
    ).toThrow(/claude-code/);
  });
});

// --- backend auto-detection --------------------------------------------------

describe("detectBackendSetting", () => {
  /** Records which probes ran, so the order can be asserted, not assumed. */
  function probe(
    answers: {
      claudeCode?: boolean;
      codex?: boolean;
      nativeCredential?: boolean;
    },
    calls: string[] = [],
  ): BackendDetectionProbe & { readonly calls: string[] } {
    return {
      calls,
      claudeCode: async () => {
        calls.push("claude-code");
        return answers.claudeCode === true;
      },
      codex: async () => {
        calls.push("codex");
        return answers.codex === true;
      },
      nativeCredential: () => {
        calls.push("native");
        return answers.nativeCredential === true;
      },
    };
  }

  beforeEach(() => {
    resetBackendDetection();
  });

  afterEach(() => {
    resetBackendDetection();
  });

  it("never probes when a flag, the environment or the config already chose", async () => {
    const lines: string[] = [];
    const announce = (line: string): void => {
      lines.push(line);
    };

    const cases = [
      { flag: "codex", env: {}, stored: undefined, source: "flag" },
      {
        flag: undefined,
        env: { AGENT_BACKEND: "codex" },
        stored: undefined,
        source: "env",
      },
      {
        flag: undefined,
        env: {},
        stored: configOn("codex"),
        source: "config",
      },
    ] as const;

    for (const { flag, env, stored, source } of cases) {
      resetBackendDetection();
      const spy = probe({ claudeCode: true });
      expect(
        await detectBackendSetting(flag, env, stored, undefined, {
          probe: spy,
          announce,
        }),
      ).toEqual({ value: "codex", source });
      expect(spy.calls).toEqual([]);
    }
    expect(lines).toEqual([]);
  });

  it("picks a logged-in Claude Code before anything else", async () => {
    const lines: string[] = [];
    const spy = probe({ claudeCode: true, codex: true });
    const resolved = await detectBackendSetting(
      undefined,
      {},
      undefined,
      undefined,
      { probe: spy, announce: (line) => lines.push(line) },
    );
    expect(resolved).toEqual({ value: "claude-code", source: "detected" });
    expect(spy.calls).toEqual(["claude-code"]);
    expect(lines).toEqual([
      "backend: claude-code (auto-detected — set one with `kapel config`)",
    ]);
  });

  it("falls to codex when Claude Code is not usable", async () => {
    const spy = probe({ codex: true, nativeCredential: true });
    const resolved = await detectBackendSetting(
      undefined,
      {},
      undefined,
      undefined,
      { probe: spy, announce: () => undefined },
    );
    expect(resolved).toEqual({ value: "codex", source: "detected" });
    expect(spy.calls).toEqual(["claude-code", "codex"]);
  });

  it("picks native when neither CLI is usable but a credential is set", async () => {
    const lines: string[] = [];
    const spy = probe({ nativeCredential: true });
    const resolved = await detectBackendSetting(
      undefined,
      {},
      undefined,
      undefined,
      { probe: spy, announce: (line) => lines.push(line) },
    );
    expect(resolved).toEqual({ value: "native", source: "detected" });
    expect(spy.calls).toEqual(["claude-code", "codex", "native"]);
    expect(lines).toEqual([
      "backend: native (auto-detected — set one with `kapel config`)",
    ]);
  });

  it("keeps the old silent native default when there is nothing to detect", async () => {
    const lines: string[] = [];
    const resolved = await detectBackendSetting(
      undefined,
      {},
      undefined,
      undefined,
      { probe: probe({}), announce: (line) => lines.push(line) },
    );
    expect(resolved).toEqual({ value: "native", source: "default" });
    expect(lines).toEqual([]);
  });

  it("probes once per process, and announces once", async () => {
    const lines: string[] = [];
    const spy = probe({ codex: true });
    for (let i = 0; i < 3; i += 1) {
      expect(
        await detectBackendSetting(undefined, {}, undefined, undefined, {
          probe: spy,
          announce: (line) => lines.push(line),
        }),
      ).toEqual({ value: "codex", source: "detected" });
    }
    expect(spy.calls).toEqual(["claude-code", "codex"]);
    expect(lines).toHaveLength(1);
  });

  it("reads the shell for the default probe's native credential check", () => {
    const { nativeCredential } = defaultBackendDetectionProbe;
    expect(nativeCredential({})).toBe(false);
    expect(nativeCredential({ ANTHROPIC_API_KEY: "sk-x" })).toBe(true);
    expect(nativeCredential({ ANTHROPIC_AUTH_TOKEN: "t" })).toBe(true);
    expect(nativeCredential({ OPENAI_API_KEY: "sk-y" })).toBe(true);
    expect(nativeCredential({ OPENAI_API_KEY: "" })).toBe(false);
  });
});

describe("resolveOrchestratorModel", () => {
  it("prefers the flag over everything else", () => {
    expect(
      resolveOrchestratorModel("gpt-mini", { AGENT_MODEL: "sonnet" }, config()),
    ).toEqual({ value: cc("gpt-mini"), source: "flag" });
  });

  it("falls back to AGENT_MODEL, then the config, then the default", () => {
    expect(
      resolveOrchestratorModel(undefined, { AGENT_MODEL: "sonnet" }, config()),
    ).toEqual({ value: cc("sonnet"), source: "env" });
    expect(resolveOrchestratorModel(undefined, {}, config())).toEqual({
      value: cc("opus"),
      source: "config",
    });
    expect(resolveOrchestratorModel(undefined, {}, undefined)).toEqual({
      value: { backend: "native", model: DEFAULT_MODEL_ALIAS },
      source: "default",
    });
  });

  it("keeps the configured backend when the model came from a flag or the shell", () => {
    const codex = configOn("codex");
    expect(resolveOrchestratorModel("gpt-5.1-codex", {}, codex).value).toEqual({
      backend: "codex",
      model: "gpt-5.1-codex",
    });
    expect(
      resolveOrchestratorModel(undefined, { AGENT_MODEL: "o3" }, codex).value,
    ).toEqual({ backend: "codex", model: "o3" });
  });

  it("reads the per-role model, and its backend, out of the config", () => {
    expect(resolveRoleModel("complex", undefined, {}, config()).value).toEqual(
      cc("opus"),
    );
    expect(resolveRoleModel("middle", undefined, {}, config()).value).toEqual(
      cc("sonnet"),
    );
    expect(resolveRoleModel("low", undefined, {}, config()).value).toEqual(
      cc("haiku"),
    );
  });

  it("prefers a project override for the roles it names, per role", () => {
    const project = {
      backends: ["claude-code", "codex"] as const,
      models: { middle: { backend: "codex", model: "gpt-5.1" } as const },
    };
    expect(
      resolveRoleModel("middle", undefined, {}, config(), project),
    ).toEqual({
      value: { backend: "codex", model: "gpt-5.1" },
      source: "project",
    });
    // Untouched roles still come from the machine config.
    expect(resolveRoleModel("low", undefined, {}, config(), project)).toEqual({
      value: cc("haiku"),
      source: "config",
    });
  });

  it("works off a project override alone, with no machine config at all", () => {
    const project = {
      models: {
        orchestrator: { backend: "codex", model: "gpt-5.1" } as const,
      },
    };
    expect(resolveOrchestratorModel(undefined, {}, undefined, project)).toEqual(
      {
        value: { backend: "codex", model: "gpt-5.1" },
        source: "project",
      },
    );
  });
});

describe("delegatedModelOverride", () => {
  it("forwards a chosen model", () => {
    expect(delegatedModelOverride({ value: "opus", source: "flag" })).toBe(
      "opus",
    );
    expect(delegatedModelOverride({ value: "opus", source: "env" })).toBe(
      "opus",
    );
    expect(delegatedModelOverride({ value: "opus", source: "config" })).toBe(
      "opus",
    );
  });

  it("reads the model out of a whole role pair", () => {
    expect(
      delegatedModelOverride({ value: cc("opus"), source: "config" }),
    ).toBe("opus");
    expect(
      delegatedModelOverride({
        value: { backend: "codex", model: "default" },
        source: "config",
      }),
    ).toBeUndefined();
  });

  it("forwards neither the built-in default nor the `default` sentinel", () => {
    expect(
      delegatedModelOverride({ value: DEFAULT_MODEL_ALIAS, source: "default" }),
    ).toBeUndefined();
    expect(
      delegatedModelOverride({ value: "default", source: "config" }),
    ).toBeUndefined();
  });
});

// --- first-run gating -------------------------------------------------------

interface EnsureCall {
  readonly interactive: boolean;
}

function recordingEnsure(
  calls: EnsureCall[],
  result?: KapelConfig,
): (
  deps: ConfigWizardDeps & { interactive: boolean },
) => Promise<KapelConfig | undefined> {
  return async (deps) => {
    calls.push({ interactive: deps.interactive });
    return result;
  };
}

describe("ensureFirstRunConfig", () => {
  it("asks on a terminal and hands back what the wizard saved", async () => {
    const calls: EnsureCall[] = [];
    const saved = config();
    const resolved = await ensureFirstRunConfig({
      interactive: true,
      ensure: recordingEnsure(calls, saved),
      write: () => undefined,
    });

    expect(calls).toEqual([{ interactive: true }]);
    expect(resolved).toBe(saved);
  });

  it("never asks when there is no terminal", async () => {
    const calls: EnsureCall[] = [];
    await ensureFirstRunConfig({
      interactive: false,
      ensure: recordingEnsure(calls),
      write: () => undefined,
    });
    // The wizard is still consulted — it is the thing that loads the stored
    // config — but never with permission to prompt.
    expect(calls).toEqual([{ interactive: false }]);
  });

  it("never asks under --no-setup, terminal or not", async () => {
    const calls: EnsureCall[] = [];
    await ensureFirstRunConfig({
      interactive: true,
      noSetup: true,
      ensure: recordingEnsure(calls),
      write: () => undefined,
    });
    expect(calls).toEqual([{ interactive: false }]);
  });

  it("announces the first run only when a question is actually asked", async () => {
    const lines: string[] = [];
    const quiet: string[] = [];

    // A configured machine: `ensureKapelConfig` returns without prompting.
    await ensureFirstRunConfig({
      interactive: true,
      ensure: async () => config(),
      write: (line) => quiet.push(line),
    });
    expect(quiet).toEqual([]);

    // A first run: the first `select` triggers the intro, exactly once.
    await ensureFirstRunConfig({
      interactive: true,
      write: (line) => lines.push(line),
      ensure: async (deps) => {
        await deps.prompt.select({ title: "one", choices: [] });
        await deps.prompt.select({ title: "two", choices: [] });
        return undefined;
      },
      io: {
        input: { isTTY: false } as never,
        output: { isTTY: false } as never,
      },
    });
    expect(lines).toEqual([...FIRST_RUN_INTRO]);
  });

  it("routes the wizard's prompts through a given suspend hook", async () => {
    const calls: string[] = [];
    const suspend: Suspend = async (fn) => {
      calls.push("start");
      try {
        return await fn();
      } finally {
        calls.push("end");
      }
    };

    await ensureFirstRunConfig({
      interactive: true,
      write: () => undefined,
      suspend,
      ensure: async (deps) => {
        await deps.prompt.select({ title: "one", choices: [] });
        return undefined;
      },
      io: {
        input: { isTTY: false } as never,
        output: { isTTY: false } as never,
      },
    });

    expect(calls).toEqual(["start", "end"]);
  });
});

// --- select-prompt coexistence (the interactive REPL's persistent readline) -

describe("ttyWizardPrompt", () => {
  const nonTtyIo = {
    input: { isTTY: false } as never,
    output: { isTTY: false } as never,
  };

  it("runs the picker directly with no suspend hook given", async () => {
    const prompt = ttyWizardPrompt(nonTtyIo);
    const result = await prompt.select({
      title: "t",
      choices: [{ value: "a", label: "A" }],
    });
    expect(result).toEqual(["a"]);
  });

  it("routes the picker through a given suspend hook, in order", async () => {
    const calls: string[] = [];
    const suspend: Suspend = async (fn) => {
      calls.push("suspend-start");
      const result = await fn();
      calls.push("suspend-end");
      return result;
    };

    const prompt = ttyWizardPrompt(nonTtyIo, suspend);
    const result = await prompt.select({
      title: "t",
      choices: [{ value: "a", label: "A" }],
    });

    expect(result).toEqual(["a"]);
    expect(calls).toEqual(["suspend-start", "suspend-end"]);
  });
});

describe("checkBackendAvailability", () => {
  it("calls the native backend ready when a credential is in the environment", async () => {
    expect(
      await checkBackendAvailability("native", { ANTHROPIC_API_KEY: "sk-x" }),
    ).toEqual({ ok: true });
    expect(
      await checkBackendAvailability("native", {
        ANTHROPIC_AUTH_TOKEN: "token",
      }),
    ).toEqual({ ok: true });
    expect(
      await checkBackendAvailability("native", { OPENAI_API_KEY: "k" }),
    ).toEqual({ ok: true });
  });

  it("reports the native backend as not ready with no credential at all", async () => {
    const result = await checkBackendAvailability("native", {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no provider credential");
  });
});

describe("codexLoginRunner", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-codex-runner-"));
    originalPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(binDir, { recursive: true, force: true });
  });

  async function installFakeCodex(script: string): Promise<void> {
    const binPath = path.join(binDir, "codex");
    await writeFile(binPath, `#!/bin/sh\n${script}\n`);
    await chmod(binPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  }

  it("suspends around the spawn and reports success after a clean re-probe", async () => {
    await installFakeCodex("exit 0");

    const calls: string[] = [];
    const suspend: Suspend = async (fn) => {
      calls.push("suspend-start");
      try {
        return await fn();
      } finally {
        calls.push("suspend-end");
      }
    };

    const run = codexLoginRunner(suspend, {});
    const result = await run();
    expect(calls).toEqual(["suspend-start", "suspend-end"]);
    expect(result.ok).toBe(true);
  });

  it("reports the spawn error, without a suspend, when codex isn't on PATH", async () => {
    process.env.PATH = binDir; // empty — nothing named "codex"
    const run = codexLoginRunner();
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.detail).toBeDefined();
  });
});
