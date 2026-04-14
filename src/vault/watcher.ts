import chokidar, { type FSWatcher } from "chokidar";
import { resolve } from "node:path";

/**
 * FS watcher scaffold. Full wiring lives in week 2 once the engine writer path
 * is locked. For w1 this file exists so the API shape is stable for Lane B /
 * Lane C to import, and so the `lastSelfWriteAt` contract is written down.
 *
 * Contract:
 *   - Engine writers MUST call `markSelfWrite(path)` immediately before they
 *     write to disk.
 *   - The chokidar handler MUST check `wasRecentSelfWrite(path)` and suppress
 *     reindexing if it returns true. This is the single-writer soft lock —
 *     external edits still reindex, engine edits don't double-dip.
 *   - Suppression window: 2000ms. Wall-clock, not mtime-based. Rationale:
 *     APFS mtime precision + editor-save patterns (atomic rename, sync) can
 *     produce mtime noise; a wall-clock window is the simpler contract.
 */
export class SelfWriteTracker {
  private map = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
  }

  markSelfWrite(path: string): void {
    this.map.set(resolve(path), Date.now());
  }

  wasRecentSelfWrite(path: string): boolean {
    const t = this.map.get(resolve(path));
    if (!t) return false;
    if (Date.now() - t > this.windowMs) {
      this.map.delete(resolve(path));
      return false;
    }
    return true;
  }

  purgeOlderThan(ms: number): void {
    const cutoff = Date.now() - ms;
    for (const [k, v] of this.map) {
      if (v < cutoff) this.map.delete(k);
    }
  }
}

export interface VaultWatcherOptions {
  vaultPath: string;
  debounceMs?: number;
  tracker: SelfWriteTracker;
  /** Called with the (debounced, self-write-filtered) relative path that changed. */
  onChange: (relPath: string) => void | Promise<void>;
}

/**
 * Thin chokidar wrapper. Not started by default — callers explicitly call
 * `start()` so tests can assemble a watcher without binding to the FS.
 */
export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: VaultWatcherOptions) {}

  start(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.opts.vaultPath, {
      ignored: (p: string) => /[\\/](\.git|\.obsidian|node_modules|\.orgmem|\.trash)[\\/]/.test(p),
      ignoreInitial: true,
      persistent: true,
    });
    this.watcher.on("add", (p) => this.queue(p));
    this.watcher.on("change", (p) => this.queue(p));
    this.watcher.on("unlink", (p) => this.queue(p));
  }

  private queue(absPath: string): void {
    if (this.opts.tracker.wasRecentSelfWrite(absPath)) return;
    const existing = this.pending.get(absPath);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.pending.delete(absPath);
      void this.opts.onChange(absPath);
    }, this.opts.debounceMs ?? 500);
    this.pending.set(absPath, handle);
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    await this.watcher.close();
    this.watcher = null;
  }
}
