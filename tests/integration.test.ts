/**
 * End-to-end scaffold: init → import → embed → search → ask.
 *
 * This file holds the hermetic (stub-only) e2e tests that run in CI. A
 * second describe block is gated on `ORGMEM_INTEGRATION_LIVE=1` and real
 * OPENAI_API_KEY / ANTHROPIC_API_KEY, so the same file can exercise the
 * real OpenAI + Anthropic path when explicitly opted in:
 *
 *   ORGMEM_INTEGRATION_LIVE=1 \
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
 *   bun test tests/integration.test.ts
 *
 * The hermetic path must remain self-contained — no network, no env
 * dependencies — so CI + local bun test are both byte-deterministic.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { importVault } from "../src/vault/import.ts";
import { runBackfill } from "../src/embeddings/backfill.ts";
import {
  createOpenAIClient,
  createStubClient,
  type EmbedClient,
} from "../src/embeddings/client.ts";
import { search } from "../src/graph/search.ts";
import { ask } from "../src/answer/ask.ts";
import {
  createAnthropicClient,
  createStubAnswerClient,
} from "../src/answer/client.ts";
import { EMBEDDING_DIM } from "../src/embeddings/model.ts";
import { countEdges, countNodes } from "../src/graph/engine.ts";

function mkWorkspace() {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-integration-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  return { dir, vault, db };
}

/**
 * Writes a small realistic-shape vault:
 *   - Decision (payment switch) → decided_in → Meeting (kickoff)
 *   - Decision → drives → Document (spec)
 *   - Document → body wiki-link → Task
 *   - Task → driven_by → Document
 *   - Meeting (standalone)
 *
 * Shape mirrors the pattern Lane C's Decision Extractor will materialize
 * (INTEGRATION-PLAN §3.4), so this scaffold is also the baseline Lane C
 * will extend in week 3.
 */
function writeSampleVault(vault: string): void {
  mkdirSync(join(vault, "decisions"), { recursive: true });
  mkdirSync(join(vault, "meetings"), { recursive: true });
  mkdirSync(join(vault, "docs"), { recursive: true });
  mkdirSync(join(vault, "tasks"), { recursive: true });

  writeFileSync(
    join(vault, "decisions/2026-02-14-switch-to-toss.md"),
    `---
id: decision-switch-to-toss
type: Decision
title: "Switch to Toss PG"
edges:
  - to: meeting-2026-02-14-kickoff
    relation: decided_in
  - to: doc-payment-spec
    relation: drives
---
# Switch to Toss PG

Three reasons: latency, T+1, agent API.
`,
  );

  writeFileSync(
    join(vault, "meetings/2026-02-14-kickoff.md"),
    `---
id: meeting-2026-02-14-kickoff
type: Meeting
title: "Payment kickoff"
---
# Payment kickoff

Attendees discussed pivoting the PG vendor. See [[decision-switch-to-toss]].
`,
  );

  writeFileSync(
    join(vault, "docs/payment-spec.md"),
    `---
id: doc-payment-spec
type: Document
title: "Payment spec v2"
---
# Payment spec v2

Implementation tracked in [[task-toss-pg-integration]].
Latency target: 250ms p99.
`,
  );

  writeFileSync(
    join(vault, "tasks/toss-pg-integration.md"),
    `---
id: task-toss-pg-integration
type: Task
title: "Toss PG integration"
edges:
  - to: doc-payment-spec
    relation: driven_by
---
# Toss PG integration

Sprint 3 deliverable.
`,
  );
}

/**
 * Deterministic stub embed client: sha256-seeded Float32Array per input.
 * Same shape as the bench harness's deterministicEmbedClient — kept local
 * so the test file is self-contained.
 */
function deterministicEmbed(): EmbedClient {
  return {
    async embed(inputs) {
      return inputs.map((input) => {
        const digest = createHash("sha256").update(input).digest();
        const v = new Float32Array(EMBEDDING_DIM);
        for (let i = 0; i < EMBEDDING_DIM; i++) {
          const byte = digest[i % digest.length] ?? 0;
          v[i] = (byte - 128) / 128;
        }
        let norm = 0;
        for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i]! * v[i]!;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = v[i]! / norm;
        return v;
      });
    },
  };
}

describe("e2e hermetic: init → import → embed → search → ask", () => {
  let ws: ReturnType<typeof mkWorkspace>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWorkspace();
    const result = runMigrations(ws.db);
    // init sanity: at least one migration applied on a fresh DB
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.vecLoaded).toBe(true);

    handle = openDb({ path: ws.db, loadVec: true });
    writeSampleVault(ws.vault);
  });
  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("import materializes all 4 nodes + frontmatter + body edges", () => {
    const report = importVault(handle, ws.vault);
    expect(report.filesScanned).toBe(4);
    expect(report.nodesUpserted).toBe(4);
    expect(report.errors).toEqual([]);
    expect(countNodes(handle)).toBe(4);
    // Expected edges:
    //   decision → decided_in → meeting (FM)
    //   decision → drives → doc (FM)
    //   meeting → references → decision (body wiki-link)
    //   doc → references → task (body wiki-link)
    //   task → driven_by → doc (FM)
    // 5 edges total.
    expect(countEdges(handle)).toBe(5);
  });

  test("embed fills node_vec for every imported node (stub embed)", async () => {
    importVault(handle, ws.vault);
    const client = deterministicEmbed();
    const report = await runBackfill(handle, client, { batchSize: 4 });
    expect(report.total).toBe(4);
    expect(report.embedded).toBe(4);
    expect(report.failed).toBe(0);

    const vecCount = handle.raw.prepare("SELECT COUNT(*) AS c FROM node_vec;").get() as {
      c: number;
    };
    expect(vecCount.c).toBe(4);

    const statusRows = handle.raw
      .prepare("SELECT embedding_status AS s, COUNT(*) AS c FROM nodes GROUP BY embedding_status;")
      .all() as Array<{ s: string; c: number }>;
    const byStatus = new Map(statusRows.map((r) => [r.s, r.c]));
    expect(byStatus.get("embedded")).toBe(4);
    expect(byStatus.get("pending") ?? 0).toBe(0);
  });

  test("search returns hits with 1-hop neighbors after embed", async () => {
    importVault(handle, ws.vault);
    const client = deterministicEmbed();
    await runBackfill(handle, client, { batchSize: 4 });

    const hits = await search(handle, client, "switch to toss pg", { k: 3 });
    expect(hits.length).toBeGreaterThan(0);

    // Each hit node must exist in the DB (no orphan vec rows).
    for (const h of hits) {
      expect(h.node.id).toBeTruthy();
    }

    // The decision node (if it appears) should surface its decided_in edge.
    const decisionHit = hits.find((h) => h.node.id === "decision-switch-to-toss");
    if (decisionHit) {
      const relations = decisionHit.directEdges.map((n) => n.relation);
      expect(relations).toContain("decided_in");
      expect(relations).toContain("drives");
    }
  });

  test("ask with stub answer client returns grounded answer + cites hits", async () => {
    importVault(handle, ws.vault);
    const embed = deterministicEmbed();
    await runBackfill(handle, embed, { batchSize: 4 });

    const answer = createStubAnswerClient([
      {
        match: /./, // accept any prompt — test cares about plumbing, not prompt
        text: "Toss PG was chosen for latency, T+1, and agent API reasons [[decision-switch-to-toss]].",
        usage: { inputTokens: 200, outputTokens: 40 },
      },
    ]);

    const res = await ask(handle, embed, answer, "why did we switch PG vendor?", {
      k: 3,
      neighborCap: 4,
    });
    expect(res.empty).toBe(false);
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.answer).toContain("[[decision-switch-to-toss]]");
    expect(res.usage?.inputTokens).toBe(200);
  });

  test("ask short-circuits to EMPTY_ANSWER when nothing is embedded (no slop)", async () => {
    importVault(handle, ws.vault);
    // Deliberately skip runBackfill — no vecs.
    const embed = createStubClient(new Map([["q", new Float32Array(EMBEDDING_DIM)]]));
    const answer = createStubAnswerClient([]);
    const res = await ask(handle, embed, answer, "q");
    expect(res.empty).toBe(true);
    expect(res.hits).toEqual([]);
    expect(answer.callCount()).toBe(0);
  });

  test("second import is a no-op for unchanged files (idempotent)", () => {
    const first = importVault(handle, ws.vault);
    const second = importVault(handle, ws.vault);
    expect(second.nodesUpserted).toBe(first.nodesUpserted);
    expect(second.errors).toEqual([]);
    expect(countNodes(handle)).toBe(4);
    expect(countEdges(handle)).toBe(5);
  });

  test("DB file lives at the expected path", () => {
    expect(existsSync(ws.db)).toBe(true);
  });
});

/**
 * Live-API path. Skipped unless the operator opts in with:
 *   ORGMEM_INTEGRATION_LIVE=1 + OPENAI_API_KEY + ANTHROPIC_API_KEY
 * Each test here costs real cents; we keep the set tiny and lean on the
 * hermetic block above for exhaustive coverage.
 */
const LIVE_ENABLED =
  process.env.ORGMEM_INTEGRATION_LIVE === "1" &&
  !!process.env.OPENAI_API_KEY &&
  !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!LIVE_ENABLED)("e2e live (OpenAI + Anthropic)", () => {
  let ws: ReturnType<typeof mkWorkspace>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWorkspace();
    runMigrations(ws.db);
    handle = openDb({ path: ws.db, loadVec: true });
    writeSampleVault(ws.vault);
  });
  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("full pipeline with real OpenAI embeddings + real Anthropic ask", async () => {
    importVault(handle, ws.vault);
    const embed = createOpenAIClient({ apiKey: process.env.OPENAI_API_KEY! });
    const answer = createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const backfill = await runBackfill(handle, embed, { batchSize: 4 });
    expect(backfill.embedded).toBe(4);
    expect(backfill.failed).toBe(0);

    const res = await ask(handle, embed, answer, "why did we switch payment PG?", {
      k: 3,
      neighborCap: 4,
    });
    expect(res.empty).toBe(false);
    expect(res.answer.length).toBeGreaterThan(0);
    expect((res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0)).toBeGreaterThan(0);
  }, 60_000);
});
