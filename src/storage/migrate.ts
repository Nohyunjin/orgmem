import { createHash } from "node:crypto";
import { openDb, defaultDbPath, type DbHandle } from "./sqlite.ts";
import { MIGRATIONS } from "./migrations.generated.ts";

interface MigrationFile {
  name: string; // filename stem, e.g. '0000_lucky_kinsey_walden'
  sql: string;
  checksum: string;
}

/**
 * Migrations are bundled into the binary at compile time via the
 * generated manifest (`src/storage/migrations.generated.ts`). We do NOT
 * walk the filesystem at runtime — `bun build --compile` does not
 * auto-bundle files only accessed via `readdirSync`, which is what
 * broke v0.1.1's `kg init` (`ENOENT: scandir '/$bunfs/root/migrations'`).
 *
 * The manifest carries a build-time checksum; we recompute the runtime
 * checksum here as a tamper-detect (any byte difference between what
 * the generator saw and what the binary carries surfaces as a mismatch
 * before we touch the DB).
 */
function discoverMigrations(): MigrationFile[] {
  return MIGRATIONS.map((m) => {
    const checksum = createHash("sha256").update(m.sql, "utf8").digest("hex");
    if (checksum !== m.checksum) {
      throw new Error(
        `migration manifest checksum drift for ${m.name}: ` +
          `runtime ${checksum} vs build-time ${m.checksum}`,
      );
    }
    return { name: m.name, sql: m.sql, checksum };
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
