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
async function command(args: string[]) {
  const process = Bun.spawn([binary, ...args], { cwd: directory, env, stdout: 'pipe', stderr: 'pipe' });
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
  console.log('Standalone smoke passed: embedded migrations, native DOCX ingest, MCP read, clean EOF shutdown.');
} finally {
  child?.kill();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.close();
  await rm(directory, { recursive: true, force: true });
}
