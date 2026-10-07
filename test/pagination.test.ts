import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, fitEntries, textPage } from '../src/mcp/pagination';

describe('lossless continuation', () => {
  test.each([
    'x'.repeat(10000) + 'THE END',
    '🙂'.repeat(2500) + '\r\nlast line\n',
    'first\n' + 'x'.repeat(10000) + '\nlast',
    Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'),
  ])('pages reproduce the entire input without gaps or loops', (content) => {
    let cursor: string | undefined;
    let previous = 0;
    const pieces: string[] = [];
    do {
      const page = textPage(content, 'read:file', 37, { cursor });
      expect(page.start).toBe(previous);
      expect(page.end).toBeGreaterThan(page.start);
      expect(page.text.length).toBeLessThanOrEqual(37 * 4);
      expect(page.text.isWellFormed()).toBe(true);
      pieces.push(page.text);
      previous = page.end;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pieces.join('')).toBe(content);
  });

  test('line limits get a continuation even when below the token budget', () => {
    const first = textPage('zero\none\ntwo', 'read:file', 100, { offset: 1, limit: 1 });
    expect(first.text).toBe('one\n');
    const last = textPage('zero\none\ntwo', 'read:file', 100, { cursor: first.nextCursor!, limit: 1 });
    expect(last.text).toBe('two');
    expect(last.nextCursor).toBeNull();
    expect(textPage('zero', 'read:file', 100, { offset: 10 }).nextCursor).toBeNull();
  });

  test('changed content, wrong resources and malformed cursors cannot silently skip content', () => {
    const page = textPage('x'.repeat(1000), 'read:first', 10);
    expect(() => textPage('y'.repeat(1000), 'read:first', 10, { cursor: page.nextCursor! })).toThrow('Content changed');
    expect(() => textPage('x'.repeat(1000), 'read:second', 10, { cursor: page.nextCursor! })).toThrow('Invalid cursor');
    expect(() => decodeCursor('not-json', 'ls:first')).toThrow('Invalid cursor');
    expect(() => decodeCursor(encodeCursor('ls:first', -1), 'ls:first')).toThrow('Invalid cursor');
    expect(() => textPage('x'.repeat(1000), 'read:first', 10, { cursor: page.nextCursor!, offset: 1 })).toThrow('not both');
  });

  test('directory advancement counts only entries actually displayed', () => {
    const entries = Array.from({ length: 200 }, (_, i) => `skill-${i}: ${'description '.repeat(30)}`);
    let offset = 0;
    const displayed: string[] = [];
    while (offset < entries.length) {
      const page = fitEntries(entries.slice(offset), (entry) => entry, 1000);
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThan(200);
      displayed.push(...page.entries);
      offset += page.entries.length;
    }
    expect(displayed).toEqual(entries);
  });
});
