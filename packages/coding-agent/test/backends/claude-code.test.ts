import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeBackend,
  type ClaudeCodeRunContext,
  imagePathsSection,
} from "../../src/backends/claude-code.js";
import {
  cleanup,
  isGone,
  makeTempDir,
  RecordingSink,
  waitForExit,
  writeFakeClaude,
} from "./test-helpers.js";

const FINAL_TEXT = "Added the feature and updated the tests.";

function context(
  workspacePath: string,
  overrides: Partial<ClaudeCodeRunContext> = {},
): ClaudeCodeRunContext {
  return { runId: "run-1", workspacePath, ...overrides };
}

/** Wraps a raw Claude API streaming event in the CLI's stream envelope. */
function envelope(event: unknown): string {
  return JSON.stringify({
    type: "stream_event",
    event,
    uuid: "11111111-2222-3333-4444-555555555555",
    session_id: "sess-1",
  });
}

function textDelta(text: string, index = 0): unknown {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  };
}

/** Reads the NUL-separated argv dump written by the fake claude binary. */
async function readArgv(path: string): Promise<string[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\0").slice(0, -1);
}

/**
 * The prompt as the real CLI would see it: the argv element immediately after
 * the `--` separator. Reading it positionally (rather than as `argv.at(-1)`)
 * is the whole point — the trailing positional is only reachable at all
 * because option parsing was ended first.
 */
function promptAfterSeparator(argv: readonly string[]): string | undefined {
  const separator = argv.indexOf("--");
  return separator === -1 ? undefined : argv[separator + 1];
}

/** A whole-message `assistant` line, the shape Claude Code 2.x emits. */
function assistantMessage(content: readonly unknown[], id = "msg_1"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content,
      stop_reason: null,
    },
    session_id: "sess-1",
    parent_tool_use_id: null,
  });
}

describe("ClaudeCodeBackend.run", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir("claude-test-");
    workspace = await makeTempDir("claude-workspace-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("captures the final result, usage, cost, session and event stream", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        envelope({
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 100,
              output_tokens: 1,
              cache_read_input_tokens: 20,
            },
          },
        }),
        envelope({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        envelope(textDelta("Added the feature ")),
        envelope(textDelta("and updated the tests.")),
        envelope({ type: "content_block_stop", index: 0 }),
        envelope({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu_1", name: "Edit" },
        }),
        envelope({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"file":' },
        }),
        envelope({ type: "content_block_stop", index: 1 }),
        envelope({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 42 },
        }),
        envelope({ type: "message_stop" }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: FINAL_TEXT,
          session_id: "sess-1",
          total_cost_usd: 0.0421,
          modelUsage: { "claude-opus-5": { inputTokens: 120 } },
        }),
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new ClaudeCodeBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "add a feature" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(FINAL_TEXT);
    expect(result.output).toBe(FINAL_TEXT);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 42 });
    expect(result.costUsd).toBeCloseTo(0.0421, 6);
    expect(result.sessionId).toBe("sess-1");
    expect(result.events).toBe(11);

    expect(events.types()).toEqual([
      "claude-code.message_start",
      "claude-code.content_block_start",
      "claude-code.content_block_delta",
      "claude-code.content_block_delta",
      "claude-code.content_block_stop",
      "claude-code.content_block_start",
      "claude-code.tool_use",
      "claude-code.content_block_delta",
      "claude-code.content_block_stop",
      "claude-code.message_delta",
      "claude-code.message_stop",
      "claude-code.result",
      "claude-code.completed",
    ]);
    // Forwarded data is the original parsed line, envelope and all.
    expect(events.events[0]?.data).toEqual({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          model: "claude-opus-5",
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 20,
          },
        },
      },
      uuid: "11111111-2222-3333-4444-555555555555",
      session_id: "sess-1",
    });
    expect(events.events[6]?.data).toEqual({
      name: "Edit",
      id: "tu_1",
      index: 1,
    });
    expect(events.events.at(-1)?.data).toEqual({
      status: "success",
      exitCode: 0,
    });
    expect(events.events.every((event) => event.runId === "run-1")).toBe(true);
  });

  it("tolerates bare (un-enveloped) streaming events", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 7, output_tokens: 2 } },
        }),
        JSON.stringify(textDelta("bare ")),
        JSON.stringify(textDelta("stream")),
        JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", name: "Bash" },
        }),
        JSON.stringify({ type: "message_stop" }),
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new ClaudeCodeBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "no envelope" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.summary).toBe("bare stream");
    expect(result.output).toBe("bare stream");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(events.types()).toEqual([
      "claude-code.message_start",
      "claude-code.content_block_delta",
      "claude-code.content_block_delta",
      "claude-code.content_block_start",
      "claude-code.tool_use",
      "claude-code.message_stop",
      "claude-code.completed",
    ]);
  });

  it("renders a whole-message assistant line when no deltas ever arrive", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        JSON.stringify({ type: "system", subtype: "init" }),
        assistantMessage([
          { type: "text", text: "Added the feature " },
          { type: "tool_use", id: "tu_1", name: "Edit", input: {} },
          { type: "text", text: "and updated the tests." },
        ]),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: FINAL_TEXT,
          session_id: "sess-1",
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 40,
            output_tokens: 4,
          },
        }),
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new ClaudeCodeBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "whole messages only" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.output).toBe(FINAL_TEXT);
    // Usage still comes from the trailing result line — the whole-message
    // line's own `usage` is a placeholder taken before the turn finished.
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 4 });
    expect(events.types()).toEqual([
      "claude-code.system",
      "claude-code.assistant",
      "claude-code.content_block_delta",
      "claude-code.tool_use",
      "claude-code.content_block_delta",
      "claude-code.message_stop",
      "claude-code.result",
      "claude-code.completed",
    ]);
    expect(events.events[2]?.data).toEqual({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Added the feature " },
      },
    });
    expect(events.events[3]?.data).toEqual({
      name: "Edit",
      id: "tu_1",
      index: 1,
    });
  });

  it("falls back to whole-message text when there is no result line", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        assistantMessage([{ type: "text", text: "Refactored the parser." }]),
      ],
      exitCode: 0,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "refactor" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.output).toBe("Refactored the parser.");
  });

  it("does not re-emit a whole message whose deltas already streamed", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        envelope({
          type: "message_start",
          message: {
            id: "msg_1",
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }),
        envelope({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        envelope(textDelta("Added the feature ")),
        envelope(textDelta("and updated the tests.")),
        // The CLI repeats the finished message alongside the deltas when
        // --include-partial-messages is on; it must not print twice.
        assistantMessage([
          { type: "text", text: "Added the feature and updated the tests." },
        ]),
        envelope({ type: "content_block_stop", index: 0 }),
        envelope({ type: "message_stop" }),
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new ClaudeCodeBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "both shapes" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.output).toBe("Added the feature and updated the tests.");
    expect(events.types()).toEqual([
      "claude-code.message_start",
      "claude-code.content_block_start",
      "claude-code.content_block_delta",
      "claude-code.content_block_delta",
      "claude-code.assistant",
      "claude-code.content_block_stop",
      "claude-code.message_stop",
      "claude-code.completed",
    ]);
  });

  it("still renders a second message that arrives whole after a streamed first one", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        envelope({ type: "message_start", message: { id: "msg_1" } }),
        envelope(textDelta("first ")),
        assistantMessage([{ type: "text", text: "first " }], "msg_1"),
        assistantMessage([{ type: "text", text: "second" }], "msg_2"),
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new ClaudeCodeBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "two messages" },
      context(workspace),
    );

    expect(result.output).toBe("first second");
    expect(
      events.types().filter((type) => type.endsWith("content_block_delta")),
    ).toHaveLength(2);
  });

  it("skips non-JSON and non-object lines without crashing", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        "Claude Code v2.1.211 starting…",
        envelope(textDelta("still ")),
        "{not json at all",
        "[]",
        "null",
        envelope(textDelta("fine")),
        "warning: something noisy",
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new ClaudeCodeBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "be noisy" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.output).toBe("still fine");
    expect(result.events).toBe(2);
    expect(events.types()).toEqual([
      "claude-code.content_block_delta",
      "claude-code.content_block_delta",
      "claude-code.completed",
    ]);
  });

  it("tolerates unknown event types and missing fields", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        JSON.stringify({ nothing: "useful" }),
        JSON.stringify({ type: "system", subtype: "init" }),
        envelope({ type: "brand_new_event", payload: { a: 1 } }),
        envelope({ type: "message_start" }),
        envelope({ type: "content_block_start", index: 0 }),
        envelope({ type: "content_block_delta", index: 0 }),
        envelope({ type: "message_delta" }),
      ],
      exitCode: 0,
    });
    const events = new RecordingSink();
    const backend = new ClaudeCodeBackend({ binaryPath, events });

    const result = await backend.run(
      { instruction: "drift" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.events).toBe(7);
    expect(result.usage).toBeUndefined();
    expect(events.types()).toContain("claude-code.unknown");
    expect(events.types()).toContain("claude-code.system");
    expect(events.types()).toContain("claude-code.brand_new_event");
    expect(result.summary).toBe("Claude Code completed with no final message.");
  });

  it("falls back to accumulated text when there is no final result line", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        envelope({ type: "message_start", message: { usage: {} } }),
        envelope(textDelta("Refactored ")),
        envelope(textDelta("the parser.")),
        envelope({ type: "message_stop" }),
      ],
      exitCode: 0,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "refactor" },
      context(workspace),
    );

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Refactored the parser.");
    expect(result.output).toBe("Refactored the parser.");
    expect(result.sessionId).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });

  it("prefers the final result line over the streamed text", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        envelope(textDelta("partial draft")),
        JSON.stringify({
          result: "authoritative answer",
          session_id: "sess-9",
          total_cost_usd: 0.5,
        }),
      ],
      exitCode: 0,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "answer" },
      context(workspace),
    );

    expect(result.summary).toBe("authoritative answer");
    expect(result.sessionId).toBe("sess-9");
    expect(result.costUsd).toBe(0.5);
  });

  it("fails with an informative summary on a non-zero exit with stderr", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [envelope({ type: "message_start", message: {} })],
      stderr: "Error: credit balance is too low\n",
      exitCode: 1,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "fail please" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("exited with code 1");
    expect(result.summary).toContain("credit balance is too low");
  });

  it("falls back to non-JSON output when a failing run writes no stderr", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: ["Invalid argument: --nope"],
      exitCode: 1,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "bad flags" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Invalid argument: --nope");
  });

  it("surfaces an error-flagged result line on failure", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "the turn was aborted by the tool harness",
          session_id: "sess-2",
        }),
      ],
      exitCode: 1,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "boom" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("aborted by the tool harness");
    expect(result.sessionId).toBe("sess-2");
  });

  it("names the requested model in the failure summary when one was set", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stderr: "Error: model not found\n",
      exitCode: 1,
    });
    const backend = new ClaudeCodeBackend({
      binaryPath,
      model: "claude-fable-5",
    });

    const result = await backend.run(
      { instruction: "fail please" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Error: model not found");
    expect(result.summary).toContain('model "claude-fable-5" was requested');
    expect(result.summary).toContain("account or plan may not have access");
  });

  it("omits the model hint when no model was requested", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stderr: "Error: credit balance is too low\n",
      exitCode: 1,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "fail please" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).not.toContain("was requested");
  });

  it("fails with an install and login hint when the binary is missing", async () => {
    const backend = new ClaudeCodeBackend({
      binaryPath: join(dir, "definitely-not-installed"),
    });

    const result = await backend.run(
      { instruction: "anything" },
      context(workspace),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBeNull();
    expect(result.summary).toContain("Claude Code CLI not found");
    expect(result.summary).toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
    expect(result.summary).toContain("log in");
  });

  it("cancels the run and terminates the process on abort", async () => {
    const pidFile = join(dir, "claude.pid");
    const binaryPath = await writeFakeClaude(dir, {
      stdout: [envelope({ type: "message_start", message: {} })],
      pidFile,
      sleepSeconds: 30,
    });
    const controller = new AbortController();
    const backend = new ClaudeCodeBackend({ binaryPath });

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

  it("fails immediately with a clear message when images are attached, without spawning (P1-9)", async () => {
    // A binary that would hang if actually spawned — proves the guard fires
    // before any process starts.
    const binaryPath = await writeFakeClaude(dir, { sleepSeconds: 30 });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const started = Date.now();
    const result = await backend.run(
      {
        instruction: "what is in this screenshot?",
        images: [
          { mediaType: "image/png", base64: "cG5n", path: "/tmp/a.png" },
        ],
      },
      context(workspace),
    );

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("headless -p mode");
    expect(result.summary).toContain("codex");
    expect(result.events).toBe(0);
    expect(result.exitCode).toBeNull();
  });

  it("returns immediately when the signal is already aborted", async () => {
    const binaryPath = await writeFakeClaude(dir, { sleepSeconds: 30 });
    const backend = new ClaudeCodeBackend({ binaryPath });

    const result = await backend.run(
      { instruction: "never runs" },
      context(workspace, { signal: AbortSignal.abort() }),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("cancelled before it started");
    expect(result.events).toBe(0);
  });

  it("times out a long-running claude process", async () => {
    const pidFile = join(dir, "claude.pid");
    const binaryPath = await writeFakeClaude(dir, {
      pidFile,
      sleepSeconds: 30,
    });
    const backend = new ClaudeCodeBackend({ binaryPath, timeoutMs: 300 });

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

describe("imagePathsSection", () => {
  it("names one image in the singular", () => {
    expect(imagePathsSection(["/repo/shot.png"])).toBe(
      "<attached-images>\n" +
        "The user attached an image file to this message. Open and view it with your Read tool before answering:\n" +
        "- /repo/shot.png\n" +
        "</attached-images>",
    );
  });

  it("lists every path, one per line", () => {
    const section = imagePathsSection(["/repo/a.png", "/repo/b.png"]);
    expect(section).toContain("- /repo/a.png\n- /repo/b.png");
    expect(section).toContain("each of them with your Read tool");
  });
});

describe("ClaudeCodeBackend argument construction", () => {
  let dir: string;
  let workspace: string;
  let argvFile: string;

  beforeEach(async () => {
    dir = await makeTempDir("claude-test-");
    workspace = await makeTempDir("claude-workspace-");
    argvFile = join(dir, "argv.txt");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("defaults to headless stream-json with acceptEdits and the prompt last", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({ binaryPath });

    await backend.run({ instruction: "ship it" }, context(workspace));

    expect(await readArgv(argvFile)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
      "--verbose",
      "--include-partial-messages",
      "--",
      "ship it",
    ]);
  });

  it("omits --verbose when verbose is false", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({ binaryPath, verbose: false });

    await backend.run({ instruction: "quiet" }, context(workspace));

    expect(await readArgv(argvFile)).not.toContain("--verbose");
  });

  it("omits --include-partial-messages when the option is false", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({
      binaryPath,
      includePartialMessages: false,
    });

    await backend.run(
      { instruction: "whole messages only" },
      context(workspace),
    );

    const argv = await readArgv(argvFile);
    expect(argv).not.toContain("--include-partial-messages");
    expect(promptAfterSeparator(argv)).toBe("whole messages only");
  });

  it("ends option parsing with `--` so a variadic flag cannot swallow the prompt", async () => {
    // Claude Code declares `--allowedTools <tools...>` and `--add-dir
    // <directories...>` as variadic, so without the separator the trailing
    // positional is consumed as another value and the CLI exits 1 with
    // "Input must be provided either through stdin or as a prompt argument".
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({
      binaryPath,
      allowedTools: ["Read", "Edit"],
      addDirs: ["/srv/shared"],
    });

    await backend.run(
      { instruction: "reply with exactly OK" },
      context(workspace),
    );

    const argv = await readArgv(argvFile);
    const separator = argv.indexOf("--");
    expect(separator).toBeGreaterThan(argv.indexOf("--allowedTools"));
    expect(separator).toBeGreaterThan(argv.indexOf("--add-dir"));
    expect(argv[separator + 1]).toBe("reply with exactly OK");
    expect(separator).toBe(argv.length - 2);
  });

  it("passes `--` even with no variadic flag in play", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({ binaryPath });

    await backend.run({ instruction: "plain prompt" }, context(workspace));

    const argv = await readArgv(argvFile);
    expect(argv).toContain("--");
    expect(promptAfterSeparator(argv)).toBe("plain prompt");
  });

  it("asks the agent to open images attached by path, after the context", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({ binaryPath });

    await backend.run(
      {
        instruction: "what is wrong here?",
        context: ["Earlier in this conversation:\nuser: hi"],
        imagePaths: [`${workspace}/shot.png`, `${workspace}/other.jpg`],
      },
      context(workspace),
    );

    const argv = await readArgv(argvFile);
    // `-p` has no image flag, so nothing new appears in argv — the attachment
    // lives in the prompt.
    expect(argv).not.toContain("-i");
    expect(promptAfterSeparator(argv)).toBe(
      "what is wrong here?\n\n" +
        '<additional-context>\n<context index="1">\n' +
        "Earlier in this conversation:\nuser: hi\n</context>\n</additional-context>\n\n" +
        "<attached-images>\n" +
        "The user attached image files to this message. Open and view each of them with your Read tool before answering:\n" +
        `- ${workspace}/shot.png\n- ${workspace}/other.jpg\n` +
        "</attached-images>",
    );
  });

  it("keeps the prompt untouched when no image was attached", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({ binaryPath });

    await backend.run({ instruction: "just text" }, context(workspace));

    const argv = await readArgv(argvFile);
    expect(promptAfterSeparator(argv)).toBe("just text");
  });

  it("never passes --dangerously-skip-permissions or --cwd", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({
      binaryPath,
      permissionMode: "bypassPermissions",
    });

    await backend.run({ instruction: "yolo" }, context(workspace));

    const argv = await readArgv(argvFile);
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--cwd");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );
  });

  it("maps model, allowedTools, addDirs and extraArgs onto flags", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({
      binaryPath,
      model: "claude-opus-5",
      permissionMode: "default",
      allowedTools: ["Read", "Edit", "Bash"],
      addDirs: ["/srv/shared", "/srv/docs"],
      extraArgs: ["--settings", "/srv/settings.json"],
    });

    await backend.run({ instruction: "review it" }, context(workspace));

    expect(await readArgv(argvFile)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "default",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "claude-opus-5",
      "--allowedTools",
      "Read,Edit,Bash",
      "--add-dir",
      "/srv/shared",
      "--add-dir",
      "/srv/docs",
      "--settings",
      "/srv/settings.json",
      "--",
      "review it",
    ]);
  });

  it("omits --model and --allowedTools when unset or empty", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({ binaryPath, allowedTools: [] });

    await backend.run({ instruction: "plain" }, context(workspace));

    const argv = await readArgv(argvFile);
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--allowedTools");
  });

  it("runs the CLI with the workspace as its working directory", async () => {
    const cwdFile = join(dir, "cwd.txt");
    const binaryPath = await writeFakeClaude(dir, {
      body: `pwd > ${cwdFile}\nexit 0`,
    });
    const backend = new ClaudeCodeBackend({ binaryPath });

    await backend.run({ instruction: "where am i" }, context(workspace));

    const cwd = (await readFile(cwdFile, "utf8")).trim();
    // macOS resolves the temp dir through a /private symlink.
    expect(cwd.endsWith(workspace)).toBe(true);
  });

  it("folds context entries into the trailing prompt argument", async () => {
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const backend = new ClaudeCodeBackend({ binaryPath });

    await backend.run(
      {
        instruction: "fix the bug",
        context: ["repo uses vitest", "TS strict"],
      },
      context(workspace),
    );

    const argv = await readArgv(argvFile);
    const prompt = promptAfterSeparator(argv) ?? "";
    expect(prompt.startsWith("fix the bug")).toBe(true);
    expect(prompt).toContain('<context index="1">');
    expect(prompt).toContain("repo uses vitest");
    expect(prompt).toContain('<context index="2">');
    expect(prompt).toContain("TS strict");
  });
});

describe("ClaudeCodeBackend.checkAvailability", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("claude-test-");
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("reports installed and logged in", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      body: [
        'if [ "$1" = "--version" ]; then echo "2.1.211 (Claude Code)"; exit 0; fi',
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "Logged in as user@example.com"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    });

    const result = await ClaudeCodeBackend.checkAvailability(binaryPath);

    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(true);
    expect(result.detail).toContain("2.1.211 (Claude Code)");
    expect(result.detail).toContain("Logged in as user@example.com");
  });

  it("reports installed but not logged in", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      body: [
        'if [ "$1" = "--version" ]; then echo "2.1.211 (Claude Code)"; exit 0; fi',
        'echo "Not authenticated" >&2',
        "exit 1",
      ].join("\n"),
    });

    const result = await ClaudeCodeBackend.checkAvailability(binaryPath);

    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("Not authenticated");
    expect(result.detail).toContain("Run `claude` and log in");
  });

  it("reports a missing binary without throwing", async () => {
    const result = await ClaudeCodeBackend.checkAvailability(
      join(dir, "no-such-claude"),
    );

    expect(result.installed).toBe(false);
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("npm install -g @anthropic-ai/claude-code");
  });

  it("reports a binary that exists but fails to run", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      body: ['echo "boom" >&2', "exit 2"].join("\n"),
    });

    const result = await ClaudeCodeBackend.checkAvailability(binaryPath);

    expect(result.installed).toBe(false);
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("boom");
  });
});
