import type { TaskResult, WorkerExecutionContext } from "@agent/orchestration";
import { describe, expect, it } from "vitest";
import { buildTaskBriefing } from "../../src/workers/briefing.js";
import {
  parseReviewVerdictReply,
  REVIEW_VERDICT_TOOL_NAME,
} from "../../src/workers/review.js";
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

  describe("review contract", () => {
    const reviewTask = makePlannedTask({ type: "review" });

    it("adds no review section to a non-review task, in either contract", () => {
      for (const options of [
        undefined,
        { reviewContract: "json-reply" } as const,
      ]) {
        const briefing = buildTaskBriefing(
          makePlannedTask(),
          "coder",
          undefined,
          options,
        );
        expect(briefing).not.toContain("## Review task");
      }
    });

    it("demands the verdict tool by default — the in-process loop's contract", () => {
      const briefing = buildTaskBriefing(reviewTask, "reviewer");

      expect(briefing).toContain("## Review task — a verdict is required");
      expect(briefing).toContain(
        `You MUST call the \`${REVIEW_VERDICT_TOOL_NAME}\` tool exactly once`,
      );
      expect(briefing).toContain("an undecided review does not pass");
      expect(briefing).not.toContain('"approved"');
    });

    it("demands a JSON verdict in the reply for a delegated backend", () => {
      const briefing = buildTaskBriefing(reviewTask, "reviewer", undefined, {
        reviewContract: "json-reply",
      });

      expect(briefing).toContain("## Review task — a verdict is required");
      // No tool exists on a CLI backend, so it must not be named as the way out.
      expect(briefing).not.toContain(REVIEW_VERDICT_TOOL_NAME);
      expect(briefing).toContain(
        "Your final message MUST contain exactly one JSON",
      );
      expect(briefing).toContain('"approved": false');
      expect(briefing).toContain('"severity": "blocking"');
      expect(briefing).toContain("Do not edit, create or delete any file");
      expect(briefing).toContain("an undecided review does not pass");
    });

    it("shows an example the parser actually accepts", () => {
      // Drift guard: the prose in the briefing and the schema in review.ts are
      // written out separately, so the briefing's own example has to survive a
      // round trip through the parser that will read the reviewer's reply.
      const briefing = buildTaskBriefing(reviewTask, "reviewer", undefined, {
        reviewContract: "json-reply",
      });

      const parsed = parseReviewVerdictReply(briefing);
      expect(parsed.issues).toEqual([]);
      expect(parsed.verdict).toEqual({
        approved: false,
        summary: "One short paragraph explaining the decision.",
        issues: [
          {
            severity: "blocking",
            description: "What is wrong, specific enough to act on.",
          },
        ],
      });
    });
  });
});
