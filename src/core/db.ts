import { migrations } from './migrations';
import { join } from 'node:path';
import { SQL } from 'bun';
import { toSql as vectorToSql, fromSql as vectorFromSql } from 'pgvector';

export const DEFAULT_URL = 'postgres://contextual:contextual@localhost:55432/contextual';

/**
 * One lazily-created pool for the process. Bun.sql handles pooling, prepared
 * statements and transactions, so there is no `pg` dependency.
 */
let pool: SQL | undefined;

export function db(): SQL {
  pool ??= new SQL({
    url: process.env.CONTEXTUAL_DATABASE_URL ?? DEFAULT_URL,
    max: 10,
    // A dead client must not take the stdio server down with it.
    onconnect: () => {},
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.close();
  pool = undefined;
}

/** pgvector's text form, bound as a parameter rather than interpolated. */
export const toVector = (v: number[] | Float32Array): string =>
  vectorToSql(Array.from(v)) as string;

export const fromVector = (v: string | null): number[] | null =>
  v === null ? null : (vectorFromSql(v) as number[]);

/**
 * Binds a JS string array as a Postgres `text[]`.
 *
 * Explicit literals preserve a stable binding contract across Bun versions.
 * The native sql.array() still double-quotes values in our Bun 1.4.2 probe,
 * so this helper remains necessary; its round-trip contract is tested.
 * Every element is quoted and escaped, so punctuation survives intact.
 */
export function pgArray(values: readonly string[] | null | undefined): string | null {
  if (values === null || values === undefined) return null;
  return `{${values.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Small key/value table for facts the schema depends on but SQL cannot carry
 * as a constant: which text-search configuration the generated `ts` columns
 * were built with, and which embedding model produced `chunks.embedding`.
 * Both are pinned at first use so a later config change is a loud error, not
 * a corpus that silently mixes two vector spaces or two stemmers.
 */
/** Postgres `undefined_table`. Anything else is a real failure. */
const UNDEFINED_TABLE = '42P01';
/** Postgres `query_canceled`, which is what a statement timeout raises. */
export const QUERY_CANCELED = '57014';

const sqlState = (err: unknown): string | undefined => {
  const e = err as { errno?: unknown; code?: unknown };
  for (const v of [e?.errno, e?.code]) if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v);
    if (/^[0-9A-Z]{5}$/.test(s)) return s;
  }
  return undefined;
};

export async function getSetting(key: string): Promise<string | null> {
  try {
    const rows = (await db()`SELECT value FROM settings WHERE key = ${key}`) as unknown as { value: string }[];
    return rows[0]?.value ?? null;
  } catch (err) {
    // Before 002 has run there is no settings table, and "unset" is the right
    // answer. Every other error — a dead connection, a permissions problem —
    // must propagate: silently reporting an unconfigured corpus would let
    // `ftsConfig` fall back to English and `assertEmbedModel` re-pin a model
    // that is already pinned.
    if (sqlState(err) === UNDEFINED_TABLE) return null;
    throw err;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db()`INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export const DEFAULT_FTS_CONFIG = 'english';
const FTS_CONFIG_RE = /^[a-z_]+$/;

let ftsConfigCache: string | undefined;

/**
 * The text-search configuration the corpus was built with. Read once per
 * process: it is fixed at migration time and only changes with a new database.
 */
export async function ftsConfig(): Promise<string> {
  ftsConfigCache ??= (await getSetting('fts_config')) ?? DEFAULT_FTS_CONFIG;
  return ftsConfigCache;
}

/**
 * Runs `fn` with a per-statement time limit.
 *
 * `SET LOCAL` inside a transaction is the pool-safe form: Bun.sql hands out
 * pooled connections, and a bare `SET` would leak the limit into whatever
 * query borrowed that connection next. The timeout exists because a regex or
 * a vector scan the planner cannot index is bounded only by the size of the
 * corpus, and an MCP server that stops answering is worse than one that says
 * a query was too expensive.
 */
export async function withStatementTimeout<T>(ms: number, fn: (tx: SQL) => Promise<T>): Promise<T> {
  return (await db().begin(async (tx: any) => {
    await tx`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.floor(ms)))}, true)`;
    return await fn(tx as SQL);
  })) as T;
}

/** True when the error is a statement-timeout cancellation. */
export const isTimeout = (err: unknown): boolean => sqlState(err) === QUERY_CANCELED;

/** Test seam: a fresh schema in the same process must not see a stale value. */
export function resetSettingsCache(): void {
  ftsConfigCache = undefined;
}

/* -------------------------------------------------------------------------- */
/* Migrations                                                                  */
/* -------------------------------------------------------------------------- */

export interface MigrateOptions {
  /**
   * Postgres text-search configuration for the generated `tsvector` columns
   * (`english`, `german`, `simple`, …). Defaults to `CONTEXTUAL_FTS_LANGUAGE`
   * or `english`. It is baked into the schema, so it can only be chosen for a
   * fresh database; asking for a different one later is an error.
   */
  ftsConfig?: string;
}

/**
 * Applies every migration in db/migrations in filename order. Each file is
 * recorded atomically so re-running is a no-op.
 *
 * Migrations are templates with one placeholder, `{{FTS_CONFIG}}`, because a
 * generated column needs a literal configuration name and English-only FTS
 * makes hybrid search look random on any other corpus.
 */
export async function migrate(
  dir?: string,
  opts: MigrateOptions = {},
): Promise<string[]> {
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;

  const { readdir } = await import('node:fs/promises');
  const files = (dir ? (await readdir(dir)).filter((f) => f.endsWith('.sql')) : Object.keys(migrations)).sort();
  const done = new Set(
    (await sql`SELECT name FROM _migrations`).map((r: { name: string }) => r.name),
  );

  const requested = (opts.ftsConfig ?? process.env.CONTEXTUAL_FTS_LANGUAGE ?? DEFAULT_FTS_CONFIG).toLowerCase();
  if (!FTS_CONFIG_RE.test(requested)) throw new Error(`invalid text-search configuration "${requested}"`);
  // A database that already has its ts columns keeps their configuration; a
  // fresh one gets the requested language.
  const fresh = !done.has(files[0]!);
  const current = fresh ? null : (await getSetting('fts_config')) ?? DEFAULT_FTS_CONFIG;
  const config = current ?? requested;
  if (current && requested !== current && (opts.ftsConfig || process.env.CONTEXTUAL_FTS_LANGUAGE)) {
    throw new Error(
      `this database was created with the "${current}" text-search configuration; ` +
        `switching to "${requested}" needs a fresh database (the tsvector columns are generated from it)`,
    );
  }
  if (fresh) {
    const known = (await sql`SELECT 1 FROM pg_ts_config WHERE cfgname = ${config}`) as unknown as unknown[];
    if (!known.length) throw new Error(`unknown text-search configuration "${config}" (see: SELECT cfgname FROM pg_ts_config)`);
  }

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const text = (dir ? await Bun.file(join(dir, file)).text() : migrations[file]!).replaceAll('{{FTS_CONFIG}}', config);
    // Bun.sql cannot send multi-statement DDL as a prepared statement; unsafe()
    // sends it as a simple query, which is what a migration needs.
    await sql.begin(async (tx: any) => {
      await tx.unsafe(text);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
    applied.push(file);
  }
  resetSettingsCache();
  return applied;
}
