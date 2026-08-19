import { describe, expect, it } from "vitest";
import { diffPolicies, formatPolicyDiff, PolicySchema } from "../src/index.js";

const BASE = PolicySchema.parse({
  version: 1,
  orchestrator: "architect",
  maxConcurrency: 3,
  parallelizeIndependentTasks: true,
  defaultMaxAttempts: 2,
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

describe("diffPolicies", () => {
  it("reports no changes for an identical policy", () => {
    const diff = diffPolicies(BASE, BASE);
    expect(diff.unchanged).toBe(true);
    expect(diff.defaults).toEqual([]);
    expect(diff.routing).toEqual([]);
    expect(diff.review).toEqual([]);
    expect(diff.escalation).toEqual([]);
  });

  it("reports no changes when array-valued fields are only reordered", () => {
    const reordered = PolicySchema.parse({
      ...BASE,
      routing: [
        { ...BASE.routing[1] },
        { ...BASE.routing[0], taskTypes: ["cleanup", "refactor"] },
      ],
    });
    const diff = diffPolicies(BASE, reordered);
    expect(diff.unchanged).toBe(true);
  });

  it("identifies an added rule by id", () => {
    const after = PolicySchema.parse({
      ...BASE,
      routing: [
        ...BASE.routing,
        {
          id: "route-docs",
          taskTypes: ["docs"],
          agent: "writer",
          strength: "preference",
          weight: 1,
        },
      ],
    });
    const diff = diffPolicies(BASE, after);
    expect(diff.unchanged).toBe(false);
    expect(diff.routing).toHaveLength(1);
    const [added] = diff.routing;
    expect(added?.kind).toBe("added");
    expect(added?.id).toBe("route-docs");
    if (added?.kind === "added") expect(added.after.agent).toBe("writer");
  });

  it("identifies a removed rule by id", () => {
    const after = PolicySchema.parse({
      ...BASE,
      review: [],
    });
    const diff = diffPolicies(BASE, after);
    expect(diff.review).toHaveLength(1);
    const [removed] = diff.review;
    expect(removed?.kind).toBe("removed");
    expect(removed?.id).toBe("review-auth");
  });

  it("identifies a changed rule with field-level detail", () => {
    const after = PolicySchema.parse({
      ...BASE,
      routing: [
        { ...BASE.routing[0], agent: "reviewer", weight: 0.9 },
        BASE.routing[1],
      ],
    });
    const diff = diffPolicies(BASE, after);
    expect(diff.routing).toHaveLength(1);
    const [changed] = diff.routing;
    expect(changed?.kind).toBe("changed");
    expect(changed?.id).toBe("route-refactors");
    if (changed?.kind === "changed") {
      const fields = changed.changes.map((change) => change.field).sort();
      expect(fields).toEqual(["agent", "weight"]);
      const agentChange = changed.changes.find(
        (change) => change.field === "agent",
      );
      expect(agentChange).toEqual({
        field: "agent",
        before: "implementer",
        after: "reviewer",
      });
    }
  });

  it("reports a changed default field", () => {
    const after = PolicySchema.parse({ ...BASE, maxConcurrency: 8 });
    const diff = diffPolicies(BASE, after);
    expect(diff.unchanged).toBe(false);
    expect(diff.defaults).toEqual([
      { field: "maxConcurrency", before: 3, after: 8 },
    ]);
  });

  it("diffs escalation rules by id, changed and unchanged separately", () => {
    const after = PolicySchema.parse({
      ...BASE,
      escalation: [{ ...BASE.escalation[0], afterFailures: 5 }],
    });
    const diff = diffPolicies(BASE, after);
    expect(diff.escalation).toHaveLength(1);
    const [changed] = diff.escalation;
    expect(changed?.kind).toBe("changed");
    if (changed?.kind === "changed") {
      expect(changed.changes).toEqual([
        { field: "afterFailures", before: 2, after: 5 },
      ]);
    }
  });
});

describe("formatPolicyDiff", () => {
  it("says 'No changes.' when the policy is unchanged", () => {
    expect(formatPolicyDiff(diffPolicies(BASE, BASE))).toEqual(["No changes."]);
  });

  it("renders added/removed/changed rules and defaults together", () => {
    const after = PolicySchema.parse({
      ...BASE,
      maxConcurrency: 8,
      routing: [
        { ...BASE.routing[0], agent: "reviewer" },
        {
          id: "route-docs",
          taskTypes: ["docs"],
          agent: "writer",
          strength: "preference",
          weight: 1,
        },
      ],
      review: [],
    });
    const diff = diffPolicies(BASE, after);
    const lines = formatPolicyDiff(diff);
    const text = lines.join("\n");

    expect(text).toContain("Defaults:");
    expect(text).toContain("maxConcurrency: 3 -> 8");
    expect(text).toContain("Routing rules:");
    expect(text).toContain("~ route-refactors:");
    expect(text).toContain("agent: implementer -> reviewer");
    expect(text).toContain("+ route-docs:");
    expect(text).toContain("- route-security:");
    expect(text).toContain("Review rules:");
    expect(text).toContain("- review-auth:");
  });
});
