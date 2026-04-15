/**
 * Anthropic Messages API client for `kg ask`. Mirrors the shape of
 * `EmbedClient`: a tiny interface and two implementations (real + stub) so
 * the pipeline can be tested without network.
 *
 * Deliberately does NOT depend on @anthropic-ai/sdk — the request surface
 * is one POST, the SDK's transitive deps are heavier than we need, and we
 * already run a fetch-based client for embeddings.
 */

export interface AnswerUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AnswerResponse {
  text: string;
  usage: AnswerUsage;
  stopReason?: string;
}

export interface AnswerRequest {
  system: string;
  user: string;
  /** Optional per-request override of max_tokens. Default 1024. */
  maxTokens?: number;
}

export interface AnswerClient {
  complete(req: AnswerRequest): Promise<AnswerResponse>;
}

/** Default model for `kg ask`. Haiku 4.5 — cheap + fast, sufficient for
 *  grounded-QA over a small context. Override via config or env. */
export const DEFAULT_ANSWER_MODEL = "claude-haiku-4-5-20251001";

export interface AnthropicConfig {
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

export function createAnthropicClient(cfg: AnthropicConfig): AnswerClient {
  const endpoint = cfg.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = cfg.model ?? DEFAULT_ANSWER_MODEL;
  const anthropicVersion = cfg.anthropicVersion ?? "2023-06-01";
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const initialMs = cfg.backoff?.initialMs ?? 1000;
  const maxMs = cfg.backoff?.maxMs ?? 60_000;
  const maxRetries = cfg.backoff?.maxRetries ?? 4;
  const jitter = cfg.backoff?.jitter ?? true;
  const sleep =
    cfg.backoff?.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function once(req: AnswerRequest): Promise<Response> {
    return fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });
  }

  async function complete(req: AnswerRequest): Promise<AnswerResponse> {
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
 * Stub for tests. Keyed by an arbitrary substring of the user prompt —
 * first matching entry wins. Rejects (instead of returning empty) when
 * nothing matches so tests that forget to wire a response fail loud.
 */
export function createStubAnswerClient(
  responses: Array<{ match: string | RegExp; text: string; usage?: AnswerUsage }>,
): AnswerClient & { callCount: () => number; lastRequest: () => AnswerRequest | null } {
  let calls = 0;
  let last: AnswerRequest | null = null;
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
        `stub answer client: no response configured matching user prompt (len=${req.user.length}). ` +
          `First 200 chars: ${req.user.slice(0, 200)}`,
      );
    },
    callCount: () => calls,
    lastRequest: () => last,
  };
}
