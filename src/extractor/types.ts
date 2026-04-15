// Lane C Decision Extractor — shared types.
//
// Ported from orgmem-probe src/decisions.ts @ commit 3be62e4 (2026-04-15).
// See INTEGRATION-PLAN.md for the full port rationale.

export type DecisionLabel = "decision" | "non_decision";

export interface DecisionResult {
  label: DecisionLabel;
  reasoning: string;
}

export interface ExtractedDecision {
  text: string;
  reasoning: string;
  /** 1-based line number in the source doc, or null when the extractor
   *  couldn't pin the decision to a line. */
  line: number | null;
}
