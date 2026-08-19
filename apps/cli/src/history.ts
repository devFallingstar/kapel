import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { kapelConfigDir } from "./config.js";

/**
 * Persistent ↑-history for the interactive input editor: one message per
 * line in a flat file under the machine's kapel config dir, oldest line
 * first (append order) — the same file format across sessions, converted
 * to readline's newest-first convention only on load.
 */

export const HISTORY_LIMIT = 1000;
const TRIM_THRESHOLD = HISTORY_LIMIT * 2;

/** `<kapelConfigDir>/history`. */
export function historyFilePath(env?: NodeJS.ProcessEnv): string {
  return path.join(kapelConfigDir(env), "history");
}

/**
 * Loads history for handing to `readline`/`InputManager`: newest first,
 * capped at `HISTORY_LIMIT`, blanks skipped. A missing or unreadable file
 * is not an error — just no history yet.
 */
export async function loadHistory(
  env?: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(historyFilePath(env), "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const newestFirst = lines.reverse();
  return newestFirst.slice(0, HISTORY_LIMIT);
}

/**
 * Builds a fire-and-forget appender: each call queues one line onto the
 * history file, serialized behind a promise chain so concurrent calls never
 * interleave writes, and never throws — a history write failing is not
 * worth interrupting the REPL over.
 *
 * Skips a line that repeats the immediately preceding one (consecutive
 * duplicates only, matching shell history conventions), and amortizes the
 * file's growth by trimming it back down to `HISTORY_LIMIT` lines once it
 * has grown past twice that.
 */
export function createHistoryAppender(
  env?: NodeJS.ProcessEnv,
): (entry: string) => void {
  const filePath = historyFilePath(env);
  let chain: Promise<void> = Promise.resolve();
  let lastEntry: string | undefined;
  let dirEnsured = false;
  /** Known line count, or `undefined` until it's been read at least once. */
  let lineCount: number | undefined;

  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    await mkdir(path.dirname(filePath), { recursive: true });
    dirEnsured = true;
  }

  async function currentLineCount(): Promise<number> {
    try {
      const raw = await readFile(filePath, "utf8");
      return raw.split("\n").filter((line) => line.trim() !== "").length;
    } catch {
      return 0;
    }
  }

  async function appendOne(entry: string): Promise<void> {
    try {
      await ensureDir();
      await writeFile(filePath, `${entry}\n`, { flag: "a" });
      // Track the count in memory after the first read so later appends
      // don't each re-read the whole file just to decide whether to trim.
      lineCount =
        lineCount === undefined ? await currentLineCount() : lineCount + 1;
      if (lineCount > TRIM_THRESHOLD) {
        await trim();
      }
    } catch {
      // Best-effort: a broken history file must never break the REPL.
    }
  }

  async function trim(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const trimmed = lines.slice(-HISTORY_LIMIT);
    await writeFile(filePath, `${trimmed.join("\n")}\n`);
    lineCount = trimmed.length;
  }

  return (entry: string): void => {
    if (entry === lastEntry) return;
    lastEntry = entry;
    chain = chain.then(() => appendOne(entry));
  };
}
