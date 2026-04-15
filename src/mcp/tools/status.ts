import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { countEdges, countNodes } from "../../graph/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

export function registerStatus(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "kg_status",
    {
      title: "Graph status",
      description:
        "Returns node/edge counts, DB path, vault path, vec load state, and the " +
        "pending/embedded/failed embedding queue breakdown.",
      inputSchema: {},
    },
    async () => {
      try {
        const statusRows = ctx.handle.raw
          .prepare("SELECT embedding_status AS s, COUNT(*) AS c FROM nodes GROUP BY embedding_status;")
          .all() as Array<{ s: string; c: number }>;
        const embedQueue: Record<string, number> = { pending: 0, embedded: 0, failed: 0 };
        for (const r of statusRows) embedQueue[r.s] = r.c;
        return ok({
          db: ctx.handle.path,
          vault: ctx.vaultPath,
          nodes: countNodes(ctx.handle),
          edges: countEdges(ctx.handle),
          vecLoaded: ctx.handle.vecLoaded,
          vecError: ctx.handle.vecError ?? null,
          embedQueue,
          searchEnabled: ctx.embedClient !== undefined,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
