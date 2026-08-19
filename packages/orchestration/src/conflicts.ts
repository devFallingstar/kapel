import type { PlannedTask, TaskType } from "./types.js";

/**
 * Task types whose workers may write to the filesystem. `exploration` and
 * `review` are read-only by construction and never participate in a
 * conflict, regardless of what `affectedAreas` they declare.
 */
export const MUTATING_TASK_TYPES: ReadonlySet<TaskType> = new Set([
  "architecture",
  "implementation",
  "testing",
  "documentation",
]);

/** An area that, once normalized, denotes "the whole repository". */
function isWholeRepo(area: string): boolean {
  return area === "**" || area === "" || area === ".";
}

/**
 * Normalizes a single affected-area string for prefix comparison: backslashes
 * become forward slashes, a leading "./" is stripped, and a trailing "/" is
 * stripped (unless doing so would leave nothing).
 */
function normalizeArea(area: string): string {
  const slashed = area.replace(/\\/g, "/");
  const withoutLeading = slashed.startsWith("./") ? slashed.slice(2) : slashed;
  return withoutLeading.length > 1 && withoutLeading.endsWith("/")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
}

/** True when `x` and `y` are the same path, or one is a path-prefix of the other. */
function prefixOverlap(x: string, y: string): boolean {
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Whether any area in `a` overlaps any area in `b` after normalization.
 * Overlap is path-prefix based: "src" overlaps "src/api/x.ts", but
 * "src/api" and "src/web" do not. "**", "" and "." denote the whole repo
 * and overlap everything.
 */
export function areasOverlap(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const normalizedA = a.map(normalizeArea);
  const normalizedB = b.map(normalizeArea);
  for (const x of normalizedA) {
    for (const y of normalizedB) {
      if (isWholeRepo(x) || isWholeRepo(y) || prefixOverlap(x, y)) return true;
    }
  }
  return false;
}

/**
 * Whether two planned tasks may write to overlapping parts of the repo and
 * therefore must not run concurrently. Always false unless both tasks are
 * mutating types; a mutating task with no declared `affectedAreas` is
 * treated as scoped to the whole repo, since its footprint is unknown.
 */
export function tasksConflict(a: PlannedTask, b: PlannedTask): boolean {
  if (!MUTATING_TASK_TYPES.has(a.type) || !MUTATING_TASK_TYPES.has(b.type))
    return false;
  const areasA = a.affectedAreas.length === 0 ? ["**"] : a.affectedAreas;
  const areasB = b.affectedAreas.length === 0 ? ["**"] : b.affectedAreas;
  return areasOverlap(areasA, areasB);
}
