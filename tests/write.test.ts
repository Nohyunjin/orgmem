import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import {
  createNode,
  createEdge,
  appendToNode,
  updateNodeStatus,
  getNode,
  listEdgesFromFile,
  slugify,
  SLUG_MAX_BYTES,
  TASK_STATUSES,
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

  describe("byte cap (SLUG_MAX_BYTES)", () => {
    const byteLen = (s: string) => new TextEncoder().encode(s).byteLength;

    test("short ASCII passes through unchanged", () => {
      const out = slugify("hello world");
      expect(out).toBe("hello-world");
      expect(byteLen(out)).toBeLessThanOrEqual(SLUG_MAX_BYTES);
    });

    test("long ASCII truncates at the byte cap", () => {
      const long = "abcdefghij ".repeat(20); // way over 80 bytes
      const out = slugify(long);
      expect(byteLen(out)).toBeLessThanOrEqual(SLUG_MAX_BYTES);
      // ASCII slugs fill the cap tightly; leave a 3-byte grace window for
      // the trailing-hyphen trim.
      expect(byteLen(out)).toBeGreaterThanOrEqual(SLUG_MAX_BYTES - 3);
      expect(out.endsWith("-")).toBe(false);
    });

    test("long Korean truncates without splitting a multi-byte character", () => {
      // 30 syllables × 3 bytes = 90 bytes — forces at least one truncation.
      const long = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도";
      expect(byteLen(long)).toBeGreaterThan(SLUG_MAX_BYTES);
      const out = slugify(long);
      expect(byteLen(out)).toBeLessThanOrEqual(SLUG_MAX_BYTES);
      // Decoded result must be valid UTF-8 (no U+FFFD replacement chars).
      expect(out).not.toContain("\uFFFD");
      // Must be a prefix of the (cleaned) original — i.e. no byte-level glitch
      // invented a bogus character.
      expect(long.startsWith(out)).toBe(true);
    });

    test("long mixed Korean + ASCII truncates on a character boundary", () => {
      const long =
        "Payment 결제 전환 결정 2026 결정 payment switch 한글 영문 혼합 결정 문서 긴 제목 테스트 케이스";
      expect(byteLen(long)).toBeGreaterThan(SLUG_MAX_BYTES);
      const out = slugify(long);
      expect(byteLen(out)).toBeLessThanOrEqual(SLUG_MAX_BYTES);
      expect(out).not.toContain("\uFFFD");
      expect(out.endsWith("-")).toBe(false);
    });

    test("cap does not strip a title that fits exactly", () => {
      // An 80-byte ASCII title is unchanged by the cap.
      const exactly = "a".repeat(SLUG_MAX_BYTES);
      expect(byteLen(exactly)).toBe(SLUG_MAX_BYTES);
      const out = slugify(exactly);
      expect(out).toBe(exactly);
      expect(byteLen(out)).toBe(SLUG_MAX_BYTES);
    });
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

  test("long Korean title produces a byte-capped filename + id", () => {
    const title = "결제 시스템 전환 결정 문서 매우 매우 긴 제목 테스트 한글 파일명 체크 2026년 4월";
    const r = createNode(handle, ws.vault, { type: "Decision", title, date: "2026-04-15" });
    const byteLen = (s: string) => new TextEncoder().encode(s).byteLength;
    // The full mdPath has dir + date prefix + slug + ".md" — cap the slug
    // portion, but assert the whole file name component stays under a
    // defensive 120-byte bar so zips / sync clients don't choke.
    const fileName = r.mdPath.split("/").pop()!;
    expect(byteLen(fileName)).toBeLessThanOrEqual(120);
    // Id is prefixed with "decision-YYYY-MM-DD-" (22 bytes) + slug.
    expect(byteLen(r.id)).toBeLessThanOrEqual(120);
    // File was actually written at the computed path.
    expect(existsSync(r.absPath)).toBe(true);
  });

  test("two identical long Korean titles collide cleanly with -2 suffix", () => {
    const title = "결제 시스템 전환 결정 문서 매우 매우 긴 제목 테스트 한글 파일명 체크 2026년 4월";
    const a = createNode(handle, ws.vault, { type: "Decision", title, date: "2026-04-15" });
    const b = createNode(handle, ws.vault, { type: "Decision", title, date: "2026-04-15" });
    expect(a.id).not.toBe(b.id);
    expect(b.id.endsWith("-2")).toBe(true);
    expect(a.mdPath).not.toBe(b.mdPath);
    expect(b.mdPath.endsWith("-2.md")).toBe(true);
    const byteLen = (s: string) => new TextEncoder().encode(s).byteLength;
    expect(byteLen(b.mdPath.split("/").pop()!)).toBeLessThanOrEqual(120);
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

describe("appendToNode", () => {
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

  test("appends a blank-line-separated block to an existing Meeting", () => {
    const m = createNode(handle, ws.vault, {
      type: "Meeting",
      title: "Weekly sync",
      date: "2026-04-15",
      content: "# Weekly sync\n\nInitial agenda.\n",
    });
    const r = appendToNode(handle, ws.vault, m.id, "New note: API latency discussion.");
    expect(r.id).toBe(m.id);
    expect(r.sourceFile).toBe(m.mdPath);

    const raw = readFileSync(m.absPath, "utf8");
    expect(raw).toContain("Initial agenda.");
    expect(raw).toContain("New note: API latency discussion.");
    // Blank line separator between the two bodies.
    expect(raw).toMatch(/Initial agenda\.\n\nNew note: API latency discussion\.\n$/);
  });

  test("twice-appended is NOT idempotent — both blocks present", () => {
    const m = createNode(handle, ws.vault, {
      type: "Meeting",
      title: "Standup",
      date: "2026-04-15",
    });
    appendToNode(handle, ws.vault, m.id, "first");
    appendToNode(handle, ws.vault, m.id, "second");
    const raw = readFileSync(m.absPath, "utf8");
    // Both blocks must be present, separated by blank lines.
    expect(raw).toContain("first");
    expect(raw).toContain("second");
    const firstIdx = raw.indexOf("first");
    const secondIdx = raw.indexOf("second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("preserves frontmatter edges across append", () => {
    const dst = createNode(handle, ws.vault, {
      type: "Decision",
      title: "Go with Toss",
      date: "2026-04-10",
    });
    const m = createNode(handle, ws.vault, {
      type: "Meeting",
      title: "Kickoff",
      date: "2026-04-15",
      edges: [{ to: dst.id, relation: "decides" }],
    });
    appendToNode(handle, ws.vault, m.id, "follow-up note");
    const raw = readFileSync(m.absPath, "utf8");
    const parsed = parseDoc({ relPath: m.mdPath, raw });
    expect(parsed.fmEdges.some((e) => e.to === dst.id && e.relation === "decides")).toBe(true);
    expect(parsed.body).toContain("follow-up note");
  });

  test("flips embedding_status back to 'pending' after content change", () => {
    const m = createNode(handle, ws.vault, {
      type: "Meeting",
      title: "Retro",
      date: "2026-04-15",
    });
    // Manually mark as embedded to prove append flips it back.
    handle.raw
      .prepare("UPDATE nodes SET embedding_status = 'embedded' WHERE id = ?;")
      .run(m.id);
    appendToNode(handle, ws.vault, m.id, "late addition");
    const row = handle.raw
      .prepare("SELECT embedding_status FROM nodes WHERE id = ?;")
      .get(m.id) as { embedding_status: string };
    expect(row.embedding_status).toBe("pending");
  });

  test("empty content is rejected", () => {
    const m = createNode(handle, ws.vault, { type: "Meeting", title: "x", date: "2026-01-01" });
    expect(() => appendToNode(handle, ws.vault, m.id, "   \n\t  ")).toThrow(
      /content must be non-empty/,
    );
  });

  test("missing node is rejected", () => {
    expect(() => appendToNode(handle, ws.vault, "nope-no-such-node", "x")).toThrow(
      /does not exist/,
    );
  });

  test("self-write is registered", () => {
    const tracker = new SelfWriteTracker();
    const m = createNode(handle, ws.vault, { type: "Meeting", title: "traced", date: "2026-04-15" });
    appendToNode(handle, ws.vault, m.id, "hello", tracker);
    expect(tracker.wasRecentSelfWrite(m.absPath)).toBe(true);
  });
});

describe("updateNodeStatus", () => {
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

  test("sets frontmatter.status on a Task and preserves body + other FM keys", () => {
    const t = createNode(handle, ws.vault, {
      type: "Task",
      title: "Ship Toss",
      content: "# Ship Toss\n\nBody stays put.\n",
      metadata: { owner: "hyunjin", priority: "P1" },
    });
    const r = updateNodeStatus(handle, ws.vault, t.id, "in_progress");
    expect(r.previousStatus).toBeNull();
    expect(r.newStatus).toBe("in_progress");

    const raw = readFileSync(t.absPath, "utf8");
    const parsed = parseDoc({ relPath: t.mdPath, raw });
    expect(parsed.frontmatter.status).toBe("in_progress");
    expect(parsed.frontmatter.owner).toBe("hyunjin");
    expect(parsed.frontmatter.priority).toBe("P1");
    expect(parsed.body).toContain("Body stays put.");
  });

  test("returns the previous status when the node was already statused", () => {
    const t = createNode(handle, ws.vault, {
      type: "Task",
      title: "Stage",
      metadata: { status: "todo" },
    });
    const r = updateNodeStatus(handle, ws.vault, t.id, "done");
    expect(r.previousStatus).toBe("todo");
    expect(r.newStatus).toBe("done");
  });

  test("rejects non-Task nodes", () => {
    const d = createNode(handle, ws.vault, { type: "Document", title: "Spec" });
    expect(() => updateNodeStatus(handle, ws.vault, d.id, "done")).toThrow(
      /only Task nodes have a status field/,
    );
  });

  test("rejects invalid status values", () => {
    const t = createNode(handle, ws.vault, { type: "Task", title: "X" });
    expect(() => updateNodeStatus(handle, ws.vault, t.id, "in-progress")).toThrow(
      /invalid status/,
    );
    expect(() => updateNodeStatus(handle, ws.vault, t.id, "")).toThrow(/invalid status/);
  });

  test("rejects missing nodes", () => {
    expect(() => updateNodeStatus(handle, ws.vault, "task-nope", "done")).toThrow(
      /does not exist/,
    );
  });

  test("flips embedding_status back to 'pending'", () => {
    const t = createNode(handle, ws.vault, { type: "Task", title: "Flip me" });
    handle.raw
      .prepare("UPDATE nodes SET embedding_status = 'embedded' WHERE id = ?;")
      .run(t.id);
    updateNodeStatus(handle, ws.vault, t.id, "done");
    const row = handle.raw
      .prepare("SELECT embedding_status FROM nodes WHERE id = ?;")
      .get(t.id) as { embedding_status: string };
    expect(row.embedding_status).toBe("pending");
  });

  test("all TASK_STATUSES are accepted", () => {
    const t = createNode(handle, ws.vault, { type: "Task", title: "Cycle" });
    for (const s of TASK_STATUSES) {
      const r = updateNodeStatus(handle, ws.vault, t.id, s);
      expect(r.newStatus).toBe(s);
    }
  });
});
