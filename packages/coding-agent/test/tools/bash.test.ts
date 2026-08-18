import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../../src/tools/bash.js";
import {
  cleanupWorkspace,
  makeContext,
  makeWorkspace,
} from "./test-helpers.js";

describe("BashTool", () => {
  let workspacePath: string;
  const tool = new BashTool();

  beforeEach(async () => {
    workspacePath = await makeWorkspace();
  });

  afterEach(async () => {
    await cleanupWorkspace(workspacePath);
  });

  it("runs a command and captures stdout/exitCode", async () => {
    const result = await tool.execute(
      { command: "echo hello" },
      makeContext(workspacePath),
    );
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures a non-zero exit code and stderr", async () => {
    const result = await tool.execute(
      { command: "echo oops 1>&2; exit 7" },
      makeContext(workspacePath),
    );
    expect(result.exitCode).toBe(7);
    expect(result.stderr.trim()).toBe("oops");
  });

  it("runs commands in the workspace directory", async () => {
    const result = await tool.execute(
      { command: "pwd" },
      makeContext(workspacePath),
    );
    expect(result.stdout.trim()).toBe(workspacePath);
  });

  it("times out a long-running command", async () => {
    const start = Date.now();
    const result = await tool.execute(
      { command: "sleep 5", timeoutMs: 200 },
      makeContext(workspacePath),
    );
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);

  it("is cancellable via the abort signal", async () => {
    const controller = new AbortController();
    const promise = tool.execute(
      { command: "sleep 5" },
      makeContext(workspacePath, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(new Error("cancelled by test")), 100);
    await expect(promise).rejects.toThrow(/cancelled by test/);
  }, 10_000);

  it("caps stdout at 100000 characters", async () => {
    const result = await tool.execute(
      { command: "head -c 150000 /dev/zero | tr '\\0' 'a'" },
      makeContext(workspacePath),
    );
    expect(result.stdout.length).toBeLessThanOrEqual(100_000 + 100);
    expect(result.stdout).toContain("truncated");
  });

  it("rejects invalid input via zod", async () => {
    await expect(
      tool.execute({}, makeContext(workspacePath)),
    ).rejects.toThrow();
    await expect(
      tool.execute(
        { command: "echo x", timeoutMs: -1 },
        makeContext(workspacePath),
      ),
    ).rejects.toThrow();
    await expect(
      tool.execute(
        { command: "echo x", timeoutMs: 700_000 },
        makeContext(workspacePath),
      ),
    ).rejects.toThrow();
  });
});
