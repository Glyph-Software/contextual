import { envNumber } from '../config';
/**
 * Hybrid retrieval: one statement, two CTEs, fused with RRF.
 *
 * Keeping full-text and vectors in the same database is what makes this a
 * single round trip — `ts_rank_cd` over `chunks.ts` and cosine `<=>` over
 * `chunks.embedding` are evaluated together, so there is no application-side
 * join between two stores and no second network hop.
 *
 * `cx_search` accepts an array of queries and merges the results, so an agent
 * spends one round trip on a multi-part question.
 */
import { db, toVector, ftsConfig, getSetting, withStatementTimeout, isTimeout } from '../db';
import { getEmbedder } from '../ingest/embed';
import { rerank } from './rerank';
import { rrf, type Ranked } from './rrf';

export interface Hit {
  chunkId: number;
  nodeId: number;
  uri: string;
  path: string;
  headingPath: string[];
  snippet: string;
  content: string;
  sourceName: string;
  sourceKind: 'skill' | 'doc';
  collection: string | null;
  score: number;
  matchedQueries: string[];
  /** Which retrievers found it — 'fts', 'vector', or both. */
  via: string[];
}

export class SearchTooExpensiveError extends Error {}

/**
 * Ceiling on one query's SQL. A vector scan that the planner cannot serve from
 * the HNSW index — because the corpus is mid-reindex, or the filter selects a
 * slice the graph cannot narrow — is bounded only by corpus size. An MCP
 * server that stops answering is worse than one that says a query was too
 * expensive.
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = envNumber('CONTEXTUAL_SEARCH_TIMEOUT_MS');

export interface SearchOptions {
  limit?: number;
  /** Overrides the per-query statement timeout, in milliseconds. */
  timeoutMs?: number;
  /** Restrict to a realm or a source: 'skills', 'docs', or 'docs/handbook'. */
  scope?: string;
  perQuery?: number;
  /**
   * Cosine-distance ceiling for the vector half. Nearest-neighbour search
   * always returns *something*, so without a ceiling a query with no real
   * match still comes back with the least-unrelated chunks in the corpus.
   *
   * The default of 1.0 is deliberately conservative and model-agnostic: for
   * normalized embeddings it prunes only non-positive similarity — vectors
   * with no relationship at all — so it never drops a legitimately weak but
   * real match. Tighten it per-embedder if you want stricter behaviour.
   */
  maxDistance?: number;
}

export const DEFAULT_MAX_DISTANCE = envNumber('CONTEXTUAL_MAX_DISTANCE');

export async function search(queries: string[], opts: SearchOptions = {}): Promise<Hit[]> {
  const { limit = 10, perQuery = 30 } = opts;
  const qs = queries.map((q) => q.trim()).filter(Boolean);
  if (qs.length === 0) return [];

  // An invalid scope is an error, not an unscoped search: an agent that asked
  // for "handbook" and silently got the whole corpus would cite the wrong thing.
  const scope = parseScope(opts.scope);

  const embedder = getEmbedder();
  // No embedder configured is a supported mode, not an error: the FTS half of
  // the hybrid still works and skills need no embeddings at all. The same goes
  // for an embedder that does not match the model the corpus was built with —
  // its vectors live in a different space, so comparing them would be noise.
  let vectors: (string | null)[] = qs.map(() => null);
  if (embedder && (await embedderMatchesCorpus(embedder.id))) {
    try {
      vectors = (await embedder.embed(qs, 'query')).map((v) => toVector(v));
    } catch {
      vectors = qs.map(() => null);
    }
  }

  const lists: Record<string, Ranked<Hit>[]> = {};
  const byChunk = new Map<number, Hit>();

  await Promise.all(
    qs.map(async (q, i) => {
      const rows = await runOne(q, vectors[i] ?? null, perQuery, scope, opts.maxDistance ?? DEFAULT_MAX_DISTANCE, opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
      const fts: Ranked<Hit>[] = [];
      const vec: Ranked<Hit>[] = [];
      for (const r of rows) {
        const hit = byChunk.get(r.chunkId) ?? { ...r, score: 0, matchedQueries: [], via: [] };
        if (!hit.matchedQueries.includes(q)) hit.matchedQueries.push(q);
        byChunk.set(r.chunkId, hit);
        if (r.ftsRank !== null) { fts.push({ key: r.chunkId, item: hit }); if (!hit.via.includes('fts')) hit.via.push('fts'); }
        if (r.vecRank !== null) { vec.push({ key: r.chunkId, item: hit }); if (!hit.via.includes('vector')) hit.via.push('vector'); }
      }
      fts.sort((a, b) => rank(rows, a) - rank(rows, b));
      vec.sort((a, b) => vrank(rows, a) - vrank(rows, b));
      lists[`fts:${i}`] = fts;
      if (vec.length) lists[`vec:${i}`] = vec;
    }),
  );

  const candidates = rrf(lists).slice(0, Math.max(30, limit));
  let preferred: number[] = [];
  try {
    const order = await rerank(qs.join('\n'), candidates.map((c) => [c.item.sourceName, ...c.item.headingPath, c.item.content].join('\n')));
    preferred = order?.map((i) => candidates[i]!.item.chunkId) ?? [];
  } catch { /* Reranking is optional: retain deterministic fusion on failure. */ }
  return diversify(lists, qs.length, limit, 3, preferred);

}

const rank = (rows: Row[], r: Ranked<Hit>) => rows.find((x) => x.chunkId === r.key)!.ftsRank ?? Infinity;
const vrank = (rows: Row[], r: Ranked<Hit>) => rows.find((x) => x.chunkId === r.key)!.vecRank ?? Infinity;

interface Row extends Omit<Hit, 'score' | 'matchedQueries' | 'via'> {
  ftsRank: number | null;
  vecRank: number | null;
}

export async function runOne(
  query: string,
  vector: string | null,
  k: number,
  scope: Scope,
  maxDistance: number,
  timeoutMs: number,
  explain = false,
): Promise<Row[]> {
  const { kind, name } = scope;
  const cfg = await ftsConfig();

  try {
    return await withStatementTimeout(timeoutMs, async (sql: any) => {
      await sql`SELECT set_config('hnsw.ef_search', ${String(Math.min(1000, Math.max(100, 4 * k)))}, true)`;
      await sql`SET LOCAL hnsw.iterative_scan = relaxed_order`;
      if (explain) await sql`SET LOCAL enable_seqscan = off`;
      const statement = sql`
    WITH q AS (
      -- websearch_to_tsquery ANDs every term, so a natural-language question
      -- only matches a chunk containing *all* of its words — which almost no
      -- chunk does. cx_search invites exactly those questions, so matching uses
      -- an OR rewrite for recall and lets ts_rank_cd's cover density supply the
      -- precision: a chunk containing more of the query's terms, closer
      -- together, ranks above one containing a single term.
      --
      -- A negated query is left strict, because ORing a negation would match
      -- nearly the whole corpus.
      SELECT websearch_to_tsquery(${cfg}::regconfig, ${query}) AS strict,
             CASE
               WHEN websearch_to_tsquery(${cfg}::regconfig, ${query})::text LIKE '%!%'
                 THEN websearch_to_tsquery(${cfg}::regconfig, ${query})
               ELSE replace(websearch_to_tsquery(${cfg}::regconfig, ${query})::text, ' & ', ' | ')::tsquery
             END AS loose,
             ARRAY(SELECT lexeme FROM unnest(to_tsvector(${cfg}::regconfig, ${query}))) AS lexemes
    ),
    scoped AS NOT MATERIALIZED (
      SELECT c.id, c.node_id, c.ord, c.content, c.heading_path, c.embedding, c.ts,
             n.uri, n.path AS node_path, s.kind AS source_kind, s.name AS source_name, s.collection
      FROM chunks c
      JOIN nodes n ON n.id = c.node_id
      JOIN sources s ON s.id = n.source_id
      WHERE s.status = 'ready'
        AND (${kind === null} OR s.kind = ${kind})
        -- "skills/{name}" names a skill; "docs/{collection}" names a collection.
        -- Never both: docs/foo must not match a *file* called foo elsewhere.
        AND (${name === null}
             OR (${kind === 'skill'} AND s.name = ${name})
             OR (${kind === 'doc'} AND coalesce(s.collection,'default') = ${name}))
    ),
    matched AS (
      -- How many *distinct* query terms the chunk contains. This is the
      -- primary signal, because ts_rank_cd measures cover density rather than
      -- term coverage: without it, a chunk repeating one common word ("part")
      -- outranks the chunk that actually contains most of the question.
      SELECT sc.id,
             (SELECT count(*) FROM unnest(sc.ts) t WHERE t.lexeme = ANY(q.lexemes))::int AS terms,
             ts_rank_cd(sc.ts, q.loose) AS density,
             (sc.ts @@ q.strict)::int AS exact
      FROM scoped sc, q
      WHERE sc.ts @@ q.loose
    ),
    fts AS (
      SELECT id, row_number() OVER (ORDER BY exact DESC, terms DESC, density DESC, id) AS rank
      FROM matched
      ORDER BY exact DESC, terms DESC, density DESC, id
      LIMIT ${k}
    ),
    nearest AS MATERIALIZED (
      -- Keep the bare distance ORDER BY/LIMIT below the window function so
      -- pgvector can supply this candidate list from HNSW.
      SELECT id, embedding <=> ${vector}::vector AS distance
      FROM scoped
      WHERE ${vector !== null} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector LIMIT ${k}
    ),
    vec AS (
      SELECT id, row_number() OVER (ORDER BY distance + 0, id) AS rank
      FROM nearest WHERE distance <= ${maxDistance}
    ),
    selected AS (SELECT id FROM fts UNION SELECT id FROM vec)
    SELECT
      sc.id                                       AS "chunkId",
      sc.node_id                                  AS "nodeId",
      sc.uri || '#chunk=' || sc.ord               AS uri,
      '/' || CASE WHEN sc.source_kind='skill' THEN 'skills/' || sc.source_name
                  ELSE 'docs/' || coalesce(sc.collection,'default') END
           || '/' || sc.node_path                 AS path,
      sc.heading_path                             AS "headingPath",
      ts_headline(${cfg}::regconfig, sc.content, q.loose,
                  'MaxFragments=2, MaxWords=32, MinWords=12, StartSel=**, StopSel=**, FragmentDelimiter=" … "')
                                                  AS snippet,
      sc.content                                  AS content,
      sc.source_name                              AS "sourceName",
      sc.source_kind                              AS "sourceKind",
      sc.collection                               AS collection,
      fts.rank::int                               AS "ftsRank",
      vec.rank::int                               AS "vecRank"
    FROM selected JOIN scoped sc ON sc.id = selected.id
    CROSS JOIN q
    LEFT JOIN fts ON fts.id = sc.id
    LEFT JOIN vec ON vec.id = sc.id
    WHERE fts.id IS NOT NULL OR vec.id IS NOT NULL
  `;
      return (explain ? await sql`EXPLAIN (FORMAT JSON) ${statement}` : await statement) as unknown as Row[];
    });
  } catch (err) {
    if (isTimeout(err)) {
      throw new SearchTooExpensiveError(
        `search for ${JSON.stringify(query)} took longer than ${timeoutMs}ms and was cancelled. ` +
          `Narrow it with scope, or lower limit.`,
      );
    }
    throw err;
  }
}

export interface Scope {
  kind: 'skill' | 'doc' | null;
  name: string | null;
}

/**
 * `"skills"`, `"docs"`, `"skills/{name}"` or `"docs/{collection}"`. Anything
 * else throws: a scope the caller cannot express must not degrade to "all".
 */
export function parseScope(scope?: string): Scope {
  if (!scope || !scope.trim()) return { kind: null, name: null };
  const parts = scope.trim().split('/').filter(Boolean);
  const [realm, ...rest] = parts;
  const kind = realm === 'skills' ? 'skill' : realm === 'docs' ? 'doc' : null;
  if (!kind || rest.length > 1) {
    throw new Error(`invalid scope "${scope}": use "skills", "docs", "skills/{name}" or "docs/{collection}"`);
  }
  return { kind, name: rest[0] ?? null };
}

/**
 * Vectors are only comparable within one model. The corpus pins the model it
 * was embedded with (see pipeline.ts); a query embedded by anything else is
 * skipped rather than ranked against noise. Cached briefly so a search does
 * not cost an extra round trip.
 */
let pinCache: { value: string | null; at: number } | undefined;
async function embedderMatchesCorpus(id: string): Promise<boolean> {
  if (!pinCache || Date.now() - pinCache.at > 30_000) pinCache = { value: await getSetting('embed_model'), at: Date.now() };
  return pinCache.value === null || pinCache.value === id;
}

/** Test seam. */
export function resetEmbedModelCache(): void {
  pinCache = undefined;
}

/** Round-robin reservations keep independent questions represented. */
export function diversify(lists: Record<string, Ranked<Hit>[]>, queryCount: number, limit: number, maxPerDocument = 3, preferred: number[] = []): Hit[] {
  const fused = rrf(lists);
  const scores = new Map(fused.map((f) => [f.key, f.score]));
  const perQuery = Array.from({ length: queryCount }, (_, i) => rrf({ fts: lists[`fts:${i}`] ?? [], vec: lists[`vec:${i}`] ?? [] }));
  if (preferred.length) {
    const positions = new Map(preferred.map((id, i) => [id, i]));
    const compare = (a: { item: Hit }, b: { item: Hit }) => (positions.get(a.item.chunkId) ?? Infinity) - (positions.get(b.item.chunkId) ?? Infinity);
    fused.sort(compare);
    for (const queue of perQuery) queue.sort(compare);
  }
  const picked: Hit[] = [];
  const seen = new Set<number>();
  const add = (hit: Hit): boolean => {
    if (seen.has(hit.chunkId) || picked.length >= limit) return false;
    const sameDoc = picked.filter((h) => h.nodeId === hit.nodeId);
    if (sameDoc.length >= maxPerDocument || sameDoc.some((h) => overlaps(h.content, hit.content))) return false;
    seen.add(hit.chunkId);
    picked.push({ ...hit, score: scores.get(hit.chunkId) ?? 0 });
    return true;
  };
  for (let round = 0; round < Math.ceil(limit / Math.max(1, queryCount)); round++) {
    for (const queue of perQuery) {
      while (queue.length) if (add(queue.shift()!.item)) break;
    }
  }
  for (const candidate of fused) add(candidate.item);
  return picked;
}

function overlaps(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return a === b;
  const common = [...left].filter((w) => right.has(w)).length;
  return common / Math.min(left.size, right.size) > 0.85;
}
