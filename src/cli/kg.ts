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
import { ask } from "../answer/ask.ts";
import { createAnthropicClient, DEFAULT_ANSWER_MODEL } from "../answer/client.ts";
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
  kg ask "<query>"          Grounded answer over the graph (vec search + 1-hop + LLM)
                              flags: --k N (default 5), --neighbor-cap N (default 6),
                                     --max-tokens N, --json
  kg mcp [--vault <path>]   Start the stdio MCP server (Claude Code / Cursor)
                              falls back to $ORGMEM_VAULT if --vault omitted
  kg extract-decisions <file>  Run Lane C Decision Extractor on a file inside the vault.
                              Creates Decision nodes + decided_in edges.
                              flags: --vault <path>, --dry-run, --json, --model <id>
  kg status                 Print node/edge counts + vec status + embedding queue
  kg doctor [--vault <path>] Diagnose sqlite-vec + API keys + vault + schema + embed queue
  kg --version
  kg --help

Env:
  ORGMEM_DB                 DB path (default: .orgmem/dev.db)
  ORGMEM_VAULT              Vault dir (required for 'kg mcp' unless --vault is given)
  ORGMEM_SQLITE_LIB         Override system SQLite lib path (for sqlite-vec load)
  OPENAI_API_KEY            Required for 'kg embed' and 'kg ask'; enables 'kg_search' in MCP
  ANTHROPIC_API_KEY         Required for 'kg ask'
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

  if (cmd === "ask") {
    const args = parseAskArgs(rest);
    if (!args.query) {
      process.stderr.write(`usage: kg ask "<query>" [--k N] [--neighbor-cap N] [--max-tokens N] [--json]\n`);
      process.exit(2);
    }
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!openaiKey) {
      process.stderr.write("OPENAI_API_KEY is required for 'kg ask' (query embedding).\n");
      process.exit(2);
    }
    if (!anthropicKey) {
      process.stderr.write("ANTHROPIC_API_KEY is required for 'kg ask'.\n");
      process.exit(2);
    }
    runMigrations();
    const handle = openDb({ path: defaultDbPath(), loadVec: true });
    try {
      const embedClient = createOpenAIClient({ apiKey: openaiKey });
      const answerClient = createAnthropicClient({ apiKey: anthropicKey });
      const result = await ask(handle, embedClient, answerClient, args.query, {
        k: args.k,
        neighborCap: args.neighborCap,
        maxTokens: args.maxTokens,
      });
      if (args.json) {
        process.stdout.write(
          JSON.stringify({ ...result, model: DEFAULT_ANSWER_MODEL }, null, 2) + "\n",
        );
      } else {
        process.stdout.write(result.answer + "\n");
        if (!result.empty) {
          process.stderr.write(
            `\n[hits=${result.hits.length}` +
              (result.usage?.inputTokens != null
                ? `, in=${result.usage.inputTokens}`
                : "") +
              (result.usage?.outputTokens != null
                ? `, out=${result.usage.outputTokens}`
                : "") +
              `]\n`,
          );
        }
      }
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
      // Look up the source doc by source_file — it must already be imported.
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
    const doctorArgs = parseDoctorArgs(rest);
    const dbPath = defaultDbPath();
    const dbExists = existsSync(dbPath);
    const out: Record<string, unknown> = {
      db: dbPath,
      dbExists,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
    };

    // API key presence — booleans only, never values. Agents consuming this
    // output should be able to fast-fail before invoking a command that
    // needs them, but must not leak secrets into logs.
    out.apiKeys = {
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
    };

    // Vault path check — optional, since many doctor invocations won't care
    // (e.g. pre-init). Pulled from --vault flag or ORGMEM_VAULT env.
    const vaultPathRaw = doctorArgs.vault ?? process.env.ORGMEM_VAULT;
    if (vaultPathRaw) {
      const vaultResolved = resolve(vaultPathRaw);
      out.vault = {
        path: vaultResolved,
        source: doctorArgs.vault ? "flag" : "ORGMEM_VAULT",
        exists: existsSync(vaultResolved),
        // Non-existent paths short-circuit to `exists=false` with no
        // further disk probe — avoids a flurry of stat() on missing roots.
      };
    } else {
      out.vault = { path: null, source: null, exists: null };
    }

    // Everything below this point needs the DB open. If the DB file doesn't
    // exist yet, return a shallow report with a clear hint to run `kg init`.
    if (!dbExists) {
      out.hint = "run `kg init` to create the DB and apply migrations";
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }

    const handle = openDb({ path: dbPath, loadVec: true });
    try {
      out.vecLoaded = handle.vecLoaded;
      out.vecError = handle.vecError ?? null;
      if (handle.vecLoaded) {
        const row = handle.raw.prepare("SELECT vec_version() AS v;").get() as { v: string };
        out.vecVersion = row.v;
      }

      // schema_version rows ordered by apply time. The table only exists
      // after a successful runMigrations; if a user nuked the DB partially,
      // we want to surface that clearly rather than crash.
      try {
        const rows = handle.raw
          .prepare("SELECT name, applied_at FROM schema_version ORDER BY applied_at ASC;")
          .all() as Array<{ name: string; applied_at: number }>;
        out.schema = {
          migrationsApplied: rows.length,
          latest: rows.length > 0 ? rows[rows.length - 1]!.name : null,
          history: rows.map((r) => ({
            name: r.name,
            appliedAt: new Date(r.applied_at).toISOString(),
          })),
        };
      } catch (err) {
        out.schema = {
          migrationsApplied: 0,
          latest: null,
          history: [],
          error: `schema_version unavailable: ${(err as Error).message}`,
        };
      }

      // Embedding queue state — counts by status. A pending count > 0
      // means `kg embed` has work to do; failed > 0 means retry is useful.
      try {
        const rows = handle.raw
          .prepare("SELECT embedding_status AS s, COUNT(*) AS c FROM nodes GROUP BY embedding_status;")
          .all() as Array<{ s: string; c: number }>;
        const queue: Record<string, number> = { pending: 0, embedded: 0, failed: 0 };
        for (const r of rows) queue[r.s] = r.c;
        out.embedQueue = queue;
        out.totalNodes = countNodes(handle);
        out.totalEdges = countEdges(handle);
      } catch (err) {
        out.embedQueue = { error: `queue probe failed: ${(err as Error).message}` };
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

interface DoctorArgs {
  vault?: string;
}

function parseDoctorArgs(rest: string[]): DoctorArgs {
  const out: DoctorArgs = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--vault") {
      out.vault = rest[++i];
      if (!out.vault) throw new Error("--vault requires a path argument");
      continue;
    }
    throw new Error(`unknown flag for 'kg doctor': ${a}`);
  }
  return out;
}

interface AskArgs {
  query?: string;
  k?: number;
  neighborCap?: number;
  maxTokens?: number;
  json?: boolean;
}

function parseAskArgs(rest: string[]): AskArgs {
  const out: AskArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--k") {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error("invalid --k value");
      out.k = Math.floor(n);
      continue;
    }
    if (a === "--neighbor-cap") {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error("invalid --neighbor-cap value");
      out.neighborCap = Math.floor(n);
      continue;
    }
    if (a === "--max-tokens") {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error("invalid --max-tokens value");
      out.maxTokens = Math.floor(n);
      continue;
    }
    if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`unknown flag for 'kg ask': ${a}`);
    }
    if (typeof a === "string") positional.push(a);
  }
  if (positional.length > 0) out.query = positional.join(" ");
  return out;
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
