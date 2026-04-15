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

### 3.4 Graph materialization semantics (LOCKED)

Edge model: **one `decided_in` edge per Decision, stored in the Decision
node's frontmatter** ("this decision is documented in <SourceDoc>"). No
reverse `decides` edge on the source doc.

For each extracted decision `e` with `e.text`, `e.reasoning`, `e.line`:

1. `createNode({ type: 'Decision', title: <first 80 chars of e.text>, content: e.text + '\n\n> ' + e.reasoning, edges: [{ to: sourceDocId, relation: 'decided_in' }], date: <source doc mtime date>, metadata: { source_line: e.line } })` → returns `decisionId`.
   - The `edges: [...]` param goes into the new Decision's frontmatter (sourceLine=0), and `upsertDocNodeAndEdges` (called inside `createNode`) materializes the row in `edges` table in the same transaction.
   - No separate `createEdge` call is needed — the frontmatter edge is sufficient and is the canonical storage location for agent-authored edges per write.ts contract.
2. The line-number field from the extractor is recorded in the Decision
   node's frontmatter as `source_line: <n>` (via `metadata`) so a future
   MCP tool can jump to the exact paragraph. It is NOT used as `sourceLine`
   on the edge, because week-2 `createEdge` rejects non-zero `sourceLine`
   (write.ts:308-312) — promote to an edge `source_line` later when
   body-anchored edges ship.

File layout: Decision files land under `decisions/<YYYY-MM-DD>-<slug>.md` per
the existing `TYPE_DIR` mapping in `write.ts:13-19`. No new directory scheme.
"ADR" is an internal terminology note only — on disk it's just `decisions/`.

## 4. Port specifics

### 4.1 Anthropic client — separate `ExtractorClient` (do NOT reuse AnswerClient)

probe uses `@anthropic-ai/sdk`; orgmem deliberately avoids it (`src/answer/client.ts`
header: "the SDK's transitive deps are heavier than we need"). Port plan:

- Introduce a dedicated `ExtractorClient` in `src/extractor/client.ts`,
  parallel in shape to `AnswerClient` but with its own contract:
  - `complete({ system, user, temperature, maxTokens }) → { text, usage }`
  - `temperature` defaults to **0** (classify requires this for reproducibility;
    extract also sets 0 for the port).
  - Own fence-stripping JSON parser + self-contained 1-shot retry on JSON
    parse failure (mirrors probe's `parseJson` + `retry` in `decisions.ts`).
- **Why not reuse `AnswerClient.complete()`**: the answer path's system
  prompt is tuned for the `[[node-id]]` citation contract; its defaults and
  shape leak that context. Keeping extractor isolated prevents eval-harness
  regressions when the answer prompt evolves, and keeps the extractor
  swappable (e.g. switch to a local model later) without touching ask code.
- **No `@anthropic-ai/sdk` added to orgmem deps.** `ExtractorClient` uses
  `fetch` and the same POST shape as `AnswerClient`'s real impl.

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

Block on: Lane A engine lock confirmed. (All §9 open questions now answered —
see decisions folded into §3.4 / §4.1 / §6.4.)

1. **Port prompts + client.** `src/extractor/prompts.ts` (byte-for-byte copy)
   + `src/extractor/client.ts` (`ExtractorClient` per §4.1 — fetch, temp=0,
   JSON parse w/ 1-shot retry).
2. **Port classify.ts + extract.ts.** Mirror probe's function shapes 1:1
   against `ExtractorClient`.
3. **Write materialize.ts** per §3.4 edge model (single `decided_in` edge in
   Decision frontmatter). Own the transaction: follow `src/vault/import.ts`'s
   pattern — `materializeDecisions(handle, vault, sourceDocId, extracted[])`
   opens `BEGIN IMMEDIATE`, calls `createNode` per decision, `COMMIT` on
   success, `ROLLBACK` on any error. CLI only passes the DbHandle.
4. **Wire `kg extract-decisions`.** Follow the dispatch pattern at
   `kg.ts:62-83` (`kg import`): parse args, `runMigrations()`, `openDb`,
   call extractor + materializer, print JSON or summary, `handle.raw.close()`.
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
| `createEdge`/`createNode` rejects non-zero sourceLine → can't anchor Decision edges to paragraphs | Known | Park `source_line` on Decision frontmatter (as `metadata.source_line`) for now; upgrade when body-anchored edges ship |
| Decision title collisions if many decisions share similar first 80 chars | Med | `pickId` already handles this (write.ts:112) — appends `-2`, `-3`. Accept the slight ugliness in week 3 |
| Extract LLM response > `max_tokens=2000` on long docs | Low | Raise to 3000 for extract path; classify stays at 200. Add a test with a 10KB fixture |
| Partial failure mid-batch leaves orphan Decision nodes | Low | `materializeDecisions` wraps the whole set in one BEGIN IMMEDIATE / COMMIT (per §6.3). ROLLBACK on any error = all-or-nothing per doc. |
| `ExtractorClient` diverges from `AnswerClient` and we end up with two HTTP wrappers to maintain | Med | Accept the duplication — it's ~50 lines and the isolation is the point. Revisit only if a third caller appears. |

## 8. Post-integration follow-ups (not in scope for the port)

- Auto-extraction on `kg import` behind `--extract-decisions` flag.
- Decision deduplication across imports (same decision mentioned in 3 meeting notes → 1 Decision node, 3 `decided_in` edges).
- Per-doc extract cap tuning based on doc length (currently 15 for any doc size).
- Body-anchored Decision edges once `createEdge` supports non-zero sourceLine.
- RESOLUTION-BACKLOG d018 fix via dataset v1.1 bump (Lane C task 2).

## 9. Open questions — RESOLVED (2026-04-15)

All blocking decisions are locked. Kept here for the execution record:

1. **Relation direction**: **Decision →(`decided_in`)→ SourceDoc**, edge stored
   in the Decision's frontmatter. Single edge; no reverse `decides`. (§3.4)
2. **ADR path**: reuse `decisions/<date>-<slug>.md` from the existing
   `TYPE_DIR` mapping. No new `docs/adr/` directory. "ADR" stays as internal
   terminology only. (§3.4)
3. **Transaction ownership**: `materializeDecisions` owns the transaction
   (BEGIN IMMEDIATE / COMMIT / ROLLBACK) following the `src/vault/import.ts`
   pattern. CLI just passes the DbHandle. (§6.3)
4. **Client separation**: ship a dedicated `ExtractorClient`; do NOT reuse
   `AnswerClient`. Decouples eval harness from answer-path prompt evolution
   and keeps the extractor swappable. (§4.1)
