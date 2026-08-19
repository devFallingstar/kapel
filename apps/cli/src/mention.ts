import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `@`-mentions: completing a workspace file path at the prompt, and telling
 * the agent about the ones that survived to send time.
 *
 * The module is deliberately three separable layers, because only the middle
 * one touches a disk:
 *
 * 1. {@link fuzzyScore} / {@link rankMentionMatches} — pure ranking, no I/O.
 * 2. {@link createFileLister} — "what files are in this workspace", answered
 *    by `git ls-files` when there is a git repo and by a bounded walk when
 *    there isn't, cached behind a short TTL so holding Tab down does not
 *    spawn a process per keystroke.
 * 3. {@link annotateMentions} — the send-time rewrite that turns the mentions
 *    a message *contains* into one line the agent can act on.
 *
 * Nothing here ever reads a mentioned file's contents. The agent has
 * `read_file`; inlining the bytes would duplicate that tool, bloat every
 * following turn's context, and lie about how fresh the snapshot is.
 */

// --- Fuzzy ranking (pure) ----------------------------------------------------

/** Any matched query character at all. */
const MATCH_BONUS = 4;
/** Matched immediately after the previous match — the tightness signal. */
const CONSECUTIVE_BONUS = 8;
/** Matched at a segment boundary: string start, or just after one of these. */
const BOUNDARY_BONUS = 6;
/** The first character skipped inside the match. */
const GAP_START_PENALTY = -3;
/** Each further character skipped in the same gap… */
const GAP_EXTRA_PENALTY = -1;
/** …up to this much, so one huge gap cannot swamp everything else. */
const GAP_MAX_PENALTY = -10;

const BOUNDARY_CHARS = new Set(["/", "\\", "-", "_", ".", " "]);

function isBoundary(candidate: string, index: number): boolean {
  if (index === 0) return true;
  const previous = candidate[index - 1];
  return previous !== undefined && BOUNDARY_CHARS.has(previous);
}

function gapPenalty(gap: number): number {
  if (gap <= 0) return 0;
  return Math.max(
    GAP_START_PENALTY + (gap - 1) * GAP_EXTRA_PENALTY,
    GAP_MAX_PENALTY,
  );
}

/**
 * Scores `query` as a case-insensitive subsequence of `candidate`, or returns
 * `undefined` when it is not one at all.
 *
 * Higher is better. The score rewards *tightness* — consecutive characters and
 * characters landing on a path-segment boundary — and penalises the holes
 * between them, so `clisrc` scores far higher against `apps/cli/src/input.ts`
 * than the same six characters scattered across an unrelated path. Characters
 * skipped **before** the first match cost nothing, on purpose: a deep path is
 * not a worse match for its own basename than a shallow one is, and preferring
 * short paths is {@link rankMentionMatches}'s job, not this function's.
 *
 * An empty query matches everything with a score of 0, which is what makes a
 * bare `@` list the workspace instead of listing nothing.
 */
export function fuzzyScore(
  candidate: string,
  query: string,
): number | undefined {
  if (query === "") return 0;

  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let previous = -1;
  for (const character of needle) {
    const index = haystack.indexOf(character, previous + 1);
    if (index === -1) return undefined;

    if (index === previous + 1 && previous !== -1) {
      score += CONSECUTIVE_BONUS;
    } else {
      score += MATCH_BONUS;
      // Only holes *inside* the match are charged for; the run-up to the
      // first matched character is free (see the doc comment).
      if (previous !== -1) score += gapPenalty(index - previous - 1);
    }
    if (isBoundary(candidate, index)) score += BOUNDARY_BONUS;

    previous = index;
  }
  return score;
}

/**
 * Ranks `paths` against `query`, best first, keeping at most `limit`.
 *
 * Ties break on the shorter path and then alphabetically: tightness decides
 * which files matched *well*, shortness decides between two that matched
 * equally, and the alphabetical last resort is what makes the order stable
 * enough to assert on.
 */
export function rankMentionMatches(
  paths: readonly string[],
  query: string,
  limit = MENTION_LIMIT,
): readonly string[] {
  const scored: { path: string; score: number }[] = [];
  for (const candidate of paths) {
    const score = fuzzyScore(candidate, query);
    if (score === undefined) continue;
    scored.push({ path: candidate, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return scored.slice(0, limit).map((entry) => entry.path);
}

// --- The mention token being typed -------------------------------------------

/**
 * The `@…` token immediately before the cursor, or `undefined` when the line
 * is not in the middle of one.
 *
 * Only the last whitespace-delimited word counts, and only when it *starts*
 * with `@` — so `look at @apps/cl` is a mention in progress while an email
 * address (`me@example.com`) and a line ending in a space are not. The token
 * is returned with its `@` still attached because that is exactly the span
 * readline will replace when a completion is accepted.
 */
export function mentionTokenAt(line: string): string | undefined {
  const boundary = Math.max(line.lastIndexOf(" "), line.lastIndexOf("\t"));
  const token = line.slice(boundary + 1);
  if (!token.startsWith("@")) return undefined;
  return token;
}

// --- Listing the workspace's files -------------------------------------------

/** How many completions one Tab offers at most. */
export const MENTION_LIMIT = 20;

/** How long a listing is reused before the workspace is looked at again. */
export const FILE_LIST_TTL_MS = 5_000;

/** Ceiling on a listing, whichever source produced it. */
export const MAX_LISTED_FILES = 2_000;

/** How deep the non-git fallback walk descends below the workspace root. */
export const MAX_WALK_DEPTH = 4;

/** Directories the fallback walk never enters. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Enough for a path list covering a large worktree. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface FileLister {
  /** The workspace's files, relative and `/`-separated. Cached; never throws. */
  list(): Promise<readonly string[]>;
  /** Drops the cache, so the next {@link list} looks at the workspace again. */
  invalidate(): void;
}

export interface FileListerOptions {
  readonly workspacePath: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
  /**
   * The git listing, overridable in tests. Returning `undefined` means "not a
   * git repo (or git is unusable here)", which is what selects the walk.
   */
  readonly listTracked?: (
    workspacePath: string,
  ) => Promise<readonly string[] | undefined>;
}

/**
 * `git ls-files --cached --others --exclude-standard` — tracked files plus
 * untracked ones that `.gitignore` does not exclude.
 *
 * This is the cheap way to respect ignore rules: git already has the answer
 * indexed, and re-implementing `.gitignore` semantics over a walk would be
 * both slower and wrong in the corners. Anything other than a clean exit is
 * read as "no git here" rather than as an error to report — a completion that
 * cannot be offered is not worth interrupting the prompt over.
 */
async function gitListFiles(
  workspacePath: string,
): Promise<readonly string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspacePath, maxBuffer: MAX_BUFFER_BYTES },
    );
    return stdout.split("\n").filter((line) => line !== "");
  } catch {
    return undefined;
  }
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * The non-git fallback: a bounded breadth-first walk of the workspace.
 *
 * Bounded three ways — depth, entry count, and a skip list — because outside a
 * git repo there is no ignore file to lean on, and an unbounded walk of a home
 * directory would hang the prompt it is supposed to be helping.
 */
async function walkFiles(
  workspacePath: string,
  maxEntries: number,
): Promise<readonly string[]> {
  const found: string[] = [];
  let level: string[] = [""];

  for (let depth = 0; depth <= MAX_WALK_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const relativeDir of level) {
      if (found.length >= maxEntries) return found;
      let entries: Dirent[];
      try {
        entries = await readdir(path.join(workspacePath, relativeDir), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      // Sorted so the listing (and therefore the truncation) is deterministic.
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of sorted) {
        if (found.length >= maxEntries) return found;
        const relative =
          relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name)) continue;
          if (depth < MAX_WALK_DEPTH) next.push(relative);
          continue;
        }
        if (entry.isFile()) found.push(toPosix(relative));
      }
    }
    level = next;
  }
  return found;
}

/**
 * A cached view of "what files can be mentioned here".
 *
 * The cache exists for one reason: the completer runs on every Tab, and
 * spawning `git ls-files` per keystroke on a large repo is felt. A short TTL
 * (5s) is the right shape of staleness for this — long enough to cover a burst
 * of tabbing, short enough that a file created in another terminal shows up
 * before anyone notices it is missing. Overlapping calls share one in-flight
 * listing rather than racing two of them.
 */
export function createFileLister(options: FileListerOptions): FileLister {
  const ttlMs = options.ttlMs ?? FILE_LIST_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? MAX_LISTED_FILES;
  const listTracked = options.listTracked ?? gitListFiles;

  let cached: { paths: readonly string[]; at: number } | undefined;
  let inFlight: Promise<readonly string[]> | undefined;

  const load = async (): Promise<readonly string[]> => {
    const tracked = await listTracked(options.workspacePath);
    const paths =
      tracked === undefined
        ? await walkFiles(options.workspacePath, maxEntries)
        : tracked.slice(0, maxEntries);
    cached = { paths, at: now() };
    return paths;
  };

  return {
    async list(): Promise<readonly string[]> {
      const fresh = cached;
      if (fresh !== undefined && now() - fresh.at < ttlMs) return fresh.paths;
      if (inFlight !== undefined) return await inFlight;
      inFlight = load().catch(() => [] as readonly string[]);
      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
      }
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}

// --- Completion ---------------------------------------------------------------

/** What `readline`'s completer contract wants back: the hits, and what they replace. */
export type CompletionResult = [string[], string];

/**
 * Completes a mention token against a workspace listing.
 *
 * The hits keep their `@`, so accepting one leaves the message reading
 * `look at @apps/cli/src/input.ts` — a mention is plain text in the prompt and
 * stays plain text in the message. `token` comes back as the second element
 * because readline replaces exactly that span; a fuzzy winner that shares no
 * prefix with what was typed is *substituted* for it rather than appended to
 * it, which is the only way `@clisrc` can turn into a real path.
 */
export async function completeMention(
  files: FileLister,
  token: string,
  limit = MENTION_LIMIT,
): Promise<CompletionResult> {
  const paths = await files.list();
  const hits = rankMentionMatches(paths, token.slice(1), limit);
  return [hits.map((hit) => `@${hit}`), token];
}

// --- Send-time annotation -------------------------------------------------------

/** Trailing prose punctuation a mention should not swallow. */
const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  '"',
  "'",
]);

/**
 * A mention in prose: `@` at the start of a word, followed by non-whitespace.
 *
 * The `[^\w@]` lead-in is what keeps `me@example.com` (and `a@@b`) out — an
 * `@` glued to the end of a word is an address or an operator, not a path —
 * while still finding one inside brackets or quotes, as in `see (@notes.md)`.
 */
const MENTION_PATTERN = /(?:^|[^\w@])@([^\s]+)/g;

/**
 * True when `relativePath` names a file that is really inside `workspacePath`.
 *
 * The containment check is not decoration: `@../../etc/passwd` is a thing a
 * message can contain, and a mention is a hint kapel *adds* to the prompt, so
 * it must never point the agent at something outside the directory the user
 * opened.
 */
export function workspaceFileExists(
  workspacePath: string,
  relativePath: string,
): Promise<boolean> {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, relativePath);
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  if (!inside) return Promise.resolve(false);
  return stat(resolved).then(
    (stats) => stats.isFile(),
    () => false,
  );
}

/** Every `@…` token in `text`, with prose punctuation trimmed off the ends. */
function mentionCandidates(text: string): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const raw = match[1];
    if (raw === undefined || raw === "") continue;
    // Longest first: `@notes.md` should win over `@notes.m` and `@notes`.
    const forms: string[] = [raw];
    let trimmed = raw;
    while (trimmed.length > 1 && TRAILING_PUNCTUATION.has(trimmed.slice(-1))) {
      trimmed = trimmed.slice(0, -1);
      forms.push(trimmed);
    }
    out.push(forms);
  }
  return out;
}

/**
 * Resolves the mentions in `text` to the workspace files they name.
 *
 * A token that names nothing is left alone and reported by nobody: people
 * write `@here` and `@someone` in prose, and guessing that those were meant to
 * be paths would be worse than ignoring them.
 */
export async function resolveMentions(
  text: string,
  exists: (relativePath: string) => boolean | Promise<boolean>,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const forms of mentionCandidates(text)) {
    for (const form of forms) {
      if (found.includes(form)) break;
      if (await exists(form)) {
        found.push(form);
        break;
      }
    }
  }
  return found;
}

/** The line appended to a message that mentioned files. */
export function mentionAnnotation(paths: readonly string[]): string {
  return `[mentioned files: ${paths.join(", ")}]`;
}

/**
 * The send-time rewrite: the message keeps its `@` mentions verbatim and gains
 * one trailing line naming the files they resolved to.
 *
 * Naming rather than inlining is the whole point. The agent already has
 * `read_file`, so a list tells it *which* files matter and lets it decide what
 * to read; pasting contents in would spend the context window on bytes the
 * agent may not need and freeze them at the moment the message was sent.
 */
export async function annotateMentions(
  text: string,
  exists: (relativePath: string) => boolean | Promise<boolean>,
): Promise<string> {
  const paths = await resolveMentions(text, exists);
  if (paths.length === 0) return text;
  return `${text}\n\n${mentionAnnotation(paths)}`;
}
