import type { AskOutcome } from "@agent/core";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_FOR_SESSION,
  type BashPermissionRules,
  bashCommandPrefix,
  DECLINED_WITH_FEEDBACK,
  DENIED_BY_POLICY,
  DENIED_BY_PROMPTER,
  describeSessionRule,
  matchBashPermission,
  NO_PROMPTER_AVAILABLE,
  PermissionEngine,
  type PermissionPrompter,
  type PermissionRequest,
  SessionAllowlist,
  sessionRuleFor,
} from "../src/permissions.js";

function request(tool: string, input: unknown = { a: 1 }): PermissionRequest {
  return { tool, input, agent: "coder" };
}

function bash(command: string): PermissionRequest {
  return request("bash", { command });
}

class RecordingPrompter implements PermissionPrompter {
  readonly seen: PermissionRequest[] = [];

  constructor(private readonly answer: boolean) {}

  async ask(req: PermissionRequest): Promise<boolean> {
    this.seen.push(req);
    return this.answer;
  }
}

describe("PermissionEngine.decisionFor", () => {
  it("resolves exact tool-name rules", () => {
    const engine = new PermissionEngine({
      read: "allow",
      bash: "deny",
      write: "ask",
    });

    expect(engine.decisionFor("read")).toBe("allow");
    expect(engine.decisionFor("bash")).toBe("deny");
    expect(engine.decisionFor("write")).toBe("ask");
  });

  it("falls back to 'ask' when no default decision is configured", () => {
    const engine = new PermissionEngine({ read: "allow" });
    expect(engine.decisionFor("unlisted")).toBe("ask");
  });

  it("falls back to the configured default decision", () => {
    const engine = new PermissionEngine(
      { read: "allow" },
      { defaultDecision: "deny" },
    );
    expect(engine.decisionFor("unlisted")).toBe("deny");
    expect(engine.decisionFor("read")).toBe("allow");
  });

  it("does not match prefixes, suffixes or inherited object keys", () => {
    const engine = new PermissionEngine(
      { bash: "allow" },
      { defaultDecision: "deny" },
    );

    expect(engine.decisionFor("bash.run")).toBe("deny");
    expect(engine.decisionFor("ba")).toBe("deny");
    expect(engine.decisionFor("toString")).toBe("deny");
    expect(engine.decisionFor("constructor")).toBe("deny");
  });

  it("is unaffected by later mutation of the rules object", () => {
    const rules: Record<string, "allow" | "ask" | "deny"> = { read: "allow" };
    const engine = new PermissionEngine(rules);
    rules.read = "deny";
    expect(engine.decisionFor("read")).toBe("allow");
  });
});

describe("PermissionEngine.authorize", () => {
  it("allows tools with an allow rule without consulting the prompter", async () => {
    const prompter = new RecordingPrompter(false);
    const engine = new PermissionEngine({ read: "allow" }, { prompter });

    const result = await engine.authorize(request("read"));

    expect(result).toEqual({ allowed: true, decision: "allow" });
    expect(result.reason).toBeUndefined();
    expect(prompter.seen).toHaveLength(0);
  });

  it("denies tools with a deny rule with reason 'denied by policy'", async () => {
    const prompter = new RecordingPrompter(true);
    const engine = new PermissionEngine({ bash: "deny" }, { prompter });

    const result = await engine.authorize(request("bash"));

    expect(result).toEqual({
      allowed: false,
      decision: "deny",
      reason: DENIED_BY_POLICY,
    });
    expect(DENIED_BY_POLICY).toBe("denied by policy");
    expect(prompter.seen).toHaveLength(0);
  });

  it("denies 'ask' tools when no prompter is available", async () => {
    const engine = new PermissionEngine({ write: "ask" });

    const result = await engine.authorize(request("write"));

    expect(result).toEqual({
      allowed: false,
      decision: "ask",
      reason: NO_PROMPTER_AVAILABLE,
    });
    expect(NO_PROMPTER_AVAILABLE).toBe(
      "no prompter available in non-interactive mode",
    );
  });

  it("allows an 'ask' tool when the prompter approves, forwarding the full request", async () => {
    const prompter = new RecordingPrompter(true);
    const engine = new PermissionEngine({ write: "ask" }, { prompter });

    const result = await engine.authorize(request("write", { path: "a.txt" }));

    expect(result).toEqual({ allowed: true, decision: "ask" });
    expect(prompter.seen).toEqual([
      { tool: "write", input: { path: "a.txt" }, agent: "coder" },
    ]);
  });

  it("denies an 'ask' tool when the prompter refuses", async () => {
    const prompter = new RecordingPrompter(false);
    const engine = new PermissionEngine({ write: "ask" }, { prompter });

    const result = await engine.authorize(request("write"));

    expect(result).toEqual({
      allowed: false,
      decision: "ask",
      reason: DENIED_BY_PROMPTER,
    });
    expect(prompter.seen).toHaveLength(1);
  });

  it("routes unlisted tools through the default decision", async () => {
    const prompter = new RecordingPrompter(true);
    const allowByDefault = new PermissionEngine(
      {},
      { defaultDecision: "allow", prompter },
    );
    const denyByDefault = new PermissionEngine(
      {},
      { defaultDecision: "deny", prompter },
    );
    const askByDefault = new PermissionEngine({}, { prompter });

    expect(await allowByDefault.authorize(request("glob"))).toEqual({
      allowed: true,
      decision: "allow",
    });
    expect(await denyByDefault.authorize(request("glob"))).toEqual({
      allowed: false,
      decision: "deny",
      reason: DENIED_BY_POLICY,
    });
    expect(await askByDefault.authorize(request("glob"))).toEqual({
      allowed: true,
      decision: "ask",
    });
  });
});

// --- bashCommandPrefix --------------------------------------------------------

describe("bashCommandPrefix", () => {
  const cases: ReadonlyArray<[string, string | undefined]> = [
    ["npm test", "npm test"],
    ["npm test --run foo", "npm test"],
    ["npm --silent test", "npm test"],
    ["  npm   test  ", "npm test"],
    ["npm publish", "npm publish"],
    ["npm testfoo", "npm testfoo"],
    ["npm", "npm"],
    ["npm run build", "npm run"],
    ["npm run test:unit", "npm run"],
    ["git log --oneline", "git log"],
    // The first non-flag token is `.`, which is not subcommand-shaped, so the
    // head stands alone rather than guessing past it.
    ["git -C . log", "git"],
    ["ls", "ls"],
    ["ls -la", "ls"],
    ["cat src/x.ts", "cat"],
    ["cat notes.txt", "cat"],
    ["rm -rf build/", "rm"],
    ["./scripts/check.sh run", "./scripts/check.sh run"],
    ["", undefined],
    ["   ", undefined],
    ["-x", undefined],
    ["npm test && rm -rf .", undefined],
    ["npm test | head", undefined],
    ["npm test; ls", undefined],
    ["echo $(whoami)", undefined],
    ["echo hi > out.txt", undefined],
    ["npm test\nls", undefined],
  ];

  for (const [command, expected] of cases) {
    it(`${JSON.stringify(command)} -> ${String(expected)}`, () => {
      expect(bashCommandPrefix(command)).toBe(expected);
    });
  }
});

// --- sessionRuleFor / SessionAllowlist ----------------------------------------

describe("sessionRuleFor", () => {
  it("derives a command prefix for bash", () => {
    expect(sessionRuleFor(bash("npm test --run foo"))).toEqual({
      kind: "bash-prefix",
      prefix: "npm test",
    });
  });

  it("derives nothing for a compound bash command", () => {
    expect(sessionRuleFor(bash("npm test && ls"))).toBeUndefined();
  });

  it("derives nothing for a bash input with no command string", () => {
    expect(sessionRuleFor(request("bash", { timeoutMs: 5 }))).toBeUndefined();
  });

  it("derives the tool name for everything else", () => {
    expect(sessionRuleFor(request("edit_file"))).toEqual({
      kind: "tool",
      tool: "edit_file",
    });
  });

  it("describes rules for humans", () => {
    expect(describeSessionRule({ kind: "tool", tool: "edit_file" })).toBe(
      "edit_file",
    );
    expect(
      describeSessionRule({ kind: "bash-prefix", prefix: "npm test" }),
    ).toBe("bash npm test \u2026");
  });
});

describe("SessionAllowlist", () => {
  it("allows nothing until something is remembered", () => {
    expect(new SessionAllowlist().allows(bash("npm test"))).toBe(false);
  });

  it("matches later commands with the same derived prefix", () => {
    const list = new SessionAllowlist();
    list.remember(bash("npm test --run foo"));
    expect(list.allows(bash("npm test"))).toBe(true);
    expect(list.allows(bash("npm test -w pkg --bail"))).toBe(true);
    expect(list.allows(bash("npm publish"))).toBe(false);
    expect(list.allows(bash("npm testfoo"))).toBe(false);
  });

  it("never matches a compound command, even under a remembered prefix", () => {
    const list = new SessionAllowlist();
    list.remember(bash("npm test"));
    expect(list.allows(bash("npm test && curl example.com"))).toBe(false);
  });

  it("remembers non-bash tools by name, for any input", () => {
    const list = new SessionAllowlist();
    list.remember(request("edit_file", { path: "a.ts" }));
    expect(
      list.allows(request("edit_file", { path: "totally-other.ts" })),
    ).toBe(true);
    expect(list.allows(request("write_file", { path: "a.ts" }))).toBe(false);
  });

  it("reports nothing remembered for a command it cannot generalise", () => {
    const list = new SessionAllowlist();
    expect(list.remember(bash("a && b"))).toBeUndefined();
    expect(list.entries()).toEqual([]);
  });

  it("lists what it has learned", () => {
    const list = new SessionAllowlist();
    list.remember(request("edit_file"));
    list.remember(bash("git log --oneline"));
    expect(list.entries()).toEqual(["edit_file", "bash git log \u2026"]);
  });
});

// --- PermissionEngine + a prompter that answers with words --------------------

/** A prompter that refuses and says something, the way a typed answer does. */
class SpeakingPrompter implements PermissionPrompter {
  readonly seen: PermissionRequest[] = [];

  constructor(private readonly outcome: AskOutcome) {}

  async ask(req: PermissionRequest): Promise<AskOutcome> {
    this.seen.push(req);
    return this.outcome;
  }
}

describe("PermissionEngine with a prompter that answers in prose", () => {
  it("denies the call and carries the user's words on the verdict", async () => {
    const prompter = new SpeakingPrompter({
      allowed: false,
      feedback: "왜 이 파일을 지우려는 거야?",
    });
    const engine = new PermissionEngine({ bash: "ask" }, { prompter });

    expect(await engine.authorize(bash("rm -rf build"))).toEqual({
      allowed: false,
      decision: "ask",
      reason: DECLINED_WITH_FEEDBACK,
      feedback: "왜 이 파일을 지우려는 거야?",
    });
  });

  it("trims the feedback", async () => {
    const prompter = new SpeakingPrompter({
      allowed: false,
      feedback: "  use the config file instead\n",
    });
    const engine = new PermissionEngine({ write: "ask" }, { prompter });

    const verdict = await engine.authorize(request("write"));
    expect(verdict.feedback).toBe("use the config file instead");
  });

  it("treats a blank or absent message as the plain refusal it is", async () => {
    for (const feedback of [undefined, "", "   "]) {
      const engine = new PermissionEngine(
        { write: "ask" },
        { prompter: new SpeakingPrompter({ allowed: false, feedback }) },
      );
      expect(await engine.authorize(request("write"))).toEqual({
        allowed: false,
        decision: "ask",
        reason: DENIED_BY_PROMPTER,
      });
    }
  });

  it("accepts the outcome shape for an approval too", async () => {
    const engine = new PermissionEngine(
      { write: "ask" },
      { prompter: new SpeakingPrompter({ allowed: true }) },
    );
    expect(await engine.authorize(request("write"))).toEqual({
      allowed: true,
      decision: "ask",
    });
  });

  it("leaves the session overlay untouched — nothing is remembered", async () => {
    const overlay = new SessionAllowlist();
    const prompter = new SpeakingPrompter({
      allowed: false,
      feedback: "run the tests first",
    });
    const engine = new PermissionEngine({ bash: "ask" }, { prompter, overlay });

    await engine.authorize(bash("npm publish"));
    expect(overlay.entries()).toEqual([]);
    expect(overlay.allows(bash("npm publish"))).toBe(false);

    // And the next identical call is asked about all over again.
    await engine.authorize(bash("npm publish"));
    expect(prompter.seen).toHaveLength(2);
  });
});

// --- PermissionEngine + session overlay ---------------------------------------

describe("PermissionEngine with a session overlay", () => {
  it("does not prompt a second time for a remembered command prefix", async () => {
    const prompter = new RecordingPrompter(true);
    const overlay = new SessionAllowlist();
    const engine = new PermissionEngine({ bash: "ask" }, { prompter, overlay });

    const first = await engine.authorize(bash("npm test --run foo"));
    expect(first.allowed).toBe(true);
    expect(prompter.seen).toHaveLength(1);

    // What the CLI prompter does on an "a" answer.
    overlay.remember(bash("npm test --run foo"));

    const second = await engine.authorize(bash("npm test --run bar"));
    expect(second.allowed).toBe(true);
    expect(second.reason).toBe(ALLOWED_FOR_SESSION);
    expect(prompter.seen).toHaveLength(1);
  });

  it("still prompts for a command outside the remembered prefix", async () => {
    const prompter = new RecordingPrompter(true);
    const overlay = new SessionAllowlist();
    overlay.remember(bash("npm test"));
    const engine = new PermissionEngine({ bash: "ask" }, { prompter, overlay });

    await engine.authorize(bash("npm publish"));
    expect(prompter.seen).toHaveLength(1);
  });

  it("never overrides an explicit deny rule", async () => {
    const prompter = new RecordingPrompter(true);
    const overlay = new SessionAllowlist();
    overlay.remember(bash("npm test"));
    const engine = new PermissionEngine(
      { bash: "deny" },
      { prompter, overlay },
    );

    const verdict = await engine.authorize(bash("npm test"));
    expect(verdict).toEqual({
      allowed: false,
      decision: "deny",
      reason: DENIED_BY_POLICY,
    });
    expect(prompter.seen).toHaveLength(0);
  });

  it("never overrides a deny that comes from the default decision", async () => {
    const overlay = new SessionAllowlist();
    overlay.remember(request("edit_file"));
    const engine = new PermissionEngine(
      {},
      { defaultDecision: "deny", overlay },
    );

    await expect(engine.authorize(request("edit_file"))).resolves.toEqual({
      allowed: false,
      decision: "deny",
      reason: DENIED_BY_POLICY,
    });
  });

  it("lets a remembered tool through with no prompter at all", async () => {
    const overlay = new SessionAllowlist();
    overlay.remember(request("edit_file"));
    const engine = new PermissionEngine({ edit_file: "ask" }, { overlay });

    await expect(engine.authorize(request("edit_file"))).resolves.toEqual({
      allowed: true,
      decision: "ask",
      reason: ALLOWED_FOR_SESSION,
    });
  });

  it("leaves an allow rule alone", async () => {
    const engine = new PermissionEngine(
      { read: "allow" },
      { overlay: new SessionAllowlist() },
    );
    await expect(engine.authorize(request("read"))).resolves.toEqual({
      allowed: true,
      decision: "allow",
    });
  });
});

// --- P1-5: bash permission patterns --------------------------------------

describe("matchBashPermission", () => {
  const patterns: BashPermissionRules = {
    "*": "ask",
    "git *": "allow",
    "git log *": "deny",
    rm: "deny",
  };

  const cases: ReadonlyArray<
    [command: string, decision: "allow" | "ask" | "deny", pattern: string]
  > = [
    // "*" is the tool default: anything not matched more specifically.
    ["npm test", "ask", "*"],
    // "git *" — a head-only pattern — matches any git subcommand ...
    ["git status", "allow", "git *"],
    ["git commit -m x", "allow", "git *"],
    // ... including bare "git" with no subcommand at all.
    ["git", "allow", "git *"],
    // "git log *" is an exact 2-token prefix match, more specific than
    // "git *", so it outranks it for exactly "git log ...".
    ["git log --oneline", "deny", "git log *"],
    ["git log", "deny", "git log *"],
    // A bare, non-wildcard pattern ("rm") is an exact match against the
    // *derived* prefix, not the literal command string — "rm -rf build/"
    // derives to "rm" (see `bashCommandPrefix`, "build/" isn't
    // subcommand-shaped), so it matches "rm" too, same as bare "rm".
    ["rm", "deny", "rm"],
    ["rm -rf build/", "deny", "rm"],
  ];

  for (const [command, decision, pattern] of cases) {
    it(`${JSON.stringify(command)} -> ${pattern} (${decision})`, () => {
      expect(matchBashPermission(patterns, command)).toEqual({
        pattern,
        decision,
      });
    });
  }

  it("a bare pattern does not match a command with a real subcommand", () => {
    // "rm log" derives to "rm log" (a word with no "." or "/" reads as a
    // subcommand), which the bare "rm" pattern — an exact match — does not
    // cover; only the tool default answers it.
    expect(matchBashPermission(patterns, "rm log")).toEqual({
      pattern: "*",
      decision: "ask",
    });
  });

  it("longest exact prefix wins over a shorter one", () => {
    const rules: BashPermissionRules = {
      npm: "deny",
      "npm test": "allow",
    };
    expect(matchBashPermission(rules, "npm test --run x")).toEqual({
      pattern: "npm test",
      decision: "allow",
    });
  });

  it("deny beats allow at equal specificity, regardless of key order", () => {
    // "git log" and "git log *" both parse to the same two-token exact
    // prefix and so tie in specificity — the only way two *different*
    // pattern keys in one map can both match the same command.
    const denyFirst: BashPermissionRules = {
      "git log *": "deny",
      "git log": "allow",
    };
    const allowFirst: BashPermissionRules = {
      "git log": "allow",
      "git log *": "deny",
    };
    expect(matchBashPermission(denyFirst, "git log --oneline")).toEqual({
      pattern: "git log *",
      decision: "deny",
    });
    expect(matchBashPermission(allowFirst, "git log --oneline")).toEqual({
      pattern: "git log *",
      decision: "deny",
    });
  });

  it("a compound command matches only the tool-default '*' pattern", () => {
    expect(
      matchBashPermission(
        { "*": "ask", "git *": "allow" },
        "git log && rm -rf .",
      ),
    ).toEqual({ pattern: "*", decision: "ask" });
  });

  it("returns undefined when nothing matches and there is no '*' entry", () => {
    expect(
      matchBashPermission({ "git *": "allow" }, "npm test"),
    ).toBeUndefined();
    expect(
      matchBashPermission({ "git *": "allow" }, "git log && ls"),
    ).toBeUndefined();
  });

  it("treats a missing command the same as one with no derivable prefix", () => {
    expect(matchBashPermission({ "*": "deny" }, undefined)).toEqual({
      pattern: "*",
      decision: "deny",
    });
    expect(
      matchBashPermission({ "git *": "allow" }, undefined),
    ).toBeUndefined();
  });
});

describe("PermissionEngine with a bash pattern map", () => {
  it("resolves the matching pattern's verdict without a prompter", async () => {
    const prompter = new RecordingPrompter(false);
    const engine = new PermissionEngine(
      { bash: { "*": "ask", "git *": "allow", "rm *": "deny" } },
      { prompter },
    );

    await expect(engine.authorize(bash("git status"))).resolves.toEqual({
      allowed: true,
      decision: "allow",
    });
    await expect(engine.authorize(bash("rm -rf build/"))).resolves.toEqual({
      allowed: false,
      decision: "deny",
      reason: DENIED_BY_POLICY,
    });
    expect(prompter.seen).toHaveLength(0);
  });

  it("falls through to the prompter for an 'ask'-matched command", async () => {
    const prompter = new RecordingPrompter(true);
    const engine = new PermissionEngine(
      { bash: { "*": "ask", "git *": "allow" } },
      { prompter },
    );

    const result = await engine.authorize(bash("npm publish"));
    expect(result).toEqual({ allowed: true, decision: "ask" });
    expect(prompter.seen).toHaveLength(1);
  });

  it("a pattern-map deny can never be masked by the session allowlist", async () => {
    const overlay = new SessionAllowlist();
    overlay.remember(bash("rm -rf build/"));
    const prompter = new RecordingPrompter(true);
    const engine = new PermissionEngine(
      { bash: { "*": "ask", "rm *": "deny" } },
      { prompter, overlay },
    );

    const result = await engine.authorize(bash("rm -rf build/"));
    expect(result).toEqual({
      allowed: false,
      decision: "deny",
      reason: DENIED_BY_POLICY,
    });
    expect(prompter.seen).toHaveLength(0);
  });

  it("the session overlay still helps an 'ask'-matched command through", async () => {
    const overlay = new SessionAllowlist();
    const prompter = new RecordingPrompter(true);
    const engine = new PermissionEngine(
      { bash: { "*": "ask", "git *": "allow" } },
      { prompter, overlay },
    );

    await engine.authorize(bash("npm test --run foo"));
    expect(prompter.seen).toHaveLength(1);
    overlay.remember(bash("npm test --run foo"));

    const second = await engine.authorize(bash("npm test --run bar"));
    expect(second).toEqual({
      allowed: true,
      decision: "ask",
      reason: ALLOWED_FOR_SESSION,
    });
    expect(prompter.seen).toHaveLength(1);
  });

  it("decisionFor without a command only sees the '*' entry", () => {
    const engine = new PermissionEngine({
      bash: { "*": "deny", "git *": "allow" },
    });
    expect(engine.decisionFor("bash")).toBe("deny");
  });

  it("decisionFor falls back to the engine default when the map has no '*' entry", () => {
    const engine = new PermissionEngine(
      { bash: { "git *": "allow" } },
      { defaultDecision: "deny" },
    );
    expect(engine.decisionFor("bash")).toBe("deny");
  });
});
