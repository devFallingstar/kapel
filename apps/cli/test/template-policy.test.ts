import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  isCanonicalPolicySource,
  parsePolicyMarkdown,
  renderPolicyMarkdown,
  validatePolicy,
} from "@agent/coding-agent";
import { describe, expect, it } from "vitest";

/**
 * The shipped `.agent/` template has to stay readable without a model.
 *
 * This is the test that makes "a new project sets itself up for free" a
 * promise rather than a hope: `kapel init` copies this file verbatim, and the
 * compile that follows only skips the model call because the file parses. An
 * edit here that slips out of the canonical form would put the model call
 * back for every new project, silently — so it fails here instead.
 */
const TEMPLATE_AGENT_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "templates",
  "default",
  ".agent",
);

async function templatePolicySource(): Promise<string> {
  return await readFile(
    path.join(TEMPLATE_AGENT_DIR, "orchestration.md"),
    "utf8",
  );
}

/** The agent names `.agent/agents/*.md` defines, by filename. */
async function templateAgentNames(): Promise<ReadonlySet<string>> {
  const entries = await readdir(path.join(TEMPLATE_AGENT_DIR, "agents"));
  return new Set(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.slice(0, -".md".length)),
  );
}

describe("the shipped orchestration policy", () => {
  it("is canonical, so a fresh project compiles with no model call", async () => {
    const markdown = await templatePolicySource();
    expect(isCanonicalPolicySource(markdown)).toBe(true);

    const outcome = parsePolicyMarkdown(markdown);
    if (!("policy" in outcome)) {
      throw new Error(
        `${outcome.failure.reason}: ${outcome.failure.message}` +
          (outcome.failure.line === undefined
            ? ""
            : ` (line ${outcome.failure.line})`),
      );
    }
    expect(outcome.policy.orchestrator).toBe("lead");
  });

  it("only names agents the template actually ships", async () => {
    const outcome = parsePolicyMarkdown(await templatePolicySource());
    if (!("policy" in outcome)) throw new Error("template does not parse");
    expect(validatePolicy(outcome.policy, await templateAgentNames())).toEqual(
      [],
    );
  });

  it("is byte-identical to what the renderer would write for it", async () => {
    // Which is what lets `kapel policy edit` rewrite this file in place
    // without reformatting everything around the one line it changed.
    const markdown = await templatePolicySource();
    const outcome = parsePolicyMarkdown(markdown);
    if (!("policy" in outcome)) throw new Error("template does not parse");
    expect(renderPolicyMarkdown(outcome.policy)).toBe(markdown);
  });
});
