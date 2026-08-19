import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import { KAPEL_CONFIG_VERSION } from "../src/config.js";
import type { BackendDetectionProbe, Suspend } from "../src/config-runtime.js";
import {
  checkBackendAvailability,
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

function config(overrides: Partial<KapelConfig> = {}): KapelConfig {
  return {
    version: KAPEL_CONFIG_VERSION,
    backend: "claude-code",
    models: {
      orchestrator: "opus",
      complex: "opus",
      middle: "sonnet",
      low: "haiku",
    },
    updatedAt: 1_700_000_000_000,
    ...overrides,
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
        stored: config({ backend: "codex" }),
        source: "config",
      },
    ] as const;

    for (const { flag, env, stored, source } of cases) {
      resetBackendDetection();
      const spy = probe({ claudeCode: true });
      expect(
        await detectBackendSetting(flag, env, stored, { probe: spy, announce }),
      ).toEqual({ value: "codex", source });
      expect(spy.calls).toEqual([]);
    }
    expect(lines).toEqual([]);
  });

  it("picks a logged-in Claude Code before anything else", async () => {
    const lines: string[] = [];
    const spy = probe({ claudeCode: true, codex: true });
    const resolved = await detectBackendSetting(undefined, {}, undefined, {
      probe: spy,
      announce: (line) => lines.push(line),
    });
    expect(resolved).toEqual({ value: "claude-code", source: "detected" });
    expect(spy.calls).toEqual(["claude-code"]);
    expect(lines).toEqual([
      "backend: claude-code (auto-detected — set one with `kapel config`)",
    ]);
  });

  it("falls to codex when Claude Code is not usable", async () => {
    const spy = probe({ codex: true, nativeCredential: true });
    const resolved = await detectBackendSetting(undefined, {}, undefined, {
      probe: spy,
      announce: () => undefined,
    });
    expect(resolved).toEqual({ value: "codex", source: "detected" });
    expect(spy.calls).toEqual(["claude-code", "codex"]);
  });

  it("picks native when neither CLI is usable but a credential is set", async () => {
    const lines: string[] = [];
    const spy = probe({ nativeCredential: true });
    const resolved = await detectBackendSetting(undefined, {}, undefined, {
      probe: spy,
      announce: (line) => lines.push(line),
    });
    expect(resolved).toEqual({ value: "native", source: "detected" });
    expect(spy.calls).toEqual(["claude-code", "codex", "native"]);
    expect(lines).toEqual([
      "backend: native (auto-detected — set one with `kapel config`)",
    ]);
  });

  it("keeps the old silent native default when there is nothing to detect", async () => {
    const lines: string[] = [];
    const resolved = await detectBackendSetting(undefined, {}, undefined, {
      probe: probe({}),
      announce: (line) => lines.push(line),
    });
    expect(resolved).toEqual({ value: "native", source: "default" });
    expect(lines).toEqual([]);
  });

  it("probes once per process, and announces once", async () => {
    const lines: string[] = [];
    const spy = probe({ codex: true });
    for (let i = 0; i < 3; i += 1) {
      expect(
        await detectBackendSetting(undefined, {}, undefined, {
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
    ).toEqual({ value: "gpt-mini", source: "flag" });
  });

  it("falls back to AGENT_MODEL, then the config, then the default", () => {
    expect(
      resolveOrchestratorModel(undefined, { AGENT_MODEL: "sonnet" }, config()),
    ).toEqual({ value: "sonnet", source: "env" });
    expect(resolveOrchestratorModel(undefined, {}, config())).toEqual({
      value: "opus",
      source: "config",
    });
    expect(resolveOrchestratorModel(undefined, {}, undefined)).toEqual({
      value: DEFAULT_MODEL_ALIAS,
      source: "default",
    });
  });

  it("reads the per-role model out of the config", () => {
    expect(resolveRoleModel("complex", undefined, {}, config()).value).toBe(
      "opus",
    );
    expect(resolveRoleModel("middle", undefined, {}, config()).value).toBe(
      "sonnet",
    );
    expect(resolveRoleModel("low", undefined, {}, config()).value).toBe(
      "haiku",
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
