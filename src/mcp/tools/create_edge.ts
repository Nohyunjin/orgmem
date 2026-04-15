import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createEdge, RELATION_TYPES } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  srcId: z.string().min(1).describe("id of the source node (must exist with a file on disk)"),
  relation: z.enum(RELATION_TYPES),
  dstId: z.string().min(1).describe("id of the destination node (may dangle — no existence check)"),
  sourceLine: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Optional 1-based body line. Omit / 0 → frontmatter edge (the only supported mode in week 2).",
    ),
};

export function registerCreateEdge(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "kg_create_edge",
    {
      title: "Create graph edge",
      description:
        "Adds an edge from srcId→dstId into the source node's markdown frontmatter " +
        "and reindexes. Idempotent: if the edge already exists (semantic match), " +
        "returns alreadyPresent: true without rewriting the file.",
      inputSchema,
    },
    async (args) => {
      try {
        const result = createEdge(ctx.handle, ctx.vaultPath, {
          srcId: args.srcId,
          relation: args.relation,
          dstId: args.dstId,
          sourceLine: args.sourceLine,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
