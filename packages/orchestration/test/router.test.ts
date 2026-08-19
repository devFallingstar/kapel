import { describe, expect, it } from "vitest";
import { PolicyRouter } from "../src/index.js";
import { makePolicy, makeTask } from "./helpers.js";

const router = new PolicyRouter();

describe("PolicyRouter", () => {
  it("falls back to the task suggestion, then the orchestrator", () => {
    const policy = makePolicy();
    expect(router.route(makeTask({ id: "T01" }), policy)).toBe("architect");
    expect(
      router.route(
        makeTask({ id: "T01", suggestedAgent: "implementer" }),
        policy,
      ),
    ).toBe("implementer");
  });

  it("matches on complexity and treats an empty list as any", () => {
    const policy = makePolicy({
      routing: [
        {
          id: "big-work",
          complexity: ["complex", "architectural"],
          agent: "architect",
          strength: "hard",
        },
        {
          id: "any-work",
          agent: "implementer",
          strength: "preference",
        },
      ],
    });

    expect(
      router.route(makeTask({ id: "T01", complexity: "complex" }), policy),
    ).toBe("architect");
    expect(
      router.route(makeTask({ id: "T02", complexity: "trivial" }), policy),
    ).toBe("implementer");
  });

  it("requires every populated facet of a rule to match", () => {
    const policy = makePolicy({
      routing: [
        {
          id: "auth-impl",
          taskTypes: ["implementation"],
          riskCategories: ["auth"],
          complexity: ["complex"],
          agent: "reviewer",
          strength: "hard",
        },
      ],
    });

    const matching = makeTask({
      id: "T01",
      type: "implementation",
      complexity: "complex",
      risk: { level: "high", categories: ["auth", "api"] },
    });
    expect(router.route(matching, policy)).toBe("reviewer");

    const wrongComplexity = makeTask({
      id: "T02",
      type: "implementation",
      complexity: "normal",
      risk: { level: "high", categories: ["auth"] },
    });
    expect(router.route(wrongComplexity, policy)).toBe("architect");

    const wrongCategory = makeTask({
      id: "T03",
      type: "implementation",
      complexity: "complex",
      risk: { level: "low", categories: ["docs"] },
    });
    expect(router.route(wrongCategory, policy)).toBe("architect");
  });

  it("prefers a hard rule over a heavier preference", () => {
    const policy = makePolicy({
      routing: [
        {
          id: "prefer-implementer",
          agent: "implementer",
          strength: "preference",
          weight: 1,
        },
        {
          id: "must-review",
          riskCategories: ["auth"],
          agent: "reviewer",
          strength: "hard",
          weight: 0,
        },
      ],
    });

    const task = makeTask({
      id: "T01",
      risk: { level: "high", categories: ["auth"] },
    });
    expect(router.route(task, policy)).toBe("reviewer");
  });

  it("sorts preferences by weight and breaks ties by rule id", () => {
    const heavier = makePolicy({
      routing: [
        {
          id: "a-light",
          agent: "implementer",
          strength: "preference",
          weight: 0.2,
        },
        {
          id: "b-heavy",
          agent: "reviewer",
          strength: "preference",
          weight: 0.8,
        },
      ],
    });
    expect(router.route(makeTask({ id: "T01" }), heavier)).toBe("reviewer");

    const tied = makePolicy({
      routing: [
        { id: "zeta", agent: "reviewer", strength: "preference", weight: 0.5 },
        {
          id: "alpha",
          agent: "implementer",
          strength: "preference",
          weight: 0.5,
        },
      ],
    });
    expect(router.route(makeTask({ id: "T01" }), tied)).toBe("implementer");

    const reordered = makePolicy({
      routing: [
        {
          id: "alpha",
          agent: "implementer",
          strength: "preference",
          weight: 0.5,
        },
        { id: "zeta", agent: "reviewer", strength: "preference", weight: 0.5 },
      ],
    });
    expect(router.route(makeTask({ id: "T01" }), reordered)).toBe(
      "implementer",
    );
  });

  it("breaks ties between hard rules by id as well", () => {
    const policy = makePolicy({
      routing: [
        { id: "zeta", agent: "reviewer", strength: "hard" },
        { id: "alpha", agent: "implementer", strength: "hard" },
      ],
    });
    expect(router.route(makeTask({ id: "T01" }), policy)).toBe("implementer");
  });

  it("ignores the task suggestion when a rule matches", () => {
    const policy = makePolicy({
      routing: [
        {
          id: "tests",
          taskTypes: ["testing"],
          agent: "reviewer",
          strength: "hard",
        },
      ],
    });
    const task = makeTask({
      id: "T01",
      type: "testing",
      suggestedAgent: "implementer",
    });
    expect(router.route(task, policy)).toBe("reviewer");
  });
});
