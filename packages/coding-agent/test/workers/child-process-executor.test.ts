import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildProcessWorkerExecutor } from "../../src/workers/child-process-executor.js";
import {
  cleanup,
  isGone,
  makeRuntimeTask,
  makeTaskResult,
  makeTempDir,
  RecordingSink,
  waitForExit,
} from "./test-helpers.js";

/**
 * Wraps a child body in the stdin plumbing every protocol worker needs.
 *
 * The children are spawned as `node -e <script>` and speak the raw protocol
 * JSON, so these tests exercise the real pipe, the real process group and the
 * real line framing without depending on a built `dist/`.
 */
function childScript(body: string): string {
  return `
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(raw);
      const send = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
      ${body}
    });
  `;
}

const RESULT_BODY = `
  send({
    type: "event",
    event: {
      id: "child-event-1",
      runId: request.runId,
      timestamp: 1,
      type: "worker.started",
      taskId: request.task.id,
      data: { agent: request.agent },
    },
  });
  process.stdout.write("Debugger listening on ws://...\\n");
  send({ type: "event", event: { id: "child-event-2", runId: request.runId, timestamp: 2, type: "worker.progress" } });
  send({
    type: "result",
    result: {
      taskId: request.task.id,
      status: "success",
      summary: "child handled " + request.task.title + " as " + request.agent,
      decisions: ["kept it simple"],
      changedFiles: ["src/retry.ts"],
      commit: "deadbeef",
      tests: { passed: 2, failed: 0, commands: ["npm test"] },
      unresolvedIssues: [],
      confidence: 0.9,
    },
  });
`;

describe("ChildProcessWorkerExecutor", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("child-worker-");
  });

  afterEach(async () => {
    await cleanup(workspace);
  });

  function executor(
    script: string,
    overrides: Partial<{
      events: RecordingSink;
      taskTimeoutMs: number;
      env: Record<string, string>;
    }> = {},
  ): ChildProcessWorkerExecutor {
    return new ChildProcessWorkerExecutor({
      command: [process.execPath, "-e", script],
      runId: "run-42",
      workspacePath: workspace,
      ...overrides,
    });
  }

  it("round-trips a task through a child process and forwards its events", async () => {
    const events = new RecordingSink();
    const result = await executor(childScript(RESULT_BODY), {
      events,
    }).execute(makeRuntimeTask(), "coder");

    expect(result).toEqual({
      taskId: "task-1",
      status: "success",
      summary: "child handled Add retry to the uploader as coder",
      decisions: ["kept it simple"],
      changedFiles: ["src/retry.ts"],
      commit: "deadbeef",
      tests: { passed: 2, failed: 0, commands: ["npm test"] },
      unresolvedIssues: [],
      confidence: 0.9,
    });

    expect(events.types()).toEqual(["worker.started", "worker.progress"]);
    expect(events.events[0]?.data).toEqual({ agent: "coder" });
    expect(events.events[0]?.runId).toBe("run-42");
  });

  it("sends the full planned task and run context on stdin", async () => {
    const dumpPath = join(workspace, "request.json");
    const script = childScript(`
      require("fs").writeFileSync(${JSON.stringify(dumpPath)}, raw);
      send({
        type: "result",
        result: { taskId: request.task.id, status: "success", summary: "ok", decisions: [], changedFiles: [], tests: { passed: 0, failed: 0, commands: [] }, unresolvedIssues: [], confidence: 0.8 },
      });
    `);

    await executor(script, { taskTimeoutMs: 30_000 }).execute(
      makeRuntimeTask(),
      "coder",
    );

    const sent = JSON.parse(await readFile(dumpPath, "utf8")) as {
      type: string;
      agent: string;
      runId: string;
      workspacePath: string;
      timeoutMs: number;
      task: { id: string; affectedAreas: string[] };
    };
    expect(sent.type).toBe("task");
    expect(sent.agent).toBe("coder");
    expect(sent.runId).toBe("run-42");
    expect(sent.workspacePath).toBe(workspace);
    expect(sent.timeoutMs).toBe(30_000);
    expect(sent.task.id).toBe("task-1");
    expect(sent.task.affectedAreas).toEqual(["packages/uploader"]);
  });

  it("forwards dependency results, and omits the field when there are none", async () => {
    const dumpPath = join(workspace, "request.json");
    const script = childScript(`
      require("fs").writeFileSync(${JSON.stringify(dumpPath)}, raw);
      send({
        type: "result",
        result: { taskId: request.task.id, status: "success", summary: "ok", decisions: [], changedFiles: [], tests: { passed: 0, failed: 0, commands: [] }, unresolvedIssues: [], confidence: 0.8 },
      });
    `);
    const dependency = makeTaskResult({ taskId: "T00", summary: "groundwork" });

    await executor(script).execute(makeRuntimeTask(), "coder", undefined, {
      dependencyResults: [dependency],
    });
    const withContext = JSON.parse(await readFile(dumpPath, "utf8")) as {
      dependencyResults?: unknown[];
    };
    expect(withContext.dependencyResults).toEqual([dependency]);

    // An empty list stays off the wire: the field is optional, and a child that
    // predates it must still see a request it can parse.
    await executor(script).execute(makeRuntimeTask(), "coder", undefined, {
      dependencyResults: [],
    });
    const without = JSON.parse(await readFile(dumpPath, "utf8")) as {
      dependencyResults?: unknown[];
    };
    expect("dependencyResults" in without).toBe(false);
  });

  it("merges extra environment into the child", async () => {
    const script = childScript(`
      send({
        type: "result",
        result: { taskId: request.task.id, status: "success", summary: String(process.env.WORKER_TOKEN), decisions: [], changedFiles: [], tests: { passed: 0, failed: 0, commands: [] }, unresolvedIssues: [], confidence: 0.8 },
      });
    `);

    const result = await executor(script, {
      env: { WORKER_TOKEN: "s3cret" },
    }).execute(makeRuntimeTask(), "coder");

    expect(result.summary).toBe("s3cret");
  });

  it("overrides a mismatched task id from the child", async () => {
    const script = childScript(`
      send({
        type: "result",
        result: { taskId: "some-other-task", status: "success", summary: "ok", decisions: [], changedFiles: [], tests: { passed: 0, failed: 0, commands: [] }, unresolvedIssues: [], confidence: 0.8 },
      });
    `);

    const result = await executor(script).execute(makeRuntimeTask(), "coder");

    expect(result.taskId).toBe("task-1");
  });

  it("fails when the child emits malformed protocol output only", async () => {
    const script = childScript(`
      process.stdout.write("{ not json\\n");
      send({ type: "result", result: { taskId: request.task.id, status: "banana" } });
      process.exit(0);
    `);

    const result = await executor(script).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.taskId).toBe("task-1");
    expect(result.summary).toContain("exited with code 0");
    expect(result.summary).toContain("without returning a result");
    expect(result.confidence).toBe(0.1);
  });

  it("fails with the exit code and stderr tail when the child crashes", async () => {
    const script = `
      process.stderr.write("worker: cannot find module @agent/nope\\n");
      process.exit(7);
    `;

    const result = await executor(script).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("exited with code 7");
    expect(result.summary).toContain("cannot find module @agent/nope");
  });

  it("fails when the worker command does not exist", async () => {
    const missing = join(workspace, "no-such-worker-binary");
    const result = await new ChildProcessWorkerExecutor({
      command: [missing, "worker"],
      runId: "run-42",
      workspacePath: workspace,
    }).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Worker command not found");
    expect(result.summary).toContain(missing);
  });

  it("fails when no command is configured", async () => {
    const result = await new ChildProcessWorkerExecutor({
      command: [],
      runId: "run-42",
      workspacePath: workspace,
    }).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("empty command argv");
  });

  it("kills the child process group when the task times out", async () => {
    const pidFile = join(workspace, "child.pid");
    const script = `
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;

    const started = Date.now();
    const result = await executor(script, { taskTimeoutMs: 400 }).execute(
      makeRuntimeTask(),
      "coder",
    );

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("timed out after 400ms");

    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    await waitForExit(pid);
    expect(isGone(pid)).toBe(true);
  }, 20_000);

  it("kills the child and reports cancellation when the signal aborts", async () => {
    const pidFile = join(workspace, "child.pid");
    const script = `
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();

    const pending = executor(script).execute(
      makeRuntimeTask(),
      "coder",
      controller.signal,
    );

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
    const result = await executor(childScript(RESULT_BODY)).execute(
      makeRuntimeTask(),
      "coder",
      AbortSignal.abort(),
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain(
      "cancelled before the process was started",
    );
  });

  it("keeps the result of a child that exits non-zero after reporting one", async () => {
    const script = childScript(`
      send({
        type: "result",
        result: { taskId: request.task.id, status: "partial", summary: "did half", decisions: [], changedFiles: [], tests: { passed: 0, failed: 0, commands: [] }, unresolvedIssues: ["ran out of budget"], confidence: 0.4 },
      });
      setTimeout(() => process.exit(1), 10);
    `);

    const result = await executor(script).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("partial");
    expect(result.summary).toBe("did half");
    expect(result.unresolvedIssues).toEqual(["ran out of budget"]);
  });
});
