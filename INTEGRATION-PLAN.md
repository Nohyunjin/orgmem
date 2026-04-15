# Decision Extractor — Integration Plan (Lane C → orgmem)

Status: **draft — awaiting Lane A engine lock confirmation before execution (week 3).**
Source prompts: locked in probe repo `src/decisions.ts` (commits 2944e92 + d2c3441).
Eval baseline: CLASSIFY P=1.000 R=0.967 F1=0.983, EXTRACT recall=0.900 (18/20).

---

## 1. Goal

Port the CLASSIFY_SYSTEM v2 + EXTRACT_SYSTEM v1.1 prompts from
`orgmem-probe` (Phase 0) into `orgmem` (Phase 1) as a first-class
`src/extractor/` module, wired through `kg extract-decisions <file>` so that
agent-run doc ingestion produces Decision nodes + `decides` / `decided_in`
edges automatically. Re-run the 60-pair classify + 2-doc extract eval against
the ported code to confirm zero regression after the port.

## 2. Non-goals (Phase 1 week 3 scope)

- **No auto-extraction on import.** `kg import` stays decision-free. Extract is
  manual-trigger only (`kg extract-decisions`) until we trust the F1 in the
  wild. Auto-run lives behind a flag in week 4+.
- **No custom relation types.** Stick to existing `decides` / `decided_in`.
- **No batch/multi-doc mode.** One doc per invocation. Batching is trivial to
  add once single-doc is solid.
- **No feature flag yet.** RESOLUTION-BACKLOG d015 covers the "precision
  미달 시 off" flag; that's a Phase 2 concern once the MVP has real traffic.

## 3. What ships in week 3

### 3.1 New files

```
orgmem/src/extractor/
├── prompts.ts      # CLASSIFY_SYSTEM v2 + EXTRACT_SYSTEM v1.1 (verbatim from probe)
├── classify.ts     # classifyDecision(client, text) → {label, reasoning}
├── extract.ts      # extractDecisionsFromDoc(client, title, body) → ExtractedDecision[]
├── materialize.ts  # materializeDecisions(handle, vault, sourceDocId, extracted[]) → {created, edges}
└── types.ts        # DecisionLabel, DecisionResult, ExtractedDecision
```

### 3.2 Modified files

- `src/cli/kg.ts` — add `extract-decisions` dispatch.
- `package.json` — no new runtime deps (reuse existing fetch-based Anthropic
  client pattern; see §4.1).
- `TODO.md` — add unscheduled entry for auto-extraction-on-import (Phase 2).

### 3.3 CLI spec

```
kg extract-decisions <file> [--dry-run] [--json] [--model <id>]

  <file>        Path to a markdown file INSIDE the vault (relative to vault root
                or absolute path that resolves inside the vault). Must already
                be imported as a Document node — throws if not found.
  --dry-run     Print the extraction result but do NOT create any nodes/edges.
  --json        Emit machine-readable JSON to stdout (default: human summary).
  --model <id>  Override the classifier/extractor model
                (default: claude-haiku-4-5-20251001 — locked eval baseline).

Env:
  ANTHROPIC_API_KEY   required

Exit codes:
  0  success (including 0 decisions found)
  2  usage error / source doc not imported
  3  extraction failed (LLM error, malformed output, etc.)
```

### 3.4 Graph materialization semantics

For each extracted decision `e` with `e.text`, `e.reasoning`, `e.line`:

1. `createNode({ type: 'Decision', title: <first 80 chars of e.text, title-cased>, content: e.text + '\n\n> ' + e.reasoning, date: <source doc mtime date> })` → returns `decisionId`.
2. `createEdge({ srcId: sourceDocId, relation: 'decides', dstId: decisionId, sourceLine: 0 })` — source doc "decides" this decision. `sourceLine=0` puts it in the source doc's frontmatter edges.
3. `createEdge({ srcId: decisionId, relation: 'decided_in', dstId: sourceDocId, sourceLine: 0 })` — Decision points back at its origin doc.

**Open question for Lane A review:** is the `decides` relation direction
correct (Doc → Decision)? Alternate reading: the Decision itself "decides X"
where X is the subject matter, not the doc. If the canonical direction
conflicts, flip to `references` (Doc → Decision) + `decided_in`
(Decision → Doc) and drop `decides`. **Blocker for execution — confirm
before writing materialize.ts.**

The line-number field from the extractor is recorded in the Decision node's
frontmatter as `source_line: <n>` so a future MCP tool can jump to the exact
paragraph. It is NOT used as `sourceLine` on the edge, because week-2
`createEdge` rejects non-zero `sourceLine` (write.ts:308-312) — promote this
to an edge source_line in a later week when body-anchored edges ship.

## 4. Port specifics

### 4.1 Anthropic client — adopt orgmem's fetch-based pattern

probe uses `@anthropic-ai/sdk`; orgmem deliberately avoids it (`src/answer/client.ts`
header: "the SDK's transitive deps are heavier than we need"). Port plan:

- Reuse the existing `AnswerClient` interface shape (`{ system, user, maxTokens } → { text, usage }`).
- classify/extract get a thin helper that wraps `client.complete()` + JSON
  parsing with the same fence-stripping logic from probe's `parseJson`.
- **No @anthropic-ai/sdk added to orgmem deps.**

### 4.2 Prompt transfer — byte-for-byte

`prompts.ts` copies the two locked prompt strings from probe's `src/decisions.ts`
verbatim. A comment at the top records:

```ts
// Ported from orgmem-probe src/decisions.ts @ commit d2c3441 (2026-04-15).
// CLASSIFY_SYSTEM: P=1.000 R=0.967 F1=0.983 on 60-pair dataset (v2 locked).
// EXTRACT_SYSTEM:  recall=0.900 (18/20) on 2-doc eval (v1.1 locked).
// DO NOT edit without re-running eval/eval-baseline.mjs + eval/eval-extract.mjs.
```

### 4.3 Temperature & retry

probe uses `temperature=0` for classify. Port preserves this. Extract path in
probe does not set temperature — port preserves defaults to avoid recall
drift. Neither path uses retry in probe; keep as-is (LLM errors surface as
exit code 3).

## 5. Eval harness — stays in probe, references orgmem

Decision: **eval harness files stay in `orgmem-probe/scripts/` + dataset stays
in `~/.gstack/projects/doc-mvp/eval/`.** Do NOT mirror them into orgmem. Reasons:

1. The dataset is the source-of-truth for prompt regression; having it in one
   place avoids drift.
2. probe can be `bun link`-ed or imported via file path so the harness calls
   orgmem's ported prompts directly.
3. RESOLUTION-BACKLOG.md already lives next to the dataset.

**Integration-time regression check procedure** (run exactly once, during the
port, and then on every prompt change):

```bash
# from orgmem repo root, after the port is built
cd ~/workspace/orgmem
bun build src/extractor/prompts.ts --outdir .tmp/extractor-prompts

# run probe's eval harness against the ported prompts
cd ~/workspace/doc-mvp
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY node scripts/eval-baseline.mjs \
  --prompt-file ~/workspace/orgmem/.tmp/extractor-prompts/prompts.js \
  --label orgmem-port-classify \
  --out ~/.gstack/projects/doc-mvp/eval/results/orgmem-port-classify-YYYYMMDD.json

ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY node scripts/eval-extract.mjs \
  --prompt-file ~/workspace/orgmem/.tmp/extractor-prompts/prompts.js \
  --label orgmem-port-extract \
  --out ~/.gstack/projects/doc-mvp/eval/results/orgmem-port-extract-YYYYMMDD.json
```

**Pass criteria for the port:**
- classify: F1 ≥ 0.980 (allow ±0.003 noise from temp=0 stochasticity)
- extract: recall ≥ 0.90 (allow one unlucky extraction producing 0.85)

If either fails, the port did not faithfully copy the prompt — do not merge.

**Note:** the current `eval-baseline.mjs` / `eval-extract.mjs` import prompts
from probe's compiled `dist/decisions.js`. Adding `--prompt-file` is a small
harness change (load prompts via ESM dynamic import). This IS a probe-side
change and should ship alongside the orgmem port.

## 6. Step-by-step execution (week 3)

Block on: Lane A engine lock confirmed + relation direction decision (§3.4 Open question).

1. **Decide relation direction** (talk to Lane A). Write a one-line ADR in
   `orgmem/docs/adr/` (if that dir exists; else inline in INTEGRATION-PLAN).
2. **Port prompts + client helper.** `src/extractor/prompts.ts` + `src/extractor/client.ts` (fetch wrapper).
3. **Port classify.ts + extract.ts.** Mirror probe's function shapes 1:1 against the orgmem AnswerClient.
4. **Write materialize.ts.** Use `createNode` + `createEdge` per §3.4. Uses a single DB transaction via the engine's existing pattern.
5. **Wire `kg extract-decisions`.** Follow the dispatch pattern at `kg.ts:62-83` (`kg import`) for shape: parse args, open DB, run, print JSON or summary, close.
6. **Add tests.** `tests/extractor.test.ts` with:
   - fixture file under `tests/fixtures/` (a small markdown doc with 2 decisions + 2 non-decisions)
   - stub AnswerClient that returns canned responses → assert node/edge creation, frontmatter edges, idempotency on re-run.
7. **Add probe harness --prompt-file support.** probe-side PR.
8. **Run regression eval** per §5. Attach JSON output paths to the PR body.
9. **Update TODO.md.** Mark Week 3 extractor as DONE + add auto-extraction-on-import to Unscheduled.
10. **Surface:8 report on push.**

## 7. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Ported prompt behaves differently due to encoding/whitespace drift | Low | §5 regression check catches it pre-merge |
| orgmem fetch-client's `complete()` shape insufficient for extractor (e.g. no temperature knob) | Med | Extend `AnswerRequest` to carry optional `temperature`; default to current behavior to avoid ask-path regression |
| `createEdge` rejects non-zero sourceLine (write.ts:308) → can't anchor Decision edges to paragraphs | Known | Park source_line on the Decision node's frontmatter for now; upgrade when body-anchored edges ship |
| Decision title collisions if many decisions share similar first 80 chars | Med | `pickId` already handles this (write.ts:112) — appends `-2`, `-3`. Accept the slight ugliness in week 3 |
| Extract LLM response > `max_tokens=2000` on long docs | Low | Raise to 3000 for extract path; classify stays at 200. Add a test with a 10KB fixture |
| Relation direction chosen wrong, need to flip later | Med | Keep materialize.ts small and test-covered so a later flip is a one-line change + migration |

## 8. Post-integration follow-ups (not in scope for the port)

- Auto-extraction on `kg import` behind `--extract-decisions` flag.
- Decision deduplication across imports (same decision mentioned in 3 meeting notes → 1 Decision node, 3 `decided_in` edges).
- Per-doc extract cap tuning based on doc length (currently 15 for any doc size).
- Body-anchored Decision edges once `createEdge` supports non-zero sourceLine.
- RESOLUTION-BACKLOG d018 fix via dataset v1.1 bump (Lane C task 2).

## 9. Open questions for Lane A

1. **Relation direction** (§3.4) — `decides` Doc→Decision vs Decision→Doc? Blocks execution.
2. Is there a canonical spot for ADRs in orgmem? (`docs/adr/` doesn't exist yet.)
3. Should `materializeDecisions` own the entire transaction, or should the CLI hand a DB handle that's already inside a transaction? Pattern in `import.ts` might already answer this.
4. Is `AnswerClient.complete()` stable enough to reuse across modules, or should extractor get its own `ExtractorClient` to avoid coupling answer-path refactors to extract-path tests?
