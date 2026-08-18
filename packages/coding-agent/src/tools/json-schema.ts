import { z } from "zod";

/**
 * Renders a zod object schema to a plain JSON Schema object suitable for handing to an LLM API
 * as a tool's inputSchema. Strips the `$schema` meta key, which tool-use APIs don't expect.
 */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}
