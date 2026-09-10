/**
 * Level 0 of the progressive-disclosure contract: the always-cheap catalog.
 *
 * An agent reads this once per session and knows everything that exists —
 * every skill's name and description, every collection's doc count and
 * summary. It must stay under BUDGET.index tokens no matter how large the
 * corpus grows, so it degrades by eliding entries and saying so, never by
 * silently growing.
 */
import { db } from '../db';
import { BUDGET, estimateTokens } from '../tokens';

export interface SkillEntry {
  name: string;
  description: string;
  status: string;
  detail: string | null;
}

export interface CollectionEntry {
  collection: string;
  /** Sources that are `ready` — the ones an agent can actually search. */
  docs: number;
  chunks: number;
  titles: string[];
  needsOcr: number;
  failed: number;
}

export interface Catalog {
  skills: SkillEntry[];
  collections: CollectionEntry[];
  problems: { name: string; collection: string | null; status: string; detail: string | null }[];
}

export async function loadCatalog(): Promise<Catalog> {
  const sql = db();

  const skills = (await sql`
    SELECT sk.name, sk.description, s.status, s.detail
    FROM skills sk JOIN sources s ON s.id = sk.source_id
    ORDER BY sk.name
  `) as unknown as SkillEntry[];

  const collections = (await sql`
    SELECT
      coalesce(s.collection, 'default')                                  AS collection,
      -- Only ready sources count as documents. A scanned PDF is known to
      -- the server but has no text, so counting it here would tell the agent
      -- there is something to search when there is not.
      count(*) FILTER (WHERE s.status = 'ready')::int                     AS docs,
      coalesce(sum(c.n), 0)::int                                         AS chunks,
      (array_agg(s.name ORDER BY s.created_at DESC)
         FILTER (WHERE s.status = 'ready'))[1:6]                         AS titles,
      count(*) FILTER (WHERE s.status = 'needs_ocr')::int                AS "needsOcr",
      count(*) FILTER (WHERE s.status = 'failed')::int                   AS failed
    FROM sources s
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM chunks ch
      JOIN nodes n2 ON n2.id = ch.node_id WHERE n2.source_id = s.id
    ) c ON true
    WHERE s.kind = 'doc'
    GROUP BY 1 ORDER BY 1
  `) as unknown as CollectionEntry[];

  const problems = (await sql`
    SELECT name, collection, status, detail FROM sources
    WHERE status <> 'ready' ORDER BY name
  `) as unknown as Catalog['problems'];

  return { skills, collections, problems };
}

/**
 * Renders the catalog to its wire form. Descriptions are the expensive part —
 * a skill description may be up to 1024 chars — so when the budget is tight
 * they are clipped before any entry is dropped: knowing a skill exists is
 * worth more to an agent than reading its full description here, since
 * `cx_skill` is one call away.
 *
 * When clipping is not enough, entries are elided from whichever section is
 * currently larger — skills *or* collections — and the count held back is
 * stated. Many small collections can blow the budget just as surely as many
 * skills, and the 2k contract holds either way.
 */
export function renderCatalog(cat: Catalog, budget = BUDGET.index): string {
  const fits = (body: string) => estimateTokens(body) <= budget;
  for (const descLimit of [400, 220, 140, 90, 60]) {
    const body = render(cat, descLimit, cat.skills.length, cat.collections.length);
    if (fits(body)) return body;
  }
  // Still over: elide entries and say exactly how many were held back.
  let skills = cat.skills.length;
  let colls = cat.collections.length;
  while (skills > 1 || colls > 1) {
    if (skills >= colls && skills > 1) skills = Math.max(1, Math.floor(skills * 0.75));
    else colls = Math.max(1, Math.floor(colls * 0.75));
    const body = render(cat, 60, skills, colls);
    if (fits(body)) return body;
  }
  return render(cat, 60, 1, 1);
}

function render(cat: Catalog, descLimit: number, skillKeep: number, collKeep: number): string {
  const out: string[] = [
    '# contextual — catalog',
    '',
    'Skills and documents available through this server. Read this once; then use',
    '`cx_skill(name)` for a skill, `cx_search(queries)` to find passages, and',
    '`cx_read(uri)` for one file or chunk. Nothing else is loaded until you ask.',
    '',
  ];

  out.push(`## Skills (${cat.skills.length})`);
  if (cat.skills.length === 0) out.push('_none ingested_');
  for (const s of cat.skills.slice(0, skillKeep)) {
    out.push(`- **${s.name}** — ${clip(s.description, descLimit)}${s.status !== 'ready' ? ` _(${s.status})_` : ''}`);
  }
  if (skillKeep < cat.skills.length) {
    out.push(`- _…${cat.skills.length - skillKeep} more; use \`cx_ls("/skills")\` for the full list._`);
  }

  out.push('', `## Documents (${cat.collections.length} collection${cat.collections.length === 1 ? '' : 's'})`);
  if (cat.collections.length === 0) out.push('_none ingested_');
  for (const c of cat.collections.slice(0, collKeep)) {
    const sample = (c.titles ?? []).filter(Boolean).slice(0, 4).join(', ');
    // Not-ready sources are named separately rather than folded into the doc
    // count, so "0 docs, 3 not searchable" cannot read as "3 docs".
    const blocked = (c.needsOcr ?? 0) + (c.failed ?? 0);
    out.push(
      `- **${c.collection}** — ${c.docs} doc${c.docs === 1 ? '' : 's'}, ${c.chunks} searchable chunks` +
        (blocked ? `, ${blocked} not searchable` : '') +
        (sample ? ` · ${clip(sample, descLimit)}` : ''),
    );
  }
  if (collKeep < cat.collections.length) {
    out.push(`- _…${cat.collections.length - collKeep} more; use \`cx_ls("/docs")\` for the full list._`);
  }

  const blocked = cat.problems.filter((p) => p.status === 'needs_ocr');
  if (blocked.length) {
    out.push('', `## Not ingested (${blocked.length})`);
    for (const p of blocked.slice(0, 10)) {
      out.push(`- ${p.name} — \`${p.status}\`${p.detail ? `: ${clip(p.detail, 120)}` : ''}`);
    }
    out.push('_These are known to the server but their text was never extracted; they are not searchable._');
  }

  return out.join('\n');
}

const clip = (s: string, n: number): string =>
  !s ? '' : s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
