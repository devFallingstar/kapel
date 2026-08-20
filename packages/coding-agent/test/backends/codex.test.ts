import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexBackend,
  type CodexRunContext,
} from "../../src/backends/codex.js";
import {
  cleanup,
  isGone,
  makeTempDir,
  RecordingSink,
  waitForExit,
  writeFakeCodex,
} from "./test-helpers.js";

const AGENT_MESSAGE = "Added the feature and updated the tests.";

function context(
  workspacePath: string,
  overrides: Partial<CodexRunContext> = {},
): CodexRunContext {
  return { runId: "run-1", workspacePath, ...overrides };
}

/** Reads the NUL-separated argv dump written by the fake codex binary. */
async function readArgv(path: string): Promise<string[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\0").slice(0, -1);
}

describe("CodexBackend.run", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir();
    workspace = await makeTempDir("codex-workspace-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("captures the final agent message, usage and event stream on success", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "th_1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "reasoning", text: "thinking" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: AGENT_MESSAGE },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 5, output_tokens: 7 },
        }),
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new CodexBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "add a feature" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(AGENT_MESSAGE);
    expect(result.output).toBe(AGENT_MESSAGE);
    expect(result.usage).toEqual({ inputTokens: 105, outputTokens: 27 });
    expect(result.events).toBe(6);

    expect(events.types()).toEqual([
      "codex.thread.started",
      "codex.turn.started",
      "codex.item.completed",
      "codex.item.completed",
      "codex.turn.completed",
      "codex.turn.completed",
      "codex.completed",
    ]);
    expect(events.events[0]?.data).toEqual({
      type: "thread.started",
      thread_id: "th_1",
    });
    expect(events.events.at(-1)?.data).toEqual({
      status: "success",
      exitCode: 0,
    });
    expect(events.events.every((event) => event.runId === "run-1")).toBe(true);
  });

  it("reports a success with no message when codex emits none", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stdout: [JSON.stringify({ type: "turn.completed" })],
    });
    const backend = new CodexBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "do nothing" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Codex completed with no final message.");
    expect(result.output).toBeUndefined();
  });

  it("skips non-JSON lines without crashing", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stdout: [
        "Codex CLI v0.1.0 — starting up",
        JSON.stringify({ type: "turn.started" }),
        "{not json at all",
        "[]",
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", message: "done via message field" },
        }),
        "warning: something noisy",
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new CodexBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "be noisy" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.output).toBe("done via message field");
    expect(result.events).toBe(2);
    expect(events.types()).toEqual([
      "codex.turn.started",
      "codex.item.completed",
      "codex.completed",
    ]);
  });

  it("tolerates unknown event shapes and missing fields", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stdout: [
        JSON.stringify({ nothing: "useful" }),
        JSON.stringify({ type: "brand.new.event", payload: { a: 1 } }),
        JSON.stringify({ type: "item.started", item: null }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "file_change" },
        }),
      ],
    });
    const events = new RecordingSink();
    const backend = new CodexBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "drift" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.events).toBe(4);
    expect(events.types()).toContain("codex.unknown");
    expect(events.types()).toContain("codex.brand.new.event");
  });

  it("fails with an informative summary on a non-zero exit with an error event", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stdout: [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "error", message: "model request failed: 429" }),
      ],
      stderr: "codex: giving up\n",
      exitCode: 3,
    });
    const backend = new CodexBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "fail please" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.summary).toContain("exited with code 3");
    expect(result.summary).toContain("model request failed: 429");
  });

  it("falls back to stderr when a failing run reports no error event", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stderr: "fatal: sandbox denied write access\n",
      exitCode: 1,
    });
    const backend = new CodexBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "fail quietly" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("sandbox denied write access");
  });

  it("names the requested model in the failure summary when one was set", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stderr: "fatal: model not found\n",
      exitCode: 1,
    });
    const backend = new CodexBackend({ binaryPath, model: "gpt-5.1-codex" });

    const result = await backend.run(
      { instruction: "fail please" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("fatal: model not found");
    expect(result.summary).toContain('model "gpt-5.1-codex" was requested');
    expect(result.summary).toContain("account or plan may not have access");
  });

  it("omits the model hint when no model was requested", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stderr: "fatal: sandbox denied write access\n",
      exitCode: 1,
    });
    const backend = new CodexBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "fail quietly" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).not.toContain("was requested");
  });

  it("fails with an install hint when the binary is missing", async () => {
    const backend = new CodexBackend({
      binaryPath: join(dir, "definitely-not-installed"),
    });

    const result = await backend.run(
      { instruction: "anything" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBeNull();
    expect(result.summary).toContain("Codex CLI not found");
    expect(result.summary).toContain("npm install -g @openai/codex");
    expect(result.summary).toContain("codex login");
  });

  it("cancels the run and terminates the process on abort", async () => {
    const pidFile = join(dir, "codex.pid");
    const binaryPath = await writeFakeCodex(dir, {
      stdout: [JSON.stringify({ type: "turn.started" })],
      pidFile,
      sleepSeconds: 30,
    });
    const controller = new AbortController();
    const backend = new CodexBackend({ binaryPath });

    const pending = backend.run(
      { instruction: "take forever" },
      context(workspace, { signal: controller.signal }),
    );

    // Wait until the fake has actually started before cancelling.
    let pid = 0;
    for (let i = 0; i < 200 && pid <= 0; i += 1) {
      try {
        const parsed = Number.parseInt(await readFile(pidFile, "utf8"), 10);
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
        else await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();

    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("cancelled");

    await waitForExit(pid);
    expect(isGone(pid)).toBe(true);
  }, 20_000);

  it("returns immediately when the signal is already aborted", async () => {
    const binaryPath = await writeFakeCodex(dir, { sleepSeconds: 30 });
    const backend = new CodexBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "never runs" },
      context(workspace, { signal: AbortSignal.abort() }),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("cancelled");
    expect(result.events).toBe(0);
  });

  it("times out a long-running codex process", async () => {
    const pidFile = join(dir, "codex.pid");
    const binaryPath = await writeFakeCodex(dir, {
      pidFile,
      sleepSeconds: 30,
    });
    const backend = new CodexBackend({ binaryPath, timeoutMs: 300 });

    const started = Date.now();
    const result = await backend.run(
      { instruction: "take forever" },
      context(workspace),
    );

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("timed out after 300ms");

    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    await waitForExit(pid);
    expect(isGone(pid)).toBe(true);
  }, 20_000);
});

describe("CodexBackend argument construction", () => {
  let dir: string;
  let workspace: string;
  let argvFile: string;

  beforeEach(async () => {
    dir = await makeTempDir();
    workspace = await makeTempDir("codex-workspace-");
    argvFile = join(dir, "argv.txt");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("defaults to `exec --json --cd <workspace> --full-auto` with the prompt last", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({ binaryPath });

    await backend.run({ instruction: "ship it" }, context(workspace));

    expect(await readArgv(argvFile)).toEqual([
      "exec",
      "--json",
      "--cd",
      workspace,
      "--full-auto",
      "ship it",
    ]);
  });

  it("maps sandbox, model and extraArgs onto flags", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({
      binaryPath,
      sandbox: "read-only",
      model: "gpt-5-codex",
      extraArgs: ["--color", "never"],
    });

    await backend.run({ instruction: "review it" }, context(workspace));

    expect(await readArgv(argvFile)).toEqual([
      "exec",
      "--json",
      "--cd",
      workspace,
      "--sandbox",
      "read-only",
      "-m",
      "gpt-5-codex",
      "--color",
      "never",
      "review it",
    ]);
  });

  it("passes each attached image as a repeated -i <path> flag, before extraArgs and the prompt (P1-9)", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({
      binaryPath,
      extraArgs: ["--color", "never"],
    });

    await backend.run(
      {
        instruction: "describe these",
        images: [
          {
            mediaType: "image/png",
            base64: "cG5n",
            path: "/tmp/one.png",
          },
          {
            mediaType: "image/jpeg",
            base64: "anBn",
            path: "/tmp/two.jpg",
          },
        ],
      },
      context(workspace),
    );

    expect(await readArgv(argvFile)).toEqual([
      "exec",
      "--json",
      "--cd",
      workspace,
      "--full-auto",
      "-i",
      "/tmp/one.png",
      "-i",
      "/tmp/two.jpg",
      "--color",
      "never",
      "describe these",
    ]);
  });

  it("passes an image attached by path as -i <path> too (delegated chat)", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({ binaryPath });

    await backend.run(
      {
        instruction: "what changed in these?",
        imagePaths: [`${workspace}/before.png`, `${workspace}/after.png`],
      },
      context(workspace),
    );

    expect(await readArgv(argvFile)).toEqual([
      "exec",
      "--json",
      "--cd",
      workspace,
      "--full-auto",
      "-i",
      `${workspace}/before.png`,
      "-i",
      `${workspace}/after.png`,
      "what changed in these?",
    ]);
  });

  it("attaches an image named both ways only once", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({ binaryPath });

    await backend.run(
      {
        instruction: "describe it",
        images: [
          { mediaType: "image/png", base64: "cG5n", path: "/tmp/one.png" },
        ],
        imagePaths: ["/tmp/one.png", "/tmp/two.png"],
      },
      context(workspace),
    );

    const argv = await readArgv(argvFile);
    expect(argv.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(argv.slice(argv.indexOf("-i"), -1)).toEqual([
      "-i",
      "/tmp/one.png",
      "-i",
      "/tmp/two.png",
    ]);
  });

  it("passes no -i flags when there are no attached images", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({ binaryPath });

    await backend.run({ instruction: "ship it" }, context(workspace));

    expect(await readArgv(argvFile)).not.toContain("-i");
  });

  it("uses an explicit --sandbox workspace-write when fullAuto is disabled", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({
      binaryPath,
      sandbox: "workspace-write",
      fullAuto: false,
    });

    await backend.run({ instruction: "careful" }, context(workspace));

    const argv = await readArgv(argvFile);
    expect(argv).toContain("--sandbox");
    expect(argv).not.toContain("--full-auto");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("does not map --full-auto onto a danger-full-access sandbox", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({
      binaryPath,
      sandbox: "danger-full-access",
    });

    await backend.run({ instruction: "yolo" }, context(workspace));

    const argv = await readArgv(argvFile);
    expect(argv).not.toContain("--full-auto");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("danger-full-access");
  });

  it("folds context entries into the trailing prompt argument", async () => {
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const backend = new CodexBackend({ binaryPath });

    await backend.run(
      {
        instruction: "fix the bug",
        context: ["repo uses vitest", "TS strict"],
      },
      context(workspace),
    );

    const argv = await readArgv(argvFile);
    const prompt = argv.at(-1) ?? "";
    expect(prompt.startsWith("fix the bug")).toBe(true);
    expect(prompt).toContain('<context index="1">');
    expect(prompt).toContain("repo uses vitest");
    expect(prompt).toContain('<context index="2">');
    expect(prompt).toContain("TS strict");
  });
});

describe("CodexBackend.checkAvailability", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("reports installed and logged in", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      body: [
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.20.0"; exit 0; fi',
        'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    });

    const result = await CodexBackend.checkAvailability(binaryPath);

    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(true);
    expect(result.detail).toContain("codex-cli 0.20.0");
  });

  it("reports installed but not logged in", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      body: [
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.20.0"; exit 0; fi',
        'echo "Not logged in" >&2',
        "exit 1",
      ].join("\n"),
    });

    const result = await CodexBackend.checkAvailability(binaryPath);

    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("Not logged in");
    expect(result.detail).toContain("codex login");
  });

  it("reports a missing binary without throwing", async () => {
    const result = await CodexBackend.checkAvailability(
      join(dir, "no-such-codex"),
    );

    expect(result.installed).toBe(false);
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("npm install -g @openai/codex");
  });

  it("reports a binary that exists but fails to run", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      body: ['echo "boom" >&2', "exit 2"].join("\n"),
    });

    const result = await CodexBackend.checkAvailability(binaryPath);

    expect(result.installed).toBe(false);
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("boom");
  });
});
