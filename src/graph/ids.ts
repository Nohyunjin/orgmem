import { createHash } from "node:crypto";
import type { RelationType } from "./types.ts";

/**
 * Deterministic edge id.
 *
 * Key rule: the same (src_id, relation, dst_id, source_file, source_line)
 * tuple ALWAYS hashes to the same id, across process restarts and across
 * machines. This is what makes "reindex file F in a single transaction"
 * correct — we recompute every edge id, UPSERT the current set, and DELETE
 * any previously-stored edge_id on this file that isn't in the current set.
 *
 * source_line = 0 is reserved for frontmatter-origin edges (i.e. the
 * `edges:` YAML array). Body-origin edges (wiki-links, inline references)
 * carry their 1-based line number. This separation prevents collisions
 * when the same src/rel/dst appears in both frontmatter and body.
 */
export interface EdgeIdInput {
  srcId: string;
  relation: RelationType;
  dstId: string;
  sourceFile: string; // canonical (relative-to-vault) path
  sourceLine: number; // 0 for frontmatter; >= 1 for body
}

export function computeEdgeId(input: EdgeIdInput): string {
  const payload = `${input.srcId}|${input.relation}|${input.dstId}|${input.sourceFile}|${input.sourceLine}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
