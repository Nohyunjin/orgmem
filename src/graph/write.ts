import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../storage/sqlite.ts";
import { nodes } from "../storage/schema.ts";
import { parseDoc, serializeDoc, type FrontmatterEdge } from "../vault/parser.ts";
import { upsertDocNodeAndEdges } from "./engine.ts";
import { computeEdgeId } from "./ids.ts";
import type { NodeType, RelationType } from "./types.ts";
import { NODE_TYPES, isNodeType, isRelationType, RELATION_TYPES } from "./types.ts";
import type { SelfWriteTracker } from "../vault/watcher.ts";

const TYPE_DIR: Record<NodeType, string> = {
  Document: "docs",
  Task: "tasks",
  Decision: "decisions",
  Meeting: "meetings",
  Person: "people",
};

/**
 * Hard cap on slug length measured in UTF-8 BYTES, not code units. 한글
 * is 3 bytes per character in UTF-8, so a 30-char Korean title is already
 * 90 bytes — well past APFS/ext4 practical comfort zones and prone to
 * bloating filenames past third-party tool limits (zip, some cloud sync
 * clients). 80 bytes leaves headroom for the date prefix ("YYYY-MM-DD-",
 * 11 bytes), ".md" (3 bytes), type directory, and the "-2"/"-3"
 * collision suffix, keeping worst-case file paths comfortably under
 * every modern FS's per-component 255-byte ceiling.
 */
export const SLUG_MAX_BYTES = 80;

/**
 * UTF-8 byte-bounded truncation that never splits a multi-byte character.
 * Walks backward from the byte cut point past any UTF-8 continuation bytes
 * (10xxxxxx) so the returned string is always a valid sequence of complete
 * code points. Trailing hyphens left behind by a mid-token cut are trimmed
 * so we don't produce ugly `결제-전환-` filenames.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const buf = enc.encode(s);
  if (buf.byteLength <= maxBytes) return s;
  let cut = maxBytes;
  // If we landed inside a multi-byte sequence (continuation byte 10xxxxxx),
  // walk back to the start of that code point.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  const truncated = new TextDecoder().decode(buf.subarray(0, cut));
  return truncated.replace(/-+$/, "");
}

/**
 * Slug rules:
 *   - keep ASCII alphanumerics, CJK (한글/漢字), and hyphens
 *   - collapse whitespace + punctuation runs to a single '-'
 *   - lowercase ASCII
 *   - trim leading/trailing '-'
 *   - cap the final slug at SLUG_MAX_BYTES bytes (UTF-8), cutting only on
 *     complete code-point boundaries
 *   - if the slug is empty after normalization (e.g. emoji-only title),
 *     fall back to a timestamp-based identifier
 */
export function slugify(input: string): string {
  const cleaned = input
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (cleaned.length === 0) return `untitled-${Date.now().toString(36)}`;
  return truncateToBytes(cleaned, SLUG_MAX_BYTES);
}

function todayIsoDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export interface CreateNodeInput {
  type: NodeType;
  title: string;
  content?: string;
  /** Arbitrary additional frontmatter keys (merged after id/type/title/edges). */
  metadata?: Record<string, unknown>;
  /** Initial frontmatter edges to include. */
  edges?: FrontmatterEdge[];
  /** Override the file date prefix for Decision/Meeting (default: today, local). */
  date?: string;
  /** Override the id (by default derived from type + slug, possibly + date). */
  id?: string;
  /** Caller-provided path override, relative to the vault root. */
  pathOverride?: string;
}

export interface CreateNodeResult {
  id: string;
  mdPath: string; // path relative to vault root
  absPath: string;
}

/**
 * Picks a non-colliding file path for a new node. If the ideal path is free,
 * returns it; otherwise appends -2, -3, ... until a free slot is found.
 */
function pickPath(vault: string, relPath: string): string {
  const abs = resolve(vault, relPath);
  if (!existsSync(abs)) return relPath;
  const ext = relPath.endsWith(".md") ? ".md" : "";
  const base = relPath.replace(/\.md$/, "");
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!existsSync(resolve(vault, candidate))) return candidate;
  }
  throw new Error(`Could not find a non-colliding path for ${relPath}`);
}

function defaultPathForType(type: NodeType, title: string, date?: string): string {
  const dir = TYPE_DIR[type];
  const slug = slugify(title);
  if (type === "Decision" || type === "Meeting") {
    return `${dir}/${date ?? todayIsoDate()}-${slug}.md`;
  }
  return `${dir}/${slug}.md`;
}

function deriveId(type: NodeType, title: string, date?: string): string {
  const slug = slugify(title);
  if (type === "Decision" || type === "Meeting") {
    return `${type.toLowerCase()}-${date ?? todayIsoDate()}-${slug}`;
  }
  return `${type.toLowerCase()}-${slug}`;
}

/**
 * Chooses a node id that doesn't collide with an existing row. Appends -2, -3
 * on collision so that createNode is safe to call repeatedly with the same
 * title. Uses the same rule as pickPath for path collisions — the two must
 * stay in lock-step so that source_file → id is a bijection per file.
 */
function pickId(handle: DbHandle, desired: string): string {
  const existing = handle.raw
    .prepare("SELECT 1 FROM nodes WHERE id = ? LIMIT 1;")
    .get(desired);
  if (!existing) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired}-${i}`;
    const row = handle.raw.prepare("SELECT 1 FROM nodes WHERE id = ? LIMIT 1;").get(candidate);
    if (!row) return candidate;
  }
  throw new Error(`Could not find a non-colliding id for ${desired}`);
}

/**
 * createNode: materializes a new graph node as a markdown file under the
 * vault and upserts it into SQLite in one go.
 *
 * Contract:
 *   - Writes the file to disk FIRST; registers the write with the SelfWriteTracker
 *     so the FS watcher (when live) won't double-reindex.
 *   - Upserts the node + any provided frontmatter edges inside the engine's
 *     single-transaction reindex path.
 *   - Returns the id (may differ from the caller's preferred id if there was
 *     a collision) and the mdPath relative to the vault root.
 *
 * This is the API that Lane C's Decision Extractor calls in week 3.
 */
export function createNode(
  handle: DbHandle,
  vaultPath: string,
  input: CreateNodeInput,
  tracker?: SelfWriteTracker,
): CreateNodeResult {
  if (!isNodeType(input.type)) {
    throw new Error(`Invalid node type '${input.type}'. Allowed: ${NODE_TYPES.join(", ")}`);
  }
  if (!input.title.trim()) {
    throw new Error("createNode: title is required (used for slug + file path derivation).");
  }
  for (const e of input.edges ?? []) {
    if (!isRelationType(e.relation)) {
      throw new Error(
        `createNode: invalid edge relation '${e.relation}'. Allowed: ${RELATION_TYPES.join(", ")}`,
      );
    }
  }

  const vault = resolve(vaultPath);
  const desiredPath = input.pathOverride ?? defaultPathForType(input.type, input.title, input.date);
  const mdPath = pickPath(vault, desiredPath);
  const absPath = resolve(vault, mdPath);

  const desiredId = input.id ?? deriveId(input.type, input.title, input.date);
  const id = pickId(handle, desiredId);

  // Build frontmatter: canonical keys first, then caller metadata (without
  // clobbering the canonical ones).
  const frontmatter: Record<string, unknown> = {
    id,
    type: input.type,
    title: input.title,
    ...(input.metadata ?? {}),
  };
  if (input.edges && input.edges.length > 0) {
    frontmatter.edges = input.edges.map((e) => ({ to: e.to, relation: e.relation }));
  }

  const body = input.content?.trim().length ? input.content : `# ${input.title}\n`;
  const bodyWithTrailingNewline = body.endsWith("\n") ? body : body + "\n";

  const initialDoc = {
    id,
    type: input.type,
    title: input.title,
    frontmatter,
    frontmatterRaw: null,
    body: bodyWithTrailingNewline,
    bodyStartLine: 1, // doesn't matter for serialization
    fmEdges: input.edges ?? [],
    wikiLinks: [],
    contentHash: "", // will be recomputed from disk
  };
  const rendered = serializeDoc(initialDoc);

  mkdirSync(dirname(absPath), { recursive: true });
  tracker?.markSelfWrite(absPath);
  writeFileSync(absPath, rendered, "utf8");

  // Now parse from disk to pick up the canonical contentHash + wiki-links.
  const raw = readFileSync(absPath, "utf8");
  const parsed = parseDoc({ relPath: mdPath, raw });
  if (parsed.id !== id) {
    // Safety net: if our serialize round-trip disagreed with the parser
    // about the id (shouldn't happen), fail loudly.
    throw new Error(
      `createNode: id drift after write (expected ${id}, got ${parsed.id} from ${mdPath})`,
    );
  }
  upsertDocNodeAndEdges(handle, mdPath, parsed);

  return { id, mdPath, absPath };
}

export interface CreateEdgeInput {
  srcId: string;
  relation: RelationType;
  dstId: string;
  /**
   * Optional 1-based body line for the edge. If omitted, the edge is recorded
   * in the source node's frontmatter `edges:` array (source_line = 0), which
   * is the path the MCP server should default to.
   */
  sourceLine?: number;
}

export interface CreateEdgeResult {
  edgeId: string;
  sourceFile: string;
  sourceLine: number;
  alreadyPresent: boolean;
}

/**
 * createEdge: adds an edge to the source node's markdown file and reindexes.
 *
 * Why write to the MD file (not just SQLite):
 *   SQLite is authoritative for edges, but MD is still the substrate a human
 *   (or Obsidian app) edits. Putting every agent-authored edge into the
 *   source node's frontmatter keeps the two views in sync — reindex from
 *   filesystem always reconstructs the same SQLite state, so someone
 *   nuking .orgmem/dev.db never loses edges.
 */
export function createEdge(
  handle: DbHandle,
  vaultPath: string,
  input: CreateEdgeInput,
  tracker?: SelfWriteTracker,
): CreateEdgeResult {
  if (!isRelationType(input.relation)) {
    throw new Error(
      `createEdge: invalid relation '${input.relation}'. Allowed: ${RELATION_TYPES.join(", ")}`,
    );
  }
  if (input.sourceLine !== undefined && input.sourceLine < 0) {
    throw new Error("createEdge: sourceLine must be >= 0");
  }

  const srcRow = handle.db.select().from(nodes).where(eq(nodes.id, input.srcId)).get();
  if (!srcRow) {
    throw new Error(`createEdge: src node '${input.srcId}' does not exist`);
  }
  if (!srcRow.sourceFile) {
    throw new Error(
      `createEdge: src node '${input.srcId}' has no source file on disk — cannot anchor a new edge to it`,
    );
  }

  const vault = resolve(vaultPath);
  const relPath = srcRow.sourceFile;
  const absPath = resolve(vault, relPath);
  if (!existsSync(absPath)) {
    throw new Error(`createEdge: src file missing on disk: ${absPath}`);
  }
  // Sanity: ensure the path is inside the vault.
  const rel = relative(vault, absPath);
  if (rel.startsWith("..")) {
    throw new Error(`createEdge: src file resolves outside the vault: ${absPath}`);
  }

  const sourceLine = input.sourceLine ?? 0;
  const expectedEdgeId = computeEdgeId({
    srcId: input.srcId,
    relation: input.relation,
    dstId: input.dstId,
    sourceFile: relPath,
    sourceLine,
  });

  const raw = readFileSync(absPath, "utf8");
  const parsed = parseDoc({ relPath, raw });

  // If the edge already lives in the file (by semantic match, not just id),
  // skip the write and just return — createEdge is idempotent.
  const alreadyPresent =
    sourceLine === 0 &&
    parsed.fmEdges.some((e) => e.to === input.dstId && e.relation === input.relation);

  if (alreadyPresent) {
    return {
      edgeId: expectedEdgeId,
      sourceFile: relPath,
      sourceLine,
      alreadyPresent: true,
    };
  }

  if (sourceLine !== 0) {
    throw new Error(
      "createEdge: non-zero sourceLine is not supported in week 2 — body-originated agent edges " +
        "require editing prose, which is an MCP-side concern. Use sourceLine=0 (frontmatter).",
    );
  }

  const mutatedFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  const updatedEdges: FrontmatterEdge[] = [
    ...parsed.fmEdges,
    { to: input.dstId, relation: input.relation },
  ];
  mutatedFrontmatter.edges = updatedEdges.map((e) => ({ to: e.to, relation: e.relation }));

  const rewritten = serializeDoc({
    ...parsed,
    frontmatter: mutatedFrontmatter,
    fmEdges: updatedEdges,
  });

  tracker?.markSelfWrite(absPath);
  writeFileSync(absPath, rewritten, "utf8");

  const reread = readFileSync(absPath, "utf8");
  const reparsed = parseDoc({ relPath, raw: reread });
  upsertDocNodeAndEdges(handle, relPath, reparsed);

  return {
    edgeId: expectedEdgeId,
    sourceFile: relPath,
    sourceLine: 0,
    alreadyPresent: false,
  };
}

/**
 * Allowed values for a Task node's frontmatter `status` field. Kept narrow
 * on purpose: this is the vocabulary Lane B's `task_update_status` tool
 * will validate against, and loosening it later is cheap; tightening is
 * expensive (agents will have written whatever they want to MD files).
 */
export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

export interface AppendToNodeResult {
  id: string;
  sourceFile: string;
  absPath: string;
  appendedChars: number;
}

/**
 * Append text to an existing node's markdown body, preserving frontmatter
 * (incl. edges and any third-party keys) and existing body content.
 *
 * NOT idempotent: calling twice with the same content appends two blocks.
 * That's the whole point — this exists for meeting-minute / daily-log
 * patterns where the agent streams updates into an existing node.
 *
 * Side effects:
 *   - File rewritten on disk with a blank-line separator between prior
 *     body and the appended block.
 *   - SelfWriteTracker notified (so a live FS watcher won't re-trigger).
 *   - Node reindexed; because raw bytes changed, engine flips
 *     `embedding_status` back to 'pending' (next `kg embed` will pick it up).
 *
 * Rejects when:
 *   - nodeId does not exist
 *   - node has no source_file (agent-only / unsupported)
 *   - content is empty/whitespace (silent append is almost always a bug)
 */
export function appendToNode(
  handle: DbHandle,
  vaultPath: string,
  nodeId: string,
  content: string,
  tracker?: SelfWriteTracker,
): AppendToNodeResult {
  const trimmedContent = content.replace(/\s+$/, "");
  if (trimmedContent.length === 0) {
    throw new Error("appendToNode: content must be non-empty (whitespace-only append rejected).");
  }

  const row = handle.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!row) {
    throw new Error(`appendToNode: node '${nodeId}' does not exist`);
  }
  if (!row.sourceFile) {
    throw new Error(
      `appendToNode: node '${nodeId}' has no source_file on disk — only file-backed nodes can be appended to`,
    );
  }

  const vault = resolve(vaultPath);
  const relPath = row.sourceFile;
  const absPath = resolve(vault, relPath);
  if (!existsSync(absPath)) {
    throw new Error(`appendToNode: source file missing on disk: ${absPath}`);
  }
  const rel = relative(vault, absPath);
  if (rel.startsWith("..")) {
    throw new Error(`appendToNode: source file resolves outside the vault: ${absPath}`);
  }

  const raw = readFileSync(absPath, "utf8");
  const parsed = parseDoc({ relPath, raw });

  // Strip trailing whitespace from existing body, then insert a single
  // blank-line separator before the new block. Final file always ends
  // with exactly one newline.
  const existingBodyTrimmed = parsed.body.replace(/\s+$/, "");
  const newBody =
    existingBodyTrimmed.length === 0
      ? `${trimmedContent}\n`
      : `${existingBodyTrimmed}\n\n${trimmedContent}\n`;

  const rewritten = serializeDoc({ ...parsed, body: newBody });

  tracker?.markSelfWrite(absPath);
  writeFileSync(absPath, rewritten, "utf8");

  const reread = readFileSync(absPath, "utf8");
  const reparsed = parseDoc({ relPath, raw: reread });
  upsertDocNodeAndEdges(handle, relPath, reparsed);

  return {
    id: nodeId,
    sourceFile: relPath,
    absPath,
    appendedChars: trimmedContent.length,
  };
}

export interface UpdateNodeStatusResult {
  id: string;
  sourceFile: string;
  absPath: string;
  previousStatus: TaskStatus | null;
  newStatus: TaskStatus;
}

/**
 * Set the `status` field in a Task node's frontmatter. All other frontmatter
 * keys (including `edges:`) and the body are preserved byte-for-byte at the
 * parsed-doc level (YAML is re-serialized, so key order within the
 * frontmatter block may normalize — see parser.ts notes).
 *
 * Rejects when:
 *   - nodeId does not exist
 *   - node is not type='Task' (other types have no status vocabulary yet)
 *   - newStatus is not in TASK_STATUSES
 *
 * Side effects (same as appendToNode):
 *   - File rewritten, SelfWriteTracker notified.
 *   - content_hash changes (frontmatter bytes differ) → engine flips
 *     embedding_status back to 'pending'. This is slightly wasteful for
 *     pure-metadata changes, but it's simpler than teaching the engine
 *     to distinguish metadata-only diffs from body diffs, and re-embedding
 *     is cheap at this scale.
 */
export function updateNodeStatus(
  handle: DbHandle,
  vaultPath: string,
  nodeId: string,
  newStatus: string,
  tracker?: SelfWriteTracker,
): UpdateNodeStatusResult {
  if (!isTaskStatus(newStatus)) {
    throw new Error(
      `updateNodeStatus: invalid status '${newStatus}'. Allowed: ${TASK_STATUSES.join(", ")}`,
    );
  }

  const row = handle.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!row) {
    throw new Error(`updateNodeStatus: node '${nodeId}' does not exist`);
  }
  if (row.type !== "Task") {
    throw new Error(
      `updateNodeStatus: node '${nodeId}' is type '${row.type}'; only Task nodes have a status field`,
    );
  }
  if (!row.sourceFile) {
    throw new Error(
      `updateNodeStatus: node '${nodeId}' has no source_file on disk — nothing to rewrite`,
    );
  }

  const vault = resolve(vaultPath);
  const relPath = row.sourceFile;
  const absPath = resolve(vault, relPath);
  if (!existsSync(absPath)) {
    throw new Error(`updateNodeStatus: source file missing on disk: ${absPath}`);
  }
  const rel = relative(vault, absPath);
  if (rel.startsWith("..")) {
    throw new Error(`updateNodeStatus: source file resolves outside the vault: ${absPath}`);
  }

  const raw = readFileSync(absPath, "utf8");
  const parsed = parseDoc({ relPath, raw });

  const previousRaw = parsed.frontmatter.status;
  const previousStatus: TaskStatus | null = isTaskStatus(previousRaw) ? previousRaw : null;

  const mutatedFrontmatter: Record<string, unknown> = {
    ...parsed.frontmatter,
    status: newStatus,
  };
  const rewritten = serializeDoc({ ...parsed, frontmatter: mutatedFrontmatter });

  tracker?.markSelfWrite(absPath);
  writeFileSync(absPath, rewritten, "utf8");

  const reread = readFileSync(absPath, "utf8");
  const reparsed = parseDoc({ relPath, raw: reread });
  upsertDocNodeAndEdges(handle, relPath, reparsed);

  return {
    id: nodeId,
    sourceFile: relPath,
    absPath,
    previousStatus,
    newStatus,
  };
}
