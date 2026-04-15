#!/usr/bin/env node
/**
 * npm postinstall health check.
 *
 * Runs after `npm install [-g] orgmem` and surfaces the one failure mode
 * we know trips every fresh install: the host SQLite was built without
 * loadable extensions, so sqlite-vec can't load, so every `kg` command
 * that touches search throws. This script detects that case and prints
 * a platform-specific fix before the operator's first `kg init`.
 *
 * Design notes:
 *   - Plain node ESM (not bun). npm invokes postinstall with node; the
 *     probe itself spawns `bun` to exercise the same sqlite.ts code path
 *     the runtime uses, so we stay in lockstep with the candidate-path
 *     list without a parallel implementation here.
 *   - Always exits 0. A postinstall failure would abort `npm install`,
 *     which is a terrible UX for what is a diagnostic. If bun isn't
 *     installed, the sqlite lib is missing, or `kg doctor` errors out,
 *     we print guidance and move on.
 *   - Skipped when CI=true (GitHub Actions sets this) or when
 *     ORGMEM_SKIP_POSTINSTALL=1 (manual override for local dev loops).
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const kgPath = resolve(here, "..", "src", "cli", "kg.ts");

// Guaranteed-nonexistent path — forces `kg doctor` into its !dbExists
// branch, which runs an ephemeral in-memory vec probe WITHOUT touching
// the disk. This way the postinstall never creates a stray `.orgmem/`
// dir in whatever CWD npm happened to be invoked from.
const probeDb = resolve(
  tmpdir(),
  `orgmem-postinstall-probe-${process.pid}-${Date.now()}-nonexistent.db`,
);

function log(s) {
  process.stderr.write(s + "\n");
}
function ok(s) {
  log("[orgmem] \u2713 " + s);
}
function warn(s) {
  log("[orgmem] \u26A0 " + s);
}
function hint(s) {
  log("         " + s);
}

if (process.env.CI === "true" || process.env.ORGMEM_SKIP_POSTINSTALL === "1") {
  // Silent on CI — the install logs stay clean and CI matrix handles its
  // own sqlite provisioning before running tests.
  process.exit(0);
}

log("[orgmem] postinstall — checking prerequisites…");

function hasBun() {
  try {
    execSync("bun --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasBun()) {
  warn("Bun is required but not on PATH.");
  hint("install from https://bun.sh (>= 1.1), then re-run: npm rebuild orgmem");
  hint("(skipping sqlite-vec probe — bun is needed to run the check)");
  process.exit(0);
}
ok("Bun available.");

let report;
try {
  const raw = execSync(`bun "${kgPath}" doctor`, {
    encoding: "utf8",
    env: { ...process.env, ORGMEM_DB: probeDb },
    // stdout: capture; stdin/stderr: ignore (doctor puts diagnostics on
    // stdout as JSON; any startup errors land on stderr and we ignore them
    // — the JSON parse will fail and we'll warn loud).
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  });
  report = JSON.parse(raw.trim());
} catch (err) {
  warn("Could not run `kg doctor`:");
  hint((err && err.message) ? err.message.split("\n")[0] : String(err));
  hint("sqlite-vec health unknown. Run `kg doctor` manually to diagnose.");
  process.exit(0);
}

if (report.vecLoaded) {
  ok(`sqlite-vec loaded (${report.vecVersion ?? "unknown version"}).`);
  ok("ready. Next: export ORGMEM_VAULT=/path/to/vault && kg init");
  process.exit(0);
}

warn("sqlite-vec extension is not loadable on this host:");
hint(report.vecError ?? "unknown reason");
log("");
const p = report.platform ?? process.platform;
if (p === "darwin") {
  hint("Fix:  brew install sqlite");
} else if (p === "linux") {
  hint("Fix:  sudo apt-get install -y libsqlite3-0 libsqlite3-dev");
  hint("      (or your distribution equivalent)");
} else {
  hint("Fix:  install a SQLite build with loadable-extension support.");
  hint("      Override path via ORGMEM_SQLITE_LIB=/path/to/libsqlite3.{dylib,so}");
}
hint("Then re-run: npm rebuild orgmem");
process.exit(0);
