import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibleRuntime, MIN_BUN_VERSION } from '../src/cli/setup';

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
