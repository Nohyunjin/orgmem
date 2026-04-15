import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDbPath, openDb } from "../storage/sqlite.ts";
import { runMigrations } from "../storage/migrate.ts";
import { createOpenAIClient } from "../embeddings/client.ts";
import {
  createExtractorClient,
  createStubExtractorClient,
  type ExtractorClient,
} from "../extractor/index.ts";
import { buildMcpServer } from "./server.ts";
import { resolveVaultPath, type McpContext } from "./context.ts";

/**
 * Resolve an ExtractorClient at server boot. Priority:
 *   1. ORGMEM_EXTRACTOR_STUB=<path-to-json> — load stub responses from disk.
 *      Used by mcp-e2e tests so we can spawn a real child process without
 *      needing an Anthropic API key. Two JSON shapes accepted:
 *
 *      a. Match-based (default):
 *           [{ "match": "<substring>", "text": "<llm response text>" }, ...]
 *         First match wins; same response every call. Wraps
 *         `createStubExtractorClient`.
 *
 *      b. Sequence-based:
 *           { "mode": "sequence", "responses": ["<text1>", "<text2>", ...] }
 *         Returns responses[N-1] on the Nth call regardless of input.
 *         Throws once exhausted. Used to simulate LLM drift across
 *         repeated calls (e.g. dedup verification).
 *
 *   2. ANTHROPIC_API_KEY — real Anthropic client (locked extractor model).
 *   3. undefined — `decisions_extract` returns "not configured" error.
 */
function resolveExtractorClient(): ExtractorClient | undefined {
  const stubPath = process.env.ORGMEM_EXTRACTOR_STUB;
  if (stubPath && stubPath.trim()) {
    try {
      const raw = readFileSync(stubPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { mode?: unknown }).mode === "sequence"
      ) {
        const responses = (parsed as { responses?: unknown }).responses;
        if (!Array.isArray(responses) || responses.some((r) => typeof r !== "string")) {
          throw new Error("sequence mode requires responses: string[]");
        }
        let i = 0;
        return {
          async complete() {
            if (i >= responses.length) {
              throw new Error(
                `ORGMEM_EXTRACTOR_STUB sequence exhausted after ${i} call(s); ` +
                  `add more entries or stop calling.`,
              );
            }
            const text = responses[i++] as string;
            return { text, usage: {}, stopReason: "end_turn" };
          },
        };
      }
      if (!Array.isArray(parsed)) {
        throw new Error("expected an array of {match, text} entries (or sequence-mode object)");
      }
      return createStubExtractorClient(parsed as Array<{ match: string; text: string }>);
    } catch (err) {
      throw new Error(
        `ORGMEM_EXTRACTOR_STUB load failed (${stubPath}): ${(err as Error).message}`,
      );
    }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return createExtractorClient({ apiKey });
  }
  return undefined;
}

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
  const extractorClient = resolveExtractorClient();
  const ctx: McpContext = {
    handle,
    vaultPath,
    embedClient: apiKey ? createOpenAIClient({ apiKey }) : undefined,
    extractorClient,
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

  const extractStatus = extractorClient
    ? process.env.ORGMEM_EXTRACTOR_STUB
      ? "stub"
      : "on"
    : "off (no ANTHROPIC_API_KEY)";
  process.stderr.write(
    `[orgmem-mcp] stdio ready · db=${handle.path} · vault=${vaultPath} · ` +
      `vec=${handle.vecLoaded ? "ok" : "off"} · search=${ctx.embedClient ? "on" : "off (no OPENAI_API_KEY)"} · ` +
      `extract=${extractStatus}\n`,
  );

  await server.connect(transport);
}
