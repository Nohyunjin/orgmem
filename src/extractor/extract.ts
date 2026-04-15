import { EXTRACT_SYSTEM } from "./prompts.ts";
import type { ExtractorClient } from "./client.ts";
import { parseExtractorJson } from "./client.ts";
import type { ExtractedDecision } from "./types.ts";

interface RawExtractedDecision {
  text?: unknown;
  reasoning?: unknown;
  line?: unknown;
}

/**
 * Extract decisions from a full markdown document.
 *
 * Caps at 20 decisions on the orgmem side regardless of what the model
 * returns — the prompt itself asks for ≤15, so a return larger than 20
 * is almost certainly a bug and we cut it defensively.
 *
 * Temperature is forced to 0 (locked eval: recall=0.900 stable across runs).
 */
export async function extractDecisionsFromDoc(
  client: ExtractorClient,
  docTitle: string,
  body: string,
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

  const out: ExtractedDecision[] = [];
  for (const raw of parsed.decisions as RawExtractedDecision[]) {
    if (typeof raw.text !== "string" || raw.text.trim().length === 0) continue;
    const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
    let line: number | null = null;
    if (typeof raw.line === "number" && Number.isFinite(raw.line) && raw.line >= 1) {
      line = Math.floor(raw.line);
    }
    out.push({ text: raw.text.trim(), reasoning, line });
    if (out.length >= 20) break;
  }
  return out;
}
