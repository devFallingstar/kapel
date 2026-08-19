import type { TaskResult, WorkerExecutionContext } from "@agent/orchestration";
import { describe, expect, it } from "vitest";
import { buildTaskBriefing } from "../../src/workers/briefing.js";
import { makePlannedTask, makeTaskResult } from "./test-helpers.js";

function context(...results: TaskResult[]): WorkerExecutionContext {
  return { dependencyResults: results };
}

describe("buildTaskBriefing", () => {
  it("describes the task without a dependency section when there is no context", () => {
    const briefing = buildTaskBriefing(makePlannedTask(), "coder");

    expect(briefing).toContain('You are acting as the "coder" worker on task');
    expect(briefing).toContain("Title: Add retry to the uploader");
    expect(briefing).not.toContain("Results from dependency tasks");
  });

  it("omits the dependency section when the context carries no results", () => {
    const briefing = buildTaskBriefing(makePlannedTask(), "coder", context());
    expect(briefing).not.toContain("Results from dependency tasks");
  });

  it("renders each dependency's id, status, summary and changed files", () => {
    const briefing = buildTaskBriefing(
      makePlannedTask({ dependencies: ["T01", "T02"] }),
      "coder",
      context(
        makeTaskResult({
          taskId: "T01",
          summary: "Added the /healthz route.",
          changedFiles: ["src/server.ts", "src/routes.ts"],
        }),
        makeTaskResult({
          taskId: "T02",
          status: "partial",
          summary: "Wrote the test but could not run it.",
          changedFiles: [],
        }),
      ),
    );

    expect(briefing).toContain("## Results from dependency tasks");
    expect(briefing).toContain("### T01 — success");
    expect(briefing).toContain("Added the /healthz route.");
    expect(briefing).toContain("Changed files:");
    expect(briefing).toContain("  - src/server.ts");
    expect(briefing).toContain("### T02 — partial");
    expect(briefing).toContain("Wrote the test but could not run it.");
    // A dependency with no changed files contributes no file list at all.
    expect(briefing.split("Changed files:")).toHaveLength(2);
  });

  it("truncates a long summary and caps the file list", () => {
    const briefing = buildTaskBriefing(
      makePlannedTask(),
      "coder",
      context(
        makeTaskResult({
          summary: "x".repeat(900),
          changedFiles: Array.from(
            { length: 25 },
            (_unused, index) => `src/file-${index}.ts`,
          ),
        }),
      ),
    );

    expect(briefing).toContain(`${"x".repeat(400)}…`);
    expect(briefing).not.toContain("x".repeat(401));
    expect(briefing).toContain("  - src/file-19.ts");
    expect(briefing).not.toContain("  - src/file-20.ts");
    expect(briefing).toContain("  - ... and 5 more");
  });
});
