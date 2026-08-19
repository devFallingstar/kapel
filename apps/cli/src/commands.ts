import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findAgentDir } from "@agent/coding-agent";
import { parse as parseYaml } from "yaml";

/**
 * Custom slash commands: `.agent/commands/<name>.md` defines `/<name>`.
 *
 * A file is optional YAML front matter (`description`, `model`, and the
 * reserved-for-later `agent`) followed by a prompt template. `$ARGUMENTS` in
 * the template is replaced by whatever the user typed after the command name;
 * a template with no placeholder gets the arguments appended instead (see
 * {@link expandCustomCommand}).
 *
 * Loading is deliberately lenient — a bad file is a warning, never a reason
 * to fail the whole scan — because a typo in one command file should not cost
 * every other command in the directory.
 */

/** A command's name must be a bare word: no leading slash, no spaces. */
export const CUSTOM_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

/** One loaded `.agent/commands/*.md` file. */
export interface CustomCommand {
  readonly name: string;
  /** Shown by `/help`; absent when the file's front matter omits it. */
  readonly description?: string;
  /**
   * A model alias/id to run this command's turn with. `agent` is parsed out
   * of the same front matter and intentionally dropped — it is reserved for
   * a future sub-agent dispatch and today does nothing.
   */
  readonly model?: string;
  readonly template: string;
  readonly sourcePath: string;
}

export interface LoadCustomCommandsResult {
  readonly commands: readonly CustomCommand[];
  readonly warnings: readonly string[];
}

interface FrontMatterSplit {
  readonly frontMatter: string;
  readonly body: string;
}

/**
 * Splits a `---`-delimited YAML front matter block from the markdown body
 * that follows it. `undefined` means the file does not open with a `---`
 * line on its own, or never closes the block — in both cases front matter is
 * simply absent (it is optional here, unlike `.agent/agents/*.md`) rather
 * than an error, and the whole file is read as the template body.
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ParsedCommandFile =
  | { readonly command: CustomCommand }
  | { readonly warning: string };

/**
 * Parses one `.agent/commands/<name>.md` file, already known to have a valid
 * `name`. Front matter is optional; when present but not valid YAML, the
 * whole file is skipped with a warning rather than partially trusted.
 */
function parseCustomCommandFile(
  filePath: string,
  name: string,
  raw: string,
): ParsedCommandFile {
  const split = splitFrontMatter(raw);
  if (split === undefined) {
    return { command: { name, template: raw.trim(), sourcePath: filePath } };
  }

  let value: unknown;
  try {
    value = parseYaml(split.frontMatter);
  } catch (error) {
    return {
      warning: `skipping ${filePath}: front matter YAML parse error: ${errorMessage(error)}`,
    };
  }

  // `agent` is read from `record` but never stored — reserved for a future
  // sub-agent dispatch; parsing it now (instead of rejecting the key) means a
  // command file written against that future shape works today too, minus
  // the routing it asks for.
  const record = asRecord(value);
  const description = asOptionalString(record?.description);
  const model = asOptionalString(record?.model);

  return {
    command: {
      name,
      ...(description === undefined ? {} : { description }),
      ...(model === undefined ? {} : { model }),
      template: split.body.trim(),
      sourcePath: filePath,
    },
  };
}

/**
 * Scans `<workspacePath>/.agent/commands/*.md` for custom slash commands.
 *
 * Every failure mode short of a filesystem error on an individual file is a
 * warning, not an exception: no `.agent` directory, no `commands`
 * subdirectory, an invalid command name (must match
 * {@link CUSTOM_COMMAND_NAME_PATTERN}), a name that collides with a built-in
 * command (the built-in always wins), or unparseable front matter. Warnings
 * are returned rather than printed so callers decide when they matter (once
 * at REPL start, once per `/help`).
 */
export async function loadCustomCommands(
  workspacePath: string,
  builtinNames: ReadonlySet<string>,
): Promise<LoadCustomCommandsResult> {
  const agentDir = await findAgentDir(workspacePath);
  if (agentDir === undefined) return { commands: [], warnings: [] };

  const commandsDir = path.join(agentDir, "commands");
  let entryNames: string[];
  try {
    const entries = await readdir(commandsDir, { withFileTypes: true });
    entryNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No `commands` directory (or it isn't readable) — nothing to offer.
    return { commands: [], warnings: [] };
  }

  const commands: CustomCommand[] = [];
  const warnings: string[] = [];

  for (const fileName of entryNames) {
    const displayPath = `.agent/commands/${fileName}`;
    const stem = path.basename(fileName, ".md");

    if (!CUSTOM_COMMAND_NAME_PATTERN.test(stem)) {
      warnings.push(
        `skipping ${displayPath}: "${stem}" is not a valid command name (expected ${CUSTOM_COMMAND_NAME_PATTERN.source})`,
      );
      continue;
    }
    if (builtinNames.has(stem)) {
      warnings.push(
        `skipping ${displayPath}: "/${stem}" is a built-in command and cannot be overridden`,
      );
      continue;
    }

    const filePath = path.join(commandsDir, fileName);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      warnings.push(`skipping ${displayPath}: ${errorMessage(error)}`);
      continue;
    }

    const parsed = parseCustomCommandFile(displayPath, stem, raw);
    if ("warning" in parsed) warnings.push(parsed.warning);
    else commands.push(parsed.command);
  }

  return { commands, warnings };
}

/**
 * Expands a custom command's template against what the user typed after the
 * command name: every `$ARGUMENTS` is replaced by it, or — when the template
 * contains no placeholder at all — the arguments are appended after a blank
 * line. Empty arguments still substitute (to `""`), so a template built
 * entirely around `$ARGUMENTS` degrades to just its surrounding prose rather
 * than growing a stray trailing blank section.
 */
export function expandCustomCommand(
  command: CustomCommand,
  argumentsText: string,
): string {
  if (command.template.includes(ARGUMENTS_PLACEHOLDER)) {
    return command.template.split(ARGUMENTS_PLACEHOLDER).join(argumentsText);
  }
  return argumentsText === ""
    ? command.template
    : `${command.template}\n\n${argumentsText}`;
}
