import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionRuleSet } from "@agent/coding-agent";
import { PermissionEngine } from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PERMISSION_DECISION,
  DEFAULT_PERMISSIONS,
  loadRepoPermissionRules,
  resolvePermissionRules,
} from "../src/permissions.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

describe("DEFAULT_PERMISSIONS", () => {
  it("pre-approves the read-only tools", () => {
    expect(DEFAULT_PERMISSIONS.read_file).toBe("allow");
    expect(DEFAULT_PERMISSIONS.glob).toBe("allow");
    expect(DEFAULT_PERMISSIONS.grep).toBe("allow");
    expect(DEFAULT_PERMISSIONS.git_diff).toBe("allow");
  });

  it("asks before mutating the workspace or shelling out", () => {
    expect(DEFAULT_PERMISSIONS.write_file).toBe("ask");
    expect(DEFAULT_PERMISSIONS.edit_file).toBe("ask");
    expect(DEFAULT_PERMISSIONS.bash).toBe("ask");
  });

  it("treats every MCP tool like the side-effecting built-ins", () => {
    expect(DEFAULT_PERMISSIONS["mcp__*"]).toBe("ask");
  });

  it("covers exactly the seven built-in tools plus the MCP wildcard", () => {
    expect(Object.keys(DEFAULT_PERMISSIONS).sort()).toEqual(
      [
        "bash",
        "edit_file",
        "git_diff",
        "glob",
        "grep",
        "mcp__*",
        "read_file",
        "write_file",
      ].sort(),
    );
  });

  it("defaults unlisted tools to 'ask'", () => {
    expect(DEFAULT_PERMISSION_DECISION).toBe("ask");
  });
});

// --- P1-5: resolvePermissionRules -------------------------------------------

describe("resolvePermissionRules", () => {
  it("returns the defaults unchanged when no layer adds anything", () => {
    expect(resolvePermissionRules(DEFAULT_PERMISSIONS)).toEqual(
      DEFAULT_PERMISSIONS,
    );
    expect(
      resolvePermissionRules(DEFAULT_PERMISSIONS, undefined, undefined),
    ).toEqual(DEFAULT_PERMISSIONS);
  });

  it("a later layer's plain-tool verdict replaces an earlier one", () => {
    const machine: PermissionRuleSet = { edit_file: "allow" };
    const repo: PermissionRuleSet = { edit_file: "deny" };

    expect(resolvePermissionRules(DEFAULT_PERMISSIONS, machine).edit_file).toBe(
      "allow",
    );
    expect(
      resolvePermissionRules(DEFAULT_PERMISSIONS, machine, repo).edit_file,
    ).toBe("deny");
  });

  it("machine < repo: repo wins when both set the same tool", () => {
    const merged = resolvePermissionRules(
      DEFAULT_PERMISSIONS,
      { write_file: "allow" },
      { write_file: "deny" },
    );
    expect(merged.write_file).toBe("deny");
  });

  it("a layer's flat bash verdict replaces DEFAULT_PERMISSIONS.bash entirely", () => {
    expect(DEFAULT_PERMISSIONS.bash).toBe("ask");
    const merged = resolvePermissionRules(DEFAULT_PERMISSIONS, {
      bash: "allow",
    });
    expect(merged.bash).toBe("allow");
  });

  it("a layer's bash pattern map replaces DEFAULT_PERMISSIONS' flat 'ask'", () => {
    const merged = resolvePermissionRules(DEFAULT_PERMISSIONS, {
      bash: { "*": "ask", "git *": "allow" },
    });
    expect(merged.bash).toEqual({ "*": "ask", "git *": "allow" });
  });

  it("merges bash pattern maps key by key across machine and repo layers", () => {
    const merged = resolvePermissionRules(
      DEFAULT_PERMISSIONS,
      { bash: { "*": "ask", "git *": "allow" } },
      { bash: { "rm *": "deny" } },
    );
    expect(merged.bash).toEqual({
      "*": "ask",
      "git *": "allow",
      "rm *": "deny",
    });
  });

  it("a repeated bash pattern key: the later layer's verdict wins", () => {
    const merged = resolvePermissionRules(
      DEFAULT_PERMISSIONS,
      { bash: { "*": "ask", "git *": "allow" } },
      { bash: { "git *": "deny" } },
    );
    expect(merged.bash).toEqual({ "*": "ask", "git *": "deny" });
  });

  it("does not mutate any of the layers it was given", () => {
    const machine: PermissionRuleSet = { bash: { "git *": "allow" } };
    const repo: PermissionRuleSet = { bash: { "rm *": "deny" } };
    resolvePermissionRules(DEFAULT_PERMISSIONS, machine, repo);
    expect(machine).toEqual({ bash: { "git *": "allow" } });
    expect(repo).toEqual({ bash: { "rm *": "deny" } });
  });

  it("supports an arbitrary number of layers, applied in order", () => {
    const merged = resolvePermissionRules(
      DEFAULT_PERMISSIONS,
      { bash: { "*": "ask" } },
      { bash: { "npm *": "allow" } },
      { bash: { "npm *": "deny" } },
    );
    expect(merged.bash).toEqual({ "*": "ask", "npm *": "deny" });
  });
});

// --- P1-5: loadRepoPermissionRules -------------------------------------------

describe("loadRepoPermissionRules", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(SCRATCHPAD, "kapel-repo-perm-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function writeConfigYaml(contents: string): Promise<void> {
    const agentDir = path.join(workspacePath, ".agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "config.yaml"), contents, "utf8");
  }

  it("returns undefined when there is no .agent directory", async () => {
    expect(await loadRepoPermissionRules(workspacePath)).toBeUndefined();
  });

  it("returns undefined when config.yaml has no permission block", async () => {
    await writeConfigYaml("models: {}\n");
    expect(await loadRepoPermissionRules(workspacePath)).toBeUndefined();
  });

  it("reads a permission block with a bash pattern map", async () => {
    await writeConfigYaml(
      [
        "permission:",
        "  bash:",
        '    "*": ask',
        '    "git *": allow',
        "  edit_file: allow",
        "",
      ].join("\n"),
    );

    expect(await loadRepoPermissionRules(workspacePath)).toEqual({
      bash: { "*": "ask", "git *": "allow" },
      edit_file: "allow",
    });
  });

  it("warns to stderr and returns undefined for a malformed config.yaml", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeConfigYaml("permission:\n  bash: not-a-map-or-verdict\n");
      expect(await loadRepoPermissionRules(workspacePath)).toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("permission rules");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// --- MCP tools through the same rule set ------------------------------------

describe("MCP tools in the merged rule set", () => {
  it("keeps the wildcard 'ask' default when no layer mentions MCP", () => {
    const merged = resolvePermissionRules(DEFAULT_PERMISSIONS, undefined, {
      edit_file: "allow",
    });
    expect(
      new PermissionEngine(merged).decisionFor("mcp__github__search_code"),
    ).toBe("ask");
  });

  it("lets a repo layer allow one server and deny another", () => {
    const merged = resolvePermissionRules(DEFAULT_PERMISSIONS, undefined, {
      "mcp__github__*": "allow",
      "mcp__deploy__*": "deny",
    });
    const engine = new PermissionEngine(merged);
    expect(engine.decisionFor("mcp__github__search_code")).toBe("allow");
    expect(engine.decisionFor("mcp__deploy__ship")).toBe("deny");
    expect(engine.decisionFor("mcp__other__thing")).toBe("ask");
  });

  it("lets the repo layer's rule beat the machine layer's for the same pattern", () => {
    const merged = resolvePermissionRules(
      DEFAULT_PERMISSIONS,
      { "mcp__github__*": "allow" },
      { "mcp__github__*": "deny" },
    );
    expect(
      new PermissionEngine(merged).decisionFor("mcp__github__search_code"),
    ).toBe("deny");
  });
});
