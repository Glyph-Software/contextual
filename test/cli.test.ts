import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli/contextual.ts', import.meta.url));
async function run(args: string[], env: Record<string, string> = {}) {
  const process = Bun.spawn([Bun.which('bun') ?? 'bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, code };
}
describe('CLI diagnostics', () => {
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
  test('a down database explains how to start it without exposing credentials', async () => {
    const result = await run(['list'], { CONTEXTUAL_DATABASE_URL: 'postgres://sample:private-password@127.0.0.1:1/contextual' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('docker compose up -d');
    expect(result.stderr).toContain('127.0.0.1:1');
    expect(result.stderr).not.toContain('private-password');
  });
});
