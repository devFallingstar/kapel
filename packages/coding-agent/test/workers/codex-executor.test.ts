import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexWorkerExecutor } from "../../src/workers/codex-executor.js";
import { NO_VERDICT_SUMMARY } from "../../src/workers/review.js";
import { writeFakeCodex } from "../backends/test-helpers.js";
import {
  cleanup,
  initGitRepo,
  makeRuntimeTask,
  makeTaskResult,
  makeTempDir,
  RecordingSink,
} from "./test-helpers.js";

const AGENT_MESSAGE = "Added the retry loop to the uploader.";

/** Reads the NUL-separated argv dump written by the fake codex binary. */
async function readArgv(path: string): Promise<string[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\0").slice(0, -1);
}

describe("CodexWorkerExecutor", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir("codex-worker-");
    workspace = await makeTempDir("codex-worker-ws-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("normalizes a successful codex run into a task result", async () => {
    const head = await initGitRepo(workspace);
    const binaryPath = await writeFakeCodex(dir, {
      body: [
        `printf '%s\\n' '${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: AGENT_MESSAGE },
        })}'`,
        'printf "export const retries = 3;\\n" > retry.ts',
        "exit 0",
      ].join("\n"),
    });
    const events = new RecordingSink();
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      events,
      backendOptions: { binaryPath },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("success");
    expect(result.summary).toBe(AGENT_MESSAGE);
    expect(result.taskId).toBe("task-1");
    expect(result.changedFiles).toEqual(["retry.ts"]);
    expect(result.commit).toBe(head);
    expect(result.confidence).toBe(0.8);
    expect(result.tests).toEqual({ passed: 0, failed: 0, commands: [] });

    expect(events.types()).toContain("codex.item.completed");
    expect(
      events.events.every(
        (event) => event.runId === "run-7" && event.taskId === "task-1",
      ),
    ).toBe(true);
  });

  it("passes the same task briefing codex-side", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath },
    });

    await executor.execute(makeRuntimeTask(), "coder");

    const argv = await readArgv(argvFile);
    const prompt = argv.at(-1) ?? "";
    expect(prompt).toContain("Add retry to the uploader");
    expect(prompt).toContain("Retry failed uploads three times with backoff.");
    expect(prompt).toContain("packages/uploader");
    expect(prompt).toContain('acting as the "coder" worker');
    expect(argv).toContain("--cd");
    expect(argv).toContain(workspace);
  });

  it("includes dependency results from the execution context in the prompt", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath },
    });

    await executor.execute(makeRuntimeTask(), "coder", undefined, {
      dependencyResults: [
        makeTaskResult({
          taskId: "T00",
          summary: "Added the /healthz route.",
          changedFiles: ["src/server.ts"],
        }),
      ],
    });

    const prompt = (await readArgv(argvFile)).at(-1) ?? "";
    expect(prompt).toContain("## Results from dependency tasks");
    expect(prompt).toContain("### T00 — success");
    expect(prompt).toContain("  - src/server.ts");
  });

  it("returns a failed result when codex exits non-zero", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stderr: "codex: something went wrong\n",
      exitCode: 3,
    });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("exited with code 3");
    expect(result.summary).toContain("something went wrong");
    expect(result.confidence).toBe(0.1);
  });

  it("returns a failed result when the codex binary is missing", async () => {
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath: join(dir, "definitely-not-here") },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Codex CLI not found");
    expect(result.changedFiles).toEqual([]);
  });

  it("applies the executor timeout to the codex process", async () => {
    const binaryPath = await writeFakeCodex(dir, { sleepSeconds: 30 });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      taskTimeoutMs: 300,
      backendOptions: { binaryPath, timeoutMs: 60_000 },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("timed out after 300ms");
  }, 20_000);

  it("passes the resolveAgentModel result to codex as -m, overriding backendOptions.model", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath, model: "run-wide-default" },
      resolveAgentModel: (agent) =>
        agent === "coder" ? "gpt-5-codex" : undefined,
    });

    await executor.execute(makeRuntimeTask(), "coder");

    const argv = await readArgv(argvFile);
    const modelIndex = argv.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(argv[modelIndex + 1]).toBe("gpt-5-codex");
  });

  it("falls back to backendOptions.model when resolveAgentModel has no answer", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath, model: "run-wide-default" },
      resolveAgentModel: () => undefined,
    });

    await executor.execute(makeRuntimeTask(), "coder");

    const argv = await readArgv(argvFile);
    const modelIndex = argv.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(argv[modelIndex + 1]).toBe("run-wide-default");
  });

  describe("review tasks", () => {
    /** A fake `codex` whose whole run is one agent message. */
    function fakeReplying(text: string): Promise<string> {
      return writeFakeCodex(dir, {
        body: [
          `printf '%s\\n' '${JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text },
          })}'`,
          "exit 0",
        ].join("\n"),
      });
    }

    async function reviewResult(text: string) {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath: await fakeReplying(text) },
      });
      return executor.execute(makeRuntimeTask({ type: "review" }), "reviewer");
    }

    it("briefs the reviewer to reply with a JSON verdict, not to call a tool", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeCodex(dir, { argvFile });
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
      });

      await executor.execute(makeRuntimeTask({ type: "review" }), "reviewer");

      const prompt = (await readArgv(argvFile)).at(-1) ?? "";
      expect(prompt).toContain("## Review task — a verdict is required");
      expect(prompt).toContain(
        "Your final message MUST contain exactly one JSON",
      );
      expect(prompt).not.toContain("submit_review_verdict");
    });

    it("passes a review whose reply approved the change", async () => {
      const result = await reviewResult(
        JSON.stringify({
          approved: true,
          summary: "The retry logic is correct and covered.",
        }),
      );

      expect(result.status).toBe("success");
      expect(result.summary).toBe("The retry logic is correct and covered.");
      expect(result.unresolvedIssues).toEqual([]);
    });

    it("fails a review whose reply rejected the change, even on a clean exit", async () => {
      const result = await reviewResult(
        [
          "Here is my verdict:",
          "```json",
          JSON.stringify({
            approved: false,
            summary: "The token is logged in plain text.",
            issues: [
              { severity: "blocking", description: "Redact the auth header." },
            ],
          }),
          "```",
        ].join("\n"),
      );

      expect(result.status).toBe("failed");
      expect(result.summary).toBe(
        "Review rejected: The token is logged in plain text.",
      );
      expect(result.unresolvedIssues).toEqual([
        "blocking: Redact the auth header.",
      ]);
      expect(result.confidence).toBe(0.9);
    });

    it("fails a review that answered in prose only", async () => {
      const result = await reviewResult(
        "REJECTED. There is a blocking issue: the token is logged.",
      );

      expect(result.status).toBe("failed");
      expect(result.summary).toBe(NO_VERDICT_SUMMARY);
      expect(result.confidence).toBe(0.1);
    });

    it("keeps the CLI diagnostic when a review never ran", async () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath: join(dir, "definitely-not-here") },
      });

      const result = await executor.execute(
        makeRuntimeTask({ type: "review" }),
        "reviewer",
      );

      expect(result.status).toBe("failed");
      expect(result.summary).toContain(NO_VERDICT_SUMMARY);
      expect(result.summary).toContain("Codex CLI not found");
    });

    it("leaves a non-review task alone even if it replied with JSON", async () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: {
          binaryPath: await fakeReplying(
            '{"approved": false, "summary": "not a review"}',
          ),
        },
      });

      const result = await executor.execute(makeRuntimeTask(), "coder");

      expect(result.status).toBe("success");
      expect(result.summary).toBe(
        '{"approved": false, "summary": "not a review"}',
      );
    });
  });

  describe("describeAgent", () => {
    it("prefers the resolver's model over backendOptions.model", () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { model: "run-wide-default" },
        resolveAgentModel: () => "gpt-5-codex",
      });

      expect(executor.describeAgent("coder")).toEqual({
        model: "gpt-5-codex",
      });
    });

    it("falls back to backendOptions.model when the resolver has no answer", () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { model: "run-wide-default" },
        resolveAgentModel: () => undefined,
      });

      expect(executor.describeAgent("coder")).toEqual({
        model: "run-wide-default",
      });
    });

    it("returns undefined when neither the resolver nor backendOptions name a model", () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
      });

      expect(executor.describeAgent("coder")).toBeUndefined();
    });
  });
});
