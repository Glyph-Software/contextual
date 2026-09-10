import { describe, expect, test } from 'bun:test';
import { parseUri, buildUri, pathToUri, uriToPath, normalizeVfsPath, assertSafePath, assertSafeName, UriError } from '../src/core/vfs/uri';

describe('parseUri', () => {
  test('parses a skill file', () => {
    expect(parseUri('ctx://skills/pdf/references/forms.md')).toEqual({ realm: 'skills', root: 'pdf', path: 'references/forms.md', chunk: undefined });
  });

  test('parses a source root with an empty path', () => {
    expect(parseUri('ctx://docs/handbook').path).toBe('');
  });

  test('parses a chunk fragment', () => {
    expect(parseUri('ctx://docs/handbook/a.md#chunk=12').chunk).toBe(12);
  });

  test.each([
    ['http://example.com', /not a ctx/],
    ['ctx://', /empty/],
    ['ctx://other/x', /unknown realm/],
    ['ctx://skills', /missing skill name/],
    ['ctx://docs/handbook/a.md#page=2', /unsupported fragment/],
  ])('rejects %s', (uri, re) => {
    expect(() => parseUri(uri)).toThrow(re);
  });
});

describe('path traversal is rejected, not normalized', () => {
  // Silently resolving `a/../b` would let two URIs address one node and break
  // the uniqueness the Resources surface depends on.
  test.each([
    '../etc/passwd',
    'references/../../escape',
    'a/./b',
    '/absolute',
    '~',
    '~/secrets',
    'C:/Windows',
    'back\\slash',
    '%2e%2e/passwd',
    '%2E%2E%2Fpasswd',
  ])('rejects %s', (p) => {
    expect(() => assertSafePath(p)).toThrow(UriError);
  });

  test('rejects a null byte', () => {
    expect(() => assertSafePath('a\0b')).toThrow(/null byte/);
  });

  test('literal percent signs are valid filesystem names; malformed URIs fail', () => {
    expect(() => assertSafePath('%zz')).not.toThrow();
    expect(() => parseUri('ctx://docs/default/%zz')).toThrow(/percent-encoding/);
  });

  test.each(['', 'SKILL.md', 'references/a/b/c.md', 'file with spaces.md', 'dot.in.name.md', 'ünïcode.md'])(
    'accepts %s', (p) => { expect(() => assertSafePath(p)).not.toThrow(); },
  );

  test('reaches through a URI too', () => {
    expect(() => parseUri('ctx://skills/pdf/../../etc/passwd')).toThrow(/traversal/);
    expect(() => parseUri('ctx://skills/../x/y')).toThrow(UriError);
  });
});

describe('assertSafeName', () => {
  test.each(['a/b', 'a\\b', '.', '..', '~x', ''])('rejects %s', (n) => {
    expect(() => assertSafeName(n)).toThrow(UriError);
  });
  test('accepts a normal name', () => {
    expect(() => assertSafeName('my-skill')).not.toThrow();
  });
});

describe('round trips', () => {
  test('buildUri and parseUri agree', () => {
    const uri = buildUri('skills', 'pdf', 'references/forms.md');
    expect(uri).toBe('ctx://skills/pdf/references/forms.md');
    expect(parseUri(uri).path).toBe('references/forms.md');
  });

  test('a chunk uri keeps its fragment', () => {
    expect(buildUri('docs', 'handbook', 'a.md', 3)).toBe('ctx://docs/handbook/a.md#chunk=3');
  });

  test('VFS path and URI convert both ways', () => {
    expect(pathToUri('/skills/pdf/SKILL.md')).toBe('ctx://skills/pdf/SKILL.md');
    expect(uriToPath('ctx://skills/pdf/SKILL.md')).toBe('/skills/pdf/SKILL.md');
    expect(pathToUri('/nonsense/x')).toBeNull();
    expect(pathToUri('/')).toBeNull();
  });

  test('normalizeVfsPath collapses slashes but still rejects escapes', () => {
    expect(normalizeVfsPath('')).toBe('/');
    expect(normalizeVfsPath('//skills//')).toBe('/skills');
    expect(normalizeVfsPath('/skills/pdf/')).toBe('/skills/pdf');
    expect(() => normalizeVfsPath('/skills/../..')).toThrow(UriError);
  });
});
