import type { AgentRole } from "@agent/core";

/** A `provider`/`model` pair as declared under `models.<alias>` in config.yaml. */
export interface ProjectModelRef {
  readonly provider: string;
  readonly model: string;
}

/** One agent definition loaded from `.agent/agents/<name>.md`. */
export interface ProjectAgent {
  readonly name: string;
  /** The `model` front-matter value: an alias into `AgentProjectConfig.models`. */
  readonly modelAlias: string;
  readonly role: AgentRole;
  readonly tools: readonly string[];
  /** The markdown body following the front matter, trimmed. */
  readonly systemPrompt: string;
  /** Absolute path to the source `.md` file. */
  readonly sourcePath: string;
}

/**
 * Timeout applied to a validator that does not declare one.
 *
 * Ten minutes is deliberately generous: a validator is a whole `npm test` or
 * `tsc -b` on a cold cache, and killing a slow-but-working suite would report a
 * failure the repository does not have.
 */
export const DEFAULT_VALIDATOR_TIMEOUT_SECONDS = 600;

/**
 * One entry of the `validation:` list in config.yaml — a command that decides
 * whether a mutating task's work is acceptable.
 *
 * `timeoutSeconds` is optional in the file; {@link loadProjectConfig} fills it
 * in with {@link DEFAULT_VALIDATOR_TIMEOUT_SECONDS}, so a validator that comes
 * out of a loaded config always carries an explicit budget. It stays optional on
 * the type so callers can build one by hand without repeating the default.
 */
export interface ProjectValidator {
  readonly name: string;
  /** Run through `bash -lc` in the task's workspace. */
  readonly command: string;
  readonly timeoutSeconds?: number;
}

/** The parsed contents of `.agent/config.yaml`. */
export interface AgentProjectConfig {
  readonly models: Readonly<Record<string, ProjectModelRef>>;
  /** The `agents` map: role-slot name -> agent name. */
  readonly agentSlots: Readonly<Record<string, string>>;
  /** The `validation` list, in file order. Empty when the key is absent. */
  readonly validators: readonly ProjectValidator[];
}

/** A fully loaded and cross-validated `.agent/` project configuration. */
export interface AgentProject {
  /** Absolute path to the `.agent` directory. */
  readonly root: string;
  readonly config: AgentProjectConfig;
  readonly agents: readonly ProjectAgent[];
  /** Contents of `orchestration.md`, or `undefined` when the file is absent. */
  readonly orchestrationMarkdown: string | undefined;
  knownAgentNames(): ReadonlySet<string>;
  agent(name: string): ProjectAgent | undefined;
}

/**
 * Thrown when `.agent/` content is malformed: invalid YAML, a schema that
 * doesn't match the expected shape, or cross-references (model aliases,
 * agent slots, duplicate/mismatched agent names) that don't resolve.
 *
 * `problems` aggregates every issue found rather than stopping at the first.
 */
export class ProjectConfigError extends Error {
  readonly file: string;
  readonly problems: readonly string[];

  constructor(file: string, problems: readonly string[]) {
    super(
      `invalid .agent configuration in ${file}:\n${problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
    this.name = "ProjectConfigError";
    this.file = file;
    this.problems = problems;
  }
}
