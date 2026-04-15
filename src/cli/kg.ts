#!/usr/bin/env bun
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { openDb, defaultDbPath } from "../storage/sqlite.ts";
import { runMigrations } from "../storage/migrate.ts";
import { importVault } from "../vault/import.ts";
import { countEdges, countNodes } from "../graph/engine.ts";
import { createOpenAIClient } from "../embeddings/client.ts";
import { runBackfill } from "../embeddings/backfill.ts";
import { EMBEDDING_MODEL } from "../embeddings/model.ts";
import {
  createExtractorClient,
  extractDecisionsFromDoc,
  materializeDecisions,
  DEFAULT_EXTRACTOR_MODEL,
} from "../extractor/index.ts";
import { readFileSync } from "node:fs";
import { relative, basename } from "node:path";

function printHelp(): void {
  process.stdout.write(
    `kg — orgmem graph CLI (Phase 1, Lane A / week 1)

Commands:
  kg init [db]              Run migrations against the DB (default: $ORGMEM_DB or .orgmem/dev.db)
  kg import <vault-path>    Walk a vault and upsert every markdown file as a node (+ edges)
  kg embed --resume         Backfill embeddings for all 'pending' nodes (resumable, 429 backoff)
                              flags: --batch-size N (default 32), --max-batches N, --retry-failed
  kg mcp [--vault <path>]   Start the stdio MCP server (Claude Code / Cursor)
                              falls back to $ORGMEM_VAULT if --vault omitted
  kg extract-decisions <file>  Run Lane C Decision Extractor on a file inside the vault.
                              Creates Decision nodes + decided_in edges.
                              flags: --vault <path>, --dry-run, --json, --model <id>
  kg status                 Print node/edge counts + vec status + embedding queue
  kg doctor                 Diagnose sqlite-vec availability
  kg --version
  kg --help

Env:
  ORGMEM_DB                 DB path (default: .orgmem/dev.db)
  ORGMEM_VAULT              Vault dir (required for 'kg mcp' unless --vault is given)
  ORGMEM_SQLITE_LIB         Override system SQLite lib path (for sqlite-vec load)
  OPENAI_API_KEY            Required for 'kg embed'; enables 'kg_search' in MCP when set
  ANTHROPIC_API_KEY         Required for 'kg ask' (W2.4)
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

  if (cmd === "embed") {
    // Accept both `kg embed --resume` and `kg embed` (same behavior — the
    // command IS always resumable; --resume is a readability flag).
    const args = parseEmbedArgs(rest);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      process.stderr.write(
        "OPENAI_API_KEY is required for 'kg embed'. Export it and re-run.\n",
      );
      process.exit(2);
    }
    runMigrations();
    const handle = openDb({ path: defaultDbPath(), loadVec: true });
    try {
      const client = createOpenAIClient({ apiKey });
      const report = await runBackfill(handle, client, {
        batchSize: args.batchSize,
        maxBatches: args.maxBatches,
        retryFailed: args.retryFailed,
        onProgress: (ev) => {
          if (ev.phase === "batch") {
            process.stderr.write(
              `[embed] batch ${String(ev.batchIndex)} (+${ev.batchSize ?? 0}): ` +
                `${ev.processed}/${ev.total} processed, ${ev.failed} failed\n`,
            );
          }
        },
      });
      process.stdout.write(
        JSON.stringify({ ...report, model: EMBEDDING_MODEL }, null, 2) + "\n",
      );
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
      const statusRows = handle.raw
        .prepare("SELECT embedding_status AS s, COUNT(*) AS c FROM nodes GROUP BY embedding_status;")
        .all() as Array<{ s: string; c: number }>;
      const embedQueue: Record<string, number> = { pending: 0, embedded: 0, failed: 0 };
      for (const r of statusRows) embedQueue[r.s] = r.c;
      const out = {
        db: handle.path,
        exists: true,
        nodes: countNodes(handle),
        edges: countEdges(handle),
        vecLoaded: handle.vecLoaded,
        vecError: handle.vecError ?? null,
        embedQueue,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } finally {
      handle.raw.close();
    }
    return;
  }

  if (cmd === "mcp") {
    const { startStdio } = await import("../mcp/start.ts");
    let vault: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--vault") {
        vault = rest[++i];
        if (!vault) {
          process.stderr.write("--vault requires a path argument\n");
          process.exit(2);
        }
        continue;
      }
      process.stderr.write(`unknown flag for 'kg mcp': ${a}\n`);
      process.exit(2);
    }
    await startStdio({ vault });
    return;
  }

  if (cmd === "extract-decisions") {
    const args = parseExtractArgs(rest);
    if (!args.file) {
      process.stderr.write(
        `usage: kg extract-decisions <file> [--vault <path>] [--dry-run] [--json] [--model <id>]\n`,
      );
      process.exit(2);
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      process.stderr.write("ANTHROPIC_API_KEY is required for 'kg extract-decisions'.\n");
      process.exit(2);
    }
    const vaultPath = args.vault ?? process.env.ORGMEM_VAULT;
    if (!vaultPath) {
      process.stderr.write(
        "--vault <path> or $ORGMEM_VAULT is required (the source file must live inside the vault).\n",
      );
      process.exit(2);
    }
    const vaultResolved = resolve(vaultPath);
    if (!existsSync(vaultResolved)) {
      process.stderr.write(`vault not found: ${vaultResolved}\n`);
      process.exit(2);
    }
    const fileResolved = resolve(args.file);
    if (!existsSync(fileResolved)) {
      process.stderr.write(`file not found: ${fileResolved}\n`);
      process.exit(2);
    }
    const relPath = relative(vaultResolved, fileResolved);
    if (relPath.startsWith("..") || relPath.includes("\0")) {
      process.stderr.write(
        `file is not inside the vault: ${fileResolved} (vault: ${vaultResolved})\n`,
      );
      process.exit(2);
    }

    runMigrations();
    const handle = openDb({ path: defaultDbPath(), loadVec: false });
    try {
      const row = handle.raw
        .prepare("SELECT id, type FROM nodes WHERE source_file = ? LIMIT 1;")
        .get(relPath) as { id: string; type: string } | null;
      if (!row) {
        process.stderr.write(
          `source file '${relPath}' is not imported yet. Run 'kg import ${vaultResolved}' first.\n`,
        );
        process.exit(2);
      }
      if (row.type !== "Document" && row.type !== "Meeting") {
        process.stderr.write(
          `source node '${row.id}' has type '${row.type}'; extract-decisions only supports Document/Meeting.\n`,
        );
        process.exit(2);
      }

      const body = readFileSync(fileResolved, "utf8");
      const title = basename(relPath, ".md");
      const client = createExtractorClient({ apiKey, model: args.model });

      let extracted;
      try {
        extracted = await extractDecisionsFromDoc(client, title, body);
      } catch (err) {
        process.stderr.write(`extractor error: ${(err as Error).message}\n`);
        process.exit(3);
      }

      if (args.dryRun) {
        const out = {
          sourceDocId: row.id,
          sourceFile: relPath,
          dryRun: true,
          extracted,
        };
        if (args.json) {
          process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        } else {
          process.stdout.write(
            `extracted ${extracted.length} candidate decision(s) from '${relPath}' (dry-run, nothing written).\n`,
          );
          for (const e of extracted) {
            const lineRef = e.line !== null ? ` (line ${e.line})` : "";
            process.stdout.write(`  - ${e.text.slice(0, 120)}${lineRef}\n`);
          }
        }
        return;
      }

      const report = materializeDecisions(handle, vaultResolved, row.id, extracted);
      const payload = {
        sourceDocId: row.id,
        sourceFile: relPath,
        model: args.model ?? DEFAULT_EXTRACTOR_MODEL,
        extractedCount: extracted.length,
        created: report.created,
        skipped: report.skipped,
        errors: report.errors,
        wallMs: report.wallMs,
      };
      if (args.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      } else {
        process.stdout.write(
          `extracted ${extracted.length}, created ${report.created.length}, skipped ${report.skipped.length} (idempotent), errors ${report.errors.length} from '${relPath}' (${report.wallMs}ms)\n`,
        );
        for (const c of report.created) {
          process.stdout.write(`  +  ${c.mdPath}  (${c.id})\n`);
        }
        for (const s of report.skipped) {
          process.stdout.write(`  =  ${s.mdPath}  (${s.id}) [already present]\n`);
        }
        for (const e of report.errors) {
          process.stdout.write(`  !  ${e.text}  — ${e.message}\n`);
        }
      }
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

interface ExtractArgs {
  file?: string;
  vault?: string;
  model?: string;
  dryRun?: boolean;
  json?: boolean;
}

function parseExtractArgs(rest: string[]): ExtractArgs {
  const out: ExtractArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--vault") {
      out.vault = rest[++i];
      if (!out.vault) throw new Error("--vault requires a path argument");
      continue;
    }
    if (a === "--model") {
      out.model = rest[++i];
      if (!out.model) throw new Error("--model requires an id argument");
      continue;
    }
    if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`unknown flag for 'kg extract-decisions': ${a}`);
    }
    if (typeof a === "string") positional.push(a);
  }
  if (positional.length > 0) out.file = positional[0];
  return out;
}

interface EmbedArgs {
  batchSize?: number;
  maxBatches?: number;
  retryFailed?: boolean;
}

function parseEmbedArgs(rest: string[]): EmbedArgs {
  const out: EmbedArgs = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--resume") continue;
    if (a === "--retry-failed") {
      out.retryFailed = true;
      continue;
    }
    if (a === "--batch-size") {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`invalid --batch-size value`);
      }
      out.batchSize = Math.floor(n);
      continue;
    }
    if (a === "--max-batches") {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`invalid --max-batches value`);
      }
      out.maxBatches = Math.floor(n);
      continue;
    }
    throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
