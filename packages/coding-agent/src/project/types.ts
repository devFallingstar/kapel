import type { AgentRole } from "@agent/core";
import type { McpServersInput } from "../mcp/config.js";
import type { ToolPermissionRule } from "../permissions.js";

/**
 * The execution backends a model alias can name in `config.yaml`.
 *
 * Deliberately a duplicate of the CLI's own `BackendName` (`apps/cli/src/
 * backend.ts`) rather than an import of it: packages must not depend on apps,
 * and this list is the file format's vocabulary, which is allowed to lag the
 * CLI's by a release if the two ever diverge.
 */
export type ProjectBackendName = "native" | "codex" | "claude-code";

/**
 * A `provider`/`model` pair as declared under `models.<alias>` in config.yaml,
 * optionally tagged with the backend that runs it.
 *
 * `backend` absent means "the run's own backend", which is what every config
 * written before mixed execution existed says — so an untagged file behaves
 * exactly as it did, and a run whose aliases are all untagged never leaves the
 * single-backend path. Tagged, it is what routes an individual agent's tasks
 * to Claude Code, Codex or the in-process loop while the rest of the run uses
 * something else.
 */
export interface ProjectModelRef {
  readonly provider: string;
  readonly model: string;
  readonly backend?: ProjectBackendName;
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
  /**
   * The `permission` block (P1-5): tool name -> verdict, or, for `bash`, a
   * map of command-prefix patterns to verdicts. Empty when the key is
   * absent. Merged on top of the CLI's machine-level config by
   * `resolvePermissionRules` in `apps/cli/src/permissions.ts` — this repo
   * layer wins over that one.
   */
  readonly permission: Readonly<Record<string, ToolPermissionRule>>;
  /**
   * The `mcp` block: server name -> `{command, args, env, enabled}`. Empty
   * when the key is absent. Kept as written rather than resolved here, because
   * the entry a session actually spawns is this one merged with the
   * checkout's `.agent/config.local.json` override — see `mergeMcpServers` in
   * `packages/coding-agent/src/mcp/config.ts`.
   */
  readonly mcp: McpServersInput;
}

/**
 * The guidance kapel includes whenever it hands work from one agent to
 * another, as three independently replaceable blocks.
 *
 * A section left `undefined` means "kapel's built-in text for this one"; a
 * section set to `""` means "deliberately nothing". That distinction is the
 * whole point of the type — see `.agent/handoff.md` and the defaults in
 * `workers/briefing.ts`.
 */
export interface HandoffGuidance {
  /** Appended to every worker agent's system prompt. */
  readonly common?: string | undefined;
  /** Standing guidance in a task briefing (how to work, not what the task is). */
  readonly worker?: string | undefined;
  /**
   * What a review task is being asked to do. Never includes the verdict
   * contract: that is machine-readable protocol, and kapel appends it after
   * this text no matter what the project put here.
   */
  readonly reviewer?: string | undefined;
}

/** {@link HandoffGuidance} as loaded from a project's `.agent/handoff.md`. */
export interface ProjectHandoff extends HandoffGuidance {
  /** Absolute path to the source `handoff.md`. */
  readonly sourcePath: string;
  /**
   * Tolerated problems: unknown headings outside any section, repeated
   * sections. Reported rather than thrown — a confused heading changes what an
   * agent is told, it does not make a run incorrect.
   */
  readonly warnings: readonly string[];
}

/** A fully loaded and cross-validated `.agent/` project configuration. */
export interface AgentProject {
  /** Absolute path to the `.agent` directory. */
  readonly root: string;
  readonly config: AgentProjectConfig;
  readonly agents: readonly ProjectAgent[];
  /** Contents of `orchestration.md`, or `undefined` when the file is absent. */
  readonly orchestrationMarkdown: string | undefined;
  /**
   * Parsed `handoff.md`, or `undefined` when the file is absent — in which case
   * every handoff uses kapel's built-in guidance.
   */
  readonly handoff: ProjectHandoff | undefined;
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
