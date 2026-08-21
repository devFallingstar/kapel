import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OrchestrationPolicy } from "@agent/coding-agent";
import {
  checkLock,
  PolicySchema,
  parseLockfile,
  parsePolicyMarkdown,
} from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyOutput } from "../src/policy.js";
import { runPolicyEdit } from "../src/policy.js";
import type { PolicyEditPrompt } from "../src/policy-edit.js";
import { runPolicyEditor } from "../src/policy-edit.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();
const TEMPLATE_AGENT_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "templates",
  "default",
  ".agent",
);

const AGENTS = ["lead", "senior", "coder", "junior", "explorer", "reviewer"];

/** One scripted answer: the title it expects to see, and what to reply. */
type Step = readonly [
  expected: string,
  reply: string | readonly string[] | null,
];

/**
 * A prompt that replays a script, asserting each question is the one the
 * script expected. `null` replies mean "cancelled" — escape, or a closed
 * stream — which is how the editor's exits are exercised without a terminal.
 */
function scripted(steps: readonly Step[]): {
  prompt: PolicyEditPrompt;
  remaining: () => number;
} {
  let at = 0;
  const next = (title: string): string | readonly string[] | null => {
    const step = steps[at];
    if (step === undefined) {
      throw new Error(`unscripted question after ${at} steps: ${title}`);
    }
    at += 1;
    if (!title.includes(step[0])) {
      throw new Error(
        `step ${at}: expected a question containing ${JSON.stringify(
          step[0],
        )}, got ${JSON.stringify(title)}`,
      );
    }
    return step[1];
  };

  return {
    remaining: () => steps.length - at,
    prompt: {
      select: async (options) => {
        const reply = next(options.title);
        if (reply === null) return undefined;
        return typeof reply === "string" ? [reply] : reply;
      },
      text: async (options) => {
        const reply = next(options.title);
        return reply === null ? undefined : String(reply);
      },
    },
  };
}

function basePolicy(
  overrides: Partial<OrchestrationPolicy> = {},
): OrchestrationPolicy {
  return PolicySchema.parse({ version: 1, orchestrator: "lead", ...overrides });
}

function editor(
  steps: readonly Step[],
  policy = basePolicy(),
): {
  run: () => Promise<OrchestrationPolicy | undefined>;
  lines: string[];
  remaining: () => number;
} {
  const { prompt, remaining } = scripted(steps);
  const lines: string[] = [];
  return {
    remaining,
    lines,
    run: () =>
      runPolicyEditor({
        prompt,
        write: (line) => lines.push(line),
        policy,
        knownAgents: AGENTS,
      }),
  };
}

describe("runPolicyEditor", () => {
  it("edits a scalar and hands back the new policy on save", async () => {
    const { run, remaining } = editor([
      ["Orchestration policy", "concurrency"],
      ["How many agents may run at once?", "2"],
      ["Orchestration policy", "save"],
    ]);

    const saved = await run();
    expect(saved?.maxConcurrency).toBe(2);
    expect(remaining()).toBe(0);
  });

  it("returns nothing when the edits are discarded", async () => {
    const { run } = editor([
      ["Orchestration policy", "concurrency"],
      ["How many agents may run at once?", "8"],
      ["Orchestration policy", "cancel"],
    ]);
    expect(await run()).toBeUndefined();
  });

  it("returns nothing when the top-level menu is escaped", async () => {
    const { run } = editor([["Orchestration policy", null]]);
    expect(await run()).toBeUndefined();
  });

  it("adds a rule whose defaults were already right", async () => {
    // Backing out of the add screen having changed nothing must still add
    // the rule — the opposite of escaping out of it.
    const { run } = editor([
      ["Orchestration policy", "routing"],
      ["Routing rules", "add"],
      ["route-1", "back"],
      ["Routing rules", "back"],
      ["Orchestration policy", "save"],
    ]);

    const saved = await run();
    expect(saved?.routing).toHaveLength(1);
    expect(saved?.routing[0]).toMatchObject({ id: "route-1", agent: "lead" });
  });

  it("does not add a rule the add screen was escaped out of", async () => {
    const { run } = editor([
      ["Orchestration policy", "routing"],
      ["Routing rules", "add"],
      ["route-1", null],
      ["Routing rules", "back"],
      ["Orchestration policy", "save"],
    ]);
    expect((await run())?.routing).toEqual([]);
  });

  it("edits a rule's fields through its own screen", async () => {
    const { run } = editor([
      ["Orchestration policy", "routing"],
      ["Routing rules", "add"],
      ["route-1", "agent"],
      ["Route to", "senior"],
      ["route-1", "complexity"],
      ["Complexity", ["complex", "architectural"]],
      ["route-1", "strength"],
      ["How firm is this rule?", "preference"],
      ["route-1", "riskCategories"],
      ["Risk categories", "auth, payments"],
      ["route-1", "back"],
      ["Routing rules", "back"],
      ["Orchestration policy", "save"],
    ]);

    expect((await run())?.routing[0]).toMatchObject({
      agent: "senior",
      complexity: ["complex", "architectural"],
      riskCategories: ["auth", "payments"],
      strength: "preference",
    });
  });

  it("clears a list with a single dash", async () => {
    const { run } = editor(
      [
        ["Orchestration policy", "routing"],
        ["Routing rules", "0"],
        ["keep-me", "riskCategories"],
        ["Risk categories", "-"],
        ["keep-me", "back"],
        ["Routing rules", "back"],
        ["Orchestration policy", "save"],
      ],
      basePolicy({
        routing: [
          {
            id: "keep-me",
            taskTypes: [],
            riskCategories: ["auth"],
            complexity: [],
            agent: "coder",
            strength: "hard",
            weight: 1,
          },
        ],
      }),
    );
    expect((await run())?.routing[0]?.riskCategories).toEqual([]);
  });

  it("removes a rule", async () => {
    const { run } = editor(
      [
        ["Orchestration policy", "escalation"],
        ["Escalation rules", "0"],
        ["drop-me", "remove"],
        ["Escalation rules", "back"],
        ["Orchestration policy", "save"],
      ],
      basePolicy({
        escalation: [{ id: "drop-me", fromAgent: "junior", toAgent: "coder" }],
      }),
    );
    expect((await run())?.escalation).toEqual([]);
  });

  it("refuses to save a policy naming an agent this project does not define", async () => {
    const { run, lines } = editor(
      [
        ["Orchestration policy", "save"],
        ["Orchestration policy", "cancel"],
      ],
      basePolicy({ orchestrator: "nobody" }),
    );

    expect(await run()).toBeUndefined();
    expect(lines.join("\n")).toContain("cannot be saved yet");
    expect(lines.join("\n")).toContain("nobody");
  });

  it("leaves a number alone when the typed one is not a number", async () => {
    const { run, lines } = editor([
      ["Orchestration policy", "concurrency"],
      ["How many agents may run at once?", "other"],
      ["How many agents may run at once?", "lots"],
      ["Orchestration policy", "save"],
    ]);

    expect((await run())?.maxConcurrency).toBe(4);
    expect(lines.join("\n")).toContain("not a whole number");
  });

  it("takes a number the list does not offer", async () => {
    const { run } = editor([
      ["Orchestration policy", "concurrency"],
      ["How many agents may run at once?", "other"],
      ["How many agents may run at once?", "12"],
      ["Orchestration policy", "save"],
    ]);
    expect((await run())?.maxConcurrency).toBe(12);
  });
});

describe("kapel policy edit", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(SCRATCHPAD, "cli-policy-edit-"));
    await cp(TEMPLATE_AGENT_DIR, path.join(workspace, ".agent"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function capture(): {
    output: PolicyOutput;
    lines: string[];
    errLines: string[];
  } {
    const lines: string[] = [];
    const errLines: string[] = [];
    return {
      lines,
      errLines,
      output: {
        log: (line) => lines.push(line),
        error: (line) => errLines.push(line),
      },
    };
  }

  const policyPath = (): string =>
    path.join(workspace, ".agent", "orchestration.md");
  const lockPath = (): string =>
    path.join(workspace, ".agent", "orchestration.lock.json");

  it("writes a canonical policy and a lock that is already fresh for it", async () => {
    const { output, lines, errLines } = capture();
    const { prompt } = scripted([
      ["Orchestration policy", "concurrency"],
      ["How many agents may run at once?", "2"],
      ["Orchestration policy", "save"],
    ]);

    expect(
      await runPolicyEdit({ cwd: workspace, json: false }, { output, prompt }),
    ).toBe(0);
    expect(errLines).toEqual([]);
    expect(lines.join("\n")).toContain("No model was called.");

    const markdown = await readFile(policyPath(), "utf8");
    const parsed = parsePolicyMarkdown(markdown);
    if (!("policy" in parsed)) throw new Error("wrote a policy it cannot read");
    expect(parsed.policy.maxConcurrency).toBe(2);

    // Nothing is left to compile: `/plan` works the moment the editor exits.
    const lock = await readFile(lockPath(), "utf8");
    expect(checkLock(markdown, lock).fresh).toBe(true);
    expect(parseLockfile(lock).model).toBe("canonical");
  });

  it("reports what changed", async () => {
    const { output, lines } = capture();
    const { prompt } = scripted([
      ["Orchestration policy", "attempts"],
      ["How many attempts does a task get?", "4"],
      ["Orchestration policy", "save"],
    ]);

    await runPolicyEdit({ cwd: workspace, json: false }, { output, prompt });
    expect(lines.join("\n")).toMatch(/defaultMaxAttempts/);
  });

  it("writes nothing when the editor is discarded", async () => {
    const before = await readFile(policyPath(), "utf8");
    const { output, lines } = capture();
    const { prompt } = scripted([["Orchestration policy", "cancel"]]);

    expect(
      await runPolicyEdit({ cwd: workspace, json: false }, { output, prompt }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("unchanged");
    expect(await readFile(policyPath(), "utf8")).toBe(before);
  });

  it("needs a terminal", async () => {
    const { output, errLines } = capture();
    expect(
      await runPolicyEdit({ cwd: workspace, json: false }, { output }),
    ).toBe(1);
    expect(errLines.join("\n")).toContain("needs a terminal");
  });

  it("starts from the lock when the policy is prose, and says the save replaces it", async () => {
    // Compile-by-hand stand-in: a lock that matches the prose on disk.
    const prose = "Send everything to `coder`.\n";
    await writeFile(policyPath(), prose, "utf8");
    const policy = basePolicy({ maxConcurrency: 7 });
    await writeFile(
      lockPath(),
      JSON.stringify(
        {
          lockfileVersion: 1,
          sourceHash: (await import("@agent/coding-agent")).hashPolicySource(
            prose,
          ),
          compiledAt: 0,
          model: "test",
          policy,
          warnings: [],
          ambiguities: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const { output, errLines } = capture();
    const titles: string[] = [];
    const prompt: PolicyEditPrompt = {
      select: async (options) => {
        titles.push(options.title);
        return options.choices.some((choice) => choice.value === "save")
          ? ["save"]
          : undefined;
      },
      text: async () => undefined,
    };

    expect(
      await runPolicyEdit({ cwd: workspace, json: false }, { output, prompt }),
    ).toBe(0);
    expect(errLines).toEqual([]);

    // The prose is gone, replaced by the canonical form of what it compiled to.
    const markdown = await readFile(policyPath(), "utf8");
    expect(markdown).not.toContain("Send everything");
    const parsed = parsePolicyMarkdown(markdown);
    if (!("policy" in parsed)) throw new Error("not canonical");
    expect(parsed.policy.maxConcurrency).toBe(7);
  });

  it("refuses to edit a prose policy that has never been compiled", async () => {
    await writeFile(policyPath(), "Send everything to `coder`.\n", "utf8");
    const { output, errLines } = capture();
    const { prompt } = scripted([]);

    expect(
      await runPolicyEdit({ cwd: workspace, json: false }, { output, prompt }),
    ).toBe(1);
    expect(errLines.join("\n")).toContain("never been compiled");
  });

  it("refuses to edit from a lock that no longer matches the prose", async () => {
    const prose = "Send everything to `coder`.\n";
    await writeFile(policyPath(), prose, "utf8");
    await writeFile(
      lockPath(),
      JSON.stringify(
        {
          lockfileVersion: 1,
          sourceHash: "0".repeat(64),
          compiledAt: 0,
          model: "test",
          policy: basePolicy(),
          warnings: [],
          ambiguities: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const { output, errLines } = capture();
    const { prompt } = scripted([]);
    expect(
      await runPolicyEdit({ cwd: workspace, json: false }, { output, prompt }),
    ).toBe(1);
    expect(errLines.join("\n")).toContain("has changed since");
  });
});
