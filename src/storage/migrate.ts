import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { openDb, defaultDbPath, type DbHandle } from "./sqlite.ts";

const MIGRATIONS_DIR = resolve(import.meta.dir, "migrations");

interface MigrationFile {
  name: string; // filename stem, e.g. '0000_lucky_kinsey_walden'
  sql: string;
  checksum: string;
}

function discoverMigrations(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return entries.map((f) => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, f), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { name: f.replace(/\.sql$/, ""), sql, checksum };
  });
}

function ensureSchemaVersionTable(handle: DbHandle): void {
  handle.raw.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL,
       checksum TEXT NOT NULL
     );`,
  );
}

function appliedMigrations(handle: DbHandle): Map<string, { checksum: string; appliedAt: number }> {
  const rows = handle.raw
    .prepare("SELECT name, checksum, applied_at FROM schema_version;")
    .all() as Array<{ name: string; checksum: string; applied_at: number }>;
  const map = new Map<string, { checksum: string; appliedAt: number }>();
  for (const r of rows) map.set(r.name, { checksum: r.checksum, appliedAt: r.applied_at });
  return map;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface MigrateResult {
  path: string;
  applied: string[];
  alreadyApplied: string[];
  vecLoaded: boolean;
  vecError?: string;
}

export function runMigrations(dbPath = defaultDbPath(), options: { loadVec?: boolean } = {}): MigrateResult {
  const handle = openDb({ path: dbPath, loadVec: options.loadVec ?? true });
  try {
    ensureSchemaVersionTable(handle);
    const applied = appliedMigrations(handle);
    const migrations = discoverMigrations();

    const justApplied: string[] = [];
    const already: string[] = [];

    for (const m of migrations) {
      const prior = applied.get(m.name);
      if (prior) {
        if (prior.checksum !== m.checksum) {
          throw new Error(
            `Migration checksum mismatch for ${m.name}: expected ${prior.checksum}, got ${m.checksum}. ` +
              `Migrations are immutable once applied; generate a new file instead of editing an existing one.`,
          );
        }
        already.push(m.name);
        continue;
      }

      const statements = splitStatements(m.sql);
      handle.raw.exec("BEGIN IMMEDIATE;");
      try {
        for (const stmt of statements) handle.raw.exec(stmt);
        handle.raw
          .prepare("INSERT INTO schema_version (name, applied_at, checksum) VALUES (?, ?, ?);")
          .run(m.name, Date.now(), m.checksum);
        handle.raw.exec("COMMIT;");
        justApplied.push(m.name);
      } catch (err) {
        handle.raw.exec("ROLLBACK;");
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }

    return {
      path: handle.path,
      applied: justApplied,
      alreadyApplied: already,
      vecLoaded: handle.vecLoaded,
      vecError: handle.vecError,
    };
  } finally {
    handle.raw.close();
  }
}

// CLI entry: `bun src/storage/migrate.ts`
if (import.meta.main) {
  const result = runMigrations();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
