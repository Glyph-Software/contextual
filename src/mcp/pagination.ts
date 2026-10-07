import { createHash } from 'node:crypto';

/** Opaque, request-bound cursors. Positions are UTF-16 offsets for text,
 * entry offsets for listings. Text revisions prevent mixing document versions. */
export class CursorError extends Error {
  constructor(message: string, readonly code: 'INVALID_CURSOR' | 'STALE_CURSOR' = 'INVALID_CURSOR') { super(message); }
}

export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function encodeCursor(key: string, position: number, revision?: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: fingerprint(key), p: position, ...(revision && { r: revision }) })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, key: string, revision?: string): number | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.k !== fingerprint(key) || !Number.isSafeInteger(value.p) || value.p < 0) throw new Error();
    if (value.r !== revision) throw new CursorError('Content changed since the previous page. Restart without cursor.', 'STALE_CURSOR');
    return value.p;
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
}

/** Line offsets remain supported; cursor continues exactly, including within
 * a long line. Concatenating pages reproduces the original text byte-for-byte. */
export function textPage(content: string, key: string, budget: number, opts: { cursor?: string; offset?: number; limit?: number } = {}): TextPage {
  const revision = fingerprint(content);
  const position = decodeCursor(opts.cursor, key, revision);
  if (position !== undefined && opts.offset) throw new CursorError('Use cursor or offset, not both.');
  let start = position ?? 0;
  if (position === undefined) {
    for (let line = 0; line < (opts.offset ?? 0) && start < content.length; line++) {
      const newline = content.indexOf('\n', start);
      start = newline < 0 ? content.length : newline + 1;
    }
  }
  if (start > content.length) throw new CursorError('Cursor is past the end of the content. Restart without cursor.');
  let boundary = content.length;
  if (opts.limit !== undefined) {
    let end = start;
    for (let line = 0; line < opts.limit && end < content.length; line++) {
      const newline = content.indexOf('\n', end);
      end = newline < 0 ? content.length : newline + 1;
    }
    boundary = end;
  }
  let end = Math.min(boundary, start + budget * 4);
  if (end < boundary) {
    const newline = content.lastIndexOf('\n', end - 1);
    if (newline >= start) end = newline + 1;
  }
  // Never split a surrogate pair (e.g. an emoji) between wire responses.
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? '')) end--;
  return { text: content.slice(start, end), start, end, nextCursor: end < content.length ? encodeCursor(key, end, revision) : null };
}

/** Fit whole entries, returning the number actually displayed, not fetched. */
export function fitEntries<T>(entries: T[], render: (entry: T, index: number) => string, budget: number): { entries: T[]; body: string } {
  const lines: string[] = [];
  let chars = 0;
  for (const [index, entry] of entries.entries()) {
    const line = render(entry, index);
    if (chars + line.length + 2 > budget * 4) {
      if (!lines.length) throw new Error('One result exceeds the output budget. Narrow the request or read its file directly.');
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
