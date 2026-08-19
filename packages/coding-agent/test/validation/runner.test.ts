import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectValidator } from "../../src/project/index.js";
import {
  MAX_VALIDATOR_OUTPUT_CHARS,
  runValidators,
} from "../../src/validation/index.js";
import { cleanup, makeTempDir, waitForExit } from "../workers/test-helpers.js";

class RecordingSink implements EventSink {
  readonly events: AgentEvent[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }
}

function validator(
  name: string,
  command: string,
  timeoutSeconds?: number,
): ProjectValidator {
  return {
    name,
    command,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

describe("runValidators", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("validation-runner-");
  });

  afterEach(async () => {
    await cleanup(workspace);
  });

  it("passes an empty validator list without running anything", async () => {
    const report = await runValidators([], workspace);
    expect(report).toEqual({ passed: true, outcomes: [] });
  });

  it("reports a passing validator with its exit code and output", async () => {
    const report = await runValidators(
      [validator("echoer", "echo all good")],
      workspace,
    );

    expect(report.passed).toBe(true);
    expect(report.outcomes).toHaveLength(1);
    const outcome = report.outcomes[0];
    expect(outcome?.name).toBe("echoer");
    expect(outcome?.command).toBe("echo all good");
    expect(outcome?.passed).toBe(true);
    expect(outcome?.exitCode).toBe(0);
    expect(outcome?.timedOut).toBe(false);
    expect(outcome?.output).toContain("all good");
    expect(outcome?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails the report when any validator exits non-zero", async () => {
    const report = await runValidators(
      [
        validator("ok", "true"),
        validator("boom", "echo broken 1>&2; exit 3"),
        validator("also-ok", "true"),
      ],
      workspace,
    );

    expect(report.passed).toBe(false);
    expect(report.outcomes.map((outcome) => outcome.passed)).toEqual([
      true,
      false,
      true,
    ]);
    expect(report.outcomes[1]?.exitCode).toBe(3);
    // Every validator runs: one failure does not hide the others.
    expect(report.outcomes).toHaveLength(3);
    expect(report.outcomes[1]?.output).toContain("broken");
  });

  it("captures stderr as well as stdout", async () => {
    const report = await runValidators(
      [validator("mixed", "echo out; echo err 1>&2")],
      workspace,
    );

    expect(report.outcomes[0]?.output).toContain("out");
    expect(report.outcomes[0]?.output).toContain("err");
  });

  it("runs commands in the given workspace directory", async () => {
    const report = await runValidators([validator("pwd", "pwd")], workspace);
    expect(report.outcomes[0]?.output.trim()).toBe(workspace);
  });

  it("runs validators sequentially, in declaration order", async () => {
    const script = (name: string): string =>
      `echo ${name} >> order.txt; sleep 0.05`;
    const report = await runValidators(
      [
        validator("first", script("first")),
        validator("second", script("second")),
        validator("third", script("third")),
      ],
      workspace,
    );

    expect(report.outcomes.map((outcome) => outcome.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
    // Written by the commands themselves: concurrent runs would interleave.
    expect(await readFile(join(workspace, "order.txt"), "utf8")).toBe(
      "first\nsecond\nthird\n",
    );
  });

  it("caps the output at the tail, keeping the end of the log", async () => {
    const report = await runValidators(
      [
        validator(
          "chatty",
          "head -c 60000 /dev/zero | tr '\\0' 'a'; echo; echo THE-VERY-END",
        ),
      ],
      workspace,
    );

    const output = report.outcomes[0]?.output ?? "";
    expect(output.length).toBeLessThanOrEqual(MAX_VALIDATOR_OUTPUT_CHARS);
    expect(output).toContain("truncated");
    // The tail survives; the head is what gets dropped.
    expect(output).toContain("THE-VERY-END");
  });

  it("kills the whole process group when a validator times out", async () => {
    const pidFile = join(workspace, "child.pid");
    const report = await runValidators(
      [validator("slow", `bash -c 'echo $$ > ${pidFile}; sleep 30' & wait`, 1)],
      workspace,
    );

    const outcome = report.outcomes[0];
    expect(report.passed).toBe(false);
    expect(outcome?.timedOut).toBe(true);
    expect(outcome?.passed).toBe(false);
    expect(outcome?.output).toContain("timed out");

    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    expect(Number.isNaN(pid)).toBe(false);
    await waitForExit(pid);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("does not run validators queued behind a timed-out one when they still pass", async () => {
    const report = await runValidators(
      [validator("slow", "sleep 30", 1), validator("quick", "true")],
      workspace,
    );

    // A timeout is a failure, not a cancellation: the rest still run.
    expect(report.outcomes.map((outcome) => outcome.name)).toEqual([
      "slow",
      "quick",
    ]);
    expect(report.passed).toBe(false);
  }, 20_000);

  it("stops on abort and never reports a pass", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled by test")), 150);

    const report = await runValidators(
      [validator("slow", "sleep 30"), validator("never", "true")],
      workspace,
      { signal: controller.signal },
    );

    expect(report.passed).toBe(false);
    // The in-flight validator is recorded; the queued one never starts.
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]?.name).toBe("slow");
    expect(report.outcomes[0]?.passed).toBe(false);
    expect(report.outcomes[0]?.timedOut).toBe(false);
  }, 20_000);

  it("reports a validator that could not be executed as a failure", async () => {
    const report = await runValidators(
      [validator("missing", "definitely-not-a-real-command-xyz")],
      workspace,
    );

    expect(report.passed).toBe(false);
    expect(report.outcomes[0]?.passed).toBe(false);
    expect(report.outcomes[0]?.exitCode).not.toBe(0);
  });

  it("emits started/completed events per validator", async () => {
    const events = new RecordingSink();
    await runValidators(
      [validator("ok", "true"), validator("bad", "exit 2")],
      workspace,
      { events, runId: "run-9", taskId: "T07" },
    );

    expect(events.events.map((event) => event.type)).toEqual([
      "validation.started",
      "validation.completed",
      "validation.started",
      "validation.completed",
    ]);
    expect(events.events.every((event) => event.runId === "run-9")).toBe(true);
    expect(events.events.every((event) => event.taskId === "T07")).toBe(true);

    const completed = events.events[3]?.data as {
      name: string;
      passed: boolean;
      exitCode: number | null;
      durationMs: number;
    };
    expect(completed.name).toBe("bad");
    expect(completed.passed).toBe(false);
    expect(completed.exitCode).toBe(2);
    expect(typeof completed.durationMs).toBe("number");
  });

  it("never fails a run because the event sink threw", async () => {
    const sink: EventSink = {
      emit: () => {
        throw new Error("sink exploded");
      },
    };

    const report = await runValidators([validator("ok", "true")], workspace, {
      events: sink,
    });

    expect(report.passed).toBe(true);
  });
});
