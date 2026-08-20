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
  ensureGitignoreEntries,
  GITIGNORE_ENTRIES,
  locateTemplate,
  providerForModel,
  runInit,
  seedModelsInto,
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

function kapelConfig(overrides: Partial<KapelConfig> = {}): KapelConfig {
  return {
    version: KAPEL_CONFIG_VERSION,
    backend: "claude-code",
    models: {
      orchestrator: "opus",
      complex: "opus",
      middle: "sonnet",
      low: "haiku",
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
        backend: "codex",
        models: {
          orchestrator: "gpt-5.1",
          complex: "gpt-5.1-codex",
          middle: "gpt-5.1",
          low: "gpt-5-mini",
        },
      }),
    );
    expect(seeded).toContain(
      [
        "models:",
        "  lead:",
        "    provider: openai",
        "    model: gpt-5.1",
        "  complex:",
        "    provider: openai",
        "    model: gpt-5.1-codex",
        "  worker:",
        "    provider: openai",
        "    model: gpt-5.1",
        "  cheap:",
        "    provider: openai",
        "    model: gpt-5-mini",
        "  reviewer:",
        "    provider: openai",
        "    model: gpt-5.1",
      ].join("\n"),
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
        "  complex:",
        "    provider: anthropic",
        "    model: opus",
        "  worker:",
        "    provider: anthropic",
        "    model: sonnet",
        "  cheap:",
        "    provider: anthropic",
        "    model: haiku",
        "  reviewer:",
        "    provider: anthropic",
        "    model: opus",
        "",
        "agents:",
        "  orchestrator: lead",
        "",
        "# a trailing comment the template ships",
        "",
      ].join("\n"),
    );
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
