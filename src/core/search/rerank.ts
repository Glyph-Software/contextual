import { voyageRequest } from '../ingest/voyage';
/** Explicit opt-in: reranking sends candidate passages as well as the query. */
export async function rerank(query: string, documents: string[]): Promise<number[] | null> {
  const key = process.env.VOYAGE_API_KEY ?? process.env.CONTEXTUAL_VOYAGE_API_KEY;
  if (process.env.CONTEXTUAL_RERANK !== 'true' || !key || !documents.length) return null;
  const result = await voyageRequest('rerank', { model: process.env.CONTEXTUAL_RERANK_MODEL ?? 'rerank-2.5-lite', query, documents, top_k: documents.length }, key);
  const order = result.data?.map((r: { index: number }) => r.index);
  if (!Array.isArray(order) || order.length !== documents.length || new Set(order).size !== order.length || order.some((i: number) => !Number.isInteger(i) || i < 0 || i >= documents.length)) throw new Error('invalid Voyage rerank result');
  return order;
}
