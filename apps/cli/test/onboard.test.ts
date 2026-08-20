import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  OrchestrationPolicy,
  PolicyCompileResult,
  PolicyCompiler,
} from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import type {
  ProjectSetupState,
  SetupContext,
  SetupOutput,
} from "../src/onboard.js";
import {
  createProjectSetup,
  detectProjectSetup,
  setupDeclinedLine,
  setupQuestion,
} from "../src/onboard.js";
import { runPolicyCompile } from "../src/policy.js";

// Session-provided scratch dir when set (keeps CI and local machines on the
// OS temp dir) — same convention as policy.test.ts.
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(SCRATCHPAD, "cli-onboard-test-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function capture(): {
  output: SetupOutput;
  lines: string[];
  errLines: string[];
} {
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    output: {
      log: (line) => lines.push(line),
      error: (line) => errLines.push(line),
    },
    lines,
    errLines,
  };
}

/** A setup whose steps are recorded rather than run. */
function fakeSetup(
  state: ProjectSetupState,
  options: {
    confirm?: (question: string) => Promise<boolean>;
    init?: () => Promise<number>;
    compile?: () => Promise<number>;
  } = {},
): {
  setup: ReturnType<typeof createProjectSetup>;
  questions: string[];
  ran: string[];
} {
  const questions: string[] = [];
  const ran: string[] = [];
  const setup = createProjectSetup({
    workspacePath: "/nowhere",
    detect: async () => state,
    init: async () => {
      ran.push("init");
      return (await options.init?.()) ?? 0;
    },
    compile: async () => {
      ran.push("compile");
      return (await options.compile?.()) ?? 0;
    },
    ...(options.confirm === undefined
      ? {}
      : {
          confirm: async (question: string) => {
            questions.push(question);
            // biome-ignore lint/style/noNonNullAssertion: narrowed above.
            return await options.confirm!(question);
          },
        }),
  });
  return { setup, questions, ran };
}

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

// --- what a workspace still needs -------------------------------------------

describe("detectProjectSetup", () => {
  it("reports a directory with no .agent at all as needing init", async () => {
    expect(await detectProjectSetup(workspace)).toBe("needs-init");
  });

  it("reports a bare .agent holding only kapel's own state as needing init", async () => {
    // What `openChatStore` leaves behind in any directory the REPL opens:
    // a directory, but not a project.
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    await writeFile(path.join(workspace, ".agent", "sessions.db"), "x");

    expect(await detectProjectSetup(workspace)).toBe("needs-init");
  });

  it("reports an initialized project with no lock as needing the compile", async () => {
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    await writeFile(
      path.join(workspace, ".agent", "orchestration.md"),
      "# policy\n",
    );

    expect(await detectProjectSetup(workspace)).toBe("needs-policy");
  });

  it("reports a project with a lock as ready", async () => {
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    await writeFile(
      path.join(workspace, ".agent", "orchestration.md"),
      "# policy\n",
    );
    await writeFile(
      path.join(workspace, ".agent", "orchestration.lock.json"),
      "{}",
    );

    expect(await detectProjectSetup(workspace)).toBe("ready");
  });
});

// --- the offer --------------------------------------------------------------

describe("createProjectSetup", () => {
  it("asks once and runs init then the compile when accepted", async () => {
    const { setup, questions, ran } = fakeSetup("needs-init", { confirm: yes });
    const { output, lines, errLines } = capture();

    expect(await setup.ensure(output, "startup")).toBe(true);
    expect(questions).toEqual([setupQuestion("needs-init")]);
    expect(ran).toEqual(["init", "compile"]);
    expect(lines).toEqual([]);
    expect(errLines).toEqual([]);
  });

  it("offers only the compile when the project exists but has no lock", async () => {
    const { setup, questions, ran } = fakeSetup("needs-policy", {
      confirm: yes,
    });
    const { output } = capture();

    expect(await setup.ensure(output, "startup")).toBe(true);
    expect(questions).toEqual([setupQuestion("needs-policy")]);
    expect(questions[0]).toContain("one model call");
    expect(ran).toEqual(["compile"]);
  });

  it("says nothing at all, and asks nothing, when the project is ready", async () => {
    const { setup, questions, ran } = fakeSetup("ready", { confirm: yes });
    const { output, lines, errLines } = capture();

    expect(await setup.ensure(output, "startup")).toBe(true);
    expect(questions).toEqual([]);
    expect(ran).toEqual([]);
    expect(lines).toEqual([]);
    expect(errLines).toEqual([]);
  });

  it("never offers without someone to ask (piped, non-interactive stdin)", async () => {
    const { setup, questions, ran } = fakeSetup("needs-init");
    const { output, lines, errLines } = capture();

    expect(await setup.ensure(output, "startup")).toBe(false);
    expect(questions).toEqual([]);
    expect(ran).toEqual([]);
    expect(lines).toEqual([]);
    expect(errLines).toEqual([]);
  });

  it("remembers a decline for the session: one line, then never asked again", async () => {
    const { setup, questions, ran } = fakeSetup("needs-init", { confirm: no });
    const first = capture();

    expect(await setup.ensure(first.output, "startup")).toBe(false);
    expect(first.lines).toEqual([setupDeclinedLine("needs-init", "startup")]);
    expect(first.lines[0]).toContain("`kapel init`");
    expect(first.lines[0]).toContain("`kapel policy compile`");
    expect(first.lines[0]).toContain("/plan and /orchestrate will offer again");

    const second = capture();
    expect(await setup.ensure(second.output, "command")).toBe(false);
    expect(questions).toHaveLength(1);
    expect(ran).toEqual([]);
    expect(second.lines).toEqual([]);
  });

  it("does not promise another offer when the offer already came from a command", async () => {
    const { setup } = fakeSetup("needs-policy", { confirm: no });
    const { output, lines } = capture();

    await setup.ensure(output, "command");
    expect(lines).toEqual([setupDeclinedLine("needs-policy", "command")]);
    expect(lines[0]).not.toContain("offer again");
    expect(lines[0]).toContain("`kapel policy compile`");
  });

  it("reports a failed init, skips the compile, and stops offering", async () => {
    const { setup, questions, ran } = fakeSetup("needs-init", {
      confirm: yes,
      init: async () => 1,
    });
    const { output, errLines } = capture();

    expect(await setup.ensure(output, "startup")).toBe(false);
    expect(ran).toEqual(["init"]);
    expect(errLines).toEqual([
      "`kapel init` did not finish — kapel keeps working without it.",
    ]);

    // Settled: a second command does not re-run a step that just failed.
    expect(await setup.ensure(output, "command")).toBe(false);
    expect(questions).toHaveLength(1);
    expect(ran).toEqual(["init"]);
  });

  it("turns a thrown compile into one line instead of a crash", async () => {
    const { setup } = fakeSetup("needs-policy", {
      confirm: yes,
      compile: async () => {
        throw new Error("no provider credential is set in this shell");
      },
    });
    const { output, errLines } = capture();

    expect(await setup.ensure(output, "startup")).toBe(false);
    expect(errLines).toEqual([
      "`kapel policy compile` failed: no provider credential is set in this shell",
    ]);
  });

  it("names both costs in the question it asks about a fresh project", () => {
    const question = setupQuestion("needs-init");
    expect(question).toContain(".agent/");
    expect(question).toContain("one model call");
  });

  it("keeps every declined-offer line to a single line", () => {
    const states: readonly Exclude<ProjectSetupState, "ready">[] = [
      "needs-init",
      "needs-policy",
    ];
    const contexts: readonly SetupContext[] = ["startup", "command"];
    for (const state of states) {
      for (const context of contexts) {
        expect(setupDeclinedLine(state, context)).not.toContain("\n");
      }
    }
  });
});

// --- the real thing ---------------------------------------------------------

const VALID_POLICY: OrchestrationPolicy = {
  version: 1,
  orchestrator: "lead",
  maxConcurrency: 4,
  parallelizeIndependentTasks: true,
  routing: [
    {
      id: "route-coder",
      taskTypes: [],
      riskCategories: [],
      complexity: [],
      agent: "coder",
      strength: "hard",
      weight: 1,
    },
  ],
  review: [],
  escalation: [],
  defaultMaxAttempts: 2,
};

const COMPILE_RESULT: PolicyCompileResult = {
  policy: VALID_POLICY,
  warnings: ["assumed default retry policy"],
  ambiguities: [],
};

const fakeCompiler = (): PolicyCompiler => ({
  compile: async () => COMPILE_RESULT,
});

describe("createProjectSetup — over the real init and compile", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    // The compile resolves a native model before the injected factory runs;
    // the fake compiler never reaches a provider with it.
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  function realSetup(
    confirm: (question: string) => Promise<boolean>,
  ): ReturnType<typeof createProjectSetup> {
    return createProjectSetup({
      workspacePath: workspace,
      confirm,
      init: (output) => runInit({ cwd: workspace, fill: true, output }),
      compile: (output) =>
        runPolicyCompile(
          { cwd: workspace, json: false, backend: "native" },
          { output, compilerFactory: fakeCompiler },
        ),
    });
  }

  it("takes a fresh directory all the way to a compiled policy", async () => {
    const { output, lines, errLines } = capture();

    expect(await realSetup(yes).ensure(output, "startup")).toBe(true);
    expect(errLines).toEqual([]);

    const agentDir = path.join(workspace, ".agent");
    expect(await exists(path.join(agentDir, "orchestration.md"))).toBe(true);
    expect(await exists(path.join(agentDir, "config.yaml"))).toBe(true);
    expect(await exists(path.join(agentDir, "handoff.md"))).toBe(true);
    expect(await exists(path.join(agentDir, "orchestration.lock.json"))).toBe(
      true,
    );
    expect(await detectProjectSetup(workspace)).toBe("ready");

    // The compile's own summary — warnings included — reaches the caller's
    // sink, exactly as `kapel policy compile` prints it on the shell.
    const text = lines.join("\n");
    expect(text).toContain(`Created ${agentDir}`);
    expect(text).toContain("Lock written to");
    expect(text).toContain("Warnings:");
    expect(text).toContain("assumed default retry policy");

    // `kapel init`'s .gitignore entries land too.
    const gitignore = await readFile(
      path.join(workspace, ".gitignore"),
      "utf8",
    );
    expect(gitignore).toContain(".agent/sessions.db*");
  });

  it("fills in a .agent that holds nothing but the session database", async () => {
    const agentDir = path.join(workspace, ".agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "sessions.db"), "not-a-real-db");

    const { output, errLines } = capture();
    expect(await realSetup(yes).ensure(output, "command")).toBe(true);
    expect(errLines).toEqual([]);

    // The template landed, and the conversation history was not deleted to
    // make room for it.
    expect(await exists(path.join(agentDir, "orchestration.lock.json"))).toBe(
      true,
    );
    expect(await readFile(path.join(agentDir, "sessions.db"), "utf8")).toBe(
      "not-a-real-db",
    );
  });

  it("writes nothing when the offer is declined", async () => {
    const { output, lines } = capture();

    expect(await realSetup(no).ensure(output, "startup")).toBe(false);
    expect(await exists(path.join(workspace, ".agent"))).toBe(false);
    expect(lines).toEqual([setupDeclinedLine("needs-init", "startup")]);
  });
});
