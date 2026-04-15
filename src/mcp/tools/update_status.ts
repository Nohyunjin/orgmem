import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TASK_STATUSES, updateNodeStatus } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  nodeId: z
    .string()
    .min(1)
    .describe("id of the Task node whose status will be updated (must exist + type='Task')"),
  status: z
    .enum(TASK_STATUSES)
    .describe("New status. Allowed: todo | in_progress | blocked | done | cancelled."),
};

export function registerTaskUpdateStatus(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "task_update_status",
    {
      title: "Update Task status",
      description:
        "Sets the `status` frontmatter field on a Task node, preserving all " +
        "other frontmatter (edges, metadata) and body. Returns previous + new " +
        "status. Reindexes; node re-enters the embed queue (frontmatter bytes changed).",
      inputSchema,
    },
    async (args) => {
      try {
        const result = updateNodeStatus(ctx.handle, ctx.vaultPath, args.nodeId, args.status);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
