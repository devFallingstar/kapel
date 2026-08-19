import type { z } from "zod";

/** True when `err` is a Node `fs` "file/directory does not exist" error. */
export function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/** Renders zod issues as `<dotted.path>: <message>` strings, `(root)` when the path is empty. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}
