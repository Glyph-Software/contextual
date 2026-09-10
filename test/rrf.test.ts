import { describe, expect, test } from 'bun:test';
import { rrf, RRF_K, type Ranked } from '../src/core/search/rrf';

const list = (...keys: string[]): Ranked<string>[] => keys.map((k) => ({ key: k, item: k }));

describe('reciprocal rank fusion', () => {
  test('a single list keeps its order', () => {
    expect(rrf({ a: list('x', 'y', 'z') }).map((f) => f.key)).toEqual(['x', 'y', 'z']);
  });

  test('agreement between lists beats a single top hit', () => {
    // "b" is second in both lists; "a" is first in one and absent from the
    // other. Consensus should win — that is the whole point of fusing.
    const fused = rrf({ fts: list('a', 'b', 'c'), vec: list('d', 'b', 'e') });
    expect(fused[0]!.key).toBe('b');
    expect(fused[0]!.ranks).toEqual({ fts: 2, vec: 2 });
  });

  test('scores are the sum of 1/(k+rank)', () => {
    const fused = rrf({ fts: list('a'), vec: list('a') });
    expect(fused[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 12);
  });

  test('a hit found by one retriever still ranks', () => {
    const fused = rrf({ fts: list('a'), vec: list('b') });
    expect(fused.map((f) => f.key).sort()).toEqual(['a', 'b']);
    expect(fused.every((f) => Object.keys(f.ranks).length === 1)).toBe(true);
  });

  test('ties break deterministically, not by insertion order', () => {
    const one = rrf({ fts: list('b', 'a'), vec: list('a', 'b') }).map((f) => f.key);
    const two = rrf({ vec: list('a', 'b'), fts: list('b', 'a') }).map((f) => f.key);
    expect(one).toEqual(two);
  });

  test('empty input yields nothing', () => {
    expect(rrf({})).toEqual([]);
    expect(rrf({ fts: [] })).toEqual([]);
  });

  test('the damping constant keeps rank 1 from dominating', () => {
    // Without damping, 1/1 would beat 1/2 + 1/3. With k=60 it must not.
    const alone = rrf({ a: list('solo') })[0]!.score;
    const shared = rrf({ a: list('x', 'pair'), b: list('y', 'z', 'pair') })[0]!.score;
    expect(shared).toBeGreaterThan(alone);
  });
});
