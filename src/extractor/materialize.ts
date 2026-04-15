import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../storage/sqlite.ts";
import { nodes } from "../storage/schema.ts";
import { createNode } from "../graph/write.ts";
import type { SelfWriteTracker } from "../vault/watcher.ts";
import type { ExtractedDecision } from "./types.ts";

export interface MaterializedDecision {
  id: string;
  mdPath: string;
  /** true when a Decision with this deterministic id already existed — we
   *  skipped createNode to keep re-runs idempotent. */
  alreadyPresent: boolean;
  sourceLine: number | null;
}

export interface MaterializeError {
  text: string;
  message: string;
}

export interface MaterializeReport {
  sourceDocId: string;
  created: MaterializedDecision[];
  skipped: MaterializedDecision[];
  errors: MaterializeError[];
  wallMs: number;
}

export interface MaterializeOptions {
  /** Override the date prefix for Decision files. Default: source doc's
   *  mtime date (stable across re-runs) or today if mtime is missing. */
  date?: string;
  tracker?: SelfWriteTracker;
}

function toIsoDate(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function todayIsoDate(): string {
  return toIsoDate(Date.now());
}

/**
 * Deterministic Decision id:
 *   decision-<date>-<sha256(sourceDocId|normalizedText).slice(0,10)>
 *
 * Why:
 *   - Idempotent: same (sourceDocId, text, date) → same id → re-runs detect
 *     existing Decision and skip.
 *   - Opaque suffix: avoids ugly long slugs for extractor-authored nodes.
 *   - Retains date prefix: consistent with the Decision TYPE_DIR convention
 *     (`decisions/<date>-<slug>.md`).
 */
function deriveDecisionId(sourceDocId: string, text: string, date: string): string {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  const h = createHash("sha256").update(`${sourceDocId}|${normalized}`).digest("hex");
  return `decision-${date}-${h.slice(0, 10)}`;
}

function titleFromText(text: string): string {
  // First line, truncated to 80 chars. createNode requires a non-empty title.
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  const cleaned = firstLine.length > 0 ? firstLine : text.trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 77) + "...";
}

function decisionBody(e: ExtractedDecision, sourceDocId: string): string {
  const lines: string[] = [];
  lines.push(`# ${titleFromText(e.text)}`);
  lines.push("");
  lines.push("## Statement");
  lines.push("");
  lines.push(e.text);
  lines.push("");
  if (e.reasoning && e.reasoning.trim().length > 0) {
    lines.push("## Extractor reasoning");
    lines.push("");
    lines.push(`> ${e.reasoning.trim()}`);
    lines.push("");
  }
  lines.push("## Source");
  lines.push("");
  const lineRef = e.line !== null ? ` (line ${e.line})` : "";
  lines.push(`Decided in \`${sourceDocId}\`${lineRef}.`);
  return lines.join("\n") + "\n";
}

/**
 * Materialize extracted decisions as Decision nodes under `decisions/`
 * with a single `decided_in` edge back to the source doc.
 *
 * Semantics (mirrors the per-file pattern in `src/vault/import.ts`):
 *   - Each Decision is created via `createNode`, which internally runs
 *     `upsertDocNodeAndEdges` inside BEGIN IMMEDIATE ... COMMIT. So every
 *     Decision is atomic on its own; a failure on decision N does NOT roll
 *     back decisions 1..N-1. Errors are collected into `report.errors` and
 *     the batch continues.
 *   - Idempotency: a deterministic id (sha256 of sourceDocId|text) is
 *     pre-checked. Existing ids skip `createNode` entirely, so re-running
 *     extract-decisions on an unchanged source doc creates zero new nodes
 *     and zero new edges.
 *
 * The function is synchronous w.r.t. DB writes (no LLM calls here) — the
 * caller is expected to have already run `extractDecisionsFromDoc`.
 */
export function materializeDecisions(
  handle: DbHandle,
  vaultPath: string,
  sourceDocId: string,
  decisions: ExtractedDecision[],
  options: MaterializeOptions = {},
): MaterializeReport {
  const start = performance.now();

  // Resolve the canonical date once, so every decision from this batch
  // shares the same date prefix (and the id hash is reproducible).
  let date = options.date;
  if (!date) {
    const row = handle.db.select().from(nodes).where(eq(nodes.id, sourceDocId)).get();
    if (!row) {
      throw new Error(
        `materializeDecisions: source node '${sourceDocId}' does not exist. Import the doc before extracting.`,
      );
    }
    if (row.type !== "Document" && row.type !== "Meeting") {
      throw new Error(
        `materializeDecisions: source node '${sourceDocId}' is type '${row.type}'; expected Document or Meeting.`,
      );
    }
    date = row.mtime ? toIsoDate(row.mtime) : todayIsoDate();
  }

  const report: MaterializeReport = {
    sourceDocId,
    created: [],
    skipped: [],
    errors: [],
    wallMs: 0,
  };

  for (const e of decisions) {
    const id = deriveDecisionId(sourceDocId, e.text, date);

    try {
      // Idempotency pre-check: if a Decision with this deterministic id
      // already exists, we've already materialized this one. Record it as
      // skipped so the caller can report "no-op" cleanly.
      const existing = handle.raw
        .prepare("SELECT source_file FROM nodes WHERE id = ? LIMIT 1;")
        .get(id) as { source_file: string | null } | null;

      if (existing) {
        report.skipped.push({
          id,
          mdPath: existing.source_file ?? "",
          alreadyPresent: true,
          sourceLine: e.line,
        });
        continue;
      }

      const title = titleFromText(e.text);
      const metadata: Record<string, unknown> = {
        extractor: "lane-c-v1.1",
      };
      if (e.line !== null) metadata.source_line = e.line;
      if (e.reasoning && e.reasoning.trim().length > 0) {
        metadata.extractor_reasoning = e.reasoning.trim();
      }

      const result = createNode(
        handle,
        vaultPath,
        {
          type: "Decision",
          title,
          content: decisionBody(e, sourceDocId),
          date,
          id,
          edges: [{ to: sourceDocId, relation: "decided_in" }],
          metadata,
        },
        options.tracker,
      );

      report.created.push({
        id: result.id,
        mdPath: result.mdPath,
        alreadyPresent: false,
        sourceLine: e.line,
      });
    } catch (err) {
      report.errors.push({ text: e.text.slice(0, 120), message: (err as Error).message });
    }
  }

  report.wallMs = Math.round(performance.now() - start);
  return report;
}
