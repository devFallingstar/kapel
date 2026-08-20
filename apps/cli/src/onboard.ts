import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Automatic project onboarding: the two commands a new repository used to
 * need before `/plan` and `/orchestrate` worked at all.
 *
 * `kapel init` writes `.agent/` (agents, `config.yaml` with this repo's
 * detected validators, `handoff.md`, the `.gitignore` entries) and `kapel
 * policy compile` turns `.agent/orchestration.md` into the lockfile the
 * scheduler enforces. Both are still commands — a CI job or a scripted setup
 * wants them spelled out — but nobody should have to *know* them to use
 * kapel, so the REPL just runs them itself the first time it opens in a
 * project that has neither: one announcing line, then the work.
 *
 * Nothing here runs where there is nobody to see it happen: a piped `kapel <
 * script.txt` gets no announcing line and nothing is run, the same way
 * `/login` never spawns a login nobody asked for. `--no-setup` is the other
 * way to say the same thing on a real terminal.
 */

/** How much of the setup a workspace is still missing. */
export type ProjectSetupState =
  /** `.agent/` holds a project *and* a compiled policy lock: nothing to do. */
  | "ready"
  /** No project here yet: `kapel init`, then a policy compile. */
  | "needs-init"
  /** A project, but its policy has never been compiled: just the compile. */
  | "needs-policy";

/** Where the setup (and whatever it runs) writes its lines. */
export interface SetupOutput {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

const ORCHESTRATION_FILE = "orchestration.md";
const LOCK_FILE = "orchestration.lock.json";

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * What this workspace still needs.
 *
 * Keyed on `.agent/orchestration.md` rather than on `.agent/` itself, because
 * the directory alone proves nothing: the REPL creates one in any directory
 * it opens, just to hold `sessions.db` (see `openChatStore`), and a directory
 * containing only kapel's own state is not a project — running a compile
 * against a policy that isn't there would only produce the error this whole
 * feature exists to remove.
 *
 * Only a *missing* lock counts as `needs-policy`. A lock that has gone stale
 * against an edited `orchestration.md` is a different situation with a
 * different answer (`kapel policy compile` to refresh it, which `/plan`
 * already says), and silently recompiling someone's edited policy at startup
 * is not this feature's business.
 */
export async function detectProjectSetup(
  workspacePath: string,
): Promise<ProjectSetupState> {
  const agentDir = path.join(workspacePath, ".agent");
  if (!(await pathExists(path.join(agentDir, ORCHESTRATION_FILE)))) {
    return "needs-init";
  }
  if (!(await pathExists(path.join(agentDir, LOCK_FILE)))) {
    return "needs-policy";
  }
  return "ready";
}

/**
 * The one line each state announces before it runs. Both name the cost up
 * front — files written, a model call spent — because that is what makes
 * kapel just doing this on its own a reasonable thing to do rather than a
 * surprise.
 */
export function setupAnnounceLine(
  state: Exclude<ProjectSetupState, "ready">,
): string {
  return state === "needs-init"
    ? "setting this project up for kapel — creating .agent/ and compiling " +
        "the orchestration policy (one model call)…"
    : "compiling this project's orchestration policy for kapel (one model " +
        "call)…";
}

export interface ProjectSetupDeps {
  readonly workspacePath: string;
  /**
   * Whether this is a run kapel may set the project up on its own for —
   * effectively "is there a real terminal watching, and has it not said
   * `--no-setup`". `false` (the default) means there is nobody to show the
   * announcing line to, so nothing is ever run: a piped or redirected REPL,
   * or one that opted out.
   */
  readonly interactive?: boolean;
  /** Runs `kapel init` in this workspace, reporting through `output`. */
  readonly init: (output: SetupOutput) => Promise<number>;
  /** Runs `kapel policy compile` in this workspace, reporting through `output`. */
  readonly compile: (output: SetupOutput) => Promise<number>;
  /** Overridable in tests; defaults to {@link detectProjectSetup}. */
  readonly detect?: (workspacePath: string) => Promise<ProjectSetupState>;
}

export interface ProjectSetup {
  /**
   * Makes sure this workspace is set up, doing it itself if it is not.
   *
   * @returns whether the project is ready now. `false` is never fatal: the
   * caller carries on — plain chat needs no `.agent/` at all, and `/plan`
   * falls through to the error it has always printed.
   */
  ensure(output: SetupOutput): Promise<boolean>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Automatic project setup, with one session's worth of memory.
 *
 * Once a setup has failed, this stops trying again for the life of the
 * process, so a REPL whose init or compile just failed does not retry it on
 * every `/plan`. Nothing is written down: a fresh `kapel` tries again, which
 * is right for a failure that might have been a transient credential or
 * network problem rather than something permanently wrong with the project.
 */
export function createProjectSetup(deps: ProjectSetupDeps): ProjectSetup {
  const detect = deps.detect ?? detectProjectSetup;
  let settled = false;

  /** Runs one step, turning any failure into a line and a `false`. */
  const step = async (
    label: string,
    run: (output: SetupOutput) => Promise<number>,
    output: SetupOutput,
  ): Promise<boolean> => {
    let code: number;
    try {
      code = await run(output);
    } catch (error) {
      output.error(`${label} failed: ${errorText(error)}`);
      return false;
    }
    if (code === 0) return true;
    // The step itself already said what went wrong, through this same sink.
    output.error(`${label} did not finish — kapel keeps working without it.`);
    return false;
  };

  return {
    ensure: async (output) => {
      if (settled) return false;

      const state = await detect(deps.workspacePath);
      if (state === "ready") return true;
      if (deps.interactive !== true) return false;

      output.log(setupAnnounceLine(state));

      if (state === "needs-init") {
        if (!(await step("`kapel init`", deps.init, output))) {
          settled = true;
          return false;
        }
      }
      if (!(await step("`kapel policy compile`", deps.compile, output))) {
        settled = true;
        return false;
      }
      return true;
    },
  };
}
