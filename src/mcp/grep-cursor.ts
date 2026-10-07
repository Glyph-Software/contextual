import type { GrepPosition } from '../core/vfs/grep';
import { CursorError, decodeCursorValue, fingerprint } from './pagination';

export function encodeGrepCursor(key: string, after: GrepPosition | null): string | null {
  return after ? Buffer.from(JSON.stringify({ v: 'grep', k: fingerprint(key), ...after })).toString('base64url') : null;
}

export function decodeGrepCursor(cursor: string | undefined, key: string): GrepPosition | undefined {
  if (cursor === undefined) return undefined;
  const value = decodeCursorValue(cursor, key, 'grep');
  if (!Number.isSafeInteger(value.nodeId) || value.nodeId < 1 || !Number.isSafeInteger(value.line) || value.line < 0) throw new CursorError('Invalid grep position.');
  return { nodeId: value.nodeId, line: value.line };
}
