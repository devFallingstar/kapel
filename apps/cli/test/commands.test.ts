import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUSTOM_COMMAND_NAME_PATTERN,
  type CustomCommand,
  expandCustomCommand,
  loadCustomCommands,
} from "../src/commands.js";

const TEST_TMP_ROOT = process.env.AGENT_TEST_TMPDIR || tmpdir();

const created: string[] = [];

async function tempWorkspace(): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP_ROOT, "kapel-commands-"));
  created.push(dir);
  return dir;
}

async function writeCommand(
  workspacePath: string,
  fileName: string,
  body: string,
): Promise<void> {
  const dir = path.join(workspacePath, ".agent", "commands");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), body, "utf8");
}

const BUILTIN_NAMES = new Set([
  "help",
  "exit",
  "new",
  "sessions",
  "resume",
  "model",
  "config",
  "usage",
  "compact",
  "undo",
  "orchestrate",
]);

afterEach(async () => {
  await Promise.all(
    created.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  created.length = 0;
});

describe("CUSTOM_COMMAND_NAME_PATTERN", () => {
  it("accepts lowercase names with digits and hyphens", () => {
    for (const name of ["review", "review-pr", "a", "x1-2-3"]) {
      expect(CUSTOM_COMMAND_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it("rejects uppercase, leading digits/hyphens, and overlong names", () => {
    for (const name of [
      "Review",
      "1review",
      "-review",
      "re view",
      "a".repeat(33),
    ]) {
      expect(CUSTOM_COMMAND_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});

describe("loadCustomCommands", () => {
  it("returns nothing when there is no .agent directory at all", async () => {
    const workspace = await tempWorkspace();
    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result).toEqual({ commands: [], warnings: [] });
  });

  it("returns nothing when .agent has no commands subdirectory", async () => {
    const workspace = await tempWorkspace();
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result).toEqual({ commands: [], warnings: [] });
  });

  it("parses description and model from front matter", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(
      workspace,
      "review.md",
      [
        "---",
        "description: Review the current diff",
        "model: claude-haiku-4-5",
        "---",
        "Review the diff for bugs.",
        "",
        "$ARGUMENTS",
      ].join("\n"),
    );

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.warnings).toEqual([]);
    expect(result.commands).toEqual([
      {
        name: "review",
        description: "Review the current diff",
        model: "claude-haiku-4-5",
        template: "Review the diff for bugs.\n\n$ARGUMENTS",
        sourcePath: ".agent/commands/review.md",
      } satisfies CustomCommand,
    ]);
  });

  it("treats a file with no front matter as a bare template", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(workspace, "ping.md", "Say pong back.\n");

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.warnings).toEqual([]);
    expect(result.commands).toEqual([
      {
        name: "ping",
        template: "Say pong back.",
        sourcePath: ".agent/commands/ping.md",
      },
    ]);
  });

  it("parses and silently drops the reserved `agent` key", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(
      workspace,
      "delegate.md",
      ["---", "agent: reviewer", "---", "Do the thing."].join("\n"),
    );

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.warnings).toEqual([]);
    expect(result.commands).toEqual([
      {
        name: "delegate",
        template: "Do the thing.",
        sourcePath: ".agent/commands/delegate.md",
      },
    ]);
  });

  it("skips a file with unparseable front matter YAML and warns", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(
      workspace,
      "broken.md",
      ["---", "description: [unterminated", "---", "body"].join("\n"),
    );

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.commands).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(".agent/commands/broken.md");
    expect(result.warnings[0]).toContain("front matter YAML parse error");
  });

  it("skips a file whose name is not a valid command name and warns", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(workspace, "Review.md", "body");
    await writeCommand(workspace, "1abc.md", "body");
    await writeCommand(workspace, "ok-one.md", "body");

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.commands.map((c) => c.name)).toEqual(["ok-one"]);
    expect(result.warnings).toHaveLength(2);
    for (const warning of result.warnings) {
      expect(warning).toContain("not a valid command name");
    }
  });

  it("skips a file whose name collides with a built-in, built-in wins", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(workspace, "help.md", "custom help override");
    await writeCommand(workspace, "review.md", "Review please.");

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.commands.map((c) => c.name)).toEqual(["review"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("/help");
    expect(result.warnings[0]).toContain("built-in");
  });

  it("loads every valid file, sorted by filename", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(workspace, "zeta.md", "z");
    await writeCommand(workspace, "alpha.md", "a");

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.commands.map((c) => c.name)).toEqual(["alpha", "zeta"]);
  });

  it("ignores non-markdown files in the commands directory", async () => {
    const workspace = await tempWorkspace();
    await writeCommand(workspace, "review.md", "Review please.");
    await mkdir(path.join(workspace, ".agent", "commands"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, ".agent", "commands", "notes.txt"),
      "not a command",
      "utf8",
    );

    const result = await loadCustomCommands(workspace, BUILTIN_NAMES);
    expect(result.commands.map((c) => c.name)).toEqual(["review"]);
  });
});

describe("expandCustomCommand", () => {
  const base: CustomCommand = {
    name: "review",
    template: "Review the diff.",
    sourcePath: ".agent/commands/review.md",
  };

  it("appends the arguments after two newlines when there is no placeholder", () => {
    expect(expandCustomCommand(base, "focus on auth.js")).toBe(
      "Review the diff.\n\nfocus on auth.js",
    );
  });

  it("leaves the template untouched when there are no arguments and no placeholder", () => {
    expect(expandCustomCommand(base, "")).toBe("Review the diff.");
  });

  it("substitutes $ARGUMENTS wherever it appears", () => {
    const withPlaceholder: CustomCommand = {
      ...base,
      template: "Review $ARGUMENTS for bugs. Focus: $ARGUMENTS",
    };
    expect(expandCustomCommand(withPlaceholder, "auth.js")).toBe(
      "Review auth.js for bugs. Focus: auth.js",
    );
  });

  it("substitutes $ARGUMENTS with an empty string when there are no arguments", () => {
    const withPlaceholder: CustomCommand = {
      ...base,
      template: "Review the diff. $ARGUMENTS",
    };
    expect(expandCustomCommand(withPlaceholder, "")).toBe("Review the diff. ");
  });
});
