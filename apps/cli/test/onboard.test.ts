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
import type { ProjectSetupState, SetupOutput } from "../src/onboard.js";
import {
  createProjectSetup,
  detectProjectSetup,
  setupAnnounceLine,
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
    interactive?: boolean;
    init?: () => Promise<number>;
    compile?: () => Promise<number>;
  } = {},
): {
  setup: ReturnType<typeof createProjectSetup>;
  ran: string[];
} {
  const ran: string[] = [];
  const setup = createProjectSetup({
    workspacePath: "/nowhere",
    detect: async () => state,
    interactive: options.interactive ?? true,
    init: async () => {
      ran.push("init");
      return (await options.init?.()) ?? 0;
    },
    compile: async () => {
      ran.push("compile");
      return (await options.compile?.()) ?? 0;
    },
  });
  return { setup, ran };
}

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

// --- automatic setup ---------------------------------------------------------

describe("createProjectSetup", () => {
  it("runs init then the compile immediately when the project is fresh", async () => {
    const { setup, ran } = fakeSetup("needs-init");
    const { output, lines, errLines } = capture();

    expect(await setup.ensure(output)).toBe(true);
    expect(ran).toEqual(["init", "compile"]);
    expect(lines).toEqual([setupAnnounceLine("needs-init", false)]);
    expect(errLines).toEqual([]);
  });

  it("runs only the compile when the project exists but has no lock", async () => {
    const { setup, ran } = fakeSetup("needs-policy");
    const { output, lines } = capture();

    expect(await setup.ensure(output)).toBe(true);
    // Nothing on disk here (the state is faked), so the announcement takes
    // the cautious branch and names the model call it cannot rule out.
    expect(lines).toEqual([setupAnnounceLine("needs-policy", true)]);
    expect(lines[0]).toContain("one model call");
    expect(ran).toEqual(["compile"]);
  });

  it("says nothing at all, and runs nothing, when the project is ready", async () => {
    const { setup, ran } = fakeSetup("ready");
    const { output, lines, errLines } = capture();

    expect(await setup.ensure(output)).toBe(true);
    expect(ran).toEqual([]);
    expect(lines).toEqual([]);
    expect(errLines).toEqual([]);
  });

  it("never runs without someone to see it happen (piped, non-interactive stdin)", async () => {
    const { setup, ran } = fakeSetup("needs-init", { interactive: false });
    const { output, lines, errLines } = capture();

    expect(await setup.ensure(output)).toBe(false);
    expect(ran).toEqual([]);
    expect(lines).toEqual([]);
    expect(errLines).toEqual([]);
  });

  it("reports a failed init, skips the compile, and stops trying again", async () => {
    const { setup, ran } = fakeSetup("needs-init", {
      init: async () => 1,
    });
    const { output, errLines } = capture();

    expect(await setup.ensure(output)).toBe(false);
    expect(ran).toEqual(["init"]);
    expect(errLines).toEqual([
      "`kapel init` did not finish — kapel keeps working without it.",
    ]);

    // Settled: a second call does not re-run a step that just failed.
    expect(await setup.ensure(output)).toBe(false);
    expect(ran).toEqual(["init"]);
  });

  it("turns a thrown compile into one line instead of a crash", async () => {
    const { setup } = fakeSetup("needs-policy", {
      compile: async () => {
        throw new Error("no provider credential is set in this shell");
      },
    });
    const { output, errLines } = capture();

    expect(await setup.ensure(output)).toBe(false);
    expect(errLines).toEqual([
      "`kapel policy compile` failed: no provider credential is set in this shell",
    ]);
  });

  it("names the files a fresh project costs, and no model call it will not spend", () => {
    const line = setupAnnounceLine("needs-init", false);
    expect(line).toContain(".agent/");
    expect(line).not.toContain("one model call");
    expect(setupAnnounceLine("needs-init", true)).toContain("one model call");
  });

  it("keeps every announce line to a single line", () => {
    const states: readonly Exclude<ProjectSetupState, "ready">[] = [
      "needs-init",
      "needs-policy",
    ];
    for (const state of states) {
      for (const callsModel of [true, false]) {
        expect(setupAnnounceLine(state, callsModel)).not.toContain("\n");
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
    interactive = true,
  ): ReturnType<typeof createProjectSetup> {
    return createProjectSetup({
      workspacePath: workspace,
      interactive,
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

    expect(await realSetup().ensure(output)).toBe(true);
    expect(errLines).toEqual([]);
    expect(lines[0]).toBe(setupAnnounceLine("needs-init", false));

    const agentDir = path.join(workspace, ".agent");
    expect(await exists(path.join(agentDir, "orchestration.md"))).toBe(true);
    expect(await exists(path.join(agentDir, "config.yaml"))).toBe(true);
    expect(await exists(path.join(agentDir, "handoff.md"))).toBe(true);
    expect(await exists(path.join(agentDir, "orchestration.lock.json"))).toBe(
      true,
    );
    expect(await detectProjectSetup(workspace)).toBe("ready");

    // The compile's own summary reaches the caller's sink, exactly as
    // `kapel policy compile` prints it on the shell — and what it says is
    // that the shipped template was read rather than compiled.
    const text = lines.join("\n");
    expect(text).toContain(`Created ${agentDir}`);
    expect(text).toContain("Lock written to");
    expect(text).toContain("no model call");
    expect(text).not.toContain("assumed default retry policy");

    // `kapel init`'s .gitignore entries land too.
    const gitignore = await readFile(
      path.join(workspace, ".gitignore"),
      "utf8",
    );
    expect(gitignore).toContain(".agent/sessions.db*");
  });

  it("sets a fresh project up with no provider credential at all", async () => {
    // The canonical template never reaches a provider, so the compile that
    // used to need `ANTHROPIC_API_KEY` (or a logged-in CLI) now needs
    // nothing — which is the whole point of not calling a model to read it.
    delete process.env.ANTHROPIC_API_KEY;
    const { output, lines, errLines } = capture();

    expect(
      await createProjectSetup({
        workspacePath: workspace,
        interactive: true,
        init: (out) => runInit({ cwd: workspace, fill: true, output: out }),
        compile: (out) =>
          runPolicyCompile(
            { cwd: workspace, json: false, backend: "native" },
            { output: out },
          ),
      }).ensure(output),
    ).toBe(true);
    expect(errLines).toEqual([]);
    expect(lines.join("\n")).toContain("no model call");
    expect(await detectProjectSetup(workspace)).toBe("ready");
  });

  it("still compiles a policy rewritten as prose, through the model", async () => {
    const { output, lines } = capture();
    expect(await realSetup().ensure(output)).toBe(true);

    // Rewriting the policy in prose drops the canonical marker, which is how
    // someone opts back into a model compile — and the compiler's warnings
    // come back with it.
    await writeFile(
      path.join(workspace, ".agent", "orchestration.md"),
      "Send everything to `coder`, and be quick about it.\n",
      "utf8",
    );
    const second = capture();
    expect(
      await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        { output: second.output, compilerFactory: fakeCompiler },
      ),
    ).toBe(0);

    const text = second.lines.join("\n");
    expect(text).toContain("Warnings:");
    expect(text).toContain("assumed default retry policy");
    expect(text).not.toContain("no model call");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("fills in a .agent that holds nothing but the session database", async () => {
    const agentDir = path.join(workspace, ".agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "sessions.db"), "not-a-real-db");

    const { output, errLines } = capture();
    expect(await realSetup().ensure(output)).toBe(true);
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

  it("writes nothing when there is no terminal to show it to", async () => {
    const { output, lines } = capture();

    expect(await realSetup(false).ensure(output)).toBe(false);
    expect(await exists(path.join(workspace, ".agent"))).toBe(false);
    expect(lines).toEqual([]);
  });
});
