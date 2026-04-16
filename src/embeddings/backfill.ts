import type { DbHandle } from "../storage/sqlite.ts";
import { requireVec } from "../storage/sqlite.ts";
import type { EmbedClient } from "./client.ts";
import { EMBEDDING_MODEL } from "./model.ts";

/**
 * Chunk-level backfill (v0.2).
 *
 * v0.1 embedded one vector per node; on docs >5KB this averaged away
 * tail-of-document signal that dogfood queries depended on. v0.2
 * switches the retrieval unit to heading-split chunks (see
 * src/vault/parser.ts::chunkDoc). This module now walks `node_chunks`
 * instead of `nodes` and writes to `chunk_vec` instead of `node_vec`.
 *
 * Input row shape reflects the join we need to build the embed input:
 * parent node title gives the chunk a short anchor ("Payment spec"),
 * heading scopes the section ("Goals"), content is the meat. Without
 * the title prefix, a chunk called "Goals" retrieves weakly against
 * queries that mention the parent doc's subject.
 */
export interface PendingChunk {
  chunkId: string;
  nodeId: string;
  chunkIdx: number;
  heading: string | null;
  content: string;
  nodeTitle: string | null;
  nodeType: string;
}

export interface BackfillOptions {
  batchSize?: number; // default 32
  maxBatches?: number; // cap total batches for a single invocation; default unlimited
  retryFailed?: boolean; // flip 'failed' rows back to 'pending' before running
  onProgress?: (info: ProgressEvent) => void;
}

export interface ProgressEvent {
  phase: "start" | "batch" | "done";
  processed: number;
  total: number;
  failed: number;
  batchIndex?: number;
  batchSize?: number;
}

export interface BackfillReport {
  model: string;
  processed: number;
  embedded: number;
  failed: number;
  total: number;
  batchesRun: number;
  durationMs: number;
}

/**
 * Builds the text we actually embed for a single chunk. Three pieces,
 * separated by blank lines, so the vector anchors on doc subject →
 * section heading → section body:
 *   1. parent node title (if present)
 *   2. chunk heading (if present)
 *   3. chunk content (heading line included inside `content` already
 *      for H2-split chunks — we still prefix the bare heading so the
 *      encoder sees it twice, which empirically helps disambiguation
 *      on short chunks)
 *
 * Coarse safety cap at 8000 chars mirrors OpenAI's input ceiling for
 * text-embedding-3-small. In practice chunks should be ≤ MAX_CHUNK_CHARS
 * (6000) from the parser so this almost never trims anything.
 */
export function embeddingInputFor(row: PendingChunk): string {
  const parts: string[] = [];
  if (row.nodeTitle) parts.push(row.nodeTitle);
  if (row.heading) parts.push(row.heading);
  if (row.content) parts.push(row.content);
  if (parts.length === 0) parts.push(row.chunkId);
  return parts.join("\n\n").slice(0, 8000);
}

function fetchPending(handle: DbHandle, limit: number): PendingChunk[] {
  // Join to nodes for title + type; we need both to construct a
  // meaningful embedding input. updated_at order keeps FIFO fairness
  // across re-imports.
  return handle.raw
    .prepare(
      `SELECT c.chunk_id AS chunkId,
              c.node_id  AS nodeId,
              c.chunk_idx AS chunkIdx,
              c.heading  AS heading,
              c.content  AS content,
              n.title    AS nodeTitle,
              n.type     AS nodeType
       FROM node_chunks c
       JOIN nodes n ON n.id = c.node_id
       WHERE c.embedding_status = 'pending'
       ORDER BY c.updated_at ASC
       LIMIT ?;`,
    )
    .all(limit) as PendingChunk[];
}

function countPending(handle: DbHandle): number {
  const row = handle.raw
    .prepare("SELECT COUNT(*) AS c FROM node_chunks WHERE embedding_status = 'pending';")
    .get() as { c: number };
  return row.c;
}

function resetFailed(handle: DbHandle): number {
  const res = handle.raw
    .prepare(
      "UPDATE node_chunks SET embedding_status='pending', embedding_error=NULL WHERE embedding_status='failed';",
    )
    .run();
  return typeof res.changes === "number" ? res.changes : 0;
}

/**
 * Writes a batch of (chunk_id, vector) pairs atomically:
 *   - INSERT OR REPLACE into chunk_vec
 *   - UPDATE node_chunks.embedding_status='embedded', embedding_updated_at=now
 *
 * If the transaction aborts, neither the vec row nor the status flip
 * survive — the chunk stays 'pending' and the next --resume call picks
 * it up again.
 */
function writeBatch(
  handle: DbHandle,
  items: Array<{ chunkId: string; vector: Float32Array }>,
): void {
  handle.raw.exec("BEGIN IMMEDIATE;");
  try {
    const now = Date.now();
    const insertVec = handle.raw.prepare(
      "INSERT OR REPLACE INTO chunk_vec (chunk_id, embedding) VALUES (?, ?);",
    );
    const updateStatus = handle.raw.prepare(
      "UPDATE node_chunks SET embedding_status='embedded', embedding_error=NULL, embedding_updated_at=? WHERE chunk_id=?;",
    );
    for (const { chunkId, vector } of items) {
      insertVec.run(chunkId, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
      updateStatus.run(now, chunkId);
    }
    handle.raw.exec("COMMIT;");
  } catch (err) {
    handle.raw.exec("ROLLBACK;");
    throw err;
  }
}

function markFailed(handle: DbHandle, ids: readonly string[], message: string): void {
  if (ids.length === 0) return;
  handle.raw.exec("BEGIN IMMEDIATE;");
  try {
    const stmt = handle.raw.prepare(
      "UPDATE node_chunks SET embedding_status='failed', embedding_error=? WHERE chunk_id=?;",
    );
    for (const id of ids) stmt.run(message.slice(0, 500), id);
    handle.raw.exec("COMMIT;");
  } catch (err) {
    handle.raw.exec("ROLLBACK;");
    throw err;
  }
}

export async function runBackfill(
  handle: DbHandle,
  client: EmbedClient,
  opts: BackfillOptions = {},
): Promise<BackfillReport> {
  // Search gate: embedding_status == 'embedded' ONLY matters if vec is loaded,
  // but the same is true for writing vecs. Call requireVec explicitly so the
  // user gets the loud error path rather than a silent no-op.
  requireVec(handle);

  const batchSize = opts.batchSize ?? 32;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;

  if (opts.retryFailed) resetFailed(handle);

  const total = countPending(handle);
  const start = performance.now();
  let processed = 0;
  let embedded = 0;
  let failed = 0;
  let batchesRun = 0;

  opts.onProgress?.({ phase: "start", processed, total, failed });

  while (batchesRun < maxBatches) {
    const batch = fetchPending(handle, batchSize);
    if (batch.length === 0) break;

    const inputs = batch.map((r) => embeddingInputFor(r));
    try {
      const vectors = await client.embed(inputs);
      if (vectors.length !== batch.length) {
        throw new Error(
          `embed() returned ${vectors.length} vectors for ${batch.length} inputs`,
        );
      }
      const items = batch.map((r, i) => ({ chunkId: r.chunkId, vector: vectors[i]! }));
      writeBatch(handle, items);
      embedded += batch.length;
    } catch (err) {
      markFailed(handle, batch.map((r) => r.chunkId), (err as Error).message);
      failed += batch.length;
    }
    processed += batch.length;
    batchesRun += 1;

    opts.onProgress?.({
      phase: "batch",
      processed,
      total,
      failed,
      batchIndex: batchesRun - 1,
      batchSize: batch.length,
    });
  }

  const durationMs = Math.round(performance.now() - start);
  opts.onProgress?.({ phase: "done", processed, total, failed });
  return {
    model: EMBEDDING_MODEL,
    processed,
    embedded,
    failed,
    total,
    batchesRun,
    durationMs,
  };
}
