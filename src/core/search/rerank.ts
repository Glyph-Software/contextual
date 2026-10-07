import { EmbeddingError, voyageRequest } from '../ingest/voyage';
import { voyageKey } from '../config';
import type { RetrievalWarning } from './diagnostics';

export type RerankResult = { order: number[] | null; warning?: RetrievalWarning };
/** Explicit opt-in: reranking sends candidate passages as well as the query. */
export async function rerank(query: string, documents: string[]): Promise<RerankResult> {
  if (process.env.CONTEXTUAL_RERANK !== 'true') return { order: null };
  const key = voyageKey();
  if (!key) return { order: null, warning: {
    code: 'RERANK_UNAVAILABLE', message: 'Reranking is enabled but no Voyage key is configured; using the original ranking.', retryable: false,
    suggested_action: 'Configure the reranker credentials or set CONTEXTUAL_RERANK=false.',
  } };
  if (!documents.length) return { order: null };
  try {
    const result = await voyageRequest('rerank', { model: process.env.CONTEXTUAL_RERANK_MODEL ?? 'rerank-2.5-lite', query, documents, top_k: documents.length }, key);
    const order = result.data?.map((r: { index: number }) => r.index);
    if (!Array.isArray(order) || order.length !== documents.length || new Set(order).size !== order.length || order.some((i: number) => !Number.isInteger(i) || i < 0 || i >= documents.length)) throw new Error('invalid Voyage rerank result');
    return { order };
  } catch (err) {
    return { order: null, warning: {
      code: 'RERANK_UNAVAILABLE', message: 'Reranking failed; using the original retrieval ranking.', retryable: err instanceof EmbeddingError && err.failure === 'transient',
      suggested_action: 'Retry later, or check the reranker configuration and credentials.',
    } };
  }
}
