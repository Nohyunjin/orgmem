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

  test("can create and query a vec0 virtual table", () => {
    const handle = openDb({ path: dbPath, loadVec: true });
    try {
      ensureVecTable(handle, 4);
      handle.raw.exec("DELETE FROM node_vec;");
      const vecA = new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer);
      const vecB = new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer);
      handle.raw
        .prepare("INSERT INTO node_vec (node_id, embedding) VALUES (?, ?);")
        .run("node-a", vecA);
      handle.raw
        .prepare("INSERT INTO node_vec (node_id, embedding) VALUES (?, ?);")
        .run("node-b", vecB);
      const rows = handle.raw
        .prepare(
          "SELECT node_id, distance FROM node_vec WHERE embedding MATCH ? AND k = 2 ORDER BY distance;",
        )
        .all(vecA) as Array<{ node_id: string; distance: number }>;
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
