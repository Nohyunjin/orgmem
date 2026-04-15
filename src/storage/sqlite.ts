import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./schema.ts";
import { EMBEDDING_DIM } from "../embeddings/model.ts";

export interface OpenOptions {
  /** Absolute DB path. */
  path: string;
  /** Attempt to load sqlite-vec. Default true; set false for tests that don't need vectors. */
  loadVec?: boolean;
  /** readonly mode (used by CLI `status`). Default false. */
  readonly?: boolean;
}

export interface DbHandle {
  raw: Database;
  db: BunSQLiteDatabase<typeof schema>;
  path: string;
  vecLoaded: boolean;
  vecError?: string;
}

/**
 * Ensures bun:sqlite is linked against a build that supports loadable extensions.
 * Bun's bundled SQLite on macOS is compiled WITHOUT SQLITE_ENABLE_LOAD_EXTENSION,
 * so we have to point it at a system SQLite (Homebrew / Xcode CLT) before any
 * Database is opened. Called at most once per process.
 */
let customSqliteApplied = false;
const CANDIDATE_SQLITE_PATHS = [
  process.env.ORGMEM_SQLITE_LIB, // explicit override
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon brew
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Intel brew
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0", // Debian/Ubuntu
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/libsqlite3.so.0",
].filter((p): p is string => typeof p === "string" && p.length > 0);

function applyCustomSqlite(): { ok: boolean; path?: string; error?: string } {
  if (customSqliteApplied) return { ok: true };
  for (const candidate of CANDIDATE_SQLITE_PATHS) {
    if (!existsSync(candidate)) continue;
    try {
      Database.setCustomSQLite(candidate);
      customSqliteApplied = true;
      return { ok: true, path: candidate };
    } catch (err) {
      return { ok: false, error: `setCustomSQLite(${candidate}): ${(err as Error).message}` };
    }
  }
  return { ok: false, error: "no system SQLite with extensions found in candidate paths" };
}

/**
 * Opens the SQLite DB. Always sets WAL + foreign keys. Attempts to load the
 * sqlite-vec extension so callers can use the `vec0` virtual table; if the
 * load fails, we record the error on the handle and continue (vec is
 * best-effort at the storage layer — hybrid search paths MUST check
 * `vecLoaded` before relying on it).
 */
export function openDb(opts: OpenOptions): DbHandle {
  // `:memory:` is a well-known bun:sqlite alias for an ephemeral DB. We
  // must not resolve() it (would turn it into `<cwd>/:memory:`) or mkdir
  // its "directory". The postinstall probe and kg doctor pre-init check
  // rely on this path.
  const isMemory = opts.path === ":memory:";
  const abs = isMemory ? ":memory:" : resolve(opts.path);
  if (!isMemory) mkdirSync(dirname(abs), { recursive: true });

  let vecLoaded = false;
  let vecError: string | undefined;

  const wantVec = opts.loadVec !== false;
  if (wantVec) {
    const applied = applyCustomSqlite();
    if (!applied.ok) {
      vecError = applied.error;
    }
  }

  const raw = new Database(abs, { readonly: opts.readonly ?? false, create: !opts.readonly });
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");

  if (wantVec && !vecError) {
    try {
      sqliteVec.load(raw);
      vecLoaded = true;
    } catch (err) {
      vecError = (err as Error).message;
    }
  }

  const db = drizzle(raw, { schema });
  const handle: DbHandle = { raw, db, path: abs, vecLoaded, vecError };
  if (vecLoaded) {
    // vec0 virtual tables live outside the drizzle schema / schema_version
    // bookkeeping because they depend on the extension being loaded at
    // create-time. CREATE IF NOT EXISTS makes this idempotent — no risk
    // of churn on repeat opens.
    try {
      ensureVecTable(handle, EMBEDDING_DIM);
    } catch (err) {
      // If this fails we degrade to the same state as vec-not-loaded so
      // that search paths throw loudly and writes still work.
      handle.vecLoaded = false;
      handle.vecError = `node_vec bootstrap: ${(err as Error).message}`;
    }
  }
  return handle;
}

export function closeDb(handle: DbHandle): void {
  handle.raw.close();
}

export function defaultDbPath(): string {
  return resolve(process.env.ORGMEM_DB ?? ".orgmem/dev.db");
}

/**
 * Guard to call from every search path. orgmem is embedding-only by design
 * (no BM25 fallback), so search MUST throw loudly when vec isn't available
 * instead of silently degrading. Migrations / writers don't need to call this.
 */
export function requireVec(handle: DbHandle): void {
  if (handle.vecLoaded) return;
  const platform = process.platform;
  const install =
    platform === "darwin"
      ? "brew install sqlite  # then re-run kg"
      : platform === "linux"
        ? "sudo apt-get install -y libsqlite3-0 libsqlite3-dev  # or the equivalent for your distro"
        : "install a SQLite build with loadable extension support";
  throw new Error(
    `orgmem requires the sqlite-vec extension for search, and it failed to load: ` +
      `${handle.vecError ?? "unknown reason"}\n` +
      `Fix: ${install}\n` +
      `You can override the SQLite library path with ORGMEM_SQLITE_LIB=/path/to/libsqlite3.dylib.`,
  );
}

/**
 * Creates the `node_vec` vec0 virtual table. Called once after migrations if
 * vec extension loaded. Idempotent via CREATE ... IF NOT EXISTS. Dim is fixed
 * to the model's dim (passed at migration time); changing dim requires a
 * drop+recreate, which is handled explicitly by the embedding backfill job
 * (not in w1).
 */
export function ensureVecTable(handle: DbHandle, dim: number): void {
  requireVec(handle);
  handle.raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS node_vec USING vec0(node_id TEXT PRIMARY KEY, embedding FLOAT[${dim}]);`,
  );
}
