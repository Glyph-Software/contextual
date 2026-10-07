import { ftsConfig, withStatementTimeout, isTimeout } from '../db';
import { InputError } from '../errors';
import { buildUri } from '../vfs/uri';
import { DEFAULT_SEARCH_TIMEOUT_MS, SearchTooExpensiveError, parseScope } from './hybrid';

export interface SkillHit { name: string; description: string; uri: string; score: number }

/** Metadata-only discovery: SKILL.md remains whole and is never a search hit. */
export async function searchSkills(queries: string[], opts: { scope?: string; limit?: number; timeoutMs?: number } = {}): Promise<SkillHit[]> {
  const scope = parseScope(opts.scope);
  if (scope.kind === 'doc') throw new InputError('Skill discovery requires a skills scope, or no scope. Use target="passages" to search documents.');
  const qs = queries.map((q) => q.trim()).filter(Boolean);
  if (!qs.length) throw new InputError('Provide at least one non-empty query.');
  const cfg = await ftsConfig();
  try {
    const rankings = await Promise.all(qs.map((query) => withStatementTimeout(opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS, async (sql) => {
      return await sql`
        WITH q AS (
          SELECT websearch_to_tsquery(${cfg}::regconfig, ${query}) AS strict,
            CASE WHEN position('!' IN websearch_to_tsquery(${cfg}::regconfig, ${query})::text) > 0
              THEN websearch_to_tsquery(${cfg}::regconfig, ${query})
              ELSE replace(plainto_tsquery(${cfg}::regconfig, ${query})::text, ' & ', ' | ')::tsquery END AS loose
        )
        SELECT sk.name, sk.description
        FROM skills sk JOIN sources s ON s.id = sk.source_id CROSS JOIN q
        WHERE s.status = 'ready' AND (${scope.name === null} OR sk.name = ${scope.name}) AND sk.ts @@ q.loose
        ORDER BY (lower(sk.name) = lower(${query})) DESC, (sk.ts @@ q.strict) DESC,
          ts_rank_cd(sk.ts, q.loose) DESC, sk.name COLLATE "C"
        LIMIT ${opts.limit ?? 8}
      ` as unknown as { name: string; description: string }[];
    })));
    const merged = new Map<string, SkillHit>();
    for (const rows of rankings) for (const [rank, row] of rows.entries()) {
      const hit = merged.get(row.name) ?? { ...row, uri: buildUri('skills', row.name, 'SKILL.md'), score: 0 };
      hit.score += 1 / (60 + rank + 1);
      merged.set(row.name, hit);
    }
    return [...merged.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, opts.limit ?? 8);
  } catch (err) {
    if (isTimeout(err)) throw new SearchTooExpensiveError('Skill discovery timed out. Use more specific terms or scope="skills/{name}".');
    throw err;
  }
}
