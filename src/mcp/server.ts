import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./context.ts";
import { registerCreateNode } from "./tools/create_node.ts";
import { registerCreateEdge } from "./tools/create_edge.ts";
import { registerSearch } from "./tools/search.ts";
import { registerGetNode } from "./tools/get_node.ts";
import { registerListEdgesFromFile } from "./tools/list_edges.ts";
import { registerStatus } from "./tools/status.ts";

const SERVER_INFO = {
  name: "orgmem",
  version: "0.1.0",
};

/**
 * Builds an MCP server with every orgmem tool registered. Callers connect
 * the returned server to a transport (Stdio for production, InMemory for
 * tests). Lifecycle of ctx.handle is the caller's responsibility — the
 * server does not close the DB.
 */
export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  });
  registerCreateNode(server, ctx);
  registerCreateEdge(server, ctx);
  registerSearch(server, ctx);
  registerGetNode(server, ctx);
  registerListEdgesFromFile(server, ctx);
  registerStatus(server, ctx);
  return server;
}
