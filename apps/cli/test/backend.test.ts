import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ClaudeCodeAvailability,
  CodexAvailability,
} from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKEND_NAMES,
  claudeCodeInstallGuidance,
  claudeCodeLoginGuidance,
  codexInstallGuidance,
  codexLoginGuidance,
  codexModelOverride,
  DEFAULT_BACKEND,
  fullAutoForSandbox,
  isDelegatedBackend,
  resolveBackendName,
  spawnClaudeCodeLogin,
  spawnCodexLogin,
  validateBackendName,
} from "../src/backend.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

describe("resolveBackendName", () => {
  it("prefers an explicit --backend flag over everything else", () => {
    expect(resolveBackendName({ AGENT_BACKEND: "codex" }, "native")).toBe(
      "native",
    );
  });

  it("falls back to AGENT_BACKEND when no flag is given", () => {
    expect(resolveBackendName({ AGENT_BACKEND: "codex" })).toBe("codex");
  });

  it("falls back to the built-in default when neither is set", () => {
    expect(resolveBackendName({})).toBe(DEFAULT_BACKEND);
    expect(DEFAULT_BACKEND).toBe("native");
  });

  it("treats an empty --backend flag as absent", () => {
    expect(resolveBackendName({ AGENT_BACKEND: "codex" }, "")).toBe("codex");
  });

  it("treats an empty AGENT_BACKEND as absent", () => {
    expect(resolveBackendName({ AGENT_BACKEND: "" })).toBe(DEFAULT_BACKEND);
  });
});

describe("validateBackendName", () => {
  it("accepts every known backend name", () => {
    for (const name of BACKEND_NAMES) {
      expect(validateBackendName(name)).toBe(name);
    }
  });

  it("throws a friendly error for an unknown backend", () => {
    expect(() => validateBackendName("bogus")).toThrow(/native, codex/);
    expect(() => validateBackendName("bogus")).toThrow(/--backend/);
  });
});

describe("fullAutoForSandbox", () => {
  it("is true for workspace-write", () => {
    expect(fullAutoForSandbox("workspace-write")).toBe(true);
  });

  it("is true for danger-full-access", () => {
    expect(fullAutoForSandbox("danger-full-access")).toBe(true);
  });

  it("is false for read-only", () => {
    expect(fullAutoForSandbox("read-only")).toBe(false);
  });
});

describe("codexModelOverride", () => {
  it("passes through an explicitly given model", () => {
    expect(codexModelOverride("gpt-5.1")).toBe("gpt-5.1");
  });

  it("is undefined when no --model flag was given", () => {
    expect(codexModelOverride(undefined)).toBeUndefined();
  });

  it("treats an empty string as absent", () => {
    expect(codexModelOverride("")).toBeUndefined();
  });

  it("never folds in the native backend's default alias", () => {
    // `resolveModelAlias({}, undefined)` would return "claude-sonnet-5";
    // codexModelOverride must not reproduce that behavior.
    expect(codexModelOverride(undefined)).not.toBe("claude-sonnet-5");
  });
});

describe("codexInstallGuidance", () => {
  it("mentions the npm install command and codex login", () => {
    const availability: CodexAvailability = {
      installed: false,
      loggedIn: false,
    };
    const message = codexInstallGuidance(availability);
    expect(message).toContain("npm install -g @openai/codex");
    expect(message).toContain("codex login");
  });

  it("includes the availability detail string when present", () => {
    const availability: CodexAvailability = {
      installed: false,
      loggedIn: false,
      detail: "ENOENT: command not found",
    };
    expect(codexInstallGuidance(availability)).toContain(
      "ENOENT: command not found",
    );
  });

  it("omits a detail line when none is given", () => {
    const availability: CodexAvailability = {
      installed: false,
      loggedIn: false,
    };
    expect(codexInstallGuidance(availability).split("\n")).toHaveLength(2);
  });
});

describe("codexLoginGuidance", () => {
  it("mentions codex login and ChatGPT, and not an API key", () => {
    const availability: CodexAvailability = {
      installed: true,
      loggedIn: false,
    };
    const message = codexLoginGuidance(availability);
    expect(message).toContain("codex login");
    expect(message).toContain("ChatGPT");
    expect(message.toLowerCase()).toContain("no openai api key needed");
  });

  it("includes the availability detail string when present", () => {
    const availability: CodexAvailability = {
      installed: true,
      loggedIn: false,
      detail: "not logged in (401)",
    };
    expect(codexLoginGuidance(availability)).toContain("not logged in (401)");
  });
});

describe("isDelegatedBackend", () => {
  it("is true for the CLIs that run the work themselves", () => {
    expect(isDelegatedBackend("codex")).toBe(true);
    expect(isDelegatedBackend("claude-code")).toBe(true);
    expect(isDelegatedBackend("native")).toBe(false);
  });
});

describe("claude code guidance", () => {
  const missing: ClaudeCodeAvailability = {
    installed: false,
    loggedIn: false,
    detail: 'Could not run "claude".',
  };

  it("names the install command and the login step", () => {
    const text = claudeCodeInstallGuidance(missing);
    expect(text).toContain("npm install -g @anthropic-ai/claude-code");
    expect(text).toContain("claude auth login");
    expect(text).toContain('Could not run "claude".');
  });

  it("asks for a login when the CLI is there but nobody is signed in", () => {
    const text = claudeCodeLoginGuidance({ installed: true, loggedIn: false });
    expect(text).toContain("not logged in");
    expect(text).toContain("claude auth login");
    expect(text).toContain("no Anthropic API key needed");
  });
});

describe("spawnCodexLogin", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-codex-login-"));
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

  it("resolves with the exit code of a successful login", async () => {
    await installFakeCodex("exit 0");
    const result = await spawnCodexLogin(binDir);
    expect(result).toEqual({ exitCode: 0 });
  });

  it("resolves with a non-zero exit code when login fails", async () => {
    await installFakeCodex("exit 1");
    const result = await spawnCodexLogin(binDir);
    expect(result).toEqual({ exitCode: 1 });
  });

  it("reports an error when the codex CLI cannot be found on PATH at all", async () => {
    process.env.PATH = binDir; // empty directory — nothing named "codex"
    const result = await spawnCodexLogin(binDir);
    expect("error" in result).toBe(true);
  });

  it("runs `codex login` — not exec, not some other subcommand", async () => {
    const { readFile } = await import("node:fs/promises");
    const argsFile = path.join(binDir, "args");
    await installFakeCodex(`echo "$@" > "${argsFile}"`);
    await spawnCodexLogin(binDir);
    const recorded = (await readFile(argsFile, "utf8")).trim();
    expect(recorded).toBe("login");
  });
});

describe("spawnClaudeCodeLogin", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDir = await mkdtemp(path.join(SCRATCHPAD, "kapel-claude-login-"));
    originalPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(binDir, { recursive: true, force: true });
  });

  async function installFakeClaude(script: string): Promise<void> {
    const binPath = path.join(binDir, "claude");
    await writeFile(binPath, `#!/bin/sh\n${script}\n`);
    await chmod(binPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  }

  it("resolves with the exit code of a successful login", async () => {
    await installFakeClaude("exit 0");
    const result = await spawnClaudeCodeLogin(binDir);
    expect(result).toEqual({ exitCode: 0 });
  });

  it("resolves with a non-zero exit code when login fails", async () => {
    await installFakeClaude("exit 1");
    const result = await spawnClaudeCodeLogin(binDir);
    expect(result).toEqual({ exitCode: 1 });
  });

  it("reports an error when the claude CLI cannot be found on PATH at all", async () => {
    process.env.PATH = binDir; // empty directory — nothing named "claude"
    const result = await spawnClaudeCodeLogin(binDir);
    expect("error" in result).toBe(true);
  });

  it("runs `claude auth login` — not exec, not some other subcommand", async () => {
    const { readFile } = await import("node:fs/promises");
    const argsFile = path.join(binDir, "args");
    await installFakeClaude(`echo "$@" > "${argsFile}"`);
    await spawnClaudeCodeLogin(binDir);
    const recorded = (await readFile(argsFile, "utf8")).trim();
    expect(recorded).toBe("auth login");
  });
});
