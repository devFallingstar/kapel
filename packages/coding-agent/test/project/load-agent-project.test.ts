import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findAgentDir,
  loadAgentProject,
  ProjectConfigError,
} from "../../src/project/index.js";
import {
  cleanupWorkspace,
  makeWorkspace,
  writeAgentFile,
} from "./test-helpers.js";

const VALID_CONFIG = `
models:
  m1:
    provider: openai
    model: gpt-test
agents:
  orchestrator: lead
`;

function agentMd(opts: {
  name: string;
  model?: string;
  role?: string;
  tools?: string[];
  body?: string;
}): string {
  const {
    name,
    model = "m1",
    role = "worker",
    tools = ["read"],
    body = "Do the thing.",
  } = opts;
  const toolsYaml = tools.map((tool) => `  - ${tool}`).join("\n");
  return `---\nname: ${name}\nmodel: ${model}\nrole: ${role}\ntools:\n${toolsYaml}\n---\n\n${body}\n`;
}

describe("findAgentDir", () => {
  it("returns undefined when .agent does not exist", async () => {
    const workspacePath = await makeWorkspace();
    try {
      expect(await findAgentDir(workspacePath)).toBeUndefined();
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("returns the .agent path when it exists as a directory", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await mkdir(join(workspacePath, ".agent"));
      expect(await findAgentDir(workspacePath)).toBe(
        join(workspacePath, ".agent"),
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});

describe("loadAgentProject - structural cases", () => {
  it("returns undefined when .agent does not exist", async () => {
    const workspacePath = await makeWorkspace();
    try {
      expect(await loadAgentProject(workspacePath)).toBeUndefined();
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("loads an empty .agent directory as an empty project", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await mkdir(join(workspacePath, ".agent"));
      const project = await loadAgentProject(workspacePath);
      expect(project).toBeDefined();
      expect(project?.config).toEqual({
        models: {},
        agentSlots: {},
        validators: [],
        permission: {},
      });
      expect(project?.agents).toEqual([]);
      expect(project?.orchestrationMarkdown).toBeUndefined();
      expect(project?.knownAgentNames()).toEqual(new Set());
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("treats a missing config.yaml as an empty config and skips the model-alias check", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "agents/solo.md",
        agentMd({ name: "solo", model: "whatever-unregistered" }),
      );
      const project = await loadAgentProject(workspacePath);
      expect(project).toBeDefined();
      expect(project?.config.models).toEqual({});
      expect(project?.agents).toHaveLength(1);
      expect(project?.agent("solo")?.modelAlias).toBe("whatever-unregistered");
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});

describe("loadAgentProject - config.yaml errors", () => {
  it("throws ProjectConfigError with the file and problems for malformed YAML", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "config.yaml",
        "models: [\n  broken\n",
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      const configErr = err as ProjectConfigError;
      expect(configErr.file).toBe(join(workspacePath, ".agent", "config.yaml"));
      expect(configErr.problems.length).toBeGreaterThan(0);
      expect(configErr.problems[0]).toMatch(/YAML parse error/);
      expect(configErr.message).toContain(configErr.file);
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("throws ProjectConfigError when config.yaml has the wrong shape", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "config.yaml",
        "models:\n  m1:\n    provider: openai\nagents: not-a-map\n",
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      const problems = (err as ProjectConfigError).problems.join("\n");
      // Missing `model` under models.m1, and `agents` is not a map: both collected.
      expect(problems).toMatch(/models\.m1\.model/);
      expect(problems).toMatch(/agents/);
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("rejects unknown top-level keys in config.yaml", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "config.yaml",
        "models: {}\nagents: {}\nbogus: true\n",
      );
      await expect(loadAgentProject(workspacePath)).rejects.toBeInstanceOf(
        ProjectConfigError,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});

describe("loadAgentProject - agents/*.md errors", () => {
  it("reports a missing front matter block", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "agents/broken.md",
        "# Just a heading\n\nNo front matter here.\n",
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      expect((err as ProjectConfigError).problems.join("\n")).toMatch(
        /missing YAML front matter/,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("reports front matter missing required keys", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "agents/incomplete.md",
        "---\nname: incomplete\n---\n\nBody.\n",
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      const problems = (err as ProjectConfigError).problems.join("\n");
      expect(problems).toMatch(/model/);
      expect(problems).toMatch(/role/);
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("reports a name/filename mismatch", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "agents/foo.md",
        agentMd({ name: "bar" }),
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      expect((err as ProjectConfigError).problems.join("\n")).toMatch(
        /name "bar" does not match filename "foo"/,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("reports duplicate agent names across files", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "agents/dup.md",
        agentMd({ name: "dup" }),
      );
      await writeAgentFile(
        workspacePath,
        "agents/dup2.md",
        agentMd({ name: "dup" }),
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      expect((err as ProjectConfigError).problems.join("\n")).toMatch(
        /duplicate agent name "dup"/,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("reports an unknown role", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "agents/manager.md",
        agentMd({ name: "manager", role: "manager" }),
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      expect((err as ProjectConfigError).problems.join("\n")).toMatch(
        /unknown role "manager"/,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("aggregates problems across multiple broken files instead of stopping at the first", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "agents/nofm.md",
        "no front matter\n",
      );
      await writeAgentFile(
        workspacePath,
        "agents/badrole.md",
        agentMd({ name: "badrole", role: "manager" }),
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      const problems = (err as ProjectConfigError).problems;
      expect(
        problems.some((p) => p.includes("missing YAML front matter")),
      ).toBe(true);
      expect(problems.some((p) => p.includes('unknown role "manager"'))).toBe(
        true,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});

describe("loadAgentProject - cross-reference validation", () => {
  it("reports a dangling agent-slot reference in config.yaml", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "config.yaml",
        "agents:\n  orchestrator: ghost\n",
      );
      await writeAgentFile(
        workspacePath,
        "agents/lead.md",
        agentMd({ name: "lead", role: "orchestrator" }),
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      expect((err as ProjectConfigError).problems.join("\n")).toMatch(
        /agents\.orchestrator references unknown agent "ghost"/,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("reports a model alias not present in a non-empty models map", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(
        workspacePath,
        "config.yaml",
        "models:\n  known:\n    provider: openai\n    model: gpt-x\n",
      );
      await writeAgentFile(
        workspacePath,
        "agents/lead.md",
        agentMd({ name: "lead", role: "orchestrator", model: "unregistered" }),
      );
      const err = await loadAgentProject(workspacePath).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectConfigError);
      expect((err as ProjectConfigError).problems.join("\n")).toMatch(
        /model alias "unregistered" is not defined/,
      );
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("skips the model-alias check when config.models is explicitly empty", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(workspacePath, "config.yaml", "models: {}\n");
      await writeAgentFile(
        workspacePath,
        "agents/lead.md",
        agentMd({ name: "lead", role: "orchestrator", model: "anything" }),
      );
      const project = await loadAgentProject(workspacePath);
      expect(project).toBeDefined();
      expect(project?.agent("lead")?.modelAlias).toBe("anything");
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });

  it("passes when every model alias and agent slot resolves", async () => {
    const workspacePath = await makeWorkspace();
    try {
      await writeAgentFile(workspacePath, "config.yaml", VALID_CONFIG);
      await writeAgentFile(
        workspacePath,
        "agents/lead.md",
        agentMd({ name: "lead", role: "orchestrator", model: "m1" }),
      );
      const project = await loadAgentProject(workspacePath);
      expect(project).toBeDefined();
      expect(project?.agent("lead")).toBeDefined();
      expect(project?.config.agentSlots).toEqual({ orchestrator: "lead" });
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});

describe("loadAgentProject - CRLF handling", () => {
  it("parses an agent file with CRLF line endings", async () => {
    const workspacePath = await makeWorkspace();
    try {
      const crlf =
        "---\r\nname: crlfagent\r\nmodel: m1\r\nrole: worker\r\ntools:\r\n  - read\r\n---\r\n\r\nLine one.\r\nLine two.\r\n";
      await writeAgentFile(workspacePath, "agents/crlfagent.md", crlf);
      const project = await loadAgentProject(workspacePath);
      expect(project).toBeDefined();
      const agent = project?.agent("crlfagent");
      expect(agent).toBeDefined();
      expect(agent?.modelAlias).toBe("m1");
      expect(agent?.role).toBe("worker");
      expect(agent?.tools).toEqual(["read"]);
      expect(agent?.systemPrompt).toBe("Line one.\nLine two.");
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});
