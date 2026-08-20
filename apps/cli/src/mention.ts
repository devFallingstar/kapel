import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { mediaTypeFromExtension, sniffImageMediaType } from "@agent/ai";
import type { AgentImageAttachment } from "@agent/core";

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
 * 3. {@link prepareMentions} — the send-time rewrite that turns the mentions
 *    a message *contains* into something the agent can act on.
 *
 * Text files are never inlined: the agent has `read_file`, and pasting the
 * bytes in would duplicate that tool, bloat every following turn's context,
 * and lie about how fresh the snapshot is — so a text mention becomes one
 * `[mentioned files: …]` line naming it. An *image* has no such tool (no
 * model reads a PNG through `read_file`), so `@shot.png` is the one mention
 * that is really attached to the turn, under the same count and size caps the
 * removed `-i/--image` flag enforced.
 *
 * *How* it is attached depends on who runs the turn, which is the whole reason
 * {@link PrepareMentionsOptions.readImage} is a seam:
 *
 * - The native loop speaks to a provider, so the bytes travel —
 *   {@link workspaceImageReader} reads them and they ride as vision content.
 * - A delegated backend is a CLI running in the workspace, which can open the
 *   file itself, so only the path travels — {@link workspaceImagePathReader}
 *   validates the mention exactly as the byte reader does (containment, is-a-
 *   file, size cap) and hands back the path without reading it.
 *
 * Both produce the same `[attached images: …]` line and obey the same caps: an
 * image that is too big is refused on a delegated backend too, even though
 * nothing would have been embedded, because "kapel attaches images up to 5 MiB"
 * is a contract worth keeping identical across backends.
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

/** The line appended to a message whose image mentions were attached. */
export function imageAnnotation(paths: readonly string[]): string {
  return `[attached images: ${paths.join(", ")}]`;
}

// --- Image mentions ----------------------------------------------------------

/**
 * At most this many images ride with one turn — the cap the removed
 * `-i/--image` flag enforced per run, kept because the reasons did not change:
 * each image rides inline in the request body, and a coding turn rarely needs
 * more than a screenshot or two.
 */
export const MAX_MENTION_IMAGES = 4;

/**
 * Per-image ceiling, checked from `stat` before any bytes are read. The old
 * flag also carried a 20 MiB combined cap; at four images of 5 MiB that is
 * exactly this cap times that count, so it has nothing left to reject.
 */
export const MAX_MENTION_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * What a reader gives back for one image mention: the absolute path it
 * resolved to, the bytes when this turn carries bytes at all, or the reason (a
 * printable clause) it did not work out. A failure is never fatal —
 * {@link prepareMentions} turns it into a note and lets the mention fall back
 * to being just a path.
 *
 * `bytes` is optional because a delegated backend attaches by path: the same
 * validation runs, and the successful answer is a path with nothing read.
 */
export type MentionImageRead =
  | { readonly bytes?: Uint8Array; readonly path: string }
  | { readonly error: string };

export type MentionImageReader = (
  relativePath: string,
) => Promise<MentionImageRead>;

function formatBytes(count: number): string {
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Everything both readers agree on: the mention names a real file, inside the
 * workspace, no bigger than the cap. Answers with the absolute path, which is
 * what the byte reader then opens and what the path reader hands on as-is.
 *
 * Containment is re-checked here even though {@link workspaceFileExists}
 * already checked it, because this is the layer that opens the file (or names
 * it to another process) — a reader that trusts its caller for that is one
 * refactor away from attaching `@../../.ssh/id_rsa`. The size cap is applied
 * from `stat`, before any read, so an enormous file is refused rather than
 * pulled into memory first.
 */
async function resolveWorkspaceImage(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<{ readonly path: string } | { readonly error: string }> {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { error: "it is outside this workspace" };
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return { error: "it is not a file" };
    if (info.size > maxBytes) {
      return {
        error: `it is ${formatBytes(info.size)}, over the ${formatBytes(maxBytes)} per-image limit`,
      };
    }
    return { path: resolved };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The reader for a turn that carries bytes: a mentioned image, read from under
 * `workspacePath`. This is the native path's reader.
 */
export function workspaceImageReader(
  workspacePath: string,
  maxBytes = MAX_MENTION_IMAGE_BYTES,
): MentionImageReader {
  const root = path.resolve(workspacePath);
  return async (relativePath: string): Promise<MentionImageRead> => {
    const resolved = await resolveWorkspaceImage(root, relativePath, maxBytes);
    if ("error" in resolved) return resolved;
    try {
      return { bytes: await readFile(resolved.path), path: resolved.path };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * The reader for a turn that carries *paths*: the delegated backends, whose
 * CLI opens the file itself from inside the workspace.
 *
 * Same validation as {@link workspaceImageReader} — including the size cap,
 * which has nothing to protect here since no bytes are embedded, and is
 * enforced anyway so `@huge.png` behaves the same on every backend rather than
 * quietly succeeding on one of them. The path is absolute: the delegated CLIs
 * run with the workspace as their cwd, so a relative path would also resolve,
 * but an absolute one cannot be misread if the child ever changes directory.
 */
export function workspaceImagePathReader(
  workspacePath: string,
  maxBytes = MAX_MENTION_IMAGE_BYTES,
): MentionImageReader {
  const root = path.resolve(workspacePath);
  return async (relativePath: string): Promise<MentionImageRead> =>
    await resolveWorkspaceImage(root, relativePath, maxBytes);
}

export interface PrepareMentionsOptions {
  /** Decides whether a mention names a real workspace file. */
  readonly exists: (relativePath: string) => boolean | Promise<boolean>;
  /**
   * Turns an image mention into an attachment: {@link workspaceImageReader} on
   * the native path (bytes), {@link workspaceImagePathReader} on a delegated
   * one (path only). Absent means "this turn attaches nothing" — every image
   * mention stays an ordinary path in the `[mentioned files: …]` line.
   */
  readonly readImage?: MentionImageReader;
  /** Defaults to {@link MAX_MENTION_IMAGES}. */
  readonly maxImages?: number;
}

export interface PreparedMentions {
  /** The message as it should be sent: the text, plus its annotation lines. */
  readonly instruction: string;
  /** Images to attach to this turn as bytes, in mention order. */
  readonly images: readonly AgentImageAttachment[];
  /**
   * Absolute paths of the images attached to this turn, in mention order —
   * what a delegated backend forwards to its CLI. Populated whichever reader
   * was used, so on the native path it simply mirrors {@link images}' paths.
   */
  readonly imagePaths: readonly string[];
  /**
   * Every resolved mention whose extension names an image, attached or not.
   * The caller uses it to say something when images cannot be attached at all.
   */
  readonly imageMentions: readonly string[];
  /** One printable note per image that did not make it, in mention order. */
  readonly notices: readonly string[];
}

/**
 * The send-time rewrite: the message keeps its `@` mentions verbatim and gains
 * the annotation lines its mentions earned.
 *
 * Text mentions are *named*, never inlined (see the module comment). Image
 * mentions are attached — as bytes or as a path, whichever the configured
 * reader produces — and are named on their own `[attached images: …]` line
 * rather than the `[mentioned files: …]` one: telling the agent to go
 * `read_file` a PNG it can already see would only earn a screenful of binary.
 *
 * Nothing here fails a turn. An image that is too big, unreadable, or past the
 * per-turn count comes back as a note *and* as an ordinary path mention, so the
 * worst case is exactly the behavior kapel had before images were attachable
 * at all.
 */
export async function prepareMentions(
  text: string,
  options: PrepareMentionsOptions,
): Promise<PreparedMentions> {
  const resolved = await resolveMentions(text, options.exists);
  const maxImages = options.maxImages ?? MAX_MENTION_IMAGES;
  const readImage = options.readImage;

  const listed: string[] = [];
  const imageMentions: string[] = [];
  const attachedNames: string[] = [];
  const images: AgentImageAttachment[] = [];
  const imagePaths: string[] = [];
  const notices: string[] = [];

  const skip = (relativePath: string, reason?: string): void => {
    if (reason !== undefined) {
      notices.push(`note: @${relativePath} was not attached — ${reason}.`);
    }
    listed.push(relativePath);
  };

  for (const relativePath of resolved) {
    // The extension decides whether a mention is *treated* as an image; the
    // magic bytes, once read, decide what it is actually declared as.
    const extensionType = mediaTypeFromExtension(relativePath);
    if (extensionType === undefined) {
      listed.push(relativePath);
      continue;
    }
    imageMentions.push(relativePath);

    if (readImage === undefined) {
      listed.push(relativePath);
      continue;
    }
    // Counted on what was *attached*, not on the byte attachments: a path-only
    // turn fills `images` with nothing and would otherwise never hit the cap.
    if (attachedNames.length >= maxImages) {
      skip(
        relativePath,
        `at most ${maxImages} image${maxImages === 1 ? "" : "s"} can ride with one message`,
      );
      continue;
    }

    const read = await readImage(relativePath);
    if ("error" in read) {
      skip(relativePath, read.error);
      continue;
    }
    const bytes = read.bytes;
    if (bytes !== undefined) {
      images.push({
        // A `.png` that is really a JPEG is declared as what it is; a format
        // the sniffer's small table does not cover falls back to the extension
        // that got it this far.
        mediaType: sniffImageMediaType(bytes) ?? extensionType,
        base64: Buffer.from(bytes).toString("base64"),
        path: read.path,
      });
    }
    imagePaths.push(read.path);
    attachedNames.push(relativePath);
  }

  const blocks: string[] = [];
  if (listed.length > 0) blocks.push(mentionAnnotation(listed));
  if (attachedNames.length > 0) blocks.push(imageAnnotation(attachedNames));

  return {
    instruction: blocks.length === 0 ? text : `${text}\n\n${blocks.join("\n")}`,
    images,
    imagePaths,
    imageMentions,
    notices,
  };
}

/**
 * {@link prepareMentions} with nothing attachable: the message plus its
 * `[mentioned files: …]` line, which is all a caller with no way to carry
 * image bytes can use.
 */
export async function annotateMentions(
  text: string,
  exists: (relativePath: string) => boolean | Promise<boolean>,
): Promise<string> {
  return (await prepareMentions(text, { exists })).instruction;
}
