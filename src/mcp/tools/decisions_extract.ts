import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  nodeId: z
    .string()
    .min(1)
    .describe("id of the source node (Document/Meeting) to extract decisions from"),
  dryRun: z
    .boolean()
    .optional()
    .describe("If true, return candidate decisions without writing them. Default: true (stub mode)."),
};

/**
 * Stub for week 3 — the real implementation lives in Lane C
 * (probe/V2 Decision Extractor) and lands in W3 once the orgmem
 * integration plan is finalized. For now, this tool advertises its
 * shape so MCP clients can discover the capability and surface a
 * helpful "not yet wired" message instead of an unknown-tool error.
 *
 * When wired (W3):
 *   - reads ctx.handle to fetch the source node body
 *   - calls Lane C's extract() (LLM call)
 *   - returns candidate Decision nodes + provenance
 *   - if dryRun=false, materializes them via createNode + createEdge
 */
export function registerDecisionsExtract(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "decisions_extract",
    {
      title: "Extract decisions from a node (stub)",
      description:
        "STUB (week 3 wiring pending). Returns { stub: true, message } with the " +
        "input echoed for protocol-shape validation. The real extractor — Lane C's " +
        "V2 (recall 0.900) — lands once the integration plan is finalized.",
      inputSchema,
    },
    async (args) => {
      try {
        const dryRun = args.dryRun ?? true;
        return ok({
          stub: true,
          message:
            "decisions_extract is not wired yet. Lane C's V2 extractor lands in week 3. " +
            "Until then, this tool only validates the call shape and returns the inputs.",
          received: { nodeId: args.nodeId, dryRun },
          plannedShape: {
            candidates: "Array<{ title, content, sourceLine, confidence }>",
            written: "Array<{ id, mdPath }> when dryRun=false",
          },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
