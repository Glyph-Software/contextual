import { createHash } from 'node:crypto';
import { InputError } from '../core/errors';
import { BoundedCache } from './cache';
import { safeContentEnd } from './content-safety';

/** Opaque, request-bound cursors. Positions are UTF-16 offsets for text,
 * entry offsets for listings. Text revisions prevent mixing document versions. */
export class CursorError extends Error {
  constructor(message: string, readonly code: 'INVALID_CURSOR' | 'STALE_CURSOR' | 'EXPIRED_CURSOR' = 'INVALID_CURSOR') { super(message); }
}

export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function encodeCursor(key: string, position: number, revision?: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: fingerprint(key), p: position, ...(revision && { r: revision }) })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, key: string, revision?: string): number | undefined {
  if (cursor === undefined) return undefined;
  const value = decodeCursorValue(cursor, key, 1);
  if (!Number.isSafeInteger(value.p) || value.p < 0) throw new CursorError('Invalid cursor position.');
  if (value.r !== revision) throw new CursorError('Content changed since the previous page. Restart without cursor.', 'STALE_CURSOR');
  return value.p;
}

export function decodeCursorValue(cursor: string, key: string, version: string | number): Record<string, any> {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v !== version || value.k !== fingerprint(key)) throw new Error();
    return value;
  } catch (err) {
    if (err instanceof CursorError) throw err;
    throw new CursorError('Invalid cursor for this request. Keep the original arguments or restart without cursor.');
  }
}

export interface TextPage {
  text: string;
  start: number;
  end: number;
  nextCursor: string | null;
  firstLine: number;
  lastLine: number;
  totalLines: number;
  contentSuppressed: boolean;
}

const INDEX_STRIDE = 8192;
interface TextIndex { checkpoints: number[]; totalLines: number; safeEnd: number }
const indexes = new BoundedCache<TextIndex>();

function textIndex(content: string, key: string, untrusted: boolean): TextIndex {
  const cached = indexes.get(key);
  if (cached) return cached;
  const checkpoints: number[] = [];
  let count = 0, newline = content.indexOf('\n');
  for (let boundary = 0; boundary <= content.length; boundary += INDEX_STRIDE) {
    while (newline >= 0 && newline < boundary) { count++; newline = content.indexOf('\n', newline + 1); }
    checkpoints.push(count);
  }
  while (newline >= 0) { count++; newline = content.indexOf('\n', newline + 1); }
  const index = { checkpoints, totalLines: count + 1, safeEnd: untrusted ? safeContentEnd(content) : content.length };
  indexes.set(key, index, checkpoints.length * 8 + 128);
  return index;
}

function lineAt(content: string, position: number, index: TextIndex): number {
  const checkpoint = Math.floor(position / INDEX_STRIDE);
  let line = index.checkpoints[checkpoint]! + 1;
  const tail = content.slice(checkpoint * INDEX_STRIDE, position);
  for (let newline = tail.indexOf('\n'); newline >= 0; newline = tail.indexOf('\n', newline + 1)) line++;
  return line;
}

/** Locate a line via checkpoints, scanning at most one stride of text. */
function linePosition(content: string, offset: number, index: TextIndex): number {
  if (offset === 0) return 0;
  if (offset >= index.totalLines) return content.length;
  let low = 0, high = index.checkpoints.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (index.checkpoints[mid]! < offset) low = mid + 1; else high = mid;
  }
  const checkpoint = Math.max(0, low - 1);
  let position = checkpoint * INDEX_STRIDE;
  for (let line = index.checkpoints[checkpoint]!; line < offset; line++) position = content.indexOf('\n', position) + 1;
  return position;
}

/** Line offsets remain supported; cursors continue within long lines. Untrusted
 * content is checked before slicing so offsets cannot bypass a suppressed tail.
 * Database row revisions avoid rehashing the document on every page. */
export function textPage(content: string, key: string, budget: number, opts: { cursor?: string; offset?: number; limit?: number; revision?: string; untrusted?: boolean } = {}): TextPage {
  const revision = opts.revision ?? fingerprint(content);
  const index = textIndex(content, `${key}:${revision}:${!!opts.untrusted}`, !!opts.untrusted);
  const safeEnd = index.safeEnd;
  const position = decodeCursor(opts.cursor, key, revision);
  if (position !== undefined && opts.offset) throw new CursorError('Use cursor or offset, not both.');
  let start = position ?? linePosition(content, opts.offset ?? 0, index);
  if (start > content.length) throw new CursorError('Cursor is past the end of the content. Restart without cursor.');
  start = Math.min(start, safeEnd);
  let boundary = safeEnd;
  if (opts.limit !== undefined) {
    boundary = Math.min(safeEnd, linePosition(content, lineAt(content, start, index) - 1 + opts.limit, index));
  }
  let end = Math.min(boundary, start + budget * 4);
  if (end < boundary) {
    const newline = content.slice(start, end).lastIndexOf('\n');
    if (newline >= 0) end = start + newline + 1;
  }
  // Never split a surrogate pair (e.g. an emoji) between wire responses.
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(content[end] ?? '')) end--;
  return {
    text: content.slice(start, end), start, end,
    nextCursor: end < safeEnd ? encodeCursor(key, end, revision) : null,
    firstLine: lineAt(content, start, index),
    lastLine: lineAt(content, end > start && content[end - 1] === '\n' ? end - 1 : end, index),
    totalLines: index.totalLines, contentSuppressed: safeEnd < content.length,
  };
}

/** Fit whole entries, returning the number actually displayed, not fetched. */
export function fitEntries<T>(entries: T[], render: (entry: T, index: number) => string, budget: number): { entries: T[]; body: string } {
  const lines: string[] = [];
  let chars = 0;
  for (const [index, entry] of entries.entries()) {
    const line = render(entry, index);
    if (chars + line.length + 2 > budget * 4) {
      if (!lines.length) throw new InputError('One result exceeds the output budget. Narrow the request or read its file directly.');
      break;
    }
    lines.push(line);
    chars += line.length + 2;
  }
  return { entries: entries.slice(0, lines.length), body: lines.join('\n') };
}

/** This is appended AFTER formatting/capping so it cannot be truncated away. */
export function continuation(tool: string, args: Record<string, unknown>, cursor: string | null): string {
  return cursor ? `\n\n[truncated: more content available. Continue with ${tool}(${JSON.stringify({ ...args, cursor })}).]` : '';
}
