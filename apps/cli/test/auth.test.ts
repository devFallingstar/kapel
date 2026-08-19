import { describe, expect, it, vi } from "vitest";
import type { ExecFileFn } from "../src/auth.js";
import { resolveAnthropicCredential } from "../src/auth.js";

function stubExecFile(
  impl: (
    file: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>,
): ExecFileFn {
  return vi.fn(async (file, args) => impl(file, args));
}

describe("resolveAnthropicCredential", () => {
  it("prefers a non-empty ANTHROPIC_API_KEY over everything else", async () => {
    const execFile = stubExecFile(() => {
      throw new Error("should not be called");
    });
    const credential = await resolveAnthropicCredential(
      { ANTHROPIC_API_KEY: "sk-a", ANTHROPIC_AUTH_TOKEN: "t-env" },
      { execFile },
    );
    expect(credential).toEqual({ kind: "api-key", apiKey: "sk-a" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back to a non-empty ANTHROPIC_AUTH_TOKEN when no api key is set", async () => {
    const execFile = stubExecFile(() => {
      throw new Error("should not be called");
    });
    const credential = await resolveAnthropicCredential(
      { ANTHROPIC_AUTH_TOKEN: "t-env" },
      { execFile },
    );
    expect(credential).toEqual({
      kind: "auth-token",
      authToken: "t-env",
      source: "env",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("treats an empty-string ANTHROPIC_API_KEY as unset and falls through to the auth token", async () => {
    const credential = await resolveAnthropicCredential(
      { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "t-env" },
      {
        execFile: stubExecFile(() =>
          Promise.resolve({ stdout: "", stderr: "" }),
        ),
      },
    );
    expect(credential).toEqual({
      kind: "auth-token",
      authToken: "t-env",
      source: "env",
    });
  });

  it("treats an empty-string ANTHROPIC_AUTH_TOKEN as unset and falls through to the oauth profile", async () => {
    const execFile = stubExecFile((file, args) => {
      expect(file).toBe("ant");
      expect(args).toEqual(["auth", "print-credentials", "--access-token"]);
      return Promise.resolve({ stdout: "sk-ant-oat-xyz\n", stderr: "" });
    });
    const credential = await resolveAnthropicCredential(
      { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
      { execFile },
    );
    expect(credential).toEqual({
      kind: "auth-token",
      authToken: "sk-ant-oat-xyz",
      source: "oauth-profile",
    });
  });

  it("resolves an oauth-profile credential from `ant auth print-credentials --access-token`", async () => {
    const execFile = stubExecFile(() =>
      Promise.resolve({ stdout: "sk-ant-oat-xyz", stderr: "" }),
    );
    const credential = await resolveAnthropicCredential({}, { execFile });
    expect(credential).toEqual({
      kind: "auth-token",
      authToken: "sk-ant-oat-xyz",
      source: "oauth-profile",
    });
  });

  it("returns undefined when ant is not installed or the command fails", async () => {
    const execFile = stubExecFile(() =>
      Promise.reject(new Error("spawn ant ENOENT")),
    );
    const credential = await resolveAnthropicCredential({}, { execFile });
    expect(credential).toBeUndefined();
  });

  it("returns undefined when the command prints nothing", async () => {
    const execFile = stubExecFile(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );
    const credential = await resolveAnthropicCredential({}, { execFile });
    expect(credential).toBeUndefined();
  });

  it("returns undefined when the command prints more than one line", async () => {
    const execFile = stubExecFile(() =>
      Promise.resolve({ stdout: "sk-ant-oat-xyz\nextra\n", stderr: "" }),
    );
    const credential = await resolveAnthropicCredential({}, { execFile });
    expect(credential).toBeUndefined();
  });

  it("skips the oauth-profile fallback entirely when allowProfile is false", async () => {
    const execFile = stubExecFile(() => {
      throw new Error("should not be called");
    });
    const credential = await resolveAnthropicCredential(
      {},
      { allowProfile: false, execFile },
    );
    expect(credential).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("passes the given env through to the child process (for ANTHROPIC_PROFILE)", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const execFile: ExecFileFn = vi.fn((_file, _args, options) => {
      seenEnv = options.env;
      return Promise.resolve({ stdout: "sk-ant-oat-xyz", stderr: "" });
    });
    await resolveAnthropicCredential(
      { ANTHROPIC_PROFILE: "work" },
      { execFile },
    );
    expect(seenEnv?.ANTHROPIC_PROFILE).toBe("work");
  });
});
