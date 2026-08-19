import { describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import { KAPEL_CONFIG_VERSION } from "../src/config.js";
import type { Suspend } from "../src/config-runtime.js";
import {
  checkBackendAvailability,
  delegatedModelOverride,
  ensureFirstRunConfig,
  FIRST_RUN_INTRO,
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
    models: { orchestrator: "opus", worker: "sonnet", cheap: "haiku" },
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
    expect(resolveRoleModel("worker", undefined, {}, config()).value).toBe(
      "sonnet",
    );
    expect(resolveRoleModel("cheap", undefined, {}, config()).value).toBe(
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
