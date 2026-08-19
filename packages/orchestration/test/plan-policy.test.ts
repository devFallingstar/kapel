import { describe, expect, it } from "vitest";
import { applyPolicyToPlan, TaskGraph } from "../src/index.js";
import { makePlan, makePolicy, makeTask } from "./helpers.js";

const KNOWN = new Set(["architect", "implementer", "reviewer"]);

const authReview = {
  id: "auth-review",
  riskCategories: ["auth"],
  reviewer: "reviewer",
  blocking: true,
  strength: "hard",
};

describe("applyPolicyToPlan", () => {
  it("injects a review for tasks whose risk categories match a rule", () => {
    const plan = makePlan([
      makeTask({
        id: "T01",
        title: "Rework the session cookie",
        affectedAreas: ["packages/api/src/auth.ts"],
        risk: { level: "high", categories: ["auth"] },
      }),
      makeTask({
        id: "T02",
        risk: { level: "low", categories: ["docs"] },
      }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({ review: [authReview] }),
      KNOWN,
    );

    expect(result.issues).toEqual([]);
    expect(result.injectedReviews).toEqual(["T01-review-auth-review"]);
    expect(result.plan.tasks).toHaveLength(3);

    const review = result.plan.tasks[2];
    expect(review).toMatchObject({
      id: "T01-review-auth-review",
      type: "review",
      complexity: "normal",
      dependencies: ["T01"],
      suggestedAgent: "reviewer",
      affectedAreas: ["packages/api/src/auth.ts"],
      risk: { level: "high", categories: ["auth"] },
    });
    expect(review?.goal).toContain("T01");
    // The rewritten plan is still runnable.
    expect(() => new TaskGraph(result.plan)).not.toThrow();
  });

  it("applies minimumComplexity with trivial < normal < complex < architectural", () => {
    const plan = makePlan([
      makeTask({ id: "T01", complexity: "trivial" }),
      makeTask({ id: "T02", complexity: "normal" }),
      makeTask({ id: "T03", complexity: "complex" }),
      makeTask({ id: "T04", complexity: "architectural" }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({
        review: [
          {
            id: "deep",
            minimumComplexity: "complex",
            reviewer: "architect",
            blocking: true,
            strength: "hard",
          },
        ],
      }),
      KNOWN,
    );

    expect(result.injectedReviews).toEqual([
      "T03-review-deep",
      "T04-review-deep",
    ]);
  });

  it("requires both facets when a rule sets categories and complexity", () => {
    const plan = makePlan([
      makeTask({
        id: "T01",
        complexity: "trivial",
        risk: { level: "high", categories: ["auth"] },
      }),
      makeTask({
        id: "T02",
        complexity: "complex",
        risk: { level: "low", categories: ["docs"] },
      }),
      makeTask({
        id: "T03",
        complexity: "complex",
        risk: { level: "high", categories: ["auth"] },
      }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({
        review: [
          {
            id: "risky-and-deep",
            riskCategories: ["auth"],
            minimumComplexity: "normal",
            reviewer: "reviewer",
            blocking: true,
            strength: "hard",
          },
        ],
      }),
      KNOWN,
    );

    expect(result.injectedReviews).toEqual(["T03-review-risky-and-deep"]);
  });

  it("notes an unconstrained review rule and injects nothing for it", () => {
    const plan = makePlan([
      makeTask({ id: "T01", risk: { level: "high", categories: ["auth"] } }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({
        review: [
          {
            id: "catch-all",
            reviewer: "reviewer",
            blocking: true,
            strength: "hard",
          },
        ],
      }),
      KNOWN,
    );

    expect(result.injectedReviews).toEqual([]);
    expect(result.notes.join("\n")).toContain("catch-all");
    expect(result.notes.join("\n")).toContain("matches no task");
  });

  it("never injects a review for a task that is itself a review", () => {
    const plan = makePlan([
      makeTask({
        id: "T01",
        type: "review",
        risk: { level: "high", categories: ["auth"] },
      }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({ review: [authReview] }),
      KNOWN,
    );

    expect(result.injectedReviews).toEqual([]);
    expect(result.plan.tasks).toHaveLength(1);
  });

  it("does not double-inject when an equivalent review already exists", () => {
    const plan = makePlan([
      makeTask({ id: "T01", risk: { level: "high", categories: ["auth"] } }),
      makeTask({
        id: "T02",
        type: "review",
        dependencies: ["T01"],
        suggestedAgent: "reviewer",
      }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({ review: [authReview] }),
      KNOWN,
    );

    expect(result.injectedReviews).toEqual([]);
    expect(result.plan.tasks).toHaveLength(2);
  });

  it("is idempotent: re-applying the policy injects nothing new", () => {
    const plan = makePlan([
      makeTask({ id: "T01", risk: { level: "high", categories: ["auth"] } }),
    ]);
    const policy = makePolicy({ review: [authReview] });

    const once = applyPolicyToPlan(plan, policy, KNOWN);
    const twice = applyPolicyToPlan(once.plan, policy, KNOWN);

    expect(twice.injectedReviews).toEqual([]);
    expect(twice.plan.tasks).toHaveLength(once.plan.tasks.length);
  });

  it("injects one review per matching rule", () => {
    const plan = makePlan([
      makeTask({
        id: "T01",
        complexity: "architectural",
        risk: { level: "high", categories: ["auth"] },
      }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({
        review: [
          authReview,
          {
            id: "deep",
            minimumComplexity: "complex",
            reviewer: "architect",
            blocking: true,
            strength: "hard",
          },
        ],
      }),
      KNOWN,
    );

    expect(result.injectedReviews).toEqual([
      "T01-review-auth-review",
      "T01-review-deep",
    ]);
  });

  it("sanitizes ids built from awkward rule ids", () => {
    const plan = makePlan([
      makeTask({ id: "T01", risk: { level: "high", categories: ["auth"] } }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({
        review: [{ ...authReview, id: "auth review/2" }],
      }),
      KNOWN,
    );

    expect(result.injectedReviews).toEqual(["T01-review-auth-review-2"]);
  });

  it("drops an unknown suggestedAgent and records a note", () => {
    const plan = makePlan([
      makeTask({ id: "T01", suggestedAgent: "ghost-agent" }),
      makeTask({ id: "T02", suggestedAgent: "implementer" }),
    ]);

    const result = applyPolicyToPlan(plan, makePolicy(), KNOWN);

    expect(result.issues).toEqual([]);
    expect(result.plan.tasks[0]).not.toHaveProperty("suggestedAgent");
    expect(result.plan.tasks[1]?.suggestedAgent).toBe("implementer");
    expect(result.notes.join("\n")).toContain("ghost-agent");
  });

  it("injects a review without an agent when the reviewer is unknown", () => {
    const plan = makePlan([
      makeTask({ id: "T01", risk: { level: "high", categories: ["auth"] } }),
    ]);

    const result = applyPolicyToPlan(
      plan,
      makePolicy({ review: [{ ...authReview, reviewer: "nobody" }] }),
      KNOWN,
    );

    expect(result.injectedReviews).toHaveLength(1);
    expect(result.plan.tasks[1]).not.toHaveProperty("suggestedAgent");
    expect(result.notes.join("\n")).toContain("nobody");
  });

  it("reports duplicate ids, dangling dependencies and cycles as issues", () => {
    const duplicates = applyPolicyToPlan(
      makePlan([makeTask({ id: "T01" }), makeTask({ id: "T01" })]),
      makePolicy(),
      KNOWN,
    );
    expect(duplicates.issues).toEqual(["Duplicate task id: T01"]);

    const dangling = applyPolicyToPlan(
      makePlan([makeTask({ id: "T01", dependencies: ["T42"] })]),
      makePolicy(),
      KNOWN,
    );
    expect(dangling.issues).toEqual(["Task T01 depends on missing task T42"]);

    const cyclic = applyPolicyToPlan(
      makePlan([
        makeTask({ id: "T01", dependencies: ["T02"] }),
        makeTask({ id: "T02", dependencies: ["T01"] }),
      ]),
      makePolicy(),
      KNOWN,
    );
    expect(cyclic.issues).toHaveLength(1);
    expect(cyclic.issues[0]).toContain("cycle");

    const selfDependent = applyPolicyToPlan(
      makePlan([makeTask({ id: "T01", dependencies: ["T01"] })]),
      makePolicy(),
      KNOWN,
    );
    expect(selfDependent.issues).toEqual(["Task T01 depends on itself."]);
  });

  it("leaves a clean plan untouched when the policy has no review rules", () => {
    const plan = makePlan([
      makeTask({ id: "T01" }),
      makeTask({ id: "T02", dependencies: ["T01"] }),
    ]);

    const result = applyPolicyToPlan(plan, makePolicy(), KNOWN);

    expect(result).toMatchObject({
      injectedReviews: [],
      issues: [],
      notes: [],
    });
    expect(result.plan.tasks).toEqual(plan.tasks);
  });
});
