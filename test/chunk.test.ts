import { describe, expect, test } from 'bun:test';
import { blocksFromMarkdown, chunkBlocks, TARGET_TOKENS, type SourceBlock } from '../src/core/ingest/chunk';

const para = (text: string): SourceBlock => ({ kind: 'paragraph', text });
const heading = (level: number, text: string): SourceBlock => ({ kind: 'heading', level, text: `${'#'.repeat(level)} ${text}` });
const filler = (tokens: number) => 'word '.repeat(tokens * 0.8);

describe('blocksFromMarkdown', () => {
  test('never splits a fenced code block, even one containing headings', () => {
    const blocks = blocksFromMarkdown('# Title\n\n```py\n# not a heading\nx = 1\n\n# also not\n```\n\nAfter.');
    const code = blocks.filter((b) => b.kind === 'code');
    expect(code).toHaveLength(1);
    expect(code[0]!.text).toContain('x = 1');
    expect(code[0]!.text).toContain('# also not');
    expect(blocks.filter((b) => b.kind === 'heading')).toHaveLength(1);
  });

  test('closes an unterminated fence so the chunk stays valid markdown', () => {
    const blocks = blocksFromMarkdown('```js\nconst a = 1;\n');
    expect(blocks[0]!.kind).toBe('code');
    expect(blocks[0]!.text.trimEnd().endsWith('```')).toBe(true);
  });

  test('handles tilde fences and longer fences', () => {
    const blocks = blocksFromMarkdown('~~~\na\n~~~\n\ntext');
    expect(blocks[0]!.kind).toBe('code');
    expect(blocks[1]!.kind).toBe('paragraph');
  });

  test('keeps a pipe table together', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.';
    const blocks = blocksFromMarkdown(md);
    expect(blocks[0]!.kind).toBe('table');
    expect(blocks[0]!.text.split('\n')).toHaveLength(4);
  });

  test('records heading levels', () => {
    const blocks = blocksFromMarkdown('# A\n\n## B\n\n### C\n');
    expect(blocks.map((b) => b.level)).toEqual([1, 2, 3]);
  });

  test('distinguishes lists and quotes from paragraphs', () => {
    expect(blocksFromMarkdown('- one\n- two')[0]!.kind).toBe('list');
    expect(blocksFromMarkdown('> quoted')[0]!.kind).toBe('quote');
  });
});

describe('chunkBlocks: heading paths', () => {
  test('builds the full ancestor path', () => {
    const chunks = chunkBlocks([
      heading(1, 'Guide'), para('intro'),
      heading(2, 'Setup'), para('install it'),
      heading(3, 'Linux'), para('apt'),
    ]);
    expect(chunks.map((c) => c.headingPath)).toEqual([['Guide'], ['Guide', 'Setup'], ['Guide', 'Setup', 'Linux']]);
  });

  test('pops back out when a heading level rises', () => {
    const chunks = chunkBlocks([
      heading(1, 'A'), para('a'),
      heading(2, 'B'), para('b'),
      heading(1, 'C'), para('c'),
    ]);
    expect(chunks.at(-1)!.headingPath).toEqual(['C']);
  });

  test('tolerates a skipped level', () => {
    const chunks = chunkBlocks([heading(1, 'A'), para('a'), heading(3, 'C'), para('c')]);
    expect(chunks.at(-1)!.headingPath).toEqual(['A', 'C']);
  });

  test('strips markdown syntax from the stored path', () => {
    const chunks = chunkBlocks([{ kind: 'heading', level: 1, text: '# **Bold** `code`' }, para('x')]);
    expect(chunks[0]!.headingPath).toEqual(['Bold code']);
  });

  test('content with no heading gets an empty path', () => {
    expect(chunkBlocks([para('orphan')])[0]!.headingPath).toEqual([]);
  });
});

describe('chunkBlocks: sizing', () => {
  test('splits oversized sections into windows', () => {
    const chunks = chunkBlocks([heading(1, 'H'), ...Array.from({ length: 8 }, (_, i) => para(filler(200) + ` p${i}`))]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThan(TARGET_TOKENS * 2);
  });

  test('every chunk after a split still carries its heading path', () => {
    const chunks = chunkBlocks([heading(1, 'H'), heading(2, 'Sub'), ...Array.from({ length: 8 }, () => para(filler(200)))]);
    expect(chunks.every((c) => c.headingPath.join('/') === 'H/Sub')).toBe(true);
  });

  test('a code block larger than the target is kept whole', () => {
    const big = '```\n' + filler(1500) + '\n```';
    const chunks = chunkBlocks([heading(1, 'H'), { kind: 'code', text: big }]);
    const holding = chunks.filter((c) => c.content.includes('```'));
    expect(holding).toHaveLength(1);
    // Opening and closing fence both present: the block was not cut in half.
    expect((holding[0]!.content.match(/```/g) ?? []).length).toBe(2);
  });

  test('an oversized table repeats its header across bounded row batches', () => {
    const table: SourceBlock = { kind: 'table', text: '| a | b |\n| --- | --- |\n' + '| 1 | 2 |\n'.repeat(400) };
    const chunks = chunkBlocks([heading(1, 'H'), para(filler(700)), table]);
    const holding = chunks.filter((c) => c.content.includes('| --- |'));
    expect(holding.length).toBeGreaterThan(1);
    expect(holding.every((c) => c.tokenCount < TARGET_TOKENS * 1.5)).toBe(true);
    expect(holding.map((c) => c.content).join('\n').match(/\| 1 \| 2 \|/g)?.length).toBe(400);
  });

  test('windows overlap so a passage on a boundary is retrievable', () => {
    const paras = Array.from({ length: 10 }, (_, i) => para(`${filler(150)} marker${i}`));
    const chunks = chunkBlocks([heading(1, 'H'), ...paras]);
    const overlaps = chunks.slice(1).filter((c, i) => {
      const prevWords = new Set(chunks[i]!.content.match(/marker\d+/g) ?? []);
      return (c.content.match(/marker\d+/g) ?? []).some((w) => prevWords.has(w));
    });
    expect(overlaps.length).toBeGreaterThan(0);
  });

  test('a code block is not replayed into the overlap', () => {
    const chunks = chunkBlocks([
      heading(1, 'H'), para(filler(700)),
      { kind: 'code', text: '```\nUNIQUE_CODE_MARKER\n```' },
      para(filler(700)), para(filler(700)),
    ]);
    expect(chunks.filter((c) => c.content.includes('UNIQUE_CODE_MARKER'))).toHaveLength(1);
  });

  test('ordinals are contiguous from zero', () => {
    const chunks = chunkBlocks([heading(1, 'H'), ...Array.from({ length: 12 }, () => para(filler(200)))]);
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  test('empty input yields no chunks', () => {
    expect(chunkBlocks([])).toEqual([]);
    expect(chunkBlocks([para('   ')])).toEqual([]);
  });

  test('a tiny trailing section folds into the previous chunk rather than standing alone', () => {
    const chunks = chunkBlocks([para('word '.repeat(80)), para('tiny trailing marker')], { target: 100, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('tiny trailing marker');
    expect(chunks[0]!.tokenCount).toBeGreaterThan(100);
  });
});
