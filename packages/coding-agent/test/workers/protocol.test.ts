import { PassThrough } from "node:stream";
import type { EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  encodeWorkerLine,
  parseWorkerStdoutLine,
  serveWorkerRequest,
  toPlannedTask,
  toTaskResult,
  type WorkerRequest,
  WorkerRequestSchema,
} from "../../src/workers/protocol.js";
import { makePlannedTask, makeTaskResult } from "./test-helpers.js";

/** Builds a raw (unvalidated) request payload for the schema to chew on. */
function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "task",
    task: makePlannedTask(),
    agent: "coder",
    runId: "run-1",
    workspacePath: "/tmp/workspace",
    ...overrides,
  };
}

interface Served {
  readonly exitCode: number;
  readonly lines: unknown[];
}

/** Feeds one request line through {@link serveWorkerRequest}. */
async function serve(
  raw: string,
  handler: (
    request: WorkerRequest,
    events: EventSink,
  ) => Promise<ReturnType<typeof makeTaskResult>>,
  options?: { events?: boolean },
): Promise<Served> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  const pending = serveWorkerRequest({ stdin, stdout }, handler, options);
  stdin.write(raw);
  stdin.end();

  const exitCode = await pending;
  const lines = chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
  return { exitCode, lines };
}

describe("worker protocol schemas", () => {
  it("accepts a well-formed request", () => {
    const parsed = WorkerRequestSchema.parse(request({ timeoutMs: 1000 }));
    expect(parsed.task.id).toBe("task-1");
    expect(parsed.timeoutMs).toBe(1000);
  });

  it("rejects a request with an unknown task type", () => {
    const bad = request();
    (bad as { task: { type: string } }).task.type = "telepathy";
    expect(WorkerRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("round-trips a planned task through the wire shape", () => {
    const task = makePlannedTask({ suggestedAgent: "coder" });
    const parsed = WorkerRequestSchema.parse(request({ task }));
    expect(toPlannedTask(parsed.task)).toEqual(task);
  });

  it("drops an absent optional rather than carrying an explicit undefined", () => {
    const parsed = WorkerRequestSchema.parse(request());
    const task = toPlannedTask(parsed.task);
    expect("suggestedAgent" in task).toBe(false);

    const result = toTaskResult({
      taskId: "task-1",
      status: "success",
      summary: "ok",
      decisions: [],
      changedFiles: [],
      commit: undefined,
      tests: { passed: 0, failed: 0, commands: [] },
      unresolvedIssues: [],
      confidence: 0.8,
    });
    expect("commit" in result).toBe(false);
  });

  it("ignores blank, non-JSON and off-protocol stdout lines", () => {
    expect(parseWorkerStdoutLine("")).toBeUndefined();
    expect(parseWorkerStdoutLine("   ")).toBeUndefined();
    expect(parseWorkerStdoutLine("Debugger attached.")).toBeUndefined();
    expect(parseWorkerStdoutLine('{"type":"progress"}')).toBeUndefined();
    expect(parseWorkerStdoutLine('{"type":"result"}')).toBeUndefined();
    expect(
      parseWorkerStdoutLine(
        JSON.stringify({ type: "result", result: { taskId: "t" } }),
      ),
    ).toBeUndefined();
  });

  it("parses a valid result line", () => {
    const line = encodeWorkerLine({ type: "result", result: makeTaskResult() });
    const parsed = parseWorkerStdoutLine(line);
    expect(parsed?.type).toBe("result");
    expect(parsed?.type === "result" && parsed.result.summary).toBe(
      "Did the thing.",
    );
  });
});

describe("serveWorkerRequest", () => {
  it("reads the request, streams events and writes exactly one result line", async () => {
    const seen: WorkerRequest[] = [];
    const served = await serve(
      `${JSON.stringify(request())}\n`,
      async (parsed, events) => {
        seen.push(parsed);
        await events.emit({
          id: "event-1",
          runId: parsed.runId,
          timestamp: 1,
          type: "loop.started",
          taskId: parsed.task.id,
        });
        return makeTaskResult({ summary: `handled ${parsed.task.title}` });
      },
    );

    expect(served.exitCode).toBe(0);
    expect(seen[0]?.agent).toBe("coder");
    expect(seen[0]?.workspacePath).toBe("/tmp/workspace");
    expect(served.lines).toEqual([
      {
        type: "event",
        event: {
          id: "event-1",
          runId: "run-1",
          timestamp: 1,
          type: "loop.started",
          taskId: "task-1",
        },
      },
      {
        type: "result",
        result: makeTaskResult({
          summary: "handled Add retry to the uploader",
        }),
      },
    ]);
  });

  it("reads a request that arrives without a trailing newline", async () => {
    const served = await serve(JSON.stringify(request()), async () =>
      makeTaskResult(),
    );

    expect(served.exitCode).toBe(0);
    expect(served.lines).toHaveLength(1);
  });

  it("suppresses event lines when events are disabled", async () => {
    const served = await serve(
      `${JSON.stringify(request())}\n`,
      async (parsed, events) => {
        events.emit({
          id: "event-1",
          runId: parsed.runId,
          timestamp: 1,
          type: "loop.started",
        });
        return makeTaskResult();
      },
      { events: false },
    );

    expect(served.lines).toHaveLength(1);
    expect((served.lines[0] as { type: string }).type).toBe("result");
  });

  it("exits 1 without output when the request line is not valid JSON", async () => {
    const served = await serve("this is not json\n", async () =>
      makeTaskResult(),
    );

    expect(served.exitCode).toBe(1);
    expect(served.lines).toEqual([]);
  });

  it("exits 1 without output when the request does not match the schema", async () => {
    const served = await serve('{"type":"task"}\n', async () =>
      makeTaskResult(),
    );

    expect(served.exitCode).toBe(1);
    expect(served.lines).toEqual([]);
  });

  it("reports a thrown handler as a failed result line and exit code 1", async () => {
    const served = await serve(`${JSON.stringify(request())}\n`, async () => {
      throw new Error("handler blew up");
    });

    expect(served.exitCode).toBe(1);
    expect(served.lines).toHaveLength(1);
    expect(served.lines[0]).toMatchObject({
      type: "result",
      result: {
        taskId: "task-1",
        status: "failed",
        summary: "Worker handler failed: handler blew up",
        confidence: 0.1,
      },
    });
  });

  it("ignores anything after the first request line", async () => {
    const served = await serve(
      `${JSON.stringify(request())}\n${JSON.stringify(request({ agent: "reviewer" }))}\n`,
      async (parsed) => makeTaskResult({ summary: parsed.agent }),
    );

    expect(served.lines).toHaveLength(1);
    expect(served.lines[0]).toMatchObject({ result: { summary: "coder" } });
  });
});
