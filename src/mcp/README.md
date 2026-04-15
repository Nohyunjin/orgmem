# orgmem MCP server

Stdio MCP server that lets coding agents (Claude Code, Cursor, Codex, etc.) read from and write to a markdown vault that's mirrored into a SQLite knowledge graph. 9 tools cover create/read/append/status-update on the graph.

## Quick start

```bash
# 1. install deps + initialize the DB
bun install
bun src/cli/kg.ts init                      # creates .orgmem/dev.db

# 2. point at a vault and start the server
ORGMEM_VAULT=/abs/path/to/vault bun src/cli/kg.ts mcp
# stderr: [orgmem-mcp] stdio ready · db=… · vault=… · vec=ok · search=…
```

The server speaks stdio JSON-RPC. Don't write to stdout — that channel belongs to the MCP protocol.

## Environment variables

| var | required | purpose |
|---|---|---|
| `ORGMEM_VAULT` | yes (unless `--vault` passed) | absolute path to the markdown vault root. Must exist on disk. |
| `ORGMEM_DB` | no (default `.orgmem/dev.db`) | SQLite file. Migrations run automatically on boot. |
| `OPENAI_API_KEY` | no | enables `kg_search` (embedding-backed semantic search). Without it, `kg_search` returns a structured "search disabled" error and the other 8 tools work normally. |
| `ORGMEM_SQLITE_LIB` | no | override system SQLite path (only needed if `sqlite-vec` fails to load with the bundled bun SQLite). |

## Client setup

### Claude Code — project scope

Already wired in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "orgmem": {
      "command": "bun",
      "args": ["src/cli/kg.ts", "mcp"],
      "env": {
        "ORGMEM_VAULT": "/Users/you/workspace/orgmem/vault"
      }
    }
  }
}
```

Restart Claude Code, run `/mcp`, approve `orgmem`. The 9 tools appear under that server's namespace.

### Claude Code — global scope

If you want orgmem available across all projects, add the same block to `~/.claude.json` under `mcpServers`. Use absolute paths (no `${workspaceFolder}` interpolation in user scope).

### Cursor

Cursor reads `~/.cursor/mcp.json` (global) or `<repo>/.cursor/mcp.json` (project). Same shape:

```json
{
  "mcpServers": {
    "orgmem": {
      "command": "bun",
      "args": ["/Users/you/workspace/orgmem/src/cli/kg.ts", "mcp"],
      "env": { "ORGMEM_VAULT": "/Users/you/workspace/orgmem/vault" }
    }
  }
}
```

Cursor doesn't inherit your shell `cwd`, so use absolute paths to `kg.ts`.

### Generic stdio MCP client

`command: bun`, `args: ["src/cli/kg.ts", "mcp"]`, `cwd: <repo root>`, env as above. Anything that speaks the MCP stdio transport (Codex, custom Python clients, the `@modelcontextprotocol/inspector` CLI, etc.) works.

## Tool reference (9 total)

### Read

| tool | what it does |
|---|---|
| `kg_status` | node/edge counts, vault/db paths, vec-load state, embedding queue breakdown, whether `kg_search` is enabled. No args. |
| `kg_get_node` | fetch a single node by id. Returns `{ node: NodeRow \| null }`. |
| `kg_list_edges_from_file` | every edge whose `source_file` matches a vault-relative path. Useful for verifying reindex behavior. |
| `kg_search` | embedding-backed search + 1-hop neighbor expansion. Requires `OPENAI_API_KEY` at server boot AND embedded nodes (`bun src/cli/kg.ts embed`). |

### Write

| tool | what it does |
|---|---|
| `kg_create_node` | materializes a new node as a markdown file under the vault and upserts it into the graph. Idempotent on title collisions (`-2`, `-3`, …). Returns `{ id, mdPath, absPath }`. |
| `kg_create_edge` | adds an edge to the source node's frontmatter and reindexes. Idempotent: duplicate semantic edge → `alreadyPresent: true`, no rewrite. |
| `doc_append` | appends a markdown block to an existing node's body. Preserves frontmatter (incl. edges) and prior body. **Not idempotent** — calling twice appends twice. Rejects empty content, missing nodes, and non-file-backed nodes. |
| `task_update_status` | sets the `status` frontmatter field on a Task node. Allowed values: `todo \| in_progress \| blocked \| done \| cancelled`. Returns `{ previousStatus, newStatus }`. Rejects non-Task types. |

### Stub (week 3)

| tool | what it does |
|---|---|
| `decisions_extract` | placeholder for Lane C's V2 Decision Extractor (recall ≥ 0.85). Currently echoes inputs + flags `stub: true`. Lands once the integration plan is finalized. |

## Behaviour to know

- **Embedding queue:** any tool that rewrites a markdown file (`kg_create_node`, `kg_create_edge`, `doc_append`, `task_update_status`) flips that node's `embedding_status` back to `pending`. Run `bun src/cli/kg.ts embed --resume` to re-embed. This affects `kg_search` ranking until the queue drains.
- **stdout discipline:** the server writes the boot banner and shutdown messages to **stderr only**. If you wire a custom transport, do not ever write to stdout.
- **Failure shape:** every tool returns `{ content: [{ type: "text", text: <pretty JSON> }] }` on success. On failure, `isError: true` is set and the JSON payload has `{ error: "<message>" }` — agents can branch on `isError`.
- **Vault writes are bytes-on-disk first, then DB upsert.** If a watcher is running, the engine's `SelfWriteTracker` suppresses the double-reindex.
- **No edge dst existence check.** `kg_create_edge` accepts dangling destinations on purpose (forward references are common during ingestion).

## Diagnostics

```bash
bun src/cli/kg.ts doctor      # vec-load state, sqlite-vec version, platform info
bun src/cli/kg.ts status      # same payload as the kg_status tool, from the CLI
```

If the server boots but `kg_search` reports unavailable, check:

1. `OPENAI_API_KEY` is in the **MCP client's** env (not just your shell — Cursor/Claude Code spawn the child with a scoped env block).
2. `kg embed` has run at least once on the vault.
3. `kg doctor` shows `vecLoaded: true`. If not, the `ORGMEM_SQLITE_LIB` workaround may be needed on macOS.

## Tests

Two layers, both run on `bun test`:

- `tests/mcp.test.ts` — InMemoryTransport, fast, exercises every tool's happy + error paths.
- `tests/mcp-e2e.test.ts` — spawns `bun src/cli/kg.ts mcp` as a real child process via `StdioClientTransport`, validates the full protocol surface end-to-end including file-on-disk effects.
