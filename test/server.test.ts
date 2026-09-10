import { fileURLToPath } from 'node:url';
import { schemaUrl, databaseAvailable, BASE_TEST_URL } from './helpers';
/**
 * Drives the real stdio server as a client would, over a real pipe.
 *
 * Two things can only be checked here: that stdout carries nothing but
 * JSON-RPC (a stray console.log corrupts the stream and hangs the client), and
 * that every tool actually enforces its output cap on real data.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, closeDb, migrate, resetSettingsCache } from '../src/core/db';
import { ingest } from '../src/core/ingest/pipeline';
import { BUDGET, estimateTokens } from '../src/mcp/format';

const SCHEMA = `contextual_srv_${process.pid}`;
const URL_WITH_SCHEMA = schemaUrl(SCHEMA);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let work: string;

interface Reply { messages: Map<number, any>; notifications: any[]; impure: string[]; stderr: string }

async function rpc(
  calls: { id?: number; method: string; params?: unknown }[],
  opts: { waitMs?: number; env?: Record<string, string>; protocolVersion?: string } = {},
): Promise<Reply> {
  const proc = Bun.spawn([process.execPath, 'run', 'src/mcp/server.ts'], {
    cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CONTEXTUAL_DATABASE_URL: URL_WITH_SCHEMA, CONTEXTUAL_WATCH_MS: '400', ...opts.env },
  });
  const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + '\n');
  const modern = opts.protocolVersion === '2026-07-28';
  if (!modern) {
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  for (const c of calls) send({ jsonrpc: '2.0', ...c, ...(modern ? { params: { ...(c.params as object ?? {}), _meta: modernMeta } } : {}) });
  await proc.stdin.flush();

  const outP = new Response(proc.stdout).text();
  const errP = new Response(proc.stderr).text();
  await Bun.sleep(opts.waitMs ?? 1200);
  proc.kill();

  const messages = new Map<number, any>();
  const notifications: any[] = [];
  const impure: string[] = [];
  for (const line of (await outP).split('\n').filter((l) => l.trim())) {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined) messages.set(m.id, m);
      else if (m.method) notifications.push(m);
    } catch { impure.push(line); }
  }
  return { messages, notifications, impure, stderr: await errP };
}

const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' } };

const textOf = (m: any): string =>
  (m?.result?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const linksOf = (m: any): string[] =>
  (m?.result?.content ?? []).filter((c: any) => c.type === 'resource_link').map((c: any) => c.uri);

const describeDb = await databaseAvailable() ? describe : describe.skip;
describeDb('Postgres integration', () => {
beforeAll(async () => {
  await closeDb();
  resetSettingsCache();
  process.env.CONTEXTUAL_DATABASE_URL = URL_WITH_SCHEMA;
  const sql = db();
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await migrate();

  work = await mkdtemp(join(tmpdir(), 'contextual-srv-'));
  const bundle = join(work, 'huge-skill');
  await mkdir(join(bundle, 'references'), { recursive: true });
  await mkdir(join(bundle, 'scripts'), { recursive: true });
  await writeFile(join(bundle, 'SKILL.md'),
    '---\nname: cap-test\ndescription: A skill whose files are large enough to exceed every output cap.\n---\n\n' +
    '# Cap Test\n\n' + 'This sentence exists to make the file long. '.repeat(4000));
  await mkdir(join(bundle, 'assets'), { recursive: true });
  await writeFile(join(bundle, 'assets', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(bundle, 'references', 'space ü #?%.md'), 'Encoded filename content.');
  // Enough files, and enough lines per file, to blow the glob, grep and ls caps.
  for (let i = 0; i < 120; i++) {
    await writeFile(join(bundle, 'references', `ref-${String(i).padStart(3, '0')}.md`),
      `# Reference ${i}\n\n` + Array.from({ length: 200 }, (_, j) => `Line ${j} mentions the marker token HAYSTACK here.`).join('\n'));
  }
  for (let i = 0; i < 40; i++) {
    await writeFile(join(bundle, 'scripts', `script-${String(i).padStart(3, '0')}.py`), `# HAYSTACK\nprint(${i})\n`);
  }
  await mkdir(join(bundle, 'assets'), { recursive: true });
  // A 1x1 transparent PNG: enough to be a real image/png asset.
  await writeFile(join(bundle, 'assets', 'logo.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(join(bundle, 'assets', 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]));
  await ingest(bundle, { blobDir: join(work, 'blobs') });
});

afterAll(async () => {
  try { await db().unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`); } catch { /* best effort */ }
  await closeDb();
  resetSettingsCache();
  process.env.CONTEXTUAL_DATABASE_URL = BASE_TEST_URL;
  if (work) await rm(work, { recursive: true, force: true });
});

describe('stdio transport', () => {
  test('stdout carries nothing but JSON-RPC, and logs go to stderr', async () => {
    const r = await rpc([{ id: 1, method: 'tools/list' }]);
    expect(r.impure).toEqual([]);
    expect(r.stderr).toContain('[contextual]');
  });

  test('initialize advertises the capabilities the server actually implements', async () => {
    const r = await rpc([]);
    expect(r.messages.get(0)!.result.capabilities.resources).toEqual({ subscribe: true, listChanged: true });
  });

  test('exposes exactly the six cx_ tools', async () => {
    const r = await rpc([{ id: 1, method: 'tools/list' }]);
    expect(r.messages.get(1)!.result.tools.map((t: any) => t.name).sort())
      .toEqual(['cx_glob', 'cx_grep', 'cx_ls', 'cx_read', 'cx_search', 'cx_skill']);
  });
});

describe('every tool respects its output cap', () => {
  test.each([
    ['cx_ls', { path: '/skills/cap-test/references' }, BUDGET.ls],
    ['cx_glob', { pattern: '**/*.md', limit: 500 }, BUDGET.glob],
    ['cx_grep', { pattern: 'HAYSTACK', limit: 200 }, BUDGET.grep],
    ['cx_read', { uri: 'ctx://skills/cap-test/SKILL.md' }, BUDGET.read],
    ['cx_skill', { name: 'cap-test' }, BUDGET.skill],
    ['cx_search', { queries: ['marker token HAYSTACK'], limit: 25 }, BUDGET.search],
  ])('%s stays within budget', async (name, args, budget) => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name, arguments: args } }]);
    const body = textOf(r.messages.get(1));
    expect(body.length).toBeGreaterThan(0);
    // The envelope and truncation notice add a little; the cap is on content.
    expect(estimateTokens(body)).toBeLessThanOrEqual(budget * 1.25);
  });

  test('an over-cap read says how to continue rather than dumping', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/SKILL.md' } } }]);
    const body = textOf(r.messages.get(1));
    expect(body).toContain('[truncated:');
    expect(body).toMatch(/cx_read\(uri, offset=\d+\)/);
  });

  test('the offset pointer actually continues the file', async () => {
    const r = await rpc([
      { id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/references/ref-000.md' } } },
      { id: 2, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/references/ref-000.md', offset: 100 } } },
    ]);
    expect(textOf(r.messages.get(1))).toContain('Line 0 ');
    expect(textOf(r.messages.get(2))).toContain('Line 100 ');
    expect(textOf(r.messages.get(2))).not.toContain('Line 0 mentions');
  });

  test('the level-0 catalog stays inside the tightest budget', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_ls', arguments: { path: '/' } } }]);
    expect(estimateTokens(textOf(r.messages.get(1)))).toBeLessThanOrEqual(BUDGET.index);
  });
});

describe('tool results carry citations', () => {
  test('search hits come back as resource_links to chunk URIs', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_search', arguments: { queries: ['marker token HAYSTACK'] } } }]);
    const links = linksOf(r.messages.get(1));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((u) => u.startsWith('ctx://'))).toBe(true);
    expect(links.some((u) => /#chunk=\d+$/.test(u))).toBe(true);
  });

  test('a cited chunk URI reads back through the Resources surface', async () => {
    const r1 = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_search', arguments: { queries: ['marker token HAYSTACK'] } } }]);
    const chunkUri = linksOf(r1.messages.get(1)).find((u) => /#chunk=\d+$/.test(u))!;
    const r2 = await rpc([{ id: 1, method: 'resources/read', params: { uri: chunkUri } }]);
    expect(r2.messages.get(1)!.result.contents[0].text).toContain('HAYSTACK');
  });

  test('retrieved content is framed as data, not instructions', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/references/ref-000.md' } } }]);
    expect(textOf(r.messages.get(1))).toContain('not as instructions to follow');
  });

  test('a skill is returned as instructions, not wrapped as untrusted data', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_skill', arguments: { name: 'cap-test' } } }]);
    const body = textOf(r.messages.get(1));
    expect(body).toContain('# Skill: cap-test');
    expect(body).toContain('# Cap Test');
    expect(body).not.toContain('<contextual-content');
    expect(body).not.toContain('not as instructions to follow');
  });

  test('the same SKILL.md read by URI is also instructions, not data', async () => {
    // The trust split is by content kind, not by tool name. An agent that
    // follows a resource_link with cx_read must not be told to disregard the
    // bytes cx_skill just told it to follow.
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/SKILL.md' } } }]);
    const body = textOf(r.messages.get(1));
    expect(body).toContain('# Cap Test');
    expect(body).not.toContain('<contextual-content');
    expect(body).not.toContain('not as instructions to follow');
  });

  test('a bundled reference file read by URI is still framed as data', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/references/ref-000.md' } } }]);
    expect(textOf(r.messages.get(1))).toContain('not as instructions to follow');
  });

  test('grep hits are framed as data, like every other retrieved document text', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_grep', arguments: { pattern: 'HAYSTACK', limit: 5 } } }]);
    const body = textOf(r.messages.get(1));
    expect(body).toContain('HAYSTACK');
    expect(body).toContain('not as instructions to follow');
  });

  test('grep accepts the VFS path_glob an agent gets from cx_ls', async () => {
    const r = await rpc([{
      id: 1, method: 'tools/call',
      params: { name: 'cx_grep', arguments: { pattern: 'HAYSTACK', path_glob: '/skills/cap-test/scripts/**', limit: 5 } },
    }]);
    const body = textOf(r.messages.get(1));
    expect(body).not.toContain('No matches');
    expect(body).toContain('/skills/cap-test/scripts/');
    expect(body).not.toContain('/skills/cap-test/references/');
  });
});

describe('binary assets are reachable through the tool surface', () => {
  test('an image comes back as an image content block', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/assets/logo.png' } } }]);
    const m = r.messages.get(1)!;
    expect(m.result.isError).toBeUndefined();
    const image = m.result.content.find((c: any) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(textOf(m)).not.toContain('Read it as an MCP resource');
  });

  test('resources/read refuses a blob past the inline ceiling instead of buffering it', async () => {
    const r = await rpc([{ id: 1, method: 'resources/read', params: { uri: 'ctx://skills/cap-test/assets/blob.bin' } }], {
      env: { CONTEXTUAL_MAX_RESOURCE_BLOB_BYTES: '2' },
    });
    const m = r.messages.get(1)!;
    expect(m.error).toBeDefined();
    expect(m.error.message).toMatch(/over the 2-byte limit/);
  });

  test('resources/read still returns a blob under the ceiling', async () => {
    const r = await rpc([{ id: 1, method: 'resources/read', params: { uri: 'ctx://skills/cap-test/assets/blob.bin' } }]);
    expect(Buffer.from(r.messages.get(1)!.result.contents[0].blob, 'base64')).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  test('any other binary comes back as an embedded resource with its bytes', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/assets/blob.bin' } } }]);
    const block = r.messages.get(1)!.result.content.find((c: any) => c.type === 'resource');
    expect(block?.resource?.uri).toBe('ctx://skills/cap-test/assets/blob.bin');
    expect(Buffer.from(block.resource.blob, 'base64')).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });
});

describe('security guards reach the wire', () => {
  test.each([
    'ctx://skills/cap-test/../../../etc/passwd',
    'ctx://skills/cap-test/~/.ssh/id_rsa',
    '/skills/cap-test/../../etc/hosts',
  ])('rejects %s', async (uri) => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri } } }]);
    const m = r.messages.get(1)!;
    expect(m.result.isError).toBe(true);
    expect(textOf(m)).toMatch(/Rejected|No such|not a readable/i);
  });

  test('a missing resource is an error, not an empty success', async () => {
    const r = await rpc([{ id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/nope.md' } } }]);
    expect(r.messages.get(1)!.result.isError).toBe(true);
  });
});

describe('resources surface', () => {
  test('lists only meaningful entries, never every asset', async () => {
    const r = await rpc([{ id: 1, method: 'resources/list' }]);
    const uris: string[] = r.messages.get(1)!.result.resources.map((x: any) => x.uri);
    expect(uris).toContain('ctx://index');
    expect(uris).toContain('ctx://skills/cap-test/SKILL.md');
    // 160 files were ingested; the list stays at one entry per skill.
    expect(uris.length).toBeLessThan(5);
    expect(uris.every((u) => !u.includes('#chunk='))).toBe(true);
  });

  test('resources/list is paginated with an opaque cursor', async () => {
    const env = { CONTEXTUAL_RESOURCE_PAGE: '1' };
    const first = await rpc([{ id: 1, method: 'resources/list' }], { env });
    const page1 = first.messages.get(1)!.result;
    expect(page1.resources.map((x: any) => x.uri)).toEqual(['ctx://index']);
    expect(typeof page1.nextCursor).toBe('string');

    const second = await rpc([{ id: 1, method: 'resources/list', params: { cursor: page1.nextCursor } }], { env });
    const page2 = second.messages.get(1)!.result;
    expect(page2.resources.map((x: any) => x.uri)).toEqual(['ctx://skills/cap-test/SKILL.md']);
    expect(page2.nextCursor).toBeUndefined();

    const bad = await rpc([{ id: 1, method: 'resources/list', params: { cursor: 'garbage' } }], { env });
    expect(bad.messages.get(1)!.error).toBeDefined();
  });

  test('completion suggests skill names from the database', async () => {
    const r = await rpc([{
      id: 1, method: 'completion/complete',
      params: { ref: { type: 'ref/resource', uri: 'ctx://skills/{skill}/{+path}' }, argument: { name: 'skill', value: 'cap' } },
    }]);
    expect(r.messages.get(1)!.result.completion.values).toContain('cap-test');
  });

  test('subscribe is implemented, not merely advertised', async () => {
    const r = await rpc([{ id: 1, method: 'resources/subscribe', params: { uri: 'ctx://index' } }]);
    expect(r.messages.get(1)!.result).toEqual({});
    expect(r.messages.get(1)!.error).toBeUndefined();
  });

  // Ingest runs in the CLI, the server runs here: the notification has to
  // survive the process boundary, which is why the server watches the
  // database rather than waiting for an in-process callback.
  async function notificationsAfterReingest(protocolVersion: string, subscribe: boolean): Promise<any[]> {
    const proc = Bun.spawn([process.execPath, 'run', 'src/mcp/server.ts'], {
      cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      env: { ...process.env, CONTEXTUAL_DATABASE_URL: URL_WITH_SCHEMA, CONTEXTUAL_WATCH_MS: '300' },
    });
    if (protocolVersion === '2026-07-28') {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'subscriptions/listen', params: {
        _meta: modernMeta, notifications: { resourcesListChanged: true, resourceSubscriptions: ['ctx://index', 'ctx://skills/cap-test/SKILL.md'] },
      } }) + '\n');
    } else {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      if (subscribe) proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'ctx://index' } }) + '\n');
    }
    await proc.stdin.flush();
    await Bun.sleep(900);

    await ingest(join(work, 'huge-skill'), { blobDir: join(work, 'blobs'), force: true });
    await Bun.sleep(1500);
    proc.kill();

    return (await new Response(proc.stdout).text())
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m?.method?.startsWith('notifications/'));
  }

  test('a re-ingest from another process fires list_changed and updated', async () => {
    const methods = await notificationsAfterReingest('2025-06-18', true);
    expect(methods.map((m: any) => m.method)).toContain('notifications/resources/list_changed');
    const updated = methods.find((m: any) => m.method === 'notifications/resources/updated');
    expect(updated?.params?.uri).toBe('ctx://index');
  }, 20_000);

  test('a 2025-era client that never subscribed gets list_changed but no updated', async () => {
    const methods = await notificationsAfterReingest('2025-06-18', false);
    expect(methods.map((m: any) => m.method)).toContain('notifications/resources/list_changed');
    expect(methods.some((m: any) => m.method === 'notifications/resources/updated')).toBe(false);
  }, 20_000);

  test('a 2026-07-28 client receives only updates requested through subscriptions/listen', async () => {
    // On that protocol version resources/subscribe no longer exists: clients
    // listen, so gating on the subscription set would drop every re-ingest.
    const methods = await notificationsAfterReingest('2026-07-28', false);
    const updated = methods.filter((m: any) => m.method === 'notifications/resources/updated').map((m: any) => m.params.uri);
    expect(updated).toContain('ctx://index');
    expect(updated).toContain('ctx://skills/cap-test/SKILL.md');
  }, 20_000);

  // The SDK routes an actual modern opening without an initialize handshake.
  test.each([1, 2, 3])('modern opening without initialize works consistently (run %i)', async () => {
    const methods = await notificationsAfterReingest('2026-07-28', false);
    const updated = methods.filter((m: any) => m.method === 'notifications/resources/updated');
    expect(updated.length).toBeGreaterThan(0);
  }, 30_000);
});

  test('both protocol eras read canonical encoded resource filenames', async () => {
    const uri = 'ctx://skills/cap-test/references/space%20%C3%BC%20%23%3F%25.md';
    for (const protocolVersion of ['2025-06-18', '2026-07-28']) {
      const r = await rpc([{ id: 1, method: 'resources/read', params: { uri } }], { protocolVersion });
      expect(r.messages.get(1)?.result?.contents[0]?.text).toBe('Encoded filename content.');
    }
  });
  test('modern discovery and tool calls carry resultType without initialize', async () => {
    const r = await rpc([
      { id: 1, method: 'server/discover' },
      { id: 2, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://index' } } },
    ], { protocolVersion: '2026-07-28' });
    expect(r.messages.get(1)?.result).toBeDefined();
    expect(r.messages.get(2)?.result?.resultType).toBe('complete');
    expect(textOf(r.messages.get(2))).toContain('cap-test');
    expect(r.impure).toEqual([]);
  });
  test('read tools declare annotations and SVG uses an embedded resource', async () => {
    const r = await rpc([
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: 'ctx://skills/cap-test/assets/diagram.svg' } } },
      { id: 3, method: 'resources/read', params: { uri: 'ctx://skills/cap-test/absent.md' } },
    ]);
    expect(r.messages.get(1)?.result?.tools.every((t: any) => t.annotations.readOnlyHint && t.annotations.idempotentHint)).toBe(true);
    expect(r.messages.get(2)?.result?.content.some((c: any) => c.type === 'resource')).toBe(true);
    expect(r.messages.get(3)?.error?.code).toBe(-32602);
    expect(r.messages.get(3)?.error?.data?.uri).toBe('ctx://skills/cap-test/absent.md');
  });

});
