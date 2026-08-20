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
 * kapel, so the REPL offers to run them the first time it opens in a project
 * that has neither.
 *
 * Nothing here runs without being asked first: compiling costs a model call
 * and init writes files into someone's repository. And nothing here is ever
 * offered where there is nobody to answer — a piped `kapel < script.txt` gets
 * no `confirm` and therefore no offer, the same way `/login` never spawns a
 * login nobody asked for.
 */

/** How much of the setup a workspace is still missing. */
export type ProjectSetupState =
  /** `.agent/` holds a project *and* a compiled policy lock: nothing to do. */
  | "ready"
  /** No project here yet: `kapel init`, then a policy compile. */
  | "needs-init"
  /** A project, but its policy has never been compiled: just the compile. */
  | "needs-policy";

/** Where the offer (and whatever it runs) writes its lines. */
export interface SetupOutput {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** Which moment is asking — it decides what a declined offer promises next. */
export type SetupContext =
  /** The REPL opening in this directory, before the first prompt. */
  | "startup"
  /** `/plan` or `/orchestrate`, re-offering what startup didn't get to do. */
  | "command";

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
 * containing only kapel's own state is not a project — offering to compile a
 * policy that isn't there would only produce the error this whole feature
 * exists to remove.
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
 * The one question each state asks. Both name the cost up front — files
 * written, a model call spent — because that is the whole reason this is a
 * question and not something kapel just does.
 */
export function setupQuestion(
  state: Exclude<ProjectSetupState, "ready">,
): string {
  return state === "needs-init"
    ? "This project isn't set up for kapel yet. Set it up now? " +
        "(creates .agent/ with default agents and compiles the orchestration " +
        "policy — one model call)"
    : "This project's orchestration policy isn't compiled yet. Compile it " +
        "now? (one model call)";
}

/**
 * The single line a declined offer leaves behind: the commands that do the
 * same thing on the shell, and — at startup, where `/plan` and `/orchestrate`
 * will ask once more — the fact that saying no now costs nothing later.
 */
export function setupDeclinedLine(
  state: Exclude<ProjectSetupState, "ready">,
  context: SetupContext,
): string {
  const commands =
    state === "needs-init"
      ? "`kapel init` and `kapel policy compile`"
      : "`kapel policy compile`";
  return context === "startup"
    ? `ok — run ${commands} on the shell when you want it, or /plan and /orchestrate will offer again.`
    : `ok — run ${commands} on the shell when you want it.`;
}

export interface ProjectSetupDeps {
  readonly workspacePath: string;
  /**
   * Asks the yes/no question, defaulting to yes. Absent means there is nobody
   * at a terminal to ask — a piped or redirected REPL — and nothing is ever
   * offered or run.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Runs `kapel init` in this workspace, reporting through `output`. */
  readonly init: (output: SetupOutput) => Promise<number>;
  /** Runs `kapel policy compile` in this workspace, reporting through `output`. */
  readonly compile: (output: SetupOutput) => Promise<number>;
  /** Overridable in tests; defaults to {@link detectProjectSetup}. */
  readonly detect?: (workspacePath: string) => Promise<ProjectSetupState>;
}

export interface ProjectSetup {
  /**
   * Makes sure this workspace is set up, asking first.
   *
   * @returns whether the project is ready now. `false` is never fatal: the
   * caller carries on — plain chat needs no `.agent/` at all, and `/plan`
   * falls through to the error it has always printed.
   */
  ensure(output: SetupOutput, context: SetupContext): Promise<boolean>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The onboarding offer, with one session's worth of memory.
 *
 * Once an offer has been declined — or accepted and then failed — this stops
 * offering for the life of the process, so a REPL where someone said no does
 * not ask again on every `/plan`. Nothing is written down: a fresh `kapel`
 * asks again, which is the right default for a decision whose answer is
 * usually "not right now" rather than "never".
 *
 * A failure counts as settled for the same reason: an init that cannot find
 * its template, or a compile with no usable credential, will fail again the
 * next time too, and repeating it once per command would bury the error that
 * explains it.
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
    ensure: async (output, context) => {
      if (settled) return false;

      const state = await detect(deps.workspacePath);
      if (state === "ready") return true;
      if (deps.confirm === undefined) return false;

      if (!(await deps.confirm(setupQuestion(state)))) {
        settled = true;
        output.log(setupDeclinedLine(state, context));
        return false;
      }

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
