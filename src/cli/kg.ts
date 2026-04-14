#!/usr/bin/env bun
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { openDb, defaultDbPath } from "../storage/sqlite.ts";
import { runMigrations } from "../storage/migrate.ts";
import { importVault } from "../vault/import.ts";
import { countEdges, countNodes } from "../graph/engine.ts";

function printHelp(): void {
  process.stdout.write(
    `kg — orgmem graph CLI (Phase 1, Lane A / week 1)

Commands:
  kg init [db]              Run migrations against the DB (default: $ORGMEM_DB or .orgmem/dev.db)
  kg import <vault-path>    Walk a vault and upsert every markdown file as a node (+ edges)
  kg status                 Print node/edge counts + vec status
  kg doctor                 Diagnose sqlite-vec availability
  kg --version
  kg --help

Env:
  ORGMEM_DB                 DB path (default: .orgmem/dev.db)
  ORGMEM_SQLITE_LIB         Override system SQLite lib path (for sqlite-vec load)
`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("kg 0.1.0 (orgmem Phase 1)\n");
    return;
  }

  if (cmd === "init") {
    const path = rest[0] ?? defaultDbPath();
    const result = runMigrations(path);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (cmd === "import") {
    const vault = rest[0];
    if (!vault) {
      process.stderr.write("usage: kg import <vault-path>\n");
      process.exit(2);
    }
    const resolved = resolve(vault);
    if (!existsSync(resolved)) {
      process.stderr.write(`vault not found: ${resolved}\n`);
      process.exit(2);
    }
    // Ensure schema is up-to-date before writing.
    runMigrations();
    const handle = openDb({ path: defaultDbPath(), loadVec: false });
    try {
      const report = importVault(handle, resolved);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } finally {
      handle.raw.close();
    }
    return;
  }

  if (cmd === "status") {
    if (!existsSync(defaultDbPath())) {
      process.stdout.write(JSON.stringify({ db: defaultDbPath(), exists: false }, null, 2) + "\n");
      return;
    }
    const handle = openDb({ path: defaultDbPath(), loadVec: true });
    try {
      const out = {
        db: handle.path,
        exists: true,
        nodes: countNodes(handle),
        edges: countEdges(handle),
        vecLoaded: handle.vecLoaded,
        vecError: handle.vecError ?? null,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } finally {
      handle.raw.close();
    }
    return;
  }

  if (cmd === "doctor") {
    const handle = openDb({ path: defaultDbPath(), loadVec: true });
    try {
      const out: Record<string, unknown> = {
        db: handle.path,
        platform: process.platform,
        arch: process.arch,
        vecLoaded: handle.vecLoaded,
        vecError: handle.vecError ?? null,
      };
      if (handle.vecLoaded) {
        const row = handle.raw.prepare("SELECT vec_version() AS v;").get() as { v: string };
        out.vecVersion = row.v;
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } finally {
      handle.raw.close();
    }
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\nrun 'kg --help' for usage\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
