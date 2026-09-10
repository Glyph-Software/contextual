import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli/contextual.ts', import.meta.url));
async function run(args: string[], env: Record<string, string> = {}) {
  const process = Bun.spawn([Bun.which('bun') ?? 'bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, code };
}
describe('CLI diagnostics', () => {
  test.each([
    [['serve', '--transport', 'sse'], '--transport must be stdio or http'],
    [['serve', '--port', '3000'], '--host and --port require --transport http'],
    [['serve', '--transport', 'http', '--port', '65536'], '--port must be an integer'],
    [['serve', '--transport', 'http', '--port', '3.5'], '--port must be an integer'],
    [['list', '--transport', 'http'], 'only valid with serve'],
  ])('rejects invalid transport arguments %j', async (args, message) => {
    const result = await run(args as string[]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message as string);
  });
  test('unknown flags report help and exit 2 without a stack trace', async () => {
    const result = await run(['--no-such-flag']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
    expect(result.stderr).not.toContain('at parseArgs');
  });
  test('configuration typos fail with the setting name', async () => {
    const result = await run(['list'], { CONTEXTUAL_GREP_TIMEOUT_MS: 'oops' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CONTEXTUAL_GREP_TIMEOUT_MS must be an integer');
  });
  test('invalid embedding providers fail before accessing the database', async () => {
    const result = await run(['reindex'], { CONTEXTUAL_EMBED_PROVIDER: 'olama' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CONTEXTUAL_EMBED_PROVIDER must be voyage, ollama, or none');
  });
  test('reindex without a provider explains both supported options', async () => {
    const result = await run(['reindex'], { CONTEXTUAL_EMBED_PROVIDER: 'none' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CONTEXTUAL_EMBED_PROVIDER=ollama');
    expect(result.stderr).toContain('VOYAGE_API_KEY');
  });
  test('a down database explains how to start it without exposing credentials', async () => {
    const result = await run(['list'], { CONTEXTUAL_DATABASE_URL: 'postgres://sample:private-password@127.0.0.1:1/contextual' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('docker compose up -d');
    expect(result.stderr).toContain('127.0.0.1:1');
    expect(result.stderr).not.toContain('private-password');
  });
});
