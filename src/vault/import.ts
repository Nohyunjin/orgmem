import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { DbHandle } from "../storage/sqlite.ts";
import { parseDoc } from "./parser.ts";
import { upsertDocNodeAndEdges } from "../graph/engine.ts";

const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ".trash", ".orgmem"]);

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && (name.endsWith(".md") || name.endsWith(".mdx"))) {
        out.push(full);
      }
    }
  }
  return out;
}

export interface ImportReport {
  vault: string;
  filesScanned: number;
  nodesUpserted: number;
  edgesWritten: number;
  edgesDeleted: number;
  errors: Array<{ path: string; message: string }>;
  wallMs: number;
}

function assertInsideVault(vault: string, target: string): void {
  const resolvedVault = resolve(vault);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedVault, resolvedTarget);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error(`Path escapes vault: ${target}`);
  }
}

export function importVault(handle: DbHandle, vaultPath: string): ImportReport {
  const vault = resolve(vaultPath);
  const files = walkMarkdown(vault);
  const report: ImportReport = {
    vault,
    filesScanned: files.length,
    nodesUpserted: 0,
    edgesWritten: 0,
    edgesDeleted: 0,
    errors: [],
    wallMs: 0,
  };

  const start = performance.now();
  for (const abs of files) {
    const relPath = relative(vault, abs);
    try {
      assertInsideVault(vault, abs);
      const raw = readFileSync(abs, "utf8");
      const doc = parseDoc({ relPath, raw });
      const res = upsertDocNodeAndEdges(handle, relPath, doc);
      report.nodesUpserted += 1;
      report.edgesWritten += res.edgesWritten;
      report.edgesDeleted += res.edgesDeleted;
    } catch (err) {
      report.errors.push({ path: relPath, message: (err as Error).message });
    }
  }
  report.wallMs = Math.round(performance.now() - start);
  return report;
}
