import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb } from "../src/storage/sqlite.ts";
import { importVault } from "../src/vault/import.ts";

/**
 * Generates a synthetic vault shaped roughly like an Obsidian vault:
 *   - 1000 markdown files under a nested directory structure
 *   - Each file has 2 frontmatter edges + 1–3 body wiki-links
 *   - Cross-references among files create a connected graph (not 1000 islands)
 */
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

describe("perf: 1000-file vault import", () => {
  test("imports 1000 synthetic files and reports wall time", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "orgmem-perf-"));
    const vault = join(dir, "vault");
    const db = join(dir, "perf.db");
    try {
      synthesize(vault, 1000);
      runMigrations(db, { loadVec: false });
      const handle = openDb({ path: db, loadVec: false });
      try {
        const report = importVault(handle, vault);
        process.stdout.write(
          `\n[perf] imported ${report.filesScanned} files in ${report.wallMs}ms` +
            ` — ${report.nodesUpserted} nodes, ${report.edgesWritten} edges, ` +
            `${(report.wallMs / report.filesScanned).toFixed(2)}ms/file\n`,
        );
        expect(report.filesScanned).toBe(1000);
        expect(report.nodesUpserted).toBe(1000);
        expect(report.errors).toEqual([]);
        // Soft budget: 1000 files should complete in under 30s on a dev
        // machine. This is wildly generous; we'll tighten in week 4 after
        // the Obsidian-scale corpus test.
        expect(report.wallMs).toBeLessThan(30_000);
      } finally {
        handle.raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
