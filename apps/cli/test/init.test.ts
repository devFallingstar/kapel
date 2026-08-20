import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import { KAPEL_CONFIG_VERSION } from "../src/config.js";
import {
  detectValidatorCommands,
  ensureGitignoreEntries,
  GITIGNORE_ENTRIES,
  locateTemplate,
  providerForModel,
  runInit,
  seedModelsInto,
  seedValidatorsInto,
} from "../src/init.js";

describe("locateTemplate", () => {
  it("finds templates/default/.agent by walking up from the real CLI dist layout", async () => {
    // apps/cli/dist/index.js -> apps/cli -> apps -> <repo root>/templates/default/.agent
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
    const fakeEntryDir = path.join(repoRoot, "apps", "cli", "dist");
    const found = await locateTemplate(fakeEntryDir);
    expect(found).toBe(path.join(repoRoot, "templates", "default", ".agent"));
  });

  it("throws a descriptive error when nothing is found within the walk limit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-cli-locate-"));
    try {
      await expect(locateTemplate(dir, 2)).rejects.toThrow(
        /Could not find templates\/default\/\.agent/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("locateTemplate (synthetic layout)", () => {
  let root: string;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("finds a template several levels above a deeply nested entry dir", async () => {
    root = await mkdtemp(path.join(tmpdir(), "agent-cli-synth-"));
    const templateDir = path.join(root, "templates", "default", ".agent");
    await mkdir(templateDir, { recursive: true });
    await writeFile(path.join(templateDir, "config.yaml"), "models: {}\n");

    const entryDir = path.join(root, "apps", "cli", "dist");
    await mkdir(entryDir, { recursive: true });

    const found = await locateTemplate(entryDir);
    expect(found).toBe(templateDir);
  });

  it("gives up beyond maxLevels", async () => {
    root = await mkdtemp(path.join(tmpdir(), "agent-cli-synth-deep-"));
    const templateDir = path.join(root, "templates", "default", ".agent");
    await mkdir(templateDir, { recursive: true });

    // one level deeper than the walk budget allows
    const entryDir = path.join(root, "a", "b", "c");
    await mkdir(entryDir, { recursive: true });

    await expect(locateTemplate(entryDir, 1)).rejects.toThrow();
  });
});

/** A template with the shape the real one has: a `models:` block, then more. */
const TEMPLATE_YAML = [
  "models:",
  "  lead:",
  "    provider: anthropic",
  "    model: claude-opus-5",
  "  complex:",
  "    provider: anthropic",
  "    model: claude-opus-5",
  "  reviewer:",
  "    provider: openai",
  "    model: gpt-5.1",
  "",
  "agents:",
  "  orchestrator: lead",
  "",
  "# a trailing comment the template ships",
  "",
].join("\n");

/** The shape of the real template's commented `validation:` example. */
const TEMPLATE_VALIDATION_YAML = [
  "agents:",
  "  orchestrator: lead",
  "",
  "# Commands that gate a mutating task's success. Each one runs through",
  "# `bash -lc` in the task's own workspace after the worker finishes; if any of",
  "# them fails, the task is reported as failed and its dependents are cancelled.",
  "# Uncomment and adapt to this repository's actual commands.",
  "#",
  "# validation:",
  "#   - name: typecheck",
  "#     command: npm run typecheck",
  "#     timeoutSeconds: 300   # optional, defaults to 600",
  "#   - name: test",
  "#     command: npm test",
].join("\n");

const cc = (model: string) => ({ backend: "claude-code", model }) as const;

function kapelConfig(overrides: Partial<KapelConfig> = {}): KapelConfig {
  return {
    version: KAPEL_CONFIG_VERSION,
    backends: ["claude-code"],
    models: {
      orchestrator: cc("opus"),
      complex: cc("opus"),
      middle: cc("sonnet"),
      low: cc("haiku"),
    },
    updatedAt: 1,
    ...overrides,
  };
}

describe("seedModelsInto", () => {
  it("replaces only the models block, keeping the rest of the template", () => {
    const seeded = seedModelsInto(TEMPLATE_YAML, kapelConfig());
    expect(seeded).toContain("# a trailing comment the template ships");
    expect(seeded).toContain("agents:\n  orchestrator: lead");
    expect(seeded).not.toContain("claude-opus-5");
  });

  it("seeds all five aliases from the three worker tiers", () => {
    const seeded = seedModelsInto(
      TEMPLATE_YAML,
      kapelConfig({
        backends: ["codex"],
        models: {
          orchestrator: { backend: "codex", model: "gpt-5.1" },
          complex: { backend: "codex", model: "gpt-5.1-codex" },
          middle: { backend: "codex", model: "gpt-5.1" },
          low: { backend: "codex", model: "gpt-5-mini" },
        },
      }),
    );
    expect(seeded).toContain(
      [
        "models:",
        "  lead:",
        "    provider: openai",
        "    model: gpt-5.1",
        "    backend: codex",
        "  complex:",
        "    provider: openai",
        "    model: gpt-5.1-codex",
        "    backend: codex",
        "  worker:",
        "    provider: openai",
        "    model: gpt-5.1",
        "    backend: codex",
        "  cheap:",
        "    provider: openai",
        "    model: gpt-5-mini",
        "    backend: codex",
        "  reviewer:",
        "    provider: openai",
        "    model: gpt-5.1",
        "    backend: codex",
      ].join("\n"),
    );
  });

  it("derives each alias's provider from that role's own backend", () => {
    const seeded = seedModelsInto(
      TEMPLATE_YAML,
      kapelConfig({
        backends: ["claude-code", "codex"],
        models: {
          orchestrator: cc("opus"),
          complex: cc("opus"),
          middle: { backend: "codex", model: "gpt-5.1" },
          low: { backend: "codex", model: "default" },
        },
      }),
    );
    // A Claude Code lead and a Codex worker seed honest, different providers.
    expect(seeded).toContain(
      "  lead:\n    provider: anthropic\n    model: opus",
    );
    expect(seeded).toContain(
      "  worker:\n    provider: openai\n    model: gpt-5.1",
    );
    // The `default` sentinel resolves through the role's backend, not a
    // single global one.
    expect(seeded).toContain(
      "  cheap:\n    provider: openai\n    model: default",
    );
  });

  it("tags each alias with the backend that runs it", () => {
    const seeded = seedModelsInto(
      TEMPLATE_YAML,
      kapelConfig({
        backends: ["claude-code", "codex"],
        models: {
          orchestrator: cc("opus"),
          complex: cc("opus"),
          middle: { backend: "codex", model: "gpt-5.1" },
          low: { backend: "native", model: "claude-haiku-4-5" },
        },
      }),
    );
    // The tag is what `MixedBackendWorkerExecutor` routes on, so it has to
    // follow the role rather than one run-wide answer.
    expect(seeded).toContain(
      "  lead:\n    provider: anthropic\n    model: opus\n    backend: claude-code",
    );
    expect(seeded).toContain(
      "  worker:\n    provider: openai\n    model: gpt-5.1\n    backend: codex",
    );
    expect(seeded).toContain(
      "  cheap:\n    provider: anthropic\n    model: claude-haiku-4-5\n    backend: native",
    );
    // The reviewer follows the orchestrator's role, backend included.
    expect(seeded).toContain(
      "  reviewer:\n    provider: anthropic\n    model: opus\n    backend: claude-code",
    );
  });

  it("gives the reviewer the orchestrator's model", () => {
    const seeded = seedModelsInto(TEMPLATE_YAML, kapelConfig());
    expect(seeded).toContain(
      "  reviewer:\n    provider: anthropic\n    model: opus",
    );
  });

  it("leaves a template with no models block alone", () => {
    expect(
      seedModelsInto("agents:\n  orchestrator: lead\n", kapelConfig()),
    ).toBe("agents:\n  orchestrator: lead\n");
  });
});

describe("detectValidatorCommands", () => {
  let dir: string;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  async function makeDir(): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "agent-cli-validators-"));
    return dir;
  }

  it("detects typecheck/test/lint, in that order, and turns bare test into `npm test`", async () => {
    const cwd = await makeDir();
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "biome check .",
          test: "vitest run",
          typecheck: "tsc -b",
          build: "tsc -b --outDir dist",
        },
      }),
    );

    expect(await detectValidatorCommands(cwd)).toEqual([
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm test" },
      { name: "lint", command: "npm run lint" },
    ]);
  });

  it("returns only the scripts that exist", async () => {
    const cwd = await makeDir();
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );

    expect(await detectValidatorCommands(cwd)).toEqual([
      { name: "test", command: "npm test" },
    ]);
  });

  it("returns [] when there is no package.json", async () => {
    const cwd = await makeDir();
    expect(await detectValidatorCommands(cwd)).toEqual([]);
  });

  it("returns [] when package.json has no scripts kapel recognizes", async () => {
    const cwd = await makeDir();
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { build: "tsc -b", dev: "vite" } }),
    );
    expect(await detectValidatorCommands(cwd)).toEqual([]);
  });

  it("returns [] when package.json does not parse as JSON", async () => {
    const cwd = await makeDir();
    await writeFile(path.join(cwd, "package.json"), "{ not json");
    expect(await detectValidatorCommands(cwd)).toEqual([]);
  });
});

describe("seedValidatorsInto", () => {
  it("replaces the commented example with an enabled block, keeping the explanatory comment", () => {
    const seeded = seedValidatorsInto(TEMPLATE_VALIDATION_YAML, [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm test" },
    ]);

    expect(seeded).toContain("# Commands that gate a mutating task's success.");
    expect(seeded).not.toContain("Uncomment and adapt");
    expect(seeded).not.toContain("#   - name: typecheck");
    expect(seeded).toContain(
      [
        "validation:",
        "  - name: typecheck",
        "    command: npm run typecheck",
        "  - name: test",
        "    command: npm test",
      ].join("\n"),
    );
  });

  it("leaves the template untouched when nothing was detected", () => {
    expect(seedValidatorsInto(TEMPLATE_VALIDATION_YAML, [])).toBe(
      TEMPLATE_VALIDATION_YAML,
    );
  });

  it("leaves a template with no uncomment marker untouched", () => {
    expect(
      seedValidatorsInto("agents:\n  orchestrator: lead\n", [
        { name: "test", command: "npm test" },
      ]),
    ).toBe("agents:\n  orchestrator: lead\n");
  });
});

describe("providerForModel", () => {
  it("reads Anthropic out of claude ids and Claude Code aliases", () => {
    expect(providerForModel("claude-opus-5", "native")).toBe("anthropic");
    expect(providerForModel("opus", "claude-code")).toBe("anthropic");
    expect(providerForModel("sonnet", "claude-code")).toBe("anthropic");
    expect(providerForModel("haiku", "claude-code")).toBe("anthropic");
  });

  it("resolves the `default` sentinel by backend, and everything else to OpenAI", () => {
    expect(providerForModel("default", "claude-code")).toBe("anthropic");
    expect(providerForModel("default", "codex")).toBe("openai");
    expect(providerForModel("gpt-5.1-codex", "codex")).toBe("openai");
  });
});

describe("ensureGitignoreEntries", () => {
  let dir: string;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  async function makeDir(): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "agent-cli-gitignore-"));
    return dir;
  }

  it("reports which entries it added, and nothing on a second call", async () => {
    const cwd = await makeDir();

    expect(await ensureGitignoreEntries(cwd)).toEqual([...GITIGNORE_ENTRIES]);
    expect(await ensureGitignoreEntries(cwd)).toEqual([]);
  });

  it("ignores kapel's state and the per-directory config override", async () => {
    expect([...GITIGNORE_ENTRIES]).toEqual([
      ".agent/sessions.db*",
      ".agent/worktrees/",
      ".agent/config.local.json",
    ]);
  });

  it("preserves a file with no trailing newline", async () => {
    const cwd = await makeDir();
    await writeFile(path.join(cwd, ".gitignore"), "dist/", "utf8");

    await ensureGitignoreEntries(cwd);

    const written = await readFile(path.join(cwd, ".gitignore"), "utf8");
    expect(written.split("\n")[0]).toBe("dist/");
    expect(written).toContain(".agent/sessions.db*");
  });
});

describe("runInit", () => {
  let root: string;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  async function setup(configYaml = "models: {}\n"): Promise<{
    templateDir: string;
    entryUrl: string;
    target: string;
  }> {
    root = await mkdtemp(path.join(tmpdir(), "agent-cli-init-"));
    const templateDir = path.join(root, "templates", "default", ".agent");
    await mkdir(path.join(templateDir, "agents"), { recursive: true });
    await writeFile(path.join(templateDir, "config.yaml"), configYaml);
    await writeFile(path.join(templateDir, "agents", "coder.md"), "# coder\n");

    const entryDir = path.join(root, "apps", "cli", "dist");
    await mkdir(entryDir, { recursive: true });
    const entryUrl = pathToFileURL(path.join(entryDir, "index.js")).toString();

    const target = path.join(root, "workspace");
    await mkdir(target, { recursive: true });

    return { templateDir, entryUrl, target };
  }

  it("copies the template into <cwd>/.agent", async () => {
    const { entryUrl, target } = await setup();

    const code = await runInit({ cwd: target, entryUrl });

    expect(code).toBe(0);
    const copied = await readdir(path.join(target, ".agent"));
    expect(copied.sort()).toEqual(["agents", "config.yaml"]);
  });

  it("creates a .gitignore with kapel's state entries when there is none", async () => {
    const { entryUrl, target } = await setup();

    expect(await runInit({ cwd: target, entryUrl })).toBe(0);

    const written = await readFile(path.join(target, ".gitignore"), "utf8");
    for (const entry of GITIGNORE_ENTRIES) expect(written).toContain(entry);
    expect(written.endsWith("\n")).toBe(true);
  });

  it("extends an existing .gitignore without touching what is already in it", async () => {
    const { entryUrl, target } = await setup();
    await writeFile(
      path.join(target, ".gitignore"),
      "node_modules/\ndist/\n",
      "utf8",
    );

    expect(await runInit({ cwd: target, entryUrl })).toBe(0);

    const written = await readFile(path.join(target, ".gitignore"), "utf8");
    expect(written.startsWith("node_modules/\ndist/\n")).toBe(true);
    expect(written).toContain(".agent/sessions.db*");
    expect(written).toContain(".agent/worktrees/");
  });

  it("does not duplicate .gitignore lines when init runs again", async () => {
    const { entryUrl, target } = await setup();

    expect(await runInit({ cwd: target, entryUrl })).toBe(0);
    const first = await readFile(path.join(target, ".gitignore"), "utf8");
    expect(await runInit({ cwd: target, entryUrl, force: true })).toBe(0);
    const second = await readFile(path.join(target, ".gitignore"), "utf8");

    expect(second).toBe(first);
    expect(second.split(".agent/sessions.db*")).toHaveLength(2);
  });

  it("adds only the entry that is missing", async () => {
    const { entryUrl, target } = await setup();
    await writeFile(
      path.join(target, ".gitignore"),
      "  .agent/worktrees/  \n",
      "utf8",
    );

    expect(await runInit({ cwd: target, entryUrl })).toBe(0);

    const written = await readFile(path.join(target, ".gitignore"), "utf8");
    // Matched despite the surrounding whitespace, so it is not written twice.
    expect(written.split(".agent/worktrees/")).toHaveLength(2);
    expect(written).toContain(".agent/sessions.db*");
  });

  it("refuses to overwrite an existing .agent without --force", async () => {
    const { entryUrl, target } = await setup();
    await mkdir(path.join(target, ".agent"));
    await writeFile(path.join(target, ".agent", "sentinel.txt"), "keep-me");

    const code = await runInit({ cwd: target, entryUrl });

    expect(code).toBe(1);
    const contents = await readdir(path.join(target, ".agent"));
    expect(contents).toEqual(["sentinel.txt"]);
  });

  it("fills an existing .agent without deleting what is already in it", async () => {
    const { entryUrl, target } = await setup();
    await mkdir(path.join(target, ".agent"));
    // What the REPL's own chat store leaves behind — automatic onboarding
    // must not take a project's conversation history with it.
    await writeFile(path.join(target, ".agent", "sessions.db"), "keep-me");

    const code = await runInit({ cwd: target, entryUrl, fill: true });

    expect(code).toBe(0);
    const contents = await readdir(path.join(target, ".agent"));
    expect(contents.sort()).toEqual(["agents", "config.yaml", "sessions.db"]);
    expect(
      await readFile(path.join(target, ".agent", "sessions.db"), "utf8"),
    ).toBe("keep-me");
  });

  it("reports through an injected output sink instead of the console", async () => {
    const { entryUrl, target } = await setup();
    const lines: string[] = [];
    const errLines: string[] = [];
    const output = {
      log: (line: string) => lines.push(line),
      error: (line: string) => errLines.push(line),
    };

    expect(await runInit({ cwd: target, entryUrl, output })).toBe(0);
    expect(lines[0]).toBe(`Created ${path.join(target, ".agent")}`);
    expect(errLines).toEqual([]);

    // …and the refusal goes to the same sink's error half.
    expect(await runInit({ cwd: target, entryUrl, output })).toBe(1);
    expect(errLines).toEqual([
      `${path.join(target, ".agent")} already exists. Re-run with --force to overwrite it.`,
    ]);
  });

  it("seeds the project's models from the global configuration", async () => {
    const { entryUrl, target } = await setup(TEMPLATE_YAML);

    const code = await runInit({
      cwd: target,
      entryUrl,
      config: kapelConfig(),
    });

    expect(code).toBe(0);
    const yaml = await readFile(
      path.join(target, ".agent", "config.yaml"),
      "utf8",
    );
    expect(yaml).toBe(
      [
        "models:",
        "  lead:",
        "    provider: anthropic",
        "    model: opus",
        "    backend: claude-code",
        "  complex:",
        "    provider: anthropic",
        "    model: opus",
        "    backend: claude-code",
        "  worker:",
        "    provider: anthropic",
        "    model: sonnet",
        "    backend: claude-code",
        "  cheap:",
        "    provider: anthropic",
        "    model: haiku",
        "    backend: claude-code",
        "  reviewer:",
        "    provider: anthropic",
        "    model: opus",
        "    backend: claude-code",
        "",
        "agents:",
        "  orchestrator: lead",
        "",
        "# a trailing comment the template ships",
        "",
      ].join("\n"),
    );
  });

  it("enables validation: from the target repo's package.json scripts", async () => {
    const { entryUrl, target } = await setup(TEMPLATE_VALIDATION_YAML);
    await writeFile(
      path.join(target, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc -b" } }),
    );

    const code = await runInit({ cwd: target, entryUrl });

    expect(code).toBe(0);
    const yaml = await readFile(
      path.join(target, ".agent", "config.yaml"),
      "utf8",
    );
    expect(yaml).toContain(
      [
        "validation:",
        "  - name: typecheck",
        "    command: npm run typecheck",
        "  - name: test",
        "    command: npm test",
      ].join("\n"),
    );
    expect(yaml).not.toContain("Uncomment and adapt");
  });

  it("leaves the commented validation: example alone when no package.json scripts match", async () => {
    const { entryUrl, target } = await setup(TEMPLATE_VALIDATION_YAML);
    await writeFile(
      path.join(target, "package.json"),
      JSON.stringify({ scripts: { build: "tsc -b" } }),
    );

    const code = await runInit({ cwd: target, entryUrl });

    expect(code).toBe(0);
    const yaml = await readFile(
      path.join(target, ".agent", "config.yaml"),
      "utf8",
    );
    expect(yaml).toBe(TEMPLATE_VALIDATION_YAML);
  });

  it("copies the template verbatim when nothing is configured", async () => {
    const { entryUrl, target } = await setup(TEMPLATE_YAML);

    const code = await runInit({ cwd: target, entryUrl });

    expect(code).toBe(0);
    const yaml = await readFile(
      path.join(target, ".agent", "config.yaml"),
      "utf8",
    );
    expect(yaml).toBe(TEMPLATE_YAML);
  });

  it("overwrites an existing .agent when --force is passed", async () => {
    const { entryUrl, target } = await setup();
    await mkdir(path.join(target, ".agent"));
    await writeFile(path.join(target, ".agent", "sentinel.txt"), "keep-me");

    const code = await runInit({ cwd: target, entryUrl, force: true });

    expect(code).toBe(0);
    const contents = await readdir(path.join(target, ".agent"));
    expect(contents.sort()).toEqual(["agents", "config.yaml"]);
  });
});
