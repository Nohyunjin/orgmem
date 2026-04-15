import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import {
  createNode,
  createEdge,
  getNode,
  listEdgesFromFile,
  slugify,
} from "../src/graph/index.ts";
import { parseDoc } from "../src/vault/parser.ts";
import { SelfWriteTracker } from "../src/vault/watcher.ts";

function mkWorkspace() {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-write-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  return { dir, vault, db };
}

describe("slugify", () => {
  test("ASCII roundtrip", () => {
    expect(slugify("Switch to Toss")).toBe("switch-to-toss");
  });
  test("Korean passes through", () => {
    expect(slugify("결제 전환 결정")).toBe("결제-전환-결정");
  });
  test("punctuation collapsed", () => {
    expect(slugify('Q1 roadmap: 2026 (draft)')).toBe("q1-roadmap-2026-draft");
  });
  test("empty-ish falls back to timestamp-ish id", () => {
    const out = slugify("  !!!  ");
    expect(out.startsWith("untitled-")).toBe(true);
  });
});

describe("createNode", () => {
  let ws: ReturnType<typeof mkWorkspace>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWorkspace();
    runMigrations(ws.db);
    handle = openDb({ path: ws.db, loadVec: true });
  });
  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("Decision node lands under decisions/ with date prefix + canonical id", () => {
    const r = createNode(handle, ws.vault, {
      type: "Decision",
      title: "Switch to Toss",
      date: "2026-02-14",
      content: "# Switch to Toss\n\nThree reasons: latency, T+1, agent API.\n",
      edges: [
        { to: "meeting-2026-02-14", relation: "decided_in" },
      ],
    });
    expect(r.mdPath).toBe("decisions/2026-02-14-switch-to-toss.md");
    expect(r.id).toBe("decision-2026-02-14-switch-to-toss");
    expect(existsSync(r.absPath)).toBe(true);

    const raw = readFileSync(r.absPath, "utf8");
    const parsed = parseDoc({ relPath: r.mdPath, raw });
    expect(parsed.id).toBe(r.id);
    expect(parsed.type).toBe("Decision");
    expect(parsed.fmEdges.length).toBe(1);

    const node = getNode(handle, r.id);
    expect(node?.type).toBe("Decision");
    expect(node?.sourceFile).toBe(r.mdPath);
  });

  test("Task node lands under tasks/", () => {
    const r = createNode(handle, ws.vault, {
      type: "Task",
      title: "Toss PG integration",
    });
    expect(r.mdPath).toBe("tasks/toss-pg-integration.md");
    expect(r.id).toBe("task-toss-pg-integration");
  });

  test("collision appends -2, -3", () => {
    const a = createNode(handle, ws.vault, { type: "Document", title: "Payment spec" });
    const b = createNode(handle, ws.vault, { type: "Document", title: "Payment spec" });
    const c = createNode(handle, ws.vault, { type: "Document", title: "Payment spec" });
    expect(a.id).toBe("document-payment-spec");
    expect(b.id).toBe("document-payment-spec-2");
    expect(c.id).toBe("document-payment-spec-3");
    expect(a.mdPath).toBe("docs/payment-spec.md");
    expect(b.mdPath).toBe("docs/payment-spec-2.md");
    expect(c.mdPath).toBe("docs/payment-spec-3.md");
  });

  test("invalid node type is rejected", () => {
    expect(() =>
      createNode(handle, ws.vault, {
        type: "NotAType" as unknown as "Document",
        title: "x",
      }),
    ).toThrow(/Invalid node type/);
  });

  test("empty title is rejected", () => {
    expect(() =>
      createNode(handle, ws.vault, { type: "Document", title: "   " }),
    ).toThrow(/title is required/);
  });

  test("new node starts with embedding_status='pending'", () => {
    const r = createNode(handle, ws.vault, { type: "Document", title: "fresh" });
    const row = handle.raw
      .prepare("SELECT embedding_status FROM nodes WHERE id = ?;")
      .get(r.id) as { embedding_status: string };
    expect(row.embedding_status).toBe("pending");
  });

  test("self-write is registered with the SelfWriteTracker", () => {
    const tracker = new SelfWriteTracker();
    const r = createNode(
      handle,
      ws.vault,
      { type: "Document", title: "traced" },
      tracker,
    );
    expect(tracker.wasRecentSelfWrite(r.absPath)).toBe(true);
  });
});

describe("createEdge", () => {
  let ws: ReturnType<typeof mkWorkspace>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWorkspace();
    runMigrations(ws.db);
    handle = openDb({ path: ws.db, loadVec: true });
  });
  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("appends to frontmatter edges of the source node's file", () => {
    const src = createNode(handle, ws.vault, {
      type: "Document",
      title: "Spec",
    });
    const dst = createNode(handle, ws.vault, {
      type: "Meeting",
      title: "Kickoff",
      date: "2026-04-01",
    });

    const e = createEdge(handle, ws.vault, {
      srcId: src.id,
      relation: "decided_in",
      dstId: dst.id,
    });
    expect(e.sourceFile).toBe(src.mdPath);
    expect(e.sourceLine).toBe(0);
    expect(e.alreadyPresent).toBe(false);

    const raw = readFileSync(src.absPath, "utf8");
    const parsed = parseDoc({ relPath: src.mdPath, raw });
    expect(parsed.fmEdges.some((x) => x.to === dst.id && x.relation === "decided_in")).toBe(true);

    const edgesInDb = listEdgesFromFile(handle, src.mdPath);
    expect(edgesInDb.some((x) => x.edgeId === e.edgeId)).toBe(true);
  });

  test("calling createEdge twice with the same args is idempotent (no duplicate)", () => {
    const src = createNode(handle, ws.vault, { type: "Document", title: "Idempotent" });
    const dst = createNode(handle, ws.vault, { type: "Task", title: "Target" });

    const first = createEdge(handle, ws.vault, {
      srcId: src.id,
      relation: "drives",
      dstId: dst.id,
    });
    const second = createEdge(handle, ws.vault, {
      srcId: src.id,
      relation: "drives",
      dstId: dst.id,
    });
    expect(second.edgeId).toBe(first.edgeId);
    expect(second.alreadyPresent).toBe(true);

    const parsed = parseDoc({
      relPath: src.mdPath,
      raw: readFileSync(src.absPath, "utf8"),
    });
    expect(
      parsed.fmEdges.filter((x) => x.to === dst.id && x.relation === "drives").length,
    ).toBe(1);
  });

  test("rejects invalid relation", () => {
    const src = createNode(handle, ws.vault, { type: "Document", title: "A" });
    expect(() =>
      createEdge(handle, ws.vault, {
        srcId: src.id,
        relation: "not_real" as unknown as "drives",
        dstId: "b",
      }),
    ).toThrow(/invalid relation/);
  });

  test("rejects unknown src node", () => {
    expect(() =>
      createEdge(handle, ws.vault, {
        srcId: "does-not-exist",
        relation: "drives",
        dstId: "x",
      }),
    ).toThrow(/does not exist/);
  });

  test("non-zero sourceLine is not supported in W2 and rejects", () => {
    const src = createNode(handle, ws.vault, { type: "Document", title: "Line" });
    const dst = createNode(handle, ws.vault, { type: "Task", title: "Other" });
    expect(() =>
      createEdge(handle, ws.vault, {
        srcId: src.id,
        relation: "references",
        dstId: dst.id,
        sourceLine: 5,
      }),
    ).toThrow(/non-zero sourceLine is not supported/);
  });
});
