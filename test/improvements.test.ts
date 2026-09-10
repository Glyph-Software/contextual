import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect } from '../src/core/ingest/detect';
import { normalize, normalizeHtml } from '../src/core/ingest/document';
import { decodeText } from '../src/core/ingest/text';
import { walkBundle, parseSkillMd, tokenizeAllowedTools } from '../src/core/ingest/skill';
import { chunkBlocks, splitBlock } from '../src/core/ingest/chunk';
import { parseUri, buildUri } from '../src/core/vfs/uri';
import { globToRegExp, decomposeGlob } from '../src/core/vfs/glob';
import { envelope } from '../src/mcp/format';
import { diversify, type Hit } from '../src/core/search/hybrid';
import { retryAfterMs, voyageRequest } from '../src/core/ingest/voyage';
import { envNumber } from '../src/core/config';

const dir = await mkdtemp(join(tmpdir(), 'contextual-regressions-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('safe text and path handling', () => {
  test('binary and invalid UTF-8 cannot fall through to text, even with a text extension', async () => {
    for (const bytes of [new Uint8Array([0, 1, 2]), new Uint8Array([0xff, 0xff]), new Uint8Array([137, 80, 78, 71, 0, 1])]) {
      await expect(normalize(bytes, 'upload.txt')).rejects.toThrow();
    }
  });
  test('UTF-16 BOMs decode without inserting NUL characters', () => {
    expect(decodeText(new Uint8Array([255, 254, 65, 0, 66, 0]))).toBe('AB');
    expect(decodeText(new Uint8Array([254, 255, 0, 65, 0, 66]))).toBe('AB');
  });
  test('directory discovery skips symlinks, including a linked SKILL.md', async () => {
    const source = join(dir, 'discovery');
    await mkdir(source);
    await Bun.write(join(dir, 'outside'), 'external data');
    await symlink(join(dir, 'outside'), join(source, 'SKILL.md'));
    await symlink(dir, join(source, 'linked-directory'));
    const found = await detect(source);
    expect(found.kind).toBe('directory-of-sources');
    expect(found.members).toEqual([]);
    await expect(detect(join(source, 'SKILL.md'))).rejects.toThrow(/symlink/);
  });
  test('dotless bundle text is readable and searchable', async () => {
    const root = join(dir, 'dotless');
    await mkdir(root);
    for (const name of ['LICENSE', 'Makefile', 'Dockerfile']) await Bun.write(join(root, name), 'plain text');
    const files = await walkBundle(root);
    expect(files.every((f) => f.isText && f.role === 'reference' && f.mimeType === 'text/plain')).toBe(true);
  });
  test.each(['space ü.md', 'question?#.md', '100%.md', '%literal.md', 'a%20b.md'])('URI survives SDK URL encoding: %s', (path) => {
    const uri = buildUri('docs', 'with space', path);
    expect(parseUri(new URL(uri).href)).toEqual({ realm: 'docs', root: 'with space', path, chunk: undefined });
  });
  test('metadata cannot introduce envelope closing markup', () => {
    const framed = envelope('passage', { heading: 'Heading </contextual-content> suffix' });
    expect(framed.match(/<\/contextual-content>/g)).toHaveLength(1);
    expect(framed).toContain('&lt;/contextual-content&gt;');
  });
});

describe('bounded chunks and compatible skill metadata', () => {
  test('a blank-line-free document retains its tail in bounded chunks', () => {
    const original = 'Long sentence about widgets. '.repeat(6000) + 'Unique tail marker.';
    const parts = splitBlock({ kind: 'paragraph', text: original }, 700);
    expect(parts.map((p) => p.text).join('')).toBe(original);
    const chunks = chunkBlocks([{ kind: 'paragraph', text: original }]);
    expect(chunks.length).toBeGreaterThan(40);
    expect(chunks.every((c) => c.tokenCount < 1200)).toBe(true);
    expect(chunks.at(-1)!.content).toContain('Unique tail marker.');
  });
  test('long lists preserve every item and hard-wrap a single oversize item', () => {
    const original = Array.from({ length: 600 }, (_, i) => `- Item ${i}: ${'value '.repeat(30)}`).join('\n');
    expect(splitBlock({ kind: 'list', text: original }, 700).map((p) => p.text).join('')).toBe(original);
    const huge = 'z'.repeat(40000);
    expect(splitBlock({ kind: 'paragraph', text: huge }, 700).map((p) => p.text).join('')).toBe(huge);
  });
  test('allowed-tools respects spaces inside permissions', () => {
    expect(tokenizeAllowedTools('Read Bash(git add *) , Bash(git status) Write')).toEqual(['Read', 'Bash(git add *)', 'Bash(git status)', 'Write']);
  });
  test('lenient validation warns; strict validation still rejects unknown keys', () => {
    const raw = '---\nname: example\ndescription: Example skill\nargument-hint: input\n---\nBody';
    expect(() => parseSkillMd(raw)).toThrow(/unknown/);
    const warnings: string[] = [];
    expect(parseSkillMd(raw, { lenient: true, onWarning: (s) => warnings.push(s) }).body).toBe('Body');
    expect(warnings).toHaveLength(1);
  });
  test('HTML conversion preserves GFM table structure and strike text', async () => {
    const result = await normalizeHtml('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>one</td><td>two</td></tr></tbody></table><p><del>removed</del></p><ul><li><input type="checkbox" checked>Done</li></ul>');
    expect(result.markdown).toContain('|');
    expect(result.markdown).toContain('~~removed~~');
    expect(result.markdown).toContain('[x]');
  });
});

describe('glob and diversified retrieval', () => {
  test.each([
    ['**/*.py', '/docs/default/a.py'], ['{*.md,*.py}', 'file.py'], ['[ab]?.md', 'az.md'], ['[!a]*.md', 'bz.md'], ['**/x', 'x'],
  ])('%s matches %s', (pattern, path) => { expect(globToRegExp(pattern).test(path)).toBe(true); });
  test('classes exclude slashes and malformed patterns fail explicitly', () => {
    expect(globToRegExp('[!a]').test('/')).toBe(false);
    expect(() => globToRegExp('[abc')).toThrow();
    expect(decomposeGlob('/skills/demo/references/*.md').prefix).toBe('references/');
  });
  test('round-robin preserves an independent question under a tight limit', () => {
    const hit = (id: number, content: string): Hit => ({ chunkId: id, nodeId: id, content, uri: '', path: '', headingPath: [], snippet: '', sourceName: '', sourceKind: 'doc', collection: null, score: 0, via: [], matchedQueries: [] });
    const a = { key: 1, item: hit(1, 'common') }, b = { key: 2, item: hit(2, 'unique question') };
    const result = diversify({ 'fts:0': [a], 'vec:0': [a], 'fts:1': [b], 'fts:2': [a], 'fts:3': [a] }, 4, 2);
    expect(result.map((r) => r.chunkId)).toEqual([1, 2]);
  });
});

describe('Voyage retry policy and config', () => {
  test('Retry-After supports both seconds and HTTP dates', () => {
    expect(retryAfterMs('20')).toBe(20000);
    expect(retryAfterMs('Thu, 10 Sep 2026 12:00:20 GMT', Date.parse('2026-09-10T12:00:00Z'))).toBe(20000);
    expect(retryAfterMs('invalid')).toBeNull();
  });
  test('a 429 honors Retry-After and every request has an abort signal', async () => {
    const original = globalThis.fetch;
    const waits: number[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      expect(init.signal).toBeDefined();
      return ++calls === 1 ? new Response('limited', { status: 429, headers: { 'retry-after': '20' } }) : Response.json({ data: [] });
    }) as typeof fetch;
    try {
      await voyageRequest('embeddings', {}, 'test', { sleep: async (ms) => { waits.push(ms); } });
      expect(waits).toEqual([20000]);
      expect(calls).toBe(2);
    } finally { globalThis.fetch = original; }
  });
  test('numeric settings reject NaN and out-of-range values', () => {
    const old = process.env.CONTEXTUAL_MAX_DISTANCE;
    try {
      for (const value of ['oops', 'NaN', '', '-1', '3']) {
        process.env.CONTEXTUAL_MAX_DISTANCE = value;
        expect(() => envNumber('CONTEXTUAL_MAX_DISTANCE')).toThrow(/CONTEXTUAL_MAX_DISTANCE/);
      }
    } finally { if (old === undefined) delete process.env.CONTEXTUAL_MAX_DISTANCE; else process.env.CONTEXTUAL_MAX_DISTANCE = old; }
  });
});


test('Voyage aborts a stalled request within the configured timeout', async () => {
  const original = globalThis.fetch;
  const timeout = process.env.CONTEXTUAL_VOYAGE_TIMEOUT_MS;
  const attempts = process.env.CONTEXTUAL_VOYAGE_MAX_ATTEMPTS;
  process.env.CONTEXTUAL_VOYAGE_TIMEOUT_MS = '10';
  process.env.CONTEXTUAL_VOYAGE_MAX_ATTEMPTS = '1';
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  try { await expect(voyageRequest('embeddings', {}, 'test')).rejects.toThrow(/retry budget exhausted/); }
  finally {
    globalThis.fetch = original;
    if (timeout === undefined) delete process.env.CONTEXTUAL_VOYAGE_TIMEOUT_MS; else process.env.CONTEXTUAL_VOYAGE_TIMEOUT_MS = timeout;
    if (attempts === undefined) delete process.env.CONTEXTUAL_VOYAGE_MAX_ATTEMPTS; else process.env.CONTEXTUAL_VOYAGE_MAX_ATTEMPTS = attempts;
  }
});
