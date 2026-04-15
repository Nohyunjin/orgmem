import type { DbHandle } from "../storage/sqlite.ts";
import { requireVec } from "../storage/sqlite.ts";
import type { EmbedClient } from "./client.ts";
import { EMBEDDING_MODEL } from "./model.ts";

export interface PendingRow {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
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
 * Builds the text we actually embed. Concatenating title + content makes
 * queries like "payment spec" hit the node even when the content body
 * uses different vocabulary. Empty nodes fall back to the id so the vec
 * row still exists (required for k-NN coverage); id-only nodes will
 * rank poorly and that's fine.
 */
export function embeddingInputFor(row: PendingRow): string {
  const parts: string[] = [];
  if (row.title) parts.push(row.title);
  if (row.content) parts.push(row.content);
  if (parts.length === 0) parts.push(row.id);
  return parts.join("\n\n").slice(0, 8000); // coarse safety cap for token budget
}

function fetchPending(handle: DbHandle, limit: number): PendingRow[] {
  return handle.raw
    .prepare(
      `SELECT id, type, title, content FROM nodes
       WHERE embedding_status = 'pending'
       ORDER BY updated_at ASC
       LIMIT ?;`,
    )
    .all(limit) as PendingRow[];
}

function countPending(handle: DbHandle): number {
  const row = handle.raw
    .prepare("SELECT COUNT(*) AS c FROM nodes WHERE embedding_status = 'pending';")
    .get() as { c: number };
  return row.c;
}

function resetFailed(handle: DbHandle): number {
  const res = handle.raw
    .prepare(
      "UPDATE nodes SET embedding_status='pending', embedding_error=NULL WHERE embedding_status='failed';",
    )
    .run();
  return typeof res.changes === "number" ? res.changes : 0;
}

/**
 * Writes a batch of (node_id, vector) pairs atomically:
 *   - INSERT OR REPLACE into node_vec
 *   - UPDATE nodes.embedding_status='embedded', embedding_updated_at=now
 *
 * If the transaction aborts, neither the vec row nor the status flip
 * survive — the node stays 'pending' and the next --resume call picks
 * it up again.
 */
function writeBatch(
  handle: DbHandle,
  items: Array<{ id: string; vector: Float32Array }>,
): void {
  handle.raw.exec("BEGIN IMMEDIATE;");
  try {
    const now = Date.now();
    const insertVec = handle.raw.prepare(
      "INSERT OR REPLACE INTO node_vec (node_id, embedding) VALUES (?, ?);",
    );
    const updateStatus = handle.raw.prepare(
      "UPDATE nodes SET embedding_status='embedded', embedding_error=NULL, embedding_updated_at=? WHERE id=?;",
    );
    for (const { id, vector } of items) {
      insertVec.run(id, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
      updateStatus.run(now, id);
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
      "UPDATE nodes SET embedding_status='failed', embedding_error=? WHERE id=?;",
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
      const items = batch.map((r, i) => ({ id: r.id, vector: vectors[i]! }));
      writeBatch(handle, items);
      embedded += batch.length;
    } catch (err) {
      markFailed(handle, batch.map((r) => r.id), (err as Error).message);
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
