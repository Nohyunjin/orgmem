import { CLASSIFY_SYSTEM } from "./prompts.ts";
import type { ExtractorClient } from "./client.ts";
import { parseExtractorJson } from "./client.ts";
import type { DecisionResult } from "./types.ts";

/**
 * Classify a single snippet as "decision" or "non_decision".
 * Temperature is forced to 0 and max_tokens to 200 — this matches the locked
 * eval baseline (P=1.000 R=0.971 F1=0.986 on v1.1 dataset, haiku-4-5).
 */
export async function classifyDecision(
  client: ExtractorClient,
  text: string,
): Promise<DecisionResult> {
  const res = await client.complete({
    system: CLASSIFY_SYSTEM,
    user: `<snippet>\n${text}\n</snippet>`,
    temperature: 0,
    maxTokens: 200,
  });
  let parsed: DecisionResult;
  try {
    parsed = parseExtractorJson<DecisionResult>(res.text);
  } catch (err) {
    throw new Error(
      `Decision classifier returned malformed output: ${res.text.slice(0, 200)} (${(err as Error).message})`,
    );
  }
  if (parsed.label !== "decision" && parsed.label !== "non_decision") {
    throw new Error(`Decision classifier returned invalid label: ${parsed.label}`);
  }
  return parsed;
}
