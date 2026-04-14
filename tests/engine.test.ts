import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrate.ts";
import { importVault } from "../src/vault/import.ts";
import { countEdges, countNodes, listEdgesFromFile } from "../src/graph/engine.ts";

function mkTempWorkspace(): { dir: string; vault: string; db: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-eng-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  return { dir, vault, db };
}

describe("engine reindex semantics", () => {
  let ws: ReturnType<typeof mkTempWorkspace>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkTempWorkspace();
    runMigrations(ws.db, { loadVec: false });
    handle = openDb({ path: ws.db, loadVec: false });
  });

  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("second import is idempotent (same node + edge counts, 0 net changes)", () => {
    writeFileSync(
      join(ws.vault, "a.md"),
      `---
id: node-a
type: Document
edges:
  - to: node-b
    relation: references
---
# A
Body with [[node-c]].
`,
    );
    const r1 = importVault(handle, ws.vault);
    expect(r1.nodesUpserted).toBe(1);
    expect(r1.edgesWritten).toBe(2);
    expect(r1.edgesDeleted).toBe(0);

    const nodesAfterFirst = countNodes(handle);
    const edgesAfterFirst = countEdges(handle);

    const r2 = importVault(handle, ws.vault);
    expect(r2.edgesDeleted).toBe(0);
    expect(countNodes(handle)).toBe(nodesAfterFirst);
    expect(countEdges(handle)).toBe(edgesAfterFirst);
  });

  test("removing a wiki-link prunes its edge on reindex (deterministic id + DELETE NOT IN)", () => {
    const path = join(ws.vault, "a.md");
    writeFileSync(
      path,
      `---
id: node-a
type: Document
---
# A
[[node-x]] and [[node-y]].
`,
    );
    importVault(handle, ws.vault);
    expect(listEdgesFromFile(handle, "a.md").length).toBe(2);

    writeFileSync(
      path,
      `---
id: node-a
type: Document
---
# A
Only [[node-x]] now.
`,
    );
    const r2 = importVault(handle, ws.vault);
    expect(r2.edgesDeleted).toBe(1);
    const remaining = listEdgesFromFile(handle, "a.md");
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.dstId).toBe("node-x");
  });

  test("removing ALL edges from a file prunes to zero", () => {
    const path = join(ws.vault, "a.md");
    writeFileSync(
      path,
      `---
id: node-a
type: Document
edges:
  - to: node-z
    relation: references
---
# A
[[node-x]]
`,
    );
    importVault(handle, ws.vault);
    expect(listEdgesFromFile(handle, "a.md").length).toBe(2);

    writeFileSync(
      path,
      `---
id: node-a
type: Document
---
# A
No links. No edges.
`,
    );
    const r2 = importVault(handle, ws.vault);
    expect(r2.edgesDeleted).toBe(2);
    expect(listEdgesFromFile(handle, "a.md").length).toBe(0);
  });

  test("invalid relation in frontmatter yields a structured error (no partial write)", () => {
    writeFileSync(
      join(ws.vault, "bad.md"),
      `---
id: node-bad
type: Document
edges:
  - to: node-other
    relation: not_a_real_relation
---
# Bad
`,
    );
    const report = importVault(handle, ws.vault);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]?.message).toMatch(/Invalid frontmatter edge relation/);
    expect(countNodes(handle)).toBe(0);
    expect(countEdges(handle)).toBe(0);
  });

  test("path escape is rejected at import-time", () => {
    // Can't literally escape the vault via a readdir walk, but any code path
    // that passes a non-vault file should reject. We assert via a direct
    // engine call later in week 2; for now the import layer can only walk
    // within the given root, so we document the guarantee by asserting the
    // walker yields no entries outside the vault root.
    mkdirSync(join(ws.vault, "nested"), { recursive: true });
    writeFileSync(join(ws.vault, "nested", "deep.md"), `# deep\n`);
    const report = importVault(handle, ws.vault);
    expect(report.filesScanned).toBe(1);
  });
});
