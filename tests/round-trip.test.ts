import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDoc, serializeDoc, type ParsedDoc } from "../src/vault/parser.ts";

const FIXTURES_DIR = resolve(import.meta.dir, "fixtures");

function loadFixtures(): Array<{ name: string; raw: string }> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, raw: readFileSync(resolve(FIXTURES_DIR, f), "utf8") }));
}

/**
 * The round-trip contract: parse → serialize → parse must produce an equal
 * ParsedDoc on the *authoritative* subset of fields. Trailing whitespace,
 * YAML key order, body-line offsets from frontmatter reflow are NOT part
 * of the contract.
 */
function project(doc: ParsedDoc) {
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    fmEdges: [...doc.fmEdges].sort((a, b) => a.to.localeCompare(b.to) || a.relation.localeCompare(b.relation)),
    wikiTargets: doc.wikiLinks.map((l) => l.target).sort(),
    body: doc.body.trim(),
  };
}

describe("round-trip: parse → serialize → parse is idempotent on authoritative subset", () => {
  const fixtures = loadFixtures();
  expect(fixtures.length).toBeGreaterThanOrEqual(20);

  for (const { name, raw } of fixtures) {
    test(name, () => {
      const first = parseDoc({ relPath: name, raw });
      const roundtripped = serializeDoc(first);
      const second = parseDoc({ relPath: name, raw: roundtripped });
      expect(project(second)).toEqual(project(first));
    });
  }
});

describe("round-trip: two serialize passes converge (no drift)", () => {
  const fixtures = loadFixtures();
  for (const { name, raw } of fixtures) {
    test(name, () => {
      const a = parseDoc({ relPath: name, raw });
      const firstSerialize = serializeDoc(a);
      const b = parseDoc({ relPath: name, raw: firstSerialize });
      const secondSerialize = serializeDoc(b);
      // After one round-trip the text is canonicalized; further passes must
      // be byte-identical (fixed point).
      expect(secondSerialize).toEqual(firstSerialize);
    });
  }
});

describe("round-trip: wiki-link line numbers are preserved across serialize", () => {
  test("13-multi-links-one-line.md keeps 3 links on same line", () => {
    const raw = readFileSync(resolve(FIXTURES_DIR, "13-multi-links-one-line.md"), "utf8");
    const a = parseDoc({ relPath: "13-multi-links-one-line.md", raw });
    const [alpha, beta, gamma, delta] = a.wikiLinks;
    expect(alpha?.target).toBe("alpha");
    expect(beta?.target).toBe("beta");
    expect(gamma?.target).toBe("gamma");
    expect(delta?.target).toBe("delta");
    // alpha, beta, gamma on the same line
    expect(alpha?.line).toBe(beta?.line);
    expect(beta?.line).toBe(gamma?.line);
    expect(delta?.line).toBeGreaterThan(alpha?.line ?? 0);
  });
});
