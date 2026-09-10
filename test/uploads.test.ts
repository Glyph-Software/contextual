import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../src/mcp/http';
import { createUploadApi } from '../src/mcp/uploads';
import { db, closeDb, resetSettingsCache } from '../src/core/db';
import { ingest } from '../src/core/ingest/pipeline';
import { resolveNode } from '../src/core/vfs/resolve';
import { databaseAvailable, schemaUrl } from './helpers';

const hasDb = await databaseAvailable();
const testDb = hasDb ? test : test.skip;
const testOcrDb = hasDb && ['tesseract', 'pdftoppm'].every((name) => Bun.which(name)) ? test : test.skip;
const schema = `contextual_upload_${process.pid}`;
const savedEnv = { ...process.env };
const envKeys = ['CONTEXTUAL_DATABASE_URL', 'CONTEXTUAL_BLOB_DIR', 'CONTEXTUAL_HTTP_TOKEN', 'CONTEXTUAL_HTTP_ALLOWED_HOSTS',
  'CONTEXTUAL_UPLOAD_MAX_BYTES', 'CONTEXTUAL_UPLOAD_MAX_FILES', 'VOYAGE_API_KEY', 'CONTEXTUAL_VOYAGE_API_KEY', 'CONTEXTUAL_OCR'];
let endpoint: ReturnType<typeof startHttpServer>;
let url: string, work: string;
const file = (name: string, text = '# Upload\n\nUpload integration test content.') => new File([text], name);
function form(files: File[], fields: Record<string, string> = {}) {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return body;
}
const send = (body: FormData, target = url, headers: Record<string, string> = {}) =>
  fetch(target, { method: 'POST', body, headers, signal: AbortSignal.timeout(10000) });
const json = async (response: Response | Promise<Response>): Promise<any> => (await response).json();
const temporaryUploads = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('contextual-upload-')).sort();

beforeAll(async () => {
  for (const key of ['CONTEXTUAL_HTTP_TOKEN', 'CONTEXTUAL_HTTP_ALLOWED_HOSTS', 'CONTEXTUAL_UPLOAD_MAX_BYTES', 'CONTEXTUAL_UPLOAD_MAX_FILES']) delete process.env[key];
  process.env.VOYAGE_API_KEY = '';
  process.env.CONTEXTUAL_VOYAGE_API_KEY = '';
  process.env.CONTEXTUAL_OCR = 'reject';
  work = await mkdtemp(join(tmpdir(), 'contextual-upload-test-'));
  process.env.CONTEXTUAL_BLOB_DIR = join(work, 'blobs');
  if (hasDb) {
    await closeDb();
    resetSettingsCache();
    process.env.CONTEXTUAL_DATABASE_URL = schemaUrl(schema);
    await db().unsafe(`CREATE SCHEMA ${schema}`);
    // The first valid upload must apply migrations itself, just like CLI add.
  }
  endpoint = startHttpServer({ port: 0 });
  url = new URL('/api/ingest', endpoint.url).href;
});

afterAll(async () => {
  await endpoint?.close();
  if (hasDb) await db().unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await closeDb();
  resetSettingsCache();
  await rm(work, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('upload request handling', () => {
  test('requires POST and multipart data', async () => {
    const get = await fetch(url);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const wrongType = await fetch(url, { method: 'POST', body: '{}' });
    expect(wrongType.status).toBe(415);
    expect((await json(wrongType)).error.code).toBe('unsupported_media_type');
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'bad' })).status).toBe(400);
    expect((await send(form([]))).status).toBe(400);
  });

  test('validates all fields before ingesting files', async () => {
    const invalidFields: Record<string, string>[] = [{ force: 'yes' }, { lenient: '1' }, { collection: '../outside' }, { collection: '' }, { path: '/tmp/file' }];
    for (const fields of invalidFields) {
      const response = await send(form([file('validation.md')], fields));
      expect(response.status).toBe(400);
      expect((await json(response)).error.code).toBe('invalid_field');
    }
    const duplicateField = form([file('validation.md')], { collection: 'one' });
    duplicateField.append('collection', 'two');
    expect((await send(duplicateField)).status).toBe(400);
    expect((await send(form([file('../outside.md')]))).status).toBe(400);
    expect((await send(form([file('duplicate.md'), file('duplicate.md')]))).status).toBe(400);
  });

  test('applies HTTP authentication and Origin checks to uploads', async () => {
    const protectedServer = startHttpServer({ port: 0, token: 'upload-test-token' });
    const target = new URL('/api/ingest', protectedServer.url).href;
    try {
      expect((await send(form([file('auth.md')]), target)).status).toBe(401);
      expect((await send(form([file('auth.md')]), target, { authorization: 'Bearer wrong' })).status).toBe(401);
      const headers = { authorization: 'Bearer upload-test-token' };
      expect((await send(form([]), target, headers)).status).toBe(400);
      expect((await send(form([]), target, { ...headers, origin: 'https://untrusted.example' })).status).toBe(403);
      expect((await send(form([]), target, { ...headers, host: 'untrusted.example' })).status).toBe(403);
    } finally { await protectedServer.close(); }
  });

  test('enforces upload size and file-count limits while retaining the MCP limit', async () => {
    process.env.CONTEXTUAL_UPLOAD_MAX_BYTES = '2048';
    process.env.CONTEXTUAL_UPLOAD_MAX_FILES = '1';
    const limited = startHttpServer({ port: 0 });
    delete process.env.CONTEXTUAL_UPLOAD_MAX_BYTES;
    delete process.env.CONTEXTUAL_UPLOAD_MAX_FILES;
    const target = new URL('/api/ingest', limited.url).href;
    try {
      const large = await send(form([file('large.md', 'x'.repeat(4096))]), target);
      expect(large.status).toBe(413);
      expect((await json(large)).error.code).toBe('payload_too_large');
      const many = await send(form([file('one.md'), file('two.md')]), target);
      expect(many.status).toBe(413);
      expect((await json(many)).error.code).toBe('too_many_files');
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4096)); controller.close(); } });
      const chunked = await fetch(target, { method: 'POST', body: stream, headers: { 'content-type': 'multipart/form-data; boundary=test' } });
      expect(chunked.status).toBe(413);
      const mcp = await fetch(endpoint.url, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { 'content-type': 'application/json' } });
      expect(mcp.status).toBe(413);
    } finally { await limited.close(); }
  });

  test('bounds concurrent uploads and cancels an unfinished body on shutdown', async () => {
    const api = createUploadApi({ maxBytes: 2048, maxFiles: 2 });
    const pending = api.handle(new Request('http://localhost/api/ingest', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=waiting' }, body: new ReadableStream(),
    }));
    const busy = await api.handle(new Request('http://localhost/api/ingest', { method: 'POST', body: form([file('busy.md')]) }));
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('1');
    await api.close();
    expect((await pending).status).toBe(400);
    expect((await api.handle(new Request('http://localhost/api/ingest', { method: 'POST' }))).status).toBe(503);
  });
});

describe('uploaded sources', () => {
  testDb('migrates, ingests multiple documents, and exposes them through MCP', async () => {
    const before = await temporaryUploads();
    const response = await send(form([file('first.md', '# Support\n\nSupport opens at 09:00 UTC.'), file('second.txt')], { collection: 'uploads' }));
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.status).toBe('completed');
    expect(payload.summary).toEqual({ files: 2, ingested: 2, unchanged: 0, needs_ocr: 0, failed: 0 });
    expect(payload.results[0].input).toBe('first.md');
    expect(payload.results[0].uris).toContain('ctx://docs/uploads/first.md');
    const resource = await fetch(endpoint.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'cx_read', arguments: { uri: payload.results[0].uris[0] },
      } }),
    });
    expect(await resource.text()).toContain('09:00 UTC');
    expect(await temporaryUploads()).toEqual(before);
    const [source] = await db()`SELECT origin_uri FROM sources WHERE name='first.md'`;
    expect(source.origin_uri).toBe('upload://docs/uploads/first.md');
  });

  testOcrDb('local OCR uploads become readable corpus content', async () => {
    const previous = process.env.CONTEXTUAL_OCR;
    process.env.CONTEXTUAL_OCR = 'local';
    try {
      const bytes = await Bun.file(new URL('../fixtures/scanned-text.pdf', import.meta.url)).bytes();
      const response = await send(form([new File([bytes], 'scanned-text.pdf')], { collection: 'local-ocr' }));
      expect(response.status).toBe(200);
      const payload = await response.json() as any;
      expect(payload.results[0].status).toBe('ingested');
      const node = await resolveNode(payload.results[0].uris[0]);
      expect(node?.content).toContain('850 milliseconds');
      expect(node?.content).toContain('amber key');
    } finally {
      if (previous === undefined) delete process.env.CONTEXTUAL_OCR;
      else process.env.CONTEXTUAL_OCR = previous;
    }
  }, 30000);

  testDb('reuploads are idempotent; changed bytes and force replace the stored source', async () => {
    const first = await json(send(form([file('repeat.md')])));
    const again = await json(send(form([file('repeat.md')])));
    expect(again.results[0].status).toBe('unchanged');
    expect(again.results[0].sourceId).toBe(first.results[0].sourceId);
    const forced = await json(send(form([file('repeat.md')], { force: 'true' })));
    expect(forced.results[0].status).toBe('ingested');
    const updated = await json(send(form([file('repeat.md', '# Changed\n\nReplacement content.')])));
    expect(updated.results[0].sourceId).toBe(first.results[0].sourceId);
    expect((await resolveNode('ctx://docs/default/repeat.md'))?.content).toContain('Replacement content');
  });

  testDb('keeps same-content files with different names after temporary originals are removed', async () => {
    await send(form([file('twin-one.md')], { collection: 'twins' }));
    await send(form([file('twin-two.md')], { collection: 'twins' }));
    await Bun.write(join(work, 'twin-three.md'), await file('twin-three.md').text());
    await ingest(join(work, 'twin-three.md'), { collection: 'twins' });
    const rows = await db()`SELECT name FROM sources WHERE collection='twins' ORDER BY name`;
    expect(rows.map((row: { name: string }) => row.name)).toEqual(['twin-one.md', 'twin-three.md', 'twin-two.md']);
  });

  testDb('an unchanged local file reuploaded through HTTP gets a durable upload origin', async () => {
    const path = join(work, 'local-first.md');
    await Bun.write(path, await file('local-first.md').text());
    await ingest(path, { collection: 'provenance' });
    const response = await json(send(form([file('local-first.md')], { collection: 'provenance' })));
    expect(response.results[0].status).toBe('unchanged');
    await rm(path);
    const [source] = await db()`SELECT origin_uri FROM sources WHERE name='local-first.md'`;
    expect(source.origin_uri).toBe('upload://docs/provenance/local-first.md');
  });

  testDb('supports the single-file field, Unicode filenames, and collection isolation', async () => {
    const body = new FormData();
    body.append('file', file('café notes.md'));
    body.append('collection', 'first');
    const result = await json(send(body));
    expect(result.results[0].uris[0]).toBe('ctx://docs/first/caf%C3%A9%20notes.md');
    await send(form([file('café notes.md', '# Different\n\nOther collection.')], { collection: 'second' }));
    expect((await resolveNode(result.results[0].uris[0]))?.content).toContain('Upload integration');
    expect((await resolveNode('ctx://docs/second/caf%C3%A9%20notes.md'))?.content).toContain('Other collection');
  });

  testDb('reports mixed success, OCR requirements, and invalid archives per file', async () => {
    const before = await temporaryUploads();
    const scanned = new File([await Bun.file(new URL('../fixtures/scanned.pdf', import.meta.url)).bytes()], 'scanned.pdf');
    const response = await send(form([file('valid.md'), scanned, file('invalid.zip', 'not a zip')], { collection: 'mixed' }));
    expect(response.status).toBe(207);
    const payload = await json(response);
    expect(payload.summary).toEqual({ files: 3, ingested: 1, unchanged: 0, needs_ocr: 1, failed: 1 });
    expect(payload.status).toBe('partial');
    expect(payload.results.map((result: any) => result.input)).toEqual(['valid.md', 'scanned.pdf', 'invalid.zip']);
    expect((await resolveNode('ctx://docs/mixed/valid.md'))?.content).toContain('Upload integration');
    expect(await temporaryUploads()).toEqual(before);
    expect((await send(form([scanned], { collection: 'only-ocr' }))).status).toBe(422);
  });

  testDb('a failed replacement leaves previously searchable content intact', async () => {
    await send(form([file('preserve.md')]));
    const response = await send(form([new File([new Uint8Array([0, 0, 0, 255])], 'preserve.md')]));
    expect(response.status).toBe(422);
    expect((await json(response)).results[0].detail).toContain('previous ready source preserved');
    expect((await resolveNode('ctx://docs/default/preserve.md'))?.content).toContain('Upload integration');
  });

  testDb('normalizes real DOCX uploads', async () => {
    const docx = new File([await Bun.file(new URL('../fixtures/sample.docx', import.meta.url)).bytes()], 'uploaded.docx');
    const response = await send(form([docx]));
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.results[0].uris[0]).toBe('ctx://docs/default/uploaded.docx.md');
    expect(payload.results[0].chunks).toBeGreaterThan(0);
  });

  testDb('ingests skill archives, preserves assets, and supports lenient validation', async () => {
    const bundle = join(work, 'skill');
    await mkdir(join(bundle, 'assets'), { recursive: true });
    await Bun.write(join(bundle, 'SKILL.md'), '---\nname: uploaded-skill\ndescription: Upload fixture\ncustom-extra: true\n---\n\nUse the bundled asset.');
    await Bun.write(join(bundle, 'assets', 'icon.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const archive = join(work, 'bundle.skill');
    await Bun.$`zip -qr ${archive} .`.cwd(bundle).quiet();
    const zip = new File([await Bun.file(archive).bytes()], 'bundle.skill');
    expect((await send(form([zip]))).status).toBe(422);
    const before = await temporaryUploads();
    const response = await send(form([zip], { lenient: 'true' }));
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.results[0].name).toBe('uploaded-skill');
    expect((await resolveNode('ctx://skills/uploaded-skill/SKILL.md'))?.content).toContain('custom-extra: true');
    const asset = await resolveNode('ctx://skills/uploaded-skill/assets/icon.png');
    expect(await Bun.file(asset!.blobRef!).exists()).toBe(true);
    const [source] = await db()`SELECT origin_uri FROM sources WHERE name='uploaded-skill'`;
    expect(source.origin_uri).toBe('upload://skills/uploaded-skill');
    expect(await temporaryUploads()).toEqual(before);
  });
});
