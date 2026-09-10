/**
 * Directory listing over the virtual tree. There are no real directories in
 * the schema — `nodes.path` is flat — so a listing is derived by splitting
 * paths at the requested depth, which keeps ingest from having to materialize
 * directory rows that could drift out of sync with their contents.
 */
import { db } from '../db';
import { normalizeVfsPath, escapeLike } from './uri';

export interface Entry {
  name: string;
  type: 'dir' | 'file';
  uri?: string;
  /** Skill description, doc count, or file role — whatever orients an agent here. */
  note?: string;
  sizeBytes?: number | null;
}

export interface Listing {
  path: string;
  entries: Entry[];
  /** Set when the path names nothing that exists. */
  missing?: boolean;
  nextOffset?: number;
}

export async function listPath(input: string, opts: { offset?: number; limit?: number } = {}): Promise<Listing> {
  const path = normalizeVfsPath(input);
  const sql = db();
  const offset = opts.offset ?? 0, limit = opts.limit ?? 200;
  const page = (entries: Entry[]): Listing => ({ path, entries: entries.slice(0, limit), ...(entries.length > limit ? { nextOffset: offset + limit } : {}) });

  if (path === '/') {
    const [counts] = (await sql`
      SELECT
        count(*) FILTER (WHERE kind='skill')::int                              AS skills,
        count(*) FILTER (WHERE kind='doc')::int                                AS docs,
        count(DISTINCT coalesce(collection,'default')) FILTER (WHERE kind='doc')::int              AS collections
      FROM sources`) as unknown as { skills: number; docs: number; collections: number }[];
    const { skills, docs, collections } = counts ?? { skills: 0, docs: 0, collections: 0 };
    return {
      path,
      entries: [
        { name: 'skills/', type: 'dir', note: `${skills} skill${skills === 1 ? '' : 's'}` },
        { name: 'docs/', type: 'dir', note: `${docs} doc${docs === 1 ? '' : 's'} in ${collections} collection${collections === 1 ? '' : 's'}` },
      ],
    };
  }

  const segs = path.slice(1).split('/');
  const realm = segs[0];
  if (realm !== 'skills' && realm !== 'docs') return { path, entries: [], missing: true };

  // /skills — one entry per skill, with its description.
  if (realm === 'skills' && segs.length === 1) {
    const rows = (await sql`
      SELECT sk.name, sk.description, s.status FROM skills sk
      JOIN sources s ON s.id = sk.source_id ORDER BY sk.name LIMIT ${limit + 1} OFFSET ${offset}
    `) as unknown as { name: string; description: string; status: string }[];
    return page(rows.map((r) => ({
        name: `${r.name}/`,
        type: 'dir' as const,
        note: r.status === 'ready' ? r.description : `[${r.status}] ${r.description}`,
      })));
  }

  // /docs — one entry per collection.
  if (realm === 'docs' && segs.length === 1) {
    const rows = (await sql`
      SELECT coalesce(collection,'default') AS collection, count(*)::int AS docs
      FROM sources WHERE kind='doc' GROUP BY 1 ORDER BY 1 LIMIT ${limit + 1} OFFSET ${offset}
    `) as unknown as { collection: string; docs: number }[];
    return page(rows.map((r) => ({ name: `${r.collection}/`, type: 'dir' as const, note: `${r.docs} doc${r.docs === 1 ? '' : 's'}` })));
  }

  // Deeper: list inside one source root (a skill bundle, or a collection).
  const root = segs[1];
  const prefix = segs.slice(2).join('/');
  const like = prefix ? `${escapeLike(prefix)}/%` : '%';

  const depth = prefix ? prefix.split('/').length + 1 : 1;
  const rows = await sql`
    WITH children AS (
      SELECT split_part(n.path, '/', ${depth}) AS name,
             array_length(string_to_array(n.path, '/'), 1) > ${depth} AS directory,
             n.uri, n.role, n.size_bytes
      FROM nodes n JOIN sources s ON s.id = n.source_id
      WHERE s.kind = ${realm === 'skills' ? 'skill' : 'doc'}
        AND ${realm === 'skills' ? sql`s.name = ${root}` : sql`coalesce(s.collection,'default') = ${root}`}
        AND (${prefix === ''} OR n.path LIKE ${like})
    )
    SELECT name, directory, count(*)::int AS count, min(uri) AS uri, min(role) AS role, max(size_bytes) AS size
    FROM children GROUP BY name, directory ORDER BY directory DESC, name COLLATE "C"
    LIMIT ${limit + 1} OFFSET ${offset}
  ` as unknown as { name: string; directory: boolean; count: number; uri: string; role: string; size: number }[];
  if (!rows.length) return { path, entries: [], missing: offset === 0 };
  return page(rows.map((r) => r.directory
    ? { name: `${r.name}/`, type: 'dir', note: `${r.count} files` }
    : { name: r.name, type: 'file', uri: r.uri, note: r.role, sizeBytes: r.size }));
}

export function renderListing(l: Listing): string {
  if (l.missing) return `${l.path}: no such path. Try cx_ls("/") for the catalog.`;
  if (l.entries.length === 0) return `${l.path}: empty`;
  const width = Math.max(...l.entries.map((e) => e.name.length));
  return [
    l.path,
    ...l.entries.map((e) => `  ${e.name.padEnd(width)}  ${e.note ?? ''}`.trimEnd()),
    ...(l.nextOffset === undefined ? [] : [`More entries: cx_ls(${JSON.stringify(l.path)}, offset=${l.nextOffset})`]),
  ].join('\n');
}
