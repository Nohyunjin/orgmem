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

- [ ] FS watcher: wire `lastSelfWriteAt[path]` 2s suppression map between
  engine writes and the chokidar event handler (scaffold lives in
  `src/vault/watcher.ts`).
- [ ] Embedding dim switcher: if the chosen model's dim changes, drop and
  recreate `node_vec`. Gate on an explicit `kg reindex --reembed` flag
  so accidental runs don't wipe the vec store.
