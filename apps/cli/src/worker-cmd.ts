import type {
  AgentProject,
  RuntimeTask,
  ServeWorkerRequestIo,
  WorkerExecutor,
} from "@agent/coding-agent";
import {
  AgentLoopWorkerExecutor,
  loadAgentProject,
  serveWorkerRequest,
  toPlannedTask,
} from "@agent/coding-agent";
import type { EventSink } from "@agent/protocol";
import { loadDotEnvFile } from "./env.js";
import { createProjectModelResolver } from "./project-models.js";

export interface WorkerExecutorFactoryArgs {
  readonly project: AgentProject;
  readonly workspacePath: string;
  readonly runId: string;
  /** Forwards events to the parent as `{"type":"event"}` protocol lines. */
  readonly events: EventSink;
  readonly taskTimeoutMs?: number;
}

/** Builds the executor that runs the requested task. Overridable in tests. */
export type WorkerExecutorFactory = (
  args: WorkerExecutorFactoryArgs,
) => Promise<WorkerExecutor> | WorkerExecutor;

export const defaultWorkerExecutorFactory: WorkerExecutorFactory = async (
  args,
) => {
  const resolveModel = await createProjectModelResolver(
    args.project,
    process.env,
  );
  return new AgentLoopWorkerExecutor({
    project: args.project,
    resolveModel,
    workspacePath: args.workspacePath,
    runId: args.runId,
    events: args.events,
    ...(args.taskTimeoutMs === undefined
      ? {}
      : { taskTimeoutMs: args.taskTimeoutMs }),
  });
};

export interface RunWorkerCommandDeps {
  readonly io?: ServeWorkerRequestIo;
  readonly executorFactory?: WorkerExecutorFactory;
  /** Diagnostics channel. Defaults to stderr — never stdout. */
  readonly error?: (line: string) => void;
}

/**
 * Implements `agent worker`: the child-process endpoint of the worker protocol.
 *
 * One request in on stdin, one result line out on stdout, then exit. **stdout is
 * the protocol channel**, so nothing human-facing may be written to it — every
 * diagnostic goes to stderr, which the parent only surfaces when a task comes
 * back without a result.
 *
 * The workspace comes from the request rather than the process's cwd: the parent
 * owns which tree the task runs against, and the child is told, not asked.
 */
export async function runWorkerCommand(
  deps: RunWorkerCommandDeps = {},
): Promise<number> {
  const io: ServeWorkerRequestIo = deps.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
  };
  const error = deps.error ?? ((line: string) => console.error(line));
  const executorFactory = deps.executorFactory ?? defaultWorkerExecutorFactory;

  return serveWorkerRequest(io, async (request, events) => {
    try {
      await loadDotEnvFile(request.workspacePath);

      const project = await loadAgentProject(request.workspacePath);
      if (project === undefined) {
        throw new Error(
          `No .agent directory found in ${request.workspacePath} — run \`agent init\` there first`,
        );
      }

      const executor = await executorFactory({
        project,
        workspacePath: request.workspacePath,
        runId: request.runId,
        events,
        ...(request.timeoutMs === undefined
          ? {}
          : { taskTimeoutMs: request.timeoutMs }),
      });

      const task: RuntimeTask = {
        spec: toPlannedTask(request.task),
        status: "running",
        attempts: 1,
      };
      error(`worker: ${task.spec.id} as ${request.agent}`);
      return await executor.execute(task, request.agent);
    } catch (failure) {
      // `serveWorkerRequest` turns this into a failed result line for the
      // parent; the stderr copy is what a human debugging by hand sees.
      error(
        `worker: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      throw failure;
    }
  });
}
