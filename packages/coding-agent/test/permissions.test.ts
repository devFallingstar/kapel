import { describe, expect, it } from "vitest";
import {
  DENIED_BY_POLICY,
  DENIED_BY_PROMPTER,
  NO_PROMPTER_AVAILABLE,
  PermissionEngine,
  type PermissionPrompter,
  type PermissionRequest,
} from "../src/permissions.js";

function request(tool: string, input: unknown = { a: 1 }): PermissionRequest {
  return { tool, input, agent: "coder" };
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
    const engine = new PermissionEngine({ read: "allow", bash: "deny", write: "ask" });

    expect(engine.decisionFor("read")).toBe("allow");
    expect(engine.decisionFor("bash")).toBe("deny");
    expect(engine.decisionFor("write")).toBe("ask");
  });

  it("falls back to 'ask' when no default decision is configured", () => {
    const engine = new PermissionEngine({ read: "allow" });
    expect(engine.decisionFor("unlisted")).toBe("ask");
  });

  it("falls back to the configured default decision", () => {
    const engine = new PermissionEngine({ read: "allow" }, { defaultDecision: "deny" });
    expect(engine.decisionFor("unlisted")).toBe("deny");
    expect(engine.decisionFor("read")).toBe("allow");
  });

  it("does not match prefixes, suffixes or inherited object keys", () => {
    const engine = new PermissionEngine({ bash: "allow" }, { defaultDecision: "deny" });

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

    expect(result).toEqual({ allowed: false, decision: "deny", reason: DENIED_BY_POLICY });
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
    expect(NO_PROMPTER_AVAILABLE).toBe("no prompter available in non-interactive mode");
  });

  it("allows an 'ask' tool when the prompter approves, forwarding the full request", async () => {
    const prompter = new RecordingPrompter(true);
    const engine = new PermissionEngine({ write: "ask" }, { prompter });

    const result = await engine.authorize(request("write", { path: "a.txt" }));

    expect(result).toEqual({ allowed: true, decision: "ask" });
    expect(prompter.seen).toEqual([{ tool: "write", input: { path: "a.txt" }, agent: "coder" }]);
  });

  it("denies an 'ask' tool when the prompter refuses", async () => {
    const prompter = new RecordingPrompter(false);
    const engine = new PermissionEngine({ write: "ask" }, { prompter });

    const result = await engine.authorize(request("write"));

    expect(result).toEqual({ allowed: false, decision: "ask", reason: DENIED_BY_PROMPTER });
    expect(prompter.seen).toHaveLength(1);
  });

  it("routes unlisted tools through the default decision", async () => {
    const prompter = new RecordingPrompter(true);
    const allowByDefault = new PermissionEngine({}, { defaultDecision: "allow", prompter });
    const denyByDefault = new PermissionEngine({}, { defaultDecision: "deny", prompter });
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
