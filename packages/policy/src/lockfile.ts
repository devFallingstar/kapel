import { createHash } from "node:crypto";
import { z } from "zod";
import { type PolicyCompileResult, PolicySchema } from "./schema.js";

export const LOCKFILE_VERSION = 1;

export const LockfileSchema = z.object({
  lockfileVersion: z.literal(1),
  sourceHash: z.string(),
  compiledAt: z.number(),
  model: z.string(),
  policy: PolicySchema,
  warnings: z.array(z.string()).default([]),
  ambiguities: z.array(z.string()).default([]),
});

export type PolicyLockfile = z.infer<typeof LockfileSchema>;

/**
 * Normalizes cosmetic differences before hashing: CRLF line endings become
 * LF, trailing whitespace is stripped from every line, and trailing blank
 * lines are dropped. Reformatting `.agent/orchestration.md` therefore does
 * not invalidate a lockfile; changing a word does.
 */
function normalizeSource(markdown: string): string {
  return markdown
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** sha256 of the normalized policy source, hex-encoded. */
export function hashPolicySource(markdown: string): string {
  return createHash("sha256")
    .update(normalizeSource(markdown), "utf8")
    .digest("hex");
}

export interface CreateLockfileInput {
  readonly markdown: string;
  readonly result: PolicyCompileResult;
  readonly model: string;
  /** Epoch milliseconds recorded as `compiledAt`. Defaults to `Date.now()`. */
  readonly now?: number;
}

export function createLockfile(input: CreateLockfileInput): PolicyLockfile {
  return {
    lockfileVersion: LOCKFILE_VERSION,
    sourceHash: hashPolicySource(input.markdown),
    compiledAt: input.now ?? Date.now(),
    model: input.model,
    policy: input.result.policy,
    warnings: [...input.result.warnings],
    ambiguities: [...input.result.ambiguities],
  };
}

/**
 * JSON with object keys sorted, 2-space indent — so that equal lockfile
 * values always serialize to equal bytes regardless of key insertion order.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted: Record<string, unknown> = {};
  for (const [key, item] of entries) sorted[key] = sortDeep(item);
  return sorted;
}

export function serializeLockfile(lock: PolicyLockfile): string {
  return `${JSON.stringify(sortDeep(lock), null, 2)}\n`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Parses and validates lockfile JSON. Throws with a readable message. */
export function parseLockfile(content: string): PolicyLockfile {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid orchestration lockfile: not valid JSON (${detail})`,
    );
  }
  const parsed = LockfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid orchestration lockfile: ${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

export type LockStatus =
  | { readonly fresh: true; readonly lock: PolicyLockfile }
  | {
      readonly fresh: false;
      readonly reason: "missing" | "stale-source" | "invalid";
      readonly detail?: string;
      readonly lock?: PolicyLockfile;
    };

/**
 * Decides whether a lockfile still describes the given policy source. Pure —
 * the caller reads `.agent/orchestration.md` and `orchestration.lock.json`.
 */
export function checkLock(
  markdown: string,
  lockContent: string | undefined,
): LockStatus {
  if (lockContent === undefined || lockContent.trim() === "") {
    return { fresh: false, reason: "missing" };
  }

  let lock: PolicyLockfile;
  try {
    lock = parseLockfile(lockContent);
  } catch (error) {
    return {
      fresh: false,
      reason: "invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const expected = hashPolicySource(markdown);
  if (lock.sourceHash !== expected) {
    return {
      fresh: false,
      reason: "stale-source",
      detail: `policy source hash ${expected} does not match locked ${lock.sourceHash}`,
      lock,
    };
  }
  return { fresh: true, lock };
}
