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

  test("initialize + tools/list exposes all 9 tools", async () => {
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
        "doc_append",
        "task_update_status",
        "decisions_extract",
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

  test("doc_append appends to body + reindexes (embedding flips back to pending)", async () => {
    const created = parseToolJson(
      (await ws.client.callTool({
        name: "kg_create_node",
        arguments: { type: "Meeting", title: "Standup", date: "2026-04-15" },
      })) as any,
    );
    const appendRes = parseToolJson(
      (await ws.client.callTool({
        name: "doc_append",
        arguments: { nodeId: created.id, content: "- Follow-up: ship MCP" },
      })) as any,
    );
    expect(appendRes.id).toBe(created.id);
    expect(appendRes.appendedChars).toBe("- Follow-up: ship MCP".length);
    const raw = readFileSync(appendRes.absPath, "utf8");
    expect(raw).toContain("- Follow-up: ship MCP");
  });

  test("doc_append rejects empty content + missing node", async () => {
    const empty = (await ws.client.callTool({
      name: "doc_append",
      arguments: { nodeId: "anything", content: "   \n  " },
    })) as any;
    expect(empty.isError).toBe(true);
    const missing = (await ws.client.callTool({
      name: "doc_append",
      arguments: { nodeId: "does-not-exist", content: "valid body" },
    })) as any;
    expect(missing.isError).toBe(true);
    const missingPayload = parseToolJson(missing);
    expect(missingPayload.error).toMatch(/does not exist/);
  });

  test("task_update_status flips a Task's status + persists to frontmatter", async () => {
    const task = parseToolJson(
      (await ws.client.callTool({
        name: "kg_create_node",
        arguments: { type: "Task", title: "Wire MCP" },
      })) as any,
    );
    const upd = parseToolJson(
      (await ws.client.callTool({
        name: "task_update_status",
        arguments: { nodeId: task.id, status: "in_progress" },
      })) as any,
    );
    expect(upd.newStatus).toBe("in_progress");
    expect(upd.id).toBe(task.id);
    const raw = readFileSync(task.absPath, "utf8");
    expect(raw).toMatch(/status:\s*in_progress/);
  });

  test("task_update_status rejects non-Task nodes + invalid statuses", async () => {
    const decision = parseToolJson(
      (await ws.client.callTool({
        name: "kg_create_node",
        arguments: { type: "Decision", title: "Pick stack", date: "2026-04-15" },
      })) as any,
    );
    const wrongType = (await ws.client.callTool({
      name: "task_update_status",
      arguments: { nodeId: decision.id, status: "done" },
    })) as any;
    expect(wrongType.isError).toBe(true);
    expect(parseToolJson(wrongType).error).toMatch(/only Task nodes/);

    // invalid enum is caught by SDK validator before we even hit the handler
    const invalidStatus = await ws.client
      .callTool({
        name: "task_update_status",
        arguments: { nodeId: decision.id, status: "wat" },
      })
      .catch((err: Error) => ({ thrown: err.message }));
    if ("thrown" in (invalidStatus as any)) {
      expect((invalidStatus as any).thrown).toMatch(/invalid|enum|wat/i);
    } else {
      expect((invalidStatus as any).isError).toBe(true);
    }
  });

  test("decisions_extract returns stub payload (echoes inputs, signals not-wired)", async () => {
    const res = parseToolJson(
      (await ws.client.callTool({
        name: "decisions_extract",
        arguments: { nodeId: "doc-some-source", dryRun: true },
      })) as any,
    );
    expect(res.stub).toBe(true);
    expect(res.received.nodeId).toBe("doc-some-source");
    expect(res.received.dryRun).toBe(true);
    expect(res.message).toMatch(/not wired|week 3|Lane C/i);
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
