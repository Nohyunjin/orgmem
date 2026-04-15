import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatHits, search } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  query: z.string().min(1).describe("Natural-language query. Embedded with the same model as backfill."),
  k: z.number().int().min(1).max(100).optional().describe("Top-k for vec MATCH (default 20)."),
  neighborCap: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Cap on 1-hop neighbors per hit per direction (default 20)."),
};

export function registerSearch(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "kg_search",
    {
      title: "Search graph",
      description:
        "Embedding-backed search with 1-hop neighbor expansion. Requires sqlite-vec " +
        "to be loaded and nodes to have embeddings (run `kg embed` first). Returns " +
        "ranked hits with directEdges and inverseEdges.",
      inputSchema,
    },
    async (args) => {
      try {
        if (!ctx.embedClient) {
          return fail(
            new Error(
              "kg_search unavailable: no OPENAI_API_KEY configured when the MCP server started. " +
                "Restart `kg mcp` with OPENAI_API_KEY set.",
            ),
          );
        }
        const hits = await search(ctx.handle, ctx.embedClient, args.query, {
          k: args.k,
          neighborCap: args.neighborCap,
        });
        return ok({ hits: formatHits(hits) });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
