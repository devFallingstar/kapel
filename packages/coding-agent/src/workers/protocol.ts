import type {
  PlannedTask,
  TaskResult,
  WorkerExecutionContext,
} from "@agent/orchestration";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { AgentEventSchema } from "@agent/protocol";
import { z } from "zod";

/**
 * The wire protocol between a parent orchestrator and a child worker process.
 *
 * Parent -> child: exactly one JSON line on stdin, then stdin is closed.
 * Child -> parent: JSONL on stdout — zero or more `{"type":"event"}` lines
 * followed by exactly one `{"type":"result"}` line. Any stdout line that is not
 * valid protocol JSON is ignored (child runtimes love to print banners), and
 * stderr is diagnostics only.
 */

export const PlannedTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  type: z.enum([
    "exploration",
    "architecture",
    "implementation",
    "testing",
    "review",
    "documentation",
  ]),
  complexity: z.enum(["trivial", "normal", "complex", "architectural"]),
  dependencies: z.array(z.string()),
  suggestedAgent: z.string().optional(),
  affectedAreas: z.array(z.string()),
  risk: z.object({
    level: z.enum(["low", "medium", "high"]),
    categories: z.array(z.string()),
  }),
});

export const TaskResultSchema = z.object({
  taskId: z.string(),
  status: z.enum(["success", "failed", "partial"]),
  summary: z.string(),
  decisions: z.array(z.string()),
  changedFiles: z.array(z.string()),
  commit: z.string().optional(),
  tests: z.object({
    passed: z.number(),
    failed: z.number(),
    commands: z.array(z.string()),
  }),
  unresolvedIssues: z.array(z.string()),
  confidence: z.number(),
});

export const WorkerRequestSchema = z.object({
  type: z.literal("task"),
  task: PlannedTaskSchema,
  agent: z.string(),
  runId: z.string(),
  workspacePath: z.string(),
  timeoutMs: z.number().optional(),
  /**
   * Results of the task's direct dependencies, in dependency-declaration order.
   * Optional on purpose: a parent that predates dependency context (or a task
   * with no dependencies) sends a request without it, and that stays valid.
   */
  dependencyResults: z.array(TaskResultSchema).optional(),
});

export const WorkerEventLineSchema = z.object({
  type: z.literal("event"),
  event: AgentEventSchema,
});

export const WorkerResultLineSchema = z.object({
  type: z.literal("result"),
  result: TaskResultSchema,
});

export const WorkerStdoutLineSchema = z.discriminatedUnion("type", [
  WorkerEventLineSchema,
  WorkerResultLineSchema,
]);

export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerEventLine = z.infer<typeof WorkerEventLineSchema>;
export type WorkerResultLine = z.infer<typeof WorkerResultLineSchema>;
export type WorkerStdoutLine = z.infer<typeof WorkerStdoutLineSchema>;

/**
 * Converts a parsed task into the orchestration `PlannedTask` shape.
 *
 * Zod infers optional properties as `T | undefined`, which `exactOptionalPropertyTypes`
 * refuses to assign to `prop?: T`, so absent fields are dropped rather than
 * carried as explicit `undefined`.
 */
export function toPlannedTask(
  parsed: z.infer<typeof PlannedTaskSchema>,
): PlannedTask {
  const { suggestedAgent, ...rest } = parsed;
  return {
    ...rest,
    ...(suggestedAgent === undefined ? {} : { suggestedAgent }),
  };
}

/**
 * The execution context a request carries, or `undefined` when it carries none.
 *
 * An absent and an empty `dependencyResults` list mean the same thing to a
 * worker, so both collapse to `undefined` rather than to an empty context.
 */
export function toWorkerExecutionContext(
  request: WorkerRequest,
): WorkerExecutionContext | undefined {
  const results = request.dependencyResults;
  if (results === undefined || results.length === 0) return undefined;
  return { dependencyResults: results.map(toTaskResult) };
}

/** Converts a parsed result into the orchestration `TaskResult` shape. */
export function toTaskResult(
  parsed: z.infer<typeof TaskResultSchema>,
): TaskResult {
  const { commit, ...rest } = parsed;
  return { ...rest, ...(commit === undefined ? {} : { commit }) };
}

/**
 * What a child may hand to {@link encodeWorkerLine}: the orchestration types
 * (readonly arrays, exact-optional `commit`) rather than the mutable shapes zod
 * infers from the schemas.
 */
export type WorkerStdoutLineInput =
  | { readonly type: "event"; readonly event: AgentEvent }
  | { readonly type: "result"; readonly result: TaskResult };

/** Serializes one protocol line (no trailing newline). */
export function encodeWorkerLine(line: WorkerStdoutLineInput): string {
  return JSON.stringify(line);
}

/**
 * Parses one stdout line. Returns `undefined` for blank lines, non-JSON output
 * and JSON that does not match the protocol — all of which are ignorable noise
 * rather than protocol violations.
 */
export function parseWorkerStdoutLine(
  line: string,
): WorkerStdoutLine | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  const parsed = WorkerStdoutLineSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export interface ServeWorkerRequestIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}

export interface ServeWorkerRequestOptions {
  /** Set to `false` to suppress `{"type":"event"}` lines. Defaults to `true`. */
  readonly events?: boolean;
}

export type WorkerRequestHandler = (
  request: WorkerRequest,
  events: EventSink,
) => Promise<TaskResult>;

/** Reads the first line of a stream without consuming or closing the rest. */
function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve) => {
    let buffer = "";
    let settled = false;

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onEnd);
      resolve(value);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index !== -1) finish(buffer.slice(0, index));
    };
    const onEnd = (): void => finish(buffer);

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onEnd);
  });
}

function write(
  stdout: NodeJS.WritableStream,
  line: WorkerStdoutLineInput,
): void {
  stdout.write(`${encodeWorkerLine(line)}\n`);
}

/**
 * Serves a single worker request on a pair of streams: read the request line,
 * run `handler`, write the result line.
 *
 * Kept free of any executor dependency so the CLI's `agent worker` command can
 * wire whichever backend it likes into it. Returns the suggested process exit
 * code: `0` when a result line was written for a well-formed request, `1` when
 * the request could not be read or the handler threw (a failed result line is
 * still written in the latter case, so the parent gets a diagnosis instead of
 * an empty pipe).
 */
export async function serveWorkerRequest(
  io: ServeWorkerRequestIo,
  handler: WorkerRequestHandler,
  options: ServeWorkerRequestOptions = {},
): Promise<number> {
  const emitEvents = options.events !== false;

  const raw = await readFirstLine(io.stdin);
  let request: WorkerRequest;
  try {
    request = WorkerRequestSchema.parse(JSON.parse(raw));
  } catch {
    // Nothing addressable to report: without a task id the parent cannot match
    // a result line to a task, so it will fall back to its exit-code path.
    return 1;
  }

  const sink: EventSink = {
    emit(event) {
      if (emitEvents) write(io.stdout, { type: "event", event });
    },
  };

  try {
    const result = await handler(request, sink);
    write(io.stdout, { type: "result", result });
    return 0;
  } catch (error) {
    write(io.stdout, {
      type: "result",
      result: {
        taskId: request.task.id,
        status: "failed",
        summary: `Worker handler failed: ${error instanceof Error ? error.message : String(error)}`,
        decisions: [],
        changedFiles: [],
        tests: { passed: 0, failed: 0, commands: [] },
        unresolvedIssues: [],
        confidence: 0.1,
      },
    });
    return 1;
  }
}
