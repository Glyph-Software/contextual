/**
 * Document normalization.
 *
 * Everything anydoc supports goes through `toDocument()` rather than
 * `toMarkdown()`. Stopping at the model is what makes the rest of the pipeline
 * work: it carries the heading tree the chunker needs *and* the embedded image
 * bytes tagged by media type, so a `.docx` and a `.pptx` produce
 * identically-shaped output and Markdown is serialized from the same model.
 *
 * Two documented exceptions:
 *
 * - **PDF has no document-model form.** anydoc converts PDFs with
 *   pdf-inspector, which emits Markdown directly; `toDocument()` on a PDF
 *   rejects with `unsupported`. So the PDF path takes `toMarkdownBytes()` and
 *   reconstructs the block stream from the Markdown. Heading paths survive
 *   because pdf-inspector emits ATX headings.
 * - **HTML is not an anydoc format**, so it keeps the readability + turndown
 *   path.
 */
import { toDocument, toMarkdownBytes, formatFromBytes, formatFromPath } from '@firecrawl/anydoc';
import type { Document as AnyDoc, Block, Inline, Table, Cell } from '@firecrawl/anydoc';
import { decodeText } from './text';
import { blocksFromMarkdown, type SourceBlock } from './chunk';
import { ocrMode } from '../config';
import { localPdfMarkdown } from './local-ocr';

export interface NormalizedAsset {
  id: number;
  mediaType: string;
  originPart: string;
  data: Uint8Array;
}

export interface Normalized {
  blocks: SourceBlock[];
  markdown: string;
  assets: NormalizedAsset[];
  format: string;
  /** How the block stream was obtained — useful in diagnostics and tests. */
  via: 'document-model' | 'markdown' | 'html' | 'text';
}

export class NeedsOcrError extends Error {
  readonly code = 'needs_ocr';
  constructor(readonly pages: number[], readonly pageCount: number) {
    super(
      `PDF needs OCR: ${pages.length} of ${pageCount} page(s) are scanned or image-only ` +
        `(${pages.slice(0, 10).join(', ')}${pages.length > 10 ? '…' : ''}). ` +
        `Set CONTEXTUAL_OCR=local to use Tesseract and Poppler on this machine, or CONTEXTUAL_OCR=hosted to send this document to ` +
        `Firecrawl Parse instead — note that the file then leaves this machine.`,
    );
  }
}

export class UnsupportedFormatError extends Error {
  constructor(msg: string) { super(msg); }
}

export async function normalize(bytes: Uint8Array, filename: string): Promise<Normalized> {
  const format = formatFromBytes(bytes) ?? formatFromPath(filename) ?? undefined;

  const mode = ocrMode();
  // Native text extraction always runs first. Local mode never enables hosted OCR.
  const ocr = mode === 'hosted' ? ('hosted' as const) : ('reject' as const);

  if (format === 'pdf') {
    try {
      const md = await toMarkdownBytes(bytes, format, { ocr, apiKey: process.env.FIRECRAWL_API_KEY });
      return { blocks: blocksFromMarkdown(md), markdown: md, assets: [], format, via: 'markdown' };
    } catch (err) {
      const error = translate(err);
      if (mode === 'local' && error instanceof NeedsOcrError) {
        const md = await localPdfMarkdown(bytes, error.pages, error.pageCount);
        return { blocks: blocksFromMarkdown(md), markdown: md, assets: [], format, via: 'markdown' };
      }
      throw error;
    }
  }

  if (format) {
    try {
      const doc = await toDocument(bytes, format);
      const blocks = blocksFromDocument(doc);
      return {
        blocks,
        markdown: blocks.map((b) => b.text).join('\n\n') + '\n',
        assets: doc.assets.map((a) => ({ id: a.id, mediaType: a.mediaType, originPart: a.originPart, data: new Uint8Array(a.data) })),
        format,
        via: 'document-model',
      };
    } catch (err) {
      const e = err as { code?: string };
      // A format whose model form is unsupported can still yield Markdown.
      if (e.code === 'unsupported') {
        const md = await toMarkdownBytes(bytes, format, { ocr, apiKey: process.env.FIRECRAWL_API_KEY }).catch((e2) => { throw translate(e2); });
        return { blocks: blocksFromMarkdown(md), markdown: md, assets: [], format, via: 'markdown' };
      }
      throw translate(err);
    }
  }

  // Plain text and markdown need no conversion at all.
  const text = decodeText(bytes);
  return { blocks: blocksFromMarkdown(text), markdown: text, assets: [], format: 'text', via: 'text' };
}

/** HTML: not an anydoc format, so readability strips chrome and turndown converts. */
export async function normalizeHtml(html: string, url?: string): Promise<Normalized> {
  const { parseHTML } = await import('linkedom');
  const { Readability } = await import('@mozilla/readability');
  const TurndownService = (await import('turndown')).default;

  const { document } = parseHTML(html);
  let content = html;
  let title = '';
  try {
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
    if (article?.content) { content = article.content; title = article.title ?? ''; }
  } catch {
    // Readability fails on fragments and non-article pages; the raw HTML is
    // still convertible, just noisier.
  }

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  const { gfm } = await import('@joplin/turndown-plugin-gfm');
  td.use(gfm);
  const md = (title ? `# ${title}\n\n` : '') + td.turndown(content);
  return { blocks: blocksFromMarkdown(md), markdown: md, assets: [], format: 'html', via: 'html' };
}

function translate(err: unknown): Error {
  const e = err as { code?: string; message?: string; pages?: number[]; pageCount?: number };
  if (e.code === 'needsOcr') return new NeedsOcrError(e.pages ?? [], e.pageCount ?? 0);
  if (e.code === 'unsupported') return new UnsupportedFormatError(e.message ?? 'unsupported format');
  return err as Error;
}

/* -------------------------------------------------------------------------- */
/* anydoc document model → block stream                                        */
/* -------------------------------------------------------------------------- */

export function blocksFromDocument(doc: AnyDoc): SourceBlock[] {
  const out: SourceBlock[] = [];
  walk(doc.blocks, out, doc);
  if (doc.notes?.length) {
    out.push({ kind: 'heading', text: '## Notes', level: 2 });
    for (const note of doc.notes) {
      const inner: SourceBlock[] = [];
      walk(note.blocks, inner, doc);
      out.push({ kind: 'paragraph', text: `[^${note.id}]: ${inner.map((b) => b.text).join(' ')}` });
    }
  }
  return out;
}

function walk(blocks: Block[], out: SourceBlock[], doc: AnyDoc, depth = 0): void {
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading': {
        const level = Math.min(Math.max(b.level ?? 1, 1), 6);
        out.push({ kind: 'heading', level, anchor: b.anchor, text: `${'#'.repeat(level)} ${inlines(b.content ?? [], doc)}` });
        break;
      }
      case 'paragraph': {
        const t = inlines(b.content ?? [], doc);
        if (t.trim()) out.push({ kind: 'paragraph', text: t });
        break;
      }
      case 'codeBlock':
        out.push({ kind: 'code', text: '```' + (b.lang ?? '') + '\n' + (b.text ?? '') + '\n```' });
        break;
      case 'math':
        out.push({ kind: 'math', text: `$$\n${b.text ?? ''}\n$$` });
        break;
      case 'rule':
        out.push({ kind: 'rule', text: '---' });
        break;
      case 'blockQuote': {
        const inner: SourceBlock[] = [];
        walk(b.blocks ?? [], inner, doc, depth + 1);
        out.push({ kind: 'quote', text: inner.map((x) => x.text.split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n') });
        break;
      }
      case 'list': {
        const text = renderList(b, doc, depth);
        if (text.trim()) out.push({ kind: 'list', text });
        break;
      }
      case 'table': {
        // Layout tables are positioning scaffolding, not data: flatten them so
        // their text is searchable without inventing a table that never existed.
        if (b.table && b.table.kind === 'layout') {
          for (const row of b.table.grid) {
            for (const slot of row) if (slot.kind === 'origin' && slot.cell) walk(slot.cell.blocks, out, doc, depth + 1);
          }
        } else if (b.table) {
          out.push({ kind: 'table', text: renderTable(b.table, doc) });
        }
        break;
      }
    }
  }
}

function renderList(b: Block, doc: AnyDoc, depth: number): string {
  const list = b.list;
  if (!list) return '';
  const pad = '  '.repeat(depth);
  return list.items
    .map((item, i) => {
      const marker = item.markerLabel ?? markerFor(list.marker, list.start + i);
      const inner: SourceBlock[] = [];
      walk(item.blocks, inner, doc, depth + 1);
      const body = inner.map((x) => x.text).join('\n\n');
      const [first = '', ...rest] = body.split('\n');
      return [`${pad}${marker} ${first}`, ...rest.map((l) => `${pad}  ${l}`)].join('\n');
    })
    .join('\n');
}

function markerFor(kind: string, n: number): string {
  switch (kind) {
    case 'bullet': return '-';
    case 'decimal': return `${n}.`;
    case 'lowerAlpha': return `${alpha(n).toLowerCase()}.`;
    case 'upperAlpha': return `${alpha(n)}.`;
    case 'lowerRoman': return `${roman(n).toLowerCase()}.`;
    case 'upperRoman': return `${roman(n)}.`;
    default: return '-';
  }
}

const alpha = (n: number) => String.fromCharCode(64 + Math.max(1, ((n - 1) % 26) + 1));
function roman(n: number): string {
  const table: [number, string][] = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let out = '', v = Math.max(1, n);
  for (const [num, sym] of table) while (v >= num) { out += sym; v -= num; }
  return out;
}

function renderTable(table: Table, doc: AnyDoc): string {
  const cellText = (cell: Cell | undefined): string => {
    if (!cell) return '';
    const inner: SourceBlock[] = [];
    walk(cell.blocks, inner, doc, 0);
    // Newlines and pipes would break the row; a table cell is one line.
    return inner.map((b) => b.text).join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
  };

  const rows = table.grid.map((row) =>
    row.map((slot) => (slot.kind === 'origin' ? cellText(slot.cell) : '')),
  );
  if (!rows.length) return '';

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const headerRows = Math.max(table.headerRows, 0);

  const out: string[] = [];
  if (headerRows > 0) {
    // Multiple header rows collapse into one: GFM has exactly one header row.
    const merged = pad(rows[0]!).map((_, c) =>
      rows.slice(0, headerRows).map((r) => pad(r)[c] ?? '').filter(Boolean).join(' — '));
    out.push(`| ${merged.join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`);
  } else {
    out.push(`| ${Array(width).fill('').join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`);
  }
  for (const r of rows.slice(headerRows)) out.push(`| ${pad(r).join(' | ')} |`);
  return out.join('\n');
}

function inlines(items: Inline[], doc: AnyDoc): string {
  return items
    .map((i) => {
      switch (i.kind) {
        case 'text': {
          let t = i.text ?? '';
          const s = i.style;
          if (!s || !t.trim()) return t;
          if (s.code) t = `\`${t}\``;
          if (s.bold) t = `**${t}**`;
          if (s.italic) t = `*${t}*`;
          if (s.strike) t = `~~${t}~~`;
          return t;
        }
        case 'link': {
          const label = inlines(i.content ?? [], doc);
          const target = i.target?.value ?? '';
          return target ? `[${label}](${i.target?.kind === 'anchor' ? `#${target}` : target})` : label;
        }
        case 'image': {
          const alt = i.alt ?? '';
          if (i.source?.kind === 'external') return `![${alt}](${i.source.url ?? ''})`;
          // An embedded image is stored as its own asset node, so the markdown
          // references it rather than inlining base64 into the text column.
          if (i.source?.kind === 'asset') return `![${alt}](asset:${i.source.assetId})`;
          return alt ? `![${alt}]()` : '';
        }
        case 'lineBreak': return '\n';
        case 'math': return `$${i.text ?? ''}$`;
        case 'noteRef': return `[^${i.noteId ?? ''}]`;
        case 'checkbox': return i.checked ? '[x]' : '[ ]';
        case 'anchor': return '';
        default: return i.text ?? '';
      }
    })
    .join('');
}
