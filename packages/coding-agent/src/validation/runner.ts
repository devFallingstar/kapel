import { spawn } from "node:child_process";
import type { AgentEventBody, EventSink } from "@agent/protocol";
import { agentEvent } from "@agent/protocol";
import {
  detachedSpawnOptions,
  killProcessTree,
  shellInvocationFor,
} from "../platform/shell.js";
import type { ProjectValidator } from "../project/index.js";
import { DEFAULT_VALIDATOR_TIMEOUT_SECONDS } from "../project/index.js";

/**
 * How much of a validator's combined output is kept.
 *
 * The *tail* is kept, not the head: a failing `tsc` or `vitest` run prints its
 * diagnostics and its summary at the end, while the beginning is install noise.
 */
export const MAX_VALIDATOR_OUTPUT_CHARS = 20_000;

/** Prefix that replaces whatever the cap cut off, counted against the cap. */
const TRUNCATION_MARKER = "...[earlier output truncated]\n";

/** Grace period between SIGTERM and SIGKILL when a validator overruns. */
const KILL_GRACE_MS = 2000;

/** What one validator command did. */
export interface ValidatorOutcome {
  readonly name: string;
  readonly command: string;
  readonly passed: boolean;
  /** `null` when the process was killed by a signal or never started. */
  readonly exitCode: number | null;
  /** Interleaved stdout/stderr, tail-capped at {@link MAX_VALIDATOR_OUTPUT_CHARS}. */
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ValidationReport {
  readonly passed: boolean;
  readonly outcomes: readonly ValidatorOutcome[];
}

export interface RunValidatorsOptions {
  readonly signal?: AbortSignal;
  readonly events?: EventSink;
  readonly runId?: string;
  readonly taskId?: string;
}

/**
 * Keeps the last {@link MAX_VALIDATOR_OUTPUT_CHARS} characters, marker included.
 *
 * `alreadyDropped` says whether the streaming buffer had to discard older
 * output before this call, in which case the marker is owed even if what is
 * left now fits.
 */
function capTail(text: string, alreadyDropped: boolean): string {
  if (!alreadyDropped && text.length <= MAX_VALIDATOR_OUTPUT_CHARS) return text;
  const budget = MAX_VALIDATOR_OUTPUT_CHARS - TRUNCATION_MARKER.length;
  return `${TRUNCATION_MARKER}${text.slice(Math.max(0, text.length - budget))}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one validator command and describes what happened.
 *
 * Never rejects. A validator is a *measurement*: "the command could not be
 * spawned" is a result the caller has to report, not an exception that should
 * unwind a task the worker already finished.
 *
 * The child is spawned detached so it leads its own process group, which is
 * what makes a timeout actually stop the work: `npm test` forks, and killing
 * only the `bash` wrapper would leave the test runner behind holding the
 * workspace.
 */
function runOne(
  validator: ProjectValidator,
  workspacePath: string,
  signal: AbortSignal | undefined,
): Promise<ValidatorOutcome> {
  const timeoutMs =
    (validator.timeoutSeconds ?? DEFAULT_VALIDATOR_TIMEOUT_SECONDS) * 1000;
  const startedAt = Date.now();

  return new Promise<ValidatorOutcome>((resolvePromise) => {
    let output = "";
    let dropped = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (fields: {
      passed: boolean;
      exitCode: number | null;
      extra?: string;
    }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        name: validator.name,
        command: validator.command,
        passed: fields.passed,
        exitCode: fields.exitCode,
        output: capTail(
          fields.extra === undefined ? output : `${output}${fields.extra}`,
          dropped,
        ),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    if (signal?.aborted === true) {
      resolvePromise({
        name: validator.name,
        command: validator.command,
        passed: false,
        exitCode: null,
        output: "Validation was cancelled before this validator started.",
        durationMs: 0,
        timedOut: false,
      });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      const shell = shellInvocationFor(validator.command);
      child = spawn(shell.command, [...shell.args], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOptions(),
      });
    } catch (error) {
      resolvePromise({
        name: validator.name,
        command: validator.command,
        passed: false,
        exitCode: null,
        output: `Could not start the validator: ${errorMessage(error)}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
      return;
    }

    const killGroup = (killSignal: NodeJS.Signals): void => {
      killProcessTree(child, killSignal);
    };

    const killHard = (): void => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killHard();
    }, timeoutMs);
    timeoutTimer.unref();

    const onAbort = (): void => {
      aborted = true;
      killHard();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup(): void {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
    }

    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      // Bound memory for a validator that prints megabytes: only the tail can
      // ever survive `capTail`, so anything older than twice the cap is dead
      // weight.
      if (output.length > MAX_VALIDATOR_OUTPUT_CHARS * 2) {
        output = output.slice(output.length - MAX_VALIDATOR_OUTPUT_CHARS);
        dropped = true;
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (error) => {
      finish({
        passed: false,
        exitCode: null,
        extra: `\nCould not run the validator: ${errorMessage(error)}`,
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish({
          passed: false,
          exitCode: code,
          extra: `\n[validator "${validator.name}" timed out after ${timeoutMs}ms and was killed]`,
        });
        return;
      }
      if (aborted) {
        finish({
          passed: false,
          exitCode: code,
          extra: `\n[validator "${validator.name}" was cancelled]`,
        });
        return;
      }
      finish({ passed: code === 0, exitCode: code });
    });
  });
}

/**
 * Runs the configured validators against a workspace, in declaration order.
 *
 * Sequential on purpose. Validators share one workspace and typically one build
 * cache (`tsc -b`, `node_modules/.vite`), so running them concurrently makes
 * them fight over the same files and turns a green repository into a flaky one.
 * Ordering is also what makes a report reproducible.
 *
 * Every validator runs even after one has already failed: a task author wants
 * "typecheck and lint are both broken" in a single pass, not one failure per
 * retry. Cancellation is the exception — once the signal aborts, the validator
 * in flight is killed and the remaining ones are never started, which leaves
 * `outcomes` shorter than `validators` and therefore `passed: false`.
 *
 * Never rejects: an empty list reports `{ passed: true, outcomes: [] }`, and
 * every other failure mode is folded into an outcome.
 */
export async function runValidators(
  validators: readonly ProjectValidator[],
  workspacePath: string,
  opts?: RunValidatorsOptions,
): Promise<ValidationReport> {
  const outcomes: ValidatorOutcome[] = [];

  for (const validator of validators) {
    if (opts?.signal?.aborted === true) break;

    await emit(opts, {
      type: "validation.started",
      data: { name: validator.name, command: validator.command },
    });

    const outcome = await runOne(validator, workspacePath, opts?.signal);
    outcomes.push(outcome);

    await emit(opts, {
      type: "validation.completed",
      data: {
        name: outcome.name,
        passed: outcome.passed,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
      },
    });
  }

  return {
    // A run cut short by an abort has fewer outcomes than validators, and an
    // unrun validator is not a passing one.
    passed:
      outcomes.length === validators.length &&
      outcomes.every((outcome) => outcome.passed),
    outcomes,
  };
}

/** Best-effort event emission: telemetry must never fail a validation run. */
async function emit(
  opts: RunValidatorsOptions | undefined,
  body: AgentEventBody,
): Promise<void> {
  const sink = opts?.events;
  if (sink === undefined) return;
  try {
    await sink.emit(
      agentEvent(
        {
          runId: opts?.runId ?? "",
          ...(opts?.taskId === undefined ? {} : { taskId: opts.taskId }),
        },
        body,
      ),
    );
  } catch {
    // Ignored on purpose.
  }
}
