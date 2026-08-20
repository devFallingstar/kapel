import type { ModelUsage } from "@agent/ai";
import type {
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import type { EventSink } from "@agent/protocol";
import type { ClaudeCodeBackendOptions } from "../backends/claude-code.js";
import { ClaudeCodeBackend } from "../backends/claude-code.js";
import type { DelegatedWorkerUsageSink } from "../planning/delegated-cli.js";
import { recordDelegatedWorkerUsage } from "../planning/delegated-cli.js";
import type { AgentProject, HandoffGuidance } from "../project/index.js";
import { buildTaskBriefing } from "./briefing.js";
import {
  inspectWorkspaceChanges,
  type NormalizableRun,
  normalizeTaskResult,
} from "./normalize.js";
import { applyReviewVerdict, reviewVerdictFromRun } from "./review.js";

/**
 * Bare template tool names mapped to the Claude Code tool that does the same
 * job.
 *
 * `.agent/agents/*.md` files spell tools the way a human writes them
 * ("read", "write", "edit") — the same vocabulary `selectToolsForAgent`
 * resolves against this repo's builtin tools. Claude Code names its own
 * tools differently again, so the template vocabulary is translated here
 * rather than assumed to line up. Keys are canonicalized (see
 * {@link canonicalize}).
 */
const TEMPLATE_TOOL_TO_CLAUDE_CODE: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  glob: "Glob",
  bash: "Bash",
  // Claude Code has no dedicated diff tool; `git diff` is a bash invocation,
  // scoped to that one command by the `Bash(<prefix>:*)` specifier syntax.
  "git.diff": "Bash(git diff:*)",
};

/** Namespace wildcards (`git.*`) mapped to a Claude Code specifier. */
const TEMPLATE_NAMESPACE_TO_CLAUDE_CODE: Readonly<Record<string, string>> = {
  git: "Bash(git:*)",
};

/**
 * Canonicalizes a tool name or pattern the same way `selectToolsForAgent`
 * does: lowercase, with `_` and `.` treated as one separator, so `git.diff`
 * and `git_diff` (and `Git_Diff`) all become `git.diff`.
 */
function canonicalize(name: string): string {
  return name.toLowerCase().replaceAll("_", ".");
}

/**
 * Translates an agent's `tools:` list into the `--allowedTools` values the
 * Claude Code CLI understands, or `undefined` when the run should not scope
 * tools at all.
 *
 * Mapping is exact-after-canonicalization, mirroring `selectToolsForAgent`'s
 * strict-but-normalized matching: `read` → `Read`, `git_diff`/`git.diff` →
 * `Bash(git diff:*)`, `git.*`/`git_*` → `Bash(git:*)`. Prefixes never match
 * implicitly, and anything with no Claude Code equivalent — the
 * orchestrator's `task.*`, `worker.*`, `result.*`, `plan.*`, or a tool this
 * table has simply never heard of — is dropped, exactly as those patterns
 * are dropped when selecting builtin tools.
 *
 * Two cases return `undefined`, i.e. "spawn without `--allowedTools`, let
 * Claude Code use its full default toolset":
 *
 * - **An empty pattern list.** An agent file that omits `tools:` has not
 *   asked to be sandboxed, it has just not made a choice — the same rule
 *   `selectToolsForAgent` applies when it returns every builtin.
 * - **Every pattern dropped.** This one is an approximation, and a
 *   deliberate one. Such an agent *did* make a choice, so the faithful
 *   translation would be "allow nothing" — but `--allowedTools` cannot
 *   express that (an empty list is indistinguishable from omitting the flag,
 *   and the backend skips empty arrays anyway), and a worker that can read
 *   nothing and write nothing cannot do a task at all. Falling back to
 *   Claude Code's own defaults keeps the task runnable; Claude Code's
 *   permission mode is still the gate on anything destructive. The only
 *   agent in the default templates that hits this is the orchestrator, which
 *   is not routed to workers in the first place.
 *
 * Output is deduped and keeps first-seen order, so the same agent always
 * produces the same `--allowedTools` string.
 */
export function claudeCodeAllowedTools(
  patterns: readonly string[],
): readonly string[] | undefined {
  if (patterns.length === 0) return undefined;

  const allowed = new Set<string>();
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === "") continue;

    const canonical = canonicalize(trimmed);
    if (canonical.endsWith(".*")) {
      const mapped = TEMPLATE_NAMESPACE_TO_CLAUDE_CODE[canonical.slice(0, -2)];
      if (mapped !== undefined) allowed.add(mapped);
      continue;
    }

    const mapped = TEMPLATE_TOOL_TO_CLAUDE_CODE[canonical];
    if (mapped !== undefined) allowed.add(mapped);
  }

  return allowed.size === 0 ? undefined : [...allowed];
}

/**
 * Resolves the `--allowedTools` list for a routed agent from the project's
 * own `.agent/agents/<name>.md` `tools:` front matter.
 *
 * Lives beside {@link claudeCodeAllowedTools} rather than next to
 * `createDelegatedModelResolver`: a model id is provider-agnostic and every
 * delegating CLI takes one, but a tool list is only meaningful once it has
 * been translated into one specific CLI's tool names, which makes this a
 * Claude Code concern rather than a shared "delegated backend" one.
 *
 * Unknown agents resolve to `undefined`, same as an agent that named no
 * tools: the executor then leaves `backendOptions.allowedTools` in place.
 */
export function createDelegatedToolsResolver(
  project: AgentProject,
): (agent: string) => readonly string[] | undefined {
  return (agent) => {
    const projectAgent = project.agent(agent);
    if (projectAgent === undefined) return undefined;
    return claudeCodeAllowedTools(projectAgent.tools);
  };
}

export interface ClaudeCodeWorkerExecutorOptions {
  readonly workspacePath: string;
  readonly runId: string;
  readonly events?: EventSink;
  readonly taskTimeoutMs?: number;
  /**
   * Passed through to {@link ClaudeCodeBackend}. `events` and `timeoutMs`
   * here are overridden by the executor-level options above when those are
   * set; `model` is overridden per task by {@link resolveAgentModel} and
   * `allowedTools` by {@link resolveAgentTools}, whenever those resolvers
   * have an answer for the routed agent.
   */
  readonly backendOptions?: ClaudeCodeBackendOptions;
  /**
   * Looks up the model the routed agent is configured for, typically
   * `createDelegatedModelResolver` bound to the run's `AgentProject`.
   *
   * A per-task result overrides `backendOptions.model` for that task — the
   * router picked this agent for a reason, and an agent-specific model is a
   * more specific choice than a run-wide default — while `undefined` (agent
   * unknown, alias unresolved, or `config.yaml` says "default") leaves
   * `backendOptions.model` as the fallback so a run-wide `--model` still
   * applies.
   */
  readonly resolveAgentModel?: (agent: string) => string | undefined;
  /**
   * Looks up the `--allowedTools` list for the routed agent, typically
   * {@link createDelegatedToolsResolver} bound to the run's `AgentProject`.
   *
   * Same precedence as {@link resolveAgentModel}: a per-agent answer wins
   * over `backendOptions.allowedTools`, and `undefined` falls back to it —
   * which in turn defaults to not passing `--allowedTools` at all.
   */
  readonly resolveAgentTools?: (agent: string) => readonly string[] | undefined;
  /**
   * Where to report what Claude Code said each task attempt spent, when the
   * caller is keeping a ledger (an orchestration run opens one for the whole
   * run). Left out, nothing is recorded — which is not the same as recording
   * zero, mirroring `DelegatedPlannerOptions.usage`.
   */
  readonly usage?: DelegatedWorkerUsageSink;
  /**
   * The project's `.agent/handoff.md` guidance, normally `project.handoff`.
   * Only the briefing's sections apply here — a delegated CLI brings its own
   * system prompt, so `## common` has nowhere to go — and the review verdict
   * contract is appended after `## reviewer` either way.
   */
  readonly handoff?: HandoffGuidance | undefined;
}

/**
 * Runs orchestration tasks through Anthropic's official Claude Code CLI
 * instead of the in-process agent loop.
 *
 * Claude Code owns its own agent loop, context and approvals, so this
 * executor is a thin adapter: same task briefing in, same workspace
 * inspection out. What sets it apart from the Codex executor is
 * that tool access is *not* entirely the CLI's business here — `claude`
 * accepts `--allowedTools` per invocation, so the `tools:` list an agent
 * declares in `.agent/agents/<name>.md` can be honoured per task instead of
 * being dropped on the floor (see {@link claudeCodeAllowedTools}). The
 * reviewer agent really does run without `Write`/`Edit`, the way it does on
 * the native loop. Approvals remain Claude Code's own (`acceptEdits` by
 * default, see `ClaudeCodeBackendOptions.permissionMode`): the tool list
 * says what may be reached for, not what may be done without asking.
 */
export class ClaudeCodeWorkerExecutor implements WorkerExecutor {
  readonly #options: ClaudeCodeWorkerExecutorOptions;

  constructor(options: ClaudeCodeWorkerExecutorOptions) {
    this.#options = options;
  }

  /**
   * The model {@link resolveAgentModel} would resolve for `agent`, falling
   * back to `backendOptions.model` — the same precedence {@link execute}
   * applies when it builds the {@link ClaudeCodeBackend} for a task, exposed
   * here so it can be reported before the task actually runs.
   */
  #modelFor(agent: string): string | undefined {
    return (
      this.#options.resolveAgentModel?.(agent) ??
      this.#options.backendOptions?.model
    );
  }

  /** The `--allowedTools` list for `agent`; see {@link resolveAgentTools}. */
  #toolsFor(agent: string): readonly string[] | undefined {
    return (
      this.#options.resolveAgentTools?.(agent) ??
      this.#options.backendOptions?.allowedTools
    );
  }

  describeAgent(agent: string): WorkerAgentDescription | undefined {
    const model = this.#modelFor(agent);
    return model === undefined ? undefined : { model };
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const taskId = task.spec.id;
    const { workspacePath, runId } = this.#options;
    const model = this.#modelFor(agent);
    const allowedTools = this.#toolsFor(agent);

    const backend = new ClaudeCodeBackend({
      ...this.#options.backendOptions,
      ...(model === undefined ? {} : { model }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(this.#options.events === undefined
        ? {}
        : { events: this.#options.events }),
      ...(this.#options.taskTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#options.taskTimeoutMs }),
    });

    let run: NormalizableRun;
    // Kept separate from `run` (typed to only the fields normalization reads)
    // so recording usage below does not depend on widening that type.
    let reportedUsage: ModelUsage | undefined;
    try {
      const backendResult = await backend.run(
        {
          instruction: buildTaskBriefing(task.spec, agent, context, {
            reviewContract: "json-reply",
            handoff: this.#options.handoff,
          }),
        },
        {
          runId,
          taskId,
          workspacePath,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      run = backendResult;
      reportedUsage = backendResult.usage;
    } catch (error) {
      run = {
        status: "failed",
        summary: `Claude Code backend crashed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Recorded regardless of outcome, same as the planner's per-attempt
    // recording: a failed or partial task still cost whatever Claude Code
    // reported.
    recordDelegatedWorkerUsage(
      this.#options.usage,
      { agent, taskId, model },
      reportedUsage,
    );

    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    const result = normalizeTaskResult({ taskId, loop: run, inspection });

    // The verdict, not the prose, decides a review — exactly as on the native
    // loop, which reads it off the tool it injected. Here it is parsed out of
    // the reply the briefing asked for, and a reply with no readable verdict
    // fails the task: a reviewer that answers "REJECTED, this is unsafe" in
    // prose must not be recorded as a success just because the CLI exited 0.
    if (task.spec.type !== "review") return result;
    return applyReviewVerdict(result, reviewVerdictFromRun(run));
  }
}
