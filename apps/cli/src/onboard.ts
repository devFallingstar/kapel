import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { checkLock, isCanonicalPolicySource } from "@agent/coding-agent";

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
  /** `.agent/` holds a project and a lock that still describes it: nothing to do. */
  | "ready"
  /** No project here yet: `kapel init`, then a policy compile. */
  | "needs-init"
  /** A project, but its policy has never been compiled: just the compile. */
  | "needs-policy"
  /**
   * A project whose lock no longer describes its policy — the file was
   * edited, or the lock is unreadable. Also just the compile.
   */
  | "needs-refresh";

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

async function readOptional(candidate: string): Promise<string | undefined> {
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return undefined;
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
 * A lock that has gone stale against an edited policy is `needs-refresh`. It
 * used to be `ready`, on the grounds that silently recompiling someone's edit
 * would spend a model call they had not asked for — a good reason while every
 * compile cost one. A canonical policy is now *read* rather than compiled, so
 * the refresh is free, and the cost question is settled where it belongs:
 * {@link setupCallsModel} prices the work and `allowModel` decides whether it
 * runs now. Editing the policy and having the lock follow is what anyone
 * would expect; making them run a command for it was never the point.
 */
export async function detectProjectSetup(
  workspacePath: string,
): Promise<ProjectSetupState> {
  const agentDir = path.join(workspacePath, ".agent");
  const markdown = await readOptional(path.join(agentDir, ORCHESTRATION_FILE));
  if (markdown === undefined) return "needs-init";

  const lockPath = path.join(agentDir, LOCK_FILE);
  if (!(await pathExists(lockPath))) return "needs-policy";

  // `stale-source` and `invalid` both mean the same thing here: whatever is
  // in that file, it is not this policy, and compiling makes it so.
  return checkLock(markdown, await readOptional(lockPath)).fresh
    ? "ready"
    : "needs-refresh";
}

/**
 * Whether the compile this setup is about to run will call a model.
 *
 * A policy in kapel's canonical form is read rather than compiled (see
 * `canonical.ts`), which is the case for every project kapel sets up itself —
 * `kapel init` copies a canonical template, and a test keeps it that way. So
 * a fresh project costs nothing but the files, and only a workspace whose
 * policy has been rewritten as prose pays for a model.
 *
 * Answered by reading the source rather than assumed, because guessing wrong
 * in either direction is a lie about a cost: promising a model call that
 * never happens teaches people to distrust the line, and staying quiet about
 * one that does is the surprise this whole announcement exists to prevent.
 */
export async function setupCallsModel(
  workspacePath: string,
  state: Exclude<ProjectSetupState, "ready">,
): Promise<boolean> {
  // `needs-init` means there is no policy here yet, so the one about to be
  // compiled is the template's — canonical by construction.
  if (state === "needs-init") return false;
  try {
    const markdown = await readFile(
      path.join(workspacePath, ".agent", ORCHESTRATION_FILE),
      "utf8",
    );
    return !isCanonicalPolicySource(markdown);
  } catch {
    // Unreadable here means the compile is about to fail on it anyway; claim
    // the higher cost rather than the lower one.
    return true;
  }
}

/**
 * The line startup prints instead of compiling, when the compile would call a
 * model and nobody has asked for any work yet.
 *
 * Said rather than done, and said once: the user needs to know the project is
 * not ready and what will make it ready, but a REPL they opened to ask a
 * question must not spend their tokens on a policy they have not used.
 */
export function setupDeferredLine(
  state: Exclude<ProjectSetupState, "ready">,
): string {
  const what =
    state === "needs-refresh"
      ? "has changed since it was compiled"
      : "has not been compiled";
  return (
    `this project's orchestration policy ${what} — /plan or /orchestrate ` +
    "will compile it (one model call), or `/policy` rewrites it in the form " +
    "that needs none."
  );
}

/**
 * The one line each state announces before it runs. Every one of them names
 * the cost up front — files written, and a model call only when there will
 * actually be one — because that is what makes kapel just doing this on its
 * own a reasonable thing to do rather than a surprise.
 */
export function setupAnnounceLine(
  state: Exclude<ProjectSetupState, "ready">,
  callsModel: boolean,
): string {
  const cost = callsModel ? " (one model call)" : "";
  if (state === "needs-init") {
    return (
      "setting this project up for kapel — creating .agent/ and compiling " +
      `the orchestration policy${cost}…`
    );
  }
  if (state === "needs-refresh") {
    return `re-reading this project's edited orchestration policy${cost}…`;
  }
  return `compiling this project's orchestration policy for kapel${cost}…`;
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

/** How much this call is allowed to spend. */
export interface EnsureOptions {
  /**
   * Whether a step that calls a model may run now.
   *
   * The whole point of the split: **no model is called before the user asks
   * for work.** Startup passes `false`, so opening a REPL — to chat, to read
   * something, to do anything that is not orchestration — never spends a
   * token on setup. `/plan` and `/orchestrate` pass `true`, because by then
   * the user has handed kapel a job and compiling the policy is part of
   * doing it.
   *
   * Nearly everything is free either way: `kapel init` copies files, and the
   * policy it copies is canonical, so its compile is a parse. Only a project
   * whose policy has been rewritten as prose has a step this can defer.
   */
  readonly allowModel?: boolean;
}

export interface ProjectSetup {
  /**
   * Makes sure this workspace is set up, doing it itself if it is not — and
   * within {@link EnsureOptions.allowModel}, which decides whether a step
   * that would call a model runs now or waits.
   *
   * @returns whether the project is ready now. `false` is never fatal: the
   * caller carries on — plain chat needs no `.agent/` at all, and `/plan`
   * falls through to the error it has always printed.
   */
  ensure(output: SetupOutput, options?: EnsureOptions): Promise<boolean>;
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
 *
 * A *deferral* is not a failure and is not remembered that way: startup
 * declining to spend a model call has to leave the next `/plan` free to spend
 * one. Only the line it prints is remembered, so a session hears it once.
 */
export function createProjectSetup(deps: ProjectSetupDeps): ProjectSetup {
  const detect = deps.detect ?? detectProjectSetup;
  let settled = false;
  let announcedDeferral = false;

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
    ensure: async (output, options = {}) => {
      if (settled) return false;

      const state = await detect(deps.workspacePath);
      if (state === "ready") return true;
      if (deps.interactive !== true) return false;

      const callsModel = await setupCallsModel(deps.workspacePath, state);
      if (callsModel && options.allowModel !== true) {
        // Nothing has been asked of kapel yet, and this step costs tokens.
        // Say so and stop — deliberately without setting `settled`, so the
        // `/plan` that does ask still gets to run it.
        if (!announcedDeferral) {
          announcedDeferral = true;
          output.log(setupDeferredLine(state));
        }
        return false;
      }

      output.log(setupAnnounceLine(state, callsModel));

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
