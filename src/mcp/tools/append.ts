import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendToNode } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  nodeId: z
    .string()
    .min(1)
    .describe("id of the node whose markdown body will be appended to (must exist + be file-backed)"),
  content: z
    .string()
    .min(1)
    .describe(
      "Block to append. Inserted after a single blank-line separator. Not idempotent — calling twice appends twice.",
    ),
};

export function registerDocAppend(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "doc_append",
    {
      title: "Append to node body",
      description:
        "Appends a block of markdown to the end of an existing node's body, " +
        "preserving frontmatter (incl. edges) and prior body. Reindexes; " +
        "the node will re-enter the embed queue. Rejects empty/whitespace " +
        "content and nodes without a source file.",
      inputSchema,
    },
    async (args) => {
      try {
        const result = appendToNode(ctx.handle, ctx.vaultPath, args.nodeId, args.content);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
