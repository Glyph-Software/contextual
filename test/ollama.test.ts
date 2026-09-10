import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaEmbedder, VoyageEmbedder, EmbeddingError, getEmbedder, setEmbedder } from '../src/core/ingest/embed';
import { validateConfig } from '../src/core/config';
import { db, closeDb, migrate, resetSettingsCache } from '../src/core/db';
import { ingest, embedMissing } from '../src/core/ingest/pipeline';
import { search, resetEmbedModelCache } from '../src/core/search/hybrid';
import { databaseAvailable, schemaUrl } from './helpers';

const hasDb = await databaseAvailable();
const realFetch = globalThis.fetch;
const keys = ['CONTEXTUAL_EMBED_PROVIDER', 'CONTEXTUAL_EMBED_MODEL', 'CONTEXTUAL_OLLAMA_URL', 'CONTEXTUAL_OLLAMA_TIMEOUT_MS', 'VOYAGE_API_KEY', 'CONTEXTUAL_VOYAGE_API_KEY', 'CONTEXTUAL_DATABASE_URL', 'CONTEXTUAL_RERANK'] as const;
const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  setEmbedder(undefined);
  for (const key of keys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

type Call = { url: string; body: any; headers: Headers };
function mockOllama(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return calls;
}
const vector = (n = 1) => [n, ...Array(1023).fill(0)];
const validReply = ({ body }: Call) => Response.json({ embeddings: body.input.map(() => vector()) });

describe('local embedding provider', () => {
  test('Ollama is explicit and takes precedence over a configured Voyage key', () => {
    setEmbedder(undefined);
    delete process.env.CONTEXTUAL_EMBED_PROVIDER;
    delete process.env.CONTEXTUAL_EMBED_MODEL;
    delete process.env.CONTEXTUAL_OLLAMA_URL;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.CONTEXTUAL_VOYAGE_API_KEY;
    expect(getEmbedder()).toBeNull();
    setEmbedder(undefined);
    process.env.VOYAGE_API_KEY = 'test-unused-key';
    expect(getEmbedder()).toBeInstanceOf(VoyageEmbedder);
    setEmbedder(undefined);
    process.env.CONTEXTUAL_EMBED_PROVIDER = 'ollama';
    expect(getEmbedder()).toBeInstanceOf(OllamaEmbedder);
    expect(getEmbedder()!.id).toBe('ollama:qwen3-embedding:0.6b');
    setEmbedder(undefined);
    process.env.CONTEXTUAL_EMBED_PROVIDER = 'none';
    expect(getEmbedder()).toBeNull();
  });

  test('configuration errors fail explicitly', () => {
    process.env.CONTEXTUAL_EMBED_PROVIDER = 'olama';
    expect(validateConfig).toThrow('CONTEXTUAL_EMBED_PROVIDER');
    for (const url of ['invalid', 'file:///tmp/model', 'http://user:password@localhost', 'http://localhost?token=secret']) {
      expect(() => new OllamaEmbedder('qwen3-embedding:0.6b', url)).toThrow('CONTEXTUAL_OLLAMA_URL');
    }
  });

  test('uses small ordered batches and never sends a Voyage credential', async () => {
    const calls = mockOllama(({ body }) => Response.json({ embeddings: body.input.map((n: string) => vector(Number(n) + 1)) }));
    const model = new OllamaEmbedder('qwen3-embedding:0.6b', 'http://127.0.0.1:11434/');
    const result = await model.embed(Array.from({ length: 17 }, (_, i) => String(i)));
    expect(result.map((v) => v[0])).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(calls.map((c) => c.body.input.length)).toEqual([8, 8, 1]);
    for (const c of calls) {
      expect(c.url).toBe('http://127.0.0.1:11434/api/embed');
      expect(c.body.dimensions).toBe(1024);
      expect(c.body.truncate).toBe(true);
      expect(c.headers.has('authorization')).toBe(false);
    }
  });

  test('applies the Qwen retrieval instruction only to queries', async () => {
    const calls = mockOllama(validReply);
    const model = new OllamaEmbedder('qwen3-embedding:0.6b');
    await model.embed(['moon landing'], 'query');
    await model.embed(['moon landing'], 'document');
    expect(calls[0]!.body.input[0]).toStartWith('Instruct:');
    expect(calls[0]!.body.input[0]).toEndWith('\nQuery: moon landing');
    expect(calls[1]!.body.input).toEqual(['moon landing']);
    await new OllamaEmbedder('custom-1024').embed(['moon landing'], 'query');
    expect(calls[2]!.body.input).toEqual(['moon landing']);
  });

  test('empty inputs make no request', async () => {
    const calls = mockOllama(validReply);
    expect(await new OllamaEmbedder().embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('rejects malformed, wrong-dimensional, empty, and nonfinite vectors', async () => {
    for (const embeddings of [undefined, [], [[1, 2]], [Array(1024).fill(0)], [Array(1024).fill('1')], [Array(1024).fill(null)], [vector(), vector()]]) {
      mockOllama(() => Response.json({ embeddings }));
      await expect(new OllamaEmbedder().embed(['x'])).rejects.toThrow('1024-dimensional');
    }
    mockOllama(() => new Response(`{"embeddings":[[1e999,${Array(1023).fill(0).join(',')}]]}`));
    await expect(new OllamaEmbedder().embed(['x'])).rejects.toThrow('1024-dimensional');
  });

  test.each([400, 404, 401, 403, 429, 503])('HTTP %i fails without a cloud fallback or per-document retries', async (status) => {
    const calls = mockOllama(() => new Response('service error', { status }));
    const err = await new OllamaEmbedder().embed(['a', 'b']).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    if (status === 404) expect(err.message).toContain('ollama pull');
    if ([401, 403, 429, 503].includes(status)) {
      expect(err).toBeInstanceOf(EmbeddingError);
      expect(err.failure).toBe(status < 429 ? 'auth' : 'transient');
    } else expect(err.failure).not.toBe('input');
    expect(calls).toHaveLength(1);
  });

  test('an unresponsive local endpoint is bounded by the request timeout', async () => {
    process.env.CONTEXTUAL_OLLAMA_TIMEOUT_MS = '30';
    globalThis.fetch = (async (_url: any, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
    const err = await new OllamaEmbedder().embed(['x']).catch((e) => e);
    expect(err.failure).toBe('transient');
    expect(err.message).toContain('timed out');
  });
});

(hasDb ? test : test.skip)('Ollama ingestion, vector retrieval, model pinning, reindex, and offline fallback', async () => {
  const schema = `contextual_ollama_${process.pid}`;
  const dir = await mkdtemp(join(tmpdir(), 'contextual-ollama-'));
  const received: { model: string; input: string[] }[] = [];
  let requests = 0;
  let available = true;
  const service = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    requests++;
    expect(new URL(req.url).pathname).toBe('/api/embed');
    expect(req.headers.has('authorization')).toBe(false);
    if (!available) return new Response('offline', { status: 503 });
    const body = await req.json() as { model: string; input: string[] };
    received.push(body);
    return Response.json({ embeddings: body.input.map((text) => text.includes('bread')
      ? [0, 1, ...Array(1022).fill(0)] : vector()) });
  } });
  try {
    await closeDb();
    resetSettingsCache();
    resetEmbedModelCache();
    process.env.CONTEXTUAL_DATABASE_URL = schemaUrl(schema);
    process.env.CONTEXTUAL_EMBED_PROVIDER = 'ollama';
    process.env.CONTEXTUAL_EMBED_MODEL = 'qwen3-embedding:0.6b';
    process.env.CONTEXTUAL_OLLAMA_URL = service.url.href;
    process.env.VOYAGE_API_KEY = '';
    process.env.CONTEXTUAL_VOYAGE_API_KEY = '';
    process.env.CONTEXTUAL_RERANK = 'false';
    setEmbedder(undefined);
    await db().unsafe(`CREATE SCHEMA ${schema}`);
    await migrate();
    await Bun.write(join(dir, 'flight.md'), '# Flight\n\nSpacecraft carry astronauts beyond Earth.');
    await Bun.write(join(dir, 'food.md'), '# Food\n\nBake bread with yeast and flour.');
    for (const name of ['flight', 'food']) {
      const result = await ingest(join(dir, `${name}.md`), { collection: 'demo', blobDir: join(dir, 'blobs') });
      expect(result[0]!.embedded).toBeGreaterThan(0);
    }
    // No lexical match: this result must come from the local vector branch.
    const hits = await search(['lunar travel'], { scope: 'docs/demo', maxDistance: 0.5 });
    expect(hits[0]!.path).toBe('/docs/demo/flight.md');
    expect(received.some((r) => r.input.some((s) => s.startsWith('Instruct:')))).toBe(true);
    const changed = new OllamaEmbedder('another-1024-model', service.url.href);
    await expect(embedMissing(changed)).rejects.toThrow('reindex --all');
    const reindexed = await embedMissing(changed, { all: true });
    expect(reindexed.embedded).toBe(reindexed.total);
    expect(reindexed.total).toBeGreaterThan(0);
    setEmbedder(changed);
    resetEmbedModelCache();
    available = false;
    const beforeFallback = requests;
    const fallback = await search(['astronauts'], { scope: 'docs/demo' });
    expect(fallback[0]!.path).toBe('/docs/demo/flight.md');
    expect(requests).toBe(beforeFallback + 1);
  } finally {
    await db().unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closeDb();
    resetSettingsCache();
    resetEmbedModelCache();
    await service.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
