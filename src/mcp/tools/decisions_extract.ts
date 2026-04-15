import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  extractDecisionsFromDoc,
  materializeDecisions,
  DEFAULT_EXTRACTOR_MODEL,
  type VerbatimDropped,
} from "../../extractor/index.ts";
import type { McpContext } from "../context.ts";
import { ok, fail } from "./result.ts";

const inputSchema = {
  nodeId: z
    .string()
    .min(1)
    .describe("id of the source node (must be Document or Meeting and already imported)"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "If true, return extracted candidates without writing Decision nodes. Default: false (materialize).",
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Override date prefix for created Decisions. Default: source doc mtime date (stable across re-runs).",
    ),
};

export function registerDecisionsExtract(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "decisions_extract",
    {
      title: "Extract decisions from a node",
      description:
        "Runs Lane C's Decision Extractor (recall ≥ 0.85, locked eval) over a " +
        "Document/Meeting node's body. With dryRun=true returns candidates only; " +
        "with dryRun=false (default) materializes Decision nodes via createNode + " +
        "decided_in edges. Idempotent: re-running on the same source produces 0 new " +
        "nodes (deterministic id based on sha256(sourceDocId|text)).",
      inputSchema,
    },
    async (args) => {
      try {
        if (!ctx.extractorClient) {
          return fail(
            new Error(
              "decisions_extract unavailable: no ANTHROPIC_API_KEY (and no " +
                "ORGMEM_EXTRACTOR_STUB) configured when the MCP server started. " +
                "Restart `kg mcp` with ANTHROPIC_API_KEY set.",
            ),
          );
        }

        const row = ctx.handle.raw
          .prepare("SELECT id, type, title, source_file FROM nodes WHERE id = ? LIMIT 1;")
          .get(args.nodeId) as
          | { id: string; type: string; title: string | null; source_file: string | null }
          | null;

        if (!row) {
          return fail(
            new Error(
              `decisions_extract: source node '${args.nodeId}' does not exist. Import the doc first.`,
            ),
          );
        }
        if (row.type !== "Document" && row.type !== "Meeting") {
          return fail(
            new Error(
              `decisions_extract: source node '${args.nodeId}' is type '${row.type}'; only Document and Meeting are supported.`,
            ),
          );
        }
        if (!row.source_file) {
          return fail(
            new Error(
              `decisions_extract: source node '${args.nodeId}' has no source_file on disk.`,
            ),
          );
        }

        const absPath = resolve(ctx.vaultPath, row.source_file);
        if (!existsSync(absPath)) {
          return fail(new Error(`decisions_extract: source file missing on disk: ${absPath}`));
        }

        const body = readFileSync(absPath, "utf8");
        const title = row.title ?? row.id;
        const dropped: VerbatimDropped[] = [];
        const extracted = await extractDecisionsFromDoc(ctx.extractorClient, title, body, {
          onDropped: (d) => dropped.push(d),
        });

        const dryRun = args.dryRun ?? false;
        if (dryRun) {
          return ok({
            sourceDocId: row.id,
            sourceFile: row.source_file,
            model: DEFAULT_EXTRACTOR_MODEL,
            dryRun: true,
            extractedCount: extracted.length,
            extracted,
            dropped,
          });
        }

        const report = materializeDecisions(ctx.handle, ctx.vaultPath, row.id, extracted, {
          date: args.date,
        });
        return ok({
          sourceDocId: row.id,
          sourceFile: row.source_file,
          model: DEFAULT_EXTRACTOR_MODEL,
          dryRun: false,
          extractedCount: extracted.length,
          created: report.created,
          skipped: report.skipped,
          errors: report.errors,
          dropped,
          wallMs: report.wallMs,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
