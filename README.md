# orgmem

Agent-native knowledge & work graph: docs, tasks, meetings, and decisions
as first-class nodes in a SQLite graph maintained by AI agents over MCP.
A markdown vault is the source of truth; orgmem materializes deterministic
edges, runs sqlite-vec embedding search, and exposes a 9-tool MCP server
so Claude Code, Cursor, and other agents can read + write the graph.

> **Status:** v0.2.0 shipped. Heading-split chunking replaces whole-doc
> embeddings — dogfood flipped the two blocked queries (Approach C
> rationale + Phase 0 gates) from ❌ to ✅, hitting the 3/6 improvement
> target. Lane A (graph engine + chunking), Lane B (MCP, 9 tools),
> Lane C (Decision Extractor, F1=0.983) all on `main`. CI green on
> macOS + Ubuntu. Binary releases via `brew install Nohyunjin/tap/orgmem`
> or [GitHub Releases](https://github.com/Nohyunjin/orgmem/releases).

---

## Install

Three install paths depending on what you already have on your machine.
All three end at the same `kg` CLI on your `PATH`.

### Option A — Homebrew (one-liner, recommended)

```bash
brew install Nohyunjin/tap/orgmem
```

> **Status:** the tap repo
> ([Nohyunjin/homebrew-tap](https://github.com/Nohyunjin/homebrew-tap))
> is live; the formula's `url` + `sha256` get filled in the moment
> `v0.1.0` is tagged and `release.yml` attaches the per-platform
> binaries to the GitHub Release. Until then the formula points at
> placeholders — track
> [`packaging/homebrew/`](packaging/homebrew/) for the runbook.

This installs the bun-compile single binary, so you don't need Bun or
Node on PATH separately. `sqlite` (with loadable extensions) is pulled
in as a Homebrew dependency.

<details>
<summary><strong>First run on macOS (ad-hoc signed binary)</strong></summary>

The macOS binary is ad-hoc signed (not Developer-ID notarized — that
lands in v0.2). With `v0.1.1+` the CI pipeline runs
`codesign --sign -` before publishing, so `brew install` → `kg` works
out of the box on any arm64 Mac.

If you installed v0.1.0 (the first release, pre-codesign) and `kg`
exits silently or with a "damaged app" dialog, either re-sign locally:

```bash
codesign --force --sign - "$(which kg)"
```

or strip Gatekeeper's quarantine flag:

```bash
xattr -d com.apple.quarantine "$(which kg)" 2>/dev/null || true
```

Upgrading to v0.1.1+ via `brew upgrade orgmem` is the cleanest fix.
</details>

### Option B — npm (cross-platform)

```bash
npm install -g orgmem
```

Requires:

- [Bun](https://bun.sh) ≥ 1.1 on PATH (the `kg` shebang is
  `#!/usr/bin/env bun`).
- A SQLite build with loadable extension support (Apple's bundled
  libsqlite3 doesn't qualify):
  - macOS: `brew install sqlite`
  - Linux: `sudo apt install libsqlite3-0 libsqlite3-dev` (or your
    distribution's equivalent)
  - Override path: `export ORGMEM_SQLITE_LIB=/path/to/libsqlite3.dylib`

The `postinstall` hook runs a sqlite-vec health check and prints the
exact fix command if anything is missing.

### Option C — Source (developers / contributors)

```bash
git clone https://github.com/Nohyunjin/orgmem.git
cd orgmem
bun install
bun src/cli/kg.ts --version
bun test               # 172 tests, ~1.5s
```

Same Bun + system-SQLite prereqs as Option B. Run the CLI as
`bun src/cli/kg.ts <cmd>` instead of `kg <cmd>` (or `npm link` to expose
the bin).

---

## First run

```bash
export ORGMEM_VAULT=~/path/to/your/vault     # any dir that holds .md files
kg init                                       # apply migrations, verify vec
kg import "$ORGMEM_VAULT"                     # nodes + frontmatter/wiki edges
kg status                                     # node / edge / embed-queue counts
kg doctor                                     # full health check (incl. API keys)
```

Optional — embedding search + grounded answers:

```bash
export OPENAI_API_KEY=sk-...                  # required for kg embed / kg ask
export ANTHROPIC_API_KEY=sk-ant-...           # required for kg ask
kg embed --resume                             # backfill embeddings (resumable)
kg ask "what did we decide about the payment vendor?"
```

Optional — agent-driven decision extraction (Lane C):

```bash
kg extract-decisions "$ORGMEM_VAULT/meetings/2026-04-15-kickoff.md"
```

---

## Claude Code MCP setup

orgmem ships a 9-tool MCP server reachable over stdio. Wire it into Claude
Code with a project-scoped or user-scoped `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "orgmem": {
      "command": "kg",
      "args": ["mcp", "--vault", "/absolute/path/to/your/vault"],
      "env": {
        "ORGMEM_DB": "/absolute/path/to/.orgmem/dev.db",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

- **Project-scoped** (recommended for per-vault setups):
  `<project>/.mcp.json` — checked in alongside the vault.
- **User-scoped** (recommended for a single global vault):
  `~/.config/claude-code/.mcp.json`.

After saving, restart Claude Code (or run `/mcp` in the chat) — the
agent should list 9 tools under `orgmem`:

| Tool | Purpose |
|---|---|
| `kg_create_node` | New Document/Task/Meeting/Decision/Person; writes the MD file + DB row |
| `kg_create_edge` | Add a frontmatter edge between existing nodes |
| `kg_get_node` | Read a single node's row + frontmatter |
| `kg_list_edges_from_file` | All edges authored by one source file |
| `kg_search` | Embedding-backed search + 1-hop neighbor expansion |
| `kg_status` | Node/edge/embed-queue counts (matches `kg status`) |
| `doc_append` | Append a block to a node's body, preserving frontmatter |
| `task_update_status` | Mutate a Task's `status` frontmatter (todo/in_progress/blocked/done/cancelled) |
| `decisions_extract` | Run Lane C's classifier + extractor on a Document/Meeting node |

`kg_search` and `decisions_extract` need the corresponding API key set in
the `env` block above (or in the parent shell). Without
`OPENAI_API_KEY`, `kg_search` returns a clear `unavailable` error rather
than silently degrading.

---

## Phase 1 status snapshot

172 tests pass / 1 skip / 0 fail across hermetic suites; type-clean on
TypeScript 5.7. CI matrix runs on macOS + Ubuntu per push and PR
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

| Lane | What's locked on `main` | Tests |
|---|---|---|
| A — graph engine | migrations + schema_version, deterministic edges, MD parser w/ frontmatter + wiki-links, `createNode`, `createEdge`, `appendToNode`, `updateNodeStatus`, vault import w/ idempotent reindex, sqlite-vec wired, embedding backfill (resumable, 429 backoff), search + 1-hop, `kg ask` answer pipeline, `kg doctor` v2, byte-capped slugify, integration scaffold, perf bench harness | 92 |
| B — MCP server | stdio server + 9 tools (table above), in-memory + real-stdio e2e tests | 17 |
| C — Decision Extractor | classify v2 (F1 = 0.983) + extract v1.1 (recall = 0.90) prompts ported, materializer, `kg extract-decisions` CLI, classify-postfilter, normalization-dedup, VERBATIM substring guard | 63 |

Local perf baseline ([`perf/bench-20260415.json`](perf/bench-20260415.json)):
import 0.51 ms/file (1000 files in 511 ms), search p50 = 0.99 ms (target ≤
200 ms — PASS by 200×). Embed and ask wall-clock require live API keys —
the harness ships ready, run with `--with-real-embed --with-real-ask`.

---

## Design notes (what's locked)

These are the contracts Lane B (MCP) and Lane C (Decision Extractor)
depend on. They will not change without a migration.

1. **Source-of-truth split.** Markdown files own prose, frontmatter, and
   the author-authored `edges:` list. SQLite owns every *derived*
   artifact: deterministic edge rows, embeddings, history. Reindexing
   the entire DB from the vault is always safe; reindexing from SQLite
   alone is not.

2. **Deterministic edge ids.**
   `edge_id = sha256(src_id|relation|dst_id|source_file|source_line)`.
   `source_line = 0` for frontmatter-origin edges, ≥ 1 for body
   wiki-links. This is what makes per-file reindex correct: we compute
   the new id set, UPSERT it, and
   `DELETE FROM edges WHERE source_file = ? AND edge_id NOT IN (…)`
   inside a single `BEGIN IMMEDIATE … COMMIT`.

3. **Embedding-only search, no silent fallback.** Every search code path
   calls `requireVec()` which throws with platform-specific install
   guidance if sqlite-vec isn't loaded. No BM25 fallback — that decision
   is locked.

4. **Fixed enums (MVP).** Node types:
   `Document | Task | Meeting | Decision | Person`. Relations:
   `references | drives | blocks | decides | attends | driven_by | decided_in`.
   User-defined types are a v2 concern; until then, the parser rejects
   anything else.

5. **Single-writer soft lock contract.** The FS watcher (full wiring in
   week 4) suppresses reindex for 2000ms after an engine self-write,
   keyed by absolute path. Wall-clock window, not mtime-based — APFS
   mtime precision is too noisy. See `src/vault/watcher.ts:SelfWriteTracker`.

---

## Layout

```
src/
  graph/
    types.ts          # NodeType / RelationType enums + row types
    ids.ts            # computeEdgeId(...)
    engine.ts         # upsertDocNodeAndEdges, getNode, count*
    write.ts          # createNode / createEdge / appendToNode / updateNodeStatus / slugify
    search.ts         # search() — vec MATCH + 1-hop neighbors
    index.ts          # public API surface (Lane B/C contract)
  storage/
    sqlite.ts         # openDb, requireVec, ensureVecTable
    schema.ts         # drizzle schema (nodes, edges, node_embeddings)
    migrate.ts        # migration runner, schema_version tracking
    migrations/       # drizzle-generated SQL
  vault/
    parser.ts         # parseDoc, serializeDoc (round-trip safe)
    import.ts         # importVault(...)
    watcher.ts        # SelfWriteTracker + VaultWatcher scaffold
  embeddings/
    client.ts         # OpenAI fetch client + stub
    backfill.ts       # resumable backfill into node_vec
    model.ts          # text-embedding-3-small / 1536d
  answer/
    client.ts         # Anthropic fetch client + stub
    ask.ts            # ask() — search → grounded prompt → LLM
  extractor/          # Lane C: classify v2 + extract v1.1 + materialize
  mcp/
    server.ts         # MCP server bootstrap
    start.ts          # stdio transport entry
    context.ts        # shared DbHandle + clients
    tools/            # 9 tools (see Claude Code MCP setup)
  cli/
    kg.ts             # init / import / embed / ask / mcp /
                      # extract-decisions / status / doctor
scripts/
  bench.ts            # W2.5 perf harness → perf/bench-YYYYMMDD.json
  postinstall.mjs     # npm postinstall vec health check
packaging/
  homebrew/           # Formula draft + tap release runbook
.github/
  workflows/
    ci.yml            # PR + main: bun test + tsc on macOS+Ubuntu
    release.yml       # tag v*: bun --compile per-platform → GH Release
tests/
  fixtures/           # 20 round-trip MD fixtures
  *.test.ts           # 172 tests (round-trip, engine, write, search, ask,
                      # vec, perf, integration, embeddings, extractor, mcp,
                      # mcp-e2e)
```

---

## License

MIT. Source on [GitHub](https://github.com/Nohyunjin/orgmem); npm package
publishes once Lane C dogfood signs off; Homebrew tap mirrors the
release at [Nohyunjin/homebrew-tap](https://github.com/Nohyunjin/homebrew-tap).
