import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { locateTemplate, runInit } from "../src/init.js";

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

describe("runInit", () => {
  let root: string;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  async function setup(): Promise<{
    templateDir: string;
    entryUrl: string;
    target: string;
  }> {
    root = await mkdtemp(path.join(tmpdir(), "agent-cli-init-"));
    const templateDir = path.join(root, "templates", "default", ".agent");
    await mkdir(path.join(templateDir, "agents"), { recursive: true });
    await writeFile(path.join(templateDir, "config.yaml"), "models: {}\n");
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

  it("refuses to overwrite an existing .agent without --force", async () => {
    const { entryUrl, target } = await setup();
    await mkdir(path.join(target, ".agent"));
    await writeFile(path.join(target, ".agent", "sentinel.txt"), "keep-me");

    const code = await runInit({ cwd: target, entryUrl });

    expect(code).toBe(1);
    const contents = await readdir(path.join(target, ".agent"));
    expect(contents).toEqual(["sentinel.txt"]);
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
