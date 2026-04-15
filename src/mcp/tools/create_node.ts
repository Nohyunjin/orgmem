import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createNode, NODE_TYPES, RELATION_TYPES } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const nodeTypeEnum = z.enum(NODE_TYPES);
const relationEnum = z.enum(RELATION_TYPES);

const edgeInput = z.object({
  to: z.string().min(1),
  relation: relationEnum,
});

const inputSchema = {
  type: nodeTypeEnum.describe(
    "Node type. MVP enum: Document | Task | Meeting | Decision | Person.",
  ),
  title: z.string().min(1).describe("Human title. Used for id + file slug."),
  content: z
    .string()
    .optional()
    .describe("Markdown body. Omit to get '# <title>\\n' as a stub."),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe("Extra frontmatter keys (won't clobber id/type/title/edges)."),
  edges: z
    .array(edgeInput)
    .optional()
    .describe("Initial frontmatter edges to anchor on this new node."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Override date prefix for Decision/Meeting (default: today)."),
  id: z.string().optional().describe("Override id (default: slug of title)."),
  pathOverride: z
    .string()
    .optional()
    .describe("Vault-relative path override. Rare — default layout is fine."),
};

export function registerCreateNode(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "kg_create_node",
    {
      title: "Create graph node",
      description:
        "Materializes a new node as a markdown file under the vault and upserts " +
        "it into the graph. Returns the assigned id + file path. Idempotent on " +
        "title collisions: appends -2, -3, ... as needed.",
      inputSchema,
    },
    async (args) => {
      try {
        const result = createNode(ctx.handle, ctx.vaultPath, {
          type: args.type,
          title: args.title,
          content: args.content,
          metadata: args.metadata,
          edges: args.edges,
          date: args.date,
          id: args.id,
          pathOverride: args.pathOverride,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
