import type {
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import type { AgentProject, ProjectBackendName } from "../project/index.js";

/**
 * Resolves the backend an agent's tasks run on, from the project alone.
 *
 * Lookup path: `agent name -> ProjectAgent.modelAlias -> AgentProjectConfig
 * .models[alias].backend`, the same chain `createDelegatedModelResolver`
 * walks for the model id — which is the point: an agent's backend and its
 * model come out of one `models:` entry, so they can never disagree about
 * which CLI is being handed which model.
 *
 * Any break in that chain — an unknown agent, an alias with no entry, an
 * entry with no `backend:` — resolves to `undefined`, which callers read as
 * "the run's own backend".
 */
export function createAgentBackendResolver(
  project: AgentProject,
): (agent: string) => ProjectBackendName | undefined {
  return (agent) => {
    const projectAgent = project.agent(agent);
    if (projectAgent === undefined) return undefined;
    return project.config.models[projectAgent.modelAlias]?.backend;
  };
}

/**
 * Every backend a run could actually route a task to: one per project agent,
 * plus `defaultBackend`.
 *
 * The default is always in the set because it is the answer for anything the
 * project does not describe — an agent named by the policy but not defined
 * under `.agent/agents/`, an alias with no `models:` entry, an entry with no
 * `backend:`. Anything *not* in this set is a backend nothing can reach, and
 * the caller is free to skip preparing it (an availability probe, a
 * credential lookup) entirely.
 *
 * A size of one therefore means "this run is single-backend", including for
 * every config.yaml that predates `backend:` tags.
 */
export function referencedBackends(
  project: AgentProject,
  defaultBackend: ProjectBackendName,
): ReadonlySet<ProjectBackendName> {
  const resolve = createAgentBackendResolver(project);
  const backends = new Set<ProjectBackendName>([defaultBackend]);
  for (const agent of project.agents) {
    backends.add(resolve(agent.name) ?? defaultBackend);
  }
  return backends;
}

export interface MixedBackendWorkerExecutorOptions {
  /**
   * The routed agent's backend, or `undefined` when the project does not name
   * one — typically {@link createAgentBackendResolver} bound to the run's
   * project.
   */
  readonly resolveAgentBackend: (
    agent: string,
  ) => ProjectBackendName | undefined;
  /** Where an agent with no backend of its own runs: the run's own backend. */
  readonly defaultBackend: ProjectBackendName;
  /**
   * Builds the executor for one backend, already bound to this dispatcher's
   * workspace. Called at most once per backend (see the class doc), and may
   * throw for a backend the caller did not prepare.
   */
  readonly createExecutor: (backend: ProjectBackendName) => WorkerExecutor;
}

/**
 * Runs each task through the backend its own agent is configured for.
 *
 * This is what makes a mixed configuration — a Claude Code orchestrator with
 * a Codex middle tier, say — mean what it reads like: the tasks routed to a
 * Codex-backed agent go to Codex, the ones routed to a Claude Code-backed
 * agent go to Claude Code, and both happen in the same run, in their own task
 * worktrees, without either agent knowing the other exists.
 *
 * One dispatcher belongs to one workspace: `createExecutor` is expected to
 * already be bound to it, which is what lets `WorktreeIsolatedExecutor` build
 * a dispatcher per task checkout exactly as it builds any other per-workspace
 * executor. Inner executors are constructed on first use and cached, so a run
 * that only ever routes to one of three configured backends only ever builds
 * one worker — while the expensive, fallible part of a backend (its CLI
 * availability probe, its credentials) stays with the caller, who does it once
 * for the run rather than once per worktree.
 */
export class MixedBackendWorkerExecutor implements WorkerExecutor {
  readonly #options: MixedBackendWorkerExecutorOptions;
  readonly #executors = new Map<ProjectBackendName, WorkerExecutor>();

  constructor(options: MixedBackendWorkerExecutorOptions) {
    this.#options = options;
  }

  /** The backend `agent` runs on: its own, or the run's when it names none. */
  backendFor(agent: string): ProjectBackendName {
    return (
      this.#options.resolveAgentBackend(agent) ?? this.#options.defaultBackend
    );
  }

  #executorFor(agent: string): WorkerExecutor {
    const backend = this.backendFor(agent);
    const existing = this.#executors.get(backend);
    if (existing !== undefined) return existing;

    const created = this.#options.createExecutor(backend);
    this.#executors.set(backend, created);
    return created;
  }

  describeAgent(agent: string): WorkerAgentDescription | undefined {
    return this.#executorFor(agent).describeAgent?.(agent);
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    return this.#executorFor(agent).execute(task, agent, signal, context);
  }
}
