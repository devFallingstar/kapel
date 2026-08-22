import { describe, expect, it } from "vitest";
import {
  enabledMcpServers,
  McpServersInputSchema,
  mergeMcpServers,
} from "../../src/mcp/config.js";

describe("McpServersInputSchema", () => {
  it("accepts the shape users know from Claude Code and opencode", () => {
    const parsed = McpServersInputSchema.parse({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "t" },
        enabled: true,
      },
    });
    expect(parsed.github?.command).toBe("npx");
  });

  it("allows an entry that only turns a server off", () => {
    expect(
      McpServersInputSchema.safeParse({ github: { enabled: false } }).success,
    ).toBe(true);
  });

  it("rejects a key it does not know, so a typo is not silently ignored", () => {
    expect(
      McpServersInputSchema.safeParse({ github: { commnd: "npx" } }).success,
    ).toBe(false);
  });

  it("rejects an empty command and non-string args", () => {
    expect(
      McpServersInputSchema.safeParse({ a: { command: "" } }).success,
    ).toBe(false);
    expect(
      McpServersInputSchema.safeParse({ a: { command: "x", args: [1] } })
        .success,
    ).toBe(false);
  });
});

describe("mergeMcpServers", () => {
  it("returns nothing for two empty layers", () => {
    expect(mergeMcpServers(undefined, undefined)).toEqual({
      servers: [],
      problems: [],
    });
  });

  it("fills in the defaults a bare entry leaves out", () => {
    expect(mergeMcpServers({ a: { command: "run-a" } }, undefined)).toEqual({
      servers: [
        { name: "a", command: "run-a", args: [], env: {}, enabled: true },
      ],
      problems: [],
    });
  });

  it("lets the override replace the command and args wholesale", () => {
    const merged = mergeMcpServers(
      { a: { command: "run-a", args: ["--one"] } },
      { a: { command: "run-b", args: ["--two"] } },
    );
    expect(merged.servers[0]).toMatchObject({
      command: "run-b",
      args: ["--two"],
    });
  });

  it("merges env key by key so a local token joins the project's variables", () => {
    const merged = mergeMcpServers(
      { a: { command: "run-a", env: { MODE: "ci", TOKEN: "committed" } } },
      { a: { env: { TOKEN: "local" } } },
    );
    expect(merged.servers[0]?.env).toEqual({ MODE: "ci", TOKEN: "local" });
  });

  it("lets a bare {enabled: false} turn off a committed server", () => {
    const merged = mergeMcpServers(
      { a: { command: "run-a" } },
      { a: { enabled: false } },
    );
    expect(merged.servers[0]).toMatchObject({
      command: "run-a",
      enabled: false,
    });
    expect(merged.problems).toEqual([]);
  });

  it("takes a server the override defines on its own", () => {
    const merged = mergeMcpServers(
      { a: { command: "run-a" } },
      { b: { command: "run-b" } },
    );
    expect(merged.servers.map((server) => server.name)).toEqual(["a", "b"]);
  });

  it("drops an entry with no command in either layer, and says which", () => {
    const merged = mergeMcpServers(undefined, { ghost: { enabled: true } });
    expect(merged.servers).toEqual([]);
    expect(merged.problems).toEqual([
      'mcp.ghost: no "command" in either config layer — ignoring this server.',
    ]);
  });

  it("keeps config.yaml order, then the override's own names", () => {
    const merged = mergeMcpServers(
      { one: { command: "x" }, two: { command: "y" } },
      { three: { command: "z" }, one: { args: ["--a"] } },
    );
    expect(merged.servers.map((server) => server.name)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });
});

describe("enabledMcpServers", () => {
  it("keeps only the servers that are turned on", () => {
    const { servers } = mergeMcpServers(
      { on: { command: "a" }, off: { command: "b", enabled: false } },
      undefined,
    );
    expect(enabledMcpServers(servers).map((server) => server.name)).toEqual([
      "on",
    ]);
  });
});
