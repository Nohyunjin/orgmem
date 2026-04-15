import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDbPath, openDb } from "../storage/sqlite.ts";
import { runMigrations } from "../storage/migrate.ts";
import { createOpenAIClient } from "../embeddings/client.ts";
import { buildMcpServer } from "./server.ts";
import { resolveVaultPath, type McpContext } from "./context.ts";

export interface StartStdioOptions {
  vault?: string;
  dbPath?: string;
}

/**
 * Boots a stdio MCP server. Resolves vault path, runs migrations, opens the
 * DB once, optionally wires up an OpenAI embed client (gated on OPENAI_API_KEY),
 * then hands control to StdioServerTransport until the client disconnects.
 *
 * All log output goes to stderr — stdout is reserved for the JSON-RPC stream
 * that MCP clients consume. Writing anything to stdout here will corrupt
 * the protocol.
 */
export async function startStdio(opts: StartStdioOptions = {}): Promise<void> {
  const vaultPath = resolveVaultPath(opts.vault);
  const dbPath = opts.dbPath ?? defaultDbPath();

  runMigrations(dbPath);
  const handle = openDb({ path: dbPath, loadVec: true });

  const apiKey = process.env.OPENAI_API_KEY;
  const ctx: McpContext = {
    handle,
    vaultPath,
    embedClient: apiKey ? createOpenAIClient({ apiKey }) : undefined,
  };

  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: NodeJS.Signals) => {
    process.stderr.write(`[orgmem-mcp] ${signal} received, shutting down\n`);
    try {
      await server.close();
    } finally {
      handle.raw.close();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(
    `[orgmem-mcp] stdio ready · db=${handle.path} · vault=${vaultPath} · ` +
      `vec=${handle.vecLoaded ? "ok" : "off"} · search=${ctx.embedClient ? "on" : "off (no OPENAI_API_KEY)"}\n`,
  );

  await server.connect(transport);
}
