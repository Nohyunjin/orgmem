#!/usr/bin/env bun
/**
 * W2.5 engineering-gate perf harness.
 *
 * Measures:
 *   1. Import throughput: 1000 synthetic MD files → SQLite wall time.
 *   2. Embed backfill throughput: how long to embed N nodes (stub by
 *      default; real OpenAI when --with-real-embed + OPENAI_API_KEY).
 *   3. Search latency p50/p99 over K queries (stub embedding for the
 *      query vector; measures pure vec0 MATCH + neighbor fetch path).
 *   4. Ask end-to-end latency p50/p99 (stub clients by default; real
 *      clients when --with-real-ask + both keys).
 *
 * Writes:  perf/bench-YYYYMMDD.json
 *
 * Targets (per eng-gate):
 *   - `kg ask` p50 ≤ 3000ms (embed 20ms + search 200ms + LLM 2500ms)
 *   - `kg embed --resume` 1000 nodes ≤ 120s
 *   - search p50 ≤ 200ms (local only)
 *
 * Stubbed runs produce local numbers that are comparable across commits;
 * they do NOT exercise network latency. Live numbers require API keys and
 * are marked `live: true` in the output JSON.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { importVault } from "../src/vault/import.ts";
import { runBackfill } from "../src/embeddings/backfill.ts";
import { createOpenAIClient, type EmbedClient } from "../src/embeddings/client.ts";
import { search } from "../src/graph/search.ts";
import { ask } from "../src/answer/ask.ts";
import {
  createAnthropicClient,
  createStubAnswerClient,
  type AnswerClient,
} from "../src/answer/client.ts";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../src/embeddings/model.ts";

interface Flags {
  files: number;
  queries: number;
  asks: number;
  withRealEmbed: boolean;
  withRealAsk: boolean;
  out?: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    files: 1000,
    queries: 100,
    asks: 10,
    withRealEmbed: false,
    withRealAsk: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files") f.files = Number(argv[++i]);
    else if (a === "--queries") f.queries = Number(argv[++i]);
    else if (a === "--asks") f.asks = Number(argv[++i]);
    else if (a === "--with-real-embed") f.withRealEmbed = true;
    else if (a === "--with-real-ask") f.withRealAsk = true;
    else if (a === "--out") f.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  return f;
}

function printHelp(): void {
  process.stdout.write(
    `bench — orgmem perf harness (W2.5 eng gate)

Flags:
  --files N            synthetic file count (default 1000)
  --queries N          search queries for p50/p99 (default 100)
  --asks N             ask-pipeline runs for p50/p99 (default 10)
  --with-real-embed    use real OpenAI embeddings (needs OPENAI_API_KEY)
  --with-real-ask      use real Anthropic LLM for ask (needs ANTHROPIC_API_KEY + OPENAI_API_KEY)
  --out <path>         override output path (default perf/bench-YYYYMMDD.json)

Targets:
  kg ask p50     ≤ 3000ms
  kg embed 1000  ≤ 120000ms
  search p50     ≤ 200ms
`,
  );
}

function synthesize(vault: string, count: number): void {
  mkdirSync(vault, { recursive: true });
  for (let i = 0; i < count; i++) {
    const bucket = String(Math.floor(i / 50)).padStart(3, "0");
    const dir = join(vault, `bucket-${bucket}`);
    mkdirSync(dir, { recursive: true });
    const id = `node-${String(i).padStart(4, "0")}`;
    const other = `node-${String((i + 7) % count).padStart(4, "0")}`;
    const other2 = `node-${String((i + 13) % count).padStart(4, "0")}`;
    const other3 = `node-${String((i + 97) % count).padStart(4, "0")}`;
    const fm = [
      "---",
      `id: ${id}`,
      "type: Document",
      `title: "Synthetic node ${i}"`,
      "edges:",
      `  - to: ${other}`,
      "    relation: references",
      `  - to: ${other2}`,
      "    relation: drives",
      "---",
    ].join("\n");
    const body = [
      `# Synthetic node ${i}`,
      "",
      `This doc links to [[${other}]] in the body too.`,
      "",
      `See also [[${other3}]] for related context.`,
      "",
    ].join("\n");
    writeFileSync(join(dir, `${id}.md`), `${fm}\n${body}`);
  }
}

/**
 * Deterministic "fake embedding" client: sha256(input) seeds a Float32Array.
 * Not a useful ANN space, but cheap and reproducible — exactly what we want
 * for local throughput + search-latency measurements.
 */
function deterministicEmbedClient(): EmbedClient {
  return {
    async embed(inputs) {
      return inputs.map((input) => {
        const digest = createHash("sha256").update(input).digest();
        const v = new Float32Array(EMBEDDING_DIM);
        // Repeat the 32-byte digest to fill 1536 floats; normalize to unit-ish.
        for (let i = 0; i < EMBEDDING_DIM; i++) {
          const byte = digest[i % digest.length] ?? 0;
          v[i] = (byte - 128) / 128; // [-1, 1)
        }
        // Crude L2 normalize for more realistic distances.
        let norm = 0;
        for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i]! * v[i]!;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = v[i]! / norm;
        return v;
      });
    },
  };
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function stats(samples: number[]): {
  n: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
} {
  if (samples.length === 0) {
    return { n: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    n: samples.length,
    minMs: round(Math.min(...samples)),
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    p99Ms: round(percentile(samples, 0.99)),
    maxMs: round(Math.max(...samples)),
    meanMs: round(mean),
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function measureImport(
  vault: string,
  db: string,
  fileCount: number,
): Promise<{ wallMs: number; nodes: number; edges: number }> {
  synthesize(vault, fileCount);
  // Load vec from the first open so later embed/search phases don't hit
  // the "setCustomSQLite after SQLite already loaded" trap.
  runMigrations(db, { loadVec: true });
  const handle = openDb({ path: db, loadVec: true });
  try {
    const report = importVault(handle, vault);
    return {
      wallMs: report.wallMs,
      nodes: report.nodesUpserted,
      edges: report.edgesWritten,
    };
  } finally {
    handle.raw.close();
  }
}

async function measureEmbed(
  db: string,
  client: EmbedClient,
  label: string,
): Promise<{ label: string; durationMs: number; total: number; embedded: number; failed: number }> {
  const handle = openDb({ path: db, loadVec: true });
  try {
    const t0 = performance.now();
    const report = await runBackfill(handle, client, { batchSize: 32 });
    const wall = performance.now() - t0;
    return {
      label,
      durationMs: round(wall),
      total: report.total,
      embedded: report.embedded,
      failed: report.failed,
    };
  } finally {
    handle.raw.close();
  }
}

async function measureSearch(
  db: string,
  client: EmbedClient,
  queryCount: number,
): Promise<ReturnType<typeof stats> & { hitsPerQueryMean: number }> {
  const handle = openDb({ path: db, loadVec: true });
  try {
    const samples: number[] = [];
    let totalHits = 0;
    // Warm up (JIT + page cache).
    for (let i = 0; i < 5; i++) {
      await search(handle, client, `warmup query ${i}`, { k: 20 });
    }
    for (let i = 0; i < queryCount; i++) {
      const q = `bench query ${i} about synthetic node ${i * 31}`;
      const t0 = performance.now();
      const hits = await search(handle, client, q, { k: 20, neighborCap: 20 });
      samples.push(performance.now() - t0);
      totalHits += hits.length;
    }
    return {
      ...stats(samples),
      hitsPerQueryMean: round(totalHits / Math.max(1, queryCount)),
    };
  } finally {
    handle.raw.close();
  }
}

async function measureAsk(
  db: string,
  embedClient: EmbedClient,
  answerClient: AnswerClient,
  askCount: number,
): Promise<ReturnType<typeof stats>> {
  const handle = openDb({ path: db, loadVec: true });
  try {
    const samples: number[] = [];
    for (let i = 0; i < askCount; i++) {
      const q = `What does synthetic node ${i * 17} reference?`;
      const t0 = performance.now();
      await ask(handle, embedClient, answerClient, q, { k: 5, neighborCap: 6 });
      samples.push(performance.now() - t0);
    }
    return stats(samples);
  } finally {
    handle.raw.close();
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const workDir = mkdtempSync(resolve(tmpdir(), "orgmem-bench-"));
  const vault = join(workDir, "vault");
  const db = join(workDir, "bench.db");

  const startedAt = new Date().toISOString();
  const result: Record<string, unknown> = {
    startedAt,
    host: {
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
    },
    flags,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIM,
    targets: { askP50Ms: 3000, embed1000Ms: 120_000, searchP50Ms: 200 },
  };

  try {
    // ── 1. Import ──────────────────────────────────────────────────────
    process.stderr.write(`[1/4] import (${flags.files} files)…\n`);
    const importReport = await measureImport(vault, db, flags.files);
    result.import = {
      ...importReport,
      msPerFile: round(importReport.wallMs / flags.files),
    };
    process.stderr.write(
      `      wall=${importReport.wallMs}ms, nodes=${importReport.nodes}, edges=${importReport.edges}\n`,
    );

    // ── 2. Embed (stub — always; real optional) ───────────────────────
    process.stderr.write(`[2/4] embed backfill (stub, deterministic)…\n`);
    const stubEmbed = deterministicEmbedClient();
    const embedStub = await measureEmbed(db, stubEmbed, "stub");
    process.stderr.write(
      `      stub: ${embedStub.durationMs}ms for ${embedStub.embedded}/${embedStub.total}\n`,
    );
    const embedRuns: unknown[] = [embedStub];
    if (flags.withRealEmbed) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("--with-real-embed requires OPENAI_API_KEY");
      // Reset embedding status so the backfill has work to do.
      const h = openDb({ path: db, loadVec: true });
      try {
        h.raw.exec("UPDATE nodes SET embedding_status='pending';");
        h.raw.exec("DELETE FROM node_vec;");
      } finally {
        h.raw.close();
      }
      const realEmbed = createOpenAIClient({ apiKey: key });
      process.stderr.write(`      embed (real OpenAI)…\n`);
      const embedLive = await measureEmbed(db, realEmbed, "openai");
      process.stderr.write(
        `      openai: ${embedLive.durationMs}ms for ${embedLive.embedded}/${embedLive.total}\n`,
      );
      embedRuns.push(embedLive);
    }
    result.embed = { runs: embedRuns };

    // ── 3. Search latency ──────────────────────────────────────────────
    process.stderr.write(`[3/4] search latency (${flags.queries} queries, stub query embed)…\n`);
    const searchReport = await measureSearch(db, stubEmbed, flags.queries);
    result.search = searchReport;
    process.stderr.write(
      `      p50=${searchReport.p50Ms}ms, p95=${searchReport.p95Ms}ms, p99=${searchReport.p99Ms}ms\n`,
    );

    // ── 4. Ask latency ─────────────────────────────────────────────────
    process.stderr.write(`[4/4] ask latency (${flags.asks} runs)…\n`);
    if (flags.withRealAsk) {
      const ok = process.env.OPENAI_API_KEY;
      const ak = process.env.ANTHROPIC_API_KEY;
      if (!ok || !ak) throw new Error("--with-real-ask requires both OPENAI_API_KEY and ANTHROPIC_API_KEY");
      const realEmbed = createOpenAIClient({ apiKey: ok });
      const realAnswer = createAnthropicClient({ apiKey: ak });
      const askLive = await measureAsk(db, realEmbed, realAnswer, flags.asks);
      result.ask = { live: true, ...askLive };
    } else {
      // Stub-only ask: isolates local overhead (search + prompt build). The
      // LLM call returns instantly (stub). Useful as a local lower bound,
      // not as a wall-clock estimate.
      const stubAnswer = createStubAnswerClient([
        { match: /./, text: "stubbed answer for bench" },
      ]);
      const askStub = await measureAsk(db, stubEmbed, stubAnswer, flags.asks);
      result.ask = {
        live: false,
        note: "stub embed + stub answer — wall-clock excludes network/LLM latency",
        ...askStub,
      };
    }

    // ── Targets verdict ───────────────────────────────────────────────
    const searchVerdict =
      (result.search as ReturnType<typeof stats>).p50Ms <= 200 ? "PASS" : "FAIL";
    const embedStubReport = embedStub;
    const embedScaleFactor = flags.files / 1000;
    const embed1000Ms = round(embedStubReport.durationMs / embedScaleFactor);
    // Only evaluate real-embed vs 120s target if we actually ran live.
    const embedLiveReport = embedRuns.find(
      (r) => (r as { label: string }).label === "openai",
    ) as { durationMs: number } | undefined;
    const embedVerdict = embedLiveReport
      ? embedLiveReport.durationMs <= 120_000
        ? "PASS"
        : "FAIL"
      : "SKIP (no --with-real-embed)";
    const askReport = result.ask as ReturnType<typeof stats> & { live: boolean };
    const askVerdict = askReport.live
      ? askReport.p50Ms <= 3000
        ? "PASS"
        : "FAIL"
      : "SKIP (no --with-real-ask)";
    result.verdicts = {
      searchP50: searchVerdict,
      embed1000: embedVerdict,
      askP50: askVerdict,
      embedStub1000Extrapolated: embed1000Ms,
    };

    result.finishedAt = new Date().toISOString();

    const outPath =
      flags.out ?? resolve(process.cwd(), `perf/bench-${today()}.json`);
    mkdirSync(resolve(outPath, ".."), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    process.stderr.write(`\nwrote ${outPath}\n`);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`bench fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
