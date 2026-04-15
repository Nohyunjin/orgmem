import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrate.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import type { McpContext } from "../src/mcp/context.ts";

interface Workspace {
  dir: string;
  vault: string;
  db: string;
  handle: DbHandle;
  client: Client;
}

async function mkWorkspace(): Promise<Workspace> {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-mcp-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  runMigrations(db, { loadVec: false });
  const handle = openDb({ path: db, loadVec: false });
  const ctx: McpContext = { handle, vaultPath: vault };
  const server = buildMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { dir, vault, db, handle, client };
}

function parseToolJson(result: { content: Array<{ type: string; text?: string }> }): any {
  const block = result.content[0];
  if (!block || block.type !== "text" || !block.text) throw new Error("no text block");
  return JSON.parse(block.text);
}

describe("mcp server smoke", () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await mkWorkspace();
  });

  afterEach(async () => {
    await ws.client.close();
    ws.handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("initialize + tools/list exposes all 6 tools", async () => {
    const { tools } = await ws.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "kg_create_edge",
        "kg_create_node",
        "kg_get_node",
        "kg_list_edges_from_file",
        "kg_search",
        "kg_status",
      ].sort(),
    );
  });

  test("kg_status returns counts on empty vault", async () => {
    const res = await ws.client.callTool({ name: "kg_status", arguments: {} });
    const payload = parseToolJson(res as any);
    expect(payload.nodes).toBe(0);
    expect(payload.edges).toBe(0);
    expect(payload.vault).toBe(ws.vault);
    expect(payload.searchEnabled).toBe(false);
  });

  test("kg_create_node writes a vault file + increments count", async () => {
    const res = await ws.client.callTool({
      name: "kg_create_node",
      arguments: { type: "Decision", title: "Adopt orgmem", content: "# Adopt orgmem\nbody" },
    });
    const payload = parseToolJson(res as any);
    expect(payload.id).toBeDefined();
    expect(payload.mdPath).toBeDefined();
    expect(existsSync(payload.absPath)).toBe(true);
    const contents = readFileSync(payload.absPath, "utf8");
    expect(contents).toContain("Adopt orgmem");

    const status = parseToolJson(
      (await ws.client.callTool({ name: "kg_status", arguments: {} })) as any,
    );
    expect(status.nodes).toBe(1);
  });

  test("kg_create_edge links two nodes + kg_list_edges_from_file surfaces it", async () => {
    const srcRes = parseToolJson(
      (await ws.client.callTool({
        name: "kg_create_node",
        arguments: { type: "Decision", title: "Pick MCP" },
      })) as any,
    );
    const dstRes = parseToolJson(
      (await ws.client.callTool({
        name: "kg_create_node",
        arguments: { type: "Task", title: "Build server" },
      })) as any,
    );
    const edgeRaw = (await ws.client.callTool({
      name: "kg_create_edge",
      arguments: { srcId: srcRes.id, relation: "drives", dstId: dstRes.id },
    })) as any;
    if (edgeRaw.isError) {
      throw new Error("kg_create_edge failed: " + edgeRaw.content[0]?.text);
    }
    const edgeRes = parseToolJson(edgeRaw);
    expect(edgeRes.edgeId).toBeDefined();
    expect(edgeRes.sourceFile).toBe(srcRes.mdPath);

    const listRes = parseToolJson(
      (await ws.client.callTool({
        name: "kg_list_edges_from_file",
        arguments: { sourceFile: srcRes.mdPath },
      })) as any,
    );
    expect(listRes.edges.length).toBeGreaterThanOrEqual(1);
    expect(listRes.edges.some((e: any) => e.dstId === dstRes.id)).toBe(true);
  });

  test("kg_get_node returns the created node, null for missing id", async () => {
    const created = parseToolJson(
      (await ws.client.callTool({
        name: "kg_create_node",
        arguments: { type: "Person", title: "Hyunjin" },
      })) as any,
    );
    const got = parseToolJson(
      (await ws.client.callTool({
        name: "kg_get_node",
        arguments: { id: created.id },
      })) as any,
    );
    expect(got.node?.id).toBe(created.id);

    const missing = parseToolJson(
      (await ws.client.callTool({
        name: "kg_get_node",
        arguments: { id: "does-not-exist" },
      })) as any,
    );
    expect(missing.node).toBeNull();
  });

  test("kg_search without embed client returns a structured error", async () => {
    const res = (await ws.client.callTool({
      name: "kg_search",
      arguments: { query: "anything" },
    })) as any;
    expect(res.isError).toBe(true);
    const payload = parseToolJson(res);
    expect(payload.error).toMatch(/no OPENAI_API_KEY/i);
  });

  test("invalid input is rejected with a tool error", async () => {
    // missing required `title`
    const res = (await ws.client
      .callTool({
        name: "kg_create_node",
        arguments: { type: "Document" },
      })
      .catch((err: Error) => ({ thrown: err.message }))) as any;
    // SDK may throw OR return isError=true depending on validator
    if (res.thrown) {
      expect(res.thrown).toMatch(/title|invalid|required/i);
    } else {
      expect(res.isError).toBe(true);
    }
  });
});
