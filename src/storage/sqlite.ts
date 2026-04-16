import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./schema.ts";
import { EMBEDDING_DIM } from "../embeddings/model.ts";
import {
  BUNDLED_VEC_PATH,
  VEC_LIB_FILENAME,
  VEC_BUNDLED_SHA256,
} from "./sqlite-vec-native.generated.ts";

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

/**
 * When running inside a `bun build --compile` binary, BUNDLED_VEC_PATH
 * resolves to a /$bunfs/root/... virtual path that dlopen() can't open.
 * Extract those bytes to a real filesystem cache (`$ORGMEM_CACHE_DIR` or
 * `~/.cache/orgmem/sqlite-vec/`) on first use, then return that real
 * path. Cache key includes the build-time sha256 so a future binary with
 * a different vec0 lib auto-extracts a fresh copy without colliding.
 *
 * Returns null in dev/test mode (the committed stub leaves
 * BUNDLED_VEC_PATH unset); callers fall back to sqliteVec.load() in
 * that case.
 */
function ensureBundledVecExtracted(): string | null {
  if (!BUNDLED_VEC_PATH || !VEC_LIB_FILENAME || !VEC_BUNDLED_SHA256) {
    return null;
  }
  const cacheDir =
    process.env.ORGMEM_CACHE_DIR ?? join(homedir(), ".cache", "orgmem", "sqlite-vec");
  mkdirSync(cacheDir, { recursive: true });
  // Suffix the cached file with a short sha so a binary upgrade transparently
  // extracts a fresh copy instead of trying to mmap a stale one.
  const dest = join(cacheDir, `${VEC_LIB_FILENAME}-${VEC_BUNDLED_SHA256.slice(0, 16)}`);
  if (existsSync(dest)) return dest;
  const bytes = readFileSync(BUNDLED_VEC_PATH);
  writeFileSync(dest, bytes);
  return dest;
}

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
      const bundled = ensureBundledVecExtracted();
      if (bundled) {
        // Compiled-binary path: bun build --compile bundles the .dylib/.so
        // as an asset, but dlopen() needs a real filesystem path. We
        // extract the bundled bytes to ~/.cache/orgmem/sqlite-vec/ once
        // and reuse on subsequent runs.
        raw.loadExtension(bundled);
      } else {
        // Dev / test mode: sqlite-vec's package exports the resolver
        // we want, walking node_modules to find the matching native dep.
        sqliteVec.load(raw);
      }
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
  // v0.1 node-level vec. Still created for now so existing backfills
  // (Day 2 of v0.2 will flip them) keep working; Day 2 drops the
  // reads but the table stays harmless until a later cleanup.
  handle.raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS node_vec USING vec0(node_id TEXT PRIMARY KEY, embedding FLOAT[${dim}]);`,
  );
  // v0.2 chunk-level vec — heading-split retrieval unit, populated by
  // the chunk backfill. Keys on chunk_id (e.g. "doc-payment-spec#3").
  handle.raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[${dim}]);`,
  );
}
