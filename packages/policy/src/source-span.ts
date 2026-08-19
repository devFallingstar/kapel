/**
 * Best-effort resolution of a compiler warning/ambiguity string back to the
 * line(s) of `.agent/orchestration.md` it is talking about.
 *
 * The compiler's warnings and ambiguities are free-form strings that quote
 * the source phrase they refer to (see the `LlmPolicyCompiler` system
 * prompt: "quote the source phrase and say why"). Rather than growing the
 * IR/tool schema with a `sourceSpan` field the model has to fill in
 * correctly, this module re-derives the location after the fact by
 * searching for the quoted phrase in the markdown itself — exact match
 * first, then a whitespace/case-insensitive fallback. When neither finds
 * the phrase, the issue simply carries no location: a missing location is
 * always preferred over a wrong one.
 */

const FILE_NAME = "orchestration.md";

/** The minimum quoted-fragment length worth searching for — shorter than
 * this, common words ("id", "no") would match almost anywhere and produce
 * a location that looks precise but means nothing. */
const MIN_FRAGMENT_LENGTH = 4;

/** Where a piece of quoted text was found in `orchestration.md`. */
export interface SourceLocation {
  /** The file the text was found in — always `"orchestration.md"` today. */
  readonly file: string;
  /** 1-based line the match starts on. */
  readonly line: number;
  /** 1-based line the match ends on — present only when it differs from `line`. */
  readonly endLine?: number;
}

/** A warning/ambiguity message paired with its best-effort source location. */
export interface LocatedIssue {
  readonly message: string;
  readonly location?: SourceLocation;
}

// Straight and "smart" quote pairs a compiler message might use to quote a
// source phrase.
const QUOTE_PATTERNS: readonly RegExp[] = [
  /"([^"]+)"/g,
  /'([^']+)'/g,
  /`([^`]+)`/g,
  /“([^”]+)”/g,
  /‘([^’]+)’/g,
];

/**
 * Every quoted fragment inside `text`, longest first (a longer fragment is
 * less likely to coincidentally match unrelated text elsewhere in the
 * source, so it is worth trying before shorter ones).
 */
export function extractQuotedFragments(text: string): readonly string[] {
  const fragments: string[] = [];
  for (const pattern of QUOTE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      const fragment = (match[1] ?? "").trim();
      if (fragment.length >= MIN_FRAGMENT_LENGTH) fragments.push(fragment);
      match = pattern.exec(text);
    }
  }
  return [...fragments].sort((a, b) => b.length - a.length);
}

/** 1-based offset of the start of every line in `markdown`. */
function buildLineStarts(markdown: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** The 1-based line number owning character offset `offset`. */
function lineForOffset(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function toLocation(
  lineStarts: readonly number[],
  startOffset: number,
  length: number,
): SourceLocation {
  const line = lineForOffset(lineStarts, startOffset);
  const endLine = lineForOffset(lineStarts, startOffset + length - 1);
  return endLine === line
    ? { file: FILE_NAME, line }
    : { file: FILE_NAME, line, endLine };
}

function locateExact(
  markdown: string,
  fragment: string,
  lineStarts: readonly number[],
): SourceLocation | undefined {
  const index = markdown.indexOf(fragment);
  return index === -1
    ? undefined
    : toLocation(lineStarts, index, fragment.length);
}

/** A normalized copy of the source with a per-character line map, built once per lookup. */
interface NormalizedSource {
  readonly text: string;
  readonly lineOf: readonly number[];
}

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Lower-cases the source and collapses every run of whitespace (including
 * line breaks, so a fragment that wraps across lines still matches) to a
 * single space, tracking which original line each emitted character came
 * from so a match can be mapped back to line numbers.
 */
function buildNormalizedSource(markdown: string): NormalizedSource {
  const chars: string[] = [];
  const lineOf: number[] = [];
  let line = 1;
  let pendingSpace = false;
  let started = false;

  for (const ch of markdown) {
    if (ch === "\n") {
      line += 1;
      pendingSpace = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && started) {
      chars.push(" ");
      lineOf.push(line);
    }
    chars.push(ch.toLowerCase());
    lineOf.push(line);
    started = true;
    pendingSpace = false;
  }

  return { text: chars.join(""), lineOf };
}

function locateNormalized(
  source: NormalizedSource,
  fragment: string,
): SourceLocation | undefined {
  const needle = collapseWhitespace(fragment);
  if (needle === "") return undefined;
  const at = source.text.indexOf(needle);
  if (at === -1) return undefined;
  const line = source.lineOf[at] ?? 1;
  const endLine = source.lineOf[at + needle.length - 1] ?? line;
  return endLine === line
    ? { file: FILE_NAME, line }
    : { file: FILE_NAME, line, endLine };
}

/**
 * Finds where `text` (a warning/ambiguity message, expected to quote a
 * source phrase) is talking about in `markdown`. Tries every quoted
 * fragment in `text` for an exact match first, then falls back to a
 * whitespace/case-insensitive search across all of them. Returns
 * `undefined` — never a guess — when nothing resolves.
 */
export function locateSourceText(
  markdown: string,
  text: string,
): SourceLocation | undefined {
  const fragments = extractQuotedFragments(text);
  if (fragments.length === 0) return undefined;

  const lineStarts = buildLineStarts(markdown);
  for (const fragment of fragments) {
    const exact = locateExact(markdown, fragment, lineStarts);
    if (exact !== undefined) return exact;
  }

  const normalized = buildNormalizedSource(markdown);
  for (const fragment of fragments) {
    const found = locateNormalized(normalized, fragment);
    if (found !== undefined) return found;
  }

  return undefined;
}

/** Pairs one warning/ambiguity message with its best-effort location. */
export function locateIssue(message: string, markdown: string): LocatedIssue {
  const location = locateSourceText(markdown, message);
  return location === undefined ? { message } : { message, location };
}

/** {@link locateIssue}, applied to a whole list of warnings/ambiguities. */
export function locateIssues(
  messages: readonly string[],
  markdown: string,
): readonly LocatedIssue[] {
  return messages.map((message) => locateIssue(message, markdown));
}

/** `"orchestration.md:12"`, or `"orchestration.md:12-13"` for a multi-line match. */
export function formatSourceLocation(location: SourceLocation): string {
  return location.endLine === undefined
    ? `${location.file}:${location.line}`
    : `${location.file}:${location.line}-${location.endLine}`;
}
