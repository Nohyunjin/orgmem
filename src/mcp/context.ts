import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { DbHandle } from "../storage/sqlite.ts";
import type { EmbedClient } from "../embeddings/client.ts";

/**
 * Shared per-process state passed into every MCP tool handler. The server
 * owns the DbHandle for its entire lifetime — tools don't open or close DBs
 * themselves. Vault path is required for any tool that writes to disk
 * (createNode, createEdge); search/status tools ignore it.
 */
export interface McpContext {
  handle: DbHandle;
  vaultPath: string;
  /** Optional embed client — required by kg_search, absent disables it. */
  embedClient?: EmbedClient;
}

/**
 * Resolves the vault path from (in order): explicit override, ORGMEM_VAULT env,
 * or throws. The vault must exist on disk — we don't materialize it here.
 */
export function resolveVaultPath(override?: string): string {
  const raw = override ?? process.env.ORGMEM_VAULT;
  if (!raw || !raw.trim()) {
    throw new Error(
      "orgmem MCP: no vault configured. Set ORGMEM_VAULT=/abs/path/to/vault " +
        "in the MCP client's env, or pass --vault to `kg mcp`.",
    );
  }
  const abs = resolve(raw);
  if (!existsSync(abs)) {
    throw new Error(`orgmem MCP: vault path does not exist: ${abs}`);
  }
  return abs;
}
