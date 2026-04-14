import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

// Note: the `schema_version` meta table is owned by src/storage/migrate.ts,
// not the drizzle schema, so that migration bookkeeping cannot be confused
// with regular DB state. See migrate.ts:ensureSchemaVersionTable.

/**
 * nodes: authoritative graph node store.
 *
 * Source of truth split:
 *   - nodes.id, type, title, content, frontmatter: derived from MD file (MD wins)
 *   - nodes.content_hash, mtime: cache
 *   - edges, embeddings, history: SQLite is authoritative (see ADR-001)
 */
export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title"),
    content: text("content"),
    sourceFile: text("source_file"),
    frontmatter: text("frontmatter_json").notNull().default("{}"),
    contentHash: text("content_hash"),
    mtime: integer("mtime", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    byType: index("nodes_type_idx").on(t.type),
    bySourceFile: index("nodes_source_file_idx").on(t.sourceFile),
  }),
);

/**
 * edges: authoritative relation store.
 *
 * Primary key is deterministic: sha256(src|type|dst|source_file|source_line).
 * Rationale: reindexing a file recomputes the exact same edge_id for the same
 * (src, relation, dst, line) tuple, so UPSERT + "DELETE WHERE NOT IN" inside a
 * single transaction correctly reconciles a file's edges.
 *
 * source_line = 0 means the edge originated in the frontmatter `edges:` array
 * (no body line). source_line >= 1 is a 1-based body line number.
 */
export const edges = sqliteTable(
  "edges",
  {
    edgeId: text("edge_id").primaryKey(),
    srcId: text("src_id").notNull(),
    relation: text("relation").notNull(),
    dstId: text("dst_id").notNull(),
    sourceFile: text("source_file"),
    sourceLine: integer("source_line", { mode: "number" }).notNull().default(0),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    bySrc: index("edges_src_idx").on(t.srcId),
    byDst: index("edges_dst_idx").on(t.dstId),
    bySourceFile: index("edges_source_file_idx").on(t.sourceFile),
    byRelation: index("edges_relation_idx").on(t.relation),
  }),
);

/**
 * node_embeddings: metadata sidecar for the sqlite-vec virtual table.
 *
 * The actual vectors live in a virtual vec0 table (`node_vec`) created by
 * raw SQL in a post-migration hook (drizzle can't describe virtual tables).
 * This row stores (node_id, model, dim, updated_at) so the runtime can
 * invalidate stale vectors without touching the vec0 blob.
 */
export const nodeEmbeddings = sqliteTable(
  "node_embeddings",
  {
    nodeId: text("node_id").notNull(),
    model: text("model").notNull(),
    dim: integer("dim", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nodeId, t.model] }),
  }),
);
