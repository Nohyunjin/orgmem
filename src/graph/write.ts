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
 * Slug rules:
 *   - keep ASCII alphanumerics, CJK (한글/漢字), and hyphens
 *   - collapse whitespace + punctuation runs to a single '-'
 *   - lowercase ASCII
 *   - trim leading/trailing '-'
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
  if (cleaned.length > 0) return cleaned;
  return `untitled-${Date.now().toString(36)}`;
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
