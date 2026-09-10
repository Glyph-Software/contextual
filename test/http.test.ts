import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../src/mcp/http';
import { db, closeDb, migrate, resetSettingsCache } from '../src/core/db';
import { ingest } from '../src/core/ingest/pipeline';
import { databaseAvailable, schemaUrl } from './helpers';

const hasDb = await databaseAvailable();
const testDb = hasDb ? test : test.skip;
const schema = `contextual_http_${process.pid}`;
const savedEnv = { ...process.env };
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'http-test', version: '1' },
};
let endpoint: ReturnType<typeof startHttpServer>;
let work: string;
const tools = ['cx_glob', 'cx_grep', 'cx_ls', 'cx_read', 'cx_search', 'cx_skill'];

function post(url: string, method: string, params: object = {}, modern = true, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(modern ? {
      'Mcp-Method': method, 'MCP-Protocol-Version': '2026-07-28',
      ...('name' in params ? { 'Mcp-Name': String(params.name) } : {}),
      ...('uri' in params ? { 'Mcp-Name': String(params.uri) } : {}),
    } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...(modern ? { _meta: meta } : {}) } }),
  });
}

async function reply(response: Response) {
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))).find((message) => message.id === 1)
    : JSON.parse(text);
  expect(data.error).toBeUndefined();
  return data.result;
}

beforeAll(async () => {
  delete process.env.CONTEXTUAL_HTTP_TOKEN;
  delete process.env.CONTEXTUAL_HTTP_ALLOWED_HOSTS;
  process.env.VOYAGE_API_KEY = '';
  process.env.CONTEXTUAL_VOYAGE_API_KEY = '';
  if (hasDb) {
    await closeDb();
    resetSettingsCache();
    process.env.CONTEXTUAL_DATABASE_URL = schemaUrl(schema);
    await db().unsafe(`CREATE SCHEMA ${schema}`);
    await migrate();
    work = await mkdtemp(join(tmpdir(), 'contextual-http-'));
    await writeFile(join(work, 'guide.md'), '# Support\n\nThe support queue is reviewed every weekday at 09:00 UTC.');
    const result = await ingest(join(work, 'guide.md'), { collection: 'demo', blobDir: join(work, 'blobs') });
    expect(result[0]?.status).toBe('ingested');
  }
  endpoint = startHttpServer({ port: 0 });
});

afterAll(async () => {
  await endpoint?.close();
  if (hasDb) {
    await db().unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await rm(work, { recursive: true, force: true });
  }
  await closeDb();
  resetSettingsCache();
  for (const key of ['CONTEXTUAL_DATABASE_URL', 'CONTEXTUAL_HTTP_TOKEN', 'CONTEXTUAL_HTTP_ALLOWED_HOSTS', 'VOYAGE_API_KEY', 'CONTEXTUAL_VOYAGE_API_KEY']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Streamable HTTP', () => {
  test('modern discovery and concurrent tool lists work without an initialize handshake', async () => {
    const discovery = await reply(await post(endpoint.url, 'server/discover'));
    expect(discovery._meta['io.modelcontextprotocol/serverInfo'].name).toBe('contextual');
    const results = await Promise.all(Array.from({ length: 8 }, async () => reply(await post(endpoint.url, 'tools/list'))));
    for (const result of results) expect(result.tools.map((t: any) => t.name).sort()).toEqual(tools);
  });

  test('legacy clients initialize and call tools statelessly over SSE', async () => {
    const response = await post(endpoint.url, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' },
    }, false);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const init = await reply(response);
    expect(init.serverInfo.name).toBe('contextual');
    expect(init.capabilities.resources.subscribe).toBe(false);
    const listed = await post(endpoint.url, 'tools/list', {}, false);
    expect(listed.headers.get('content-type')).toContain('text/event-stream');
    expect((await reply(listed)).tools.map((t: any) => t.name).sort()).toEqual(tools);
    const notification = await fetch(endpoint.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notification.status).toBe(202);
    expect((await fetch(endpoint.url, { method: 'GET' })).status).toBe(405);
    expect((await fetch(endpoint.url, { method: 'DELETE' })).status).toBe(405);
  });

  test('routes only /mcp and rejects invalid media types', async () => {
    expect((await fetch(new URL('/other', endpoint.url))).status).toBe(404);
    expect((await post(endpoint.url, 'tools/list', {}, true, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  test('checks Host and Origin before serving MCP', async () => {
    expect((await post(endpoint.url, 'tools/list', {}, true, { host: 'untrusted.example' })).status).toBe(403);
    for (const origin of ['https://untrusted.example', 'null']) {
      expect((await post(endpoint.url, 'tools/list', {}, true, { origin })).status).toBe(403);
    }
    expect((await post(endpoint.url, 'tools/list', {}, true, { origin: new URL(endpoint.url).origin })).status).toBe(200);
  });

  test('enforces bearer tokens on both protocol eras and on subscription requests', async () => {
    const protectedServer = startHttpServer({ port: 0, token: 'http-test-token' });
    try {
      for (const modern of [true, false]) {
        for (const authorization of ['', 'Bearer wrong-token']) {
          const response = await post(protectedServer.url, 'tools/list', {}, modern, { authorization });
          expect(response.status).toBe(401);
          expect(response.headers.get('www-authenticate')).toContain('Bearer');
        }
        expect((await post(protectedServer.url, 'tools/list', {}, modern, { authorization: 'Bearer http-test-token' })).status).toBe(200);
      }
      expect((await post(protectedServer.url, 'subscriptions/listen', { notifications: { resourcesListChanged: true } })).status).toBe(401);
    } finally { await protectedServer.close(); }
  });

  test('rejects incomplete network binding configuration before listening', () => {
    expect(() => startHttpServer({ host: '0.0.0.0', port: 0 })).toThrow('CONTEXTUAL_HTTP_TOKEN');
    expect(() => startHttpServer({ host: '0.0.0.0', port: 0, token: 'test-token' })).toThrow('CONTEXTUAL_HTTP_ALLOWED_HOSTS');
    expect(() => startHttpServer({ port: 0, token: '' })).toThrow('CONTEXTUAL_HTTP_TOKEN');
    expect(() => startHttpServer({ port: 0, allowedHosts: ['localhost:3000'] })).toThrow('without ports');
  });

  testDb('search, chunk reads, and MCP resource reads return stored content in both eras', async () => {
    for (const modern of [true, false]) {
      const search = await reply(await post(endpoint.url, 'tools/call', {
        name: 'cx_search', arguments: { queries: ['support queue'], scope: 'docs/demo' },
      }, modern));
      expect(search.isError).not.toBe(true);
      const uri = search.content.find((item: any) => item.type === 'resource_link')?.uri;
      expect(uri).toContain('ctx://docs/demo/guide.md#chunk=');
      const read = await reply(await post(endpoint.url, 'tools/call', { name: 'cx_read', arguments: { uri } }, modern));
      expect(JSON.stringify(read.content)).toContain('09:00 UTC');
      const resource = await reply(await post(endpoint.url, 'resources/read', { uri: 'ctx://docs/demo/guide.md' }, modern));
      expect(resource.contents[0].text).toContain('09:00 UTC');
    }
  });

  testDb('modern SSE subscribers receive upload changes across concurrent HTTP requests', async () => {
    const abort = new AbortController();
    const response = await fetch(endpoint.url, {
      method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Mcp-Method': 'subscriptions/listen', 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: {
        _meta: meta, notifications: { resourcesListChanged: true, resourceSubscriptions: ['ctx://index'] },
      } }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const timeout = setTimeout(() => abort.abort(), 6000);
    try {
      const first = await reader.read();
      received += decoder.decode(first.value);
      await Promise.all(Array.from({ length: 5 }, async () => reply(await post(endpoint.url, 'tools/list'))));
      // Allow the initial database revision read to finish before changing it.
      await Bun.sleep(200);
      const upload = new FormData();
      upload.append('files', new File(['# Support\n\nThe support queue is reviewed at 10:00 UTC.'], 'guide.md'));
      upload.append('collection', 'demo');
      const ingested = await fetch(new URL('/api/ingest', endpoint.url), { method: 'POST', body: upload });
      expect(ingested.status).toBe(200);
      while (!received.includes('notifications/resources/updated')) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      expect(received).toContain('notifications/resources/list_changed');
      expect(received).toContain('notifications/resources/updated');
      expect(received).toContain('ctx://index');
      expect(received).not.toContain('ctx://docs/demo/guide.md');
    } finally { clearTimeout(timeout); abort.abort(); await reader.cancel().catch(() => {}); }
  }, 10000);

  test('closing the HTTP handle releases the listening socket', async () => {
    const temporary = startHttpServer({ port: 0 });
    await reply(await post(temporary.url, 'tools/list'));
    await temporary.close();
    await temporary.close();
    await expect(fetch(temporary.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });
});
