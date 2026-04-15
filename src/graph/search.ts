import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "../storage/sqlite.ts";
import { requireVec } from "../storage/sqlite.ts";
import { edges, nodes } from "../storage/schema.ts";
import type { EmbedClient } from "../embeddings/client.ts";
import type { RelationType, GraphEdge } from "./types.ts";

export interface SearchNode {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  sourceFile: string | null;
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
  node: SearchNode;
  directEdges: Neighbor[];
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

/**
 * Batched 1-hop neighbor fetch. One SELECT per direction over every hit id,
 * rather than N per-hit round-trips. Result is grouped by the "anchor" id
 * (src for outgoing, dst for incoming). Per-anchor truncation to
 * `neighborCap` happens in the caller so we don't lose edges to a global
 * LIMIT when one anchor has many edges.
 *
 * For multi-hop (v1.1+) this is the natural place to swap in a recursive
 * CTE. 1-hop alone doesn't benefit from the CTE machinery.
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
 * Pipeline:
 *   1. Embed the query with the same client used for backfill (so dim
 *      matches node_vec).
 *   2. vec0 MATCH with k = opts.k (default 20).
 *   3. Join hits to `nodes` for display fields.
 *   4. For each hit, fetch outgoing and incoming edges (capped at
 *      opts.neighborCap) and resolve each edge's far-side node.
 *
 * Failure modes:
 *   - requireVec throws loudly if sqlite-vec isn't loaded.
 *   - Empty `node_vec` (no embedded nodes yet) → returns [] silently. The
 *     caller (kg ask) is responsible for the user-facing "no relevant
 *     nodes" message — search does not inject prose.
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
      `SELECT node_id, distance FROM node_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance;`,
    )
    .all(queryBuf, k) as Array<{ node_id: string; distance: number }>;

  if (hits.length === 0) return [];

  // Two batched SELECTs (one per direction) instead of 2×k round-trips.
  const hitIds = hits.map((h) => h.node_id);
  const outgoingByHit = fetchOutgoingByIds(handle, hitIds);
  const incomingByHit = fetchIncomingByIds(handle, hitIds);
  const farSideIds = new Set<string>();
  for (const edgesFrom of outgoingByHit.values()) {
    for (const e of edgesFrom) farSideIds.add(e.dstId);
  }
  for (const edgesInto of incomingByHit.values()) {
    for (const e of edgesInto) farSideIds.add(e.srcId);
  }
  const allIds = new Set<string>([...hitIds, ...farSideIds]);
  const nodeMap = fetchNodes(handle, [...allIds]);

  const results: SearchHit[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const self = nodeMap.get(h.node_id);
    if (!self) continue; // vec row without corresponding node row — skip
    const outs = (outgoingByHit.get(h.node_id) ?? []).slice(0, neighborCap);
    const ins = (incomingByHit.get(h.node_id) ?? []).slice(0, neighborCap);
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
      node: self,
      directEdges,
      inverseEdges,
    });
  }
  return results;
}

/**
 * Formatter for human/agent consumption. Produces a concise JSON-ish
 * representation; kg ask and MCP server both call this.
 */
export function formatHits(hits: SearchHit[]): Array<Record<string, unknown>> {
  return hits.map((h) => ({
    rank: h.rank,
    distance: Number(h.distance.toFixed(4)),
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
