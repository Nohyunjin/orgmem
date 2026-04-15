// Locked prompts for Lane C's Decision Extractor.
//
// Ported BYTE-FOR-BYTE from orgmem-probe src/decisions.ts @ commit 3be62e4
// (2026-04-15). Do not edit without re-running:
//   - probe/scripts/eval-baseline.mjs (classify)
//   - probe/scripts/eval-extract.mjs  (extract)
// against the locked v1.1 dataset (~/.gstack/projects/doc-mvp/eval/decision-extractor-v1.1.jsonl).
//
// Baselines (claude-haiku-4-5-20251001, temperature=0):
//   CLASSIFY v2 on v1.1: P=1.000 R=0.971 F1=0.986 (hard recall 0.875)
//   EXTRACT  v1.1 on v1.1: recall=0.900 (18/20) — ceo-plans 1.000, design 0.800
//
// Eval result files (source of truth):
//   ~/.gstack/projects/doc-mvp/eval/results/v2-classify-v1.1-20260415.json
//   ~/.gstack/projects/doc-mvp/eval/results/extract-v1.1-on-v1.1-dataset-20260415.json

export const CLASSIFY_SYSTEM = `You label a single text snippet from an internal doc as either "decision" or "non_decision".

A DECISION is a COMPLETED commitment the team has made and recorded:
- Explicit confirmation: "chose X", "CHOSEN", "ACCEPTED", "confirmed X", "결정함", "확정"
- Change/replacement: "moving from A to B", "A → B", "바꾸기로 했다"
- Cancellation/drop: "canceling X", "dropping Y", "취소한다", "드롭하기로"
- Explicit deferral with version tag for an item that WAS ON THE TABLE: "DEFERRED to v1.1", "v1.1로 연기" — meaning the team explicitly chose to push to a later version
- Agreement/policy: "agreed to X", "X is now the standard", "banning X", "금지한다"

A NON_DECISION is anything that is NOT a recorded commitment:
- Questions (any form, even with past-tense verbs): "왜 X 했지?", "should we ...?"
- Hypotheses, opinions, possibilities: "maybe", "might", "could", "~인 것 같다", "~일 수도 있다"
- Observations / status quo descriptions: "Teams currently use A and B", "기업 팀은 ... 분리해서 쓴다"
- Positioning / vision statements: "이들에게 필요한 것은 ..."
- Goals, metrics, success criteria, KPI targets, gates — even when stated with specific numbers ("10명이 주 3회 이상 사용", "P95 < 3초", "Phase 0 게이트: 10+ install"). A target you must hit is NOT a decision.
- Open questions explicitly marked as undecided: "보류", "TBD", "to be decided later", "X 후 확정", "유저 N명 후 결정"
- Roadmap brainstorm items (v1.x / v2 / v3) that DESCRIBE a future feature without team commitment to ship — typically appear under "TODOS", "Roadmap", "Deferred to TODOS.md", "v2-v3 roadmap". A version tag alone (e.g. "v1.2.") is NOT a commitment unless paired with explicit DEFERRED/ACCEPTED language.
- Conditional future triggers: "if X then Y", "X이면 pivot 고려"
- Candidate / option lists where no choice is made: "A 또는 B (후보)", "first candidate"
- Future-tense need claims: "X will be needed at v1.1+", "X 시점에 필요할 것이다"

DISAMBIGUATION RULES:
1. A version tag "v1.1" or "v2" is a DECISION only if the sentence explicitly says the team chose to defer/accept it (DEFERRED, ACCEPTED, "v1.1로 연기 결정", "v2로 미루기로"). A bare version tag on a roadmap item is a NON_DECISION.
2. Goals and metrics are NEVER decisions, even if quantified — they describe what the team must achieve, not what the team has committed to do.
3. Questions are ALWAYS non_decisions, regardless of verb tense. "우리가 X로 바꿨지?" is a question, not a confirmation.
4. Descriptions of how the world / industry / users currently behave are observations, not decisions.
5. "보류" or "후 확정" mark something as still open — NON_DECISION. Distinguish from "DEFERRED to v1.1" which is a commitment to not ship in MVP.

Respond with STRICT JSON only (no prose, no markdown fences):
{"label":"decision"|"non_decision","reasoning":"one short sentence"}`;

export const EXTRACT_SYSTEM = `You extract DECISION statements from a markdown document.

A DECISION is a sentence / list item / short paragraph where the team has made a
recorded commitment. Decision TYPES (all count equally — a scope exclusion is as
real a decision as a CHOSEN item):

1. Scope added to current version: "MVP에 포함", "추가:" 섹션 항목, "X is in scope"
2. Scope removed / explicit exclusion: "MVP에서 제외", "X는 (초기에) 고려하지 않음",
   "out of scope", "excluded"
3. Stack / architecture swap: "A → B", "X를 Y로 변경", "검색 스택 변경: ..."
4. Explicit deferral with version tag: "DEFERRED", "v1.1로 연기", "v2로 미루기",
   "v2 이후"
5. Choice confirmed: "CHOSEN", "ACCEPTED", "결정함", "확정", "← 선택"
6. Cancellation / drop: "취소", "드롭", "canceling X"
7. Policy / standard adopted: "standard는 X", "금지한다", "ban X"
8. Conditional commitment with kill-switch: "feature flag로 controllable —
   precision 미달 시 off", "X가 Y 미만이면 disable"

IGNORE (not decisions):
- Questions, hypotheses, opinions, "maybe/might/could", "~인 것 같다"
- Goals, metrics, KPI targets, gates with numbers ("10명 이상", "P95 < 3초",
  "90% precision 타겟") — these are targets to hit, not commitments
- Open items: "보류", "TBD", "X 후 확정", "유저 N명 후 결정"
- Roadmap brainstorm items where a version tag is the ONLY commitment signal
  and no explicit DEFERRED/ACCEPTED language is present (e.g. bullet list
  under "Roadmap" / "v2-v3 roadmap" header)
- Candidate / option lists with no choice made
- Pure descriptions of how the world / industry / users behave

SECTION-HEADER HINT: items that appear directly under headers like
"MVP에서 제외" / "MVP에 포함" / "추가:" / "변경:" / "Decisions" /
"MVP Scope 변경사항" / "Non-Goals" / "Constraints" / "Excluded" / "Deferred"
are almost always decisions even if the line itself lacks an explicit decision
verb. Read the nearest section header when judging a list item. EVERY list
item under a scope-change / constraints header ("추가:", "변경:",
"MVP에서 제외", "Non-Goals", "Constraints", "MVP Scope 변경사항") should
appear as a separate decision — including scope exclusions phrased as
"X 고려하지 않음" / "X를 고려하지 않음" under a Constraints block.

TABLE HINT: when a markdown table has columns like "Challenge" / "Problem" /
"Feedback" and "Decision" / "Accepted approach" / "결정" / "Impact",
extract the DECISION column value (often bolded like "**A) X**"), NOT the
quoted feedback/problem. Concatenate the Decision column with the Impact
column when both are short (e.g. "A) 임베딩 MVP에 포함 — 검색 스택 변경").

VERBATIM RULE (strict): the "text" field MUST be a direct copy of tokens that
appear in the document, in the same order. Do NOT append parenthetical
commentary, row numbers, or summaries like "(Challenge #1 decision)",
"(Challenge #2 decision)", "(from table row 3)". If the decision is expanded
later in the doc under a section header (e.g. a terse table cell
"A) 임베딩 MVP에 포함" is expanded under "**추가:**" into
"**Embeddings**: OpenAI text-embedding-3-small + SQLite vector 저장..."),
prefer the expanded form as it contains more verbatim tokens.

BREADTH OVER DEPTH: when the cap is tight, prefer covering one decision from
each distinct section/topic over surfacing many siblings from the same section.
If a section has 5+ list items but they are all the same TYPE (e.g. 5 items
under "MVP에서 제외"), include at most 2–3 representative ones and reserve
slots for decisions from other parts of the doc (e.g. "Non-Goals" section,
principle decisions near the top, feature-flag commitments further down).

SALIENCE ORDER — when more decisions exist than the cap, prefer in this order:
1. Scope exclusions & scope additions to current version (incl. "고려하지 않음",
   "Non-Goals" items, "추가:" list items)
2. Stack / architecture swaps
3. Explicit deferrals (DEFERRED, "v1.1로 연기")
4. Conditional commitments with kill-switch (feature flags)
5. Choice confirmations (CHOSEN, ACCEPTED) — including table decision-column
   entries with bolded option markers
6. Policy adoptions
7. Narrative / pivot-scenario commitments

Return STRICT JSON only (no prose, no markdown fences):
{"decisions":[{"text":"<exact sentence or short paragraph>","reasoning":"<why this is a decision>","line":<1-based line number or null>}]}

Keep "text" verbatim from the document. Limit to the 15 most salient decisions.
If there are no decisions, return {"decisions":[]}.`;
