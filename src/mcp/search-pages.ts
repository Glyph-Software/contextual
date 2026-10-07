import { randomUUID } from 'node:crypto';
import { InputError } from '../core/errors';
import { BoundedCache } from './cache';
import { CursorError, decodeCursorValue, fingerprint } from './pagination';

/** Shared across MCP server instances, including stateless HTTP requests.
 * Cache only display fields, never the full passages used for reranking. */
export class SearchPages<T> {
  constructor(private cache = new BoundedCache<{ key: string; value: T }>()) {}

  save(key: string, value: T): string {
    const id = randomUUID();
    if (!this.cache.set(id, { key, value }, Buffer.byteLength(JSON.stringify(value)) * 2)) {
      throw new InputError('Search results exceed the continuation cache budget. Lower limit or narrow the search.');
    }
    return id;
  }

  cursor(key: string, id: string, position: number): string {
    return Buffer.from(JSON.stringify({ v: 'search', k: fingerprint(key), id, p: position })).toString('base64url');
  }

  read(cursor: string, key: string): { id: string; start: number; value: T } {
    const value = decodeCursorValue(cursor, key, 'search');
    if (typeof value.id !== 'string' || !Number.isSafeInteger(value.p) || value.p < 0) throw new CursorError('Invalid search cursor.');
    const snapshot = this.cache.get(value.id);
    if (!snapshot) throw new CursorError('Search snapshot expired or was evicted. Restart without cursor.', 'EXPIRED_CURSOR');
    if (snapshot.key !== key) throw new CursorError('Search cursor belongs to a different request.');
    return { id: value.id, start: value.p, value: snapshot.value };
  }
}
