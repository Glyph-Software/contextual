/**
 * Chunking.
 *
 * The unit fed to this module is a **block stream**, not serialized markdown.
 * For everything anydoc parses to a document model, `document.ts` walks the
 * model directly, so `heading_path` falls out of the tree instead of being
 * recovered by re-parsing `#` prefixes. PDFs are the exception — anydoc has no
 * document-model form for them and emits Markdown directly — so
 * `blocksFromMarkdown` reconstructs the same stream for that one path, and the
 * chunker itself never has to know which it is looking at.
 *
 * Split on heading boundaries first, then into ~800-token windows with ~100
 * tokens of overlap. A fenced code block is never split: half a
 * code fence retrieved on its own is worse than useless, because it reads as
 * valid content while being syntactically broken.
 */
import { estimateTokens } from '../tokens';

export const TARGET_TOKENS = 800;
export const OVERLAP_TOKENS = 100;
/** Below this, a trailing fragment is folded back into the previous chunk. */
export const MIN_TOKENS = 40;

export type BlockKind = 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'quote' | 'rule' | 'math';

export interface SourceBlock {
  kind: BlockKind;
  /** Markdown for this block, ready to be joined into a chunk. */
  text: string;
  /** Headings only: 1-6. */
  level?: number;
  /** Headings only: the anchor anydoc resolved, when the document has one. */
  anchor?: string;
}

export interface Chunk {
  ord: number;
  headingPath: string[];
  content: string;
  tokenCount: number;
}

/** Blocks that must never be split across chunks. */
const ATOMIC: ReadonlySet<BlockKind> = new Set<BlockKind>(['code']);

export function chunkBlocks(blocks: SourceBlock[], opts: { target?: number; overlap?: number } = {}): Chunk[] {
  const target = opts.target ?? TARGET_TOKENS;
  const overlap = opts.overlap ?? OVERLAP_TOKENS;

  const chunks: Chunk[] = [];
  let headingPath: string[] = [];
  let buffer: SourceBlock[] = [];
  let bufferTokens = 0;
  // Captured when the buffer opens, so a chunk carries the heading path it
  // started under even if a new heading arrives mid-buffer.
  let bufferHeading: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    // A buffer holding nothing but headings is not a retrievable passage —
    // "## Setup" on its own answers no question. Carry it into the next chunk
    // instead of emitting it, so the heading leads the content it introduces.
    if (buffer.every((b) => b.kind === 'heading')) return;
    const content = render(buffer);
    if (!content.trim()) { buffer = []; bufferTokens = 0; return; }
    const tokenCount = estimateTokens(content);
    const prev = chunks.at(-1);
    // A tiny trailing fragment is not independently retrievable; fold it back.
    if (prev && tokenCount < MIN_TOKENS && sameHeading(prev.headingPath, bufferHeading) && prev.tokenCount + tokenCount <= target * 1.5) {
      prev.content += `\n\n${content}`;
      prev.tokenCount = estimateTokens(prev.content);
    } else {
      chunks.push({ ord: chunks.length, headingPath: [...bufferHeading], content, tokenCount });
    }
    buffer = [];
    bufferTokens = 0;
  };

  for (const block of blocks.flatMap((b) => splitBlock(b, Math.max(1, target - Math.min(overlap, target / 4) - 40)))) {
    if (block.kind === 'heading') {
      // A heading is a natural boundary: flush, then re-root the path.
      flush();
      const level = Math.min(Math.max(block.level ?? 1, 1), 6);
      headingPath = [...headingPath.slice(0, level - 1)];
      while (headingPath.length < level - 1) headingPath.push('');
      headingPath[level - 1] = stripMarkdown(block.text);
      headingPath = headingPath.slice(0, level);
      bufferHeading = headingPath.filter(Boolean);
      // The heading text leads its own section, so the chunk reads in context.
      buffer.push(block);
      bufferTokens = estimateTokens(block.text);
      continue;
    }

    const tokens = estimateTokens(block.text);

    if (bufferTokens + tokens > target && buffer.length) {
      const carried = [...buffer];
      flush();
      // Overlap: replay the tail of the previous chunk so a passage split
      // across a boundary is still retrievable from either side. The overlap
      // is taken as *text*, not as whole blocks — a corpus of 200-token
      // paragraphs would otherwise never produce any overlap at all, since no
      // single block fits the budget. Atomic blocks are excluded: duplicating
      // a whole table or code fence spends the budget without adding recall.
      const tail = tailText(carried, overlap);
      const head = bufferHeading.length
        ? [{ kind: 'heading' as const, text: headingLine(bufferHeading), level: bufferHeading.length }]
        : [];
      buffer = [...head, ...(tail ? [{ kind: 'paragraph' as const, text: tail }] : [])];
      bufferTokens = estimateTokens(render(buffer));
    }

    // An atomic block larger than the whole target still goes in whole: a
    // split code fence is worse than an over-budget chunk.
    buffer.push(block);
    bufferTokens += tokens;

    if (bufferTokens >= target && ATOMIC.has(block.kind)) flush();
  }

  flush();
  return chunks.map((c, i) => ({ ...c, ord: i }));
}

const render = (blocks: SourceBlock[]) => blocks.map((b) => b.text).join('\n\n').trim();

/**
 * The trailing ~`overlap` tokens of prose from a flushed buffer, snapped to a
 * sentence or line boundary so the replayed text reads as language rather than
 * starting mid-word.
 */
function tailText(blocks: SourceBlock[], overlap: number): string {
  const usable: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'heading' || b.kind === 'table' || ATOMIC.has(b.kind)) break;
    usable.unshift(b.text);
  }
  const joined = usable.join('\n\n').trim();
  if (!joined) return '';

  const limit = overlap * 4;
  if (joined.length <= limit) return joined;

  const cut = joined.slice(joined.length - limit);
  const boundary = cut.search(/(?<=[.!?])\s+|\n/);
  return (boundary === -1 ? cut : cut.slice(boundary)).trim();
}
const sameHeading = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const headingLine = (path: string[]) => `${'#'.repeat(Math.min(path.length, 6))} ${path.at(-1) ?? ''}`;
const stripMarkdown = (s: string) => s.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();

/**
 * Reconstructs a block stream from Markdown. Used for PDFs, for `.md` files in
 * a skill bundle, and for HTML that turndown has already converted.
 */
export function blocksFromMarkdown(md: string): SourceBlock[] {
  const lines = md.split('\n');
  const blocks: SourceBlock[] = [];
  let para: string[] = [];

  const flushPara = () => {
    const text = para.join('\n').trim();
    if (text) blocks.push({ kind: /^\s*([-*+]|\d+[.)])\s/.test(text) ? 'list' : /^\s*>/.test(text) ? 'quote' : 'paragraph', text });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code: consume to the closing fence so it is never split.
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2]!;
      const body = [line];
      let closed = false;
      for (i++; i < lines.length; i++) {
        body.push(lines[i]!);
        if (new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) { closed = true; break; }
      }
      // An unterminated fence gets one, so the chunk is still valid markdown.
      if (!closed) body.push(marker);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: 'heading', text: line.trim(), level: heading[1]!.length });
      continue;
    }

    // Reconstruct the table block; oversized tables split into row batches later.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flushPara();
      const body = [line];
      for (i++; i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]!) && lines[i]!.trim() !== ''; i++) body.push(lines[i]!);
      i--;
      blocks.push({ kind: 'table', text: body.join('\n') });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); blocks.push({ kind: 'rule', text: '---' }); continue; }
    if (line.trim() === '') { flushPara(); continue; }
    para.push(line);
  }

  flushPara();
  return blocks;
}

/** Bound prose by sentences/items, tables by rows with a repeated header.
 * A pathological single sentence/item/row still gets a lossless hard split.
 */
export function splitBlock(block: SourceBlock, budget: number): SourceBlock[] {
  if (ATOMIC.has(block.kind) || block.kind === 'heading' || estimateTokens(block.text) <= budget) return [block];
  const limit = Math.max(4, Math.floor(budget * 4));
  if (block.kind === 'table') {
    const [header = '', delimiter = '', ...rows] = block.text.split('\n');
    const prefix = `${header}\n${delimiter}\n`;
    if (prefix.length < limit / 2 && rows.every((r) => r.length + prefix.length <= limit)) {
      const out: SourceBlock[] = [];
      let text = prefix;
      for (const row of rows) {
        if (text.length + row.length + 1 > limit && text !== prefix) {
          out.push({ ...block, text: text.trimEnd() }); text = prefix;
        }
        text += row + '\n';
      }
      if (text !== prefix) out.push({ ...block, text: text.trimEnd() });
      return out;
    }
  }
  const out: SourceBlock[] = [];
  let remaining = block.text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    // Prefer a sentence or line end; then a word end; finally a hard bound.
    const boundaries = [...window.matchAll(/[.!?]\s+|\n/g)];
    let end = boundaries.at(-1)?.index;
    let cut = end !== undefined && end > limit / 3 ? end + boundaries.at(-1)![0].length : window.lastIndexOf(' ') + 1;
    if (cut < limit / 3) cut = limit;
    // Never split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1]!)) cut--;
    out.push({ ...block, text: remaining.slice(0, cut) });
    remaining = remaining.slice(cut);
  }
  if (remaining) out.push({ ...block, text: remaining });
  return out;
}
