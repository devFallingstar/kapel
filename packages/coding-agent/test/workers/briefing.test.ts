import type { TaskResult, WorkerExecutionContext } from "@agent/orchestration";
import { describe, expect, it } from "vitest";
import {
  buildTaskBriefing,
  buildWorkerSystemPrompt,
  DEFAULT_HANDOFF,
  DEFAULT_REVIEWER_GUIDANCE,
  DEFAULT_WORKER_GUIDANCE,
  WORKER_SYSTEM_POSTAMBLE,
} from "../../src/workers/briefing.js";
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

  it("tells the worker that a configured validation: block runs after it, not that it must run checks itself", () => {
    const briefing = buildTaskBriefing(makePlannedTask(), "coder");
    expect(briefing).toContain("validation:");
    expect(briefing).toContain("not expected to run checks yourself");
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

  describe("handoff guidance", () => {
    const reviewTask = makePlannedTask({ type: "review" });

    it("uses the built-in text when no handoff is supplied", () => {
      const briefing = buildTaskBriefing(makePlannedTask(), "coder");

      expect(briefing).toContain(
        "\n\nWork directly in the current workspace. Return a short summary of what you changed.\nIf this project configures validators (.agent/config.yaml's `validation:` block), they run against your change after you finish — you are not expected to run checks yourself.",
      );
      expect(briefing).toContain(DEFAULT_WORKER_GUIDANCE);
      // The empty handoff is the same as none: nothing was replaced.
      expect(buildTaskBriefing(makePlannedTask(), "coder", undefined, {})).toBe(
        briefing,
      );
      expect(
        buildTaskBriefing(makePlannedTask(), "coder", undefined, {
          handoff: {},
        }),
      ).toBe(briefing);
    });

    it("replaces the standing guidance with the project's `## worker` text", () => {
      const briefing = buildTaskBriefing(
        makePlannedTask(),
        "coder",
        undefined,
        {
          handoff: { worker: "Commit nothing. Leave the tree dirty." },
        },
      );

      expect(briefing).toContain("Commit nothing. Leave the tree dirty.");
      expect(briefing).not.toContain("Work directly in the current workspace");
      expect(briefing).not.toContain("validation:");
      // Per-task facts are data, not guidance: they survive any replacement.
      expect(briefing).toContain("Title: Add retry to the uploader");
      expect(briefing).toContain("packages/uploader");
      expect(briefing).toContain("Risk level: medium");
    });

    it("replaces only the sections the project actually supplied", () => {
      const briefing = buildTaskBriefing(reviewTask, "reviewer", undefined, {
        handoff: { worker: "Only the worker block moved." },
      });

      expect(briefing).toContain("Only the worker block moved.");
      expect(briefing).not.toContain("Work directly in the current workspace");
      // `## reviewer` was absent, so the built-in reviewer guidance stands.
      expect(briefing).toContain(DEFAULT_REVIEWER_GUIDANCE);
    });

    it("treats a present-but-empty section as deliberately blank", () => {
      const briefing = buildTaskBriefing(
        makePlannedTask(),
        "coder",
        undefined,
        {
          handoff: { worker: "" },
        },
      );

      expect(briefing).not.toContain("Work directly in the current workspace");
      expect(briefing).not.toContain("validation:");
      // Nothing is appended at all, so the briefing ends on the last task fact.
      expect(briefing.endsWith("Risk categories: reliability")).toBe(true);
    });

    it("replaces the reviewer guidance but never the verdict tool contract", () => {
      const briefing = buildTaskBriefing(reviewTask, "reviewer", undefined, {
        handoff: { reviewer: "Judge only whether the tests are honest." },
      });

      expect(briefing).toContain("## Review task — a verdict is required");
      expect(briefing).toContain("Judge only whether the tests are honest.");
      expect(briefing).not.toContain("not writing code yourself");
      expect(briefing).toContain(
        `You MUST call the \`${REVIEW_VERDICT_TOOL_NAME}\` tool exactly once`,
      );
      expect(briefing).toContain("an undecided review does not pass");
      // Guidance first, machine contract after it.
      expect(briefing.indexOf("Judge only whether")).toBeLessThan(
        briefing.indexOf(REVIEW_VERDICT_TOOL_NAME),
      );
    });

    it("replaces the reviewer guidance but never the JSON reply contract", () => {
      const briefing = buildTaskBriefing(reviewTask, "reviewer", undefined, {
        reviewContract: "json-reply",
        handoff: { reviewer: "Judge only whether the tests are honest." },
      });

      expect(briefing).toContain("Judge only whether the tests are honest.");
      expect(briefing).not.toContain("not writing code yourself");
      expect(briefing).toContain("Do not edit, create or delete any file");
      expect(briefing).toContain(
        "Your final message MUST contain exactly one JSON",
      );
      // The schema still round-trips through the parser that reads the reply.
      expect(parseReviewVerdictReply(briefing).verdict?.approved).toBe(false);
      expect(briefing.indexOf("Judge only whether")).toBeLessThan(
        briefing.indexOf('"approved": false'),
      );
    });

    it("keeps both verdict contracts intact when the reviewer section is blank", () => {
      const tool = buildTaskBriefing(reviewTask, "reviewer", undefined, {
        handoff: { reviewer: "" },
      });
      const json = buildTaskBriefing(reviewTask, "reviewer", undefined, {
        reviewContract: "json-reply",
        handoff: { reviewer: "" },
      });

      expect(tool).not.toContain("not writing code yourself");
      expect(tool).toContain("## Review task — a verdict is required");
      expect(tool).toContain(
        `You MUST call the \`${REVIEW_VERDICT_TOOL_NAME}\` tool exactly once`,
      );
      // No stray blank line where the guidance used to be.
      expect(tool).toContain(
        "## Review task — a verdict is required\n\nYou MUST call",
      );

      expect(json).not.toContain("not writing code yourself");
      expect(json).toContain("Do not edit, create or delete any file");
      expect(parseReviewVerdictReply(json).verdict?.approved).toBe(false);
    });

    it("re-applying the built-in defaults changes nothing", () => {
      // The shipped template is DEFAULT_HANDOFF spelled out, so a project that
      // copies it and edits nothing must get exactly the unconfigured briefing.
      for (const task of [makePlannedTask(), reviewTask]) {
        for (const reviewContract of ["tool", "json-reply"] as const) {
          expect(
            buildTaskBriefing(task, "coder", undefined, {
              reviewContract,
              handoff: DEFAULT_HANDOFF,
            }),
          ).toBe(
            buildTaskBriefing(task, "coder", undefined, { reviewContract }),
          );
        }
      }
    });
  });
});

describe("buildWorkerSystemPrompt", () => {
  it("appends the built-in postamble when no handoff is supplied", () => {
    expect(buildWorkerSystemPrompt("You are the coder.")).toBe(
      `You are the coder.\n\n${WORKER_SYSTEM_POSTAMBLE}`,
    );
    expect(buildWorkerSystemPrompt("  ")).toBe(WORKER_SYSTEM_POSTAMBLE);
    expect(buildWorkerSystemPrompt("You are the coder.", {})).toBe(
      `You are the coder.\n\n${WORKER_SYSTEM_POSTAMBLE}`,
    );
    expect(buildWorkerSystemPrompt("You are the coder.", DEFAULT_HANDOFF)).toBe(
      `You are the coder.\n\n${WORKER_SYSTEM_POSTAMBLE}`,
    );
  });

  it("replaces the postamble with the project's `## common` text", () => {
    expect(
      buildWorkerSystemPrompt("You are the coder.", {
        common: "Ship small changes.",
      }),
    ).toBe("You are the coder.\n\nShip small changes.");
  });

  it("appends nothing when `## common` is present but blank", () => {
    expect(buildWorkerSystemPrompt("You are the coder.", { common: "" })).toBe(
      "You are the coder.",
    );
    expect(buildWorkerSystemPrompt("", { common: "" })).toBe("");
  });
});
