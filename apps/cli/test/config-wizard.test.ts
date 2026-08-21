import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KapelBackend, KapelConfig } from "../src/config.js";
import {
  KAPEL_CONFIG_VERSION,
  kapelConfigPath,
  loadKapelConfig,
  saveKapelConfig,
} from "../src/config.js";
import type {
  ConfigWizardDeps,
  SavedWizardConfig,
  WizardPrompt,
} from "../src/config-wizard.js";
import {
  BACKEND_TITLE,
  ensureKapelConfig,
  runConfigWizard,
} from "../src/config-wizard.js";

// Session-provided scratch dir when set (keeps CI and local machines on the
// OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

type SelectOptions = Parameters<WizardPrompt["select"]>[0];

/**
 * A prompt that answers from a script and records what it was asked.
 *
 * A scripted answer is a single value (a role step) or a list (the backend
 * multi-select); `undefined` is a cancellation.
 */
class ScriptedPrompt implements WizardPrompt {
  readonly calls: SelectOptions[] = [];

  constructor(
    private readonly answers: readonly (
      | string
      | readonly string[]
      | undefined
    )[],
  ) {}

  async select(options: SelectOptions): Promise<readonly string[] | undefined> {
    this.calls.push(options);
    const answer = this.answers[this.calls.length - 1];
    if (answer === undefined) return undefined;
    return typeof answer === "string" ? [answer] : answer;
  }

  get titles(): string[] {
    return this.calls.map((call) => call.title);
  }

  get initials(): (string | readonly string[] | undefined)[] {
    return this.calls.map((call) => call.initial);
  }
}

let configDir: string;
let env: NodeJS.ProcessEnv;
let lines: string[];

beforeEach(async () => {
  configDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-wizard-"));
  env = { KAPEL_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  lines = [];
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function deps(
  prompt: WizardPrompt,
  overrides: Partial<ConfigWizardDeps> = {},
): ConfigWizardDeps {
  return {
    prompt,
    write: (line) => lines.push(line),
    env,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

const cc = (model: string) => ({ backend: "claude-code", model }) as const;

const CLAUDE_ANSWERS = [
  ["claude-code"],
  "claude-code:opus",
  "claude-code:opus",
  "claude-code:sonnet",
  "claude-code:haiku",
] as const;

const CLAUDE_MODELS = {
  orchestrator: cc("opus"),
  complex: cc("opus"),
  middle: cc("sonnet"),
  low: cc("haiku"),
};

// --- the happy path ---------------------------------------------------------

describe("runConfigWizard", () => {
  it("asks the five questions in order", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt));
    expect(prompt.titles).toEqual([
      BACKEND_TITLE,
      "Main orchestrator model",
      "Worker model — most complex coding tasks",
      "Worker model — routine, non-trivial tasks",
      "Worker model — small, single-function tasks",
    ]);
  });

  it("asks the backend question as a required multi-select", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt));
    const step = prompt.calls[0];
    expect(step?.multi).toBe(true);
    expect(step?.required).toBe(true);
    expect(step?.title).toContain("space to toggle");
    expect(step?.footer).toContain("at least one");
    // The role steps stay single-select.
    expect(prompt.calls[1]?.multi).toBeUndefined();
  });

  it("returns and saves the answers", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await runConfigWizard(deps(prompt));
    expect(config).toEqual({
      version: KAPEL_CONFIG_VERSION,
      backends: ["claude-code"],
      models: CLAUDE_MODELS,
      updatedAt: 1_700_000_000_000,
    });
    expect(await loadKapelConfig(env)).toEqual(config);
  });

  it("prints the summary and where it was written", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt));
    expect(lines).toContain("backends: Claude Code (claude-code)");
    expect(lines).toContain("orchestrator model: opus (claude-code)");
    expect(lines).toContain(`saved to ${kapelConfigPath(env)}`);
  });

  it("offers each backend its own model list", async () => {
    const prompt = new ScriptedPrompt([
      ["codex"],
      "codex:gpt-5.1",
      "codex:default",
      "codex:default",
      "codex:default",
    ]);
    const config = await runConfigWizard(deps(prompt));
    expect(config?.models.orchestrator).toEqual({
      backend: "codex",
      model: "gpt-5.1",
    });
    const modelStep = prompt.calls[1];
    // `orchestrator`'s pinned block (Sol 5.6, Terra 5.6) leads, then every
    // other named/catalog id sorted alphabetically, then `default` last (see
    // `PINNED_MODELS_BY_ROLE` and `codexChoices` in `src/config.ts`).
    expect(modelStep?.choices.map((choice) => choice.value)).toEqual([
      "codex:sol-5.6",
      "codex:terra-5.6",
      "codex:gpt-5-mini",
      "codex:gpt-5.1",
      "codex:gpt-5.1-codex",
      "codex:luna-5.6",
      "codex:default",
    ]);
  });

  it("offers the union of every selected backend, and stores each answer's backend", async () => {
    const prompt = new ScriptedPrompt([
      ["claude-code", "codex"],
      "claude-code:opus",
      "claude-code:opus",
      "codex:gpt-5.1",
      "codex:gpt-5-mini",
    ]);
    const config = await runConfigWizard(deps(prompt));
    expect(config?.backends).toEqual(["claude-code", "codex"]);
    expect(config?.models).toEqual({
      orchestrator: cc("opus"),
      complex: cc("opus"),
      middle: { backend: "codex", model: "gpt-5.1" },
      low: { backend: "codex", model: "gpt-5-mini" },
    });

    const values = prompt.calls[1]?.choices.map((choice) => choice.value) ?? [];
    // `claude-code:opus` no longer exists as its own row — `opus` and
    // `claude-opus-5` are the same model, and the wizard now shows only the
    // full id (see `claudeCodeChoices` in `src/config.ts`).
    expect(values).toContain("claude-code:claude-opus-5");
    expect(values).not.toContain("claude-code:opus");
    expect(values).toContain("codex:gpt-5.1-codex");
    expect(await loadKapelConfig(env)).toEqual(config);
  });

  it("names the backend beside every non-pinned model once several are selected", async () => {
    const prompt = new ScriptedPrompt([
      ["claude-code", "codex"],
      "claude-code:opus",
      "claude-code:opus",
      "codex:gpt-5.1",
      "codex:gpt-5-mini",
    ]);
    await runConfigWizard(deps(prompt));
    const choices = prompt.calls[1]?.choices ?? [];
    expect(
      choices.find((choice) => choice.value === "codex:gpt-5.1")?.hint,
    ).toContain("Codex · ");
    expect(
      choices.find((choice) => choice.value === "claude-code:claude-sonnet-5")
        ?.hint,
    ).toContain("Claude Code · ");
  });

  it("defaults the first step to Claude Code with no stored config", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt));
    expect(prompt.initials[0]).toEqual(["claude-code"]);
  });

  it("seeds every step from the current config when re-run", async () => {
    const current: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["codex"],
      models: {
        orchestrator: { backend: "codex", model: "gpt-5.1-codex" },
        complex: { backend: "codex", model: "gpt-5.1-codex" },
        middle: { backend: "codex", model: "gpt-5.1" },
        low: { backend: "codex", model: "gpt-5-mini" },
      },
      updatedAt: 5,
    };
    const prompt = new ScriptedPrompt([
      ["codex"],
      "codex:gpt-5.1-codex",
      "codex:gpt-5.1-codex",
      "codex:gpt-5.1",
      "codex:gpt-5-mini",
    ]);
    await runConfigWizard(deps(prompt, { current }));
    expect(prompt.initials).toEqual([
      ["codex"],
      "codex:gpt-5.1-codex",
      "codex:gpt-5.1-codex",
      "codex:gpt-5.1",
      "codex:gpt-5-mini",
    ]);
  });

  it("pre-ticks every backend a multi-backend config already has", async () => {
    const current: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["claude-code", "codex"],
      models: {
        ...CLAUDE_MODELS,
        middle: { backend: "codex", model: "gpt-5.1" },
      },
      updatedAt: 5,
    };
    const prompt = new ScriptedPrompt([
      ["claude-code", "codex"],
      "claude-code:opus",
      "claude-code:opus",
      "codex:gpt-5.1",
      "claude-code:haiku",
    ]);
    await runConfigWizard(deps(prompt, { current }));
    expect(prompt.initials[0]).toEqual(["claude-code", "codex"]);
    expect(prompt.initials[3]).toBe("codex:gpt-5.1");
  });

  it("seeds the steps from a migrated version-1 config", async () => {
    // A v1 file on disk: `complex` and `middle` both migrate from `worker`.
    await writeFile(
      kapelConfigPath(env),
      JSON.stringify({
        version: 1,
        backend: "claude-code",
        models: { orchestrator: "opus", worker: "sonnet", cheap: "haiku" },
        updatedAt: 5,
      }),
      "utf8",
    );
    const current = await loadKapelConfig(env);
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt, { current }));
    // Every stored alias is canonicalized to the full id before it is
    // checked against the (alias-free) choice list — see `canonicalRoleModel`
    // and `initialFor` in `src/config-wizard.ts`.
    expect(prompt.initials).toEqual([
      ["claude-code"],
      "claude-code:claude-opus-5",
      "claude-code:claude-sonnet-5",
      "claude-code:claude-sonnet-5",
      "claude-code:claude-haiku-4-5",
    ]);
  });

  it("falls back to the suggested default when the old model is not on offer", async () => {
    const current: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["codex"],
      models: {
        orchestrator: { backend: "codex", model: "gpt-5.1-codex" },
        complex: { backend: "codex", model: "gpt-5.1-codex" },
        middle: { backend: "codex", model: "gpt-5.1" },
        low: { backend: "codex", model: "gpt-5-mini" },
      },
      updatedAt: 5,
    };
    // Switching to claude-code: none of the stored pairs exist in that list.
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt, { current }));
    // The fallback default is canonicalized too, same as a stored answer.
    expect(prompt.initials.slice(1)).toEqual([
      "claude-code:claude-opus-5",
      "claude-code:claude-opus-5",
      "claude-code:claude-sonnet-5",
      "claude-code:claude-haiku-4-5",
    ]);
  });

  it("does not touch disk when save is false", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await runConfigWizard(deps(prompt, { save: false }));
    expect(config?.backends).toEqual(["claude-code"]);
    expect(await loadKapelConfig(env)).toBeUndefined();
    expect(lines.some((line) => line.startsWith("saved to"))).toBe(false);
  });

  it("saves through a given writeConfig instead of the machine file", async () => {
    const saved: SavedWizardConfig[] = [];
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(
      deps(prompt, {
        writeConfig: async (config) => {
          saved.push(config);
          return "/somewhere/.agent/config.local.json";
        },
      }),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]?.backends).toEqual(["claude-code"]);
    expect(saved[0]?.models).toEqual(CLAUDE_MODELS);
    expect(lines).toContain("saved to /somewhere/.agent/config.local.json");
    expect(await loadKapelConfig(env)).toBeUndefined();
  });

  it("carries a hand-edited permission block through a re-save", async () => {
    const current: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backends: ["claude-code"],
      models: CLAUDE_MODELS,
      updatedAt: 1,
      permission: { edit_file: "allow" },
    };
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt, { current }));
    expect((await loadKapelConfig(env))?.permission).toEqual({
      edit_file: "allow",
    });
  });
});

// --- cancelling -------------------------------------------------------------

describe("runConfigWizard cancellation", () => {
  for (const step of [0, 1, 2, 3, 4]) {
    it(`stops without saving when the user cancels at step ${step + 1}`, async () => {
      const answers = CLAUDE_ANSWERS.map((answer, index) =>
        index === step ? undefined : answer,
      );
      const prompt = new ScriptedPrompt(answers);
      expect(await runConfigWizard(deps(prompt))).toBeUndefined();
      expect(prompt.calls).toHaveLength(step + 1);
      expect(lines).toEqual(["setup cancelled"]);
      expect(await loadKapelConfig(env)).toBeUndefined();
    });
  }

  it("treats an empty backend selection as a cancellation", async () => {
    const prompt = new ScriptedPrompt([[]]);
    expect(await runConfigWizard(deps(prompt))).toBeUndefined();
    expect(prompt.calls).toHaveLength(1);
    expect(lines).toEqual(["setup cancelled"]);
    expect(await loadKapelConfig(env)).toBeUndefined();
  });
});

// --- backend availability ---------------------------------------------------

describe("runConfigWizard backend check", () => {
  it("stays quiet when the backend checks out", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const seen: KapelBackend[] = [];
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async (backend) => {
          seen.push(backend);
          return { ok: true };
        },
      }),
    );
    expect(seen).toEqual(["claude-code"]);
    expect(lines.some((line) => line.startsWith("warning:"))).toBe(false);
  });

  it("probes every selected backend, in order", async () => {
    const prompt = new ScriptedPrompt([
      ["codex", "claude-code"],
      "codex:default",
      "codex:default",
      "codex:default",
      "codex:default",
    ]);
    const seen: KapelBackend[] = [];
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async (backend) => {
          seen.push(backend);
          return { ok: true };
        },
      }),
    );
    expect(seen).toEqual(["codex", "claude-code"]);
  });

  it("warns with the detail and the fix, then carries on", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, detail: "claude not on PATH" }),
      }),
    );
    expect(lines[0]).toContain("claude not on PATH");
    expect(lines[1]).toContain("npm install -g @anthropic-ai/claude-code");
    expect(lines[1]).toContain("claude auth login");
    expect(prompt.calls).toHaveLength(5);
    expect(config?.backends).toEqual(["claude-code"]);
    expect(await loadKapelConfig(env)).toEqual(config);
  });

  it("gives the Codex fix when Codex is the one missing", async () => {
    const prompt = new ScriptedPrompt([
      ["codex"],
      "codex:default",
      "codex:default",
      "codex:default",
      "codex:default",
    ]);
    await runConfigWizard(
      deps(prompt, { checkBackend: async () => ({ ok: false }) }),
    );
    expect(lines[0]).toBe("warning: codex does not look ready");
    expect(lines[1]).toContain("npm install -g @openai/codex");
    expect(lines[1]).toContain("codex login");
  });

  it("treats a probe that throws as a failed check", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => {
          throw new Error("spawn EACCES");
        },
      }),
    );
    expect(lines[0]).toContain("spawn EACCES");
    expect(config?.backends).toEqual(["claude-code"]);
  });
});

// --- codex: installed but not logged in — the login offer -------------------

describe("runConfigWizard codex login offer", () => {
  const CODEX_ANSWERS_AFTER_CONFIRM = [
    "codex:default",
    "codex:default",
    "codex:default",
    "codex:default",
  ] as const;

  it("skips the offer entirely when nothing can run codex login, same as before", async () => {
    const prompt = new ScriptedPrompt([
      ["codex"],
      ...CODEX_ANSWERS_AFTER_CONFIRM,
    ]);
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
      }),
    );
    // No confirm question was inserted — the five original calls stand.
    expect(prompt.calls).toHaveLength(5);
    expect(
      lines.some((line) => line.includes("npm install -g @openai/codex")),
    ).toBe(true);
  });

  it("offers to run codex login, and reports success when it re-probes clean", async () => {
    const prompt = new ScriptedPrompt([
      ["codex"],
      "yes",
      ...CODEX_ANSWERS_AFTER_CONFIRM,
    ]);
    let loginCalls = 0;
    const config = await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
        runCodexLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      }),
    );
    expect(prompt.calls[1]?.title).toBe(
      "Codex is installed but not logged in — run `codex login` now?",
    );
    expect(loginCalls).toBe(1);
    expect(lines).toContain("codex: now logged in.");
    expect(
      lines.some((line) => line.includes("npm install -g @openai/codex")),
    ).toBe(false);
    expect(config?.backends).toEqual(["codex"]);
  });

  it("declines to run codex login and falls back to the fix line", async () => {
    const prompt = new ScriptedPrompt([
      ["codex"],
      "no",
      ...CODEX_ANSWERS_AFTER_CONFIRM,
    ]);
    let loginCalls = 0;
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
        runCodexLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      }),
    );
    expect(loginCalls).toBe(0);
    expect(
      lines.some((line) => line.includes("npm install -g @openai/codex")),
    ).toBe(true);
  });

  it("reports a login attempt that did not end up logged in, then falls back to the fix line", async () => {
    const prompt = new ScriptedPrompt([
      ["codex"],
      "yes",
      ...CODEX_ANSWERS_AFTER_CONFIRM,
    ]);
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
        runCodexLogin: async () => ({ ok: false, detail: "still no token" }),
      }),
    );
    expect(lines).toContain("codex: still not logged in: still no token");
    expect(
      lines.some((line) => line.includes("npm install -g @openai/codex")),
    ).toBe(true);
  });
});

// --- claude-code: installed but not logged in — the login offer ------------

describe("runConfigWizard claude-code login offer", () => {
  it("skips the offer entirely when nothing can run claude auth login, same as before", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
      }),
    );
    // No confirm question was inserted — the five original calls stand.
    expect(prompt.calls).toHaveLength(5);
    expect(
      lines.some((line) =>
        line.includes("npm install -g @anthropic-ai/claude-code"),
      ),
    ).toBe(true);
  });

  it("offers to run claude auth login, and reports success when it re-probes clean", async () => {
    const prompt = new ScriptedPrompt([
      ["claude-code"],
      "yes",
      ...CLAUDE_ANSWERS.slice(1),
    ]);
    let loginCalls = 0;
    const config = await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
        runClaudeCodeLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      }),
    );
    expect(prompt.calls[1]?.title).toBe(
      "Claude Code is installed but not logged in — run `claude auth login` now?",
    );
    expect(loginCalls).toBe(1);
    expect(lines).toContain("claude-code: now logged in.");
    expect(
      lines.some((line) =>
        line.includes("npm install -g @anthropic-ai/claude-code"),
      ),
    ).toBe(false);
    expect(config?.backends).toEqual(["claude-code"]);
  });

  it("declines to run claude auth login and falls back to the fix line", async () => {
    const prompt = new ScriptedPrompt([
      ["claude-code"],
      "no",
      ...CLAUDE_ANSWERS.slice(1),
    ]);
    let loginCalls = 0;
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
        runClaudeCodeLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      }),
    );
    expect(loginCalls).toBe(0);
    expect(
      lines.some((line) =>
        line.includes("npm install -g @anthropic-ai/claude-code"),
      ),
    ).toBe(true);
  });

  it("reports a login attempt that did not end up logged in, then falls back to the fix line", async () => {
    const prompt = new ScriptedPrompt([
      ["claude-code"],
      "yes",
      ...CLAUDE_ANSWERS.slice(1),
    ]);
    await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, installed: true }),
        runClaudeCodeLogin: async () => ({
          ok: false,
          detail: "still no token",
        }),
      }),
    );
    expect(lines).toContain("claude-code: still not logged in: still no token");
    expect(
      lines.some((line) =>
        line.includes("npm install -g @anthropic-ai/claude-code"),
      ),
    ).toBe(true);
  });
});

// --- first-run detection ----------------------------------------------------

describe("ensureKapelConfig", () => {
  it("returns the stored config without asking anything", async () => {
    await saveKapelConfig(
      {
        backends: ["native"],
        models: {
          orchestrator: { backend: "native", model: "claude-opus-5" },
          complex: { backend: "native", model: "claude-opus-5" },
          middle: { backend: "native", model: "claude-sonnet-5" },
          low: { backend: "native", model: "claude-haiku-4-5" },
        },
        updatedAt: 42,
      },
      env,
    );
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await ensureKapelConfig({
      ...deps(prompt),
      interactive: true,
    });
    expect(config?.backends).toEqual(["native"]);
    expect(config?.updatedAt).toBe(42);
    expect(prompt.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("runs the wizard on a fresh machine at a terminal", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await ensureKapelConfig({
      ...deps(prompt),
      interactive: true,
    });
    expect(prompt.calls).toHaveLength(5);
    expect(config?.models.complex).toEqual(cc("opus"));
    expect(config?.models.middle).toEqual(cc("sonnet"));
    expect(config?.models.low).toEqual(cc("haiku"));
    expect(await loadKapelConfig(env)).toEqual(config);
  });

  it("returns undefined rather than blocking a non-interactive run", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await ensureKapelConfig({
      ...deps(prompt),
      interactive: false,
    });
    expect(config).toBeUndefined();
    expect(prompt.calls).toEqual([]);
    expect(await loadKapelConfig(env)).toBeUndefined();
  });
});
