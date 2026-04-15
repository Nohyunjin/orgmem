import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listEdgesFromFile } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  sourceFile: z
    .string()
    .min(1)
    .describe("Vault-relative path of the file that authored the edges (e.g. 'decisions/2026-04-15-x.md')."),
};

export function registerListEdgesFromFile(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "kg_list_edges_from_file",
    {
      title: "List edges authored by a file",
      description:
        "Returns every edge whose source_file matches the given vault-relative path. " +
        "Useful for verifying reindex behavior after a write.",
      inputSchema,
    },
    async (args) => {
      try {
        const edges = listEdgesFromFile(ctx.handle, args.sourceFile);
        return ok({ edges });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
