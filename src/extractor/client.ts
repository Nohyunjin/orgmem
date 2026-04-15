/**
 * ExtractorClient — Anthropic Messages wrapper for Lane C's Decision Extractor.
 *
 * Deliberately separate from `src/answer/client.ts` (`AnswerClient`):
 *   - Answer path is tuned for the grounded-QA prompt shape ([[node-id]]
 *     citation contract). Its defaults and contract leak that context.
 *   - Extractor needs strict temperature=0 for classify/extract reproducibility.
 *   - Keeps the eval harness decoupled from answer-path prompt evolution so
 *     regression runs stay apples-to-apples.
 *
 * Like `AnswerClient`, this uses plain `fetch` — no `@anthropic-ai/sdk`.
 */

export interface ExtractorUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ExtractorResponse {
  text: string;
  usage: ExtractorUsage;
  stopReason?: string;
}

export interface ExtractorRequest {
  system: string;
  user: string;
  /** Defaults to 0 (classify + extract both want reproducibility). */
  temperature?: number;
  /** Default: 2000. Classify callers pass 200. */
  maxTokens?: number;
}

export interface ExtractorClient {
  complete(req: ExtractorRequest): Promise<ExtractorResponse>;
}

/** Locked eval baseline model. Override via env or config when experimenting. */
export const DEFAULT_EXTRACTOR_MODEL = "claude-haiku-4-5-20251001";

export interface ExtractorClientConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  anthropicVersion?: string;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  backoff?: {
    initialMs?: number;
    maxMs?: number;
    maxRetries?: number;
    jitter?: boolean;
    sleepImpl?: (ms: number) => Promise<void>;
  };
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createExtractorClient(cfg: ExtractorClientConfig): ExtractorClient {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? DEFAULT_EXTRACTOR_MODEL;
  const anthropicVersion = cfg.anthropicVersion ?? "2023-06-01";
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const initialMs = cfg.backoff?.initialMs ?? 1000;
  const maxMs = cfg.backoff?.maxMs ?? 60_000;
  const maxRetries = cfg.backoff?.maxRetries ?? 4;
  const jitter = cfg.backoff?.jitter ?? true;
  const sleep =
    cfg.backoff?.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function once(req: ExtractorRequest): Promise<Response> {
    return fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 2000,
        temperature: req.temperature ?? 0,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });
  }

  async function complete(req: ExtractorRequest): Promise<ExtractorResponse> {
    let attempt = 0;
    let delay = initialMs;
    for (;;) {
      const res = await once(req);
      if (res.ok) {
        const body = (await res.json()) as AnthropicMessagesResponse;
        const text = (body.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");
        return {
          text,
          stopReason: body.stop_reason,
          usage: {
            inputTokens: body.usage?.input_tokens,
            outputTokens: body.usage?.output_tokens,
          },
        };
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(
          `Anthropic messages HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
        );
      }
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
      const wait = retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : delay;
      const withJitter = jitter ? wait * (0.5 + Math.random() * 0.5) : wait;
      await sleep(Math.min(maxMs, Math.round(withJitter)));
      delay = Math.min(maxMs, delay * 2);
      attempt += 1;
    }
  }

  return { complete };
}

/**
 * Strip accidental ```json fences and parse. If the first parse throws,
 * try once more on the first `{...}` balanced block we can find — LLMs
 * occasionally include a trailing note despite "STRICT JSON only".
 * Callers should treat a thrown error as a hard failure.
 */
export function parseExtractorJson<T>(raw: string): T {
  let cleaned = raw.trim();
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) cleaned = fence[1].trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (primary) {
    // Salvage: find the largest balanced {...} block.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(slice) as T;
      } catch {
        // fall through
      }
    }
    throw new Error(
      `Extractor JSON parse failed: ${(primary as Error).message}. Raw (first 200 chars): ${cleaned.slice(0, 200)}`,
    );
  }
}

/**
 * Stub for tests. Keyed by a substring of `user` (first match wins).
 * Throws on unmatched calls — tests that forget to wire a response fail loud.
 */
export function createStubExtractorClient(
  responses: Array<{ match: string | RegExp; text: string; usage?: ExtractorUsage }>,
): ExtractorClient & { callCount: () => number; lastRequest: () => ExtractorRequest | null } {
  let calls = 0;
  let last: ExtractorRequest | null = null;
  return {
    async complete(req) {
      calls += 1;
      last = req;
      for (const r of responses) {
        const hit =
          typeof r.match === "string" ? req.user.includes(r.match) : r.match.test(req.user);
        if (hit) {
          return { text: r.text, usage: r.usage ?? {}, stopReason: "end_turn" };
        }
      }
      throw new Error(
        `stub extractor client: no response configured matching user prompt (len=${req.user.length}). ` +
          `First 200 chars: ${req.user.slice(0, 200)}`,
      );
    },
    callCount: () => calls,
    lastRequest: () => last,
  };
}
