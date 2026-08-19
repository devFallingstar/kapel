import { describe, expect, it } from "vitest";
import { describePolicy, PolicySchema } from "../src/index.js";

const policy = PolicySchema.parse({
  version: 1,
  orchestrator: "architect",
  maxConcurrency: 3,
  routing: [
    {
      id: "route-refactors",
      taskTypes: ["refactor", "cleanup"],
      agent: "implementer",
      strength: "preference",
      weight: 0.5,
    },
    {
      id: "route-security",
      riskCategories: ["auth"],
      complexity: ["complex", "architectural"],
      agent: "reviewer",
      strength: "hard",
    },
  ],
  review: [
    {
      id: "review-auth",
      riskCategories: ["auth"],
      minimumComplexity: "normal",
      reviewer: "reviewer",
    },
  ],
  escalation: [
    {
      id: "escalate-stuck",
      fromAgent: "implementer",
      toAgent: "architect",
      afterFailures: 2,
      confidenceBelow: 0.4,
    },
  ],
});

describe("describePolicy", () => {
  it("renders a plain-English summary, one line per rule", () => {
    const lines = describePolicy(policy).split("\n");
    expect(lines).toEqual([
      "Orchestrator: architect",
      "Concurrency: up to 3 agents at a time",
      "Independent tasks: may run in parallel",
      "Attempts per task: 2 before giving up",
      "Routing rules (2):",
      "- route-refactors: prefer to route refactor and cleanup tasks to implementer [weight 0.5]",
      "- route-security: always route tasks touching auth of complex and architectural complexity to reviewer",
      "Review rules (1):",
      "- review-auth: reviewer reviews tasks touching auth at normal complexity or above; review must pass before the work lands (required)",
      "Escalation rules (1):",
      "- escalate-stuck: hand off from implementer to architect after 2 failed attempts and when confidence drops below 0.4",
    ]);
  });

  it("says so when a rule kind is empty", () => {
    const bare = PolicySchema.parse({
      version: 1,
      orchestrator: "solo",
      maxConcurrency: 1,
      parallelizeIndependentTasks: false,
    });
    const text = describePolicy(bare);
    expect(text).toContain("Concurrency: up to 1 agent at a time");
    expect(text).toContain("Independent tasks: run one at a time");
    expect(text).toContain("Routing rules: none");
    expect(text).toContain("Review rules: none");
    expect(text).toContain("Escalation rules: none");
  });
});
