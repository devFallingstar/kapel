import type { CodexAvailability } from "@agent/coding-agent";
import { describe, expect, it } from "vitest";
import {
  BACKEND_NAMES,
  codexInstallGuidance,
  codexLoginGuidance,
  codexModelOverride,
  DEFAULT_BACKEND,
  DEFAULT_SANDBOX_MODE,
  fullAutoForSandbox,
  resolveBackendName,
  SANDBOX_MODES,
  validateBackendName,
  validateSandboxMode,
} from "../src/backend.js";

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

describe("validateSandboxMode", () => {
  it("accepts every known sandbox mode", () => {
    for (const mode of SANDBOX_MODES) {
      expect(validateSandboxMode(mode)).toBe(mode);
    }
  });

  it("throws a friendly error for an unknown sandbox mode", () => {
    expect(() => validateSandboxMode("bogus")).toThrow(/--sandbox/);
    expect(() => validateSandboxMode("bogus")).toThrow(
      /read-only, workspace-write, danger-full-access/,
    );
  });

  it("defaults to workspace-write", () => {
    expect(DEFAULT_SANDBOX_MODE).toBe("workspace-write");
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
