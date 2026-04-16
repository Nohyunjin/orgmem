import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/storage/migrate.ts";
import { openDb, type DbHandle } from "../src/storage/sqlite.ts";
import { importVault } from "../src/vault/import.ts";
import { createStubClient } from "../src/embeddings/client.ts";
import { runBackfill } from "../src/embeddings/backfill.ts";
import { EMBEDDING_DIM } from "../src/embeddings/model.ts";
import {
  createAnthropicClient,
  createStubAnswerClient,
} from "../src/answer/client.ts";
import {
  ask,
  buildUserPrompt,
  EMPTY_ANSWER,
  SYSTEM_PROMPT,
} from "../src/answer/ask.ts";
import { search } from "../src/graph/search.ts";

function mkWs() {
  const dir = mkdtempSync(resolve(tmpdir(), "orgmem-ask-"));
  const vault = join(dir, "vault");
  const db = join(dir, "dev.db");
  mkdirSync(vault, { recursive: true });
  return { dir, vault, db };
}

function unitVec(idx: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[idx % EMBEDDING_DIM] = 1;
  return v;
}

function writeVault(vault: string) {
  writeFileSync(
    join(vault, "spec.md"),
    `---
id: doc-spec
type: Document
title: "Payment spec"
edges:
  - to: meeting-kickoff
    relation: decided_in
---
# Payment spec

Refers to [[task-toss]]. Uses Toss PG.
`,
  );
  writeFileSync(
    join(vault, "task.md"),
    `---
id: task-toss
type: Task
title: "Toss PG integration"
edges:
  - to: doc-spec
    relation: driven_by
---
# Toss PG integration
`,
  );
  writeFileSync(
    join(vault, "meeting.md"),
    `---
id: meeting-kickoff
type: Meeting
title: "Payment kickoff"
---
# Payment kickoff
`,
  );
}

describe("ask() pipeline", () => {
  let ws: ReturnType<typeof mkWs>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWs();
    runMigrations(ws.db);
    handle = openDb({ path: ws.db, loadVec: true });
    writeVault(ws.vault);
    importVault(handle, ws.vault);
  });
  afterEach(() => {
    handle.raw.close();
    rmSync(ws.dir, { recursive: true, force: true });
  });

  test("empty query returns empty result without calling LLM", async () => {
    const embed = createStubClient(new Map());
    const answer = createStubAnswerClient([]);
    const res = await ask(handle, embed, answer, "   ");
    expect(res.empty).toBe(true);
    expect(res.answer).toBe("");
    expect(res.hits).toEqual([]);
    expect(answer.callCount()).toBe(0);
  });

  test("no embeddings yet → EMPTY_ANSWER fast path, LLM not called", async () => {
    const embed = createStubClient(new Map([["what about payments", unitVec(0)]]));
    const answer = createStubAnswerClient([]);
    const res = await ask(handle, embed, answer, "what about payments");
    expect(res.empty).toBe(true);
    expect(res.answer).toBe(EMPTY_ANSWER);
    expect(res.hits).toEqual([]);
    expect(answer.callCount()).toBe(0);
  });

  test("populated graph → calls LLM with grounded prompt, returns answer + hits + usage", async () => {
    const vecs = new Map<string, Float32Array>();
    vecs.set("Payment spec\n\n# Payment spec\n\nRefers to [[task-toss]]. Uses Toss PG.\n", unitVec(10));
    vecs.set("Toss PG integration\n\n# Toss PG integration\n", unitVec(20));
    vecs.set("Payment kickoff\n\n# Payment kickoff\n", unitVec(30));
    vecs.set("how do payments work", unitVec(10));

    const embed = createStubClient(vecs);
    await runBackfill(handle, embed, { batchSize: 4 });

    const answer = createStubAnswerClient([
      {
        match: /Payment spec/,
        text: "Payments are specced in [[doc-spec]] and implemented by [[task-toss]].",
        usage: { inputTokens: 123, outputTokens: 45 },
      },
    ]);

    const res = await ask(handle, embed, answer, "how do payments work", {
      k: 3,
      neighborCap: 4,
    });

    expect(res.empty).toBe(false);
    expect(res.answer).toContain("[[doc-spec]]");
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.usage?.inputTokens).toBe(123);
    expect(res.usage?.outputTokens).toBe(45);
    expect(answer.callCount()).toBe(1);

    const req = answer.lastRequest();
    expect(req).not.toBeNull();
    expect(req!.system).toBe(SYSTEM_PROMPT);
    // Prompt must carry the grounded context (hit id, title, edges).
    expect(req!.user).toContain("[[doc-spec]]");
    expect(req!.user).toContain("Payment spec");
    expect(req!.user).toContain("decided_in");
    expect(req!.user).toContain("# Query");
    expect(req!.user).toContain("# Context");
  });

  test("buildUserPrompt clips content to the char cap", async () => {
    const vecs = new Map<string, Float32Array>();
    vecs.set("Payment spec\n\n# Payment spec\n\nRefers to [[task-toss]]. Uses Toss PG.\n", unitVec(10));
    vecs.set("Toss PG integration\n\n# Toss PG integration\n", unitVec(20));
    vecs.set("Payment kickoff\n\n# Payment kickoff\n", unitVec(30));
    vecs.set("query", unitVec(10));

    const embed = createStubClient(vecs);
    await runBackfill(handle, embed, { batchSize: 4 });
    const hits = await search(handle, embed, "query", { k: 3, neighborCap: 4 });
    expect(hits.length).toBeGreaterThan(0);

    const clipped = buildUserPrompt("query", hits, 5);
    // With a 5-char cap every body will be truncated to 5 chars + ellipsis.
    expect(clipped).toContain("…");
    // Still structurally intact.
    expect(clipped).toContain("# Query");
    expect(clipped).toContain("# Context");
  });
});

describe("Anthropic client", () => {
  test("parses content + usage on 200", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hello world" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 9 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const client = createAnthropicClient({
      apiKey: "sk-test",
      fetchImpl,
      backoff: { sleepImpl: async () => {} },
    });
    const out = await client.complete({ system: "s", user: "u" });
    expect(out.text).toBe("hello world");
    expect(out.usage.inputTokens).toBe(7);
    expect(out.usage.outputTokens).toBe(9);
    expect(out.stopReason).toBe("end_turn");
  });

  test("retries 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = createAnthropicClient({
      apiKey: "sk-test",
      fetchImpl,
      backoff: { initialMs: 1, maxMs: 1, maxRetries: 2, jitter: false, sleepImpl: async () => {} },
    });
    const out = await client.complete({ system: "s", user: "u" });
    expect(out.text).toBe("ok");
    expect(calls).toBe(2);
  });

  test("throws on non-retryable HTTP error", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const client = createAnthropicClient({
      apiKey: "sk-test",
      fetchImpl,
      backoff: { sleepImpl: async () => {} },
    });
    await expect(client.complete({ system: "s", user: "u" })).rejects.toThrow(/HTTP 400/);
  });

  test("gives up after maxRetries on persistent 5xx", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("nope", { status: 503, headers: { "retry-after": "0" } });
    }) as unknown as typeof fetch;
    const client = createAnthropicClient({
      apiKey: "sk-test",
      fetchImpl,
      backoff: { initialMs: 1, maxMs: 1, maxRetries: 2, jitter: false, sleepImpl: async () => {} },
    });
    await expect(client.complete({ system: "s", user: "u" })).rejects.toThrow(/HTTP 503/);
    // initial call + 2 retries = 3 total
    expect(calls).toBe(3);
  });

  test("sends x-api-key + anthropic-version headers and correct body shape", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : (url as URL).toString();
      capturedInit = init;
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = createAnthropicClient({
      apiKey: "sk-secret",
      model: "claude-haiku-4-5-20251001",
      fetchImpl,
      backoff: { sleepImpl: async () => {} },
    });
    await client.complete({ system: "SYS", user: "USR", maxTokens: 256 });

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBe(256);
    expect(body.system).toBe("SYS");
    expect(body.messages).toEqual([{ role: "user", content: "USR" }]);
  });
});

/**
 * Regression guards for the v0.2.1 prompt tuning (commit e8cb483 + follow-up).
 *
 * Iteration 1 added two rules to SYSTEM_PROMPT that over-corrected:
 *   - "heading scope" rule (REMOVED in follow-up) was too strict, making
 *     the LLM refuse the premise of counting/listing queries like
 *     "Phase 0 게이트 3가지" even when the source doc supports that reading.
 *   - "named-artifact existence" rule applied too broadly — now scoped
 *     explicitly to yes/no existence questions only, NOT counting /
 *     listing / summarizing / comparing / explanatory queries.
 *
 * These tests assert the prompt's SHAPE, not a specific LLM behavior:
 *   1. the existence rule is present and scoped
 *   2. the removed heading-scope rule does not sneak back in
 *   3. the rule's non-existence scope covers at least counting +
 *      listing + summarizing
 *   4. the citation contract is still in place
 */
describe("SYSTEM_PROMPT (v0.2.1 follow-up shape)", () => {
  test("named-artifact existence rule exists and is scoped to yes/no", () => {
    expect(SYSTEM_PROMPT).toContain("Named-artifact existence rule");
    expect(SYSTEM_PROMPT).toContain("yes/no questions");
  });

  test("existence rule explicitly excludes counting / listing / summarizing queries", () => {
    // The follow-up scope line lists every query type that v0.2 handled
    // correctly and that iter1 broke. Losing any of these in a future
    // prompt edit should fail CI loud.
    for (const kw of ["counting", "listing", "summarizing", "comparing", "explanatory"]) {
      expect(SYSTEM_PROMPT).toContain(kw);
    }
  });

  test("over-strict heading-scope rule from iter1 stays removed", () => {
    // The phrase "treat the chunk as supporting context at best" was the
    // iter1 rule-2 that broke phase0-gates. Re-adding it would regress.
    expect(SYSTEM_PROMPT).not.toContain("supporting context at best");
    expect(SYSTEM_PROMPT).not.toContain("primary evidence that the topic is present");
  });

  test("citation contract still uses [[node-id#heading]]", () => {
    expect(SYSTEM_PROMPT).toContain("[[node-id#heading]]");
    expect(SYSTEM_PROMPT).toContain("double brackets");
  });
});

/**
 * Behavioral smoke via the stub answer client: both a named-existence
 * query and a counting query reach the LLM with the FULL chunk content
 * (no heading-scope gating), so the LLM has the evidence it needs in
 * both shapes. We only verify the prompt plumbing here; grading the
 * model's actual answer lives in scripts/dogfood.ts against real keys.
 */
describe("ask() routes existence vs counting queries with the same chunk context", () => {
  let ws: ReturnType<typeof mkWs>;
  let handle: DbHandle;

  beforeEach(() => {
    ws = mkWs();
    runMigrations(ws.db);
    handle = openDb({ path: ws.db, loadVec: true });
    // Vault with a single Phase 0 doc that has a "게이트" heading — so
    // ask pulls back the full section body regardless of query phrasing.
    import("node:fs").then(() => {}); // keep bun type-happy
  });
  afterEach(() => {
    handle.raw.close();
    import("node:fs").then(({ rmSync }) => rmSync(ws.dir, { recursive: true, force: true }));
  });

  test("counting query carries full chunk body (not just heading) to the LLM", async () => {
    // Single-chunk fixture — no H2 — so chunkDoc emits one chunk
    // (heading=null, content=body) and the stub embed input reduces to
    // `${nodeTitle}\n\n${content}`, predictable enough to key a
    // stub-vector map on.
    const { writeFileSync } = await import("node:fs");
    const body = [
      "# Phase 0",
      "",
      "The gate criteria for this phase are enumerated below.",
      "1. Interview gate — 3+/5 admit pain",
      "2. Install gate — 10+ installs",
      "3. Retention gate — 2+ return within a week",
      "",
    ].join("\n");
    writeFileSync(
      `${ws.vault}/phase0.md`,
      [
        "---",
        "id: doc-phase0",
        "type: Document",
        'title: "Phase 0 plan"',
        "---",
        body,
      ].join("\n"),
    );
    const { importVault } = await import("../src/vault/import.ts");
    importVault(handle, ws.vault);
    const vecs = new Map<string, Float32Array>();
    const chunkEmbedInput = `Phase 0 plan\n\n${body}`;
    vecs.set(chunkEmbedInput, unitVec(42));
    vecs.set("게이트 몇 개", unitVec(42));
    const embed = createStubClient(vecs);
    await runBackfill(handle, embed, { batchSize: 4 });

    const answer = createStubAnswerClient([
      { match: /./, text: "three gates [[doc-phase0]]" },
    ]);
    const res = await ask(handle, embed, answer, "게이트 몇 개");
    expect(res.empty).toBe(false);
    const req = answer.lastRequest();
    expect(req).not.toBeNull();
    // Counting-query prompt must include the enumerated body lines so
    // the LLM can actually count.
    expect(req!.user).toContain("Interview gate");
    expect(req!.user).toContain("Install gate");
    expect(req!.user).toContain("Retention gate");
  });
});
