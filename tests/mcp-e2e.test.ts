import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Separate describe — spawns a fresh server with ORGMEM_EXTRACTOR_STUB so
 * decisions_extract has an extractor client wired (no Anthropic key needed).
 */
describe("mcp e2e — decisions_extract (stub-injected)", () => {
  const SOURCE_TITLE = "Payment redesign meeting";
  // STUB_DECISION_TEXT must appear verbatim in the meeting body — Lane C's
  // VERBATIM post-check (extract.ts) drops any extracted text that isn't a
  // (normalized) substring of the source body.
  const STUB_DECISION_TEXT = "Adopt MCP as the primary agent integration surface";
  const STUB_MATCH = STUB_DECISION_TEXT;
  const STUB_REASONING = "Stub: locked in during the meeting body";

  let dir: string;
  let vault: string;
  let stubPath: string;
  let client: Client;
  let transport: StdioClientTransport;
  let stderrBuf = "";

  beforeAll(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "orgmem-e2e-extract-"));
    vault = join(dir, "vault");
    const db = join(dir, "dev.db");
    stubPath = join(dir, "extractor-stub.json");
    const fs = await import("node:fs");
    fs.mkdirSync(vault, { recursive: true });

    const stubResponses = [
      {
        match: STUB_MATCH,
        text: JSON.stringify({
          decisions: [
            {
              text: STUB_DECISION_TEXT,
              reasoning: STUB_REASONING,
              line: 3,
            },
          ],
        }),
      },
    ];
    writeFileSync(stubPath, JSON.stringify(stubResponses), "utf8");

    const repoRoot = resolve(import.meta.dir, "..");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli/kg.ts", "mcp"],
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ORGMEM_VAULT: vault,
        ORGMEM_DB: db,
        ORGMEM_EXTRACTOR_STUB: stubPath,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    client = new Client({ name: "orgmem-e2e-extract", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) await client.close().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("server boots with extract=stub in the banner", () => {
    expect(stderrBuf).toContain("extract=stub");
  });

  test("decisions_extract dryRun returns extracted candidates without writing", async () => {
    // First create a Meeting node so the extractor has a source to read.
    const meeting = await callTool(client, "kg_create_node", {
      type: "Meeting",
      title: SOURCE_TITLE,
      content: `# ${SOURCE_TITLE}\n\nNotes:\n- ${STUB_DECISION_TEXT}.\n- Roll out next sprint.`,
      date: "2026-04-15",
    });
    const before = await callTool(client, "kg_status", {});

    const res = await callTool(client, "decisions_extract", {
      nodeId: meeting.id,
      dryRun: true,
    });
    expect(res.dryRun).toBe(true);
    expect(res.sourceDocId).toBe(meeting.id);
    expect(res.extractedCount).toBe(1);
    expect(res.extracted[0].text).toBe(STUB_DECISION_TEXT);
    expect(res.extracted[0].reasoning).toBe(STUB_REASONING);
    expect(res.extracted[0].line).toBe(3);

    // dryRun must NOT have created any Decision nodes.
    const after = await callTool(client, "kg_status", {});
    expect(after.nodes).toBe(before.nodes);
  });

  test("decisions_extract (write) materializes Decision + decided_in edge", async () => {
    const meeting = await callTool(client, "kg_get_node", {
      id: `meeting-2026-04-15-payment-redesign-meeting`,
    });
    expect(meeting.node).not.toBeNull();
    const sourceDocId = meeting.node.id;

    const res = await callTool(client, "decisions_extract", {
      nodeId: sourceDocId,
      dryRun: false,
      date: "2026-04-15",
    });
    expect(res.dryRun).toBe(false);
    expect(res.extractedCount).toBe(1);
    expect(res.created.length).toBe(1);
    expect(res.skipped.length).toBe(0);
    expect(res.errors.length).toBe(0);

    const decisionId = res.created[0].id;
    expect(decisionId).toMatch(/^decision-2026-04-15-[0-9a-f]{10}$/);
    const decisionMd = res.created[0].mdPath;
    const raw = readFileSync(join(vault, decisionMd), "utf8");
    expect(raw).toContain(STUB_DECISION_TEXT);
    expect(raw).toContain(`to: ${sourceDocId}`);
    expect(raw).toContain("relation: decided_in");

    // Source meeting authored the inverse view via list_edges_from_file on the
    // Decision (the edge lives on the Decision's frontmatter).
    const list = await callTool(client, "kg_list_edges_from_file", {
      sourceFile: decisionMd,
    });
    expect(list.edges.length).toBe(1);
    expect(list.edges[0].relation).toBe("decided_in");
    expect(list.edges[0].dstId).toBe(sourceDocId);
  });

  test("decisions_extract is idempotent (re-run produces 0 created, 1 skipped)", async () => {
    const sourceDocId = "meeting-2026-04-15-payment-redesign-meeting";
    const res = await callTool(client, "decisions_extract", {
      nodeId: sourceDocId,
      dryRun: false,
      date: "2026-04-15",
    });
    expect(res.created.length).toBe(0);
    expect(res.skipped.length).toBe(1);
    expect(res.skipped[0].alreadyPresent).toBe(true);
  });
});

/**
 * Verifies Lane C's dedup fix (commit 90dd539 — aggressive normalization in
 * deriveDecisionId) at the MCP level. Simulates the real-world failure mode:
 * the LLM returns *semantically* identical decisions across runs but with
 * surface drift (punctuation, backticks, casing, whitespace). Pre-fix this
 * produced N new Decision nodes per re-run; post-fix the normalization
 * collapses them all to the same id and the pre-existing dedup absorbs them.
 *
 * Stub uses sequence mode so each call returns a different surface form of
 * the same 3 underlying decisions.
 */
describe("mcp e2e — decisions_extract dedup (Lane C fix #2 verification)", () => {
  // Three decisions, in three drifted surface forms. All three forms must
  // collapse to the same id under normalizeForDedup (NFC + lowercase + strip
  // every non-letter/non-digit/non-CJK char).
  const SEMANTIC_DECISIONS = [
    {
      run1: "Adopt MCP as the primary agent integration surface",
      run2: "Adopt MCP, as the primary agent-integration surface.",
      run3: "**Adopt MCP** as the primary `agent integration` surface!",
    },
    {
      run1: "Defer mobile client to Q3",
      run2: "Defer mobile client to Q3.",
      run3: "  defer  mobile-client  to Q3 ",
    },
    {
      run1: "Cap LLM spend at $200/month per user",
      run2: "Cap LLM spend at $200 / month per user.",
      run3: "Cap **LLM** spend at `$200/month` per user",
    },
  ];

  function buildExtractorResponse(forms: { run1: string; run2: string; run3: string }[], runIdx: 1 | 2 | 3): string {
    const key = `run${runIdx}` as const;
    return JSON.stringify({
      decisions: forms.map((f, i) => ({
        text: f[key],
        reasoning: `Stub semantic #${i + 1}, drift run ${runIdx}`,
        line: i + 5,
      })),
    });
  }

  let dir: string;
  let vault: string;
  let stubPath: string;
  let client: Client;
  let transport: StdioClientTransport;
  let stderrBuf = "";

  beforeAll(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "orgmem-e2e-dedup-"));
    vault = join(dir, "vault");
    const db = join(dir, "dev.db");
    stubPath = join(dir, "extractor-stub.json");
    const fs = await import("node:fs");
    fs.mkdirSync(vault, { recursive: true });

    const sequencePayload = {
      mode: "sequence",
      responses: [
        buildExtractorResponse(SEMANTIC_DECISIONS, 1),
        buildExtractorResponse(SEMANTIC_DECISIONS, 2),
        buildExtractorResponse(SEMANTIC_DECISIONS, 3),
      ],
    };
    writeFileSync(stubPath, JSON.stringify(sequencePayload), "utf8");

    const repoRoot = resolve(import.meta.dir, "..");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli/kg.ts", "mcp"],
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ORGMEM_VAULT: vault,
        ORGMEM_DB: db,
        ORGMEM_EXTRACTOR_STUB: stubPath,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    client = new Client({ name: "orgmem-e2e-dedup", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) await client.close().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("3 consecutive decisions_extract calls on the same source: 3 created, 0 created, 0 created", async () => {
    expect(stderrBuf).toContain("extract=stub");

    // Body must contain every surface form the stub will return — Lane C's
    // VERBATIM post-check drops any extracted text that isn't a (normalized)
    // substring of the body. Listing every drift form keeps the dedup test
    // independent of the verbatim filter.
    const allForms = SEMANTIC_DECISIONS.flatMap((d) => [d.run1, d.run2, d.run3]);
    const bodyLines = ["# Q2 planning sync", "", "Discussion notes:"];
    for (const form of allForms) bodyLines.push(`- ${form}`);
    const meeting = await callTool(client, "kg_create_node", {
      type: "Meeting",
      title: "Q2 planning sync",
      content: bodyLines.join("\n") + "\n",
      date: "2026-04-15",
    });

    const N = SEMANTIC_DECISIONS.length;

    // Run 1 — first surface form. All N are new.
    const run1 = await callTool(client, "decisions_extract", {
      nodeId: meeting.id,
      dryRun: false,
      date: "2026-04-15",
    });
    expect(run1.extractedCount).toBe(N);
    expect(run1.created.length).toBe(N);
    expect(run1.skipped.length).toBe(0);
    expect(run1.errors.length).toBe(0);
    const run1Ids = run1.created.map((c: { id: string }) => c.id).sort();

    // Run 2 — drifted surface form (commas, periods, hyphens). Pre-fix this
    // would create ~N new nodes; post-fix all N normalize to the same id and
    // are skipped.
    const run2 = await callTool(client, "decisions_extract", {
      nodeId: meeting.id,
      dryRun: false,
      date: "2026-04-15",
    });
    expect(run2.extractedCount).toBe(N);
    expect(run2.created.length).toBe(0);
    expect(run2.skipped.length).toBe(N);
    expect(run2.errors.length).toBe(0);
    const run2SkippedIds = run2.skipped.map((s: { id: string }) => s.id).sort();
    expect(run2SkippedIds).toEqual(run1Ids);

    // Run 3 — heavier drift (markdown emphasis, backticks, extra whitespace,
    // trailing punctuation). Same outcome.
    const run3 = await callTool(client, "decisions_extract", {
      nodeId: meeting.id,
      dryRun: false,
      date: "2026-04-15",
    });
    expect(run3.extractedCount).toBe(N);
    expect(run3.created.length).toBe(0);
    expect(run3.skipped.length).toBe(N);
    expect(run3.errors.length).toBe(0);
    const run3SkippedIds = run3.skipped.map((s: { id: string }) => s.id).sort();
    expect(run3SkippedIds).toEqual(run1Ids);

    // Final graph state: exactly N Decision nodes (plus the Meeting source +
    // any other nodes the test created).
    const status = await callTool(client, "kg_status", {});
    // 1 Meeting + N Decisions = N+1 nodes
    expect(status.nodes).toBe(N + 1);
    // N decided_in edges (one per Decision pointing back at the Meeting)
    expect(status.edges).toBe(N);
  });
});
