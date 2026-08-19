import type { AgentEvent } from "@agent/protocol";
import { SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explainRoute, runExplainCommand } from "../src/explain-cmd.js";
import { sessionDbPathFor } from "../src/sessions.js";
import {
  capture,
  cleanupWorkspace,
  makeWorkspace,
  makeWorkspaceWithAgentDir,
  ROUTING_POLICY,
  SAMPLE_PLAN,
  task,
} from "./orchestration-fixtures.js";

const RUN_ID = "run-explain";
const START = 1_700_000_000_000;

let seq = 0;

function event(
  type: string,
  taskId: string,
  data: Record<string, unknown>,
): AgentEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    runId: RUN_ID,
    timestamp: START + seq * 1000,
    type,
    taskId,
    data,
  };
}

/**
 * A realistic T03 history: held behind a conflicting task, one failing
 * attempt, an escalation, then a clean second attempt that merged.
 */
const T03_EVENTS: readonly AgentEvent[] = [
  event("task.held", "T03", { conflictsWith: "T02" }),
  event("task.started", "T03", { agent: "reviewer", attempt: 1 }),
  event("validation.started", "T03", { name: "test" }),
  event("validation.completed", "T03", {
    name: "test",
    passed: false,
    exitCode: 1,
    durationMs: 2400,
  }),
  event("task.completed", "T03", {
    agent: "reviewer",
    attempt: 1,
    final: false,
    result: { status: "failed", summary: "the suite is red\nmore detail" },
  }),
  event("task.escalated", "T03", {
    from: "reviewer",
    to: "lead",
    rule: "escalate-review",
  }),
  event("task.started", "T03", { agent: "lead", attempt: 2 }),
  event("task.low_confidence", "T03", {
    agent: "lead",
    confidence: 0.4,
    threshold: 0.7,
    rule: "escalate-review",
    accepted: true,
  }),
  event("worktree.integrated", "T03", {
    merged: true,
    commit: "4b1c9de012345678",
  }),
  event("task.completed", "T03", {
    agent: "lead",
    attempt: 2,
    final: true,
    result: { status: "success", summary: "Covered the endpoint." },
  }),
  // Worker chatter the digest must leave out.
  event("tool.execution.started", "T03", { tool: "bash", input: "ls" }),
];

describe("explainRoute", () => {
  it("names the routing rule that decided the agent", () => {
    const route = explainRoute(
      task("T02", { type: "implementation" }),
      ROUTING_POLICY,
    );
    expect(route).toEqual({ agent: "coder", rule: "route-impl" });
  });

  it("reports the suggestedAgent fallback when no rule matches", () => {
    const route = explainRoute(
      task("T09", { type: "documentation", suggestedAgent: "scribe" }),
      ROUTING_POLICY,
    );
    expect(route).toEqual({ agent: "scribe", fallback: "suggestedAgent" });
  });

  it("reports the orchestrator fallback when nothing else applies", () => {
    const route = explainRoute(
      task("T09", { type: "documentation" }),
      ROUTING_POLICY,
    );
    expect(route).toEqual({ agent: "lead", fallback: "orchestrator" });
  });
});

describe("agent explain", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspaceWithAgentDir("cli-explain-test-");
    const store = new SqliteSessionStore({ path: sessionDbPathFor(workspace) });
    try {
      await store.createRun({
        id: RUN_ID,
        objective: "add a health endpoint",
        createdAt: START,
        policySnapshot: ROUTING_POLICY,
      });
      await store.savePlan(RUN_ID, SAMPLE_PLAN);
      for (const entry of T03_EVENTS) await store.appendEvent(entry);
      await store.setRunStatus(RUN_ID, "completed");
    } finally {
      store.close();
    }
  });

  afterEach(async () => {
    await cleanupWorkspace(workspace);
  });

  it("digests the task's decisions and re-derives its routing", async () => {
    const { output, lines } = capture();

    const code = await runExplainCommand(
      "T03",
      { cwd: workspace, json: false },
      { output },
    );

    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Task T03 — Cover the endpoint");
    expect(text).toContain(`Run ${RUN_ID}`);
    // The task ended on lead, after two attempts.
    expect(text).toContain("Agent: lead — 2 attempts, success");
    expect(text).toContain("Routing: routed to reviewer by rule route-test");

    expect(text).toContain("held — serialized behind T02");
    expect(text).toContain("started — agent reviewer, attempt 1");
    expect(text).toContain("validator failed — test (exit 1)");
    expect(text).toContain("completed — failed: the suite is red (retrying)");
    expect(text).toContain(
      "escalated — reviewer → lead by rule escalate-review",
    );
    expect(text).toContain("started — agent lead, attempt 2");
    expect(text).toContain(
      "low confidence — 0.40 < 0.70, accepted (attempts exhausted)",
    );
    expect(text).toContain("merged → 4b1c9de0");
    expect(text).toContain("completed — success: Covered the endpoint.");
    // Worker chatter stays out of a decisions digest.
    expect(text).not.toContain("bash");

    // Chronological: the first attempt is reported before the escalation.
    expect(text.indexOf("attempt 1")).toBeLessThan(text.indexOf("escalated"));
  });

  it("emits a structured digest under --json", async () => {
    const { output, lines } = capture();

    const code = await runExplainCommand(
      "T03",
      { cwd: workspace, json: true, run: RUN_ID },
      { output },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.task.id).toBe("T03");
    expect(parsed.agent).toBe("lead");
    expect(parsed.attempts).toBe(2);
    expect(parsed.route).toEqual({ agent: "reviewer", rule: "route-test" });
    expect(parsed.events.map((entry: { type: string }) => entry.type)).toEqual([
      "task.held",
      "task.started",
      "validation.completed",
      "task.completed",
      "task.escalated",
      "task.started",
      "task.low_confidence",
      "worktree.integrated",
      "task.completed",
    ]);
  });

  it("rejects an unknown task, naming the ones the run has", async () => {
    const { output, errLines } = capture();

    const code = await runExplainCommand(
      "T99",
      { cwd: workspace, json: false },
      { output },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("has no task T99");
    expect(errLines.join("\n")).toContain("T01, T02, T03");
  });

  it("rejects an unknown run", async () => {
    const { output, errLines } = capture();

    const code = await runExplainCommand(
      "T03",
      { cwd: workspace, json: false, run: "nope" },
      { output },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("Unknown run nope");
  });

  it("says so when the workspace has recorded nothing at all", async () => {
    const bare = await makeWorkspace("cli-explain-empty-");
    try {
      const { output, errLines } = capture();
      const code = await runExplainCommand(
        "T01",
        { cwd: bare, json: false },
        { output },
      );

      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("No runs recorded yet");
    } finally {
      await cleanupWorkspace(bare);
    }
  });
});
