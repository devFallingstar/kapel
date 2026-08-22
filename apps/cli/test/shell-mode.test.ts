import type { spawn as SpawnFn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachShellContext,
  createPendingShellQueue,
  exitCodeNotice,
  MAX_CAPTURED_OUTPUT_CHARS,
  parseBangLine,
  pendingAttachedNotice,
  runShellCaptured,
  runShellInteractive,
  shellUsageNotice,
  splitOutputLines,
} from "../src/shell-mode.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "kapel-shell-mode-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** A `node -e <script>` invocation — portable across bash and cmd.exe. */
function node(script: string): string {
  return `node -e "${script.replace(/"/g, '\\"')}"`;
}

// --- parseBangLine -----------------------------------------------------------

describe("parseBangLine", () => {
  it("recognizes a single-bang command", () => {
    expect(parseBangLine("!ls -la")).toEqual({ kind: "!", command: "ls -la" });
  });

  it("recognizes a double-bang command", () => {
    expect(parseBangLine("!!npm test")).toEqual({
      kind: "!!",
      command: "npm test",
    });
  });

  it("trims whitespace around the command", () => {
    expect(parseBangLine("!   ls   ")).toEqual({ kind: "!", command: "ls" });
  });

  it("answers empty for a bare bang", () => {
    expect(parseBangLine("!")).toEqual({ kind: "!", command: "" });
    expect(parseBangLine("!!")).toEqual({ kind: "!!", command: "" });
  });

  it("answers undefined for anything that is not shell syntax", () => {
    expect(parseBangLine("hello")).toBeUndefined();
    expect(parseBangLine("/help")).toBeUndefined();
    expect(parseBangLine("")).toBeUndefined();
  });
});

describe("shellUsageNotice", () => {
  it("differs between the two forms", () => {
    expect(shellUsageNotice("!")).toContain("!<command>");
    expect(shellUsageNotice("!!")).toContain("!!<command>");
    expect(shellUsageNotice("!!")).toContain("attaches its output");
  });
});

describe("exitCodeNotice", () => {
  it("says nothing about a clean exit", () => {
    expect(exitCodeNotice(0)).toBeUndefined();
  });

  it("names a nonzero exit code", () => {
    expect(exitCodeNotice(3)).toBe("exit 3");
  });

  it("falls back to -1 for a signal-killed process (code null)", () => {
    expect(exitCodeNotice(null)).toBe("exit -1");
  });
});

describe("splitOutputLines", () => {
  it("is empty for empty output", () => {
    expect(splitOutputLines("")).toEqual([]);
  });

  it("drops exactly one trailing newline", () => {
    expect(splitOutputLines("one\ntwo\n")).toEqual(["one", "two"]);
  });

  it("keeps a line with no trailing newline", () => {
    expect(splitOutputLines("one\ntwo")).toEqual(["one", "two"]);
  });

  it("keeps interior blank lines", () => {
    expect(splitOutputLines("one\n\ntwo\n")).toEqual(["one", "", "two"]);
  });
});

// --- pending shell queue -----------------------------------------------------

describe("createPendingShellQueue", () => {
  it("is empty until something is pushed", () => {
    const queue = createPendingShellQueue();
    expect(queue.count()).toBe(0);
    expect(queue.takeAll()).toEqual([]);
  });

  it("takes everything queued, in order, and clears it", () => {
    const queue = createPendingShellQueue();
    queue.push({ command: "ls", output: "a.txt\n" });
    queue.push({ command: "pwd", output: "/repo\n" });
    expect(queue.count()).toBe(2);

    const taken = queue.takeAll();
    expect(taken).toEqual([
      { command: "ls", output: "a.txt\n" },
      { command: "pwd", output: "/repo\n" },
    ]);
    expect(queue.count()).toBe(0);
    expect(queue.takeAll()).toEqual([]);
  });

  it("clear() throws everything away and answers how many went with it", () => {
    const queue = createPendingShellQueue();
    queue.push({ command: "one", output: "x" });
    queue.push({ command: "two", output: "y" });
    expect(queue.clear()).toBe(2);
    expect(queue.count()).toBe(0);
  });

  it("drops the oldest captures, FIFO, once the total exceeds the cap", () => {
    const queue = createPendingShellQueue(10);
    queue.push({ command: "one", output: "12345" });
    queue.push({ command: "two", output: "12345" });
    // Total is exactly 10 so far — still within the cap.
    expect(queue.count()).toBe(2);

    queue.push({ command: "three", output: "12345" });
    // Now 15 > 10: "one" is dropped first, since it is the oldest.
    const taken = queue.takeAll();
    expect(taken.map((c) => c.command)).toEqual(["two", "three"]);
  });

  it("never drops the only capture left, even if it alone is over the cap", () => {
    const queue = createPendingShellQueue(5);
    queue.push({ command: "huge", output: "0123456789" });
    expect(queue.count()).toBe(1);
    expect(queue.takeAll()).toEqual([
      { command: "huge", output: "0123456789" },
    ]);
  });
});

describe("pendingAttachedNotice", () => {
  it("names the command that was captured", () => {
    expect(pendingAttachedNotice("npm test")).toBe(
      "→ output of !!npm test will ride along with your next message",
    );
  });
});

describe("attachShellContext", () => {
  it("leaves the instruction untouched with nothing queued", () => {
    expect(attachShellContext("fix this", [])).toBe("fix this");
  });

  it("appends every capture as its own labelled block, in order", () => {
    const result = attachShellContext("fix this", [
      { command: "npm test", output: "1 failing\n" },
      { command: "git status", output: "clean\n" },
    ]);
    expect(result).toBe(
      'fix this\n\n<additional-context>\n<shell-output index="1" command="!!npm test">\n1 failing\n\n</shell-output>\n<shell-output index="2" command="!!git status">\nclean\n\n</shell-output>\n</additional-context>',
    );
  });
});

// --- real spawns --------------------------------------------------------------
//
// `node -e <script>` rather than a shell builtin: the platform shell differs
// (bash -lc vs cmd.exe /d /s /c — see `shellInvocationFor`), but `node` is
// guaranteed to be on PATH in a test run, so this is the one command that
// behaves identically under both.

describe("runShellCaptured", () => {
  it("captures stdout and reports a clean exit", async () => {
    const result = await runShellCaptured(node("console.log('hello')"), {
      cwd,
    });
    expect(result.output).toBe("hello\n");
    expect(result.code).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("merges stderr in with stdout", async () => {
    const result = await runShellCaptured(
      node("console.error('oops'); console.log('ok')"),
      { cwd },
    );
    expect(result.output).toContain("oops");
    expect(result.output).toContain("ok");
  });

  it("reports a nonzero exit code", async () => {
    const result = await runShellCaptured(node("process.exit(7)"), { cwd });
    expect(result.code).toBe(7);
  });

  it("runs in the given cwd", async () => {
    const result = await runShellCaptured(node("console.log(process.cwd())"), {
      cwd,
    });
    expect(result.output.trim()).toBe(cwd);
  });

  it("caps output and says so, mirroring the bash tool's discipline", async () => {
    const result = await runShellCaptured(
      node("process.stdout.write('x'.repeat(50))"),
      { cwd, maxChars: 10 },
    );
    expect(result.truncated).toBe(true);
    expect(result.output.startsWith("x".repeat(10))).toBe(true);
    expect(result.output).toContain("truncated");
  });

  it("defaults the cap to the bash tool's 100,000 characters", async () => {
    expect(MAX_CAPTURED_OUTPUT_CHARS).toBe(100_000);
  });

  it("kills the process tree on abort instead of waiting it out", async () => {
    const controller = new AbortController();
    const pending = runShellCaptured(node("setTimeout(() => {}, 30000)"), {
      cwd,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    // Killed by SIGTERM/SIGKILL rather than exiting on its own — Node reports
    // that as a null exit code.
    expect(result.code).toBeNull();
  }, 10000);
});

describe("runShellInteractive", () => {
  it("hands stdio through and reports the child's real exit code", async () => {
    const result = await runShellInteractive(node("process.exit(4)"), {
      cwd,
    });
    expect(result.code).toBe(4);
  });

  it("resolves with -1 rather than throwing when the spawn itself fails", async () => {
    const child = new EventEmitter();
    const fakeSpawn = (() => child) as unknown as typeof SpawnFn;

    const pending = runShellInteractive("does-not-matter", {
      cwd,
      spawn: fakeSpawn,
    });
    queueMicrotask(() => child.emit("error", new Error("ENOENT")));

    expect(await pending).toEqual({ code: -1 });
  });
});
