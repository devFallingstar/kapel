import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ModelDefinition,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "@agent/ai";
import type {
  PlannedTask,
  RuntimeTask,
  TaskResult,
} from "@agent/orchestration";
import type { AgentEvent, EventSink } from "@agent/protocol";
import type {
  AgentProject,
  AgentProjectConfig,
  ProjectAgent,
} from "../../src/project/index.js";

const execFileAsync = promisify(execFile);

const SCRATCHPAD =
  "/tmp/claude-0/-home-user-multi-model-orchestration-agent/475a4108-ea0d-56a1-9770-14d838a0e5f8/scratchpad";

export async function makeTempDir(prefix = "workers-test-"): Promise<string> {
  return mkdtemp(join(SCRATCHPAD, prefix));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Creates a git repository with one commit and returns its HEAD sha. */
export async function initGitRepo(dir: string): Promise<string> {
  const run = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, { cwd: dir });
    return stdout.trim();
  };

  await run("init", "-q", "-b", "main");
  await run("config", "user.email", "worker@example.test");
  await run("config", "user.name", "Worker Test");
  await run("config", "commit.gpgsign", "false");
  await writeFile(join(dir, "tracked.txt"), "original\n", "utf8");
  await run("add", "tracked.txt");
  await run("commit", "-q", "-m", "initial");
  return run("rev-parse", "HEAD");
}

export const MODEL: ModelDefinition = {
  provider: "fake",
  id: "fake-model-1",
  capabilities: {
    tools: true,
    reasoning: false,
    vision: false,
    structuredOutput: true,
  },
};

/** Replays scripted model turns and records every request it received. */
export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ModelRequest[] = [];
  readonly #turns: ModelEvent[][];

  constructor(turns: ModelEvent[][]) {
    this.#turns = turns.map((turn) => [...turn]);
  }

  supports(): boolean {
    return true;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const turn = this.#turns.shift();
    if (turn === undefined) throw new Error("scripted provider exhausted");
    for (const event of turn) yield event;
  }
}

/** Provider whose stream throws before yielding anything. */
export class ExplodingProvider implements ModelProvider {
  readonly id = "exploding";

  supports(): boolean {
    return true;
  }

  // biome-ignore lint/correctness/useYield: the stream fails before yielding.
  async *stream(): AsyncIterable<ModelEvent> {
    throw new Error("provider exploded");
  }
}

/** A single text turn, which ends the loop with a success. */
export function textTurn(text: string): ModelEvent[] {
  return [
    { type: "text.delta", text },
    { type: "done", finishReason: "stop" },
  ];
}

/** A turn requesting one tool call. */
export function toolCallTurn(
  id: string,
  name: string,
  input: unknown,
): ModelEvent[] {
  return [
    { type: "tool.call", id, name, input },
    { type: "done", finishReason: "tool_use" },
  ];
}

export class RecordingSink implements EventSink {
  readonly events: AgentEvent[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

export function makeProjectAgent(
  overrides: Partial<ProjectAgent> = {},
): ProjectAgent {
  return {
    name: "coder",
    modelAlias: "worker",
    role: "worker",
    tools: ["read", "grep", "glob", "edit", "write", "bash", "git.*"],
    systemPrompt: "You are the coder.",
    sourcePath: "/virtual/.agent/agents/coder.md",
    ...overrides,
  };
}

/** Minimal in-memory {@link AgentProject} for executor tests. */
export function makeProject(agents: readonly ProjectAgent[]): AgentProject {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const config: AgentProjectConfig = {
    models: {},
    agentSlots: {},
    validators: [],
  };
  return {
    root: "/virtual/.agent",
    config,
    agents,
    orchestrationMarkdown: undefined,
    knownAgentNames: () => new Set(byName.keys()),
    agent: (name: string) => byName.get(name),
  };
}

export function makePlannedTask(
  overrides: Partial<PlannedTask> = {},
): PlannedTask {
  return {
    id: "task-1",
    title: "Add retry to the uploader",
    goal: "Retry failed uploads three times with backoff.",
    type: "implementation",
    complexity: "normal",
    dependencies: [],
    affectedAreas: ["packages/uploader"],
    risk: { level: "medium", categories: ["reliability"] },
    ...overrides,
  };
}

export function makeRuntimeTask(
  overrides: Partial<PlannedTask> = {},
): RuntimeTask {
  return {
    spec: makePlannedTask(overrides),
    status: "running",
    attempts: 1,
  };
}

export function makeTaskResult(
  overrides: Partial<TaskResult> = {},
): TaskResult {
  return {
    taskId: "task-1",
    status: "success",
    summary: "Did the thing.",
    decisions: [],
    changedFiles: ["src/a.ts"],
    tests: { passed: 0, failed: 0, commands: [] },
    unresolvedIssues: [],
    confidence: 0.8,
    ...overrides,
  };
}

/** True once the given pid no longer exists. */
export function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function waitForExit(
  pid: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isGone(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
