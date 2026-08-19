import type { ToolContext } from "@agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentLoopWorkerExecutor,
  type AgentLoopWorkerExecutorOptions,
} from "../../src/workers/agent-loop-executor.js";
import {
  applyReviewVerdict,
  NO_VERDICT_SUMMARY,
  REVIEW_VERDICT_TOOL_NAME,
  ReviewVerdictTool,
} from "../../src/workers/review.js";
import {
  cleanup,
  MODEL,
  makeProject,
  makeProjectAgent,
  makeRuntimeTask,
  makeTaskResult,
  makeTempDir,
  ScriptedProvider,
  textTurn,
  toolCallTurn,
} from "./test-helpers.js";

function toolContext(workspacePath: string): ToolContext {
  return {
    runId: "run-1",
    taskId: "task-1",
    workspacePath,
    signal: new AbortController().signal,
  };
}

describe("ReviewVerdictTool", () => {
  const context = toolContext("/virtual");

  it("exposes the documented tool name and a JSON input schema", () => {
    const tool = new ReviewVerdictTool();
    expect(REVIEW_VERDICT_TOOL_NAME).toBe("submit_review_verdict");
    expect(tool.name).toBe(REVIEW_VERDICT_TOOL_NAME);
    const definition = tool.definition();
    expect(definition.name).toBe(REVIEW_VERDICT_TOOL_NAME);
    expect(definition.inputSchema).toMatchObject({ type: "object" });
  });

  it("starts with no verdict", () => {
    expect(new ReviewVerdictTool().verdict()).toBeUndefined();
  });

  it("records a submitted verdict and defaults issues to an empty list", async () => {
    const tool = new ReviewVerdictTool();
    const output = await tool.execute(
      { approved: true, summary: "Looks fine." },
      context,
    );

    expect(output).toEqual({ recorded: true });
    expect(tool.verdict()).toEqual({
      approved: true,
      summary: "Looks fine.",
      issues: [],
    });
  });

  it("keeps the last verdict when one is submitted twice", async () => {
    const tool = new ReviewVerdictTool();
    await tool.execute({ approved: true, summary: "First pass." }, context);
    await tool.execute(
      {
        approved: false,
        summary: "Second look: the migration is missing.",
        issues: [{ severity: "blocking", description: "No down migration." }],
      },
      context,
    );

    expect(tool.verdict()).toEqual({
      approved: false,
      summary: "Second look: the migration is missing.",
      issues: [{ severity: "blocking", description: "No down migration." }],
    });
  });

  it("rejects malformed input", async () => {
    const tool = new ReviewVerdictTool();
    await expect(
      tool.execute({ summary: "no decision" }, context),
    ).rejects.toThrow();
    await expect(
      tool.execute({ approved: true, summary: "" }, context),
    ).rejects.toThrow();
    await expect(
      tool.execute(
        {
          approved: true,
          summary: "ok",
          issues: [{ severity: "critical", description: "x" }],
        },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      tool.execute({ approved: true, summary: "ok", extra: 1 }, context),
    ).rejects.toThrow();
    expect(tool.verdict()).toBeUndefined();
  });
});

describe("applyReviewVerdict", () => {
  it("maps an approval onto a success carrying the reviewer's summary", () => {
    const result = applyReviewVerdict(makeTaskResult(), {
      approved: true,
      summary: "The retry logic is correct.",
      issues: [{ severity: "advisory", description: "Consider a jitter." }],
    });

    expect(result.status).toBe("success");
    expect(result.summary).toBe("The retry logic is correct.");
    expect(result.unresolvedIssues).toEqual(["advisory: Consider a jitter."]);
  });

  it("fails the task on a rejection, with the reason and every issue", () => {
    const result = applyReviewVerdict(makeTaskResult(), {
      approved: false,
      summary: "The migration is not reversible.",
      issues: [
        { severity: "blocking", description: "No down migration." },
        { severity: "advisory", description: "Name the index." },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toBe(
      "Review rejected: The migration is not reversible.",
    );
    expect(result.unresolvedIssues).toEqual([
      "blocking: No down migration.",
      "advisory: Name the index.",
    ]);
    // The review itself ran fine, so this verdict is worth trusting.
    expect(result.confidence).toBe(0.9);
  });

  it("fails a review that never decided anything", () => {
    const result = applyReviewVerdict(makeTaskResult(), undefined);

    expect(result.status).toBe("failed");
    expect(result.summary).toBe(NO_VERDICT_SUMMARY);
    expect(result.confidence).toBe(0.1);
  });

  it("keeps a failed loop failed even when a verdict approved it", () => {
    const base = makeTaskResult({
      status: "failed",
      summary: "Run timed out after 1000ms.",
    });
    const result = applyReviewVerdict(base, {
      approved: true,
      summary: "Looks good to me.",
      issues: [],
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Run timed out after 1000ms.");
  });

  it("preserves the inner issues it was handed", () => {
    const base = makeTaskResult({ unresolvedIssues: ["worker note"] });
    const result = applyReviewVerdict(base, {
      approved: false,
      summary: "No.",
      issues: [{ severity: "blocking", description: "Missing tests." }],
    });

    expect(result.unresolvedIssues).toEqual([
      "worker note",
      "blocking: Missing tests.",
    ]);
  });
});

describe("AgentLoopWorkerExecutor - review tasks", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("review-worker-");
  });

  afterEach(async () => {
    await cleanup(workspace);
  });

  function options(provider: ScriptedProvider): AgentLoopWorkerExecutorOptions {
    return {
      project: makeProject([
        makeProjectAgent({
          name: "reviewer",
          tools: ["read", "grep", "glob", "git.diff"],
        }),
      ]),
      resolveModel: () => ({ provider, model: MODEL }),
      workspacePath: workspace,
      runId: "run-1",
    };
  }

  const reviewTask = () => makeRuntimeTask({ type: "review" });

  it("injects the verdict tool and briefs the reviewer about it", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", REVIEW_VERDICT_TOOL_NAME, {
        approved: true,
        summary: "Fine.",
      }),
      textTurn("submitted"),
    ]);

    const result = await new AgentLoopWorkerExecutor(options(provider)).execute(
      reviewTask(),
      "reviewer",
    );

    const request = provider.requests[0];
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob",
      "grep",
      "git_diff",
      REVIEW_VERDICT_TOOL_NAME,
    ]);

    const user = request?.messages[1];
    expect(user?.content).toContain(REVIEW_VERDICT_TOOL_NAME);
    expect(user?.content).toContain("exactly once");
    expect(user?.content).toContain("an undecided review does not pass");

    // The tool is allowed even though it is nowhere in the permission rules.
    const toolMessage = provider.requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.isError).toBeUndefined();
    expect(toolMessage?.content).toContain("recorded");
    expect(result.status).toBe("success");
  });

  it("does not give a non-review task the verdict tool or the review briefing", async () => {
    const provider = new ScriptedProvider([textTurn("done")]);

    await new AgentLoopWorkerExecutor(options(provider)).execute(
      makeRuntimeTask(),
      "reviewer",
    );

    const request = provider.requests[0];
    expect(request?.tools?.map((tool) => tool.name)).not.toContain(
      REVIEW_VERDICT_TOOL_NAME,
    );
    expect(request?.messages[1]?.content).not.toContain(
      REVIEW_VERDICT_TOOL_NAME,
    );
  });

  it("completes a review that approved the change", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", REVIEW_VERDICT_TOOL_NAME, {
        approved: true,
        summary: "The change is correct and covered by tests.",
        issues: [{ severity: "advisory", description: "Rename `tmp`." }],
      }),
      textTurn("verdict submitted"),
    ]);

    const result = await new AgentLoopWorkerExecutor(options(provider)).execute(
      reviewTask(),
      "reviewer",
    );

    expect(result.status).toBe("success");
    expect(result.summary).toBe("The change is correct and covered by tests.");
    expect(result.unresolvedIssues).toEqual(["advisory: Rename `tmp`."]);
  });

  it("fails a review that rejected the change, so its dependents are blocked", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", REVIEW_VERDICT_TOOL_NAME, {
        approved: false,
        summary: "The token is logged in plain text.",
        issues: [
          { severity: "blocking", description: "Redact the auth header." },
        ],
      }),
      textTurn("verdict submitted"),
    ]);

    const result = await new AgentLoopWorkerExecutor(options(provider)).execute(
      reviewTask(),
      "reviewer",
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toBe(
      "Review rejected: The token is logged in plain text.",
    );
    expect(result.unresolvedIssues).toEqual([
      "blocking: Redact the auth header.",
    ]);
    expect(result.confidence).toBe(0.9);
  });

  it("fails a review that finished without submitting a verdict", async () => {
    const provider = new ScriptedProvider([
      textTurn("Looks good to me, shipping it."),
    ]);

    const result = await new AgentLoopWorkerExecutor(options(provider)).execute(
      reviewTask(),
      "reviewer",
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toBe(NO_VERDICT_SUMMARY);
    expect(result.confidence).toBe(0.1);
  });

  it("honours the last verdict when the reviewer changes its mind", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", REVIEW_VERDICT_TOOL_NAME, {
        approved: true,
        summary: "Looks fine.",
      }),
      toolCallTurn("call-2", REVIEW_VERDICT_TOOL_NAME, {
        approved: false,
        summary: "Found a leak on a second read.",
      }),
      textTurn("done"),
    ]);

    const result = await new AgentLoopWorkerExecutor(options(provider)).execute(
      reviewTask(),
      "reviewer",
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toBe(
      "Review rejected: Found a leak on a second read.",
    );
  });
});
