/**
 * `core/` is the part of the codebase that survives the move to a hosted,
 * multi-tenant transport. That only holds while nothing under it reaches
 * into `mcp/` — the moment it does, a second server drags stdio helpers and
 * SDK types into the ingest path. README promises it; this test enforces it.
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(abs)));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

describe('layering', () => {
  test('nothing under src/core imports from src/mcp', async () => {
    const root = new URL('../src/core/', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of await tsFiles(root)) {
      const text = await Bun.file(file).text();
      text.split('\n').forEach((line, i) => {
        if (/^\s*(import|export)\b.*from\s+['"][^'"]*\/mcp\//.test(line) || /^\s*import\s+['"][^'"]*\/mcp\//.test(line)) {
          offenders.push(`${file.slice(root.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('nothing under src/core imports the MCP SDK', async () => {
    const root = new URL('../src/core/', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of await tsFiles(root)) {
      const text = await Bun.file(file).text();
      if (/@modelcontextprotocol\//.test(text)) offenders.push(file.slice(root.length));
    }
    expect(offenders).toEqual([]);
  });
});
