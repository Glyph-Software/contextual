/**
 * Glob over the virtual tree.
 *
 * A pattern is matched against the full VFS path (`/skills/pdf/SKILL.md`), so
 * an agent can glob across realms in one call. The database stores paths
 * *relative to their source root*, though, so the pattern is decomposed into
 * three parts — realm, source root, and the path inside it — and only the last
 * one becomes a `LIKE` prefix. Matching `n.path LIKE 'widget-press/%'` against
 * a column that holds `SKILL.md` is the bug this decomposition exists to
 * prevent.
 *
 * `LIKE` cannot express `*` (no separator) versus `**` (any), so SQL is only a
 * prefilter; the precise distinction is applied to the rows it returns.
 */
import { db } from '../db';
import { normalizeVfsPath, escapeLike } from './uri';

export interface GlobHit {
  path: string;
  uri: string;
  role: string;
  sizeBytes: number | null;
}

/**
 * Translates a glob to a regex *source string*, honouring the `*` / `**`
 * distinction. The source is deliberately dialect-neutral so the same
 * translation drives both a JavaScript `RegExp` and a Postgres ARE — `cx_glob`
 * filters rows in this process, `cx_grep` filters them in SQL, and the two
 * must not disagree about what `/skills/pdf/**` means.
 *
 * `.` is used for "any character": in Postgres AREs it matches a newline by
 * default, and the JS side compiles with the `s` flag, so both agree.
 */
export function globToRegExpSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories, so `**/x` also matches `x`.
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1 || pattern.slice(i + 1, end).includes('{')) throw new Error('invalid or nested brace glob');
      out += `(?:${pattern.slice(i + 1, end).split(',').map((part) => globToRegExpSource(part).slice(1, -1)).join('|')})`;
      i = end;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) throw new Error('unclosed character class in glob');
      let chars = pattern.slice(i + 1, end);
      const negate = chars.startsWith('!') || chars.startsWith('^');
      if (negate) chars = chars.slice(1);
      if (!chars || /[\\/[]/.test(chars)) throw new Error('invalid glob character class');
      out += negate ? `[^/${chars}]` : `[${chars}]`;
      i = end;
    } else out += escapeRe(c);
  }
  return `^${out}$`;
}

/** The JavaScript form. `s` so `.` spans newlines, matching Postgres's default. */
export const globToRegExp = (pattern: string): RegExp => new RegExp(globToRegExpSource(pattern), 's');

/**
 * Splits a VFS glob into the parts a SQL prefilter can use: the realm, the
 * source root, and the run of literal path segments before the first wildcard.
 * `nodes.path` is stored *relative to its source root*, so a pattern like
 * `/skills/pdf/**` has to be taken apart before any of it can touch that
 * column — matching the whole pattern against `n.path` finds nothing, because
 * that column holds `SKILL.md`, not `/skills/pdf/SKILL.md`.
 */
export interface GlobParts {
  /** Full-path regex source, for matching the built `/realm/root/path` string. */
  regexSource: string;
  kind: 'skill' | 'doc' | null;
  root: string | null;
  /** `LIKE` prefix for `nodes.path`, already relative to the source root. */
  prefix: string;
}

export function decomposeGlob(pattern: string): GlobParts {
  const full = pattern.startsWith('/') ? normalizeGlob(pattern) : `**/${normalizeGlob(pattern)}`;
  const segs = full.replace(/^\//, '').split('/');

  // Only a literal leading segment can narrow the query; `**/x` cannot.
  const realm = isLiteral(segs[0]) && (segs[0] === 'skills' || segs[0] === 'docs') ? segs[0] : null;
  const root = realm && isLiteral(segs[1]) ? segs[1]! : null;

  // The path prefix is the run of literal segments *after* the source root,
  // stopping at the first wildcard.
  let prefix = '';
  if (root) {
    const rest: string[] = [];
    for (const seg of segs.slice(2)) {
      if (!isLiteral(seg)) break;
      rest.push(seg);
    }
    // The final literal segment may be a filename rather than a directory, so
    // it is dropped from the prefix unless a wildcard follows it.
    if (rest.length && rest.length < segs.length - 2) prefix = `${rest.join('/')}/`;
  }

  return {
    regexSource: globToRegExpSource(full),
    kind: realm === null ? null : realm === 'skills' ? 'skill' : 'doc',
    root,
    prefix,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLiteral = (seg: string | undefined) => seg !== undefined && !/[*?{[]/.test(seg);

export async function glob(pattern: string, limit = 200): Promise<GlobHit[]> {
  const { kind, root, prefix, regexSource } = decomposeGlob(pattern);

  const rows = (await db()`
    SELECT
      '/' || CASE WHEN s.kind='skill' THEN 'skills/' || s.name ELSE 'docs/' || coalesce(s.collection,'default') END
          || '/' || n.path AS path,
      n.uri, n.role, n.size_bytes AS "sizeBytes"
    FROM nodes n JOIN sources s ON s.id = n.source_id
    WHERE (${kind === null} OR s.kind = ${kind})
      AND (${root === null} OR s.name = ${root} OR coalesce(s.collection,'default') = ${root})
      AND (${prefix === ''} OR n.path LIKE ${`${escapeLike(prefix)}%`})
    AND ('/' || CASE WHEN s.kind='skill' THEN 'skills/' || s.name ELSE 'docs/' || coalesce(s.collection,'default') END || '/' || n.path) ~ ${regexSource}
    ORDER BY n.path COLLATE "C"
    LIMIT ${limit}
  `) as unknown as GlobHit[];

  return rows;
}

const normalizeGlob = (p: string) => (p === '/' ? '/' : p.replace(/\/+$/, ''));

export { normalizeVfsPath };
