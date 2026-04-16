import { and, eq, inArray, not } from "drizzle-orm";
import type { DbHandle } from "../storage/sqlite.ts";
import { nodes, edges, nodeChunks } from "../storage/schema.ts";
import { computeEdgeId } from "./ids.ts";
import type { GraphEdge, GraphNode, RelationType } from "./types.ts";
import type { ParsedDoc, DocChunk } from "../vault/parser.ts";
import { chunkDoc } from "../vault/parser.ts";

export interface UpsertResult {
  nodeId: string;
  edgesWritten: number;
  edgesDeleted: number;
  chunksWritten: number;
  chunksDeleted: number;
}

/** Deterministic chunk id: node-scoped index. Stable across reindexes as long
 *  as the ordered chunk list doesn't change; insertions / deletions shift
 *  suffix indices but UPSERT + "DELETE WHERE NOT IN" reconciles cleanly. */
function chunkIdFor(nodeId: string, chunkIdx: number): string {
  return `${nodeId}#${chunkIdx}`;
}

/**
 * Upserts a single parsed document's node + all edges it owns.
 *
 * Reconciliation semantics (single transaction):
 *   1. UPSERT the node row.
 *   2. For every edge declared by this file (frontmatter edges + body
 *      wiki-links), compute its deterministic id and UPSERT.
 *   3. DELETE any edge rows where source_file = F and edge_id NOT IN
 *      the set we just wrote. This is what prunes removed edges.
 *
 * All of that runs inside BEGIN IMMEDIATE ... COMMIT. If any step fails,
 * the whole reindex is rolled back — the file's edges never end up in a
 * partial state. This is the guarantee Lane C depends on when it starts
 * writing Decision nodes in week 3.
 */
export function upsertDocNodeAndEdges(handle: DbHandle, sourceFile: string, doc: ParsedDoc): UpsertResult {
  const now = Date.now();
  const frontmatterJson = JSON.stringify(doc.frontmatter ?? {});

  const desiredEdges: GraphEdge[] = [];

  for (const e of doc.fmEdges) {
    const edgeId = computeEdgeId({
      srcId: doc.id,
      relation: e.relation,
      dstId: e.to,
      sourceFile,
      sourceLine: 0,
    });
    desiredEdges.push({
      edgeId,
      srcId: doc.id,
      relation: e.relation,
      dstId: e.to,
      sourceFile,
      sourceLine: 0,
      createdAt: now,
    });
  }

  for (const link of doc.wikiLinks) {
    const rel: RelationType = "references";
    const edgeId = computeEdgeId({
      srcId: doc.id,
      relation: rel,
      dstId: link.target,
      sourceFile,
      sourceLine: link.line,
    });
    desiredEdges.push({
      edgeId,
      srcId: doc.id,
      relation: rel,
      dstId: link.target,
      sourceFile,
      sourceLine: link.line,
      createdAt: now,
    });
  }

  const deduped = new Map<string, GraphEdge>();
  for (const e of desiredEdges) deduped.set(e.edgeId, e);
  const uniqueEdges = [...deduped.values()];

  handle.raw.exec("BEGIN IMMEDIATE;");
  try {
    // Compare against any existing row to decide whether to flip
    // embedding_status back to 'pending'. The contract from W2 is: new
    // nodes or nodes whose content_hash changed need re-embedding; nodes
    // whose content_hash is identical retain their prior status (so
    // 'embedded' stays 'embedded' across no-op reindexes).
    const existing = handle.raw
      .prepare("SELECT content_hash, embedding_status FROM nodes WHERE id = ?;")
      .get(doc.id) as { content_hash: string | null; embedding_status: string } | null;

    const contentChanged = !existing || existing.content_hash !== doc.contentHash;
    const nextEmbeddingStatus = contentChanged ? "pending" : existing.embedding_status;

    handle.db
      .insert(nodes)
      .values({
        id: doc.id,
        type: doc.type,
        title: doc.title,
        content: doc.body,
        sourceFile,
        frontmatter: frontmatterJson,
        contentHash: doc.contentHash,
        mtime: now,
        createdAt: now,
        updatedAt: now,
        embeddingStatus: nextEmbeddingStatus,
      })
      .onConflictDoUpdate({
        target: nodes.id,
        set: {
          type: doc.type,
          title: doc.title,
          content: doc.body,
          sourceFile,
          frontmatter: frontmatterJson,
          contentHash: doc.contentHash,
          mtime: now,
          updatedAt: now,
          embeddingStatus: nextEmbeddingStatus,
        },
      })
      .run();

    for (const e of uniqueEdges) {
      handle.db
        .insert(edges)
        .values({
          edgeId: e.edgeId,
          srcId: e.srcId,
          relation: e.relation,
          dstId: e.dstId,
          sourceFile: e.sourceFile,
          sourceLine: e.sourceLine,
          createdAt: e.createdAt,
        })
        .onConflictDoUpdate({
          target: edges.edgeId,
          set: {
            srcId: e.srcId,
            relation: e.relation,
            dstId: e.dstId,
            sourceFile: e.sourceFile,
            sourceLine: e.sourceLine,
          },
        })
        .run();
    }

    // drizzle-orm/bun-sqlite's `.run()` is typed `void`, which hides the
    // bun:sqlite changes count we need. Drop to raw prepared statements for
    // the DELETE so we can return an accurate `edgesDeleted` to callers.
    const keepIds = uniqueEdges.map((e) => e.edgeId);
    let deletedCount = 0;
    if (keepIds.length === 0) {
      const res = handle.raw
        .prepare("DELETE FROM edges WHERE source_file = ?;")
        .run(sourceFile);
      deletedCount = typeof res.changes === "number" ? res.changes : 0;
    } else {
      const placeholders = keepIds.map(() => "?").join(",");
      const res = handle.raw
        .prepare(
          `DELETE FROM edges WHERE source_file = ? AND edge_id NOT IN (${placeholders});`,
        )
        .run(sourceFile, ...keepIds);
      deletedCount = typeof res.changes === "number" ? res.changes : 0;
    }

    // v0.2 chunks: heading-split retrieval units. Same atomicity as
    // edges — compute the desired set, UPSERT, then DELETE-NOT-IN.
    // embedding_status is preserved across reindexes for chunks whose
    // content_hash didn't change; edits flip the chunk back to 'pending'
    // so the next `kg embed` picks it up.
    const desiredChunks = chunkDoc(doc);
    const existingChunks = handle.raw
      .prepare(
        "SELECT chunk_id, content_hash, embedding_status FROM node_chunks WHERE node_id = ?;",
      )
      .all(doc.id) as Array<{ chunk_id: string; content_hash: string; embedding_status: string }>;
    const existingByChunkId = new Map(
      existingChunks.map((r) => [r.chunk_id, { hash: r.content_hash, status: r.embedding_status }]),
    );

    let chunksWritten = 0;
    const keepChunkIds: string[] = [];
    const upsertChunk = handle.raw.prepare(
      `INSERT INTO node_chunks (
         chunk_id, node_id, chunk_idx, heading, content, content_hash,
         start_line, end_line, embedding_status, embedding_error,
         embedding_updated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         chunk_idx = excluded.chunk_idx,
         heading = excluded.heading,
         content = excluded.content,
         content_hash = excluded.content_hash,
         start_line = excluded.start_line,
         end_line = excluded.end_line,
         embedding_status = excluded.embedding_status,
         embedding_error = CASE
           WHEN excluded.embedding_status = 'pending' THEN NULL
           ELSE node_chunks.embedding_error
         END,
         updated_at = excluded.updated_at;`,
    );
    for (const c of desiredChunks) {
      const id = chunkIdFor(doc.id, c.chunkIdx);
      keepChunkIds.push(id);
      const prior = existingByChunkId.get(id);
      const nextStatus = !prior || prior.hash !== c.contentHash ? "pending" : prior.status;
      upsertChunk.run(
        id,
        doc.id,
        c.chunkIdx,
        c.heading,
        c.content,
        c.contentHash,
        c.startLine,
        c.endLine,
        nextStatus,
        now,
        now,
      );
      chunksWritten += 1;
    }

    let chunksDeleted = 0;
    if (keepChunkIds.length === 0) {
      const res = handle.raw
        .prepare("DELETE FROM node_chunks WHERE node_id = ?;")
        .run(doc.id);
      chunksDeleted = typeof res.changes === "number" ? res.changes : 0;
    } else {
      const placeholders = keepChunkIds.map(() => "?").join(",");
      const res = handle.raw
        .prepare(
          `DELETE FROM node_chunks WHERE node_id = ? AND chunk_id NOT IN (${placeholders});`,
        )
        .run(doc.id, ...keepChunkIds);
      chunksDeleted = typeof res.changes === "number" ? res.changes : 0;
    }

    handle.raw.exec("COMMIT;");
    return {
      nodeId: doc.id,
      edgesWritten: uniqueEdges.length,
      edgesDeleted: deletedCount,
      chunksWritten,
      chunksDeleted,
    };
  } catch (err) {
    handle.raw.exec("ROLLBACK;");
    throw err;
  }
}

export interface NodeRow {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  sourceFile: string | null;
  frontmatter: string; // JSON
  mtime: number | null;
  updatedAt: number;
}

export function getNode(handle: DbHandle, id: string): NodeRow | null {
  const row = handle.db.select().from(nodes).where(eq(nodes.id, id)).get();
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    sourceFile: row.sourceFile,
    frontmatter: row.frontmatter,
    mtime: row.mtime,
    updatedAt: row.updatedAt,
  };
}

export function listEdgesFromFile(handle: DbHandle, sourceFile: string): GraphEdge[] {
  const rows = handle.db.select().from(edges).where(eq(edges.sourceFile, sourceFile)).all();
  return rows.map((r) => ({
    edgeId: r.edgeId,
    srcId: r.srcId,
    relation: r.relation as RelationType,
    dstId: r.dstId,
    sourceFile: r.sourceFile,
    sourceLine: r.sourceLine,
    createdAt: r.createdAt,
  }));
}

export function countNodes(handle: DbHandle): number {
  const row = handle.raw.prepare("SELECT COUNT(*) AS c FROM nodes;").get() as { c: number };
  return row.c;
}

export function countEdges(handle: DbHandle): number {
  const row = handle.raw.prepare("SELECT COUNT(*) AS c FROM edges;").get() as { c: number };
  return row.c;
}

// Re-exported for consumers (Lane B MCP / Lane C decision extractor).
export type { GraphEdge, GraphNode } from "./types.ts";
