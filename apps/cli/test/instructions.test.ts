import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  type LoadedInstructions,
  loadInstructions,
} from "../src/instructions.js";

// Session-provided scratch dir when set (keeps CI and local machines on the
// OS temp dir), same pattern as config.test.ts.
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

let workspace: string;
let configDir: string;
let env: NodeJS.ProcessEnv;
// Cleaned up alongside `workspace`/`configDir`, but created under the real
// home directory so the `~/...` abbreviation has something real to point at.
let homeConfigDir: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(SCRATCHPAD, "kapel-instructions-ws-"));
  configDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-instructions-cfg-"));
  env = { KAPEL_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  if (homeConfigDir !== undefined) {
    await rm(homeConfigDir, { recursive: true, force: true });
    homeConfigDir = undefined;
  }
});

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("loadInstructions", () => {
  it("returns empty text and no sources when nothing exists", () => {
    const result = loadInstructions(workspace, env);
    expect(result).toEqual({ text: "", sources: [] });
  });

  it("loads a lone project-root AGENTS.md", async () => {
    await write(path.join(workspace, "AGENTS.md"), "always run the tests");

    const result = loadInstructions(workspace, env);
    expect(result.sources).toEqual(["AGENTS.md"]);
    expect(result.text).toContain("always run the tests");
    expect(result.text).toContain("AGENTS.md");
  });

  it("loads a lone .agent/AGENTS.md override", async () => {
    await write(path.join(workspace, ".agent", "AGENTS.md"), "kapel-only rule");

    const result = loadInstructions(workspace, env);
    expect(result.sources).toEqual([path.join(".agent", "AGENTS.md")]);
    expect(result.text).toContain("kapel-only rule");
  });

  it("merges all three in machine, project, kapel-override precedence order", async () => {
    await write(path.join(configDir, "AGENTS.md"), "machine rule");
    await write(path.join(workspace, "AGENTS.md"), "project rule");
    await write(
      path.join(workspace, ".agent", "AGENTS.md"),
      "kapel override rule",
    );

    const result = loadInstructions(workspace, env);
    expect(result.sources).toEqual([
      path.join(configDir, "AGENTS.md"),
      "AGENTS.md",
      path.join(".agent", "AGENTS.md"),
    ]);

    const machineAt = result.text.indexOf("machine rule");
    const projectAt = result.text.indexOf("project rule");
    const overrideAt = result.text.indexOf("kapel override rule");
    expect(machineAt).toBeGreaterThanOrEqual(0);
    expect(machineAt).toBeLessThan(projectAt);
    expect(projectAt).toBeLessThan(overrideAt);
  });

  it("skips missing files silently, loading only what exists", async () => {
    await write(path.join(workspace, ".agent", "AGENTS.md"), "only override");

    const result = loadInstructions(workspace, env);
    expect(result.sources).toEqual([path.join(".agent", "AGENTS.md")]);
  });

  it("treats an empty file as absent", async () => {
    await write(path.join(workspace, "AGENTS.md"), "");

    const result = loadInstructions(workspace, env);
    expect(result).toEqual({ text: "", sources: [] });
  });

  it("treats a whitespace-only file as absent", async () => {
    await write(path.join(workspace, "AGENTS.md"), "   \n\t\n  ");

    const result = loadInstructions(workspace, env);
    expect(result).toEqual({ text: "", sources: [] });
  });

  it("skips an unreadable path (a directory named AGENTS.md) rather than throwing", async () => {
    await mkdir(path.join(workspace, "AGENTS.md"), { recursive: true });

    expect(() => loadInstructions(workspace, env)).not.toThrow();
    const result = loadInstructions(workspace, env);
    expect(result).toEqual({ text: "", sources: [] });
  });

  it("truncates combined text over 32 KiB with a single marker line", async () => {
    const huge = "x".repeat(40 * 1024);
    await write(path.join(workspace, "AGENTS.md"), huge);

    const result = loadInstructions(workspace, env);
    const bytes = Buffer.byteLength(result.text, "utf8");
    expect(bytes).toBeLessThanOrEqual(32 * 1024);
    expect(result.text).toContain("[instructions truncated]");
    expect(result.text.endsWith("[instructions truncated]")).toBe(true);
    // Only one marker, however many files went over the cap.
    expect(result.text.split("[instructions truncated]").length - 1).toBe(1);
  });

  it("leaves text under the cap untouched", async () => {
    await write(path.join(workspace, "AGENTS.md"), "short and sweet");

    const result = loadInstructions(workspace, env);
    expect(result.text).not.toContain("truncated");
  });

  it("honours KAPEL_CONFIG_DIR for the machine-level file", async () => {
    const otherConfigDir = await mkdtemp(
      path.join(SCRATCHPAD, "kapel-instructions-other-cfg-"),
    );
    try {
      await write(
        path.join(otherConfigDir, "AGENTS.md"),
        "from the other config dir",
      );
      const otherEnv = {
        KAPEL_CONFIG_DIR: otherConfigDir,
      } as NodeJS.ProcessEnv;

      const result = loadInstructions(workspace, otherEnv);
      expect(result.sources).toEqual([path.join(otherConfigDir, "AGENTS.md")]);
      expect(result.text).toContain("from the other config dir");
    } finally {
      await rm(otherConfigDir, { recursive: true, force: true });
    }
  });

  it("abbreviates a config-dir source under the home directory as ~/...", async () => {
    homeConfigDir = await mkdtemp(
      path.join(homedir(), ".kapel-instructions-test-"),
    );
    await write(path.join(homeConfigDir, "AGENTS.md"), "home-level rule");
    const homeEnv = { KAPEL_CONFIG_DIR: homeConfigDir } as NodeJS.ProcessEnv;

    const result = loadInstructions(workspace, homeEnv);
    expect(result.sources).toHaveLength(1);
    const source = result.sources[0] ?? "";
    expect(source.startsWith(`~${path.sep}`)).toBe(true);
    expect(source).not.toContain(homedir());
  });

  it("wraps each loaded file with a header naming its source", async () => {
    await write(path.join(workspace, "AGENTS.md"), "rule text");

    const result = loadInstructions(workspace, env);
    expect(result.text).toMatch(/AGENTS\.md/);
    expect(result.text).toContain("rule text");
  });
});

describe("composeSystemPrompt", () => {
  it("returns the base prompt unchanged when nothing was loaded", () => {
    const empty: LoadedInstructions = { text: "", sources: [] };
    expect(composeSystemPrompt("BASE PROMPT", empty)).toBe("BASE PROMPT");
  });

  it("appends the instructions after the base prompt when present", () => {
    const loaded: LoadedInstructions = {
      text: "# From AGENTS.md\n\nalways run the tests",
      sources: ["AGENTS.md"],
    };
    const composed = composeSystemPrompt("BASE PROMPT", loaded);
    expect(composed.startsWith("BASE PROMPT")).toBe(true);
    expect(composed).toContain("always run the tests");
    // The base prompt content still appears exactly once, before the
    // appended instructions.
    expect(composed.indexOf("BASE PROMPT")).toBe(0);
  });

  it("is idempotent in shape regardless of how many sources contributed", async () => {
    await write(path.join(workspace, "AGENTS.md"), "project rule");
    await write(path.join(workspace, ".agent", "AGENTS.md"), "override rule");
    const loaded = loadInstructions(workspace, env);
    const composed = composeSystemPrompt("BASE", loaded);
    expect(composed).toContain("project rule");
    expect(composed).toContain("override rule");
    expect(composed.startsWith("BASE")).toBe(true);
  });
});
