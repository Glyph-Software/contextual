import { expect, test } from 'bun:test';
import { BoundedCache } from '../src/mcp/cache';
import { SearchPages } from '../src/mcp/search-pages';

test('search snapshots bind arguments and preserve results until their absolute expiry', () => {
  let now = 0;
  const pages = new SearchPages(new BoundedCache<{ key: string; value: string[] }>(2, 1024, 100, () => now));
  const id = pages.save('request', ['one', 'two']);
  const cursor = pages.cursor('request', id, 1);
  expect(pages.read(cursor, 'request')).toEqual({ id, start: 1, value: ['one', 'two'] });
  expect(() => pages.read(cursor, 'different filters')).toThrow('Invalid cursor');
  expect(() => pages.read('invalid', 'request')).toThrow('Invalid cursor');
  now = 99;
  expect(pages.read(cursor, 'request').value).toEqual(['one', 'two']);
  now = 100;
  try { pages.read(cursor, 'request'); throw new Error('Expected expiry'); }
  catch (err: any) { expect(err.code).toBe('EXPIRED_CURSOR'); }
});

test('cache bounds memory and evicts least recently used snapshots', () => {
  const cache = new BoundedCache<string>(2, 10);
  cache.set('a', 'first', 5);
  cache.set('b', 'second', 5);
  expect(cache.get('a')).toBe('first');
  cache.set('c', 'third', 5);
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toBe('first');
  expect(cache.set('oversized', 'large', 11)).toBe(false);
  cache.set('d', 'all the space', 10);
  expect(cache.get('a')).toBeUndefined();
  expect(cache.get('c')).toBeUndefined();
});
