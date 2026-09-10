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
 * With no API key configured, `getEmbedder()` returns null and retrieval
 * degrades to full-text only rather than failing. That matters: skills need no
 * embeddings at all, so a user should be able to run the whole skill path with
 * zero credentials.
 */
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
import { voyageRequest, type RequestOptions } from './voyage';

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

let cached: Embedder | null | undefined;

export function getEmbedder(): Embedder | null {
  if (cached !== undefined) return cached;
  const key = process.env.VOYAGE_API_KEY ?? process.env.CONTEXTUAL_VOYAGE_API_KEY;
  cached = key ? new VoyageEmbedder(key) : null;
  return cached;
}

/** Tests inject a deterministic embedder rather than calling the network. */
export function setEmbedder(e: Embedder | null): void {
  cached = e;
}
