# orgmem

Agent-Native Knowledge & Work Graph: docs + tasks as first-class nodes in a
graph maintained by AI agents via MCP. Phase 1 of the
[orgmem-probe](https://github.com/Nohyunjin/orgmem-probe) build.

> **Status:** week 1 of 6–8. Lane A (graph engine + SQLite + migrations + FS
> watcher scaffold) is the only trunk currently committed. MCP server (Lane B)
> and Decision Extractor (Lane C) land in later weeks.

---

## Week 1 gate — all green

| Check | Status | Evidence |
|---|---|---|
| Drizzle-kit migrations wired with checksum-verified `schema_version` | ✅ | `src/storage/migrate.ts` + `kg init` |
| SQLite schema: nodes / edges / node_embeddings | ✅ | `src/storage/schema.ts`, `0000_curved_lenny_balinger.sql` |
| Deterministic edge ids (`sha256(src\|rel\|dst\|file\|line)`) | ✅ | `src/graph/ids.ts` |
| Markdown parser (remark + frontmatter + wiki-link) | ✅ | `src/vault/parser.ts` |
| Vault import — MD → nodes + edges | ✅ | `src/vault/import.ts`, `kg import <vault>` |
| **Round-trip test** (20 fixtures × 2 passes, +line-preservation) | ✅ | `tests/round-trip.test.ts` — 41 pass |
| Engine reindex semantics (idempotent upsert + prune) | ✅ | `tests/engine.test.ts` — 5 pass |
| **sqlite-vec extension loads** | ✅ | `tests/vec.test.ts` — 3 pass, `vec_version() = v0.1.9` |
| 1000-file perf | ✅ | **1000 files in ~500ms (≈0.5 ms/file)** |

Total suite: **50 pass / 0 fail** in ~800ms.

---

## Prereqs

- [Bun](https://bun.sh) ≥ 1.1
- A SQLite build with loadable extensions:
  - macOS: `brew install sqlite` (not Apple's bundled libsqlite3)
  - Linux: `apt install libsqlite3-dev` or distro equivalent
  - Override path via `ORGMEM_SQLITE_LIB=/path/to/libsqlite3.dylib`

(Distribution-friendly onboarding lands in week 6 — see `TODO.md`.)

## Quickstart

```bash
bun install
bun src/cli/kg.ts init                # run migrations, verify vec load
bun src/cli/kg.ts import /path/to/vault
bun src/cli/kg.ts status
bun src/cli/kg.ts doctor              # sqlite-vec health check
bun test                              # 50 tests, ~800ms
```

Default DB path: `.orgmem/dev.db` (override with `ORGMEM_DB`).

---

## Design notes (what's locked)

These are the contracts Lane B (MCP) and Lane C (Decision Extractor) will
depend on starting week 2–3. They will not change without a migration.

1. **Source-of-truth split.** Markdown files own prose, frontmatter, and the
   author-authored `edges:` list. SQLite owns every *derived* artifact:
   deterministic edge rows, embeddings, history. Reindexing the entire DB
   from the vault is always safe; reindexing from SQLite alone is not.

2. **Deterministic edge ids.** `edge_id = sha256(src_id|relation|dst_id|source_file|source_line)`.
   `source_line = 0` for frontmatter-origin edges, ≥ 1 for body wiki-links.
   This is what makes per-file reindex correct: we compute the new id set,
   UPSERT it, and `DELETE FROM edges WHERE source_file = ? AND edge_id NOT IN (…)`
   inside a single `BEGIN IMMEDIATE … COMMIT`.

3. **Embedding-only search, no silent fallback.** Every search code path
   calls `requireVec()` which throws with platform-specific install guidance
   if sqlite-vec isn't loaded. Don't introduce BM25 fallback — that decision
   is locked.

4. **Fixed enums (MVP).** Node types: `Document | Task | Meeting | Decision |
   Person`. Relations: `references | drives | blocks | decides | attends |
   driven_by | decided_in`. User-defined types are a v2 concern; until then,
   the parser rejects anything else.

5. **Single-writer soft lock contract.** The FS watcher (full wiring in week
   2) suppresses reindex for 2000ms after an engine self-write, keyed by
   absolute path. Wall-clock window, not mtime-based — APFS mtime precision
   is too noisy. See `src/vault/watcher.ts:SelfWriteTracker`.

---

## Layout

```
src/
  graph/
    types.ts       # NodeType / RelationType enums + row types
    ids.ts         # computeEdgeId(...)
    engine.ts      # upsertDocNodeAndEdges, listEdgesFromFile, count*
  storage/
    sqlite.ts      # openDb, requireVec, ensureVecTable
    schema.ts      # drizzle schema (nodes, edges, node_embeddings)
    migrate.ts     # migration runner, schema_version tracking
    migrations/    # drizzle-generated SQL
  vault/
    parser.ts      # parseDoc, serializeDoc (round-trip safe)
    import.ts      # importVault(...)
    watcher.ts     # SelfWriteTracker + VaultWatcher scaffold
  cli/
    kg.ts          # init / import / status / doctor
tests/
  fixtures/        # 20 round-trip MD fixtures
  round-trip.test.ts
  engine.test.ts
  vec.test.ts
  perf.test.ts
```

---

## License

MIT. Public repo, unpublished — npm package ships with week 6's distribution work.
