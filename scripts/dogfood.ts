#!/usr/bin/env bun
/**
 * v0.2 dogfood harness — runs the 5 baseline queries that motivated
 * the chunking work and emits a markdown report. Meant to be executed
 * locally by the operator (needs OPENAI_API_KEY + ANTHROPIC_API_KEY —
 * we do not bake keys into CI). Output lives at
 * `perf/dogfood-v0.2-YYYYMMDD.md` unless overridden via `--out`.
 *
 * Pre-req: a vault already imported + embedded on this machine. The
 * script does NOT call `kg import` — it assumes the DB at $ORGMEM_DB
 * (or .orgmem/dev.db) already has chunks + chunk_vec populated.
 * Suggested bootstrap for a clean run:
 *
 *   rm -rf /tmp/orgmem-dogfood && mkdir -p /tmp/orgmem-dogfood
 *   export ORGMEM_DB=/tmp/orgmem-dogfood/dev.db
 *   export ORGMEM_VAULT=~/.gstack/projects/doc-mvp   # or wherever
 *   kg init
 *   kg import "$ORGMEM_VAULT"
 *   kg reindex "$ORGMEM_VAULT"       # force chunk rebuild
 *   kg embed --resume                 # needs OPENAI_API_KEY
 *   bun scripts/dogfood.ts            # needs both keys
 *
 * Baseline (v0.1) over the same 5 queries:
 *   - "Approach C 왜 선택": ❌ (misattributed to Lane C)
 *   - "eval 몇 쌍":          ✅ 70쌍 정답
 *   - "MVP 제외 기능":        ❌ (partial)
 *   - "인터뷰 템플릿":        ✅ (no-hallucinate)
 *   - "V2 precision":        ✅ 1.000 정답
 *   - "Phase 0 게이트 3":    ❌ (not found)
 *
 * v0.2 target: ≥ 3/5 improved. "Approach C 왜 선택" and "Phase 0 게이트
 * 3" must both be correct.
 */
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, defaultDbPath } from "../src/storage/sqlite.ts";
import { createOpenAIClient } from "../src/embeddings/client.ts";
import { createAnthropicClient } from "../src/answer/client.ts";
import { ask } from "../src/answer/ask.ts";

interface DogfoodQuery {
  id: string;
  query: string;
  expectedTopic: string;
  v01Baseline: "pass" | "fail" | "partial";
  notes: string;
}

const QUERIES: DogfoodQuery[] = [
  {
    id: "approach-c",
    query: "Approach C (왜 그걸 선택했지)?",
    expectedTopic: "design doc's Approach C rationale (CHOSEN marker)",
    v01Baseline: "fail",
    notes: "v0.1 misattributed this to Lane C (the agent), not the design doc's Approach C.",
  },
  {
    id: "eval-pairs",
    query: "eval dataset 몇 쌍이야?",
    expectedTopic: "eval/README: 70 pairs",
    v01Baseline: "pass",
    notes: "Small doc (6KB). v0.1 answered 70쌍 correctly.",
  },
  {
    id: "mvp-excluded",
    query: "MVP에서 제외된 기능은?",
    expectedTopic: "design doc: out-of-scope list",
    v01Baseline: "partial",
    notes: "v0.1 gave a partial answer on the 17.5KB design doc.",
  },
  {
    id: "interview-template",
    query: "인터뷰 템플릿 있어?",
    expectedTopic: "no-hallucinate — template doesn't exist",
    v01Baseline: "pass",
    notes: "v0.1 correctly said 'not found' — negative case.",
  },
  {
    id: "v2-precision",
    query: "V2 precision 수치 뭐야?",
    expectedTopic: "SUMMARY: precision = 1.000",
    v01Baseline: "pass",
    notes: "Small doc (4KB). v0.1 answered 1.000 correctly.",
  },
  {
    id: "phase0-gates",
    query: "Phase 0 게이트 3가지 뭐야?",
    expectedTopic: "CEO plan: Phase 0 gate 3-item list",
    v01Baseline: "fail",
    notes: "v0.1 couldn't find this — it's in a 16KB CEO plan's tail section.",
  },
];

interface QueryResult {
  query: DogfoodQuery;
  answer: string;
  hits: Array<{ rank: number; cite: string; distance: number }>;
  usage: { inputTokens?: number; outputTokens?: number };
  elapsedMs: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let outPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") outPath = args[++i];
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey || !anthropicKey) {
    console.error(
      "Missing API keys. Set OPENAI_API_KEY and ANTHROPIC_API_KEY before running.",
    );
    process.exit(2);
  }

  const dbPath = defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`DB not found at ${dbPath}. Run \`kg init && kg import <vault> && kg embed\` first.`);
    process.exit(2);
  }
  const handle = openDb({ path: dbPath, loadVec: true });
  const embedClient = createOpenAIClient({ apiKey: openaiKey });
  const answerClient = createAnthropicClient({ apiKey: anthropicKey });

  const results: QueryResult[] = [];
  try {
    for (const q of QUERIES) {
      process.stderr.write(`\n[dogfood] ${q.id}: ${q.query}\n`);
      const t0 = performance.now();
      const res = await ask(handle, embedClient, answerClient, q.query, {
        k: 5,
        neighborCap: 6,
      });
      const elapsed = performance.now() - t0;
      const hits = res.hits.map((h) => ({
        rank: h.rank as number,
        cite: h.cite as string,
        distance: h.distance as number,
      }));
      results.push({
        query: q,
        answer: res.answer,
        hits,
        usage: res.usage ?? {},
        elapsedMs: Math.round(elapsed),
      });
      process.stderr.write(`  hits: ${hits.map((h) => h.cite).join(", ")}\n`);
      process.stderr.write(`  answer (first 200c): ${res.answer.slice(0, 200)}\n`);
      process.stderr.write(`  ${elapsed | 0}ms, in=${res.usage?.inputTokens}, out=${res.usage?.outputTokens}\n`);
    }
  } finally {
    handle.raw.close();
  }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outFile = outPath ?? resolve(process.cwd(), `perf/dogfood-v0.2-${today}.md`);

  const md: string[] = [];
  md.push(`# Dogfood — v0.2 chunking re-measure (${new Date().toISOString()})`);
  md.push("");
  md.push(
    "Runs the 5 baseline queries against the current DB. Verdict column" +
      " is filled MANUALLY after inspecting each answer against the source" +
      " documents; the harness only records what came back. Target: ≥ 3/5" +
      " improved vs v0.1, with `approach-c` and `phase0-gates` both correct.",
  );
  md.push("");
  md.push(`| # | Query | v0.1 | v0.2 verdict | Top hit | Answer excerpt | Tokens in/out | ms |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const top = r.hits[0]?.cite ?? "—";
    const excerpt = r.answer.replace(/\n+/g, " ").slice(0, 180).replaceAll("|", "\\|");
    const tokens = `${r.usage.inputTokens ?? "?"} / ${r.usage.outputTokens ?? "?"}`;
    md.push(
      `| ${i + 1} | \`${r.query.id}\` | ${r.query.v01Baseline} | _TODO fill in_ | \`${top}\` | ${excerpt} | ${tokens} | ${r.elapsedMs} |`,
    );
  }
  md.push("");
  md.push("## Per-query details");
  for (const r of results) {
    md.push("");
    md.push(`### \`${r.query.id}\` — ${r.query.query}`);
    md.push("");
    md.push(`**Expected topic:** ${r.query.expectedTopic}`);
    md.push("");
    md.push(`**v0.1 baseline:** ${r.query.v01Baseline} — ${r.query.notes}`);
    md.push("");
    md.push("**Hits:**");
    for (const h of r.hits) {
      md.push(`- rank ${h.rank} d=${h.distance} → \`${h.cite}\``);
    }
    md.push("");
    md.push("**Answer:**");
    md.push("");
    md.push("```");
    md.push(r.answer);
    md.push("```");
    md.push("");
    md.push(`**Tokens:** in=${r.usage.inputTokens ?? "?"}, out=${r.usage.outputTokens ?? "?"}  `);
    md.push(`**Wall:** ${r.elapsedMs} ms`);
  }
  md.push("");

  writeFileSync(outFile, md.join("\n") + "\n", "utf8");
  process.stderr.write(`\nwrote ${outFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
