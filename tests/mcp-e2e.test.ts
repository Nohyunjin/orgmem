import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FIXED_DATE = "2026-04-15";
const TITLE = "Gate test";
const EXPECTED_MD_PATH = `decisions/${FIXED_DATE}-gate-test.md`;
const EXPECTED_ID = `decision-${FIXED_DATE}-gate-test`;

interface Ctx {
  dir: string;
  vault: string;
  db: string;
  client: Client;
  transport: StdioClientTransport;
  stderrBuf: string;
}

function parseToolJson(res: any): any {
  const block = res?.content?.[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error(`expected text block, got: ${JSON.stringify(res)}`);
  }
  return JSON.parse(block.text);
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const raw: any = await client.callTool({ name, arguments: args });
  if (raw.isError) {
    const msg = raw.content?.[0]?.text ?? JSON.stringify(raw);
    throw new Error(`tool ${name} returned isError: ${msg}`);
  }
  return parseToolJson(raw);
}

describe("mcp e2e (real stdio child process)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "orgmem-e2e-"));
    const vault = join(dir, "vault");
    const db = join(dir, "dev.db");
    // Vault and parent dir get materialized by the server on first write.
    // But resolveVaultPath requires the vault to exist on disk.
    const fs = await import("node:fs");
    fs.mkdirSync(vault, { recursive: true });

    const repoRoot = resolve(import.meta.dir, "..");
    const transport = new StdioClientTransport({
      command: process.execPath, // current bun binary
      args: ["src/cli/kg.ts", "mcp"],
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ORGMEM_VAULT: vault,
        ORGMEM_DB: db,
      },
      stderr: "pipe",
    });

    let stderrBuf = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const client = new Client({ name: "orgmem-e2e", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    ctx = { dir, vault, db, client, transport, stderrBuf: "" };
    // stderrBuf is captured in closure; expose via getter for assertions
    Object.defineProperty(ctx, "stderrBuf", { get: () => stderrBuf });
  });

  afterAll(async () => {
    if (ctx?.client) await ctx.client.close().catch(() => {});
    if (ctx?.dir) rmSync(ctx.dir, { recursive: true, force: true });
  });

  test("1. server booted cleanly — stderr shows stdio ready", () => {
    expect(ctx.stderrBuf).toContain("[orgmem-mcp] stdio ready");
    expect(ctx.stderrBuf).toContain(`vault=${ctx.vault}`);
  });

  test("2. tools/list exposes all 9 tools", async () => {
    const { tools } = await ctx.client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      "kg_create_node",
      "kg_create_edge",
      "kg_get_node",
      "kg_list_edges_from_file",
      "kg_search",
      "kg_status",
      "doc_append",
      "task_update_status",
      "decisions_extract",
    ]) {
      expect(names.has(required)).toBe(true);
    }
  });

  test("3. initial kg_status shows 0 nodes / 0 edges", async () => {
    const status = await callTool(ctx.client, "kg_status", {});
    expect(status.nodes).toBe(0);
    expect(status.edges).toBe(0);
    expect(status.vault).toBe(ctx.vault);
    expect(status.vecLoaded).toBe(true);
  });

  test("4. kg_create_node returns id + mdPath + absPath", async () => {
    const res = await callTool(ctx.client, "kg_create_node", {
      type: "Decision",
      title: TITLE,
      content: "MCP e2e validation",
      date: FIXED_DATE,
    });
    expect(res.id).toBe(EXPECTED_ID);
    expect(res.mdPath).toBe(EXPECTED_MD_PATH);
    expect(res.absPath).toBe(join(ctx.vault, EXPECTED_MD_PATH));
  });

  test("5. vault file exists on disk with expected frontmatter + body", () => {
    const abs = join(ctx.vault, EXPECTED_MD_PATH);
    expect(existsSync(abs)).toBe(true);
    const raw = readFileSync(abs, "utf8");
    expect(raw).toContain(`id: ${EXPECTED_ID}`);
    expect(raw).toContain("type: Decision");
    expect(raw).toContain(`title: ${TITLE}`);
    expect(raw).toContain("MCP e2e validation");
  });

  test("6. kg_status reports nodes=1 (DB materialized the upsert)", async () => {
    const status = await callTool(ctx.client, "kg_status", {});
    expect(status.nodes).toBe(1);
    expect(status.embedQueue.pending).toBe(1);
  });

  test("7. kg_get_node returns the newly created node", async () => {
    const res = await callTool(ctx.client, "kg_get_node", { id: EXPECTED_ID });
    expect(res.node).not.toBeNull();
    expect(res.node.id).toBe(EXPECTED_ID);
    expect(res.node.type).toBe("Decision");
    expect(res.node.title).toBe(TITLE);
    expect(res.node.sourceFile).toBe(EXPECTED_MD_PATH);
  });

  test("8. kg_create_edge appends edge to frontmatter + DB", async () => {
    // Create a target node first to give the edge a real destination.
    const dst = await callTool(ctx.client, "kg_create_node", {
      type: "Task",
      title: "Gate followup",
    });
    const edgeRes = await callTool(ctx.client, "kg_create_edge", {
      srcId: EXPECTED_ID,
      relation: "drives",
      dstId: dst.id,
    });
    expect(edgeRes.sourceFile).toBe(EXPECTED_MD_PATH);
    expect(edgeRes.alreadyPresent).toBe(false);
    expect(edgeRes.edgeId).toBeTruthy();

    // Frontmatter on the source file should now carry the edge.
    const raw = readFileSync(join(ctx.vault, EXPECTED_MD_PATH), "utf8");
    expect(raw).toContain("edges:");
    expect(raw).toContain(`to: ${dst.id}`);
    expect(raw).toContain("relation: drives");

    // And it should be queryable via kg_list_edges_from_file.
    const list = await callTool(ctx.client, "kg_list_edges_from_file", {
      sourceFile: EXPECTED_MD_PATH,
    });
    expect(list.edges.length).toBe(1);
    expect(list.edges[0].relation).toBe("drives");
    expect(list.edges[0].dstId).toBe(dst.id);
  });

  test("9. second kg_create_edge call is idempotent (alreadyPresent=true)", async () => {
    // Look up the destination node id that test 8 created.
    const list = await callTool(ctx.client, "kg_list_edges_from_file", {
      sourceFile: EXPECTED_MD_PATH,
    });
    const dstId = list.edges[0].dstId;

    const edgeRes = await callTool(ctx.client, "kg_create_edge", {
      srcId: EXPECTED_ID,
      relation: "drives",
      dstId,
    });
    expect(edgeRes.alreadyPresent).toBe(true);
  });

  test("10. doc_append writes a new block to the Decision body + reindexes", async () => {
    const APPEND_BLOCK = "## Follow-ups\n- Wire `task_update_status` from agent loop";
    const res = await callTool(ctx.client, "doc_append", {
      nodeId: EXPECTED_ID,
      content: APPEND_BLOCK,
    });
    expect(res.id).toBe(EXPECTED_ID);
    expect(res.sourceFile).toBe(EXPECTED_MD_PATH);
    expect(res.appendedChars).toBe(APPEND_BLOCK.length);

    const raw = readFileSync(join(ctx.vault, EXPECTED_MD_PATH), "utf8");
    expect(raw).toContain("MCP e2e validation"); // original body preserved
    expect(raw).toContain("## Follow-ups");
    expect(raw).toContain("Wire `task_update_status` from agent loop");
    // edges from test 8 must still be present (frontmatter not clobbered)
    expect(raw).toContain("edges:");
    expect(raw).toContain("relation: drives");
  });

  test("11. doc_append rejects empty content + nonexistent node", async () => {
    const empty = (await ctx.client.callTool({
      name: "doc_append",
      arguments: { nodeId: EXPECTED_ID, content: "   \n  " },
    })) as any;
    expect(empty.isError).toBe(true);
    expect(parseToolJson(empty).error).toMatch(/non-empty/i);

    const missing = (await ctx.client.callTool({
      name: "doc_append",
      arguments: { nodeId: "no-such-node-id", content: "valid body" },
    })) as any;
    expect(missing.isError).toBe(true);
    expect(parseToolJson(missing).error).toMatch(/does not exist/);
  });

  test("12. task_update_status flips a Task's status + persists to frontmatter", async () => {
    const list = await callTool(ctx.client, "kg_list_edges_from_file", {
      sourceFile: EXPECTED_MD_PATH,
    });
    const taskId = list.edges[0].dstId;

    const upd = await callTool(ctx.client, "task_update_status", {
      nodeId: taskId,
      status: "in_progress",
    });
    expect(upd.id).toBe(taskId);
    expect(upd.newStatus).toBe("in_progress");

    const taskAbs = join(ctx.vault, "tasks/gate-followup.md");
    const raw = readFileSync(taskAbs, "utf8");
    expect(raw).toMatch(/status:\s*in_progress/);

    const second = await callTool(ctx.client, "task_update_status", {
      nodeId: taskId,
      status: "done",
    });
    expect(second.previousStatus).toBe("in_progress");
    expect(second.newStatus).toBe("done");
  });

  test("13. task_update_status rejects non-Task nodes + invalid status enum", async () => {
    const wrongType = (await ctx.client.callTool({
      name: "task_update_status",
      arguments: { nodeId: EXPECTED_ID, status: "done" },
    })) as any;
    expect(wrongType.isError).toBe(true);
    expect(parseToolJson(wrongType).error).toMatch(/only Task nodes/);

    const invalidStatus = (await ctx.client
      .callTool({
        name: "task_update_status",
        arguments: { nodeId: EXPECTED_ID, status: "in-flight" },
      })
      .catch((err: Error) => ({ thrown: err.message }))) as any;
    if (invalidStatus.thrown) {
      expect(invalidStatus.thrown).toMatch(/invalid|enum|in-flight/i);
    } else {
      expect(invalidStatus.isError).toBe(true);
    }
  });
});
