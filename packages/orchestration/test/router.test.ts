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

  describe("specificity", () => {
    /**
     * The shape a compiled policy actually has (this is the mock template's
     * own, verbatim): one tier rule per complexity band, plus a targeted rule
     * for reviews. All hard, all at the default weight — and "route-coder"
     * sorts before "route-reviewer", which is how reviews used to end up on the
     * coder, holding the coder's write tools.
     */
    const stockTemplate = makePolicy({
      orchestrator: "lead",
      routing: [
        {
          id: "route-senior",
          complexity: ["complex", "architectural"],
          agent: "senior",
          strength: "hard",
        },
        {
          id: "route-coder",
          complexity: ["normal"],
          agent: "coder",
          strength: "hard",
        },
        {
          id: "route-junior",
          complexity: ["trivial"],
          agent: "junior",
          strength: "hard",
        },
        {
          id: "route-reviewer",
          taskTypes: ["review"],
          agent: "reviewer",
          strength: "hard",
        },
      ],
    });

    it("routes an injected review to the reviewer, not the coder", () => {
      const review = makeTask({
        id: "T02-review-review-auth-blocking",
        type: "review",
        complexity: "normal",
      });

      expect(router.decide(review, stockTemplate)).toEqual({
        agent: "reviewer",
        rule: "route-reviewer",
        reason: "rule",
      });
    });

    it("still routes ordinary work by the tier rule", () => {
      const work = makeTask({
        id: "T02",
        type: "implementation",
        complexity: "normal",
      });

      expect(router.decide(work, stockTemplate)).toEqual({
        agent: "coder",
        rule: "route-coder",
        reason: "rule",
      });
      expect(
        router.route(
          makeTask({ id: "T01", complexity: "architectural" }),
          stockTemplate,
        ),
      ).toBe("senior");
      expect(
        router.route(
          makeTask({ id: "T03", type: "testing", complexity: "trivial" }),
          stockTemplate,
        ),
      ).toBe("junior");
    });

    it("counts one point per populated facet, so more facets win", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "a-two-facets",
            taskTypes: ["implementation"],
            riskCategories: ["auth"],
            agent: "reviewer",
            strength: "hard",
          },
          {
            id: "b-three-facets",
            taskTypes: ["implementation"],
            riskCategories: ["auth"],
            complexity: ["normal"],
            agent: "architect",
            strength: "hard",
          },
          {
            id: "c-one-facet",
            taskTypes: ["implementation"],
            agent: "implementer",
            strength: "hard",
          },
        ],
      });

      const task = makeTask({
        id: "T01",
        type: "implementation",
        complexity: "normal",
        risk: { level: "high", categories: ["auth"] },
      });
      expect(router.route(task, policy)).toBe("architect");
    });

    it("prefers the more specific rule even when the broader one is heavier", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "broad",
            agent: "implementer",
            strength: "hard",
            weight: 1,
          },
          {
            id: "narrow",
            taskTypes: ["review"],
            agent: "reviewer",
            strength: "hard",
            weight: 0.1,
          },
        ],
      });

      expect(
        router.route(makeTask({ id: "T01", type: "review" }), policy),
      ).toBe("reviewer");
    });

    it("ranks equally-many facets by which facets they are", () => {
      // Same count (one facet each), same weight, and the complexity rule sorts
      // first by id — but naming the task type says more about who should do it
      // than naming its size does.
      const policy = makePolicy({
        routing: [
          {
            id: "a-by-size",
            complexity: ["normal"],
            agent: "implementer",
            strength: "hard",
          },
          {
            id: "b-by-area",
            riskCategories: ["auth"],
            agent: "architect",
            strength: "hard",
          },
          {
            id: "c-by-type",
            taskTypes: ["review"],
            agent: "reviewer",
            strength: "hard",
          },
        ],
      });

      const task = makeTask({
        id: "T01",
        type: "review",
        complexity: "normal",
        risk: { level: "high", categories: ["auth"] },
      });
      expect(router.route(task, policy)).toBe("reviewer");
    });

    it("lets facet count beat facet rank", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "a-type-only",
            taskTypes: ["review"],
            agent: "reviewer",
            strength: "hard",
          },
          {
            id: "b-area-and-size",
            riskCategories: ["auth"],
            complexity: ["normal"],
            agent: "architect",
            strength: "hard",
          },
        ],
      });

      const task = makeTask({
        id: "T01",
        type: "review",
        complexity: "normal",
        risk: { level: "high", categories: ["auth"] },
      });
      expect(router.route(task, policy)).toBe("architect");
    });

    it("falls back to weight, then id, between identically specific rules", () => {
      const byWeight = makePolicy({
        routing: [
          {
            id: "a-light",
            taskTypes: ["review"],
            agent: "implementer",
            strength: "hard",
            weight: 0.2,
          },
          {
            id: "b-heavy",
            taskTypes: ["review"],
            agent: "reviewer",
            strength: "hard",
            weight: 0.8,
          },
        ],
      });
      expect(
        router.route(makeTask({ id: "T01", type: "review" }), byWeight),
      ).toBe("reviewer");

      const byId = makePolicy({
        routing: [
          {
            id: "zeta",
            taskTypes: ["review"],
            agent: "reviewer",
            strength: "hard",
            weight: 0.5,
          },
          {
            id: "alpha",
            taskTypes: ["review"],
            agent: "implementer",
            strength: "hard",
            weight: 0.5,
          },
        ],
      });
      expect(router.route(makeTask({ id: "T01", type: "review" }), byId)).toBe(
        "implementer",
      );
    });

    it("never lets a specific preference outrank a hard rule", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "hard-catch-all",
            agent: "implementer",
            strength: "hard",
            weight: 0.1,
          },
          {
            id: "preferred-reviewer",
            taskTypes: ["review"],
            riskCategories: ["auth"],
            complexity: ["normal"],
            agent: "reviewer",
            strength: "preference",
            weight: 1,
          },
        ],
      });

      const task = makeTask({
        id: "T01",
        type: "review",
        complexity: "normal",
        risk: { level: "high", categories: ["auth"] },
      });
      expect(router.route(task, policy)).toBe("implementer");
    });

    it("ranks preferences among themselves by specificity too", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "a-broad",
            agent: "implementer",
            strength: "preference",
            weight: 1,
          },
          {
            id: "b-narrow",
            taskTypes: ["review"],
            agent: "reviewer",
            strength: "preference",
            weight: 0.3,
          },
        ],
      });

      expect(
        router.route(makeTask({ id: "T01", type: "review" }), policy),
      ).toBe("reviewer");
    });

    it("still uses the task suggestion only when nothing matched at all", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "route-reviewer-review",
            taskTypes: ["review"],
            agent: "reviewer",
            strength: "hard",
          },
        ],
      });

      expect(
        router.route(
          makeTask({
            id: "T01",
            type: "review",
            suggestedAgent: "implementer",
          }),
          policy,
        ),
      ).toBe("reviewer");
      expect(
        router.route(
          makeTask({
            id: "T02",
            type: "implementation",
            suggestedAgent: "implementer",
          }),
          policy,
        ),
      ).toBe("implementer");
    });
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

  describe("decide", () => {
    it("reports the winning rule's id when a rule matches", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "implementation",
            taskTypes: ["implementation"],
            agent: "implementer",
            strength: "hard",
          },
        ],
      });
      expect(
        router.decide(makeTask({ id: "T01", type: "implementation" }), policy),
      ).toEqual({
        agent: "implementer",
        rule: "implementation",
        reason: "rule",
      });
    });

    it("reports 'suggestedAgent' with no rule id when the task's suggestion is used", () => {
      const policy = makePolicy();
      expect(
        router.decide(
          makeTask({ id: "T01", suggestedAgent: "implementer" }),
          policy,
        ),
      ).toEqual({ agent: "implementer", reason: "suggestedAgent" });
    });

    it("reports 'orchestrator' with no rule id when nothing else matched", () => {
      const policy = makePolicy();
      expect(router.decide(makeTask({ id: "T01" }), policy)).toEqual({
        agent: "architect",
        reason: "orchestrator",
      });
    });

    it("agrees with route() on the agent it picks", () => {
      const policy = makePolicy({
        routing: [
          {
            id: "auth-impl",
            riskCategories: ["auth"],
            agent: "reviewer",
            strength: "hard",
          },
        ],
      });
      const task = makeTask({
        id: "T01",
        risk: { level: "high", categories: ["auth"] },
      });
      expect(router.decide(task, policy).agent).toBe(
        router.route(task, policy),
      );
    });
  });
});
