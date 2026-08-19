import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  detachedSpawnOptions,
  executableCandidates,
  killProcessTree,
  shellInvocationFor,
} from "../src/platform/shell.js";

describe("shellInvocationFor", () => {
  it("uses bash -lc on POSIX platforms", () => {
    expect(shellInvocationFor("echo hi", "linux")).toEqual({
      command: "bash",
      args: ["-lc", "echo hi"],
    });
    expect(shellInvocationFor("echo hi", "darwin")).toEqual({
      command: "bash",
      args: ["-lc", "echo hi"],
    });
  });

  it("uses cmd.exe /d /s /c on Windows", () => {
    expect(shellInvocationFor("echo hi", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "echo hi"],
    });
  });
});

describe("detachedSpawnOptions", () => {
  it("detaches on POSIX so the child leads its own process group", () => {
    expect(detachedSpawnOptions("linux").detached).toBe(true);
  });

  it("does not detach on Windows and hides the console window", () => {
    expect(detachedSpawnOptions("win32")).toEqual({
      detached: false,
      windowsHide: true,
    });
  });
});

describe("executableCandidates", () => {
  it("returns the bare name alone on POSIX", () => {
    expect(executableCandidates("codex", "linux")).toEqual(["codex"]);
  });

  it("adds .cmd and .exe shim names on Windows for bare names", () => {
    expect(executableCandidates("codex", "win32")).toEqual([
      "codex",
      "codex.cmd",
      "codex.exe",
    ]);
  });

  it("leaves names that already carry an extension alone on Windows", () => {
    expect(executableCandidates("codex.cmd", "win32")).toEqual(["codex.cmd"]);
    expect(executableCandidates("C:\\tools\\codex.exe", "win32")).toEqual([
      "C:\\tools\\codex.exe",
    ]);
  });
});

function fakeChild(pid: number | undefined): ChildProcess & {
  killed: NodeJS.Signals[];
} {
  const killed: NodeJS.Signals[] = [];
  return {
    pid,
    killed,
    kill(signal?: NodeJS.Signals) {
      killed.push(signal ?? "SIGTERM");
      return true;
    },
  } as unknown as ChildProcess & { killed: NodeJS.Signals[] };
}

describe("killProcessTree (win32 branch)", () => {
  it("invokes taskkill with /pid /T /F", () => {
    const child = fakeChild(1234);
    const taskkill = vi.fn();
    killProcessTree(child, "SIGTERM", "win32", taskkill);
    expect(taskkill).toHaveBeenCalledWith(1234);
    expect(child.killed).toEqual([]);
  });

  it("falls back to child.kill() when taskkill throws", () => {
    const child = fakeChild(1234);
    killProcessTree(child, "SIGTERM", "win32", () => {
      throw new Error("no taskkill");
    });
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  it("is a no-op without a pid", () => {
    const child = fakeChild(undefined);
    const taskkill = vi.fn();
    killProcessTree(child, "SIGTERM", "win32", taskkill);
    expect(taskkill).not.toHaveBeenCalled();
  });
});
