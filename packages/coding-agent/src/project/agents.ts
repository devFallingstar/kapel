import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AgentRole } from "@agent/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodIssues, isNotFound } from "./internal.js";
import type { ProjectAgent } from "./types.js";

const AGENT_ROLES: ReadonlySet<string> = new Set([
  "orchestrator",
  "worker",
  "reviewer",
]);

const AgentFrontMatterSchema = z
  .object({
    name: z.string().min(1, "must not be empty"),
    model: z.string().min(1, "must not be empty"),
    role: z.string().min(1, "must not be empty"),
    tools: z.array(z.string()).default([]),
  })
  .strict();

interface FrontMatterSplit {
  readonly frontMatter: string;
  readonly body: string;
}

/**
 * Splits a `---`-delimited YAML front matter block from the markdown body
 * that follows it. Returns `undefined` when the file does not open with a
 * `---` line on its own, or never closes the block with a matching `---`
 * line. CRLF line endings are normalized to LF first.
 */
function splitFrontMatter(raw: string): FrontMatterSplit | undefined {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) return undefined;

  return {
    frontMatter: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

interface AgentFileResult {
  readonly problems: readonly string[];
  /** The parsed `name`, when front matter parsed structurally even if other problems were found. Used for duplicate detection. */
  readonly name?: string;
  /** Only set when this file itself has zero problems. */
  readonly agent?: ProjectAgent;
}

/** Parses one `agents/<name>.md` file. Aggregates every problem it finds rather than stopping at the first. */
export function parseAgentFile(filePath: string, raw: string): AgentFileResult {
  const stem = basename(filePath, extname(filePath));

  const split = splitFrontMatter(raw);
  if (!split) {
    return {
      problems: [
        `${filePath}: missing YAML front matter (file must start with a "---" line and include a closing "---" line)`,
      ],
    };
  }

  let frontMatterValue: unknown;
  try {
    frontMatterValue = parseYaml(split.frontMatter);
  } catch (err) {
    return {
      problems: [
        `${filePath}: front matter YAML parse error: ${(err as Error).message}`,
      ],
    };
  }

  const result = AgentFrontMatterSchema.safeParse(frontMatterValue);
  if (!result.success) {
    return {
      problems: formatZodIssues(result.error).map(
        (problem) => `${filePath}: ${problem}`,
      ),
    };
  }

  const { name, model, role, tools } = result.data;
  const problems: string[] = [];

  if (name !== stem) {
    problems.push(
      `${filePath}: front matter name "${name}" does not match filename "${stem}"`,
    );
  }

  if (!AGENT_ROLES.has(role)) {
    problems.push(
      `${filePath}: unknown role "${role}" (expected one of orchestrator, worker, reviewer)`,
    );
  }

  if (problems.length > 0) return { problems, name };

  return {
    problems: [],
    name,
    agent: {
      name,
      modelAlias: model,
      role: role as AgentRole,
      tools,
      systemPrompt: split.body.trim(),
      sourcePath: filePath,
    },
  };
}

export interface LoadedAgents {
  readonly agents: readonly ProjectAgent[];
  readonly problems: readonly string[];
}

/**
 * Loads every `*.md` file under `<agentDir>/agents`. A missing `agents`
 * directory yields no agents and no problems. Problems (missing/invalid
 * front matter, name/filename mismatches, unknown roles, duplicate names)
 * are aggregated across all files rather than stopping at the first.
 */
export async function loadProjectAgents(
  agentDir: string,
): Promise<LoadedAgents> {
  const agentsDir = join(agentDir, "agents");

  let entryNames: string[];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    entryNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (isNotFound(err)) return { agents: [], problems: [] };
    throw err;
  }

  const agents: ProjectAgent[] = [];
  const problems: string[] = [];
  const seenNames = new Map<string, string>();

  for (const entryName of entryNames) {
    const filePath = join(agentsDir, entryName);
    const raw = await readFile(filePath, "utf8");
    const result = parseAgentFile(filePath, raw);
    problems.push(...result.problems);

    // Duplicate detection runs off the parsed name whenever we have one,
    // independent of whether this file also has other problems (e.g. a
    // name/filename mismatch, which is in fact the only way a duplicate
    // name can arise, since two files can't share a filename).
    let isDuplicate = false;
    if (result.name !== undefined) {
      const existingPath = seenNames.get(result.name);
      if (existingPath !== undefined) {
        isDuplicate = true;
        problems.push(
          `${filePath}: duplicate agent name "${result.name}" (already defined in ${existingPath})`,
        );
      } else {
        seenNames.set(result.name, filePath);
      }
    }

    if (result.agent && !isDuplicate) agents.push(result.agent);
  }

  return { agents, problems };
}
