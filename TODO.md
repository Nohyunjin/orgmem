# Phase 1 TODOs

Backlog captured during week-by-week work. Items are scoped to a week when a
natural slot exists; otherwise "unscheduled". Do not delete — mark `DONE` with
commit SHA when shipped.

## Week 6 — distribution

- [ ] **sqlite-vec system dependency onboarding.** Currently vec load requires
  a separately-installed system SQLite with loadable extensions
  (`brew install sqlite` on macOS, `libsqlite3-dev` on Linux). On fresh
  installs this silently fails to `vecLoaded=false`, which now throws on
  every search call. We need:
    - README postinstall note with per-platform install commands
    - An npm `postinstall` script that runs `kg doctor` (load + query
      a trivial vec_distance) and prints the install command on failure
    - Consider shipping a prebuilt static SQLite in the npm package so end
      users don't need brew/apt at all. Evaluate size + license tradeoff.

## Unscheduled

- [ ] **Auto-extraction on `kg import`** behind `--extract-decisions` flag. Currently
  extraction is manual-trigger only (`kg extract-decisions <file>`). Auto-run
  requires trust in F1 under real traffic; promote after week 4+ usage data.
- [ ] **Decision deduplication across source docs.** Deterministic ids currently
  dedupe within a single (sourceDocId, text) pair. If the same decision is
  mentioned in 3 meeting notes, we'll produce 3 Decision nodes with 3 distinct
  ids. Future: content-based dedup (sha256 of normalized text) with multiple
  `decided_in` edges pointing at one canonical Decision.
- [ ] **Body-anchored Decision edges.** `createEdge` rejects non-zero sourceLine
  (write.ts:308). Decision `source_line` is parked on frontmatter as metadata
  for now. Promote to a real edge attribute once body-anchored edges ship.

- [ ] FS watcher: wire `lastSelfWriteAt[path]` 2s suppression map between
  engine writes and the chokidar event handler (scaffold lives in
  `src/vault/watcher.ts`).
- [ ] Embedding dim switcher: if the chosen model's dim changes, drop and
  recreate `node_vec`. Gate on an explicit `kg reindex --reembed` flag
  so accidental runs don't wipe the vec store.
- [ ] **Lane A dogfood (2026-04-15, `/tmp/lane-a-dogfood` over doc-mvp
  vault, 5 files, 0 edges):**
    - "Pure prose" vaults (design notes, planning docs) produce `edges=0`
      because they lack frontmatter `edges:` and `[[wiki-links]]`. Search
      still works but 1-hop expansion has nothing to expand, which hides
      half of what makes this tool useful. Ship a `docs/authoring-guide.md`
      that documents the minimum linking convention agents should write
      when producing Meeting / Decision / Task docs, and consider a
      `kg lint` command that flags nodes with zero outgoing edges.
    - `kg import` on 5 files finished in 29ms with no per-file log.
      Acceptable for small vaults, but for a 1000+ file Obsidian vault
      the operator gets nothing between "started" and "done". Add an
      opt-in `--verbose` flag that streams one line per file (path +
      nodes/edges delta) so slow imports are debuggable.
- [ ] **Lane C dogfood follow-ups** (`docs/dogfood-2026-04-15.md`): 4 fixes
  ordered by ROI — classify-as-postfilter (~40% FP at cap=15 → decision-only
  graph), filename byte cap for long Korean titles, VERBATIM substring
  post-check to drop paraphrased/hallucinated line refs, text-similarity
  dedup for idempotent re-runs at temperature=0.
