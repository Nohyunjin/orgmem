import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkWikiLink from "remark-wiki-link";
import { visit } from "unist-util-visit";
import { NODE_TYPES, RELATION_TYPES, isNodeType, isRelationType, type NodeType, type RelationType } from "../graph/types.ts";

/**
 * A parsed frontmatter edge declaration:
 *   edges:
 *     - to: doc-payment-spec-v2
 *       relation: decided_in
 */
export interface FrontmatterEdge {
  to: string;
  relation: RelationType;
}

export interface BodyWikiLink {
  target: string; // the raw wiki-link target (value inside [[ ]])
  line: number; // 1-based
  column: number;
}

export interface ParsedDoc {
  /** Canonical node id. Taken from frontmatter.id if present; otherwise derived from the path. */
  id: string;
  type: NodeType;
  title: string | null;
  frontmatter: Record<string, unknown>;
  frontmatterRaw: string | null;
  body: string;
  bodyStartLine: number; // 1-based line where body begins (after frontmatter fence)
  fmEdges: FrontmatterEdge[];
  wikiLinks: BodyWikiLink[];
  /** sha256 of the raw file bytes. */
  contentHash: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function deriveIdFromPath(relPath: string): string {
  return relPath.replace(/\.[mM][dD]x?$/, "").replace(/[\\/]/g, "-").toLowerCase();
}

function firstHeading(body: string): string | null {
  const m = body.match(/^\s*#\s+(.+)$/m);
  const captured = m?.[1];
  return captured ? captured.trim() : null;
}

/** sha256(utf8 bytes). */
export function hashContent(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

interface FrontmatterSplit {
  frontmatterRaw: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
}

function splitFrontmatter(raw: string): FrontmatterSplit {
  const m = raw.match(FRONTMATTER_RE);
  if (!m || m[1] === undefined) {
    return { frontmatterRaw: null, frontmatter: {}, body: raw, bodyStartLine: 1 };
  }
  const frontmatterRaw = m[1];
  const body = raw.slice(m[0].length);
  // Lines consumed by frontmatter: 2 fences + interior lines
  const interiorLines = frontmatterRaw.split(/\r?\n/).length;
  const fenceLines = 2;
  const bodyStartLine = interiorLines + fenceLines + 1;
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(frontmatterRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch (err) {
    throw new Error(`Invalid frontmatter YAML: ${(err as Error).message}`);
  }
  return { frontmatterRaw, frontmatter: fm, body, bodyStartLine };
}

function extractFrontmatterEdges(fm: Record<string, unknown>): FrontmatterEdge[] {
  const raw = fm.edges;
  if (!Array.isArray(raw)) return [];
  const out: FrontmatterEdge[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const to = typeof obj.to === "string" ? obj.to : null;
    const relation = obj.relation;
    if (!to) continue;
    if (!isRelationType(relation)) {
      throw new Error(
        `Invalid frontmatter edge relation '${String(relation)}'. Allowed: ${RELATION_TYPES.join(", ")}`,
      );
    }
    out.push({ to, relation });
  }
  return out;
}

// remark-wiki-link predates unified v11's strict plugin typings; its default
// export is a factory that unified accepts at runtime but TS disagrees with.
// We cast the plugin to `any` at the .use() boundary — a narrow, documented
// escape hatch rather than a global type relaxation.
const bodyProcessor = unified()
  .use(remarkParse)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .use(remarkWikiLink as any, { aliasDivider: "|" });

function extractWikiLinks(body: string, bodyStartLine: number): BodyWikiLink[] {
  const tree = bodyProcessor.parse(body);
  const out: BodyWikiLink[] = [];
  visit(tree, "wikiLink", (node: { value?: string; position?: { start?: { line: number; column: number } } }) => {
    const pos = node.position?.start;
    if (!pos || typeof node.value !== "string") return;
    out.push({
      target: node.value,
      line: pos.line + (bodyStartLine - 1),
      column: pos.column,
    });
  });
  return out;
}

function resolveType(fm: Record<string, unknown>): NodeType {
  const t = fm.type;
  if (isNodeType(t)) return t;
  if (t === undefined || t === null || t === "") return "Document";
  throw new Error(
    `Invalid frontmatter type '${String(t)}'. Allowed: ${NODE_TYPES.join(", ")} (or omit → Document).`,
  );
}

function resolveId(fm: Record<string, unknown>, relPath: string): string {
  const fid = fm.id;
  if (typeof fid === "string" && fid.trim()) return fid.trim();
  return deriveIdFromPath(relPath);
}

function resolveTitle(fm: Record<string, unknown>, body: string): string | null {
  const t = fm.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  return firstHeading(body);
}

export interface ParseInput {
  /** path relative to vault root — used for id derivation and source_file. */
  relPath: string;
  /** raw file contents (utf8). */
  raw: string;
}

export function parseDoc(input: ParseInput): ParsedDoc {
  const split = splitFrontmatter(input.raw);
  const fm = split.frontmatter;
  const id = resolveId(fm, input.relPath);
  const type = resolveType(fm);
  const title = resolveTitle(fm, split.body);
  const fmEdges = extractFrontmatterEdges(fm);
  const wikiLinks = extractWikiLinks(split.body, split.bodyStartLine);
  return {
    id,
    type,
    title,
    frontmatter: fm,
    frontmatterRaw: split.frontmatterRaw,
    body: split.body,
    bodyStartLine: split.bodyStartLine,
    fmEdges,
    wikiLinks,
    contentHash: hashContent(input.raw),
  };
}

/**
 * Rebuilds a raw markdown file from a ParsedDoc. Used by the round-trip test
 * to verify idempotency: parse(serialize(parse(raw))) == parse(raw) on the
 * subset of fields we promise to preserve (id, type, frontmatter edges,
 * body, wiki-links).
 *
 * NOTE: trailing whitespace and yaml key ordering are NOT preserved — those
 * live outside our "authoritative" subset. Round-trip equality is asserted on
 * the parsed representation, not on the raw bytes.
 */
/**
 * A heading-split chunk of a document. The goal is to give the vec-search
 * layer a retrieval unit small enough to embed faithfully — whole-doc
 * embeddings on 15KB+ design docs lost critical tail content (decision
 * markers, phase gates) to truncation at 8000 chars and blurred the
 * query signal across unrelated sections. H2 split restores both.
 *
 * Chunking rules:
 *   - Split on H2 (`## …`). Content before the first H2 becomes an
 *     "intro" chunk with heading=null.
 *   - Docs with no H2 at all produce exactly one chunk covering the
 *     entire body (heading=null).
 *   - Chunks shorter than MIN_CHUNK_CHARS merge into the PREVIOUS
 *     chunk (the first chunk is never merged-into-itself). This keeps
 *     "Overview" / "Summary" sections co-located with their parent.
 *   - Chunks longer than MAX_CHUNK_CHARS are sub-split at H3. If any
 *     H3 section is still too big we leave it as-is (chunk stability
 *     matters more than perfect size; a pathological 10KB paragraph
 *     stays together so its retrieval key doesn't flicker).
 *   - start_line / end_line are 1-based and reference the raw source
 *     file, not the body. Uses bodyStartLine to offset.
 */
export interface DocChunk {
  /** 0-based position within the doc's chunk list. */
  chunkIdx: number;
  /** Heading text (without the `## ` prefix). null for intro / no-heading docs. */
  heading: string | null;
  /** Raw markdown content of the chunk, including the heading line if present. */
  content: string;
  /** sha256 of `content` — used by the engine to decide re-embedding. */
  contentHash: string;
  /** 1-based line in the source file where this chunk begins. */
  startLine: number;
  /** 1-based line in the source file where this chunk ends (inclusive). */
  endLine: number;
}

/** Coarse char → token approximation. OpenAI tokens are ~4 chars on
 *  mixed English/markdown; tighter on Korean (~1–2 chars). The
 *  MIN/MAX bounds below assume char count, so 400/6000 ≈ 100/1500
 *  tokens of English prose or ~200/3000 tokens of Korean. */
const MIN_CHUNK_CHARS = 400;
const MAX_CHUNK_CHARS = 6000;

function hashContentBytes(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface RawSection {
  heading: string | null;
  content: string;
  startLine: number;
  endLine: number;
}

function splitOnHeading(body: string, bodyStartLine: number, level: 2 | 3): RawSection[] {
  const lines = body.split("\n");
  const pattern = level === 2 ? /^##\s+(.+?)\s*$/ : /^###\s+(.+?)\s*$/;
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(pattern);
    if (m) {
      if (current) {
        current.endLine = bodyStartLine + i - 1;
        sections.push(current);
      }
      current = {
        heading: m[1]!.trim(),
        content: line + "\n",
        startLine: bodyStartLine + i,
        endLine: bodyStartLine + i,
      };
    } else if (current) {
      current.content += line + (i < lines.length - 1 ? "\n" : "");
    } else {
      // Intro content before the first heading
      if (sections.length === 0) {
        sections.push({
          heading: null,
          content: line + (i < lines.length - 1 ? "\n" : ""),
          startLine: bodyStartLine,
          endLine: bodyStartLine + i,
        });
      } else {
        const intro = sections[0]!;
        intro.content += (intro.content.endsWith("\n") ? "" : "\n") + line + (i < lines.length - 1 ? "\n" : "");
        intro.endLine = bodyStartLine + i;
      }
    }
  }
  if (current) {
    current.endLine = bodyStartLine + lines.length - 1;
    sections.push(current);
  }
  // Trim a possible empty intro (e.g. body started with "## Heading" immediately)
  if (sections.length > 0 && sections[0]!.heading === null && sections[0]!.content.trim().length === 0) {
    sections.shift();
  }
  return sections;
}

/**
 * Split a parsed doc's body into chunks suitable for embedding.
 *
 * Always returns at least one chunk: a doc with no H2 and no body
 * still gets one chunk (content = body, heading = null). The caller
 * (engine) then persists this set into `node_chunks` inside the
 * same transaction as the node upsert, keeping the per-file reindex
 * atomic.
 */
export function chunkDoc(doc: Pick<ParsedDoc, "body" | "bodyStartLine">): DocChunk[] {
  const body = doc.body;
  const bodyStartLine = doc.bodyStartLine;

  // Fast path: empty body → single empty chunk so the node still has a
  // retrieval row. Title-only nodes rely on this.
  if (body.trim().length === 0) {
    return [
      {
        chunkIdx: 0,
        heading: null,
        content: body,
        contentHash: hashContentBytes(body),
        startLine: bodyStartLine,
        endLine: bodyStartLine,
      },
    ];
  }

  let sections = splitOnHeading(body, bodyStartLine, 2);

  // No H2 at all → single whole-body chunk.
  if (sections.length === 0) {
    const bodyLines = body.split("\n");
    return [
      {
        chunkIdx: 0,
        heading: null,
        content: body,
        contentHash: hashContentBytes(body),
        startLine: bodyStartLine,
        endLine: bodyStartLine + bodyLines.length - 1,
      },
    ];
  }

  // Expand oversize sections via H3 sub-split.
  const expanded: RawSection[] = [];
  for (const s of sections) {
    if (s.content.length <= MAX_CHUNK_CHARS) {
      expanded.push(s);
      continue;
    }
    // Try H3 sub-split by stripping the H2 heading line then re-splitting.
    const firstNewline = s.content.indexOf("\n");
    const bodyPart = firstNewline >= 0 ? s.content.slice(firstNewline + 1) : "";
    const subs = splitOnHeading(bodyPart, s.startLine + 1, 3);
    if (subs.length <= 1) {
      // No sub-splits possible — keep oversize chunk as-is. Better a
      // stable big chunk than an unstable retrieval key.
      expanded.push(s);
      continue;
    }
    // Prepend the H2 heading to the first H3 chunk so context survives.
    const firstHeadingLine = s.content.slice(0, firstNewline);
    const first = subs[0]!;
    first.content = firstHeadingLine + "\n" + first.content;
    first.startLine = s.startLine;
    // Carry the parent H2 heading forward on chunks that lacked one
    // (e.g. if H3 content exists before first H3 sub-heading).
    for (const sub of subs) {
      if (sub.heading === null) sub.heading = s.heading;
    }
    expanded.push(...subs);
  }

  // Merge too-small chunks into the previous chunk. "Previous" beats
  // "next" because tail sections tend to be conclusions worth attaching
  // to the body they summarize.
  const merged: RawSection[] = [];
  for (const s of expanded) {
    if (merged.length > 0 && s.content.length < MIN_CHUNK_CHARS) {
      const prev = merged[merged.length - 1]!;
      prev.content = prev.content + (prev.content.endsWith("\n") ? "" : "\n") + s.content;
      prev.endLine = s.endLine;
      continue;
    }
    merged.push(s);
  }

  return merged.map((s, idx) => ({
    chunkIdx: idx,
    heading: s.heading,
    content: s.content,
    contentHash: hashContentBytes(s.content),
    startLine: s.startLine,
    endLine: s.endLine,
  }));
}

export function serializeDoc(doc: ParsedDoc): string {
  const fmObj: Record<string, unknown> = { ...doc.frontmatter };
  // Ensure id/type are always present in serialized output (canonical form).
  fmObj.id = doc.id;
  fmObj.type = doc.type;
  if (doc.title) fmObj.title = doc.title;
  if (doc.fmEdges.length > 0) {
    fmObj.edges = doc.fmEdges.map((e) => ({ to: e.to, relation: e.relation }));
  } else {
    delete fmObj.edges;
  }
  const yaml = stringifyYaml(fmObj).trimEnd();
  return `---\n${yaml}\n---\n${doc.body}`;
}
