import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAgentProject,
  parseHandoffMarkdown,
} from "../../src/project/index.js";
import { DEFAULT_HANDOFF } from "../../src/workers/briefing.js";
import {
  cleanupWorkspace,
  copyTemplateAgentDir,
  makeWorkspace,
  writeAgentFile,
} from "./test-helpers.js";

const FULL = `# Ignored preamble

Prose above the first section is a comment.

## common

Be brief.

## worker

Work in the worktree.

## reviewer

Look for missing tests.
`;

/** Loads `.agent/handoff.md` written from `content` in a throwaway workspace. */
async function loadHandoff(content: string) {
  const workspacePath = await makeWorkspace();
  try {
    await writeAgentFile(workspacePath, "handoff.md", content);
    const project = await loadAgentProject(workspacePath);
    expect(project).toBeDefined();
    return project?.handoff;
  } finally {
    await cleanupWorkspace(workspacePath);
  }
}

describe("parseHandoffMarkdown", () => {
  const parse = (raw: string) => parseHandoffMarkdown("/p/handoff.md", raw);

  it("reads the three sections and ignores the preamble", () => {
    const handoff = parse(FULL);
    expect(handoff.common).toBe("Be brief.");
    expect(handoff.worker).toBe("Work in the worktree.");
    expect(handoff.reviewer).toBe("Look for missing tests.");
    expect(handoff.warnings).toEqual([]);
    expect(handoff.sourcePath).toBe("/p/handoff.md");
  });

  it("leaves an absent section undefined so it can fall back to the default", () => {
    const handoff = parse("## worker\n\nJust this one.\n");
    expect(handoff.worker).toBe("Just this one.");
    expect(handoff.common).toBeUndefined();
    expect(handoff.reviewer).toBeUndefined();
  });

  it("distinguishes a present-but-empty section from an absent one", () => {
    const handoff = parse("## common\n\n\n## reviewer\n   \n");
    // Present and blank: a deliberate "say nothing", not a fallback.
    expect(handoff.common).toBe("");
    expect(handoff.reviewer).toBe("");
    expect(handoff.worker).toBeUndefined();
  });

  it("keeps headings inside a section as guidance text", () => {
    // The built-in `## common` opens with `## Execution context`, so a section
    // has to be able to carry its own headings without being split at them.
    const handoff = parse(
      "## common\n\n## Execution context\n\nYou are headless.\n\n## worker\n\nGo.\n",
    );
    expect(handoff.common).toBe("## Execution context\n\nYou are headless.");
    expect(handoff.worker).toBe("Go.");
    expect(handoff.warnings).toEqual([]);
  });

  it("does not split at a deeper heading level", () => {
    const handoff = parse("## worker\n\nDo it.\n\n### Notes\n\nCarefully.\n");
    expect(handoff.worker).toBe("Do it.\n\n### Notes\n\nCarefully.");
  });

  it("warns about an unrecognised heading outside any section and ignores it", () => {
    const handoff = parse("## reviwer\n\nTypo.\n");
    expect(handoff.reviewer).toBeUndefined();
    expect(handoff.warnings).toEqual([
      '/p/handoff.md: ignoring unknown section "## reviwer" (expected one of common, worker, reviewer)',
    ]);
  });

  it("keeps the first of a repeated section and warns", () => {
    const handoff = parse("## worker\n\nFirst.\n\n## worker\n\nSecond.\n");
    expect(handoff.worker).toBe("First.");
    expect(handoff.warnings).toEqual([
      '/p/handoff.md: ignoring a repeated "## worker" section — the first one wins',
    ]);
  });

  it("matches headings case-insensitively and tolerates trailing space", () => {
    const handoff = parse("##   Worker  \n\nUp top.\n");
    expect(handoff.worker).toBe("Up top.");
    expect(handoff.warnings).toEqual([]);
  });

  it("parses a file with CRLF line endings", () => {
    const handoff = parse("## worker\r\n\r\nOne.\r\nTwo.\r\n");
    expect(handoff.worker).toBe("One.\nTwo.");
  });

  it("reads nothing out of a file with no sections at all", () => {
    const handoff = parse("Just some notes.\n");
    expect(handoff.common).toBeUndefined();
    expect(handoff.worker).toBeUndefined();
    expect(handoff.reviewer).toBeUndefined();
    expect(handoff.warnings).toEqual([]);
  });
});

describe("loadAgentProject - handoff.md", () => {
  it("leaves handoff undefined when the file is absent", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(workspacePath, "config.yaml", "models: {}\n");
      const project = await loadAgentProject(workspacePath);
      expect(project?.handoff).toBeUndefined();
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("exposes the parsed sections on the project", async () => {
    const handoff = await loadHandoff(FULL);
    expect(handoff?.common).toBe("Be brief.");
    expect(handoff?.worker).toBe("Work in the worktree.");
    expect(handoff?.reviewer).toBe("Look for missing tests.");
  });

  it("reports a bad heading as a warning rather than failing the load", async () => {
    const handoff = await loadHandoff("## nonsense\n\nHi.\n");
    expect(handoff?.warnings.join("\n")).toMatch(/unknown section/);
    expect(handoff?.sourcePath).toMatch(/handoff\.md$/);
  });

  it("records the source path of the file it read", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(workspacePath, "handoff.md", "## worker\n\nGo.\n");
      const project = await loadAgentProject(workspacePath);
      expect(project?.handoff?.sourcePath).toBe(
        join(workspacePath, ".agent", "handoff.md"),
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});

describe("templates/default/.agent/handoff.md", () => {
  it("round-trips through the loader to exactly the built-in defaults", async () => {
    // Drift guard: the template is documentation *and* the shipped default, so
    // an edit to either side that the other does not follow must fail here
    // rather than silently changing what every worker is told.
    const workspacePath = await makeWorkspace();
    try {
      await copyTemplateAgentDir(workspacePath);
      const project = await loadAgentProject(workspacePath);
      const handoff = project?.handoff;

      expect(handoff).toBeDefined();
      expect(handoff?.warnings).toEqual([]);
      expect({
        common: handoff?.common,
        worker: handoff?.worker,
        reviewer: handoff?.reviewer,
      }).toEqual(DEFAULT_HANDOFF);
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});
