import { spawn } from "node:child_process";
import type {
  RuntimeTask,
  TaskResult,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { detachedSpawnOptions, killProcessTree } from "../platform/shell.js";
import { failedTaskResult } from "./normalize.js";
import { parseWorkerStdoutLine, toTaskResult } from "./protocol.js";

const KILL_GRACE_MS = 2000;
const MAX_STDERR_CHARS = 50_000;
const STDERR_TAIL_CHARS = 2000;

export interface ChildProcessWorkerExecutorOptions {
  /** Full argv to spawn, e.g. `[process.execPath, cliEntry, "worker"]`. */
  readonly command: readonly string[];
  readonly runId: string;
  readonly workspacePath: string;
  /** Receives every event line the child emits, in order. */
  readonly events?: EventSink;
  readonly taskTimeoutMs?: number;
  /** Extra environment for the child, merged over `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

interface ChildOutcome {
  readonly kind: "spawn-error" | "exit";
  readonly error?: Error;
  readonly exitCode?: number | null;
  readonly aborted?: boolean;
  readonly timedOut?: boolean;
}

function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `...${trimmed.slice(trimmed.length - limit)}`;
}

function describe(command: readonly string[]): string {
  return command.join(" ");
}

/**
 * Runs orchestration tasks in a separate process that speaks the worker
 * protocol (see `./protocol.ts`).
 *
 * Isolation is the point: a worker that wedges, leaks memory or writes to
 * global state cannot take the orchestrator with it, and the whole process
 * group is killable on timeout or cancellation. As with the other executors,
 * every failure comes back as a `failed` {@link TaskResult} instead of a
 * rejected promise.
 *
 * **Nothing in the kapel CLI spawns this any more.** It used to back
 * `--worker-mode child`, whose child process was `kapel worker`; both the flag
 * and that command went when kapel became REPL-first, and the REPL runs every
 * task through the in-process agent loop. What is left here is library
 * surface: the executor and the protocol it speaks (`./protocol.ts`) are
 * complete, tested, and take their argv from the caller, so an embedder that
 * has its own worker binary can still drive one.
 */
export class ChildProcessWorkerExecutor implements WorkerExecutor {
  readonly #options: ChildProcessWorkerExecutorOptions;

  constructor(options: ChildProcessWorkerExecutorOptions) {
    this.#options = options;
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const taskId = task.spec.id;
    const { command, runId, workspacePath, taskTimeoutMs } = this.#options;

    const executable = command[0];
    if (executable === undefined) {
      return failedTaskResult(
        taskId,
        "No worker command was configured (empty command argv).",
      );
    }

    const signals: AbortSignal[] = [];
    if (signal !== undefined) signals.push(signal);
    const timeoutSignal =
      taskTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(taskTimeoutMs);
    if (timeoutSignal !== undefined) signals.push(timeoutSignal);
    const combined =
      signals.length === 0 ? undefined : AbortSignal.any(signals);

    if (combined?.aborted === true) {
      return failedTaskResult(
        taskId,
        "Worker cancelled before the process was started.",
      );
    }

    // An empty dependency list is left off the wire entirely: the field is
    // optional, and an older child that ignores it must still see a request it
    // can parse.
    const dependencyResults = context?.dependencyResults ?? [];
    const request = JSON.stringify({
      type: "task",
      task: task.spec,
      agent,
      runId,
      workspacePath,
      ...(taskTimeoutMs === undefined ? {} : { timeoutMs: taskTimeoutMs }),
      ...(dependencyResults.length === 0 ? {} : { dependencyResults }),
    });

    // Events are queued synchronously as lines arrive and drained in order so
    // the sink observes the child's ordering.
    let queue: Promise<void> = Promise.resolve();
    const forward = (event: AgentEvent): void => {
      const sink = this.#options.events;
      if (sink === undefined) return;
      queue = queue.then(async () => {
        try {
          await sink.emit(event);
        } catch {
          // Event emission is best-effort and must never fail a task.
        }
      });
    };

    let result: TaskResult | undefined;
    let stderr = "";
    let stderrTruncated = false;

    const outcome = await new Promise<ChildOutcome>((resolve) => {
      // command[0] is process.execPath (the node binary, extension-complete),
      // so no Windows .cmd-shim fallback is needed here.
      const child = spawn(executable, [...command.slice(1)], {
        cwd: workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
        ...detachedSpawnOptions(),
        env: { ...process.env, ...this.#options.env },
      });

      let settled = false;
      let aborted = false;
      let killTimer: NodeJS.Timeout | undefined;

      const killGroup = (sig: NodeJS.Signals): void => {
        killProcessTree(child, sig);
      };

      const onAbort = (): void => {
        aborted = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      combined?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        combined?.removeEventListener("abort", onAbort);
      };

      let pending = "";
      const consumeLine = (line: string): void => {
        const parsed = parseWorkerStdoutLine(line.replace(/\r$/, ""));
        if (parsed === undefined) return;
        if (parsed.type === "event") {
          forward(parsed.event);
          return;
        }
        // Exactly one result line is expected; keep the first and ignore any
        // extras rather than letting a chatty child rewrite history.
        if (result === undefined) result = toTaskResult(parsed.result);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let index = pending.indexOf("\n");
        while (index !== -1) {
          consumeLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
          index = pending.indexOf("\n");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrTruncated) return;
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_STDERR_CHARS) {
          stderr = stderr.slice(0, MAX_STDERR_CHARS);
          stderrTruncated = true;
        }
      });

      // A child that exits before reading its stdin makes the write fail with
      // EPIPE; that is the child's exit to report, not a separate error.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(`${request}\n`);

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ kind: "spawn-error", error });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (pending !== "") consumeLine(pending);
        resolve({
          kind: "exit",
          exitCode: code,
          aborted,
          timedOut: aborted && timeoutSignal?.aborted === true,
        });
      });
    });

    await queue;

    if (outcome.kind === "spawn-error") {
      const error = outcome.error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const detail = error?.message ?? "unknown error";
      return failedTaskResult(
        taskId,
        code === "ENOENT"
          ? `Worker command not found: "${describe(command)}".`
          : `Failed to start the worker process "${describe(command)}": ${detail}`,
      );
    }

    if (result !== undefined) {
      // The parent owns task identity: a child that reports a different id is
      // answering the wrong question, and the scheduler keys on ours.
      return result.taskId === taskId ? result : { ...result, taskId };
    }

    const stderrTail =
      stderr.trim() === "" ? "" : ` stderr: ${tail(stderr, STDERR_TAIL_CHARS)}`;

    if (outcome.timedOut === true) {
      return failedTaskResult(
        taskId,
        `Worker process timed out after ${String(taskTimeoutMs)}ms and was terminated.${stderrTail}`,
      );
    }
    if (outcome.aborted === true) {
      return failedTaskResult(
        taskId,
        `Worker process was cancelled and terminated.${stderrTail}`,
      );
    }

    return failedTaskResult(
      taskId,
      `Worker process exited with code ${String(outcome.exitCode)} without returning a result.${stderrTail}`,
    );
  }
}
