/**
 * v0.2 chunking tests — parser (unit) + engine (integration) coverage.
 *
 * Scope for Day 1: parser splits docs deterministically, engine upserts
 * the set into `node_chunks` inside the same transaction as the node
 * upsert, and reindex preserves embedding_status only when content_hash
 * matches. Day 2 (search / backfill / ask over chunks) is a separate
 * commit.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { importVault } from "../src/vault/import.ts";
import { chunkDoc, parseDoc } from "../src/vault/parser.ts";

function mkWorkspace() {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-chunking-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  return { dir, vault, db };
}

describe("chunkDoc (parser unit)", () => {
  test("no-heading doc produces a single chunk covering the whole body", () => {
    const body = "Just some prose.\n\nA second paragraph.\n";
    const chunks = chunkDoc({ body, bodyStartLine: 5 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[0]?.content).toBe(body);
    expect(chunks[0]?.startLine).toBe(5);
    expect(chunks[0]?.chunkIdx).toBe(0);
    expect(chunks[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty body still produces one chunk (title-only node)", () => {
    const chunks = chunkDoc({ body: "", bodyStartLine: 3 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[0]?.content).toBe("");
  });

  test("intro + H2 sections produce per-heading chunks with correct lines", () => {
    const body = [
      "Intro paragraph.", // body line 1
      "",
      "## Overview", // line 3
      "Overview content.",
      "",
      "## Details", // line 6
      "Details content.",
      "",
    ].join("\n");
    // Give each section enough bulk so nothing merges into another.
    const fatBody =
      body.replace("Intro paragraph.", "Intro paragraph. " + "x ".repeat(300))
          .replace("Overview content.", "Overview content. " + "x ".repeat(300))
          .replace("Details content.", "Details content. " + "x ".repeat(300));
    const chunks = chunkDoc({ body: fatBody, bodyStartLine: 5 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[0]?.content.startsWith("Intro paragraph.")).toBe(true);
    expect(chunks[1]?.heading).toBe("Overview");
    expect(chunks[1]?.content.startsWith("## Overview")).toBe(true);
    expect(chunks[2]?.heading).toBe("Details");
    expect(chunks[2]?.content.startsWith("## Details")).toBe(true);
    // chunk_idx is monotonically increasing from 0.
    expect(chunks.map((c) => c.chunkIdx)).toEqual([0, 1, 2]);
    // Line numbers offset from bodyStartLine=5 and remain monotonic.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.endLine - 1);
    }
  });

  test("tiny trailing section merges into the previous chunk", () => {
    const body = [
      "## Big",
      "x ".repeat(1000), // well above MIN (400)
      "",
      "## Tiny",
      "short",
      "",
    ].join("\n");
    const chunks = chunkDoc({ body, bodyStartLine: 1 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.heading).toBe("Big");
    expect(chunks[0]?.content).toContain("## Big");
    expect(chunks[0]?.content).toContain("## Tiny");
    expect(chunks[0]?.content).toContain("short");
  });

  test("oversize H2 section sub-splits at H3 and preserves the H2 heading on the first sub", () => {
    const hugeParagraph = "x ".repeat(1500); // ~3000 chars
    const body = [
      "## Parent",
      "parent intro", // tiny intro under Parent, before any H3
      "",
      "### First sub",
      hugeParagraph,
      "",
      "### Second sub",
      hugeParagraph,
      "",
    ].join("\n");
    const chunks = chunkDoc({ body, bodyStartLine: 1 });
    // Expect 2 H3 sub-chunks (too small Parent-intro gets absorbed into
    // the first sub when the splitter runs, or it merges back later).
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The FIRST chunk carries the H2 heading line so Parent context survives.
    expect(chunks[0]?.content).toContain("## Parent");
    // Every sub-chunk's heading is either the H2 or an H3 — never null.
    for (const c of chunks) {
      expect(c.heading).not.toBeNull();
    }
  });

  test("Korean headings round-trip through chunker", () => {
    const body = [
      "## 개요",
      "본문1 " + "x ".repeat(300),
      "",
      "## 결정",
      "본문2 " + "x ".repeat(300),
      "",
    ].join("\n");
    const chunks = chunkDoc({ body, bodyStartLine: 1 });
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.heading).toBe("개요");
    expect(chunks[1]?.heading).toBe("결정");
  });

  test("parsed doc + chunkDoc integration", () => {
    const raw = [
      "---",
      "id: doc-payment",
      "type: Document",
      "title: Payment spec",
      "---",
      "",
      "## Goals",
      "Goals " + "x ".repeat(300),
      "",
      "## Non-goals",
      "Non-goals " + "x ".repeat(300),
      "",
    ].join("\n");
    const doc = parseDoc({ relPath: "docs/payment.md", raw });
    const chunks = chunkDoc(doc);
    // bodyStartLine should offset start/end lines to the real file.
    expect(chunks[0]?.startLine).toBeGreaterThanOrEqual(doc.bodyStartLine);
  });
});

describe("engine: chunks are upserted inside the node transaction", () => {
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

  test("importing a multi-section doc populates node_chunks", () => {
    writeFileSync(
      join(ws.vault, "spec.md"),
      [
        "---",
        "id: doc-spec",
        "type: Document",
        "title: Payment spec",
        "---",
        "# Payment spec",
        "",
        "## Goals",
        "Goals " + "x ".repeat(300),
        "",
        "## Risks",
        "Risks " + "x ".repeat(300),
        "",
      ].join("\n"),
    );
    importVault(handle, ws.vault);

    const rows = handle.raw
      .prepare("SELECT chunk_id, node_id, chunk_idx, heading, embedding_status FROM node_chunks ORDER BY chunk_idx;")
      .all() as Array<{
        chunk_id: string;
        node_id: string;
        chunk_idx: number;
        heading: string | null;
        embedding_status: string;
      }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.node_id).toBe("doc-spec");
    expect(rows[0]?.chunk_id).toBe("doc-spec#0");
    // All chunks land as 'pending' on first import.
    for (const r of rows) expect(r.embedding_status).toBe("pending");
    const headings = rows.map((r) => r.heading);
    expect(headings).toContain("Goals");
    expect(headings).toContain("Risks");
  });

  test("reindexing an unchanged file preserves chunk embedding_status", () => {
    writeFileSync(
      join(ws.vault, "spec.md"),
      [
        "---",
        "id: doc-spec",
        "type: Document",
        "title: Spec",
        "---",
        "## A",
        "A " + "x ".repeat(300),
        "",
        "## B",
        "B " + "x ".repeat(300),
        "",
      ].join("\n"),
    );
    importVault(handle, ws.vault);

    // Simulate a past backfill run.
    handle.raw
      .prepare("UPDATE node_chunks SET embedding_status='embedded' WHERE node_id=?;")
      .run("doc-spec");

    // Re-import with identical content.
    importVault(handle, ws.vault);

    const statuses = handle.raw
      .prepare("SELECT embedding_status FROM node_chunks WHERE node_id=?;")
      .all("doc-spec") as Array<{ embedding_status: string }>;
    for (const r of statuses) expect(r.embedding_status).toBe("embedded");
  });

  test("editing one chunk flips only that chunk back to 'pending'", () => {
    const filePath = join(ws.vault, "spec.md");
    writeFileSync(
      filePath,
      [
        "---",
        "id: doc-spec",
        "type: Document",
        "title: Spec",
        "---",
        "## A",
        "A " + "x ".repeat(300),
        "",
        "## B",
        "B " + "x ".repeat(300),
        "",
      ].join("\n"),
    );
    importVault(handle, ws.vault);
    handle.raw
      .prepare("UPDATE node_chunks SET embedding_status='embedded' WHERE node_id=?;")
      .run("doc-spec");

    // Edit only the B section.
    writeFileSync(
      filePath,
      [
        "---",
        "id: doc-spec",
        "type: Document",
        "title: Spec",
        "---",
        "## A",
        "A " + "x ".repeat(300),
        "",
        "## B",
        "B (edited) " + "x ".repeat(300),
        "",
      ].join("\n"),
    );
    importVault(handle, ws.vault);

    const rows = handle.raw
      .prepare(
        "SELECT heading, embedding_status FROM node_chunks WHERE node_id=? ORDER BY chunk_idx;",
      )
      .all("doc-spec") as Array<{ heading: string; embedding_status: string }>;
    const aRow = rows.find((r) => r.heading === "A");
    const bRow = rows.find((r) => r.heading === "B");
    expect(aRow?.embedding_status).toBe("embedded");
    expect(bRow?.embedding_status).toBe("pending");
  });

  test("removing a section prunes its chunk row", () => {
    const filePath = join(ws.vault, "spec.md");
    writeFileSync(
      filePath,
      [
        "---",
        "id: doc-spec",
        "type: Document",
        "title: Spec",
        "---",
        "## A",
        "A " + "x ".repeat(300),
        "",
        "## B",
        "B " + "x ".repeat(300),
        "",
      ].join("\n"),
    );
    importVault(handle, ws.vault);
    const before = handle.raw
      .prepare("SELECT COUNT(*) AS c FROM node_chunks WHERE node_id=?;")
      .get("doc-spec") as { c: number };
    expect(before.c).toBeGreaterThanOrEqual(2);

    // Drop the B section.
    writeFileSync(
      filePath,
      [
        "---",
        "id: doc-spec",
        "type: Document",
        "title: Spec",
        "---",
        "## A",
        "A " + "x ".repeat(300),
        "",
      ].join("\n"),
    );
    importVault(handle, ws.vault);

    const after = handle.raw
      .prepare(
        "SELECT heading FROM node_chunks WHERE node_id=? ORDER BY chunk_idx;",
      )
      .all("doc-spec") as Array<{ heading: string }>;
    expect(after.some((r) => r.heading === "B")).toBe(false);
  });
});
