import { describe, expect, it } from "vitest";
import { loadAgentProject } from "../../src/project/index.js";
import {
  cleanupWorkspace,
  copyTemplateAgentDir,
  makeWorkspace,
} from "./test-helpers.js";

describe("loadAgentProject - templates/default/.agent fixture", () => {
  it("loads the repo template end to end", async () => {
    const workspacePath = await makeWorkspace();
    try {
      const agentDir = await copyTemplateAgentDir(workspacePath);
      const project = await loadAgentProject(workspacePath);

      expect(project).toBeDefined();
      if (!project) throw new Error("unreachable");

      expect(project.root).toBe(agentDir);
      expect(project.agents).toHaveLength(6);

      const names = project.agents.map((agent) => agent.name).sort();
      expect(names).toEqual([
        "coder",
        "explorer",
        "junior",
        "lead",
        "reviewer",
        "senior",
      ]);

      expect(project.knownAgentNames()).toEqual(
        new Set(["coder", "explorer", "junior", "lead", "reviewer", "senior"]),
      );

      const lead = project.agent("lead");
      expect(lead).toBeDefined();
      expect(lead?.role).toBe("orchestrator");
      expect(lead?.modelAlias).toBe("lead");
      expect(lead?.tools).toEqual(["task.*", "worker.*", "result.*", "plan.*"]);
      expect(lead?.systemPrompt).toContain("Act as the engineering lead.");

      const explorer = project.agent("explorer");
      expect(explorer?.role).toBe("worker");
      expect(explorer?.modelAlias).toBe("cheap");
      expect(explorer?.tools).toEqual(["read", "grep", "glob", "git.diff"]);

      // The three implementation tiers: senior/coder/junior differ only in
      // which model alias they draw on.
      const implementationTools = [
        "read",
        "grep",
        "glob",
        "edit",
        "write",
        "bash",
        "git.*",
      ];
      const senior = project.agent("senior");
      expect(senior?.role).toBe("worker");
      expect(senior?.modelAlias).toBe("complex");
      expect(senior?.tools).toEqual(implementationTools);

      expect(project.agent("coder")?.modelAlias).toBe("worker");
      expect(project.agent("coder")?.tools).toEqual(implementationTools);

      const junior = project.agent("junior");
      expect(junior?.role).toBe("worker");
      expect(junior?.modelAlias).toBe("cheap");
      expect(junior?.tools).toEqual(implementationTools);

      // Slots in config.yaml resolve to existing agents.
      expect(project.config.agentSlots).toEqual({
        orchestrator: "lead",
        defaultWorker: "coder",
        explorer: "explorer",
        reviewer: "reviewer",
      });

      // Models declared in config.yaml.
      expect(project.config.models.lead).toEqual({
        provider: "anthropic",
        model: "claude-opus-5",
      });
      expect(project.config.models.complex).toEqual({
        provider: "anthropic",
        model: "claude-opus-5",
      });
      expect(project.config.models.reviewer).toEqual({
        provider: "openai",
        model: "gpt-5.1",
      });

      // The template documents `validation:` as comments only, so the shipped
      // default still configures no validators.
      expect(project.config.validators).toEqual([]);

      expect(project.orchestrationMarkdown).toBeDefined();
      expect(project.orchestrationMarkdown).toContain("Orchestration Policy");
      expect(project.orchestrationMarkdown).toContain(
        "Use `explorer` for inexpensive read-only repository exploration.",
      );
      expect(project.orchestrationMarkdown).toContain(
        "Use `senior` for complex or architectural implementation work.",
      );
      expect(project.orchestrationMarkdown).toContain(
        "Use `junior` for trivial single-function changes.",
      );

      expect(project.agent("nonexistent")).toBeUndefined();
    } finally {
      await cleanupWorkspace(workspacePath);
    }
  });
});
