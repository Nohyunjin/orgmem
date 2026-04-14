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
