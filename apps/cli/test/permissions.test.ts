import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_DECISION,
  DEFAULT_PERMISSIONS,
} from "../src/permissions.js";

describe("DEFAULT_PERMISSIONS", () => {
  it("pre-approves the read-only tools", () => {
    expect(DEFAULT_PERMISSIONS.read_file).toBe("allow");
    expect(DEFAULT_PERMISSIONS.glob).toBe("allow");
    expect(DEFAULT_PERMISSIONS.grep).toBe("allow");
    expect(DEFAULT_PERMISSIONS.git_diff).toBe("allow");
  });

  it("asks before mutating the workspace or shelling out", () => {
    expect(DEFAULT_PERMISSIONS.write_file).toBe("ask");
    expect(DEFAULT_PERMISSIONS.edit_file).toBe("ask");
    expect(DEFAULT_PERMISSIONS.bash).toBe("ask");
  });

  it("covers exactly the seven built-in tools", () => {
    expect(Object.keys(DEFAULT_PERMISSIONS).sort()).toEqual(
      [
        "bash",
        "edit_file",
        "git_diff",
        "glob",
        "grep",
        "read_file",
        "write_file",
      ].sort(),
    );
  });

  it("defaults unlisted tools to 'ask'", () => {
    expect(DEFAULT_PERMISSION_DECISION).toBe("ask");
  });
});
