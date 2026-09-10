/** Exercise the standalone binary outside the checkout in a disposable schema. */
import { SQL } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_URL } from '../src/core/db';
const binary = resolve(process.argv[2] ?? 'dist/contextual');
const admin = new SQL(process.env.CONTEXTUAL_DATABASE_URL ?? DEFAULT_URL);
const schema = `contextual_binary_${process.pid}`;
const directory = await mkdtemp(join(tmpdir(), 'contextual binary '));
const url = new URL(process.env.CONTEXTUAL_DATABASE_URL ?? DEFAULT_URL);
url.searchParams.set('options', `-c search_path=${schema},public`);
const env = { ...process.env, CONTEXTUAL_DATABASE_URL: url.href, VOYAGE_API_KEY: '', CONTEXTUAL_VOYAGE_API_KEY: '' };
let child: ReturnType<typeof Bun.spawn> | undefined;
async function command(args: string[], extraEnv: Record<string, string> = {}) {
  const process = Bun.spawn([binary, ...args], { cwd: directory, env: { ...env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code) throw new Error(`binary ${args[0]} exited ${code}: ${err}`);
  return out;
}
try {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await command(['--help']);
  await command(['migrate']);
  const fixture = fileURLToPath(new URL('../fixtures/sample.docx', import.meta.url));
  const result = JSON.parse(await command(['add', fixture, '--json']));
  if (result[0]?.status !== 'ingested') throw new Error('compiled native addon did not ingest DOCX');
  const hasOcr = ['tesseract', 'pdftoppm'].every((name) => Bun.which(name));
  if (!hasOcr && process.env.CONTEXTUAL_REQUIRE_OCR_TESTS === '1') throw new Error('Standalone OCR smoke requires Tesseract and Poppler');
  if (hasOcr) {
    const scanned = fileURLToPath(new URL('../fixtures/scanned-text.pdf', import.meta.url));
    const ocr = JSON.parse(await command(['add', scanned, '--collection', 'ocr', '--json'], { CONTEXTUAL_OCR: 'local' }));
    if (ocr[0]?.status !== 'ingested') throw new Error('compiled local OCR did not ingest the scanned PDF');
  }
  const server = Bun.spawn([binary, 'serve'], { cwd: directory, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child = server;
  const timeout = setTimeout(() => { server.kill(); }, 10000);
  try {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'binary-test', version: '0' } } }) + '\n');
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: result[0].uris[0] } } }) + '\n');
    await server.stdin.flush();
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = '', received = false;
    while (!received) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const message = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (message.id === 1) {
          if (!message.result?.content?.length || message.result.isError) throw new Error('compiled resource read failed');
          received = true;
        }
      }
    }
    server.stdin.end();
    if (!received) throw new Error('compiled server did not return a response');
    if (await server.exited) throw new Error('compiled server shutdown failed');
  } finally { clearTimeout(timeout); server.kill(); }
  // HTTP must also work from the compiled executable, including when stdin
  // is already closed (as in a service manager).
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const http = Bun.spawn([binary, 'serve', '--transport', 'http', '--port', String(port)], {
    cwd: directory, env: { ...env, CONTEXTUAL_HTTP_TOKEN: 'binary-test-token', CONTEXTUAL_HTTP_ALLOWED_HOSTS: '127.0.0.1' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });
  child = http;
  const httpErrors = new Response(http.stderr).text();
  const httpTimeout = setTimeout(() => { http.kill('SIGKILL'); }, 10000);
  try {
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (http.exitCode !== null) break;
      try { ready = (await fetch(endpoint, { signal: AbortSignal.timeout(200) })).status === 401; }
      catch { /* waiting for the listener */ }
      if (ready) break;
      await Bun.sleep(25);
    }
    if (!ready) throw new Error('compiled HTTP server did not start or enforce authentication');
    const upload = new FormData();
    upload.append('files', new File(['# Uploaded\n\nUploaded through the standalone HTTP API.'], 'upload.md'));
    upload.append('collection', 'binary-api');
    const uploaded = await fetch(new URL('/api/ingest', endpoint), {
      method: 'POST', body: upload, signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer binary-test-token' },
    });
    const uploadResult = await uploaded.json() as { results?: { status: string; uris: string[] }[] };
    const uploadedSource = uploadResult.results?.[0];
    if (uploaded.status !== 200 || uploadedSource?.status !== 'ingested') throw new Error('compiled upload API failed');
    const response = await fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer binary-test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cx_read', arguments: { uri: uploadedSource.uris[0] } } }),
    });
    const body = await response.text();
    const data = body.split('\n').find((line) => line.startsWith('data:'));
    const message = data ? JSON.parse(data.slice(5)) : JSON.parse(body);
    if (response.status !== 200 || !message.result?.content?.length || message.result.isError) throw new Error('compiled HTTP resource read failed');
    http.kill('SIGTERM');
    if (await http.exited) throw new Error(`compiled HTTP shutdown failed: ${await httpErrors}`);
  } finally { clearTimeout(httpTimeout); http.kill(); }
  console.log(`Standalone smoke passed: embedded migrations, native DOCX ingest, ${hasOcr ? 'local PDF OCR, ' : ''}stdio reads, authenticated HTTP upload/read, clean EOF/SIGTERM shutdown.`);
} finally {
  child?.kill();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.close();
  await rm(directory, { recursive: true, force: true });
}
