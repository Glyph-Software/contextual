/**
 * Embeddings, behind an interface so the model is swappable and so the whole
 * system still works without one.
 *
 * Default is Voyage `voyage-4` at 1024 dimensions — 32K context and
 * Matryoshka-truncatable, so the same vectors can be shortened later without
 * re-embedding the corpus. `CONTEXTUAL_EMBED_MODEL` overrides the model id;
 * the corpus pins whichever model first embedded it (pipeline.ts), and a
 * mismatch is a loud error rather than a mixed vector space.
 *
 * Ollama is an opt-in local provider, defaulting to qwen3-embedding:0.6b.
 * Without a local provider or Voyage key, retrieval is full-text only.
 * Skills need no embeddings at all, so a user can run the whole skill path with
 * zero credentials.
 */
import { embedProvider, envNumber } from '../config';
import { EmbeddingError, voyageRequest, type RequestOptions } from './voyage';

export const EMBED_DIMS = 1024;

export interface Embedder {
  readonly id: string;
  readonly dims: number;
  /** `query` and `document` are embedded asymmetrically by design. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

/**
 * Why an embedding call failed, so the caller can decide what to do with the
 * *batch*: a bad input is isolated and skipped, a transient failure is retried
 * later, a bad key is reported once.
 */
export { EmbeddingError, type EmbeddingFailure } from './voyage';

/** Voyage's per-request ceiling on list length. */
export const MAX_BATCH = 96;
/**
 * Voyage allows 320k tokens per request and 32k per input. Batches are cut
 * well under that on a conservative 3-chars-per-token estimate, so a run of
 * oversize chunks (an atomic table, a long code fence) cannot 4xx the batch.
 */
export const MAX_BATCH_TOKENS = 120_000;
const MAX_INPUT_TOKENS = 32_000;

const conservativeTokens = (text: string) => Math.min(MAX_INPUT_TOKENS, Math.ceil(text.length / 3));

/**
 * Splits `texts` into request-sized batches by count *and* estimated tokens.
 * Order is preserved and every text lands in exactly one batch.
 */
export function planBatches(texts: string[], maxItems = MAX_BATCH, maxTokens = MAX_BATCH_TOKENS): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let tokens = 0;
  texts.forEach((t, i) => {
    const cost = conservativeTokens(t);
    if (current.length && (current.length >= maxItems || tokens + cost > maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(i);
    tokens += cost;
  });
  if (current.length) batches.push(current);
  return batches;
}

export class VoyageEmbedder implements Embedder {
  readonly id: string;
  readonly dims = EMBED_DIMS;

  constructor(private apiKey: string, private model = process.env.CONTEXTUAL_EMBED_MODEL ?? 'voyage-4', private requests: RequestOptions = {}) {
    this.id = this.model;
  }

  async embed(texts: string[], kind: 'document' | 'query' = 'document'): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    for (const batch of planBatches(texts)) {
      const vectors = await this.batch(batch.map((i) => texts[i]!), kind);
      batch.forEach((i, j) => { out[i] = vectors[j]!; });
    }
    return out;
  }

  private async batch(input: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const body = await voyageRequest('embeddings', {
      model: this.model, input, input_type: kind, output_dimension: this.dims, truncation: true,
    }, this.apiKey, this.requests);
    if (!Array.isArray(body.data) || body.data.length !== input.length) throw new Error('Voyage returned an incomplete embedding batch');
    const rows = body.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index);
    if (rows.some((r: { index: number; embedding: number[] }, i: number) => r.index !== i || !Array.isArray(r.embedding) || r.embedding.length !== this.dims || r.embedding.some((v: number) => !Number.isFinite(v)))) throw new Error('Voyage returned invalid embedding dimensions or values');
    return rows.map((r: { embedding: number[] }) => r.embedding);
  }
}

/** Local embeddings via Ollama's /api/embed endpoint; no Voyage key is used. */
export class OllamaEmbedder implements Embedder {
  readonly id: string;
  readonly dims = EMBED_DIMS;
  private endpoint: URL;

  constructor(
    private model = process.env.CONTEXTUAL_EMBED_MODEL ?? 'qwen3-embedding:0.6b',
    baseUrl = process.env.CONTEXTUAL_OLLAMA_URL ?? 'http://127.0.0.1:11434',
  ) {
    if (!model.trim()) throw new Error('CONTEXTUAL_EMBED_MODEL must not be empty');
    let url: URL;
    try { url = new URL(baseUrl); }
    catch { throw new Error('CONTEXTUAL_OLLAMA_URL must be an HTTP(S) base URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('CONTEXTUAL_OLLAMA_URL must be an HTTP(S) base URL without credentials, query, or fragment');
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/embed`;
    this.endpoint = url;
    // Equal dimensions do not make vectors from different providers compatible.
    this.id = `ollama:${model}`;
  }

  async embed(texts: string[], kind: 'document' | 'query' = 'document'): Promise<number[][]> {
    const out: number[][] = [];
    const input = texts.map((text) => kind === 'query' && this.model.split(':')[0] === 'qwen3-embedding'
      ? `Instruct: Retrieve relevant passages that answer the query.\nQuery: ${text}` : text);
    // Small sequential batches keep local inference memory and load bounded.
    for (const batch of planBatches(input, 8, 16000)) {
      let response: Response;
      let body: any;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: batch.map((i) => input[i]!), dimensions: this.dims, truncate: true }),
          signal: AbortSignal.timeout(envNumber('CONTEXTUAL_OLLAMA_TIMEOUT_MS')),
        });
        if (response.ok) body = await response.json();
        else await response.body?.cancel();
      } catch {
        throw new EmbeddingError('transient', 'Ollama request failed or timed out. Check that Ollama is running and CONTEXTUAL_OLLAMA_URL is correct.');
      }
      // Do not classify missing models or bad configuration as bad documents:
      // ingestion would otherwise retry every chunk and silently skip them.
      if (response.status === 404) throw new Error(`Ollama model or endpoint not found. Run \`ollama pull ${this.model}\` and check CONTEXTUAL_OLLAMA_URL.`);
      if (response.status === 401 || response.status === 403) throw new EmbeddingError('auth', `Ollama returned HTTP ${response.status}`);
      if (response.status === 429 || response.status >= 500) throw new EmbeddingError('transient', `Ollama returned HTTP ${response.status}; retry when the service is available.`);
      if (!response.ok) throw new Error(`Ollama rejected the embedding request (HTTP ${response.status}). Check the model and Ollama server logs.`);
      const vectors = body?.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== batch.length || vectors.some((v: unknown) =>
        !Array.isArray(v) || v.length !== this.dims || v.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)) || !v.some((n: number) => n !== 0))) {
        throw new Error(`Ollama must return one nonzero ${this.dims}-dimensional vector per input. Use a compatible embedding model such as qwen3-embedding:0.6b.`);
      }
      out.push(...vectors);
    }
    return out;
  }
}

let cached: Embedder | null | undefined;

export function getEmbedder(): Embedder | null {
  if (cached !== undefined) return cached;
  const provider = embedProvider();
  if (provider === 'none') return cached = null;
  if (provider === 'ollama') return cached = new OllamaEmbedder();
  const key = process.env.VOYAGE_API_KEY ?? process.env.CONTEXTUAL_VOYAGE_API_KEY;
  cached = key ? new VoyageEmbedder(key) : null;
  return cached;
}

/** Tests inject an embedder; undefined resets lazy environment selection. */
export function setEmbedder(e: Embedder | null | undefined): void {
  cached = e;
}
