import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpStdioClient } from "../../src/mcp/client.js";
import type { McpToolDescriptor } from "../../src/mcp/protocol.js";
import {
  MAX_TOOL_NAME_CHARS,
  McpTool,
  mcpToolName,
  renderToolResult,
} from "../../src/mcp/tool.js";
import type { FakeMcpSpec } from "./fake-server.js";
import {
  cleanup,
  fakeMcpArgs,
  makeTempDir,
  writeFakeMcpServer,
} from "./fake-server.js";

describe("mcpToolName", () => {
  it("uses the mcp__<server>__<tool> convention", () => {
    expect(mcpToolName("github", "search_code")).toBe(
      "mcp__github__search_code",
    );
  });

  it("reduces both halves to characters the model APIs accept", () => {
    expect(mcpToolName("my server.v2", "do/it!")).toBe(
      "mcp__my_server_v2__do_it_",
    );
  });

  it("keeps the provider name cap in reach of a normal name", () => {
    expect(mcpToolName("github", "search").length).toBeLessThan(
      MAX_TOOL_NAME_CHARS,
    );
  });
});

describe("renderToolResult", () => {
  it("joins text blocks", () => {
    expect(
      renderToolResult({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("describes image and audio content instead of pasting base64", () => {
    const rendered = renderToolResult({
      content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
    });
    expect(rendered).toBe(
      "[image content: image/png, 4 base64 chars — not forwarded to the model]",
    );
    expect(rendered).not.toContain("AAAA");
  });

  it("passes an embedded resource's text through, and describes a blob", () => {
    expect(
      renderToolResult({
        content: [
          { type: "resource", resource: { uri: "file:///a.txt", text: "hi" } },
        ],
      }),
    ).toBe("[resource file:///a.txt]\nhi");

    expect(
      renderToolResult({
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///a.bin",
              mimeType: "application/octet-stream",
              blob: "AA",
            },
          },
        ],
      }),
    ).toContain("not forwarded to the model");
  });

  it("names a resource link", () => {
    expect(
      renderToolResult({
        content: [{ type: "resource_link", uri: "https://example.test/x" }],
      }),
    ).toBe("[resource link https://example.test/x]");
  });

  it("marks a block it cannot read rather than dropping it silently", () => {
    expect(renderToolResult({ content: [{ type: "video" }] })).toBe(
      "[unreadable MCP content block]",
    );
  });

  it("falls back to structuredContent, then to a stated emptiness", () => {
    expect(renderToolResult({ structuredContent: { ok: true } })).toBe(
      '{"ok":true}',
    );
    expect(renderToolResult({ content: [] })).toBe(
      "[the tool returned no content]",
    );
  });

  it("prefers content over structuredContent so an answer is not doubled", () => {
    expect(
      renderToolResult({
        content: [{ type: "text", text: "the answer" }],
        structuredContent: { answer: "the answer" },
      }),
    ).toBe("the answer");
  });
});

describe("McpTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  async function connect(spec: FakeMcpSpec): Promise<McpStdioClient> {
    const { command, env } = await writeFakeMcpServer(dir, spec);
    return McpStdioClient.connect({
      name: "fake",
      command,
      args: fakeMcpArgs(dir),
      env,
      cwd: dir,
      startupTimeoutMs: 10_000,
      shutdownGraceMs: 200,
    });
  }

  const context = {
    runId: "run-1",
    workspacePath: "/tmp",
    signal: new AbortController().signal,
  };

  it("passes the server's JSON Schema through to the model unchanged", async () => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const client = await connect({ tools: [{ name: "search" }] });
    try {
      const descriptor: McpToolDescriptor = {
        name: "search",
        description: "Searches",
        inputSchema: schema,
      };
      const tool = new McpTool("github", descriptor, client);
      expect(tool.definition()).toEqual({
        name: "mcp__github__search",
        description: "Searches",
        inputSchema: schema,
      });
    } finally {
      await client.close();
    }
  });

  it("describes itself when the server gave no description", async () => {
    const client = await connect({ tools: [{ name: "x" }] });
    try {
      const tool = new McpTool("srv", { name: "x" }, client);
      expect(tool.description).toContain('"x"');
      expect(tool.description).toContain('"srv"');
      expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
    } finally {
      await client.close();
    }
  });

  it("returns the rendered text of a successful call", async () => {
    const client = await connect({
      tools: [{ name: "echo" }],
      calls: {
        echo: { result: { content: [{ type: "text", text: "done" }] } },
      },
    });
    try {
      const tool = new McpTool("srv", { name: "echo" }, client);
      await expect(tool.execute({ a: 1 }, context)).resolves.toBe("done");
    } finally {
      await client.close();
    }
  });

  it("throws the tool's own message when the server reports isError", async () => {
    const client = await connect({
      tools: [{ name: "boom" }],
      calls: {
        boom: {
          result: {
            isError: true,
            content: [{ type: "text", text: "rate limited" }],
          },
        },
      },
    });
    try {
      const tool = new McpTool("srv", { name: "boom" }, client);
      await expect(tool.execute({}, context)).rejects.toThrow(/rate limited/);
    } finally {
      await client.close();
    }
  });

  it("throws — rather than hanging — when the server dies mid-call", async () => {
    const client = await connect({
      tools: [{ name: "crash" }],
      calls: { crash: { exit: 9 } },
    });
    try {
      const tool = new McpTool("srv", { name: "crash" }, client);
      await expect(tool.execute({}, context)).rejects.toThrow(/stopped/);
    } finally {
      await client.close();
    }
  });
});
