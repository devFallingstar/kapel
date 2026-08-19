import { PassThrough } from "node:stream";
import type {
  RuntimeTask,
  TaskResult,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerExecutorFactoryArgs } from "../src/worker-cmd.js";
import { runWorkerCommand } from "../src/worker-cmd.js";
import {
  cleanupWorkspace,
  copyTemplateAgentDir,
  makeWorkspace,
  successResult,
  task,
} from "./orchestration-fixtures.js";

interface Io {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stdoutLines: () => string[];
}

function makeIo(): Io {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return {
    stdin,
    stdout,
    stdoutLines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line !== ""),
  };
}

function request(
  workspacePath: string,
  agent = "coder",
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    type: "task",
    task: task("T01", { title: "Add the endpoint" }),
    agent,
    runId: "run-1",
    workspacePath,
    timeoutMs: 60_000,
    ...extra,
  })}\n`;
}

/** Emits one event, then returns a canned result — no model, no filesystem. */
class StubExecutor implements WorkerExecutor {
  readonly seen: { taskId: string; agent: string; attempts: number }[] = [];
  readonly contexts: (WorkerExecutionContext | undefined)[] = [];

  constructor(private readonly args: WorkerExecutorFactoryArgs) {}

  async execute(
    runtime: RuntimeTask,
    agent: string,
    _signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    this.contexts.push(context);
    this.seen.push({
      taskId: runtime.spec.id,
      agent,
      attempts: runtime.attempts,
    });
    await this.args.events.emit({
      id: "evt-1",
      runId: this.args.runId,
      timestamp: 0,
      type: "tool.execution.started",
      taskId: runtime.spec.id,
      data: { tool: "read_file" },
    });
    return successResult(runtime.spec.id, "did the thing");
  }
}

describe("agent worker", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspace("cli-worker-test-");
    await copyTemplateAgentDir(workspace);
  });

  afterEach(async () => {
    await cleanupWorkspace(workspace);
  });

  it("serves one request: events then exactly one result line", async () => {
    const io = makeIo();
    const errors: string[] = [];
    let executor: StubExecutor | undefined;

    const pending = runWorkerCommand({
      io,
      error: (line) => errors.push(line),
      executorFactory: (args) => {
        executor = new StubExecutor(args);
        return executor;
      },
    });
    io.stdin.end(request(workspace));

    expect(await pending).toBe(0);

    const lines = io.stdoutLines();
    expect(lines).toHaveLength(2);
    const event = JSON.parse(lines[0] ?? "{}");
    expect(event.type).toBe("event");
    expect(event.event.type).toBe("tool.execution.started");
    const result = JSON.parse(lines[1] ?? "{}");
    expect(result.type).toBe("result");
    expect(result.result.taskId).toBe("T01");
    expect(result.result.status).toBe("success");

    // The request's task becomes a running RuntimeTask on its first attempt.
    expect(executor?.seen).toEqual([
      { taskId: "T01", agent: "coder", attempts: 1 },
    ]);
    // Diagnostics never touch stdout.
    expect(errors.join("\n")).toContain("T01");
  });

  it("passes the request's workspace and timeout through to the executor", async () => {
    const io = makeIo();
    let seen: WorkerExecutorFactoryArgs | undefined;

    const pending = runWorkerCommand({
      io,
      error: () => undefined,
      executorFactory: (args) => {
        seen = args;
        return new StubExecutor(args);
      },
    });
    io.stdin.end(request(workspace));
    await pending;

    expect(seen?.workspacePath).toBe(workspace);
    expect(seen?.runId).toBe("run-1");
    expect(seen?.taskTimeoutMs).toBe(60_000);
    expect(seen?.project.knownAgentNames().has("coder")).toBe(true);
  });

  it("threads the request's dependency results into the execution context", async () => {
    const io = makeIo();
    let executor: StubExecutor | undefined;
    const dependency = successResult("T00", "did the groundwork");

    const pending = runWorkerCommand({
      io,
      error: () => undefined,
      executorFactory: (args) => {
        executor = new StubExecutor(args);
        return executor;
      },
    });
    io.stdin.end(
      request(workspace, "coder", { dependencyResults: [dependency] }),
    );
    await pending;

    expect(executor?.contexts).toEqual([{ dependencyResults: [dependency] }]);
  });

  it("hands the executor no context when the request carries no dependencies", async () => {
    const io = makeIo();
    let executor: StubExecutor | undefined;

    const pending = runWorkerCommand({
      io,
      error: () => undefined,
      executorFactory: (args) => {
        executor = new StubExecutor(args);
        return executor;
      },
    });
    io.stdin.end(request(workspace));
    await pending;

    expect(executor?.contexts).toEqual([undefined]);
  });

  it("exits 1 with no stdout output when the request is not a task", async () => {
    const io = makeIo();
    const pending = runWorkerCommand({ io, error: () => undefined });
    io.stdin.end("{}\n");

    expect(await pending).toBe(1);
    expect(io.stdoutLines()).toEqual([]);
  });

  it("reports a missing .agent directory as a failed result, not a crash", async () => {
    const bare = await makeWorkspace("cli-worker-bare-");
    try {
      const io = makeIo();
      const errors: string[] = [];
      const pending = runWorkerCommand({
        io,
        error: (line) => errors.push(line),
      });
      io.stdin.end(request(bare));

      expect(await pending).toBe(1);
      const lines = io.stdoutLines();
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.result.taskId).toBe("T01");
      expect(parsed.result.status).toBe("failed");
      expect(parsed.result.summary).toContain("agent init");
      expect(errors.join("\n")).toContain("agent init");
    } finally {
      await cleanupWorkspace(bare);
    }
  });
});
