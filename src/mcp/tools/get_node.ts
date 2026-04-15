import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNode } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  id: z.string().min(1).describe("Node id. Check kg_search results or use the slug convention."),
};

export function registerGetNode(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "kg_get_node",
    {
      title: "Get node by id",
      description:
        "Returns the node row (type, title, content, sourceFile, frontmatter JSON, mtime) " +
        "or null if no node with that id exists.",
      inputSchema,
    },
    async (args) => {
      try {
        const row = getNode(ctx.handle, args.id);
        return ok({ node: row });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
