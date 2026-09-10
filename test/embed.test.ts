/**
 * The Voyage client, exercised against a fake `fetch`. What matters here is
 * request shape and failure classification — the network is not the subject.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { VoyageEmbedder, EmbeddingError, planBatches, MAX_BATCH, MAX_BATCH_TOKENS } from '../src/core/ingest/embed';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Call = { body: any };
function fakeFetch(handler: (call: Call) => { status: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const call = { body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const r = handler(call);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return calls;
}

const okVectors = (n: number) => ({ status: 200, json: { data: Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: Array(1024).fill(i) })) } });

describe('planBatches', () => {
  test('splits by count', () => {
    const batches = planBatches(Array.from({ length: MAX_BATCH * 2 + 1 }, () => 'x'));
    expect(batches.map((b) => b.length)).toEqual([MAX_BATCH, MAX_BATCH, 1]);
    expect(batches.flat()).toEqual(Array.from({ length: MAX_BATCH * 2 + 1 }, (_, i) => i));
  });

  test('splits by estimated tokens so oversize inputs cannot blow the request ceiling', () => {
    // Each input is ~32k tokens by the conservative estimate; a batch of 96
    // of them would be ~3M tokens against a 320k limit.
    const big = 'x'.repeat(32_000 * 3);
    const batches = planBatches(Array.from({ length: 10 }, () => big));
    for (const b of batches) expect(b.length * 32_000).toBeLessThanOrEqual(MAX_BATCH_TOKENS);
    expect(batches.flat()).toHaveLength(10);
  });

  test('an empty list yields no batches', () => {
    expect(planBatches([])).toEqual([]);
  });
});

describe('VoyageEmbedder', () => {
  test('asks Voyage to truncate over-length inputs and preserves order', async () => {
    const calls = fakeFetch(({ body }) => okVectors(body.input.length));
    const out = await new VoyageEmbedder('k', 'voyage-3.5').embed(['a', 'b', 'c'], 'document');
    expect(calls[0]!.body.truncation).toBe(true);
    expect(calls[0]!.body.input_type).toBe('document');
    expect(calls[0]!.body.output_dimension).toBe(1024);
    // The response arrived out of order; the client sorts by index.
    expect(out.map((v) => v[0])).toEqual([2, 1, 0]);
  });

  test('a 4xx is an input failure and is not retried', async () => {
    const calls = fakeFetch(() => ({ status: 400, text: '{"detail":"too long"}' }));
    const err = await new VoyageEmbedder('k', 'voyage-4', { sleep: async () => {} }).embed(['x'], 'document').catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).failure).toBe('input');
    expect(calls).toHaveLength(1);
  });

  test('a 401 is an auth failure', async () => {
    fakeFetch(() => ({ status: 401, text: 'nope' }));
    const err = await new VoyageEmbedder('k', 'voyage-4', { sleep: async () => {} }).embed(['x'], 'document').catch((e) => e);
    expect((err as EmbeddingError).failure).toBe('auth');
  });

  test('a 5xx is retried and then reported as transient', async () => {
    const calls = fakeFetch(() => ({ status: 503, text: 'busy' }));
    const err = await new VoyageEmbedder('k', 'voyage-4', { sleep: async () => {} }).embed(['x'], 'document').catch((e) => e);
    expect((err as EmbeddingError).failure).toBe('transient');
    expect(calls.length).toBeGreaterThan(1);
  }, 10_000);
});
