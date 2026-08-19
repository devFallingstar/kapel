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
import type { ConfigWizardDeps, WizardPrompt } from "../src/config-wizard.js";
import { ensureKapelConfig, runConfigWizard } from "../src/config-wizard.js";

// Session-provided scratch dir when set (keeps CI and local machines on the
// OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

type SelectOptions = Parameters<WizardPrompt["select"]>[0];

/** A prompt that answers from a script and records what it was asked. */
class ScriptedPrompt implements WizardPrompt {
  readonly calls: SelectOptions[] = [];

  constructor(private readonly answers: readonly (string | undefined)[]) {}

  async select(options: SelectOptions): Promise<readonly string[] | undefined> {
    this.calls.push(options);
    const answer = this.answers[this.calls.length - 1];
    return answer === undefined ? undefined : [answer];
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

const CLAUDE_ANSWERS = [
  "claude-code",
  "opus",
  "opus",
  "sonnet",
  "haiku",
] as const;

// --- the happy path ---------------------------------------------------------

describe("runConfigWizard", () => {
  it("asks the five questions in order", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt));
    expect(prompt.titles).toEqual([
      "Which coding backend should kapel use?",
      "Main orchestrator model",
      "Worker model — most complex coding tasks",
      "Worker model — everyday tasks",
      "Worker model — small, single-function tasks",
    ]);
  });

  it("returns and saves the answers", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await runConfigWizard(deps(prompt));
    expect(config).toEqual({
      version: KAPEL_CONFIG_VERSION,
      backend: "claude-code",
      models: {
        orchestrator: "opus",
        complex: "opus",
        middle: "sonnet",
        low: "haiku",
      },
      updatedAt: 1_700_000_000_000,
    });
    expect(await loadKapelConfig(env)).toEqual(config);
  });

  it("prints the summary and where it was written", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt));
    expect(lines).toContain("backend: Claude Code (claude-code)");
    expect(lines).toContain("orchestrator model: opus");
    expect(lines).toContain(`saved to ${kapelConfigPath(env)}`);
  });

  it("offers each backend its own model list", async () => {
    const prompt = new ScriptedPrompt([
      "codex",
      "gpt-5.1",
      "default",
      "default",
      "default",
    ]);
    const config = await runConfigWizard(deps(prompt));
    expect(config?.models.orchestrator).toBe("gpt-5.1");
    const modelStep = prompt.calls[1];
    // `default` leads; the rest is every named/catalog id sorted
    // alphabetically (see `codexChoices` in `src/config.ts`).
    expect(modelStep?.choices.map((choice) => choice.value)).toEqual([
      "default",
      "gpt-5-mini",
      "gpt-5.1",
      "gpt-5.1-codex",
    ]);
  });

  it("defaults the first step to Claude Code with no stored config", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt));
    expect(prompt.initials[0]).toBe("claude-code");
  });

  it("seeds every step from the current config when re-run", async () => {
    const current: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backend: "codex",
      models: {
        orchestrator: "gpt-5.1-codex",
        complex: "gpt-5.1-codex",
        middle: "gpt-5.1",
        low: "gpt-5-mini",
      },
      updatedAt: 5,
    };
    const prompt = new ScriptedPrompt([
      "codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex",
      "gpt-5.1",
      "gpt-5-mini",
    ]);
    await runConfigWizard(deps(prompt, { current }));
    expect(prompt.initials).toEqual([
      "codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex",
      "gpt-5.1",
      "gpt-5-mini",
    ]);
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
    expect(prompt.initials).toEqual([
      "claude-code",
      "opus",
      "sonnet",
      "sonnet",
      "haiku",
    ]);
  });

  it("falls back to the backend default when the old model is not on offer", async () => {
    const current: KapelConfig = {
      version: KAPEL_CONFIG_VERSION,
      backend: "codex",
      models: {
        orchestrator: "gpt-5.1-codex",
        complex: "gpt-5.1-codex",
        middle: "gpt-5.1",
        low: "gpt-5-mini",
      },
      updatedAt: 5,
    };
    // Switching to claude-code: none of the stored ids exist in that list.
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    await runConfigWizard(deps(prompt, { current }));
    expect(prompt.initials.slice(1)).toEqual([
      "opus",
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  it("does not touch disk when save is false", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await runConfigWizard(deps(prompt, { save: false }));
    expect(config?.backend).toBe("claude-code");
    expect(await loadKapelConfig(env)).toBeUndefined();
    expect(lines.some((line) => line.startsWith("saved to"))).toBe(false);
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

  it("warns with the detail and the fix, then carries on", async () => {
    const prompt = new ScriptedPrompt(CLAUDE_ANSWERS);
    const config = await runConfigWizard(
      deps(prompt, {
        checkBackend: async () => ({ ok: false, detail: "claude not on PATH" }),
      }),
    );
    expect(lines[0]).toContain("claude not on PATH");
    expect(lines[1]).toContain("npm install -g @anthropic-ai/claude-code");
    expect(lines[1]).toContain("log in");
    expect(prompt.calls).toHaveLength(5);
    expect(config?.backend).toBe("claude-code");
    expect(await loadKapelConfig(env)).toEqual(config);
  });

  it("gives the Codex fix when Codex is the one missing", async () => {
    const prompt = new ScriptedPrompt([
      "codex",
      "default",
      "default",
      "default",
      "default",
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
    expect(config?.backend).toBe("claude-code");
  });
});

// --- first-run detection ----------------------------------------------------

describe("ensureKapelConfig", () => {
  it("returns the stored config without asking anything", async () => {
    await saveKapelConfig(
      {
        backend: "native",
        models: {
          orchestrator: "claude-opus-5",
          complex: "claude-opus-5",
          middle: "claude-sonnet-5",
          low: "claude-haiku-4-5",
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
    expect(config?.backend).toBe("native");
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
    expect(config?.models.complex).toBe("opus");
    expect(config?.models.middle).toBe("sonnet");
    expect(config?.models.low).toBe("haiku");
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
