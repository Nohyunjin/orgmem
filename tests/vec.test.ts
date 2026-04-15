import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDb, ensureVecTable, requireVec } from "../src/storage/sqlite.ts";

const dir = mkdtempSync(resolve(tmpdir(), "orgmem-vec-"));
const dbPath = resolve(dir, "vec.db");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Eng gate Q1: sqlite-vec must load on the dev machine. If this test fails
 * on a fresh checkout, the dev is expected to `brew install sqlite` (or
 * export ORGMEM_SQLITE_LIB) — NOT to silence the test. See TODO.md week 6
 * for the install-time onboarding work.
 */
describe("sqlite-vec extension", () => {
  test("loads and exposes vec_version()", () => {
    const handle = openDb({ path: dbPath, loadVec: true });
    try {
      expect(handle.vecLoaded).toBe(true);
      expect(handle.vecError).toBeUndefined();
      const row = handle.raw.prepare("SELECT vec_version() AS v;").get() as { v: string };
      expect(typeof row.v).toBe("string");
      expect(row.v.length).toBeGreaterThan(0);
    } finally {
      handle.raw.close();
    }
  });

  test("can insert + kNN-query the auto-bootstrapped node_vec (1536-dim)", () => {
    const handle = openDb({ path: dbPath, loadVec: true });
    try {
      // openDb auto-creates node_vec at the configured EMBEDDING_DIM (1536)
      // so we don't call ensureVecTable here — we just verify the table
      // exists and round-trips a typed Float32 vector.
      handle.raw.exec("DELETE FROM node_vec;");
      const a = new Float32Array(1536);
      a[0] = 1;
      const b = new Float32Array(1536);
      b[1] = 1;
      handle.raw
        .prepare("INSERT INTO node_vec (node_id, embedding) VALUES (?, ?);")
        .run("node-a", new Uint8Array(a.buffer));
      handle.raw
        .prepare("INSERT INTO node_vec (node_id, embedding) VALUES (?, ?);")
        .run("node-b", new Uint8Array(b.buffer));
      const rows = handle.raw
        .prepare(
          "SELECT node_id, distance FROM node_vec WHERE embedding MATCH ? AND k = 2 ORDER BY distance;",
        )
        .all(new Uint8Array(a.buffer)) as Array<{ node_id: string; distance: number }>;
      expect(rows.length).toBe(2);
      expect(rows[0]?.node_id).toBe("node-a");
      expect(rows[0]?.distance).toBeCloseTo(0, 5);
    } finally {
      handle.raw.close();
    }
  });

  test("requireVec throws loudly when extension unavailable (silent fallback forbidden)", () => {
    const fakeHandle = {
      raw: null as never,
      db: null as never,
      path: "/tmp/fake.db",
      vecLoaded: false,
      vecError: "synthesized failure for test",
    };
    expect(() => requireVec(fakeHandle)).toThrow(/orgmem requires the sqlite-vec extension/);
    expect(() => requireVec(fakeHandle)).toThrow(/synthesized failure for test/);
  });
});
