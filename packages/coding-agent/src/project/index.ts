import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadProjectAgents } from "./agents.js";
import { loadProjectConfig } from "./config.js";
import { loadProjectHandoff } from "./handoff.js";

export { loadProjectConfig } from "./config.js";
export {
  HANDOFF_FILE_NAME,
  HANDOFF_SECTION_NAMES,
  loadProjectHandoff,
  parseHandoffMarkdown,
} from "./handoff.js";

import { isNotFound } from "./internal.js";
import type {
  AgentProject,
  AgentProjectConfig,
  ProjectAgent,
  ProjectHandoff,
} from "./types.js";
import { ProjectConfigError } from "./types.js";

export type {
  AgentProject,
  AgentProjectConfig,
  HandoffGuidance,
  ProjectAgent,
  ProjectHandoff,
  ProjectModelRef,
  ProjectValidator,
} from "./types.js";
export {
  DEFAULT_VALIDATOR_TIMEOUT_SECONDS,
  ProjectConfigError,
} from "./types.js";

/** Returns `<workspaceRoot>/.agent` when it exists and is a directory, else `undefined`. */
export async function findAgentDir(
  workspaceRoot: string,
): Promise<string | undefined> {
  const dir = join(workspaceRoot, ".agent");
  try {
    const info = await stat(dir);
    return info.isDirectory() ? dir : undefined;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function readOrchestrationMarkdown(
  agentDir: string,
): Promise<string | undefined> {
  try {
    return await readFile(join(agentDir, "orchestration.md"), "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

class AgentProjectImpl implements AgentProject {
  readonly root: string;
  readonly config: AgentProjectConfig;
  readonly agents: readonly ProjectAgent[];
  readonly orchestrationMarkdown: string | undefined;
  readonly handoff: ProjectHandoff | undefined;
  readonly #byName: ReadonlyMap<string, ProjectAgent>;

  constructor(
    root: string,
    config: AgentProjectConfig,
    agents: readonly ProjectAgent[],
    orchestrationMarkdown: string | undefined,
    handoff: ProjectHandoff | undefined,
  ) {
    this.root = root;
    this.config = config;
    this.agents = agents;
    this.orchestrationMarkdown = orchestrationMarkdown;
    this.handoff = handoff;
    this.#byName = new Map(agents.map((agent) => [agent.name, agent]));
  }

  knownAgentNames(): ReadonlySet<string> {
    return new Set(this.#byName.keys());
  }

  agent(name: string): ProjectAgent | undefined {
    return this.#byName.get(name);
  }
}

/**
 * Loads and cross-validates the `.agent/` project configuration rooted at
 * `<workspaceRoot>/.agent`.
 *
 * - Returns `undefined` when `.agent` does not exist.
 * - Throws {@link ProjectConfigError} when `config.yaml` is malformed, an
 *   `agents/*.md` file has invalid front matter, or a cross-reference
 *   (model alias, agent slot, duplicate/mismatched agent name) doesn't
 *   resolve. All problems found are aggregated onto the thrown error.
 * - Never throws for `handoff.md`: an unrecognised heading there is reported as
 *   a warning on {@link AgentProject.handoff} instead.
 */
export async function loadAgentProject(
  workspaceRoot: string,
): Promise<AgentProject | undefined> {
  const agentDir = await findAgentDir(workspaceRoot);
  if (!agentDir) return undefined;

  const config = await loadProjectConfig(agentDir);
  const { agents, problems: agentProblems } = await loadProjectAgents(agentDir);
  const orchestrationMarkdown = await readOrchestrationMarkdown(agentDir);
  // Handoff problems are warnings, not errors (see `parseHandoffMarkdown`), so
  // they stay on the returned project instead of joining `problems` below.
  const handoff = await loadProjectHandoff(agentDir);

  const problems = [...agentProblems];
  const agentNames = new Set(agents.map((agent) => agent.name));
  const hasModels = Object.keys(config.models).length > 0;

  if (hasModels) {
    for (const agent of agents) {
      if (!(agent.modelAlias in config.models)) {
        problems.push(
          `${agent.sourcePath}: model alias "${agent.modelAlias}" is not defined in config.yaml models`,
        );
      }
    }
  }

  for (const [slot, agentName] of Object.entries(config.agentSlots)) {
    if (!agentNames.has(agentName)) {
      problems.push(
        `config.yaml: agents.${slot} references unknown agent "${agentName}"`,
      );
    }
  }

  if (problems.length > 0) {
    throw new ProjectConfigError(agentDir, problems);
  }

  return new AgentProjectImpl(
    agentDir,
    config,
    agents,
    orchestrationMarkdown,
    handoff,
  );
}
