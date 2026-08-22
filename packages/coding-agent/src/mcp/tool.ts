import type { Tool, ToolContext } from "@agent/core";
import type { McpStdioClient } from "./client.js";
import type { CallToolResult, McpToolDescriptor } from "./protocol.js";
import { McpContentBlockSchema } from "./protocol.js";

/**
 * One MCP tool, wearing kapel's {@link Tool} interface.
 *
 * The bridged name is `mcp__<server>__<tool>` — the convention Claude Code and
 * opencode already established, which matters because it is what users type
 * into permission rules and what the model sees in a transcript it may have
 * been trained on.
 */

export const MCP_TOOL_PREFIX = "mcp__";
const MCP_NAME_SEPARATOR = "__";

/**
 * The longest tool name the model APIs accept (Anthropic and OpenAI both cap
 * at 64). A bridged name over the cap is not truncated — two truncations can
 * collide, and a colliding tool name is a call routed to the wrong tool — so
 * the tool is left out instead, and the count is reported on
 * `mcp.server.started`.
 */
export const MAX_TOOL_NAME_CHARS = 64;

/**
 * Characters a tool name may contain, per both providers' tool-name rules.
 * Anything else in a server or tool name becomes `_`, which is why a server
 * should be named in `config.yaml` the way it will be written in a permission
 * pattern.
 */
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_-]/g;

function sanitizeSegment(segment: string): string {
  return segment.replace(UNSAFE_NAME_CHARS, "_");
}

/** `mcp__<server>__<tool>`, with both halves reduced to name-safe characters. */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(server)}${MCP_NAME_SEPARATOR}${sanitizeSegment(tool)}`;
}

/**
 * The empty JSON Schema handed to the model for a tool whose server declared
 * none (or declared something that is not an object). Permissive on purpose:
 * the server is the authority on its own arguments, and inventing a stricter
 * schema here would reject calls the server would have accepted.
 */
const OPEN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {},
};

/**
 * Renders a `tools/call` result into the string the loop feeds back to the
 * model.
 *
 * Text is passed through. Non-text content is *described*, not carried: kapel's
 * `ModelMessage` tool results are strings, so an image or an audio blob has
 * nowhere to go, and a base64 payload pasted into the transcript would burn
 * the context window on bytes the model cannot decode. The description names
 * the type, the media type and the payload size, so the model can say what it
 * received and pick a different tool rather than silently seeing nothing.
 * Embedded resources are the exception where they carry `text` — that is text,
 * and it is what the server meant to hand over.
 */
export function renderToolResult(result: CallToolResult): string {
  const rendered: string[] = [];

  for (const entry of result.content ?? []) {
    const block = McpContentBlockSchema.safeParse(entry);
    if (!block.success) {
      rendered.push("[unreadable MCP content block]");
      continue;
    }

    switch (block.data.type) {
      case "text":
        rendered.push(block.data.text);
        break;
      case "image":
      case "audio": {
        const mime = block.data.mimeType ?? "unknown media type";
        const size = block.data.data?.length ?? 0;
        rendered.push(
          `[${block.data.type} content: ${mime}, ${String(size)} base64 chars — not forwarded to the model]`,
        );
        break;
      }
      case "resource": {
        const { uri, mimeType, text } = block.data.resource;
        const label = uri ?? "resource";
        if (text !== undefined) {
          rendered.push(`[resource ${label}]\n${text}`);
        } else {
          rendered.push(
            `[binary resource ${label}: ${mimeType ?? "unknown media type"} — not forwarded to the model]`,
          );
        }
        break;
      }
      case "resource_link":
        rendered.push(
          `[resource link ${block.data.uri ?? block.data.name ?? "unnamed"}]`,
        );
        break;
    }
  }

  // `structuredContent` is a newer, machine-readable mirror of the same
  // answer. It is used only when there is nothing else, so a server that sends
  // both does not have its answer duplicated into the transcript.
  if (rendered.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent) ?? "";
  }
  if (rendered.length === 0) return "[the tool returned no content]";
  return rendered.join("\n");
}

export class McpTool implements Tool<unknown, string> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** The server-side name, which is what `tools/call` has to be given. */
  readonly remoteName: string;
  readonly server: string;
  readonly #client: McpStdioClient;

  constructor(
    server: string,
    descriptor: McpToolDescriptor,
    client: McpStdioClient,
  ) {
    this.server = server;
    this.remoteName = descriptor.name;
    this.name = mcpToolName(server, descriptor.name);
    this.description =
      descriptor.description ??
      descriptor.title ??
      `The "${descriptor.name}" tool provided by the "${server}" MCP server.`;
    // Passed through as authored: JSON Schema is what the model wants and what
    // the server will validate against, so any rewriting here would put the
    // two out of step.
    this.inputSchema = descriptor.inputSchema ?? { ...OPEN_INPUT_SCHEMA };
    this.#client = client;
  }

  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  /**
   * Runs the call and returns its text.
   *
   * Every failure — a dead server, a timeout, a result that does not parse, a
   * tool reporting `isError` — leaves here as a thrown `Error`, which the agent
   * loop turns into a failed tool result the model can read and react to. That
   * is the whole contract: an MCP server crashing must cost the model one tool
   * call, never the turn.
   */
  async execute(input: unknown, context: ToolContext): Promise<string> {
    const result = await this.#client.callTool(
      this.remoteName,
      input,
      context.signal,
    );
    const text = renderToolResult(result);
    if (result.isError === true) {
      throw new Error(text);
    }
    return text;
  }
}
