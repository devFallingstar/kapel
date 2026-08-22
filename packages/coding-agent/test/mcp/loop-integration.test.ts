import type {
  ModelDefinition,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "@agent/ai";
import type { AgentDefinition } from "@agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop, type AgentLoopRunContext } from "../../src/loop.js";
import type { McpServerConfig } from "../../src/mcp/config.js";
import { McpSession } from "../../src/mcp/session.js";
import { PermissionEngine } from "../../src/permissions.js";
import { builtinTools } from "../../src/tools/index.js";
import type { FakeMcpSpec } from "./fake-server.js";
import {
  cleanup,
  fakeMcpArgs,
  makeTempDir,
  RecordingSink,
  writeFakeMcpServer,
} from "./fake-server.js";

/**
 * The end of the wire: a real fake MCP server, bridged into a real
 * {@link AgentLoop} driven by a scripted model. What these cover that the unit
 * tests do not is the contract the loop depends on — that a failing MCP server
 * costs one tool call and never the turn.
 */

const MODEL: ModelDefinition = {
  provider: "fake",
  id: "fake-model-1",
  capabilities: {
    tools: true,
    reasoning: false,
    vision: false,
    structuredOutput: true,
  },
};

const RUN_CONTEXT: AgentLoopRunContext = {
  runId: "run-1",
  workspacePath: "/workspace",
};

/** Replays scripted turns and keeps every request, so tool results can be read back. */
class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ModelRequest[] = [];
  readonly #turns: ModelEvent[][];

  constructor(turns: ModelEvent[][]) {
    this.#turns = turns.map((turn) => [...turn]);
  }

  supports(): boolean {
    return true;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const turn = this.#turns.shift();
    if (turn === undefined) throw new Error("scripted provider exhausted");
    for (const event of turn) yield event;
  }
}

function callThen(tool: string, then: string): ModelEvent[][] {
  return [
    [
      { type: "tool.call", id: "c1", name: tool, input: { q: "x" } },
      { type: "done", finishReason: "tool_use" },
    ],
    [
      { type: "text.delta", text: then },
      { type: "done", finishReason: "stop" },
    ],
  ];
}

/** The tool result the loop fed back for call `c1`. */
function toolResultOf(provider: ScriptedProvider): {
  readonly content: string;
  readonly isError: boolean;
} {
  const second = provider.requests[1];
  const message = second?.messages.find(
    (entry) => entry.role === "tool" && entry.toolCallId === "c1",
  );
  return {
    content: message?.content ?? "",
    isError: message?.isError === true,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanup(dir);
});

async function sessionFor(spec: FakeMcpSpec): Promise<McpSession> {
  const { command, env } = await writeFakeMcpServer(dir, spec);
  const server: McpServerConfig = {
    name: "srv",
    command,
    args: fakeMcpArgs(dir),
    env,
    enabled: true,
  };
  return McpSession.start({
    servers: [server],
    workspacePath: dir,
    context: { runId: RUN_CONTEXT.runId },
    startupTimeoutMs: 10_000,
    shutdownGraceMs: 200,
  });
}

async function runLoop(
  session: McpSession,
  provider: ScriptedProvider,
  rules: Readonly<Record<string, "allow" | "ask" | "deny">>,
  events?: RecordingSink,
) {
  const tools = [...builtinTools(), ...session.tools()];
  const agent: AgentDefinition = {
    name: "coder",
    role: "worker",
    model: MODEL,
    systemPrompt: "You are a coding agent.",
    tools: tools.map((tool) => tool.name),
    permissions: {},
  };
  const loop = new AgentLoop({
    agent,
    provider,
    tools,
    permissions: new PermissionEngine(rules, { defaultDecision: "deny" }),
    ...(events === undefined ? {} : { events }),
  });
  return loop.run({ instruction: "do it" }, RUN_CONTEXT);
}

describe("MCP tools inside the agent loop", () => {
  it("offers the bridged tool to the model and feeds its text back", async () => {
    const session = await sessionFor({
      tools: [{ name: "search", description: "Searches" }],
      calls: {
        search: { result: { content: [{ type: "text", text: "found it" }] } },
      },
    });
    const provider = new ScriptedProvider(callThen("mcp__srv__search", "done"));
    try {
      const result = await runLoop(session, provider, {
        "mcp__srv__*": "allow",
      });

      expect(result.status).toBe("success");
      expect(
        provider.requests[0]?.tools?.map((definition) => definition.name),
      ).toContain("mcp__srv__search");
      expect(toolResultOf(provider)).toEqual({
        content: "found it",
        isError: false,
      });
    } finally {
      await session.close();
    }
  });

  it("turns a server that dies mid-call into one failed tool call", async () => {
    const events = new RecordingSink();
    const session = await sessionFor({
      tools: [{ name: "crash" }],
      calls: { crash: { exit: 4 } },
    });
    const provider = new ScriptedProvider(
      callThen("mcp__srv__crash", "recovering"),
    );
    try {
      const result = await runLoop(
        session,
        provider,
        { "mcp__srv__*": "allow" },
        events,
      );

      // The turn completed: the model got an error result and answered it.
      expect(result.status).toBe("success");
      expect(result.output).toBe("recovering");
      const answer = toolResultOf(provider);
      expect(answer.isError).toBe(true);
      expect(answer.content).toMatch(/mcp__srv__crash" failed/);
      expect(answer.content).toMatch(/exit code 4/);
      expect(events.types()).toContain("tool.execution.completed");
    } finally {
      await session.close();
    }
  });

  it("turns a tool-reported failure into a failed tool call, not a crash", async () => {
    const session = await sessionFor({
      tools: [{ name: "boom" }],
      calls: {
        boom: {
          result: {
            isError: true,
            content: [{ type: "text", text: "the repo is archived" }],
          },
        },
      },
    });
    const provider = new ScriptedProvider(
      callThen("mcp__srv__boom", "ok then"),
    );
    try {
      const result = await runLoop(session, provider, {
        "mcp__srv__*": "allow",
      });
      expect(result.status).toBe("success");
      expect(toolResultOf(provider).content).toContain("the repo is archived");
    } finally {
      await session.close();
    }
  });

  it("refuses an MCP call the rules deny, without touching the server", async () => {
    const session = await sessionFor({
      tools: [{ name: "search" }],
      calls: { search: { result: { content: [{ type: "text", text: "!" }] } } },
    });
    const provider = new ScriptedProvider(
      callThen("mcp__srv__search", "understood"),
    );
    try {
      await runLoop(session, provider, { "mcp__srv__*": "deny" });
      const answer = toolResultOf(provider);
      expect(answer.isError).toBe(true);
      expect(answer.content).toContain("was not permitted");
    } finally {
      await session.close();
    }
  });
});
