import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * All orgmem tools return a single JSON text block. MCP's content array
 * officially supports {type: "text", text}. The text is always
 * JSON.stringify(payload, null, 2) so agents can either parse or display
 * verbatim without ambiguity.
 */
export function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
  };
}
