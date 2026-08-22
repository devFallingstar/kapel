import type { ModelUsage } from "@agent/ai";
import type {
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import type { EventSink } from "@agent/protocol";
import { agentEvent } from "@agent/protocol";
import type { CodexBackendOptions, CodexSandbox } from "../backends/codex.js";
import { CodexBackend } from "../backends/codex.js";
import type { DelegatedWorkerUsageSink } from "../planning/delegated-cli.js";
import { recordDelegatedWorkerUsage } from "../planning/delegated-cli.js";
import type { AgentProject, HandoffGuidance } from "../project/index.js";
import { builtinTools } from "../tools/index.js";
import { selectToolsForAgent } from "./agent-loop-executor.js";
import { buildTaskBriefing } from "./briefing.js";
import {
  inspectWorkspaceChanges,
  type NormalizableRun,
  normalizeTaskResult,
} from "./normalize.js";
import { applyReviewVerdict, reviewVerdictFromRun } from "./review.js";

/**
 * Builtin tools capable of changing the workspace or running an arbitrary
 * command. This is the one distinction {@link codexToolScopingFor} can carry
 * across into a Codex `--sandbox` mode — see that function's doc for why
 * nothing finer-grained survives the trip.
 */
const CODEX_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "bash",
]);

/**
 * What an agent's `tools:` list means for the Codex CLI's sandbox, which is
 * the only lever this backend has over what a task may do — see
 * `CodexBackendOptions.sandbox` and the class doc below.
 *
 * Codex has no per-tool allowlist the way the native loop
 * ({@link selectToolsForAgent}) or Claude Code (`--allowedTools`) do; the only
 * knob is `--sandbox` (`read-only` / `workspace-write` /
 * `danger-full-access`), which gates the whole subprocess rather than one
 * named tool. So the mapping here is deliberately narrow:
 *
 * - No `tools:` restriction, or one that (after {@link selectToolsForAgent}
 *   resolves it) still grants every builtin tool: the agent made no
 *   meaningful choice, so `"unscoped"` — Codex's own default sandbox applies,
 *   same as an agent with no `tools:` line at all.
 * - A restriction that grants **none** of {@link CODEX_MUTATING_TOOL_NAMES}:
 *   the agent's intent — "look, don't touch" — has a faithful sandbox
 *   equivalent, `"read-only"`. It is still an approximation: a reviewer
 *   scoped to `read, grep` and one scoped to `read` alone both collapse onto
 *   the same sandbox, because Codex cannot distinguish "no grep" from "no
 *   bash" the way a per-tool allowlist could. But neither one can ever write,
 *   which is the property `read-only` actually guarantees and the one that
 *   matters for, say, a reviewer agent.
 * - Anything else — a restriction that keeps some but not all of the
 *   mutating tools (`bash` without `write`/`edit`, say) — has no Codex
 *   sandbox equivalent at all: every mode above `read-only` permits every one
 *   of the CLI's own file and shell operations, with nothing in between.
 *   `"unsupported"` is what {@link CodexWorkerExecutor} turns into the
 *   once-per-run `backend.tool_scoping_unsupported` warning, because running
 *   such an agent unrestricted without saying so is the silent degradation
 *   `docs/FUTURE_WORK.md` used to just document and move on from.
 */
export function codexToolScopingFor(
  patterns: readonly string[],
): "unscoped" | "read-only" | "unsupported" {
  if (patterns.length === 0) return "unscoped";

  const allTools = builtinTools();
  const selected = selectToolsForAgent(allTools, patterns);
  if (selected.length === allTools.length) return "unscoped";

  const grantsMutation = selected.some((tool) =>
    CODEX_MUTATING_TOOL_NAMES.has(tool.name),
  );
  return grantsMutation ? "unsupported" : "read-only";
}

/**
 * Resolves the raw `tools:` patterns a routed agent declared in its
 * `.agent/agents/<name>.md` front matter, for {@link codexToolScopingFor} to
 * turn into a sandbox decision.
 *
 * Deliberately returns the patterns themselves rather than a translated
 * value the way `createDelegatedToolsResolver` does for Claude Code:
 * `--allowedTools` speaks the same vocabulary as a tool name, `--sandbox`
 * does not, so the translation has to happen after `selectToolsForAgent` has
 * resolved the patterns against the actual builtin tool set.
 */
export function createCodexToolsResolver(
  project: AgentProject,
): (agent: string) => readonly string[] | undefined {
  return (agent) => project.agent(agent)?.tools;
}

export interface CodexWorkerExecutorOptions {
  readonly workspacePath: string;
  readonly runId: string;
  readonly events?: EventSink;
  readonly taskTimeoutMs?: number;
  /**
   * Passed through to {@link CodexBackend}. `events` and `timeoutMs` here are
   * overridden by the executor-level options above when those are set, and
   * `model` is overridden per task by {@link resolveAgentModel} when that
   * resolver has an answer for the routed agent.
   */
  readonly backendOptions?: CodexBackendOptions;
  /**
   * Looks up the model the routed agent is configured for, typically
   * {@link createDelegatedModelResolver} bound to the run's `AgentProject`.
   *
   * A per-task result overrides `backendOptions.model` for that task — the
   * router picked this agent for a reason, and an agent-specific model is a
   * more specific choice than a run-wide default — while `undefined` (agent
   * unknown, alias unresolved, or `config.yaml` says "default") leaves
   * `backendOptions.model` as the fallback so a run-wide `-m` still applies.
   */
  readonly resolveAgentModel?: (agent: string) => string | undefined;
  /**
   * Looks up the routed agent's `tools:` patterns, typically
   * {@link createCodexToolsResolver} bound to the run's `AgentProject`.
   * Turned into a sandbox decision per task by {@link codexToolScopingFor};
   * left unset, no per-agent scoping is attempted at all (every task uses
   * `backendOptions.sandbox` as-is), which keeps every existing caller that
   * does not pass this option behaving exactly as before.
   */
  readonly resolveAgentTools?: (agent: string) => readonly string[] | undefined;
  /**
   * Where to report what Codex said each task attempt spent, when the caller
   * is keeping a ledger (an orchestration run opens one for the whole run).
   * Left out, nothing is recorded — which is not the same as recording zero,
   * mirroring `DelegatedPlannerOptions.usage`.
   */
  readonly usage?: DelegatedWorkerUsageSink;
  /**
   * The project's `.agent/handoff.md` guidance, normally `project.handoff`.
   * Only the briefing's sections apply here — Codex brings its own system
   * prompt, so `## common` has nowhere to go — and the review verdict contract
   * is appended after `## reviewer` either way.
   */
  readonly handoff?: HandoffGuidance | undefined;
  /**
   * Agents this run has already emitted a `backend.tool_scoping_unsupported`
   * warning for.
   *
   * Shared by the caller across every {@link CodexWorkerExecutor} built for
   * one run — `codexWorkspaceFactory` constructs a fresh executor per task
   * worktree, so an instance-local set would warn once per *task* rather
   * than once per run. Left unset, the warning is not deduplicated at all
   * (every unsupported-scoping task warns), which only matters to a caller —
   * a test, typically — that builds more than one executor for the same
   * agent and cares about the dedup itself.
   */
  readonly toolScopingWarned?: Set<string>;
}

/**
 * Runs orchestration tasks through the official Codex CLI instead of the
 * in-process agent loop.
 *
 * Codex owns its own agent loop and sandbox, so this executor is a thin
 * adapter: same task briefing in, same workspace inspection out. Approvals are
 * Codex's own business (`--sandbox` / `--full-auto` in
 * {@link CodexBackendOptions}) — but per-agent tool *selection* is not purely
 * a Codex concern the way it might look: {@link resolveAgentTools} maps a
 * read-only-intentioned agent onto `--sandbox read-only` (see
 * {@link codexToolScopingFor}), and warns once per run, through
 * `backend.tool_scoping_unsupported`, about the agents whose restriction has
 * no sandbox-mode equivalent at all — rather than silently running them with
 * every tool Codex itself allows, which is what this executor used to do.
 */
export class CodexWorkerExecutor implements WorkerExecutor {
  readonly #options: CodexWorkerExecutorOptions;

  constructor(options: CodexWorkerExecutorOptions) {
    this.#options = options;
  }

  /**
   * The sandbox scoping {@link resolveAgentTools} implies for `agent`, or
   * `"unscoped"` when no resolver was supplied — see the option's doc.
   */
  #toolScopingFor(agent: string): "unscoped" | "read-only" | "unsupported" {
    const patterns = this.#options.resolveAgentTools?.(agent);
    return patterns === undefined ? "unscoped" : codexToolScopingFor(patterns);
  }

  /**
   * Emits the once-per-run warning for an agent whose `tools:` restriction
   * {@link codexToolScopingFor} could not map onto a sandbox mode.
   *
   * Best-effort and non-blocking, like every other event this backend emits:
   * a warning that fails to send must not fail the task it describes.
   */
  async #warnUnsupportedScoping(agent: string, taskId: string): Promise<void> {
    const warned = this.#options.toolScopingWarned;
    if (warned?.has(agent) === true) return;
    warned?.add(agent);

    const sink = this.#options.events;
    if (sink === undefined) return;
    try {
      await sink.emit(
        agentEvent(
          { runId: this.#options.runId, taskId },
          {
            type: "backend.tool_scoping_unsupported",
            data: { backend: "codex", agent },
          },
        ),
      );
    } catch {
      // Event emission is best-effort and must never fail a task.
    }
  }

  /**
   * The model {@link resolveAgentModel} would resolve for `agent`, falling
   * back to `backendOptions.model` — the same precedence {@link execute}
   * applies when it builds the {@link CodexBackend} for a task, exposed here
   * so it can be reported before the task actually runs.
   */
  #modelFor(agent: string): string | undefined {
    return (
      this.#options.resolveAgentModel?.(agent) ??
      this.#options.backendOptions?.model
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
    const scoping = this.#toolScopingFor(agent);
    if (scoping === "unsupported") {
      await this.#warnUnsupportedScoping(agent, taskId);
    }

    // A per-agent sandbox decision overrides `backendOptions.sandbox` the same
    // way `model` overrides `backendOptions.model` above: the agent's own
    // restriction is more specific than a run-wide default, and — since the
    // only decision this layer can ever make is the *stricter* `read-only` —
    // tightening it never surprises a run that asked for something looser.
    const sandbox: CodexSandbox | undefined =
      scoping === "read-only" ? "read-only" : undefined;

    const backend = new CodexBackend({
      ...this.#options.backendOptions,
      ...(model === undefined ? {} : { model }),
      ...(sandbox === undefined ? {} : { sandbox }),
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
        summary: `Codex backend crashed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Recorded regardless of outcome, same as the planner's per-attempt
    // recording: a failed or partial task still cost whatever Codex reported.
    recordDelegatedWorkerUsage(
      this.#options.usage,
      { agent, taskId, model },
      reportedUsage,
    );

    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    const result = normalizeTaskResult({ taskId, loop: run, inspection });

    // Same contract as the native loop and the Claude Code executor: the
    // verdict decides the review, and a reply with no readable verdict fails
    // it rather than passing on a zero exit code.
    if (task.spec.type !== "review") return result;
    return applyReviewVerdict(result, reviewVerdictFromRun(run));
  }
}
