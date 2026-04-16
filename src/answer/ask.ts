/**
 * `kg ask` pipeline — search → build grounded prompt → LLM → return.
 *
 * v0.2 chunk-aware rewrite. Hits now carry heading-split chunk content,
 * not whole-doc truncated content, so the prompt includes chunks
 * verbatim (no char cap needed in practice; MAX_CHUNK_CHARS in the
 * parser caps them at ~6000 / ~1500 tokens each).
 *
 * Contract highlights:
 *  - Empty-hits fast-path: if vec search returns 0 rows we return a
 *    canned "no relevant chunks" answer WITHOUT calling the LLM.
 *    Saves tokens on empty / unembeded graphs and prevents slop.
 *  - Grounding: the system prompt instructs the model to cite every
 *    factual claim with `[[node-id#heading]]` (or bare `[[node-id]]`
 *    for chunks with no heading). The user prompt serializes each
 *    hit with its citation, parent node title, chunk heading, full
 *    chunk content, and the parent node's 1-hop edges.
 *  - Return shape includes the raw hits so the caller (CLI or MCP
 *    tool) can render citations, follow edges, or deep-link the user
 *    into the source file at `chunk.startLine`.
 */
import type { DbHandle } from "../storage/sqlite.ts";
import type { EmbedClient } from "../embeddings/client.ts";
import {
  search,
  formatHits,
  citationFor,
  type SearchHit,
} from "../graph/search.ts";
import type { AnswerClient, AnswerResponse } from "./client.ts";

export interface AskOptions {
  /** Top-k for vec search. Default 5 (keep context small for ask). */
  k?: number;
  /** Cap on 1-hop neighbors per hit per direction. Default 6. */
  neighborCap?: number;
  /** Per-hit content clip (chars). Chunks stay under MAX_CHUNK_CHARS
   *  (6000) by construction, so the default here is generous and
   *  almost never trims. Kept for defence against the "chunker left a
   *  pathological oversize chunk unsplit" case. */
  contentCharCap?: number;
  /** Override max_tokens for the LLM response. */
  maxTokens?: number;
}

export interface AskResult {
  answer: string;
  hits: ReturnType<typeof formatHits>;
  /** Populated only when the LLM was actually called. */
  usage: AnswerResponse["usage"] | null;
  /** True when we short-circuited because search returned 0 hits. */
  empty: boolean;
}

// v0.2 default was k=5. Bumped to 10 in v0.2.1 so that chunks from short
// docs (1-chunk SUMMARY.md etc.) still surface when they compete against
// many chunks from larger docs — the v2-precision regression from the
// 2026-04-16 dogfood (perf/dogfood-v0.2-20260416.md).
const DEFAULT_K = 10;
const DEFAULT_NEIGHBOR_CAP = 6;
const DEFAULT_CONTENT_CHAR_CAP = 6000;

const SYSTEM_PROMPT = `You are a careful assistant answering questions from a knowledge graph.

Each context block is a CHUNK extracted from a larger document by heading split. The chunk's citation form is \`[[node-id#heading]]\` when a heading is present, or \`[[node-id]]\` for a chunk with no heading (intro / whole-doc chunks).

Rules:
- Answer ONLY from the provided context. If the context does not contain the answer, say so explicitly — do not guess, do not fill in from prior knowledge.
- Cite every factual claim with the chunk's citation exactly as provided, in double brackets. Example: [[doc-payment-spec#Goals]].
- Do not invent node ids, headings, or edges that are not in the context.
- Prefer concise answers. Use bullet points when listing multiple items.
- Literal existence check. When the query asks whether a specific named artifact exists (e.g. a template, checklist, spec, schema, runbook), answer "yes, it exists" ONLY if the context explicitly introduces or defines that artifact by name. If the context merely contains adjacent content that could be adapted into the artifact (e.g. the user asks for an "interview template" and the context has 3 example questions under a non-template heading), report: "No <artifact> was found in the graph. Related content appears in [[…]]." Do NOT stretch adjacent content into a claim that the named artifact exists.
- A chunk's heading states the scope of its body. Do not infer a chunk's topic from body keywords alone — if a heading does not directly concern the query topic, treat the chunk as supporting context at best, not as primary evidence that the topic is present in the graph.`;

const EMPTY_ANSWER =
  "No relevant chunks found in the graph for this query. " +
  "Either the graph has no embeddings yet (run `kg embed`) or the question is out of scope.";

export function buildUserPrompt(query: string, hits: SearchHit[], charCap: number): string {
  const parts: string[] = [];
  parts.push(`# Query`);
  parts.push(query.trim());
  parts.push("");
  parts.push(`# Context (${hits.length} hit${hits.length === 1 ? "" : "s"})`);
  for (const h of hits) {
    const cite = citationFor(h);
    const title = h.node.title ? ` "${h.node.title}"` : "";
    parts.push("");
    parts.push(
      `## Hit ${h.rank} (distance ${h.distance.toFixed(4)}) — [[${cite}]]${title}`,
    );
    const locator = h.node.sourceFile
      ? `source: ${h.node.sourceFile}:${h.chunk.startLine}`
      : `chunk: ${h.chunk.chunkId}`;
    parts.push(locator);

    if (h.chunk.content) {
      const clipped =
        h.chunk.content.length > charCap
          ? h.chunk.content.slice(0, charCap) + "…"
          : h.chunk.content;
      parts.push("");
      parts.push(clipped);
    }
    if (h.directEdges.length > 0) {
      parts.push("");
      parts.push("Outgoing edges (from parent node):");
      for (const n of h.directEdges) {
        const far = n.node
          ? `[[${n.node.id}]]${n.node.title ? ` "${n.node.title}"` : ""}`
          : `(dangling)`;
        parts.push(`  → ${n.relation} ${far}`);
      }
    }
    if (h.inverseEdges.length > 0) {
      parts.push("");
      parts.push("Incoming edges (to parent node):");
      for (const n of h.inverseEdges) {
        const far = n.node
          ? `[[${n.node.id}]]${n.node.title ? ` "${n.node.title}"` : ""}`
          : `(dangling)`;
        parts.push(`  ← ${n.relation} ${far}`);
      }
    }
  }
  parts.push("");
  parts.push(
    `Answer the query using only the context above. Cite with the exact [[node-id#heading]] tags shown. If the context is insufficient, say so.`,
  );
  return parts.join("\n");
}

export async function ask(
  handle: DbHandle,
  embedClient: EmbedClient,
  answerClient: AnswerClient,
  query: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { answer: "", hits: [], usage: null, empty: true };
  }
  const k = opts.k ?? DEFAULT_K;
  const neighborCap = opts.neighborCap ?? DEFAULT_NEIGHBOR_CAP;
  const charCap = opts.contentCharCap ?? DEFAULT_CONTENT_CHAR_CAP;

  const hits = await search(handle, embedClient, trimmed, { k, neighborCap });
  const formatted = formatHits(hits);
  if (hits.length === 0) {
    return { answer: EMPTY_ANSWER, hits: formatted, usage: null, empty: true };
  }

  const user = buildUserPrompt(trimmed, hits, charCap);
  const resp = await answerClient.complete({
    system: SYSTEM_PROMPT,
    user,
    maxTokens: opts.maxTokens,
  });
  return { answer: resp.text, hits: formatted, usage: resp.usage, empty: false };
}

export { SYSTEM_PROMPT, EMPTY_ANSWER };
