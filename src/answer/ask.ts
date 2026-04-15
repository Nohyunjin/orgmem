/**
 * `kg ask` pipeline — search → build grounded prompt → LLM → return.
 *
 * Contract highlights:
 *  - Empty-hits fast-path: if the vec search returns 0 rows, we return a
 *    canned "no relevant nodes" answer WITHOUT calling the LLM. This keeps
 *    freshly-imported empty graphs from burning API calls and from emitting
 *    hallucinated answers.
 *  - Grounding: the system prompt tells the model to answer ONLY from
 *    context and to cite every claim with `[[node-id]]`. The user prompt
 *    serializes each hit with id, title, (clipped) content, and one-hop
 *    edges — titles only on neighbors, no bodies, to stay under token
 *    budget.
 *  - Return shape includes the raw hits so the caller (CLI or future MCP
 *    tool) can render citations, follow edges, or display the trail.
 */
import type { DbHandle } from "../storage/sqlite.ts";
import type { EmbedClient } from "../embeddings/client.ts";
import { search, formatHits, type SearchHit } from "../graph/search.ts";
import type { AnswerClient, AnswerResponse } from "./client.ts";

export interface AskOptions {
  /** Top-k for vec search. Default 5 (keep context small for ask). */
  k?: number;
  /** Cap on 1-hop neighbors per hit per direction. Default 6. */
  neighborCap?: number;
  /** Per-hit content-body clip (chars). Default 1200. */
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

const DEFAULT_K = 5;
const DEFAULT_NEIGHBOR_CAP = 6;
const DEFAULT_CONTENT_CHAR_CAP = 1200;

const SYSTEM_PROMPT = `You are a careful assistant answering questions from a knowledge graph.

Rules:
- Answer ONLY from the provided context. If the context does not contain the answer, say so explicitly — do not guess.
- Cite every factual claim with the node id in double brackets, e.g. [[doc-spec]].
- Do not invent node ids, titles, or edges that are not in the context.
- Prefer concise answers. Use bullet points when listing multiple items.`;

const EMPTY_ANSWER =
  "No relevant nodes found in the graph for this query. " +
  "Either the graph has no embeddings yet (run `kg embed`) or the question is out of scope.";

export function buildUserPrompt(query: string, hits: SearchHit[], charCap: number): string {
  const parts: string[] = [];
  parts.push(`# Query`);
  parts.push(query.trim());
  parts.push("");
  parts.push(`# Context (${hits.length} hit${hits.length === 1 ? "" : "s"})`);
  for (const h of hits) {
    const title = h.node.title ? ` "${h.node.title}"` : "";
    parts.push("");
    parts.push(
      `## Hit ${h.rank} (distance ${h.distance.toFixed(4)}) — [[${h.node.id}]]${title}`,
    );
    if (h.node.sourceFile) {
      parts.push(`source: ${h.node.sourceFile}`);
    }
    if (h.node.content) {
      const clipped =
        h.node.content.length > charCap
          ? h.node.content.slice(0, charCap) + "…"
          : h.node.content;
      parts.push("");
      parts.push(clipped);
    }
    if (h.directEdges.length > 0) {
      parts.push("");
      parts.push("Outgoing edges:");
      for (const n of h.directEdges) {
        const far = n.node
          ? `[[${n.node.id}]]${n.node.title ? ` "${n.node.title}"` : ""}`
          : `(dangling)`;
        parts.push(`  → ${n.relation} ${far}`);
      }
    }
    if (h.inverseEdges.length > 0) {
      parts.push("");
      parts.push("Incoming edges:");
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
    `Answer the query using only the context above. Cite with [[node-id]]. If the context is insufficient, say so.`,
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
