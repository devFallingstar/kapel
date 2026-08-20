import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound } from "./internal.js";
import type { ProjectHandoff } from "./types.js";

/** The file, relative to `.agent/`, that carries a project's handoff guidance. */
export const HANDOFF_FILE_NAME = "handoff.md";

/** The `## ` headings this file recognises, in the order they are documented. */
export const HANDOFF_SECTION_NAMES = ["common", "worker", "reviewer"] as const;

type HandoffSectionName = (typeof HANDOFF_SECTION_NAMES)[number];

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(HANDOFF_SECTION_NAMES);

/** A `## <title>` line's title, or `undefined` when the line is not one. */
function headingTitle(line: string): string | undefined {
  // Exactly two hashes followed by whitespace: `### Something` is body text, so
  // a section can carry sub-headings without being split at them.
  return /^##[ \t]+(\S.*?)[ \t]*$/.exec(line)?.[1];
}

function knownSection(title: string): HandoffSectionName | undefined {
  const name = title.trim().toLowerCase();
  return KNOWN_SECTIONS.has(name) ? (name as HandoffSectionName) : undefined;
}

/**
 * Splits `.agent/handoff.md` into its `## common` / `## worker` / `## reviewer`
 * sections.
 *
 * Deliberately tolerant — this file is prose a human maintains, and a
 * misspelled heading must not take an orchestration run down:
 *
 * - Everything before the first recognised heading is preamble (the shipped
 *   template puts its explanation there) and is ignored.
 * - A `## ` heading that is not one of the three known names is *guidance text*
 *   when it appears inside a section — the built-in `## common` block opens
 *   with `## Execution context`, so a section has to be able to contain
 *   headings — and a reported warning when it appears outside one, where it can
 *   only be a typo for a section name.
 * - A repeated section keeps the first occurrence and reports a warning.
 * - A section's body is trimmed. Present-but-blank is *not* the same as absent:
 *   absent falls back to kapel's built-in text, blank replaces it with nothing,
 *   which is what wholesale replacement means.
 *
 * Warnings are carried on the result rather than thrown: unlike `config.yaml`,
 * nothing here can make a run behave incorrectly, only differently from what
 * the author intended.
 */
export function parseHandoffMarkdown(
  sourcePath: string,
  raw: string,
): ProjectHandoff {
  const bodies = new Map<HandoffSectionName, string[]>();
  const warnings: string[] = [];
  let current: HandoffSectionName | undefined;

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const title = headingTitle(line);

    if (title === undefined) {
      if (current !== undefined) bodies.get(current)?.push(line);
      continue;
    }

    const name = knownSection(title);
    if (name === undefined) {
      if (current === undefined) {
        warnings.push(
          `${sourcePath}: ignoring unknown section "## ${title}" (expected one of ${HANDOFF_SECTION_NAMES.join(", ")})`,
        );
      } else {
        bodies.get(current)?.push(line);
      }
      continue;
    }

    if (bodies.has(name)) {
      warnings.push(
        `${sourcePath}: ignoring a repeated "## ${name}" section — the first one wins`,
      );
      current = undefined;
      continue;
    }

    bodies.set(name, []);
    current = name;
  }

  const section = (name: HandoffSectionName): string | undefined =>
    bodies.get(name)?.join("\n").trim();

  return {
    sourcePath,
    common: section("common"),
    worker: section("worker"),
    reviewer: section("reviewer"),
    warnings,
  };
}

/**
 * Loads `<agentDir>/handoff.md`. A missing file yields `undefined`, which is
 * how "use kapel's built-in guidance for all three sections" is spelled.
 */
export async function loadProjectHandoff(
  agentDir: string,
): Promise<ProjectHandoff | undefined> {
  const filePath = join(agentDir, HANDOFF_FILE_NAME);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }

  return parseHandoffMarkdown(filePath, raw);
}
