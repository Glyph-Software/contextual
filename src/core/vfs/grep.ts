import { envNumber } from '../config';
/**
 * Literal and regex search over stored file contents.
 *
 * Distinct from `cx_search`: grep is exact and structural (find every mention
 * of a symbol), hybrid search is semantic and ranked (find passages about a
 * topic). An agent needs both, and conflating them would make one of the two
 * jobs impossible.
 *
 * Everything runs in Postgres. The file-level prefilter uses `~` / `~*`, which
 * the trigram index on `nodes.content` serves; line extraction is a lateral
 * `regexp_split_to_table`, so only matching lines cross the wire and no whole
 * document is ever loaded into this process to be scanned.
 *
 * Postgres's engine resists the classic catastrophic-backtracking patterns —
 * `(a+)+$` against a non-matching subject returns in milliseconds — but that
 * is not the same as a bound. A pattern with no indexable trigram (`.`, `a|b`)
 * degrades to a sequential scan with a regex evaluated per row, and that grows
 * with the corpus. So the query carries a statement timeout and reports the
 * cancellation as an over-expensive pattern rather than an internal error.
 *
 * The cost of running in SQL is dialect: patterns are Postgres AREs, which
 * cover everything an agent normally reaches for (`\d`, `\b`, `{n,m}`,
 * lookahead) but not named groups. Those are rejected with the engine's own
 * message.
 */
import { withStatementTimeout, isTimeout } from '../db';
import { escapeLike } from './uri';
import { decomposeGlob } from './glob';

export interface GrepMatch {
  uri: string;
  path: string;
  line: number;
  text: string;
}

export interface GrepOptions {
  pathGlob?: string;
  ignoreCase?: boolean;
  maxMatches?: number;
  /** Overrides the statement timeout, in milliseconds. */
  timeoutMs?: number;
}

/** Candidate files per query. Past this, the caller is told to narrow. */
export const MAX_FILES = 200;
const MAX_LINE_CHARS = 300;
export const DEFAULT_TIMEOUT_MS = envNumber('CONTEXTUAL_GREP_TIMEOUT_MS');

export class GrepTooExpensiveError extends Error {}

export async function grep(pattern: string, opts: GrepOptions = {}): Promise<GrepMatch[]> {
  const { ignoreCase = true, maxMatches = 60 } = opts;
  if (!pattern) throw new Error('invalid regular expression: empty pattern');

  const re = newlineSensitive(pattern);
  // The path filter is a VFS glob (`/skills/pdf/**`), but `nodes.path` holds a
  // source-relative path (`SKILL.md`). Decomposing it is what keeps a pattern
  // an agent copied out of cx_ls or cx_glob from silently matching nothing.
  const parts = opts.pathGlob === undefined ? null : decomposeGlob(opts.pathGlob);

  try {
    return await withStatementTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (sql: any) => {
      // `~*` rather than an embedded (?i): the trigram index serves both
      // operators, and a user pattern that carries its own options group
      // keeps working.
      const fileMatch = ignoreCase ? sql`n.content ~* ${re}` : sql`n.content ~ ${re}`;
      const lineMatch = ignoreCase ? sql`l.line ~* ${re}` : sql`l.line ~ ${re}`;

      return (await sql`
        WITH candidates AS (
          SELECT n.uri, n.content,
            '/' || CASE WHEN s.kind='skill' THEN 'skills/' || s.name ELSE 'docs/' || coalesce(s.collection,'default') END
                || '/' || n.path AS path
          FROM nodes n JOIN sources s ON s.id = n.source_id
          WHERE n.content IS NOT NULL
            AND (${parts === null} OR (
              (${parts?.kind == null} OR s.kind = ${parts?.kind ?? null})
              AND (${parts?.root == null} OR s.name = ${parts?.root ?? null}
                   OR coalesce(s.collection,'default') = ${parts?.root ?? null})
              AND (${!parts?.prefix} OR n.path LIKE ${`${escapeLike(parts?.prefix ?? '')}%`})
            ))
            AND ${fileMatch}
        ),
        scoped AS (
          -- The precise single-star versus double-star distinction, applied
          -- to the full VFS path that the agent actually sees.
          SELECT * FROM candidates
          WHERE ${parts === null} OR path ~ ${parts?.regexSource ?? ''}
          ORDER BY path LIMIT ${MAX_FILES}
        )
        SELECT c.uri, c.path, l.ord::int AS line, left(btrim(l.line), ${MAX_LINE_CHARS}) AS text
        FROM scoped c
        CROSS JOIN LATERAL regexp_split_to_table(c.content, E'\\n') WITH ORDINALITY AS l(line, ord)
        WHERE ${lineMatch}
        ORDER BY c.path, l.ord
        LIMIT ${maxMatches}
      `) as unknown as GrepMatch[];
    });
  } catch (err) {
    if (isTimeout(err)) {
      throw new GrepTooExpensiveError(
        `pattern /${pattern}/ took longer than ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms and was cancelled. ` +
          `Narrow it with path_glob, or use a pattern with a literal substring so the index can be used.`,
      );
    }
    const message = (err as Error).message ?? String(err);
    if (/regular expression/i.test(message)) {
      throw new Error(
        `invalid regular expression: ${message.replace(/^.*?invalid regular expression:\s*/i, '')} ` +
          `(patterns are Postgres regular expressions; named groups are not supported)`,
      );
    }
    throw err;
  }
}

/**
 * Without the `n` option, `^` and `$` only match at the ends of the whole
 * file, which is not what anyone means by grep. Postgres accepts exactly one
 * leading `(?xyz)` options group, so any the caller supplied are merged.
 */
function newlineSensitive(pattern: string): string {
  const own = /^\(\?([a-z]+)\)/.exec(pattern);
  if (!own) return `(?n)${pattern}`;
  const flags = new Set(['n', ...own[1]!]);
  return `(?${[...flags].join('')})${pattern.slice(own[0].length)}`;
}
