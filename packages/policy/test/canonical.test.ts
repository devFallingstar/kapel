import { describe, expect, it } from "vitest";
import {
  CANONICAL_POLICY_MARKER,
  isCanonicalPolicySource,
  PolicyRenderError,
  parsePolicyMarkdown,
  renderPolicyMarkdown,
} from "../src/canonical.js";
import { hashPolicySource } from "../src/lockfile.js";
import type { OrchestrationPolicy } from "../src/schema.js";
import {
  EscalationRuleSchema,
  PolicySchema,
  ReviewRuleSchema,
  RoutingRuleSchema,
} from "../src/schema.js";

function policy(
  overrides: Partial<OrchestrationPolicy> = {},
): OrchestrationPolicy {
  return PolicySchema.parse({ version: 1, orchestrator: "lead", ...overrides });
}

/** Renders, parses back, and asserts nothing was lost. */
function roundTrip(input: OrchestrationPolicy): OrchestrationPolicy {
  const markdown = renderPolicyMarkdown(input);
  const outcome = parsePolicyMarkdown(markdown);
  if (!("policy" in outcome)) {
    throw new Error(
      `${outcome.failure.reason}: ${outcome.failure.message}\n---\n${markdown}`,
    );
  }
  expect(outcome.policy).toEqual(input);
  return outcome.policy;
}

/**
 * Names that each contain a word or a separator the grammar also uses.
 * Backtick quoting is what keeps them one value instead of two.
 */
const HOSTILE = [
  "go to market",
  "a, b",
  "x and y",
  "tasks",
  "touching",
  "of complex complexity",
  "reviews",
  "hand off from",
  "at normal complexity or above",
  "always route",
  "; blocking, required",
  "  padded  ",
  "유니코드 작업",
];

describe("canonical policy source", () => {
  it("round-trips a bare policy", () => {
    roundTrip(policy());
  });

  it("round-trips every scalar away from its default", () => {
    roundTrip(
      policy({
        orchestrator: "captain",
        maxConcurrency: 1,
        parallelizeIndependentTasks: false,
        defaultMaxAttempts: 1,
      }),
    );
  });

  it("round-trips routing rules across strength, weight and every matcher", () => {
    roundTrip(
      policy({
        routing: [
          { id: "any", agent: "coder", strength: "hard" },
          {
            id: "narrow",
            taskTypes: ["test", "docs"],
            riskCategories: ["auth", "payments", "migrations"],
            complexity: ["complex", "architectural"],
            agent: "senior",
            strength: "preference",
            weight: 0.25,
          },
          {
            id: "types-only",
            taskTypes: ["refactor"],
            agent: "junior",
            strength: "hard",
          },
          {
            id: "risk-only",
            riskCategories: ["secrets"],
            agent: "senior",
            strength: "hard",
          },
          {
            id: "complexity-only",
            complexity: ["trivial"],
            agent: "junior",
            strength: "preference",
          },
        ].map((rule) => RoutingRuleSchema.parse(rule)),
      }),
    );
  });

  it("round-trips review rules across blocking, strength and the complexity floor", () => {
    roundTrip(
      policy({
        review: [
          { id: "plain", reviewer: "reviewer" },
          {
            id: "advisory",
            reviewer: "senior",
            riskCategories: ["auth"],
            blocking: false,
            strength: "preference",
            minimumComplexity: "normal",
          },
          {
            id: "floor-only",
            reviewer: "reviewer",
            minimumComplexity: "architectural",
          },
        ].map((rule) => ReviewRuleSchema.parse(rule)),
      }),
    );
  });

  it("round-trips escalation rules across every trigger combination", () => {
    roundTrip(
      policy({
        escalation: [
          { id: "on-request", fromAgent: "junior", toAgent: "coder" },
          {
            id: "failures",
            fromAgent: "junior",
            toAgent: "coder",
            afterFailures: 1,
          },
          {
            id: "confidence",
            fromAgent: "coder",
            toAgent: "senior",
            confidenceBelow: 0.5,
          },
          {
            id: "both",
            fromAgent: "coder",
            toAgent: "senior",
            afterFailures: 3,
            confidenceBelow: 0.125,
          },
        ].map((rule) => EscalationRuleSchema.parse(rule)),
      }),
    );
  });

  it.each(HOSTILE)(
    "round-trips %j as a task type, risk and agent name",
    (name) => {
      roundTrip(
        policy({
          orchestrator: name,
          routing: [
            RoutingRuleSchema.parse({
              id: name,
              taskTypes: [name, "plain"],
              riskCategories: ["plain", name],
              complexity: ["normal"],
              agent: name,
              strength: "preference",
              weight: 0.5,
            }),
          ],
          review: [
            ReviewRuleSchema.parse({
              id: name,
              reviewer: name,
              riskCategories: [name],
              minimumComplexity: "complex",
            }),
          ],
          escalation: [
            EscalationRuleSchema.parse({
              id: name,
              fromAgent: name,
              toAgent: "other",
              afterFailures: 2,
            }),
          ],
        }),
      );
    },
  );

  it("refuses to write a name it could not read back", () => {
    expect(() =>
      renderPolicyMarkdown(policy({ orchestrator: "we`ird" })),
    ).toThrow(PolicyRenderError);
  });

  it("renders a marker every canonical source is recognized by", () => {
    const markdown = renderPolicyMarkdown(policy());
    expect(markdown).toContain(CANONICAL_POLICY_MARKER);
    expect(isCanonicalPolicySource(markdown)).toBe(true);
  });

  it("is stable: re-rendering a parsed policy reproduces the same bytes", () => {
    const first = renderPolicyMarkdown(
      policy({
        routing: [
          RoutingRuleSchema.parse({
            id: "r",
            agent: "coder",
            strength: "hard",
          }),
        ],
      }),
    );
    const outcome = parsePolicyMarkdown(first);
    if (!("policy" in outcome)) throw new Error("expected a parse");
    const second = renderPolicyMarkdown(outcome.policy);
    expect(second).toBe(first);
    // Which is what lets a lock written beside a rendered file stay fresh.
    expect(hashPolicySource(second)).toBe(hashPolicySource(first));
  });
});

describe("canonical round trip, fuzzed", () => {
  /** A tiny seeded LCG, so a failure here is reproducible from its seed. */
  function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  const NAMES = [...HOSTILE, "lead", "coder", "senior", "junior", "reviewer"];
  const COMPLEXITY = ["trivial", "normal", "complex", "architectural"] as const;

  function generate(next: () => number): OrchestrationPolicy {
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)] as T;
    const some = <T>(items: readonly T[]): T[] =>
      items.filter(() => next() < 0.4);
    const count = (max: number): number => Math.floor(next() * (max + 1));

    return PolicySchema.parse({
      version: 1,
      orchestrator: pick(NAMES),
      maxConcurrency: 1 + count(7),
      parallelizeIndependentTasks: next() < 0.5,
      defaultMaxAttempts: 1 + count(4),
      routing: Array.from({ length: count(3) }, (_, index) => ({
        id: `r${index}-${pick(NAMES)}`,
        taskTypes: some(NAMES),
        riskCategories: some(NAMES),
        complexity: some(COMPLEXITY),
        agent: pick(NAMES),
        strength: next() < 0.5 ? "hard" : "preference",
        weight: next() < 0.5 ? 1 : Math.round(next() * 100) / 100,
      })),
      review: Array.from({ length: count(3) }, (_, index) => ({
        id: `v${index}-${pick(NAMES)}`,
        riskCategories: some(NAMES),
        reviewer: pick(NAMES),
        blocking: next() < 0.5,
        strength: next() < 0.5 ? "hard" : "preference",
        ...(next() < 0.5 ? {} : { minimumComplexity: pick(COMPLEXITY) }),
      })),
      escalation: Array.from({ length: count(3) }, (_, index) => ({
        id: `e${index}-${pick(NAMES)}`,
        fromAgent: pick(NAMES),
        toAgent: pick(NAMES),
        ...(next() < 0.5 ? {} : { afterFailures: 1 + count(4) }),
        ...(next() < 0.5
          ? {}
          : { confidenceBelow: Math.round(next() * 100) / 100 }),
      })),
    });
  }

  it("survives 500 generated policies", () => {
    const next = rng(20260821);
    for (let seed = 0; seed < 500; seed += 1) roundTrip(generate(next));
  });
});

describe("declining to parse", () => {
  it("declines prose with no marker, without guessing", () => {
    const outcome = parsePolicyMarkdown(
      "# Orchestration Policy\n\nUse `lead` as the main orchestrator.\n",
    );
    expect(outcome).toMatchObject({ failure: { reason: "not-canonical" } });
  });

  /** A canonical source with one line replaced by `mutate`. */
  function mutated(mutate: (lines: string[]) => void): string {
    const lines = renderPolicyMarkdown(
      policy({
        routing: [
          RoutingRuleSchema.parse({
            id: "r",
            agent: "coder",
            strength: "hard",
          }),
        ],
      }),
    ).split("\n");
    mutate(lines);
    return lines.join("\n");
  }

  it("fails on a sentence added inside a section rather than ignoring it", () => {
    const markdown = mutated((lines) => {
      const at = lines.indexOf("## Execution");
      lines.splice(at + 2, 0, "- Never touch the database.");
    });
    expect(parsePolicyMarkdown(markdown)).toMatchObject({
      failure: { reason: "unreadable" },
    });
  });

  it("fails on a deleted section rather than reading it as empty", () => {
    const markdown = mutated((lines) => {
      const at = lines.indexOf("## Review");
      lines.splice(at, 3);
    });
    expect(parsePolicyMarkdown(markdown)).toMatchObject({
      failure: { reason: "unreadable" },
    });
  });

  it("fails on an unknown section", () => {
    const markdown = mutated((lines) => {
      lines.push("", "## Budget", "", "- Spend nothing.");
    });
    expect(parsePolicyMarkdown(markdown)).toMatchObject({
      failure: { reason: "unreadable" },
    });
  });

  it("reports the line a broken rule sits on", () => {
    const markdown = mutated((lines) => {
      const at = lines.findIndex((line) => line.startsWith("- `r`:"));
      lines[at] = "- `r`: send it to whoever is free.";
    });
    const outcome = parsePolicyMarkdown(markdown);
    if ("policy" in outcome) throw new Error("expected a failure");
    expect(outcome.failure.reason).toBe("unreadable");
    expect(outcome.failure.line).toBeGreaterThan(0);
  });

  it("rejects a value the schema would not admit", () => {
    const markdown = mutated((lines) => {
      const at = lines.findIndex((line) => line.startsWith("- Run at most"));
      lines[at] = "- Run at most 0 agents at a time.";
    });
    expect(parsePolicyMarkdown(markdown)).toMatchObject({
      failure: { reason: "unreadable" },
    });
  });

  it("tolerates prose in the preamble above the first section", () => {
    const markdown = mutated((lines) => {
      const at = lines.indexOf("## Orchestrator");
      lines.splice(at, 0, "Anything may be said up here.", "");
    });
    expect(parsePolicyMarkdown(markdown)).toHaveProperty("policy");
  });
});
