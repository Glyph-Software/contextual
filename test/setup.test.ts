import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibleRuntime, MIN_BUN_VERSION, checkMcp } from '../src/cli/setup';

const cli = fileURLToPath(new URL('../src/cli/contextual.ts', import.meta.url));
async function run(args: string[], cwd: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: {
    ...process.env,
    CONTEXTUAL_DATABASE_URL: 'postgres://test:private-password@127.0.0.1:1/contextual',
    CONTEXTUAL_EMBED_PROVIDER: 'none',
    CONTEXTUAL_BLOB_DIR: './local blobs',
    ...extra,
  }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
async function temporary(fn: (dir: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'contextual setup ')));
  try { await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

describe('first-run setup', () => {
  test('checks the declared runtime minimum including prereleases', () => {
    expect(compatibleRuntime(MIN_BUN_VERSION)).toBe(true);
    expect(compatibleRuntime('1.3.11')).toBe(false);
    expect(compatibleRuntime('2.0.0')).toBe(true);
    expect(compatibleRuntime(MIN_BUN_VERSION + '-canary')).toBe(false);
  });

  test('doctor reports invalid configuration and database failures as JSON without credentials', () => temporary(async (dir) => {
    const response = await run(['doctor', '--json'], dir, { CONTEXTUAL_GREP_TIMEOUT_MS: 'oops' });
    expect(response.code).toBe(1);
    const report = JSON.parse(response.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c: any) => c.name === 'configuration').message).toContain('CONTEXTUAL_GREP_TIMEOUT_MS');
    expect(report.checks.find((c: any) => c.name === 'database').status).toBe('error');
    expect(response.stdout + response.stderr).not.toContain('private-password');
  }));

  test('init merges host configuration with absolute paths and runs diagnostics; repeat is idempotent', () => temporary(async (dir) => {
    const output = join(dir, '.mcp.json');
    const unrelated = { mcpServers: { existing: { command: 'keep-me' } }, metadata: { keep: true } };
    await writeFile(output, JSON.stringify(unrelated));
    const response = await run(['init', '--json'], dir);
    expect(response.code).toBe(1); // Configuration is generated even if the DB is offline.
    const report = JSON.parse(response.stdout);
    expect(report.config).toEqual({ path: output, written: true });
    expect(report.checks.find((c: any) => c.name === 'database').status).toBe('error');
    expect(response.stdout + response.stderr).not.toContain('private-password');
    const config = JSON.parse(await readFile(output, 'utf8'));
    expect(config.mcpServers.existing).toEqual(unrelated.mcpServers.existing);
    expect(config.metadata).toEqual(unrelated.metadata);
    expect(isAbsolute(config.mcpServers.contextual.command)).toBe(true);
    expect(isAbsolute(config.mcpServers.contextual.args[1])).toBe(true);
    expect(config.mcpServers.contextual.args.at(-1)).toBe('serve');
    expect(config.mcpServers.contextual.env.CONTEXTUAL_BLOB_DIR).toBe(join(dir, 'local blobs'));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, 'local blobs'))).toEqual([]);
    const again = await run(['init', '--json'], dir);
    expect(JSON.parse(again.stdout).config.written).toBe(false);
    // JSON object ordering is not configuration drift, including nested env.
    const entry = config.mcpServers.contextual;
    config.mcpServers.contextual = { env: Object.fromEntries(Object.entries(entry.env).reverse()), args: entry.args, command: entry.command };
    const reordered = JSON.stringify(config, null, 4);
    await writeFile(output, reordered);
    const same = await run(['init', '--json'], dir);
    expect(JSON.parse(same.stdout).config.written).toBe(false);
    expect(await readFile(output, 'utf8')).toBe(reordered);
  }));

  test('init --force never serializes shell or autoloaded dotenv credentials', () => temporary(async (dir) => {
    const output = join(dir, '.mcp.json');
    await writeFile(output, JSON.stringify({ mcpServers: { contextual: { command: 'old' } } }));
    await writeFile(join(dir, '.env'), 'CONTEXTUAL_HTTP_TOKEN=dotenv-token\nFIRECRAWL_API_KEY=dotenv-firecrawl\nCONTEXTUAL_FUTURE_SECRET=dotenv-secret\n');
    const response = await run(['init', '--force', '--json'], dir, {
      VOYAGE_API_KEY: 'shell-voyage', CONTEXTUAL_VOYAGE_API_KEY: 'alias-voyage',
      CONTEXTUAL_OLLAMA_URL: 'https://user:url-password@example.test',
      CONTEXTUAL_SEARCH_TIMEOUT_MS: '12345',
    });
    const raw = await readFile(output, 'utf8');
    for (const secret of ['private-password', 'dotenv-token', 'dotenv-firecrawl', 'dotenv-secret', 'shell-voyage', 'alias-voyage', 'url-password']) {
      expect(raw + response.stdout + response.stderr).not.toContain(secret);
    }
    const env = JSON.parse(raw).mcpServers.contextual.env;
    expect(env.CONTEXTUAL_DATABASE_URL).toBeUndefined();
    expect(env.CONTEXTUAL_HTTP_TOKEN).toBeUndefined();
    expect(env.CONTEXTUAL_SEARCH_TIMEOUT_MS).toBe('12345');
    expect(JSON.parse(response.stdout).checks.find((c: any) => c.name === 'host_environment').message).toContain('inherited');
  }));

  test('MCP startup accepts extra tools and fails promptly when required tools are missing', () => temporary(async (dir) => {
    const stub = join(dir, 'server.ts');
    await writeFile(stub, `import { createInterface } from 'node:readline';
const names = JSON.parse(process.env.TOOL_NAMES!);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.id === 1 ? { tools: names.map((name: string) => ({ name })) }
    : message.id === 2 ? { content: [{ type: 'text', text: 'catalog' }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
}`);
    const required = ['cx_ls', 'cx_glob', 'cx_grep', 'cx_read', 'cx_search', 'cx_skill'];
    const check = (names: string[]) => checkMcp({ command: process.execPath, args: [stub], env: { TOOL_NAMES: JSON.stringify(names) } });
    expect((await check([...required, 'cx_future'])).status).toBe('ok');
    const start = Date.now();
    expect((await check(required.slice(0, -1))).status).toBe('error');
    expect(Date.now() - start).toBeLessThan(3000);
  }));

  test('conflicting entries require --force; malformed files and symlinks are preserved', () => temporary(async (dir) => {
    const output = join(dir, 'custom.json');
    const original = JSON.stringify({ mcpServers: { contextual: { command: 'old' }, another: { command: 'keep' } } });
    await writeFile(output, original);
    const refused = await run(['init', '--output', output], dir);
    expect(refused.stderr).toContain('--force');
    expect(await readFile(output, 'utf8')).toBe(original);
    const replaced = await run(['init', '--output', output, '--force', '--json'], dir);
    expect(JSON.parse(replaced.stdout).config.written).toBe(true);
    expect(JSON.parse(await readFile(output, 'utf8')).mcpServers.another.command).toBe('keep');
    await writeFile(output, '{bad json');
    const malformed = await run(['init', '--output', output, '--force'], dir);
    expect(malformed.code).toBe(1);
    expect(await readFile(output, 'utf8')).toBe('{bad json');
    const link = join(dir, 'linked.json');
    await symlink(output, link);
    const linked = await run(['init', '--output', link, '--force'], dir);
    expect(linked.code).toBe(1);
    expect(await readFile(output, 'utf8')).toBe('{bad json');
  }));

  test('doctor probes the configured local embedding model with synthetic text and rejects bad dimensions', () => temporary(async (dir) => {
    let invalid = false;
    const requests: any[] = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      requests.push(await req.json());
      return Response.json({ embeddings: [new Array(invalid ? 3 : 1024).fill(0.1)] });
    } });
    try {
      const env = { CONTEXTUAL_EMBED_PROVIDER: 'ollama', CONTEXTUAL_OLLAMA_URL: server.url.href, CONTEXTUAL_EMBED_MODEL: 'qwen3-embedding:0.6b' };
      const good = JSON.parse((await run(['doctor', '--json'], dir, env)).stdout);
      expect(good.checks.find((c: any) => c.name === 'embeddings').status).toBe('ok');
      expect(requests[0].input[0]).toContain('contextual connectivity check');
      expect(requests[0].dimensions).toBe(1024);
      invalid = true;
      const bad = JSON.parse((await run(['doctor', '--json'], dir, env)).stdout);
      expect(bad.checks.find((c: any) => c.name === 'embeddings').status).toBe('error');
    } finally { await server.stop(true); }
  }));
});
