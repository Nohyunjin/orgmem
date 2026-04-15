import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { importVault } from "../src/vault/import.ts";
import { createStubClient } from "../src/embeddings/client.ts";
import { runBackfill } from "../src/embeddings/backfill.ts";
import { search, formatHits } from "../src/graph/search.ts";
import { EMBEDDING_DIM } from "../src/embeddings/model.ts";

function mkWs() {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-search-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  return { dir, vault, db };
}

/** Build a unit vector that is non-zero only at the given index. */
function unitVec(idx: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[idx % EMBEDDING_DIM] = 1;
  return v;
}

function writeVaultWithEdges(vault: string) {
  writeFileSync(
    join(vault, "spec.md"),
    `---
id: doc-spec
type: Document
title: "Payment spec"
edges:
  - to: meeting-kickoff
    relation: decided_in
---
# Payment spec

Refers to [[task-toss]].
`,
  );
  writeFileSync(
    join(vault, "task.md"),
    `---
id: task-toss
type: Task
title: "Toss PG integration"
edges:
  - to: doc-spec
    relation: driven_by
---
# Toss PG integration
`,
  );
  writeFileSync(
    join(vault, "meeting.md"),
    `---
id: meeting-kickoff
type: Meeting
title: "Payment kickoff"
---
# Payment kickoff
`,
  );
  writeFileSync(
    join(vault, "unrelated.md"),
    `---
id: doc-random
type: Document
title: "Totally unrelated"
---
# Totally unrelated

Cats and yarn.
`,
  );
}

describe("vec search + 1-hop", () => {
  let ws: ReturnType<typeof mkWs>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWs();
    runMigrations(ws.db);
    handle = openDb({ path: ws.db, loadVec: true });
    writeVaultWithEdges(ws.vault);
    importVault(handle, ws.vault);
  });
  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("returns [] when nothing has been embedded yet (no slop)", async () => {
    const client = createStubClient(new Map([["anything", unitVec(0)]]));
    const hits = await search(handle, client, "anything");
    expect(hits).toEqual([]);
  });

  test("ranks the node whose embedding matches the query vector", async () => {
    // Give each doc a distinctive vector; the query matches spec exactly.
    const vecs = new Map<string, Float32Array>();
    vecs.set("Payment spec\n\n# Payment spec\n\nRefers to [[task-toss]].\n", unitVec(10));
    vecs.set("Toss PG integration\n\n# Toss PG integration\n", unitVec(20));
    vecs.set("Payment kickoff\n\n# Payment kickoff\n", unitVec(30));
    vecs.set("Totally unrelated\n\n# Totally unrelated\n\nCats and yarn.\n", unitVec(40));
    // Query vector identical to spec's vector:
    vecs.set("payment spec query", unitVec(10));

    const client = createStubClient(vecs);
    await runBackfill(handle, client, { batchSize: 4 });

    const hits = await search(handle, client, "payment spec query", { k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.node.id).toBe("doc-spec");
    expect(hits[0]?.distance).toBeLessThan(0.001);

    // 1-hop expansion: doc-spec has one direct (decided_in → meeting-kickoff)
    // and one inverse (task-toss driven_by doc-spec).
    const direct = hits[0]?.directEdges ?? [];
    const inverse = hits[0]?.inverseEdges ?? [];
    const directByRel = new Map(direct.map((n) => [n.relation, n]));
    expect(directByRel.has("decided_in")).toBe(true);
    expect(directByRel.get("decided_in")?.node?.id).toBe("meeting-kickoff");
    // Also the wiki-link references edge from body.
    expect(directByRel.has("references")).toBe(true);
    expect(directByRel.get("references")?.node?.id).toBe("task-toss");

    const inverseByRel = new Map(inverse.map((n) => [n.relation, n]));
    expect(inverseByRel.get("driven_by")?.node?.id).toBe("task-toss");
  });

  test("formatHits returns a stable, JSON-serializable shape", async () => {
    const vecs = new Map<string, Float32Array>();
    vecs.set("Payment spec\n\n# Payment spec\n\nRefers to [[task-toss]].\n", unitVec(10));
    vecs.set("Toss PG integration\n\n# Toss PG integration\n", unitVec(20));
    vecs.set("Payment kickoff\n\n# Payment kickoff\n", unitVec(30));
    vecs.set("Totally unrelated\n\n# Totally unrelated\n\nCats and yarn.\n", unitVec(40));
    vecs.set("q", unitVec(10));
    const client = createStubClient(vecs);
    await runBackfill(handle, client, { batchSize: 4 });
    const hits = await search(handle, client, "q", { k: 3 });
    const formatted = formatHits(hits);
    expect(formatted[0]?.rank).toBe(1);
    const node = (formatted[0] as { node: { id: string } }).node;
    expect(node.id).toBe("doc-spec");
    // Must be JSON-round-trippable.
    expect(JSON.parse(JSON.stringify(formatted))).toEqual(formatted);
  });

  test("search throws a clear error when vec extension is unavailable", async () => {
    // Forge a handle that claims vec isn't loaded.
    const fake: DbHandle = {
      ...handle,
      vecLoaded: false,
      vecError: "synthesized for test",
    };
    const client = createStubClient(new Map([["q", unitVec(0)]]));
    await expect(search(fake, client, "q")).rejects.toThrow(/orgmem requires the sqlite-vec extension/);
  });
});
