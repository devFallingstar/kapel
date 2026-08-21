/**
 * The two English list joiners the policy's prose forms share.
 *
 * Kept apart from both users so the summary in `explain.ts` and the canonical
 * source form in `canonical.ts` can never drift on how they spell a list —
 * `describePolicy` is a one-way summary, but the canonical renderer has to
 * survive being read back, and a second copy of "a, b and c" is exactly the
 * kind of thing that grows a comma somewhere and breaks the round trip.
 */

/** `a`, `a and b`, `a, b and c`. */
export function joinList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  const head = values.slice(0, -1).join(", ");
  return `${head} and ${values[values.length - 1] ?? ""}`;
}

/**
 * Splits a {@link joinList} rendering back into its items.
 *
 * Only safe for vocabularies whose items contain neither `, ` nor ` and ` —
 * the complexity enum, and nothing else. Free-form values (task types, risk
 * categories, agent names) go through the backtick-quoted list in
 * `canonical.ts` instead, which is separator-proof by construction.
 */
export function splitJoinedList(text: string): readonly string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  return trimmed
    .replace(/ and /g, ", ")
    .split(", ")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
