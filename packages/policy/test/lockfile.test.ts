import { describe, expect, it } from "vitest";
import {
  checkLock,
  createLockfile,
  hashPolicySource,
  LOCKFILE_VERSION,
  type PolicyCompileResult,
  PolicySchema,
  parseLockfile,
  serializeLockfile,
} from "../src/index.js";

const MARKDOWN = `# Orchestration

The architect plans. Prefer implementer for refactors.
`;

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

const result: PolicyCompileResult = {
  policy,
  warnings: ["weight 0.5 inferred from 'slightly prefer'"],
  ambiguities: [],
};

const lockInput = {
  markdown: MARKDOWN,
  result,
  model: "anthropic/claude-opus-5",
  now: 1_750_000_000_000,
} as const;

describe("hashPolicySource", () => {
  it("ignores CRLF line endings, trailing whitespace and trailing blank lines", () => {
    const base = hashPolicySource("alpha\nbeta\n");
    expect(hashPolicySource("alpha\r\nbeta\r\n")).toBe(base);
    expect(hashPolicySource("alpha   \nbeta\t\n")).toBe(base);
    expect(hashPolicySource("alpha\nbeta\n\n\n")).toBe(base);
    expect(hashPolicySource("alpha\nbeta")).toBe(base);
  });

  it("changes when the content changes", () => {
    expect(hashPolicySource("alpha\nbeta\n")).not.toBe(
      hashPolicySource("alpha\ngamma\n"),
    );
    // Leading/inner whitespace is meaningful in markdown, so it still counts.
    expect(hashPolicySource("alpha\nbeta\n")).not.toBe(
      hashPolicySource("alpha\n  beta\n"),
    );
  });

  it("is a hex sha256 digest", () => {
    expect(hashPolicySource(MARKDOWN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createLockfile / serializeLockfile / parseLockfile", () => {
  it("records the source hash, model, timestamp and compile result", () => {
    const lock = createLockfile(lockInput);
    expect(lock.lockfileVersion).toBe(LOCKFILE_VERSION);
    expect(lock.sourceHash).toBe(hashPolicySource(MARKDOWN));
    expect(lock.compiledAt).toBe(1_750_000_000_000);
    expect(lock.model).toBe("anthropic/claude-opus-5");
    expect(lock.policy).toEqual(policy);
    expect(lock.warnings).toEqual([
      "weight 0.5 inferred from 'slightly prefer'",
    ]);
    expect(lock.ambiguities).toEqual([]);
  });

  it("defaults compiledAt to now", () => {
    const before = Date.now();
    const { markdown, result: compiled, model } = lockInput;
    const lock = createLockfile({ markdown, result: compiled, model });
    expect(lock.compiledAt).toBeGreaterThanOrEqual(before);
  });

  it("serializes deterministically, with sorted keys and a trailing newline", () => {
    const first = serializeLockfile(createLockfile(lockInput));
    const second = serializeLockfile(createLockfile(lockInput));
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);

    const keys = JSON.parse(first) as Record<string, unknown>;
    expect(Object.keys(keys)).toEqual([
      "ambiguities",
      "compiledAt",
      "lockfileVersion",
      "model",
      "policy",
      "sourceHash",
      "warnings",
    ]);

    // Key insertion order in the input must not leak into the bytes.
    const shuffled = { ...createLockfile(lockInput) };
    const rebuilt = {
      warnings: shuffled.warnings,
      policy: shuffled.policy,
      model: shuffled.model,
      sourceHash: shuffled.sourceHash,
      compiledAt: shuffled.compiledAt,
      ambiguities: shuffled.ambiguities,
      lockfileVersion: shuffled.lockfileVersion,
    } as const;
    expect(serializeLockfile(rebuilt)).toBe(first);
  });

  it("round-trips through parseLockfile", () => {
    const lock = createLockfile(lockInput);
    const parsed = parseLockfile(serializeLockfile(lock));
    expect(parsed).toEqual(lock);
    expect(serializeLockfile(parsed)).toBe(serializeLockfile(lock));
  });

  it("throws a readable error on malformed JSON", () => {
    expect(() => parseLockfile("{ not json")).toThrow(/not valid JSON/);
  });

  it("throws a readable error on a schema mismatch", () => {
    expect(() =>
      parseLockfile(JSON.stringify({ lockfileVersion: 2, sourceHash: "x" })),
    ).toThrow(/Invalid orchestration lockfile: .*lockfileVersion/);
  });
});

describe("checkLock", () => {
  it("reports missing when there is no lockfile", () => {
    expect(checkLock(MARKDOWN, undefined)).toEqual({
      fresh: false,
      reason: "missing",
    });
    expect(checkLock(MARKDOWN, "   \n")).toEqual({
      fresh: false,
      reason: "missing",
    });
  });

  it("reports fresh when the hash matches, including after cosmetic edits", () => {
    const content = serializeLockfile(createLockfile(lockInput));
    const status = checkLock(MARKDOWN, content);
    expect(status.fresh).toBe(true);
    expect(status.lock?.model).toBe("anthropic/claude-opus-5");

    const cosmetic = `${MARKDOWN.replace(/\n/g, "\r\n")}   \n\n`;
    expect(checkLock(cosmetic, content).fresh).toBe(true);
  });

  it("reports stale-source when the policy text changed, keeping the old lock", () => {
    const content = serializeLockfile(createLockfile(lockInput));
    const status = checkLock(
      `${MARKDOWN}\nAlso: never skip review.\n`,
      content,
    );
    expect(status.fresh).toBe(false);
    if (status.fresh) throw new Error("expected a stale lock");
    expect(status.reason).toBe("stale-source");
    expect(status.detail).toContain("does not match locked");
    expect(status.lock?.policy.orchestrator).toBe("architect");
  });

  it("reports invalid when the lockfile does not parse", () => {
    const status = checkLock(MARKDOWN, '{"lockfileVersion":99}');
    expect(status.fresh).toBe(false);
    if (status.fresh) throw new Error("expected an invalid lock");
    expect(status.reason).toBe("invalid");
    expect(status.detail).toContain("Invalid orchestration lockfile");
    expect(status.lock).toBeUndefined();
  });

  it("identical lockfiles imply identical runtime policy", () => {
    const a = serializeLockfile(createLockfile(lockInput));
    const b = serializeLockfile(
      createLockfile({ ...lockInput, markdown: MARKDOWN.replace(/\n$/, "") }),
    );
    expect(a).toBe(b);
    expect(parseLockfile(a).policy).toEqual(parseLockfile(b).policy);
  });
});
