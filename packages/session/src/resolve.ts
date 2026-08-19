import type { ChatSessionRecord } from "./sqlite.js";

/** How many characters of a session id identify it in a resolution error. */
const SHORT_ID_LENGTH = 8;

function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/** A reference resolved to exactly one stored session. */
export interface ChatSessionMatch {
  readonly record: ChatSessionRecord;
}

/** A reference that could not be resolved to exactly one stored session. */
export interface ChatSessionResolutionError {
  readonly error: string;
}

export type ChatSessionResolution =
  | ChatSessionMatch
  | ChatSessionResolutionError;

export interface ResolveChatSessionOptions {
  /**
   * Called with a human-readable note when resolution succeeds but had to
   * make a judgment call the caller may want to surface — currently just the
   * "two sessions share this name" case. Never called on an error result.
   */
  readonly onNote?: (note: string) => void;
}

function availableSessionsHint(records: readonly ChatSessionRecord[]): string {
  if (records.length === 0) return "";
  const listed = records.slice(0, 20).map((record) => shortId(record.id));
  return ` Available: ${listed.join(", ")}.`;
}

/**
 * Resolves a `--session <id|name>`-style reference against a workspace's
 * stored sessions, matching (in order):
 *
 * 1. an id, exactly;
 * 2. an id prefix — ambiguous when it prefixes more than one id;
 * 3. a `name`, exactly — when more than one session shares it, the most
 *    recently updated one wins and `onNote` is called with a warning.
 *
 * Id resolution is tried before name resolution and short-circuits on a
 * unique match, which is what makes id-prefix win over name in the one case
 * they can collide: a reference that is simultaneously some session's exact
 * name and another session's id prefix resolves to the id. This mirrors
 * `matchChatSession` in `apps/cli/src/interactive.ts` (same shape of result,
 * same id-prefix behavior) with name matching layered on top.
 *
 * `records` must already be ordered most-recently-updated first — the order
 * `listChatSessions` returns — since that order is what "most recent wins"
 * reads off of.
 */
export function resolveChatSessionReference(
  records: readonly ChatSessionRecord[],
  reference: string,
  options: ResolveChatSessionOptions = {},
): ChatSessionResolution {
  const exactId = records.find((record) => record.id === reference);
  if (exactId !== undefined) return { record: exactId };

  const idPrefixMatches = records.filter((record) =>
    record.id.startsWith(reference),
  );
  if (idPrefixMatches.length === 1) {
    // `length === 1` is always defined; the non-null assertion below is only
    // to satisfy noUncheckedIndexedAccess.
    return { record: idPrefixMatches[0] as ChatSessionRecord };
  }
  if (idPrefixMatches.length > 1) {
    const ids = idPrefixMatches.map((record) => shortId(record.id));
    return {
      error: `"${reference}" matches ${idPrefixMatches.length} sessions: ${ids.join(", ")}. Use a longer prefix.`,
    };
  }

  const nameMatches = records.filter((record) => record.name === reference);
  const first = nameMatches[0];
  if (first !== undefined) {
    if (nameMatches.length > 1) {
      options.onNote?.(
        `Multiple sessions are named "${reference}"; using the most recently updated one (${shortId(first.id)}).`,
      );
    }
    return { record: first };
  }

  return {
    error: `No chat session matches "${reference}".${availableSessionsHint(records)}`,
  };
}
