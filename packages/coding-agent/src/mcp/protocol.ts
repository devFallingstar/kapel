import { z } from "zod";

/**
 * The wire vocabulary of the Model Context Protocol, as far as kapel speaks
 * it, with every inbound shape expressed as a zod schema.
 *
 * MCP is JSON-RPC 2.0 over newline-delimited JSON on a child process's
 * stdin/stdout. kapel talks to it the way it talks to the Claude Code and
 * Codex CLIs (see `backends/claude-code.ts`): the process on the other end is
 * somebody else's, versioned by somebody else, and is treated as untrusted and
 * drifting. Nothing here rejects a frame for carrying fields this build has
 * never heard of, and nothing here trusts a field it has not checked.
 *
 * Only three requests are ever sent — `initialize`, `tools/list`,
 * `tools/call` — so only three results have schemas. Everything else a server
 * may send (resources, prompts, sampling requests, progress notifications) is
 * classified at the envelope level and dropped or answered with "method not
 * found"; see {@link classifyFrame}.
 */

export const JSONRPC_VERSION = "2.0";

/**
 * The protocol revision kapel announces at `initialize`.
 *
 * The handshake result's `protocolVersion` is recorded but never enforced: the
 * two calls kapel makes (`tools/list`, `tools/call`) have been present and
 * shape-stable in every published revision, so refusing to talk to a server
 * pinned to an older or newer one would break working setups over a string
 * comparison that buys nothing.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_METHOD_INITIALIZE = "initialize";
export const MCP_METHOD_TOOLS_LIST = "tools/list";
export const MCP_METHOD_TOOLS_CALL = "tools/call";
export const MCP_NOTIFICATION_INITIALIZED = "notifications/initialized";
export const MCP_NOTIFICATION_CANCELLED = "notifications/cancelled";

/** JSON-RPC's "the method does not exist", answered to server-to-client calls. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

export type JsonRpcId = string | number;

const JsonRpcIdSchema = z.union([z.string(), z.number()]);

export const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

/**
 * The envelope every inbound frame shares.
 *
 * `result` is deliberately absent from this schema: JSON-RPC distinguishes a
 * response by the *presence* of the key, and a schema cannot express "present,
 * value unconstrained" in a way that survives zod dropping unknown-typed
 * optional keys. {@link classifyFrame} reads it off the parsed object instead,
 * and the payload underneath is validated by the caller against the schema for
 * the method it asked about — which is where a result's shape actually
 * matters.
 */
const InboundEnvelopeSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcIdSchema.nullable().optional(),
  method: z.string().optional(),
  error: JsonRpcErrorSchema.optional(),
});

/**
 * One inbound frame, sorted into the four things it can be.
 *
 * A server may legitimately send all four — it answers our requests
 * (`response`/`error`), it logs progress (`notification`), and it may call
 * *us* (`request`, e.g. `sampling/createMessage`). The last one has to be
 * answered even though kapel implements none of those methods, or a server
 * that asks sits waiting forever.
 */
export type InboundFrame =
  | {
      readonly kind: "response";
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly kind: "error";
      readonly id: JsonRpcId;
      readonly error: JsonRpcError;
    }
  | {
      readonly kind: "request";
      readonly id: JsonRpcId;
      readonly method: string;
    }
  | { readonly kind: "notification"; readonly method: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and classifies one decoded JSON frame, or returns `undefined` for
 * anything that is not a usable JSON-RPC message.
 *
 * `undefined` is not an error condition: an MCP server is free to print
 * whatever it likes, and a frame this build cannot place is dropped rather
 * than treated as a protocol violation. The one thing that never happens is a
 * malformed frame being handed on as if it were well-formed.
 */
export function classifyFrame(value: unknown): InboundFrame | undefined {
  if (!isRecord(value)) return undefined;
  const envelope = InboundEnvelopeSchema.safeParse(value);
  if (!envelope.success) return undefined;

  const { id, method, error } = envelope.data;

  if (method !== undefined) {
    // A request carries an id and expects an answer; a notification does not.
    if (id === undefined || id === null)
      return { kind: "notification", method };
    return { kind: "request", id, method };
  }

  // Everything past here answers something we sent, so it must say what.
  if (id === undefined || id === null) return undefined;
  if (error !== undefined) return { kind: "error", id, error };
  if (!Object.hasOwn(value, "result")) return undefined;
  return { kind: "response", id, result: value.result };
}

/* -------------------------------------------------------------------------- */
/* results                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The `initialize` result. Everything below `protocolVersion` is optional
 * because none of it changes what kapel does — it is recorded for the
 * `mcp.server.started` event and for error messages, and a server that omits
 * `serverInfo` is still perfectly usable.
 */
export const InitializeResultSchema = z.object({
  protocolVersion: z.string(),
  serverInfo: z
    .object({ name: z.string().optional(), version: z.string().optional() })
    .optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  instructions: z.string().optional(),
});

export type InitializeResult = z.infer<typeof InitializeResultSchema>;

/**
 * One entry of `tools/list`.
 *
 * `inputSchema` stays a bare record: it is JSON Schema authored by the server
 * and handed to the model verbatim (see `McpTool`), so validating its
 * *contents* here would be kapel inventing an opinion about someone else's
 * schema dialect. That it is an object at all is the whole check.
 */
export const McpToolDescriptorSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

export type McpToolDescriptor = z.infer<typeof McpToolDescriptorSchema>;

/**
 * The `tools/list` result.
 *
 * `tools` is an array of `unknown` on purpose: one malformed descriptor must
 * cost that one tool, not the whole server's tool set, so each element is
 * validated separately against {@link McpToolDescriptorSchema} by the caller.
 */
export const ListToolsResultSchema = z.object({
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const BinaryContentSchema = z.object({
  type: z.enum(["image", "audio"]),
  mimeType: z.string().optional(),
  data: z.string().optional(),
});

const EmbeddedResourceSchema = z.object({
  type: z.literal("resource"),
  resource: z.object({
    uri: z.string().optional(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
  }),
});

const ResourceLinkSchema = z.object({
  type: z.literal("resource_link"),
  uri: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
});

export const McpContentBlockSchema = z.union([
  TextContentSchema,
  BinaryContentSchema,
  EmbeddedResourceSchema,
  ResourceLinkSchema,
]);

export type McpContentBlock = z.infer<typeof McpContentBlockSchema>;

/** The `tools/call` result. See {@link McpToolDescriptorSchema} for why the array is loose. */
export const CallToolResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

export type CallToolResult = z.infer<typeof CallToolResultSchema>;
