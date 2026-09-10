import { envNumber } from '../config';

export type EmbeddingFailure = 'input' | 'transient' | 'auth';
export class EmbeddingError extends Error {
  constructor(readonly failure: EmbeddingFailure, message: string) { super(message); }
}
export interface RequestOptions {
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
}
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (value.trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
/** Shared bounded retry/timeout policy for Voyage embedding and rerank calls. */
export async function voyageRequest(endpoint: string, payload: unknown, apiKey: string, opts: RequestOptions = {}): Promise<any> {
  const attempts = envNumber('CONTEXTUAL_VOYAGE_MAX_ATTEMPTS');
  const maxWait = envNumber('CONTEXTUAL_VOYAGE_RETRY_MAX_MS');
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let wait = 0, last = 'unknown error';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let delay = Math.min(30000, 500 * 2 ** attempt) * (1 + (opts.random ?? Math.random)() * 0.25);
    try {
      const response = await fetch(`https://api.voyageai.com/v1/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(envNumber('CONTEXTUAL_VOYAGE_TIMEOUT_MS')),
      });
      if (response.ok) return await response.json();
      last = `voyage ${response.status}: ${(await response.text()).slice(0, 1000)}`;
      if (response.status === 401 || response.status === 403) throw new EmbeddingError('auth', last);
      if (response.status !== 429 && response.status < 500) throw new EmbeddingError('input', last);
      delay = retryAfterMs(response.headers.get('retry-after')) ?? (response.status === 429 ? Math.max(20000, delay) : delay);
    } catch (err) {
      if (err instanceof EmbeddingError && err.failure !== 'transient') throw err;
      last = (err as Error).message;
    }
    if (attempt + 1 >= attempts || wait + delay > maxWait) break;
    await sleep(delay);
    wait += delay;
  }
  throw new EmbeddingError('transient', `Voyage retry budget exhausted: ${last}`);
}
