import { inArray } from "drizzle-orm";
import type { DbHandle } from "../storage/sqlite.ts";
import { requireVec } from "../storage/sqlite.ts";
import { edges, nodes } from "../storage/schema.ts";
import type { EmbedClient } from "../embeddings/client.ts";
import type { RelationType, GraphEdge } from "./types.ts";

/**
 * Chunk-level search (v0.2).
 *
 * Shape change from v0.1: hits are now CHUNKS, not nodes. Each hit carries
 * the chunk content + heading alongside its parent node's row and 1-hop
 * edges. Rationale: v0.1's whole-doc embeddings lost tail-of-document
 * signal on 15KB+ design docs; chunk embeddings restore it. Parent nodes
 * still host the edges, so the 1-hop expansion walks `edges.src_id = <parent>`
 * or `edges.dst_id = <parent>` regardless of which chunk was the hit.
 */

export interface SearchNode {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  sourceFile: string | null;
}

export interface SearchChunk {
  chunkId: string;
  nodeId: string;
  chunkIdx: number;
  heading: string | null;
  content: string;
  startLine: number;
  endLine: number;
}

export interface Neighbor {
  relation: RelationType;
  node: SearchNode | null; // null when the edge references an id that has no row yet
  dangling: boolean;
  sourceLine: number;
}

export interface SearchHit {
  rank: number;
  distance: number;
  /** The chunk that matched the query vector. */
  chunk: SearchChunk;
  /** The chunk's parent node (row from `nodes`). Always present — chunks
   *  are FK'd into nodes via ON DELETE CASCADE (see schema). */
  node: SearchNode;
  /** Edges leaving the parent node. */
  directEdges: Neighbor[];
  /** Edges into the parent node. */
  inverseEdges: Neighbor[];
}

export interface SearchOptions {
  /** Top-k for the vec0 MATCH query. Default 20. */
  k?: number;
  /** Cap on neighbors expanded per hit, per direction. Default 20 (generous). */
  neighborCap?: number;
}

function fetchNodes(handle: DbHandle, ids: readonly string[]): Map<string, SearchNode> {
  if (ids.length === 0) return new Map();
  const rows = handle.db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      content: nodes.content,
      sourceFile: nodes.sourceFile,
    })
    .from(nodes)
    .where(inArray(nodes.id, [...ids]))
    .all();
  const map = new Map<string, SearchNode>();
  for (const r of rows) map.set(r.id, r);
  return map;
}

interface ChunkRow {
  chunk_id: string;
  node_id: string;
  chunk_idx: number;
  heading: string | null;
  content: string;
  start_line: number;
  end_line: number;
}

function fetchChunks(handle: DbHandle, chunkIds: readonly string[]): Map<string, SearchChunk> {
  const map = new Map<string, SearchChunk>();
  if (chunkIds.length === 0) return map;
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = handle.raw
    .prepare(
      `SELECT chunk_id, node_id, chunk_idx, heading, content, start_line, end_line
       FROM node_chunks
       WHERE chunk_id IN (${placeholders});`,
    )
    .all(...chunkIds) as ChunkRow[];
  for (const r of rows) {
    map.set(r.chunk_id, {
      chunkId: r.chunk_id,
      nodeId: r.node_id,
      chunkIdx: r.chunk_idx,
      heading: r.heading,
      content: r.content,
      startLine: r.start_line,
      endLine: r.end_line,
    });
  }
  return map;
}

/**
 * Batched 1-hop neighbor fetch, keyed on PARENT NODE ids (not chunk ids).
 * The graph carries edges between nodes; a single hit chunk and all its
 * sibling chunks share the parent node's edges. Deduplicating on the
 * parent id avoids issuing the same edge-list query once per chunk hit.
 */
function fetchOutgoingByIds(handle: DbHandle, srcIds: readonly string[]): Map<string, GraphEdge[]> {
  const out = new Map<string, GraphEdge[]>();
  if (srcIds.length === 0) return out;
  const rows = handle.db
    .select()
    .from(edges)
    .where(inArray(edges.srcId, [...srcIds]))
    .all();
  for (const r of rows) {
    const bucket = out.get(r.srcId) ?? [];
    bucket.push({
      edgeId: r.edgeId,
      srcId: r.srcId,
      relation: r.relation as RelationType,
      dstId: r.dstId,
      sourceFile: r.sourceFile,
      sourceLine: r.sourceLine,
      createdAt: r.createdAt,
    });
    out.set(r.srcId, bucket);
  }
  return out;
}

function fetchIncomingByIds(handle: DbHandle, dstIds: readonly string[]): Map<string, GraphEdge[]> {
  const out = new Map<string, GraphEdge[]>();
  if (dstIds.length === 0) return out;
  const rows = handle.db
    .select()
    .from(edges)
    .where(inArray(edges.dstId, [...dstIds]))
    .all();
  for (const r of rows) {
    const bucket = out.get(r.dstId) ?? [];
    bucket.push({
      edgeId: r.edgeId,
      srcId: r.srcId,
      relation: r.relation as RelationType,
      dstId: r.dstId,
      sourceFile: r.sourceFile,
      sourceLine: r.sourceLine,
      createdAt: r.createdAt,
    });
    out.set(r.dstId, bucket);
  }
  return out;
}

/**
 * Embedding-backed search + 1-hop neighbor expansion.
 *
 * Pipeline (v0.2):
 *   1. Embed the query with the same client used for backfill.
 *   2. vec0 MATCH against `chunk_vec` with k = opts.k (default 20).
 *   3. Join hit chunk_ids → node_chunks (content + heading) → nodes
 *      (parent row).
 *   4. For each unique parent node, fetch 1-hop edges and resolve
 *      far-side node metadata. Cap per anchor at opts.neighborCap.
 *
 * Failure modes:
 *   - requireVec throws loudly if sqlite-vec isn't loaded.
 *   - Empty `chunk_vec` → returns [] silently. The caller (kg ask) is
 *     responsible for the "no relevant nodes" message.
 */
export async function search(
  handle: DbHandle,
  client: EmbedClient,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  requireVec(handle);
  const trimmed = query.trim();
  if (!trimmed) return [];
  const k = opts.k ?? 20;
  const neighborCap = opts.neighborCap ?? 20;

  const [queryVec] = await client.embed([trimmed]);
  if (!queryVec) return [];
  const queryBuf = new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

  const hits = handle.raw
    .prepare(
      `SELECT chunk_id, distance FROM chunk_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance;`,
    )
    .all(queryBuf, k) as Array<{ chunk_id: string; distance: number }>;

  if (hits.length === 0) return [];

  const chunkIds = hits.map((h) => h.chunk_id);
  const chunkMap = fetchChunks(handle, chunkIds);

  // De-duplicate the parent node ids — one batched edge fetch per
  // direction even when several hits share the same parent.
  const parentNodeIds = Array.from(
    new Set(
      chunkIds
        .map((id) => chunkMap.get(id)?.nodeId)
        .filter((x): x is string => typeof x === "string"),
    ),
  );
  const outgoingByNode = fetchOutgoingByIds(handle, parentNodeIds);
  const incomingByNode = fetchIncomingByIds(handle, parentNodeIds);
  const farSideIds = new Set<string>();
  for (const out of outgoingByNode.values()) {
    for (const e of out) farSideIds.add(e.dstId);
  }
  for (const inc of incomingByNode.values()) {
    for (const e of inc) farSideIds.add(e.srcId);
  }
  const allNodeIds = new Set<string>([...parentNodeIds, ...farSideIds]);
  const nodeMap = fetchNodes(handle, [...allNodeIds]);

  const results: SearchHit[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const chunk = chunkMap.get(h.chunk_id);
    if (!chunk) continue; // vec row without corresponding chunk — skip
    const parent = nodeMap.get(chunk.nodeId);
    if (!parent) continue; // parent deleted mid-query — skip

    const outs = (outgoingByNode.get(chunk.nodeId) ?? []).slice(0, neighborCap);
    const ins = (incomingByNode.get(chunk.nodeId) ?? []).slice(0, neighborCap);
    const directEdges: Neighbor[] = outs.map((e) => {
      const n = nodeMap.get(e.dstId);
      return {
        relation: e.relation,
        node: n ?? null,
        dangling: !n,
        sourceLine: e.sourceLine,
      };
    });
    const inverseEdges: Neighbor[] = ins.map((e) => {
      const n = nodeMap.get(e.srcId);
      return {
        relation: e.relation,
        node: n ?? null,
        dangling: !n,
        sourceLine: e.sourceLine,
      };
    });

    results.push({
      rank: i + 1,
      distance: h.distance,
      chunk,
      node: parent,
      directEdges,
      inverseEdges,
    });
  }
  return results;
}

/**
 * Formatter for human/agent consumption. Produces a concise JSON-ish
 * representation; kg ask and MCP server both call this.
 *
 * Citation-friendly shape: each hit carries a ready-made `cite` string
 * (`node-id` or `node-id#heading`) that the ask prompt instructs the
 * LLM to reproduce verbatim, and the MCP client can use to deep-link
 * back into the vault file at start_line.
 */
export function formatHits(hits: SearchHit[]): Array<Record<string, unknown>> {
  return hits.map((h) => ({
    rank: h.rank,
    distance: Number(h.distance.toFixed(4)),
    cite: citationFor(h),
    chunk: {
      chunkId: h.chunk.chunkId,
      heading: h.chunk.heading,
      startLine: h.chunk.startLine,
      endLine: h.chunk.endLine,
    },
    node: {
      id: h.node.id,
      type: h.node.type,
      title: h.node.title,
      sourceFile: h.node.sourceFile,
    },
    directEdges: h.directEdges.map((n) => ({
      relation: n.relation,
      to: n.node?.id ?? null,
      title: n.node?.title ?? null,
      dangling: n.dangling,
    })),
    inverseEdges: h.inverseEdges.map((n) => ({
      relation: n.relation,
      from: n.node?.id ?? null,
      title: n.node?.title ?? null,
      dangling: n.dangling,
    })),
  }));
}

/** Canonical citation string for a chunk hit. Format: `node-id#heading`
 *  when a heading is present, bare `node-id` otherwise. The ask prompt
 *  asks the LLM to reproduce these verbatim inside `[[…]]` so the user
 *  can open the file at the exact section. */
export function citationFor(h: { node: SearchNode; chunk: SearchChunk }): string {
  return h.chunk.heading ? `${h.node.id}#${h.chunk.heading}` : h.node.id;
}
