import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan } from "@agent/coding-agent";
import { PlanError } from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatTable, runPlan } from "../src/plan.js";
import {
  capture,
  cleanupWorkspace,
  copyTemplateAgentDir,
  fixedPlannerFactory,
  makeWorkspace,
  REVIEW_POLICY,
  ROUTING_POLICY,
  SAMPLE_PLAN,
  task,
  throwingPlannerFactory,
  writeLock,
} from "./orchestration-fixtures.js";

describe("formatTable", () => {
  it("pads every column but the last", () => {
    const lines = formatTable(
      ["ID", "TITLE"],
      [
        ["T01", "short"],
        ["T100", "a much longer title"],
      ],
    );
    expect(lines).toEqual([
      "ID    TITLE",
      "T01   short",
      "T100  a much longer title",
    ]);
  });
});

describe("agent plan", () => {
  let workspace: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    // Planner model resolution runs before the injected planner factory does;
    // a fake key satisfies it without any network access, since the fake
    // planner never calls the provider.
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace("cli-plan-test-");
    await copyTemplateAgentDir(workspace);
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
  });

  it("prints a routed task table for a fresh lock", async () => {
    await writeLock(workspace, ROUTING_POLICY);
    const { output, lines } = capture();

    const code = await runPlan(
      "add a health endpoint",
      { cwd: workspace, json: false },
      { output, plannerFactory: fixedPlannerFactory(SAMPLE_PLAN) },
    );

    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Objective: add a health endpoint");
    // The orchestrator agent ("lead" -> model alias "lead") supplies the
    // planner model when -m is not passed.
    expect(text).toContain("Planner: claude-opus-5 (anthropic)");
    expect(text).toContain("ID   TYPE");

    const rows = lines.filter((line) => /^T0\d\s/.test(line));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("explorer");
    expect(rows[1]).toContain("coder");
    expect(rows[2]).toContain("reviewer");
    // The dependency column carries T03's dependency on T02.
    expect(rows[2]).toContain("T02");
  });

  it("emits {plan, injectedReviews, notes, routes} in --json mode", async () => {
    await writeLock(workspace, ROUTING_POLICY);
    const { output, lines } = capture();

    const code = await runPlan(
      "add a health endpoint",
      { cwd: workspace, json: true },
      { output, plannerFactory: fixedPlannerFactory(SAMPLE_PLAN) },
    );

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(Object.keys(parsed).sort()).toEqual([
      "injectedReviews",
      "notes",
      "plan",
      "routes",
    ]);
    expect(parsed.plan.tasks).toHaveLength(3);
    expect(parsed.routes).toEqual({
      T01: "explorer",
      T02: "coder",
      T03: "reviewer",
    });
    expect(parsed.injectedReviews).toEqual([]);
  });

  it("lists the reviews the policy injected", async () => {
    await writeLock(workspace, REVIEW_POLICY);
    const plan: ExecutionPlan = {
      objective: "rotate the signing key",
      tasks: [task("T01", { risk: { level: "high", categories: ["auth"] } })],
    };
    const { output, lines } = capture();

    const code = await runPlan(
      "rotate the signing key",
      { cwd: workspace, json: false },
      { output, plannerFactory: fixedPlannerFactory(plan) },
    );

    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Injected reviews: T01-review-review-auth");
    expect(text).toContain("T01-review-review-auth");
  });

  it("fails with compile-first guidance when no lock exists", async () => {
    const { output, errLines } = capture();

    const code = await runPlan(
      "add a health endpoint",
      { cwd: workspace, json: false },
      { output, plannerFactory: fixedPlannerFactory(SAMPLE_PLAN) },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("kapel policy compile");
  });

  it("fails when orchestration.md changed after the lock was written", async () => {
    await writeLock(workspace, ROUTING_POLICY);
    const orchestrationPath = path.join(
      workspace,
      ".agent",
      "orchestration.md",
    );
    await writeFile(
      orchestrationPath,
      "Route everything to the lead.\n",
      "utf8",
    );

    const { output, errLines } = capture();
    const code = await runPlan(
      "add a health endpoint",
      { cwd: workspace, json: false },
      { output, plannerFactory: fixedPlannerFactory(SAMPLE_PLAN) },
    );

    expect(code).toBe(1);
    const text = errLines.join("\n");
    expect(text).toContain("orchestration.md has changed");
    expect(text).toContain("kapel policy compile");
  });

  it("fails when no .agent directory exists", async () => {
    const bare = await makeWorkspace("cli-plan-bare-");
    try {
      const { output, errLines } = capture();
      const code = await runPlan(
        "add a health endpoint",
        { cwd: bare, json: false },
        { output, plannerFactory: fixedPlannerFactory(SAMPLE_PLAN) },
      );
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("kapel init");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("rejects a plan the policy rewrite finds unrunnable", async () => {
    await writeLock(workspace, ROUTING_POLICY);
    const broken: ExecutionPlan = {
      objective: "add a health endpoint",
      tasks: [task("T01", { dependencies: ["T99"] })],
    };
    const { output, errLines } = capture();

    const code = await runPlan(
      "add a health endpoint",
      { cwd: workspace, json: false },
      { output, plannerFactory: fixedPlannerFactory(broken) },
    );

    expect(code).toBe(1);
    const text = errLines.join("\n");
    expect(text).toContain("cannot be executed under this policy");
    expect(text).toContain("T99");
  });

  it("reports attempts and issues when the planner gives up", async () => {
    await writeLock(workspace, ROUTING_POLICY);
    const { output, errLines } = capture();

    const code = await runPlan(
      "add a health endpoint",
      { cwd: workspace, json: false },
      {
        output,
        plannerFactory: throwingPlannerFactory(
          new PlanError({
            message: "Failed to plan the objective after 3 attempt(s).",
            attempts: 3,
            lastIssues: [{ path: "tasks.0.id", message: "Duplicate task id." }],
          }),
        ),
      },
    );

    expect(code).toBe(1);
    const text = errLines.join("\n");
    expect(text).toContain("Attempts: 3");
    expect(text).toContain("tasks.0.id: Duplicate task id.");
  });

  it("falls back to the default model, with a note, when the orchestrator can't be used", async () => {
    await writeLock(workspace, { ...ROUTING_POLICY, orchestrator: "ghost" });
    const { output, lines, errLines } = capture();

    const code = await runPlan(
      "add a health endpoint",
      { cwd: workspace, json: false },
      { output, plannerFactory: fixedPlannerFactory(SAMPLE_PLAN) },
    );

    expect(code).toBe(0);
    expect(errLines.join("\n")).toContain('orchestrator agent "ghost"');
    expect(lines.join("\n")).toContain("Planner: claude-sonnet-5 (anthropic)");
  });
});
