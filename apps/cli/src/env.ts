import { readFile } from "node:fs/promises";
import path from "node:path";

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a `.env`-style file: `KEY=VALUE` lines, `#`-prefixed comment lines,
 * blank lines, and optional single/double-quoted values. Lines that don't
 * match `KEY=VALUE` (missing `=`, invalid key characters, ...) are silently
 * skipped rather than raising an error.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = LINE_RE.exec(line);
    if (match === null) continue;

    const [, key = "", rawValue = ""] = match;
    if (key === "") continue;
    result[key] = unquote(rawValue);
  }

  return result;
}

/**
 * Copies `parsed` entries into `target`, but never overrides a variable that
 * is already set there. Mirrors the "real" process env taking precedence
 * over `.env` file contents.
 */
export function applyDotEnv(
  parsed: Readonly<Record<string, string>>,
  target: Record<string, string | undefined> = process.env,
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
}

/**
 * Loads `<workspaceRoot>/.env` (if present) and applies it to `target`
 * without overriding already-set variables. A missing file is not an error.
 */
export async function loadDotEnvFile(
  workspaceRoot: string,
  target: Record<string, string | undefined> = process.env,
): Promise<void> {
  const filePath = path.join(workspaceRoot, ".env");
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  applyDotEnv(parseDotEnv(content), target);
}
