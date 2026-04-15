import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { importVault } from "../src/vault/import.ts";
import { createOpenAIClient, createStubClient } from "../src/embeddings/client.ts";
import { runBackfill, embeddingInputFor } from "../src/embeddings/backfill.ts";
import { EMBEDDING_DIM } from "../src/embeddings/model.ts";

function mkWs() {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-embed-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  return { dir, vault, db };
}

function fakeVec(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  // Non-zero at a seed-dependent index keeps k-NN ordering predictable.
  v[seed % EMBEDDING_DIM] = 1;
  return v;
}

function writeSampleVault(vault: string): Map<string, string> {
  const inputs = new Map<string, string>();
  for (let i = 0; i < 5; i++) {
    const slug = `doc-${String(i).padStart(2, "0")}`;
    writeFileSync(
      join(vault, `${slug}.md`),
      `---
id: ${slug}
type: Document
title: "Doc ${i}"
---
# Doc ${i}

Content for node ${i}.
`,
    );
    const title = `Doc ${i}`;
    const body = `# Doc ${i}\n\nContent for node ${i}.\n`;
    inputs.set(slug, `${title}\n\n${body}`);
  }
  return inputs;
}

describe("embeddings backfill", () => {
  let ws: ReturnType<typeof mkWs>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWs();
    runMigrations(ws.db);
    handle = openDb({ path: ws.db, loadVec: true });
    writeSampleVault(ws.vault);
    importVault(handle, ws.vault);
  });
  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("import marks all new nodes as pending", () => {
    const rows = handle.raw
      .prepare("SELECT id, embedding_status FROM nodes ORDER BY id;")
      .all() as Array<{ id: string; embedding_status: string }>;
    expect(rows.length).toBe(5);
    for (const r of rows) expect(r.embedding_status).toBe("pending");
  });

  test("runBackfill embeds everything with a stub client", async () => {
    const map = new Map<string, Float32Array>();
    for (let i = 0; i < 5; i++) {
      map.set(`Doc ${i}\n\n# Doc ${i}\n\nContent for node ${i}.\n`, fakeVec(i));
    }
    const client = createStubClient(map);
    const report = await runBackfill(handle, client, { batchSize: 2 });
    expect(report.total).toBe(5);
    expect(report.embedded).toBe(5);
    expect(report.failed).toBe(0);
    expect(report.batchesRun).toBeGreaterThanOrEqual(3);

    const rows = handle.raw
      .prepare("SELECT embedding_status FROM nodes;")
      .all() as Array<{ embedding_status: string }>;
    for (const r of rows) expect(r.embedding_status).toBe("embedded");

    const vecCount = (
      handle.raw.prepare("SELECT COUNT(*) AS c FROM node_vec;").get() as { c: number }
    ).c;
    expect(vecCount).toBe(5);
  });

  test("second runBackfill is a no-op on already-embedded nodes", async () => {
    const map = new Map<string, Float32Array>();
    for (let i = 0; i < 5; i++) {
      map.set(`Doc ${i}\n\n# Doc ${i}\n\nContent for node ${i}.\n`, fakeVec(i));
    }
    const client = createStubClient(map);
    await runBackfill(handle, client, { batchSize: 5 });
    const second = await runBackfill(handle, client, { batchSize: 5 });
    expect(second.processed).toBe(0);
    expect(second.total).toBe(0);
  });

  test("a failing embed marks nodes failed, and retryFailed flips them back", async () => {
    const alwaysFailing = {
      embed: async () => {
        throw new Error("HTTP 500: synthesized failure");
      },
    };
    const first = await runBackfill(handle, alwaysFailing, { batchSize: 3 });
    expect(first.failed).toBeGreaterThan(0);

    const failedCount = (
      handle.raw
        .prepare("SELECT COUNT(*) AS c FROM nodes WHERE embedding_status='failed';")
        .get() as { c: number }
    ).c;
    expect(failedCount).toBeGreaterThan(0);

    const map = new Map<string, Float32Array>();
    for (let i = 0; i < 5; i++) {
      map.set(`Doc ${i}\n\n# Doc ${i}\n\nContent for node ${i}.\n`, fakeVec(i));
    }
    const client = createStubClient(map);
    const retry = await runBackfill(handle, client, { retryFailed: true, batchSize: 5 });
    expect(retry.embedded).toBeGreaterThan(0);
    expect(retry.failed).toBe(0);
  });

  test("content change on reindex flips embedded → pending", async () => {
    const map = new Map<string, Float32Array>();
    for (let i = 0; i < 5; i++) {
      map.set(`Doc ${i}\n\n# Doc ${i}\n\nContent for node ${i}.\n`, fakeVec(i));
    }
    const client = createStubClient(map);
    await runBackfill(handle, client, { batchSize: 5 });

    // Mutate one doc's body and re-import.
    writeFileSync(
      join(ws.vault, "doc-00.md"),
      `---
id: doc-00
type: Document
title: "Doc 0"
---
# Doc 0

CHANGED body.
`,
    );
    importVault(handle, ws.vault);

    const statuses = handle.raw
      .prepare("SELECT id, embedding_status FROM nodes ORDER BY id;")
      .all() as Array<{ id: string; embedding_status: string }>;
    const doc00 = statuses.find((s) => s.id === "doc-00");
    expect(doc00?.embedding_status).toBe("pending");
    // The unchanged docs should stay 'embedded'.
    for (const s of statuses) {
      if (s.id !== "doc-00") expect(s.embedding_status).toBe("embedded");
    }
  });
});

describe("OpenAI client 429 retry", () => {
  test("exponential backoff retries and eventually succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, _opts: RequestInit) => {
      calls += 1;
      if (calls < 3) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      const vec = new Array(EMBEDDING_DIM).fill(0);
      vec[0] = 1;
      return new Response(
        JSON.stringify({ data: [{ embedding: vec, index: 0 }], model: "text-embedding-3-small" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const sleepCalls: number[] = [];
    const client = createOpenAIClient({
      apiKey: "sk-test",
      fetchImpl,
      backoff: {
        initialMs: 10,
        maxMs: 100,
        maxRetries: 5,
        jitter: false,
        sleepImpl: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    });
    const [v] = await client.embed(["hello"]);
    expect(v).toBeDefined();
    expect(v?.length).toBe(EMBEDDING_DIM);
    expect(calls).toBe(3);
    // Two waits before success (initialMs=10, then doubled to 20 — but
    // Retry-After: 0 overrides to 0ms each time).
    expect(sleepCalls.length).toBe(2);
  });

  test("non-retryable status fails fast with body context", async () => {
    const fetchImpl = (async () =>
      new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const client = createOpenAIClient({ apiKey: "sk-test", fetchImpl });
    await expect(client.embed(["hello"])).rejects.toThrow(/HTTP 401/);
  });
});

describe("embeddingInputFor", () => {
  test("joins title + content with blank line", () => {
    const out = embeddingInputFor({ id: "x", type: "Document", title: "Hello", content: "Body." });
    expect(out).toBe("Hello\n\nBody.");
  });
  test("falls back to id when title/content are missing", () => {
    const out = embeddingInputFor({ id: "only-id", type: "Document", title: null, content: null });
    expect(out).toBe("only-id");
  });
});
