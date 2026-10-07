import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { databaseAvailable, schemaUrl, BASE_TEST_URL, HashEmbedder } from './helpers';
import { closeDb, db, migrate, resetSettingsCache, setSetting } from '../src/core/db';
import { setEmbedder, EmbeddingError } from '../src/core/ingest/embed';
import { resetEmbedModelCache } from '../src/core/search/hybrid';
import { registerTools } from '../src/mcp/tools';
import { doctor, checkMcp } from '../src/cli/setup';

const schema = `contextual_agent_${process.pid}`;
const handlers = new Map<string, { schema: z.ZodObject<any>; run: (args: any) => Promise<CallToolResult> }>();
registerTools({ registerTool(name: string, spec: any, run: any) {
  handlers.set(name, { schema: z.object(spec.inputSchema), run });
} } as unknown as McpServer);
const call = async (name: string, args: Record<string, unknown>) => {
  const handler = handlers.get(name)!;
  return await handler.run(handler.schema.parse(args));
};
const body = (result: CallToolResult) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const meta = (result: CallToolResult) => result.structuredContent as Record<string, any>;
const longContent = '# Instruction\n' + 'a🙂b'.repeat(40000) + '\nTAIL';
const uri = 'ctx://skills/invoice-helper/SKILL.md';
const describeDb = await databaseAvailable() ? describe : describe.skip;

describeDb('agent workflows', () => {
  beforeAll(async () => {
    await closeDb();
    resetSettingsCache();
    resetEmbedModelCache();
    setEmbedder(null);
    process.env.CONTEXTUAL_DATABASE_URL = schemaUrl(schema);
    await db().unsafe(`CREATE SCHEMA ${schema}`);
    await migrate();
    await db()`INSERT INTO sources(kind,name,content_hash)
      SELECT 'skill', 'catalog-' || lpad(i::text,3,'0'), 'test' FROM generate_series(1,250) i`;
    await db()`INSERT INTO skills(source_id,name,description)
      SELECT id, name, repeat('Catalog entry for a specific task. ',20) FROM sources`;
    await db()`INSERT INTO nodes(source_id,path,uri,role,content)
      SELECT id,'SKILL.md','ctx://skills/' || name || '/SKILL.md','skill_md','MARKER ' || name FROM sources`;
    const [skill] = await db()`INSERT INTO sources(kind,name,content_hash) VALUES ('skill','invoice-helper','test') RETURNING id`;
    await db()`INSERT INTO skills(source_id,name,description) VALUES (${skill.id},'invoice-helper','Extract invoices, reconcile payments and prepare billing reports.')`;
    await db()`INSERT INTO nodes(source_id,path,uri,role,content) VALUES (${skill.id},'SKILL.md',${uri},'skill_md',${longContent})`;
    const [doc] = await db()`INSERT INTO sources(kind,name,collection,content_hash) VALUES ('doc','policy.md','handbook','test') RETURNING id`;
    const [node] = await db()`INSERT INTO nodes(source_id,path,uri,role,content) VALUES (${doc.id},'policy.md','ctx://docs/handbook/policy.md','doc','Refunds are available within thirty days.') RETURNING id`;
    await db()`INSERT INTO chunks(node_id,ord,content) VALUES (${node.id},0,'Refunds are available within thirty days.')`;
  });
  afterAll(async () => {
    await db().unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closeDb();
    resetSettingsCache();
    resetEmbedModelCache();
    setEmbedder(undefined);
    process.env.CONTEXTUAL_DATABASE_URL = BASE_TEST_URL;
  });

  test('long-line MCP reads advance and reconstruct the complete file', async () => {
    let cursor: string | undefined;
    let output = '';
    let calls = 0;
    do {
      const response = await call('cx_read', { uri, cursor });
      expect(response.isError).not.toBe(true);
      const metadata = meta(response);
      expect(metadata.start_character).toBe(output.length);
      const text = body(response);
      const start = text.indexOf('\n---\n') + 5;
      output += text.slice(start, start + metadata.end_character - metadata.start_character);
      cursor = metadata.next_cursor ?? undefined;
      if (cursor) expect(text).toContain(cursor);
      expect(++calls).toBeLessThan(20);
    } while (cursor);
    expect(output).toBe(longContent);
  });

  test('large directory pages retain their continuation and omit no entries', async () => {
    let cursor: string | undefined;
    const names: string[] = [];
    do {
      const response = await call('cx_ls', { path: '/skills', cursor });
      const pageNames = body(response).split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().split('/')[0]!);
      expect(pageNames.length).toBe(meta(response).returned);
      expect(pageNames.length).toBeGreaterThan(0);
      names.push(...pageNames);
      cursor = meta(response).next_cursor ?? undefined;
      if (cursor) {
        expect(body(response)).toContain(cursor);
        expect(meta(response).next_offset).toBe(names.length);
      }
    } while (cursor);
    expect(names).toHaveLength(251);
    expect(new Set(names).size).toBe(251);
    expect(names.at(-1)).toBe('invoice-helper');
  });

  test('glob and grep continue across files with identical relative paths, including beyond 200 files', async () => {
    for (const [tool, args, expected] of [
      ['cx_glob', { pattern: '/skills/catalog-*/SKILL.md', limit: 40 }, 250],
      ['cx_grep', { pattern: 'MARKER', path_glob: '/skills/**', limit: 40 }, 250],
    ] as const) {
      let cursor: string | undefined;
      let count = 0;
      const pages = new Set<string>();
      do {
        const response = await call(tool, { ...args, cursor });
        expect(response.isError).not.toBe(true);
        expect(pages.has(body(response))).toBe(false);
        pages.add(body(response));
        count += meta(response).returned;
        cursor = meta(response).next_cursor ?? undefined;
      } while (cursor);
      expect(count).toBe(expected);
    }
  });

  test('purpose discovery returns metadata and an explicit load action without instructions', async () => {
    const response = await call('cx_search', { queries: ['help reconcile invoice payments'], target: 'skills' });
    expect(meta(response).retrieval_mode).toBe('skill_metadata');
    expect(meta(response).skills[0].next_call).toEqual({ tool: 'cx_skill', arguments: { name: 'invoice-helper' } });
    expect(body(response)).toContain('invoice-helper');
    expect(body(response)).not.toContain('Instruction');
    const absent = await call('cx_search', { queries: ['TAIL'], target: 'skills' });
    expect(meta(absent).returned).toBe(0);
    const loaded = await call('cx_skill', { name: 'invoice-helper' });
    expect(body(loaded)).toContain('# Instruction');
    expect(meta(loaded).next_cursor).toBeString();
  });

  test('full-text and degraded searches explain the actual retrieval mode, including empty results', async () => {
    const normal = await call('cx_search', { queries: ['refund'] });
    expect(meta(normal).retrieval_mode).toBe('full_text');
    expect(meta(normal).returned).toBe(1);
    expect(meta(normal).warnings[0].code).toBe('EMBEDDINGS_DISABLED');
    try {
      setEmbedder({ id: 'failing', dims: 1024, embed: async () => { throw new EmbeddingError('transient', 'private upstream response'); } });
      for (const query of ['refund', 'unfindableword']) {
        const response = await call('cx_search', { queries: [query] });
        expect(meta(response).retrieval_mode).toBe('full_text');
        expect(meta(response).warnings[0]).toMatchObject({ code: 'EMBEDDING_UNAVAILABLE', retryable: true });
        expect(body(response)).not.toContain('private upstream response');
      }
      setEmbedder({ id: 'bad-key', dims: 1024, embed: async () => { throw new EmbeddingError('auth', 'private upstream response'); } });
      expect(meta(await call('cx_search', { queries: ['refund'] })).warnings[0]).toMatchObject({ code: 'EMBEDDING_AUTH_FAILED', retryable: false });
      setEmbedder(new HashEmbedder());
      expect(meta(await call('cx_search', { queries: ['refund'] })).retrieval_mode).toBe('hybrid');
      await setSetting('embed_model', 'different-model');
      resetEmbedModelCache();
      expect(meta(await call('cx_search', { queries: ['refund'] })).warnings[0].code).toBe('EMBEDDING_MODEL_MISMATCH');
    } finally {
      await db()`DELETE FROM settings WHERE key='embed_model'`;
      resetEmbedModelCache();
      setEmbedder(null);
    }
  });

  test('invalid provider settings and reranker failures retain results with recovery diagnostics', async () => {
    const keys = ['CONTEXTUAL_RERANK', 'VOYAGE_API_KEY', 'CONTEXTUAL_VOYAGE_API_KEY', 'CONTEXTUAL_VOYAGE_MAX_ATTEMPTS', 'CONTEXTUAL_EMBED_PROVIDER', 'CONTEXTUAL_OLLAMA_URL'] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    try {
      process.env.CONTEXTUAL_EMBED_PROVIDER = 'ollama';
      process.env.CONTEXTUAL_OLLAMA_URL = 'invalid';
      setEmbedder(undefined);
      const configured = await call('cx_search', { queries: ['refund'] });
      expect(meta(configured).warnings[0].code).toBe('EMBEDDING_UNAVAILABLE');
      expect(meta(configured).returned).toBe(1);
      setEmbedder(null);
      process.env.CONTEXTUAL_RERANK = 'true';
      process.env.VOYAGE_API_KEY = '';
      process.env.CONTEXTUAL_VOYAGE_API_KEY = '';
      const noKey = await call('cx_search', { queries: ['refund'] });
      expect(meta(noKey).warnings.find((w: any) => w.code === 'RERANK_UNAVAILABLE').retryable).toBe(false);
      process.env.VOYAGE_API_KEY = 'test-key';
      process.env.CONTEXTUAL_VOYAGE_MAX_ATTEMPTS = '1';
      globalThis.fetch = Object.assign(async () => new Response('Unavailable', { status: 503 }), { preconnect: originalFetch.preconnect });
      const failed = await call('cx_search', { queries: ['refund'] });
      expect(meta(failed).returned).toBe(1);
      expect(meta(failed).warnings.find((w: any) => w.code === 'RERANK_UNAVAILABLE').retryable).toBe(true);
    } finally {
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
      globalThis.fetch = originalFetch;
      setEmbedder(null);
    }
  });

  test('bad inputs, missing resources and stale cursors have stable recovery codes', async () => {
    const first = await call('cx_read', { uri });
    await db()`UPDATE nodes SET content=${longContent + ' changed'} WHERE uri=${uri}`;
    try {
      const stale = await call('cx_read', { uri, cursor: meta(first).next_cursor });
      expect(stale.isError).toBe(true);
      expect(meta(stale).error.code).toBe('STALE_CURSOR');
      for (const [tool, args, code] of [
        ['cx_read', { uri, cursor: 'invalid' }, 'INVALID_CURSOR'],
        ['cx_read', { uri: '/docs/handbook/missing.md' }, 'NOT_FOUND'],
        ['cx_grep', { pattern: '(' }, 'INVALID_ARGUMENT'],
        ['cx_search', { queries: ['refund'], scope: 'wrong' }, 'INVALID_ARGUMENT'],
        ['cx_search', { queries: ['refund'], target: 'skills', scope: 'docs' }, 'INVALID_ARGUMENT'],
      ] as const) {
        const response = await call(tool, args);
        expect(response.isError).toBe(true);
        expect(meta(response).error).toMatchObject({ code, retryable: false });
        expect(meta(response).error.suggested_action).toBeString();
      }
    } finally { await db()`UPDATE nodes SET content=${longContent} WHERE uri=${uri}`; }
  });

  test('doctor recognizes the migrated schema without writing to it', async () => {
    const report = await doctor();
    expect(report.checks.find((c) => c.name === 'migrations')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'database')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'extensions')?.status).toBe('ok');
    expect((await checkMcp()).status).toBe('ok');
  });
});
