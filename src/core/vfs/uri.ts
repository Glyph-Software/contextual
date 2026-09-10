/**
 * The `ctx://` namespace, and the guards that keep it a namespace rather than
 * a window onto the host filesystem.
 *
 *   ctx://index                                   level-0 catalog
 *   ctx://skills/{skill}/SKILL.md
 *   ctx://skills/{skill}/references/{path}
 *   ctx://docs/{collection}/{path}
 *   ctx://docs/{collection}/{path}#chunk={id}     link-only, never listed
 *
 * Skills and documents share one tree because a skill bundle *is* a directory
 * and a corpus *is* a directory, so one `cx_read` works on both.
 */
export const SCHEME = 'ctx://';
export const INDEX_URI = 'ctx://index';

export type Realm = 'skills' | 'docs';

export interface CtxUri {
  realm: Realm;
  /** Skill name, or document collection. */
  root: string;
  /** Path inside the source root. Empty string addresses the root itself. */
  path: string;
  /** Present only on links returned by search; never listed. */
  chunk?: number;
}

export class UriError extends Error {}

/**
 * Path traversal rejection. Uploaded bundles are untrusted input and a source
 * root is a hard boundary, so this rejects rather than normalizes: silently
 * resolving `a/../b` would make two URIs address one node and break the
 * uniqueness the Resources surface depends on.
 */
export function assertSafePath(path: string): void {
  if (path === '') return;
  if (path.includes('\0')) throw new UriError('path contains a null byte');
  if (path.startsWith('/')) throw new UriError(`absolute path rejected: ${path}`);
  if (path.includes('\\')) throw new UriError(`backslash rejected in path: ${path}`);

  // Percent-encoded traversal is still traversal; decode before judging.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Filesystem names may contain a literal percent sign. URI decoding is
    // strict at parseUri; traversal checks here inspect valid escapes only.
    decoded = path.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  if (decoded !== path) assertSafePath(decoded);

  for (const seg of path.split('/')) {
    if (seg === '..') throw new UriError(`path traversal rejected: ${path}`);
    if (seg === '~' || seg.startsWith('~/')) throw new UriError(`home-relative path rejected: ${path}`);
    if (seg === '.') throw new UriError(`unnormalized path segment rejected: ${path}`);
  }
  // A Windows drive letter or a UNC prefix is an absolute escape too.
  if (/^[a-zA-Z]:/.test(path)) throw new UriError(`absolute path rejected: ${path}`);
}

/** Source names are identifiers, not paths: no separators, no traversal. */
export function assertSafeName(name: string, what = 'name'): void {
  if (!name) throw new UriError(`empty ${what}`);
  if (name.includes('/') || name.includes('\\')) throw new UriError(`${what} must not contain a path separator: ${name}`);
  if (name === '.' || name === '..' || name.startsWith('~')) throw new UriError(`invalid ${what}: ${name}`);
  if (name.includes('\0')) throw new UriError(`${what} contains a null byte`);
}

export function buildUri(realm: Realm, root: string, path = '', chunk?: number): string {
  assertSafeName(root, realm === 'skills' ? 'skill name' : 'collection');
  assertSafePath(path);
  const base = `${SCHEME}${realm}/${encodeURIComponent(root)}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
  return chunk === undefined ? base : `${base}#chunk=${chunk}`;
}

export function parseUri(uri: string): CtxUri {
  if (!uri.startsWith(SCHEME)) throw new UriError(`not a ctx:// uri: ${uri}`);
  const rest = uri.slice(SCHEME.length);
  if (!rest) throw new UriError('empty ctx:// uri');

  const hash = rest.indexOf('#');
  const body = hash === -1 ? rest : rest.slice(0, hash);
  const frag = hash === -1 ? '' : rest.slice(hash + 1);

  let chunk: number | undefined;
  if (frag) {
    const m = /^chunk=(\d+)$/.exec(frag);
    if (!m) throw new UriError(`unsupported fragment: #${frag}`);
    chunk = Number(m[1]);
  }

  if (body.includes('?')) throw new UriError('query strings are not supported; encode filename question marks');
  const [realm, encodedRoot, ...encodedSegs] = body.split('/');
  const decode = (segment: string): string => {
    try {
      const value = decodeURIComponent(segment);
      if (value.includes('/')) throw new UriError('encoded path separator rejected');
      return value;
    } catch (err) {
      if (err instanceof UriError) throw err;
      throw new UriError('malformed percent-encoding in URI');
    }
  };
  const root = encodedRoot === undefined ? undefined : decode(encodedRoot);
  const segs = encodedSegs.map(decode);
  if (realm !== 'skills' && realm !== 'docs') throw new UriError(`unknown realm: ${realm}`);
  if (!root) throw new UriError(`missing ${realm === 'skills' ? 'skill name' : 'collection'} in ${uri}`);

  const path = segs.join('/');
  assertSafeName(root, realm === 'skills' ? 'skill name' : 'collection');
  assertSafePath(path);
  return { realm, root, path, chunk };
}

/**
 * The VFS path form the filesystem tools speak (`/skills/pdf/SKILL.md`) maps
 * onto the same namespace as the URI form, so `cx_ls` output feeds `cx_read`
 * directly and a search hit is addressable both ways.
 */
export function pathToUri(vfsPath: string): string | null {
  const trimmed = vfsPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return null;
  const [realm, root, ...segs] = trimmed.split('/');
  if ((realm !== 'skills' && realm !== 'docs') || !root) return null;
  return buildUri(realm, root, segs.join('/'));
}

export function uriToPath(uri: string): string {
  const { realm, root, path } = parseUri(uri);
  return `/${realm}/${root}${path ? `/${path}` : ''}`;
}

/** Normalizes user-supplied VFS paths, rejecting escapes. `/` is the root. */
export function normalizeVfsPath(input: string): string {
  const p = (input || '/').trim();
  if (p === '/' || p === '') return '/';
  const stripped = p.replace(/^\/+/, '').replace(/\/+$/, '');
  assertSafePath(stripped);
  return `/${stripped}`;
}

/** Escape a literal path prefix for a parameterized SQL LIKE expression. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');
