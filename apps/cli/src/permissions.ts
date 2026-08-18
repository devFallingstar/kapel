import type { PermissionDecision } from "@agent/core";

/**
 * Default per-tool permission decisions for the CLI: read-only tools are
 * pre-approved, anything that mutates the workspace or shells out asks first.
 */
export const DEFAULT_PERMISSIONS: Readonly<Record<string, PermissionDecision>> =
  {
    read_file: "allow",
    glob: "allow",
    grep: "allow",
    git_diff: "allow",
    write_file: "ask",
    edit_file: "ask",
    bash: "ask",
  };

export const DEFAULT_PERMISSION_DECISION: PermissionDecision = "ask";
