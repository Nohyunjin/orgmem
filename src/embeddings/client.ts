import { EMBEDDING_DIM, EMBEDDING_MODEL } from "./model.ts";

export interface EmbedClient {
  embed(inputs: readonly string[]): Promise<Float32Array[]>;
}

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Backoff tuning. Exposed mostly for tests — production defaults should be fine. */
  backoff?: {
    initialMs?: number; // default 1000
    maxMs?: number; // default 60000
    maxRetries?: number; // default 6
    jitter?: boolean; // default true
    /** Test seam for sleep; defaults to setTimeout-based. */
    sleepImpl?: (ms: number) => Promise<void>;
  };
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/**
 * Minimal OpenAI embeddings client. Uses native fetch, retries 429 / 5xx
 * with exponential backoff + jitter, and honors the Retry-After header
 * when present. Deliberately does NOT bring in the @openai/* SDK — the
 * surface is tiny and the SDK's transitive deps are heavier than we need.
 */
export function createOpenAIClient(cfg: OpenAIConfig): EmbedClient {
  const endpoint = cfg.endpoint ?? "https://api.openai.com/v1/embeddings";
  const model = cfg.model ?? EMBEDDING_MODEL;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const initialMs = cfg.backoff?.initialMs ?? 1000;
  const maxMs = cfg.backoff?.maxMs ?? 60_000;
  const maxRetries = cfg.backoff?.maxRetries ?? 6;
  const jitter = cfg.backoff?.jitter ?? true;
  const sleep = cfg.backoff?.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function once(inputs: readonly string[]): Promise<Response> {
    return fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model, input: inputs }),
    });
  }

  async function embed(inputs: readonly string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    let attempt = 0;
    let delay = initialMs;
    for (;;) {
      const res = await once(inputs);
      if (res.ok) {
        const body = (await res.json()) as OpenAIEmbeddingResponse;
        // OpenAI does not guarantee order in older versions; sort by index.
        const sorted = [...body.data].sort((a, b) => a.index - b.index);
        return sorted.map((d) => {
          if (d.embedding.length !== EMBEDDING_DIM) {
            throw new Error(
              `OpenAI returned embedding of dim ${d.embedding.length}; expected ${EMBEDDING_DIM}`,
            );
          }
          return Float32Array.from(d.embedding);
        });
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(
          `OpenAI embeddings HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
        );
      }

      // Respect Retry-After if present; otherwise apply exponential backoff.
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
      const wait = retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : delay;
      const withJitter = jitter ? wait * (0.5 + Math.random() * 0.5) : wait;
      await sleep(Math.min(maxMs, Math.round(withJitter)));
      delay = Math.min(maxMs, delay * 2);
      attempt += 1;
    }
  }

  return { embed };
}

/** No-op client for environments where embeddings are disabled / tests. */
export function createStubClient(vectors: Map<string, Float32Array>): EmbedClient {
  return {
    async embed(inputs) {
      return inputs.map((input) => {
        const v = vectors.get(input);
        if (!v) throw new Error(`stub client: no vector configured for input: ${input.slice(0, 64)}`);
        if (v.length !== EMBEDDING_DIM) {
          throw new Error(`stub vector dim ${v.length} != ${EMBEDDING_DIM}`);
        }
        return v;
      });
    },
  };
}
