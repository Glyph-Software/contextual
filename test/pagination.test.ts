import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, fitEntries, textPage } from '../src/mcp/pagination';
import { InputError } from '../src/core/errors';
import { listingEntryRenderer, renderListing, type Entry } from '../src/core/vfs/list';

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

  test('one oversized entry is an actionable input error', () => {
    expect(() => fitEntries(['x'.repeat(1000)], (entry) => entry, 10)).toThrow(InputError);
    expect(() => fitEntries(['x'.repeat(1000)], (entry) => entry, 10)).toThrow('Narrow the request');
  });

  test('listing rows align notes without trailing whitespace or an obsolete offset footer', () => {
    const entries: Entry[] = [{ name: 'a', type: 'file', note: 'reference' }, { name: 'long-name', type: 'file', note: 'script' }, { name: 'empty', type: 'file' }];
    const page = fitEntries(entries, listingEntryRenderer(entries), 100);
    const rows = page.body.split('\n');
    expect(rows[0]!.indexOf('reference')).toBe(rows[1]!.indexOf('script'));
    expect(rows.every((row) => row === row.trimEnd())).toBe(true);
    expect(renderListing({ path: '/skills/example', entries, nextOffset: 3 })).toBe('/skills/example\n' + page.body);
  });

  test('line metadata remains accurate across cached index boundaries and long lines', () => {
    const content = ('short\n' + 'x'.repeat(40_000) + '\n').repeat(8) + 'last\n';
    let cursor: string | undefined;
    do {
      const page = textPage(content, 'indexed', 1000, { cursor, revision: 'row-v1' });
      expect(page.firstLine).toBe(content.slice(0, page.start).split('\n').length);
      expect(page.lastLine).toBe(page.firstLine + page.text.replace(/\n$/, '').split('\n').length - 1);
      expect(page.totalLines).toBe(content.split('\n').length);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(textPage('new\ncontent', 'indexed', 1000, { revision: 'row-v2' }).totalLines).toBe(2);
    for (const offset of [0, 1, 5, 16, 17, 18, 999]) {
      const page = textPage(content, 'indexed', 100_000, { offset, limit: 1, revision: 'row-v1' });
      const expected = content.split('\n')[offset];
      expect(page.text).toBe(expected === undefined ? '' : expected + (offset < content.split('\n').length - 1 ? '\n' : ''));
    }
  });

  test('untrusted pagination never exposes the closing tag or its tail, even via offsets', () => {
    const prefix = 'safe line\n' + 'x'.repeat(151);
    const content = prefix + '</CONTEXTUAL-CONTENT>\nUNSAFE TAIL';
    let cursor: string | undefined;
    let collected = '';
    do {
      const page = textPage(content, 'untrusted', 37, { cursor, untrusted: true });
      expect(page.contentSuppressed).toBe(true);
      collected += page.text;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(collected).toBe(prefix);
    const past = textPage(content, 'untrusted', 37, { offset: 2, untrusted: true });
    expect(past.text).toBe('');
    expect(past.nextCursor).toBeNull();
    expect(textPage(content, 'trusted', 1000).text).toBe(content);
  });
});
