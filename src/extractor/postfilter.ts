import type { ExtractorClient } from "./client.ts";
import { classifyDecision } from "./classify.ts";
import type { ExtractedDecision } from "./types.ts";

export interface PostFilterDropped {
  text: string;
  reason: "classified_non_decision" | "classify_error";
  classifyReasoning?: string;
  classifyError?: string;
}

export interface PostFilterOptions {
  onDropped?: (dropped: PostFilterDropped) => void;
  /**
   * Cap the number of items we bother classifying. Default: 30 (matches
   * the extract hard-cap in extract.ts). Prevents runaway LLM spend if
   * a caller somehow passes a very long list.
   */
  maxItems?: number;
}

/**
 * Classify-as-postfilter: runs each already-extracted decision through the
 * locked CLASSIFY_SYSTEM (v2, P=1.000 R=0.971 F1=0.986 on v1.1 dataset)
 * and drops items the classifier calls `non_decision`.
 *
 * Why this exists
 * ---------------
 * Lane C dogfood (2026-04-15 → docs/dogfood-2026-04-15.md) showed that the
 * EXTRACT path has a precision cliff at cap=15: ~40% of extracted items on
 * real docs were goals/metrics/candidate-lists that the classifier would
 * cleanly reject. The EXTRACT eval harness only measures recall against a
 * curated gold subset, so the cliff never surfaced in lab measurements.
 *
 * Since CLASSIFY is cheap (≤200 output tokens per call) and the two prompts
 * share the same taxonomy, post-filtering is a clean precision lever
 * without retraining the EXTRACT prompt or lowering the cap.
 *
 * Failure mode policy: if classify throws for a specific item (HTTP error,
 * malformed JSON), we KEEP the item and surface the error via `onDropped`
 * with reason `classify_error`. That's safer than silently dropping a real
 * decision due to transient network flakiness; the caller can inspect the
 * warnings and re-run if needed.
 */
export async function classifyExtractedDecisions(
  client: ExtractorClient,
  extracted: ExtractedDecision[],
  options: PostFilterOptions = {},
): Promise<ExtractedDecision[]> {
  const maxItems = options.maxItems ?? 30;
  const kept: ExtractedDecision[] = [];

  for (let i = 0; i < extracted.length && i < maxItems; i++) {
    const e = extracted[i]!;
    try {
      const result = await classifyDecision(client, e.text);
      if (result.label === "decision") {
        kept.push(e);
      } else {
        options.onDropped?.({
          text: e.text,
          reason: "classified_non_decision",
          classifyReasoning: result.reasoning,
        });
      }
    } catch (err) {
      // Keep the item; surface the error.
      kept.push(e);
      options.onDropped?.({
        text: e.text,
        reason: "classify_error",
        classifyError: (err as Error).message,
      });
    }
  }

  // Any items beyond maxItems pass through unfiltered — they shouldn't
  // exist in practice (the cap defends against runaway input) but we
  // keep them to preserve the "classify failures don't drop items" rule.
  for (let i = maxItems; i < extracted.length; i++) {
    kept.push(extracted[i]!);
  }

  return kept;
}
