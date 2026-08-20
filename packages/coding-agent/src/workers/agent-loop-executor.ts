import type { ModelDefinition, ModelProvider, UsageRecorder } from "@agent/ai";
import type { AgentDefinition, PermissionDecision, Tool } from "@agent/core";
import type {
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import type { EventSink } from "@agent/protocol";
import { AgentLoop } from "../loop.js";
import { PermissionEngine } from "../permissions.js";
import type { AgentProject, HandoffGuidance } from "../project/index.js";
import { builtinTools } from "../tools/index.js";
import { buildTaskBriefing, buildWorkerSystemPrompt } from "./briefing.js";
import {
  failedTaskResult,
  inspectWorkspaceChanges,
  type NormalizableRun,
  normalizeTaskResult,
} from "./normalize.js";
import {
  applyReviewVerdict,
  REVIEW_VERDICT_TOOL_NAME,
  ReviewVerdictTool,
} from "./review.js";

/**
 * Default tool policy for headless workers.
 *
 * This deliberately differs from the interactive CLI defaults: a worker has no
 * terminal to prompt on, so an `"ask"` decision would resolve to a denial with
 * "no prompter available" and quietly cripple the run. The risk gate for
 * unattended execution is policy review before the run, not an interactive
 * confirmation during it — so the built-ins a worker needs are allowed up front
 * and everything else (MCP tools, plugin tools, anything added later) falls
 * through to the `"deny"` default until it is explicitly granted.
 */
export const DEFAULT_WORKER_PERMISSIONS: Readonly<
  Record<string, PermissionDecision>
> = {
  read_file: "allow",
  glob: "allow",
  grep: "allow",
  git_diff: "allow",
  write_file: "allow",
  edit_file: "allow",
  bash: "allow",
};

/**
 * Template tool names that do not follow the builtin `<verb>_<noun>` naming.
 *
 * `.agent/agents/*.md` files list tools the way a human writes them ("read",
 * "write", "edit"), while the builtin tools are named after their
 * implementation (`read_file`, `write_file`, `edit_file`).
 */
const TEMPLATE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
};

/**
 * Canonicalizes a tool name or pattern so both spellings meet in the middle:
 * lowercase, with `_` and `.` treated as the same separator (`git.diff` and
 * `git_diff` both become `git.diff`).
 */
function canonicalize(name: string): string {
  return name.toLowerCase().replaceAll("_", ".");
}

/**
 * Selects the tools an agent may use.
 *
 * Matching is strict-but-normalized. A pattern matches a tool when, after
 * canonicalization (and after the alias map above is applied to bare template
 * names), either:
 *
 * - the names are equal — `"git.diff"` and `"git_diff"` match the `git_diff`
 *   tool, `"read"` matches `read_file` via the alias map; or
 * - the pattern ends in `.*` and the tool sits in that namespace —
 *   `"git.*"` matches `git_diff` (and would match a future `git_status`).
 *
 * Prefixes never match implicitly: `"file"` does not match `read_file`.
 * Patterns that match nothing (`"task.*"` for the orchestrator agent, which has
 * no builtin equivalent) are simply dropped. An empty pattern list means "every
 * builtin tool" — an agent file that omits `tools:` is not asking to be
 * sandboxed, it just has not made a choice.
 */
export function selectToolsForAgent(
  tools: readonly Tool[],
  patterns: readonly string[],
): readonly Tool[] {
  if (patterns.length === 0) return tools;

  const exact = new Set<string>();
  const prefixes: string[] = [];

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === "") continue;

    if (trimmed.endsWith(".*") || trimmed.endsWith("_*")) {
      prefixes.push(canonicalize(trimmed.slice(0, -2)));
      continue;
    }

    const aliased = TEMPLATE_TOOL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
    exact.add(canonicalize(aliased));
  }

  return tools.filter((tool) => {
    const name = canonicalize(tool.name);
    if (exact.has(name)) return true;
    return prefixes.some(
      (prefix) => name === prefix || name.startsWith(`${prefix}.`),
    );
  });
}

/** A model alias resolved to the provider and definition that can serve it. */
export interface ResolvedWorkerModel {
  readonly provider: ModelProvider;
  readonly model: ModelDefinition;
}

/**
 * Resolves an agent's `model` front-matter alias. Throws (with a message that
 * names the alias) when the alias is unknown; the executor turns that into a
 * failed task result rather than letting it escape.
 */
export type WorkerModelResolver = (modelAlias: string) => ResolvedWorkerModel;

export interface AgentLoopWorkerExecutorOptions {
  readonly project: AgentProject;
  readonly resolveModel: WorkerModelResolver;
  readonly workspacePath: string;
  readonly runId: string;
  readonly events?: EventSink;
  readonly usage?: UsageRecorder;
  readonly taskTimeoutMs?: number;
  readonly maxIterations?: number;
  /** Replaces {@link DEFAULT_WORKER_PERMISSIONS} wholesale when provided. */
  readonly permissionOverrides?: Readonly<Record<string, PermissionDecision>>;
  /**
   * The project's `.agent/handoff.md` guidance, normally `project.handoff`.
   * Passed in rather than read off {@link project} so the caller decides once,
   * for every backend, what guidance a run hands its workers; left out, every
   * section falls back to kapel's built-in text.
   */
  readonly handoff?: HandoffGuidance | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs orchestration tasks in-process with the M1 {@link AgentLoop}.
 *
 * Every failure mode — unknown agent, unresolvable model alias, a loop that
 * throws — comes back as a `failed` {@link TaskResult}. The scheduler treats a
 * rejected promise as a crash that takes down the whole run, so a described
 * failure is strictly more useful than a thrown one.
 */
export class AgentLoopWorkerExecutor implements WorkerExecutor {
  readonly #options: AgentLoopWorkerExecutorOptions;

  constructor(options: AgentLoopWorkerExecutorOptions) {
    this.#options = options;
  }

  /**
   * The model `agent`'s `.agent/agents/<name>.md` front matter points at,
   * resolved the same way {@link execute} resolves it. `undefined` for an
   * unknown agent or an unresolvable model alias — both are reported as task
   * failures once the task actually runs, so this is silent about them rather
   * than throwing ahead of that.
   */
  describeAgent(agent: string): WorkerAgentDescription | undefined {
    const projectAgent = this.#options.project.agent(agent);
    if (projectAgent === undefined) return undefined;
    try {
      const resolved = this.#options.resolveModel(projectAgent.modelAlias);
      return { model: resolved.model.id };
    } catch {
      return undefined;
    }
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const taskId = task.spec.id;
    const { project, workspacePath, runId } = this.#options;

    const projectAgent = project.agent(agent);
    if (projectAgent === undefined) {
      const known = [...project.knownAgentNames()].sort().join(", ");
      return failedTaskResult(
        taskId,
        `Unknown agent ${agent}. Known agents: ${known === "" ? "(none)" : known}`,
      );
    }

    let resolved: ResolvedWorkerModel;
    try {
      resolved = this.#options.resolveModel(projectAgent.modelAlias);
    } catch (error) {
      return failedTaskResult(
        taskId,
        `Could not resolve model alias "${projectAgent.modelAlias}" for agent ${agent}: ${errorMessage(error)}`,
      );
    }

    const configuredPermissions =
      this.#options.permissionOverrides ?? DEFAULT_WORKER_PERMISSIONS;
    const selected = selectToolsForAgent(builtinTools(), projectAgent.tools);

    // A review task gets one extra tool on top of whatever its agent file
    // grants: the way it reports its decision. It is injected rather than
    // configured because it is part of the task contract, not of the agent —
    // the same reviewer agent has nothing to submit on a non-review task — and
    // it is force-allowed for the same reason: a reviewer that cannot reach its
    // own verdict tool would fail every review it is asked to run.
    const isReview = task.spec.type === "review";
    const verdictTool = isReview ? new ReviewVerdictTool() : undefined;
    const tools =
      verdictTool === undefined ? selected : [...selected, verdictTool];
    const permissions: Readonly<Record<string, PermissionDecision>> =
      verdictTool === undefined
        ? configuredPermissions
        : { ...configuredPermissions, [REVIEW_VERDICT_TOOL_NAME]: "allow" };

    const definition: AgentDefinition = {
      name: projectAgent.name,
      role: projectAgent.role,
      model: resolved.model,
      systemPrompt: buildWorkerSystemPrompt(
        projectAgent.systemPrompt,
        this.#options.handoff,
      ),
      tools: tools.map((tool) => tool.name),
      permissions,
    };

    const loop = new AgentLoop({
      agent: definition,
      provider: resolved.provider,
      tools,
      permissions: new PermissionEngine(permissions, {
        // Headless: no prompter is wired up on purpose, and anything not
        // explicitly allowed is denied instead of silently escalating.
        defaultDecision: "deny",
      }),
      ...(this.#options.events === undefined
        ? {}
        : { events: this.#options.events }),
      ...(this.#options.usage === undefined
        ? {}
        : { usage: this.#options.usage }),
      ...(this.#options.maxIterations === undefined
        ? {}
        : { maxIterations: this.#options.maxIterations }),
      ...(this.#options.taskTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#options.taskTimeoutMs }),
    });

    let run: NormalizableRun;
    try {
      run = await loop.run(
        {
          instruction: buildTaskBriefing(task.spec, agent, context, {
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
    } catch (error) {
      // The loop is written not to throw, but a provider or tool that violates
      // that contract must not take the scheduler down with it. Inspect anyway:
      // a crash halfway through can still have left edits behind.
      run = {
        status: "failed",
        summary: `Agent loop crashed: ${errorMessage(error)}`,
      };
    }

    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    const result = normalizeTaskResult({ taskId, loop: run, inspection });

    // The verdict, not the prose, decides a review. A rejection becomes a
    // `failed` result, which is what makes the review blocking: the scheduler
    // cancels the dependents of a failed task and the run exits non-zero, so a
    // risky task cannot complete past a review that turned it down.
    return verdictTool === undefined
      ? result
      : applyReviewVerdict(result, verdictTool.verdict());
  }
}
