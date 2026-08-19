import type {
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectValidator } from "../../src/project/index.js";
import { ValidatingExecutor } from "../../src/validation/index.js";
import { runValidators } from "../../src/validation/runner.js";
import {
  cleanup,
  makeRuntimeTask,
  makeTaskResult,
  makeTempDir,
} from "../workers/test-helpers.js";

// Wraps the real runner so one test can make it reject and prove that a broken
// validator harness still produces a failed task rather than a thrown one.
vi.mock("../../src/validation/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/validation/runner.js")>();
  return { ...actual, runValidators: vi.fn(actual.runValidators) };
});

/** Inner executor that hands back a canned result and records its calls. */
class StubExecutor implements WorkerExecutor {
  readonly calls: { task: RuntimeTask; agent: string }[] = [];

  constructor(
    private readonly result: TaskResult,
    private readonly model?: string,
  ) {}

  describeAgent(_agent: string): WorkerAgentDescription | undefined {
    return this.model === undefined ? undefined : { model: this.model };
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    _signal?: AbortSignal,
    _context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    this.calls.push({ task, agent });
    return this.result;
  }
}

const PASSING: ProjectValidator = { name: "typecheck", command: "true" };
const FAILING: ProjectValidator = {
  name: "test",
  command: "echo '1 test failed' 1>&2; exit 1",
};

describe("ValidatingExecutor", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("validating-executor-");
  });

  afterEach(async () => {
    await cleanup(workspace);
  });

  function executor(
    inner: WorkerExecutor,
    validators: readonly ProjectValidator[],
  ): ValidatingExecutor {
    return new ValidatingExecutor({
      inner,
      validators,
      workspacePath: workspace,
      runId: "run-1",
    });
  }

  it("records the validators it ran on a successful mutating task", async () => {
    const inner = new StubExecutor(makeTaskResult());
    const result = await executor(inner, [
      PASSING,
      { name: "lint", command: "true" },
    ]).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("success");
    expect(result.tests).toEqual({
      passed: 2,
      failed: 0,
      commands: ["true", "true"],
    });
    // Everything else the inner executor reported survives.
    expect(result.summary).toBe("Did the thing.");
    expect(result.changedFiles).toEqual(["src/a.ts"]);
    expect(result.confidence).toBe(0.8);
    expect(result.unresolvedIssues).toEqual([]);
  });

  it("fails the task when a validator fails, naming it in the issues", async () => {
    const inner = new StubExecutor(
      makeTaskResult({ unresolvedIssues: ["something the worker noted"] }),
    );

    const result = await executor(inner, [PASSING, FAILING]).execute(
      makeRuntimeTask(),
      "coder",
    );

    expect(result.status).toBe("failed");
    expect(result.confidence).toBe(0.2);
    expect(result.tests).toEqual({
      passed: 1,
      failed: 1,
      commands: [PASSING.command, FAILING.command],
    });
    expect(result.unresolvedIssues[0]).toBe("something the worker noted");
    expect(result.unresolvedIssues[1]).toContain('Validator "test" failed');
    expect(result.unresolvedIssues[1]).toContain("exit code 1");
    expect(result.unresolvedIssues[1]).toContain("1 test failed");
    // The work itself is still reported, so the failure is actionable.
    expect(result.changedFiles).toEqual(["src/a.ts"]);
  });

  it("caps the output quoted into an unresolved issue", async () => {
    const inner = new StubExecutor(makeTaskResult());
    const result = await executor(inner, [
      {
        name: "noisy",
        command: "head -c 5000 /dev/zero | tr '\\0' 'x'; exit 1",
      },
    ]).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.unresolvedIssues[0]?.length).toBeLessThan(1200);
    expect(result.unresolvedIssues[0]?.endsWith("…")).toBe(true);
  });

  it("skips validation for a read-only task type", async () => {
    const inner = new StubExecutor(makeTaskResult());
    const result = await executor(inner, [FAILING]).execute(
      makeRuntimeTask({ type: "review" }),
      "reviewer",
    );

    expect(result).toEqual(makeTaskResult());
  });

  it("skips validation when the inner executor did not succeed", async () => {
    for (const status of ["failed", "partial"] as const) {
      const inner = new StubExecutor(makeTaskResult({ status }));
      const result = await executor(inner, [FAILING]).execute(
        makeRuntimeTask(),
        "coder",
      );
      expect(result).toEqual(makeTaskResult({ status }));
    }
  });

  it("passes a mutating task through when no validators are configured", async () => {
    const inner = new StubExecutor(makeTaskResult());
    const result = await executor(inner, []).execute(
      makeRuntimeTask(),
      "coder",
    );

    expect(result.status).toBe("success");
    expect(result.tests).toEqual({ passed: 0, failed: 0, commands: [] });
  });

  it("fails the task rather than rejecting when the validator machinery breaks", async () => {
    vi.mocked(runValidators).mockRejectedValueOnce(
      new Error("runner imploded"),
    );
    const inner = new StubExecutor(makeTaskResult());

    const result = await executor(inner, [PASSING]).execute(
      makeRuntimeTask(),
      "coder",
    );

    expect(result.status).toBe("failed");
    expect(result.confidence).toBe(0.2);
    expect(result.unresolvedIssues.join("\n")).toContain("runner imploded");
  });

  it("runs validation in the workspace it was given, not the process cwd", async () => {
    const inner = new StubExecutor(makeTaskResult());
    const result = await executor(inner, [
      { name: "here", command: `test "$(pwd)" = "${workspace}"` },
    ]).execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("success");
  });

  it("forwards describeAgent to the inner executor", () => {
    const inner = new StubExecutor(makeTaskResult(), "claude-haiku-4-5");
    expect(executor(inner, []).describeAgent("coder")).toEqual({
      model: "claude-haiku-4-5",
    });
  });

  it("reports nothing when the inner executor has nothing to say", () => {
    const inner = new StubExecutor(makeTaskResult());
    expect(executor(inner, []).describeAgent("coder")).toBeUndefined();
  });
});
