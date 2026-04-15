import { EXTRACT_SYSTEM } from "./prompts.ts";
import type { ExtractorClient } from "./client.ts";
import { parseExtractorJson } from "./client.ts";
import type { ExtractedDecision } from "./types.ts";

interface RawExtractedDecision {
  text?: unknown;
  reasoning?: unknown;
  line?: unknown;
}

export type VerbatimDropReason =
  | "empty_text"
  | "not_a_substring_of_body";

export interface VerbatimDropped {
  text: string;
  reason: VerbatimDropReason;
}

export interface ExtractDecisionsOptions {
  /**
   * Called once per dropped decision. Use this to surface drops in logs.
   * The extractor returns only the kept items from `extractDecisionsFromDoc`;
   * drops are invisible without this callback. Lane C dogfood (2026-04-15)
   * showed that the LLM occasionally synthesizes a paraphrase by combining
   * tokens from multiple lines — these are caught by the substring-of-body
   * post-check and dropped rather than materialized as a Decision node.
   */
  onDropped?: (dropped: VerbatimDropped) => void;
  /**
   * Set to `false` to skip the VERBATIM post-check. Default: `true`.
   * Turning this off is only useful for testing prompt behavior in isolation.
   */
  verbatimCheck?: boolean;
}

/**
 * Normalize a string for the VERBATIM substring check.
 *
 * The extractor is asked to return contiguous substrings of the doc body,
 * but it sometimes drops markdown emphasis / wrapping backticks / collapses
 * whitespace while quoting (e.g. it outputs `"MCP 표준 사용"` while the
 * doc has `"**MCP 표준 사용**"`). Normalizing both sides to
 *   lowercase, no ` * _ backticks, collapsed whitespace
 * lets the post-check accept those legitimate edits without also accepting
 * genuine paraphrases — genuine paraphrases still produce text that, after
 * normalization, is not a substring of the normalized body.
 */
function normalizeForVerbatim(s: string): string {
  return s
    .replace(/\*\*|__|`/g, "")
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Extract decisions from a full markdown document.
 *
 * Caps at 20 decisions on the orgmem side regardless of what the model
 * returns — the prompt itself asks for ≤15, so a return larger than 20
 * is almost certainly a bug and we cut it defensively.
 *
 * Temperature is forced to 0 (locked eval: recall=0.900 stable across runs).
 *
 * VERBATIM post-check: every returned decision's `text` must appear as a
 * (normalized) substring of `body`. Paraphrases and cross-line
 * synthesis fail this check and are dropped, protecting the graph from
 * hallucinated Decision nodes (Lane C dogfood issue (4), 2026-04-15).
 * Opt out via `options.verbatimCheck = false` (testing only).
 */
export async function extractDecisionsFromDoc(
  client: ExtractorClient,
  docTitle: string,
  body: string,
  options: ExtractDecisionsOptions = {},
): Promise<ExtractedDecision[]> {
  const res = await client.complete({
    system: EXTRACT_SYSTEM,
    user: `# ${docTitle}\n\n${body}`,
    temperature: 0,
    maxTokens: 2000,
  });

  let parsed: { decisions?: unknown };
  try {
    parsed = parseExtractorJson<{ decisions?: unknown }>(res.text);
  } catch (err) {
    throw new Error(
      `Decision extractor returned malformed output: ${res.text.slice(0, 200)} (${(err as Error).message})`,
    );
  }

  if (!Array.isArray(parsed.decisions)) {
    throw new Error(
      `Decision extractor returned non-array 'decisions' field. Raw (first 200 chars): ${res.text.slice(0, 200)}`,
    );
  }

  const verbatimCheck = options.verbatimCheck !== false;
  const normalizedBody = verbatimCheck ? normalizeForVerbatim(body) : "";

  const out: ExtractedDecision[] = [];
  for (const raw of parsed.decisions as RawExtractedDecision[]) {
    if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
      if (typeof raw.text === "string" && options.onDropped) {
        options.onDropped({ text: raw.text, reason: "empty_text" });
      }
      continue;
    }
    const trimmed = raw.text.trim();

    if (verbatimCheck) {
      const normalizedText = normalizeForVerbatim(trimmed);
      if (!normalizedBody.includes(normalizedText)) {
        options.onDropped?.({ text: trimmed, reason: "not_a_substring_of_body" });
        continue;
      }
    }

    const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
    let line: number | null = null;
    if (typeof raw.line === "number" && Number.isFinite(raw.line) && raw.line >= 1) {
      line = Math.floor(raw.line);
    }
    out.push({ text: trimmed, reasoning, line });
    if (out.length >= 20) break;
  }
  return out;
}
