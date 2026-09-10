import { fileURLToPath } from 'node:url';
import { schemaUrl, databaseAvailable, BASE_TEST_URL } from './helpers';
/**
 * End-to-end against a real Postgres and the real stdio server.
 *
 * These are the tests that would have caught the two bugs unit tests could not
 * see: Bun.sql's array binding, and the `sample.docx` / `sample.pdf` URI
 * collision. Both only appear once real data reaches real SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, closeDb, migrate, resetSettingsCache, toVector } from '../src/core/db';
import { ingest } from '../src/core/ingest/pipeline';
import { setEmbedder } from '../src/core/ingest/embed';
import { search } from '../src/core/search/hybrid';
import { listPath } from '../src/core/vfs/list';
import { glob } from '../src/core/vfs/glob';
import { grep } from '../src/core/vfs/grep';
import { resolveNode, resolveChunk } from '../src/core/vfs/resolve';
import { loadCatalog, renderCatalog } from '../src/core/catalog/index';
import { estimateTokens, BUDGET } from '../src/mcp/format';
import { HashEmbedder } from './helpers';

const SCHEMA = `contextual_test_${process.pid}`;
let work: string;

const describeDb = await databaseAvailable() ? describe : describe.skip;
describeDb('Postgres integration', () => {
beforeAll(async () => {
  // A dedicated schema keeps the test corpus away from the developer's own.
  await closeDb();
  resetSettingsCache();
  process.env.CONTEXTUAL_DATABASE_URL = schemaUrl(SCHEMA);
  const sql = db();
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await migrate();
  setEmbedder(new HashEmbedder());

  work = await mkdtemp(join(tmpdir(), 'contextual-test-'));
  const bundle = join(work, 'test-bundle');
  await mkdir(join(bundle, 'references'), { recursive: true });
  await mkdir(join(bundle, 'scripts'), { recursive: true });
  await mkdir(join(bundle, 'assets'), { recursive: true });
  await writeFile(join(bundle, 'SKILL.md'),
    '---\nname: widget-press\ndescription: Operates the widget press. Use when a widget must be pressed.\nallowed-tools: [Read, Bash]\nlicense: MIT\n---\n\n' +
    '# Widget Press\n\nThe press seals at 412 kelvin.\n\n## Safety\n\nAlways vent the chamber first.\n');
  await writeFile(join(bundle, 'references', 'tolerances.md'),
    '# Tolerances\n\n## Radial\n\nThe radial tolerance is 0.04 millimetres.\n\n## Axial\n\nThe axial tolerance is 0.11 millimetres.\n');
  await writeFile(join(bundle, 'scripts', 'press.py'), 'import sys\nprint("pressing", sys.argv[1])\n');
  await writeFile(join(bundle, 'assets', 'logo.bin'), Buffer.from([0, 1, 2, 3, 255]));
});

afterAll(async () => {
  try { await db().unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`); } catch { /* best effort */ }
  await closeDb();
  resetSettingsCache();
  process.env.CONTEXTUAL_DATABASE_URL = BASE_TEST_URL;
  if (work) await rm(work, { recursive: true, force: true });
});

const bundlePath = () => join(work, 'test-bundle');
const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));

describe('skill ingest', () => {
  test('ingests a bundle and classifies every file', async () => {
    const [r] = await ingest(bundlePath(), { blobDir: join(work, 'blobs') });
    expect(r!.status).toBe('ingested');
    expect(r!.kind).toBe('skill');
    expect(r!.name).toBe('widget-press');
    expect(r!.nodes).toBe(4);

    const rows = (await db()`SELECT path, role FROM nodes ORDER BY path COLLATE "C"`) as unknown as { path: string; role: string }[];
    expect(rows).toEqual([
      { path: 'SKILL.md', role: 'skill_md' },
      { path: 'assets/logo.bin', role: 'asset' },
      { path: 'references/tolerances.md', role: 'reference' },
      { path: 'scripts/press.py', role: 'script' },
    ]);
  });

  test('stores SKILL.md verbatim and unchunked', async () => {
    const node = await resolveNode('ctx://skills/widget-press/SKILL.md');
    expect(node!.content).toStartWith('---\nname: widget-press');
    expect(node!.content).toContain('412 kelvin');
    const [countRow] = (await db()`SELECT count(*)::int AS n FROM chunks WHERE node_id = ${node!.id}`) as unknown as { n: number }[];
    expect(countRow!.n).toBe(0);
  });

  test('chunks reference files with heading paths', async () => {
    const rows = (await db()`
      SELECT c.heading_path AS "headingPath" FROM chunks c JOIN nodes n ON n.id = c.node_id
      WHERE n.path = 'references/tolerances.md' ORDER BY c.ord`) as unknown as { headingPath: string[] }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.headingPath[0]).toBe('Tolerances');
  });

  test('stores frontmatter fields, including text[] arrays, without corruption', async () => {
    const [row] = (await db()`SELECT allowed_tools AS "allowedTools", license FROM skills`) as unknown as { allowedTools: string[]; license: string }[];
    expect(row!.allowedTools).toEqual(['Read', 'Bash']);
    expect(row!.license).toBe('MIT');
  });

  test('binary assets go to disk, not into the content column', async () => {
    const node = await resolveNode('ctx://skills/widget-press/assets/logo.bin');
    expect(node!.content).toBeNull();
    expect(await Bun.file(node!.blobRef!).exists()).toBe(true);
  });

  test('re-ingesting unchanged bytes is a no-op', async () => {
    const [r] = await ingest(bundlePath(), { blobDir: join(work, 'blobs') });
    expect(r!.status).toBe('unchanged');
  });

  test('re-ingesting after an edit replaces nodes instead of duplicating them', async () => {
    await writeFile(join(bundlePath(), 'references', 'extra.md'), '# Extra\n\nA new reference file.\n');
    const [r] = await ingest(bundlePath(), { blobDir: join(work, 'blobs') });
    expect(r!.status).toBe('ingested');
    const [countRow] = (await db()`SELECT count(*)::int AS n FROM nodes`) as unknown as { n: number }[];
    expect(countRow!.n).toBe(5);
  });
});

describe('document ingest', () => {
  test('a .docx goes through the document model with correct heading paths', async () => {
    const [r] = await ingest(fixture('sample.docx'), { collection: 'handbook' });
    expect(r!.status).toBe('ingested');
    const rows = (await db()`
      SELECT c.heading_path AS "headingPath" FROM chunks c JOIN nodes n ON n.id = c.node_id
      WHERE n.path = 'sample.docx.md' ORDER BY c.ord`) as unknown as { headingPath: string[] }[];
    expect(rows.map((r) => r.headingPath)).toEqual([['Quarterly Report'], ['Quarterly Report', 'Regional Breakdown']]);
  });

  test('a .docx table survives normalization', async () => {
    const node = await resolveNode('ctx://docs/handbook/sample.docx.md');
    expect(node!.content).toContain('| Region | Growth |');
    expect(node!.content).toContain('| APAC | 31% |');
  });

  test('a text-layer PDF ingests via markdown', async () => {
    const [r] = await ingest(fixture('sample.pdf'), { collection: 'handbook' });
    expect(r!.status).toBe('ingested');
    const node = await resolveNode('ctx://docs/handbook/sample.pdf.md');
    expect(node!.content).toContain('Migration Runbook');
  });

  test('a .docx and a .pdf of the same stem do not collide', async () => {
    const [countRow] = (await db()`SELECT count(*)::int AS n FROM nodes WHERE role='doc'`) as unknown as { n: number }[];
    expect(countRow!.n).toBe(2);
  });

  test('a scanned PDF lands as needs_ocr rather than ingesting empty text', async () => {
    const [r] = await ingest(fixture('scanned.pdf'), { collection: 'handbook' });
    expect(r!.status).toBe('needs_ocr');
    expect(r!.chunks).toBe(0);
    const [row] = (await db()`SELECT status, detail FROM sources WHERE name='scanned.pdf'`) as unknown as { status: string; detail: string }[];
    expect(row!.status).toBe('needs_ocr');
    expect(row!.detail).toContain('OCR');
    // Crucially, it produced no searchable content at all.
    const [countRow] = (await db()`
      SELECT count(*)::int AS n FROM chunks c JOIN nodes n2 ON n2.id = c.node_id
      JOIN sources s ON s.id = n2.source_id WHERE s.name = 'scanned.pdf'`) as unknown as { n: number }[];
    expect(countRow!.n).toBe(0);
  });

  test('HTML routes to the readability path', async () => {
    const html = join(work, 'page.html');
    await writeFile(html, '<html><head><title>Nav Doc</title></head><body><nav>menu junk</nav>' +
      '<article><h1>Turbine Notes</h1><p>The turbine idles at 3200 rpm.</p></article></body></html>');
    const [r] = await ingest(html, { collection: 'web' });
    expect(r!.status).toBe('ingested');
    const node = await resolveNode('ctx://docs/web/page.html.md');
    expect(node!.content).toContain('3200 rpm');
  });
});

describe('vfs', () => {
  test('lists the root, realms and a bundle', async () => {
    expect((await listPath('/')).entries.map((e) => e.name)).toEqual(['skills/', 'docs/']);
    expect((await listPath('/skills')).entries.map((e) => e.name)).toContain('widget-press/');
    const bundle = await listPath('/skills/widget-press');
    expect(bundle.entries.map((e) => e.name).sort()).toEqual(['SKILL.md', 'assets/', 'references/', 'scripts/']);
  });

  test('descends into a subdirectory', async () => {
    expect((await listPath('/skills/widget-press/scripts')).entries.map((e) => e.name)).toEqual(['press.py']);
  });

  test('reports a missing path instead of throwing', async () => {
    expect((await listPath('/skills/nope')).missing).toBe(true);
  });

  test('glob matches across realms and respects * versus **', async () => {
    expect((await glob('**/*.py')).map((h) => h.path)).toEqual(['/skills/widget-press/scripts/press.py']);
    expect((await glob('/skills/widget-press/*.md')).map((h) => h.path)).toEqual(['/skills/widget-press/SKILL.md']);
    expect((await glob('/skills/widget-press/**/*.md')).length).toBeGreaterThan(1);
  });

  test('grep finds exact lines with locations', async () => {
    const hits = await grep('412 kelvin');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe('/skills/widget-press/SKILL.md');
    expect(hits[0]!.line).toBeGreaterThan(0);
  });

  test('grep rejects an invalid regex rather than crashing', async () => {
    expect(grep('([')).rejects.toThrow(/invalid regular expression/);
  });

  test('grep rejects syntax Postgres cannot run instead of scanning in-process', async () => {
    expect(grep('(?<name>vent)')).rejects.toThrow(/invalid regular expression/);
  });

  test('grep anchors apply per line, not per file', async () => {
    const hits = await grep('^## Axial');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe('/skills/widget-press/references/tolerances.md');
    expect(hits[0]!.line).toBeGreaterThan(1);
    expect(await grep('millimetres\\.$')).toHaveLength(2);
  });

  test('grep honours ignore_case both ways', async () => {
    expect(await grep('KELVIN', { ignoreCase: true })).toHaveLength(1);
    expect(await grep('KELVIN', { ignoreCase: false })).toHaveLength(0);
  });

  test('grep path_glob takes the VFS path an agent copies out of cx_ls', async () => {
    // nodes.path is source-relative ("SKILL.md"), but every path the agent
    // ever sees is a full VFS path. Matching the glob against the raw column
    // is the bug this covers: it silently returned nothing.
    const scoped = await grep('tolerance', { pathGlob: '/skills/widget-press/**' });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((h) => h.path.startsWith('/skills/widget-press/'))).toBe(true);

    const refs = await grep('tolerance', { pathGlob: '/skills/widget-press/references/*.md' });
    expect(refs.map((h) => h.path)).toEqual(
      expect.arrayContaining(['/skills/widget-press/references/tolerances.md']),
    );
  });

  test('grep path_glob honours the single-star versus double-star distinction', async () => {
    // A single star does not cross a separator, so the nested reference file
    // must not match while the double-star form does.
    expect(await grep('tolerance', { pathGlob: '/skills/widget-press/*' })).toHaveLength(0);
    expect((await grep('tolerance', { pathGlob: '/skills/widget-press/**' })).length).toBeGreaterThan(0);
  });

  test('grep path_glob can select a realm, and excludes the other', async () => {
    const docs = await grep('tolerance', { pathGlob: '/docs/**' });
    expect(docs.every((h) => h.path.startsWith('/docs/'))).toBe(true);
    const skills = await grep('tolerance', { pathGlob: '/skills/**' });
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((h) => h.path.startsWith('/skills/'))).toBe(true);
  });

  test('a pattern that runs too long is cancelled with an actionable message', async () => {
    const { GrepTooExpensiveError } = await import('../src/core/vfs/grep');
    // A corpus big enough that a full regex scan cannot finish inside 1ms, so
    // the assertion is about the timeout firing rather than about machine speed.
    const big = join(work, 'big.md');
    await writeFile(big, '# Big\n\n' + Array.from({ length: 20_000 },
      (_, i) => `Line ${i} of a document that exists to make a sequential regex scan take real time.`).join('\n'));
    await ingest(big, { collection: 'bulk' });

    const err = await grep('sequential regex scan', { timeoutMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(GrepTooExpensiveError);
    expect((err as Error).message).toMatch(/cancelled/);
    expect((err as Error).message).toMatch(/path_glob/);

    // The limit was SET LOCAL, so the pooled connection is clean straight after.
    expect((await grep('412 kelvin')).length).toBe(1);

    // Leave the corpus as it was found: later assertions describe its shape.
    const { removeSource } = await import('../src/core/ingest/pipeline');
    expect(await removeSource('doc', 'big.md', 'bulk')).toBe(true);
  }, 30_000);
});

describe('statement timeouts', () => {
  test('withStatementTimeout aborts a slow statement and isTimeout recognises it', async () => {
    const { withStatementTimeout, isTimeout } = await import('../src/core/db');
    const err = await withStatementTimeout(300, async (tx: any) => tx`SELECT pg_sleep(3)`).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isTimeout(err)).toBe(true);
  }, 20_000);

  test('the limit does not leak to the next query on that pooled connection', async () => {
    const { withStatementTimeout } = await import('../src/core/db');
    await withStatementTimeout(50, async (tx: any) => tx`SELECT pg_sleep(2)`).catch(() => {});
    // Would abort if the timeout had leaked out of the transaction.
    const rows = (await db()`SELECT pg_sleep(0.4), 1 AS ok`) as unknown as { ok: number }[];
    expect(rows[0]!.ok).toBe(1);
  }, 20_000);

  test('search is bounded too, and says so rather than hanging', async () => {
    const { SearchTooExpensiveError } = await import('../src/core/search/hybrid');
    const err = await search(['radial tolerance millimetres'], { timeoutMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(SearchTooExpensiveError);
    expect((err as Error).message).toMatch(/cancelled/);
    // Normal searches keep working on the same pool afterwards.
    expect((await search(['radial tolerance millimetres'])).length).toBeGreaterThan(0);
  }, 20_000);

  test('a non-timeout SQL error is not disguised as a timeout', async () => {
    const { withStatementTimeout, isTimeout } = await import('../src/core/db');
    const err = await withStatementTimeout(5_000, async (tx: any) => tx`SELECT * FROM no_such_table_here`).catch((e) => e);
    expect(isTimeout(err)).toBe(false);
  });
});

describe('hybrid search', () => {
  beforeAll(async () => {
    const sql = db();
    const rows = (await sql`SELECT id, content FROM chunks WHERE embedding IS NULL`) as unknown as { id: number; content: string }[];
    const vectors = await new HashEmbedder().embed(rows.map((r) => r.content));
    for (let i = 0; i < rows.length; i++) {
      await sql`UPDATE chunks SET embedding = ${toVector(vectors[i]!)}::vector WHERE id = ${rows[i]!.id}`;
    }
  });

  test('finds a passage and cites it with a chunk URI', async () => {
    const hits = await search(['radial tolerance millimetres']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('0.04');
    expect(hits[0]!.uri).toMatch(/#chunk=\d+$/);
    expect(hits[0]!.headingPath).toContain('Radial');
  });

  test('uses both retrievers', async () => {
    const hits = await search(['radial tolerance millimetres']);
    expect(hits[0]!.via).toContain('fts');
    expect(hits.some((h) => h.via.includes('vector'))).toBe(true);
  });

  test('merges an array of queries in one call', async () => {
    // Both parts of the question are answered in a single round trip, from
    // two different sources.
    const hits = await search(['radial tolerance', 'failover threshold milliseconds'], { limit: 10 });
    const joined = hits.map((h) => h.content).join(' ');
    expect(joined).toContain('0.04');
    expect(joined).toContain('850');
  });

  test('SKILL.md is reachable but not chunked, so search cannot surface it', async () => {
    // By design: a skill is discovered from its description in the level-0
    // catalog, not by searching its body. Splitting SKILL.md to make it
    // searchable would fragment the instructions that make the skill work.
    const hits = await search(['vent the chamber before operating'], { scope: 'skills', limit: 20 });
    expect(hits.every((h) => !h.path.endsWith('SKILL.md'))).toBe(true);
    // It is still reachable by exact search and by cx_skill.
    expect(await grep('vent the chamber')).not.toBeEmpty();
  });

  test('a natural-language question matches without every term being present', async () => {
    // websearch_to_tsquery ANDs its terms, so this question — whose words are
    // spread across the corpus rather than concentrated in one chunk — used to
    // return nothing at all. Recall comes from an OR rewrite; precision comes
    // from ranking by distinct term coverage.
    const hits = await search(['what is the radial tolerance in millimetres for the widget press']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('0.04');
  });

  test('a chunk covering more query terms outranks one repeating a common term', async () => {
    const hits = await search(['axial tolerance millimetres'], { limit: 5 });
    expect(hits[0]!.content).toContain('0.11');
  });

  test('scope restricts the realm', async () => {
    const hits = await search(['tolerance'], { scope: 'docs' });
    expect(hits.every((h) => h.sourceKind === 'doc')).toBe(true);
  });

  test('scope names one collection or one skill, never a file that happens to share the name', async () => {
    const docs = await search(['tolerance report'], { scope: 'docs/handbook', limit: 20 });
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((h) => h.collection === 'handbook')).toBe(true);
    const skill = await search(['tolerance'], { scope: 'skills/widget-press', limit: 20 });
    expect(skill.length).toBeGreaterThan(0);
    expect(skill.every((h) => h.sourceName === 'widget-press')).toBe(true);
  });

  test('an invalid scope is an error, not an unscoped search', async () => {
    expect(search(['tolerance'], { scope: 'handbook' })).rejects.toThrow(/invalid scope/);
    expect(search(['tolerance'], { scope: 'docs/handbook/extra' })).rejects.toThrow(/invalid scope/);
  });

  test('excludes sources that are not ready', async () => {
    const hits = await search(['scanned'], { limit: 20 });
    expect(hits.every((h) => h.sourceName !== 'scanned.pdf')).toBe(true);
  });

  test('a query with no lexical match yields no full-text hits', async () => {
    // Vector search is nearest-neighbour, so it may still return weak matches
    // — that is what makes semantic recall work. What must hold is that
    // nothing is *claimed* as a full-text hit when there is none.
    const hits = await search(['zzzzqqqxx nonexistent term'], { limit: 5 });
    expect(hits.every((h) => !h.via.includes('fts'))).toBe(true);
  });

  test('the distance ceiling prunes unrelated vector hits', async () => {
    expect(await search(['zzzzqqqxx nonexistent term'], { maxDistance: 0.01 })).toEqual([]);
  });

  test('a cited chunk URI resolves back to its passage', async () => {
    const hits = await search(['radial tolerance millimetres']);
    const chunk = await resolveChunk(hits[0]!.uri);
    expect(chunk!.content).toBe(hits[0]!.content);
  });
});

describe('catalog', () => {
  test('lists skills and collections and stays under the level-0 budget', async () => {
    const cat = await loadCatalog();
    expect(cat.skills.map((s) => s.name)).toContain('widget-press');
    expect(cat.collections.map((c) => c.collection).sort()).toEqual(['handbook', 'web']);
    expect(estimateTokens(renderCatalog(cat))).toBeLessThanOrEqual(BUDGET.index);
  });

  test('surfaces a needs_ocr source as known-but-not-ingested', async () => {
    const body = renderCatalog(await loadCatalog());
    expect(body).toContain('scanned.pdf');
    expect(body).toContain('needs_ocr');
  });

  test('a source with no extractable text is not counted as a searchable doc', async () => {
    const cat = await loadCatalog();
    const handbook = cat.collections.find((c) => c.collection === 'handbook')!;
    // sample.docx and sample.pdf are ready; scanned.pdf is needs_ocr.
    expect(handbook.docs).toBe(2);
    expect(handbook.needsOcr).toBe(1);
    expect(handbook.titles).not.toContain('scanned.pdf');
    expect(renderCatalog(cat)).toContain('2 docs');
    expect(renderCatalog(cat)).toContain('1 not searchable');
  });

  test('holds the budget with many more skills than the corpus has', async () => {
    const cat = await loadCatalog();
    const inflated = {
      ...cat,
      skills: Array.from({ length: 60 }, (_, i) => ({
        name: `synthetic-skill-number-${i}`,
        description: 'A description that runs to the specification ceiling. '.repeat(18).slice(0, 1024),
        status: 'ready', detail: null,
      })),
    };
    const body = renderCatalog(inflated);
    expect(estimateTokens(body)).toBeLessThanOrEqual(BUDGET.index);
    // Degrading by clipping descriptions is fine; silently growing is not.
    expect(body).toContain('## Skills (60)');
  });

  test('holds the budget with many small collections, and says what it held back', async () => {
    const cat = await loadCatalog();
    const inflated = {
      ...cat,
      collections: Array.from({ length: 150 }, (_, i) => ({
        collection: `collection-with-a-long-name-${i}`, docs: 3, chunks: 40,
        titles: ['quarterly-report-final-v2.docx', 'onboarding-handbook.pdf', 'notes.md'], needsOcr: 0, failed: 0,
      })),
    };
    const body = renderCatalog(inflated);
    expect(estimateTokens(body)).toBeLessThanOrEqual(BUDGET.index);
    expect(body).toContain('## Documents (150 collections)');
    expect(body).toMatch(/…\d+ more; use `cx_ls\("\/docs"\)`/);
  });
});

describe('embedding safety', () => {
  const marker = 'POISONCHUNK';
  const sections = (n: number, poisoned: number) =>
    Array.from({ length: n }, (_, i) =>
      `# Section ${i}\n\n` + (i === poisoned ? `${marker} ` : '') +
      `This section talks at length about topic number ${i} so that it is comfortably larger than the minimum chunk size and is not folded into its neighbour. `.repeat(3),
    ).join('\n\n');

  afterAll(() => setEmbedder(new HashEmbedder()));

  test('a rejected input is isolated instead of nulling the whole source', async () => {
    const { EmbeddingError } = await import('../src/core/ingest/embed');
    const hash = new HashEmbedder();
    setEmbedder({
      id: hash.id, dims: hash.dims,
      async embed(texts, kind) {
        if (texts.some((t) => t.includes(marker))) throw new EmbeddingError('input', 'voyage 400: input too long');
        return hash.embed(texts);
      },
    });
    const file = join(work, 'poison.md');
    await writeFile(file, sections(3, 1));
    const [r] = await ingest(file, { collection: 'embedding' });
    expect(r!.status).toBe('ingested');
    expect(r!.chunks).toBe(3);
    expect(r!.embedded).toBe(2);
    const rows = (await db()`
      SELECT c.content LIKE ${`%${marker}%`} AS poisoned, c.embedding IS NULL AS missing
      FROM chunks c JOIN nodes n ON n.id = c.node_id JOIN sources s ON s.id = n.source_id
      WHERE s.name = 'poison.md' ORDER BY c.ord`) as unknown as { poisoned: boolean; missing: boolean }[];
    expect(rows.map((x) => x.missing)).toEqual(rows.map((x) => x.poisoned));
  });

  test('a different embedding model is refused until reindex --all', async () => {
    const hash = new HashEmbedder();
    setEmbedder({ id: 'some-other-model', dims: hash.dims, embed: (t) => hash.embed(t) });
    const file = join(work, 'other-model.md');
    await writeFile(file, sections(1, -1));
    const messages: string[] = [];
    const [r] = await ingest(file, { collection: 'embedding', onProgress: (m) => messages.push(m) });
    expect(r!.status).toBe('ingested');
    expect(r!.embedded).toBe(0);
    expect(messages.join('\n')).toContain('reindex --all');
    const [pin] = (await db()`SELECT value FROM settings WHERE key='embed_model'`) as unknown as { value: string }[];
    expect(pin!.value).toBe('hash-test');
  });
});

describe('lifecycle: renames, removal, zips', () => {
  const blobDir = () => join(work, 'blobs');

  test('a skill whose SKILL.md name changed replaces the old entry and its blobs', async () => {
    const md = await Bun.file(join(bundlePath(), 'SKILL.md')).text();
    await writeFile(join(bundlePath(), 'SKILL.md'), md.replace('name: widget-press', 'name: widget-press-v2'));
    const [r] = await ingest(bundlePath(), { blobDir: blobDir() });
    expect(r!.status).toBe('ingested');
    expect(r!.name).toBe('widget-press-v2');
    const names = (await db()`SELECT name FROM skills ORDER BY name`) as unknown as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(['widget-press-v2']);
    expect(await Bun.file(join(blobDir(), 'widget-press', 'assets', 'logo.bin')).exists()).toBe(false);
    const asset = await resolveNode('ctx://skills/widget-press-v2/assets/logo.bin');
    expect(await Bun.file(asset!.blobRef!).exists()).toBe(true);
  });

  test('a renamed document with identical bytes is reclaimed, not duplicated', async () => {
    const a = join(work, 'notes.md');
    await writeFile(a, '# Notes\n\nThe same bytes under two names.\n');
    await ingest(a, { collection: 'renames' });
    const b = join(work, 'notes-renamed.md');
    await Bun.write(b, Bun.file(a));
    await rm(a);
    const [r] = await ingest(b, { collection: 'renames' });
    expect(r!.status).toBe('ingested');
    const rows = (await db()`SELECT name FROM sources WHERE collection='renames' ORDER BY name`) as unknown as { name: string }[];
    expect(rows.map((x) => x.name)).toEqual(['notes-renamed.md']);
  });

  test('a copy whose original still exists is a second document, not a rename', async () => {
    const a = join(work, 'copy-a.md');
    const b = join(work, 'copy-b.md');
    await writeFile(a, '# Copy\n\nIdentical content, both files kept.\n');
    await Bun.write(b, Bun.file(a));
    await ingest(a, { collection: 'copies' });
    await ingest(b, { collection: 'copies' });
    const rows = (await db()`SELECT name FROM sources WHERE collection='copies' ORDER BY name`) as unknown as { name: string }[];
    expect(rows.map((x) => x.name)).toEqual(['copy-a.md', 'copy-b.md']);
  });

  test('removing a source deletes its blobs and prunes the empty directory', async () => {
    const { removeSource } = await import('../src/core/ingest/pipeline');
    expect(await removeSource('skill', 'widget-press-v2')).toBe(true);
    expect(await Bun.file(join(blobDir(), 'widget-press-v2', 'assets', 'logo.bin')).exists()).toBe(false);
    const { stat } = await import('node:fs/promises');
    expect(await stat(join(blobDir(), 'widget-press-v2')).then(() => true, () => false)).toBe(false);
    expect((await db()`SELECT count(*)::int AS n FROM skills`)[0].n).toBe(0);
  });

  test('a zipped bundle ingests, with compatibility stored', async () => {
    const src = join(work, 'zipped');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'SKILL.md'),
      '---\nname: zipped-skill\ndescription: Arrives as a zip.\ncompatibility: Needs the unzip binary and no network.\n---\n\n# Zipped\n\nHello from inside the archive.\n');
    const zip = join(work, 'zipped.zip');
    await Bun.$`zip -q -r ${zip} zipped`.cwd(work);
    const [r] = await ingest(zip, { blobDir: blobDir() });
    expect(r!.status).toBe('ingested');
    expect(r!.name).toBe('zipped-skill');
    const [row] = (await db()`SELECT compatibility, sources.origin_uri AS origin FROM skills JOIN sources ON sources.id = skills.source_id WHERE skills.name='zipped-skill'`) as unknown as { compatibility: string; origin: string }[];
    expect(row!.compatibility).toBe('Needs the unzip binary and no network.');
    // The origin is the archive the user handed us, not the temp dir it was expanded into.
    expect(row!.origin).toBe(zip);
  });

  test('a zip containing a symlink is rejected before anything is extracted', async () => {
    const src = join(work, 'linky');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'SKILL.md'), '---\nname: linky\ndescription: Has a symlink.\n---\n\n# Linky\n');
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc/passwd', join(src, 'passwd'));
    const zip = join(work, 'linky.zip');
    await Bun.$`zip -q -r -y ${zip} linky`.cwd(work);
    expect(ingest(zip, { blobDir: blobDir() })).rejects.toThrow(/symlink/);
    expect((await db()`SELECT count(*)::int AS n FROM skills WHERE name='linky'`)[0].n).toBe(0);
  });

  test('a zip with a ../ entry (zip slip) is rejected', async () => {
    const outside = join(work, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'SKILL.md'), '---\nname: slip\ndescription: Escapes.\n---\n\n# Slip\n');
    const zip = join(work, 'slip.zip');
    // Built from inside a sibling directory so the stored entry name starts with "../".
    const inner = join(work, 'slip-cwd');
    await mkdir(inner, { recursive: true });
    await Bun.$`zip -q ${zip} ../outside/SKILL.md`.cwd(inner);
    const { inspectZip } = await import('../src/core/ingest/pipeline');
    expect(inspectZip(zip)).rejects.toThrow(/unsafe entry name/);
    expect(ingest(zip, { blobDir: blobDir() })).rejects.toThrow(/unsafe entry name/);
  });

  test('a zip that is not a zip is rejected cleanly', async () => {
    const zip = join(work, 'bogus.zip');
    await writeFile(zip, 'not an archive');
    expect(ingest(zip)).rejects.toThrow(/not a readable zip/);
  });

  test('a directory of sources reports a bad member as failed and keeps going', async () => {
    const dir = join(work, 'mixed');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bogus.zip'), 'not an archive');
    await writeFile(join(dir, 'fine.md'), '# Fine\n\nThis one ingests.\n');
    const results = await ingest(dir, { collection: 'mixed' });
    expect(results.map((r) => [r.name, r.status]).sort()).toEqual([['bogus.zip', 'failed'], ['fine.md', 'ingested']]);
  });
});

describe('improvement plan regressions', () => {
  test('hybrid SQL can use both GIN and HNSW indexes', async () => {
    const { runOne } = await import('../src/core/search/hybrid');
    const vector = toVector(await new HashEmbedder().embed(['radial tolerance']).then((v) => v[0]!));
    const [source] = await db()`INSERT INTO sources(kind,name,collection,content_hash) VALUES ('doc','planner-fixture','planner','x') RETURNING id`;
    const [node] = await db()`INSERT INTO nodes(source_id,path,uri,role,content) VALUES (${source.id}, 'planner.md', 'ctx://docs/planner/planner.md', 'doc', 'planner fixture') RETURNING id`;
    await db()`INSERT INTO chunks(node_id,ord,content,embedding) SELECT ${node.id}, i, CASE WHEN i = 1 THEN 'radial tolerance' ELSE 'ordinary filler content' END, ${vector}::vector FROM generate_series(1,2500) i`;
    await db().unsafe('ANALYZE sources; ANALYZE nodes; ANALYZE chunks;');
    const plans = await runOne('radial tolerance', vector, 30, { kind: null, name: null }, 1, 10000, true);
    const plan = JSON.stringify(plans);
    expect(plan).toContain('chunks_ts_idx');
    expect(plan).toContain('chunks_embedding_idx');
    expect(plan).not.toContain('CTE Scan on scoped');
  });

  test('grep applies exact glob before its 200-file cap; glob and ls remain paginated', async () => {
    const [source] = await db()`INSERT INTO sources(kind,name,collection,content_hash) VALUES ('doc','late-files','regression','x') RETURNING id`;
    await db()`INSERT INTO nodes(source_id,path,uri,role,content)
      SELECT ${source.id}, 'a' || lpad(i::text, 3, '0') || '.md', 'ctx://docs/regression/a' || lpad(i::text, 3, '0') || '.md', 'doc', 'needle'
      FROM generate_series(1, 205) i`;
    await db()`INSERT INTO nodes(source_id,path,uri,role,content) VALUES (${source.id}, 'z.py', 'ctx://docs/regression/z.py', 'script', 'needle')`;
    expect((await grep('needle', { pathGlob: '**/*.py' })).some((r) => r.path.endsWith('/z.py'))).toBe(true);
    expect((await glob('/docs/regression/{*.py,*.txt}')).map((r) => r.path)).toContain('/docs/regression/z.py');
    const first = await listPath('/docs/regression', { limit: 100 });
    expect(first.entries).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    const second = await listPath('/docs/regression', { offset: first.nextOffset, limit: 100 });
    expect(second.entries).toHaveLength(100);
    expect(second.entries[0]!.name).not.toBe(first.entries[0]!.name);
  });

  test('literal LIKE characters do not merge sibling directories', async () => {
    const [source] = await db()`SELECT id FROM sources WHERE name='late-files'`;
    for (const path of ['a_b/file.md', 'axb/file.md', '100%/file.md', '100x/file.md']) {
      const { buildUri } = await import('../src/core/vfs/uri');
      await db()`INSERT INTO nodes(source_id,path,uri,role,content) VALUES (${source.id}, ${path}, ${buildUri('docs','regression',path)}, 'doc', 'needle')`;
    }
    expect((await listPath('/docs/regression/a_b')).entries).toHaveLength(1);
    expect((await listPath('/docs/regression/100%')).entries[0]?.uri).toContain('100%25');
  });

  test('multi-megabyte text ingests without a file tsvector and keeps its tail searchable', async () => {
    const file = join(work, 'large-manual.txt');
    const content = Array.from({ length: 140000 }, (_, i) => `lexeme${i.toString(36)} value${i.toString(36)}`).join(' ') + ' uniquetailterminus';
    await Bun.write(file, content);
    setEmbedder(null);
    try {
      const [result] = await ingest(file, { collection: 'large-regression' });
      expect(result!.status).toBe('ingested');
      expect(result!.chunks).toBeGreaterThan(500);
      const hits = await search(['uniquetailterminus'], { scope: 'docs/large-regression' });
      expect(hits[0]?.content).toContain('uniquetailterminus');
      const columns = await db()`SELECT column_name FROM information_schema.columns WHERE table_schema = ${SCHEMA} AND table_name='nodes' AND column_name='ts'`;
      expect(columns).toHaveLength(0);
    } finally { setEmbedder(new HashEmbedder()); }
  }, 30000);

  test('context prefixes are indexed and embedded without changing read content', async () => {
    const file = join(work, 'contextprefixmarker.txt');
    await Bun.write(file, '# Parent\n\n## Leaf\n\nA short passage.');
    const captured: string[] = [];
    const hash = new HashEmbedder();
    setEmbedder({ id: hash.id, dims: hash.dims, embed: async (texts) => { captured.push(...texts); return hash.embed(texts); } });
    try {
      const [result] = await ingest(file, { collection: 'prefixcollectionmarker' });
      expect(captured[0]).toContain('prefixcollectionmarker / contextprefixmarker.txt / Parent / Leaf');
      expect((await resolveNode(result!.uris[0]!))!.content).not.toContain('prefixcollectionmarker');
      setEmbedder(null);
      expect((await search(['prefixcollectionmarker'], { scope: 'docs/prefixcollectionmarker' })).length).toBeGreaterThan(0);
    } finally { setEmbedder(hash); }
  });

  test('directory add makes one bulk decision across small sources and rebuilds after failure', async () => {
    const directory = join(work, 'bulk-regression');
    await mkdir(directory);
    for (let i = 0; i < 3; i++) await Bun.write(join(directory, `bulk-${i}.txt`), `Document number ${i} about distinct mechanics.`);
    const oldThreshold = process.env.CONTEXTUAL_BULK_INDEX_THRESHOLD;
    process.env.CONTEXTUAL_BULK_INDEX_THRESHOLD = '2';
    const hash = new HashEmbedder();
    let sawDropped = false;
    setEmbedder({ id: hash.id, dims: hash.dims, embed: async () => {
      const rows = await db()`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'chunks_embedding_idx'`;
      sawDropped = rows.length === 0;
      throw new Error('simulated network failure');
    } });
    try {
      const results = await ingest(directory, { collection: 'bulk-regression' });
      expect(results).toHaveLength(3);
      expect(sawDropped).toBe(true);
      const [row] = await db()`SELECT to_regclass('chunks_embedding_idx') AS idx`;
      expect(row.idx).not.toBeNull();
    } finally {
      if (oldThreshold === undefined) delete process.env.CONTEXTUAL_BULK_INDEX_THRESHOLD; else process.env.CONTEXTUAL_BULK_INDEX_THRESHOLD = oldThreshold;
      setEmbedder(hash);
    }
  });

  test('a failed rename rolls back source deletion and staged blobs', async () => {
    const root = join(work, 'transaction-skill');
    const blobDir = join(work, 'transaction-blobs');
    await mkdir(join(root, 'assets'), { recursive: true });
    await Bun.write(join(root, 'SKILL.md'), '---\nname: transaction-old\ndescription: Transaction test\n---\nOriginal');
    await Bun.write(join(root, 'assets', 'asset.bin'), new Uint8Array([0, 1, 2]));
    await ingest(root, { blobDir });
    const oldNode = await resolveNode('ctx://skills/transaction-old/assets/asset.bin');
    await Bun.write(join(root, 'SKILL.md'), '---\nname: transaction-new\ndescription: Transaction test\n---\nUpdated');
    await Bun.write(join(root, 'assets', 'asset.bin'), new Uint8Array([0, 3, 4]));
    await db().unsafe(`CREATE FUNCTION reject_test_node() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uri LIKE '%transaction-new/assets/%' THEN RAISE EXCEPTION 'simulated write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_node BEFORE INSERT ON nodes FOR EACH ROW EXECUTE FUNCTION reject_test_node();`);
    try {
      await expect(ingest(root, { blobDir })).rejects.toThrow('simulated write failure');
      expect((await resolveNode('ctx://skills/transaction-old/SKILL.md'))!.content).toContain('Original');
      expect(await resolveNode('ctx://skills/transaction-new/SKILL.md')).toBeNull();
      expect([...await Bun.file(oldNode!.blobRef!).bytes()]).toEqual([0, 1, 2]);
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(blobDir)).toHaveLength(1);
    } finally { await db().unsafe('DROP TRIGGER reject_test_node ON nodes; DROP FUNCTION reject_test_node();'); }
  });

  test('a .skill archive ingests every bundle with stable identities', async () => {
    const root = join(work, 'multi-skill-archive');
    for (const name of ['archive-one', 'archive-two']) {
      await mkdir(join(root, name), { recursive: true });
      await Bun.write(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Archive test\n---\nInstructions`);
    }
    const archive = join(work, 'multi.skill');
    await Bun.$`cd ${root} && zip -qr ${archive} .`.quiet();
    const results = await ingest(archive);
    expect(results.map((r) => r.name)).toEqual(['archive-one', 'archive-two']);
    expect((await ingest(archive)).every((r) => r.status === 'unchanged')).toBe(true);
    expect(await resolveNode('ctx://skills/archive-one/SKILL.md')).not.toBeNull();
    expect(await resolveNode('ctx://skills/archive-two/SKILL.md')).not.toBeNull();
  });

  test('Bun arrays round-trip and a killed pooled connection recovers', async () => {
    const { pgArray } = await import('../src/core/db');
    const values = ['alpha', 'a,b', '"quoted"', 'back\\slash'];
    const [literal] = await db()`SELECT ${pgArray(values)}::text[] AS values`;
    expect(literal.values).toEqual(values);
    const reserved = await db().reserve();
    const [backend] = await reserved`SELECT pg_backend_pid() AS pid`;
    await db()`SELECT pg_terminate_backend(${backend.pid})`;
    try { await reserved`SELECT 1`; } catch { /* expected close */ } finally { reserved.release(); }
    const [alive] = await db()`SELECT 1 AS value`;
    expect(alive.value).toBe(1);
  });
});

describe('CLI and migration regressions', () => {
  const cli = fileURLToPath(new URL('../src/cli/contextual.ts', import.meta.url));
  async function cliRun(args: string[], cwd?: string, entry = cli, url = schemaUrl(SCHEMA)) {
    const child = Bun.spawn([process.execPath, entry, ...args], { cwd, env: { ...process.env, CONTEXTUAL_DATABASE_URL: url, VOYAGE_API_KEY: '', CONTEXTUAL_VOYAGE_API_KEY: '' }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  test('add reports failed and empty inputs through its exit status, including JSON', async () => {
    const directory = join(work, 'cli-fail');
    await mkdir(directory);
    await Bun.write(join(directory, 'binary.txt'), new Uint8Array([0, 1, 2]));
    const failed = await cliRun(['add', directory, '--json']);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)[0].status).toBe('failed');
    const empty = join(work, 'cli-empty');
    await mkdir(empty);
    expect((await cliRun(['add', empty, '--json'])).code).toBe(1);
    const text = join(work, 'empty-file.txt');
    await Bun.write(text, '');
    expect((await cliRun(['add', text, '--json'])).code).toBe(1);
  });
  test('checkout paths containing spaces support migration and source loading', async () => {
    const { cp, symlink } = await import('node:fs/promises');
    const checkout = join(work, 'checkout with spaces');
    await mkdir(checkout);
    const root = fileURLToPath(new URL('..', import.meta.url));
    await cp(join(root, 'src'), join(checkout, 'src'), { recursive: true });
    await cp(join(root, 'db'), join(checkout, 'db'), { recursive: true });
    await Bun.write(join(checkout, 'package.json'), '{"type":"module"}');
    await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'));
    const result = await cliRun(['migrate'], checkout, join(checkout, 'src/cli/contextual.ts'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('up to date');
  });
  test('upgrading an old corpus canonicalizes colliding URI spellings atomically', async () => {
    const { SQL } = await import('bun');
    const schema = `${SCHEMA}_upgrade`;
    const connection = new SQL(schemaUrl(schema));
    try {
      await connection.unsafe(`CREATE SCHEMA ${schema}`);
      await connection.unsafe('CREATE TABLE _migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
      for (const migration of ['001_init.sql', '002_scale_and_settings.sql']) {
        const text = await Bun.file(new URL(`../db/migrations/${migration}`, import.meta.url)).text();
        await connection.unsafe(text.replaceAll('{{FTS_CONFIG}}', 'english'));
        await connection`INSERT INTO _migrations(name) VALUES (${migration})`;
      }
      const [source] = await connection`INSERT INTO sources(kind,name,collection,content_hash) VALUES ('doc','legacy','encoded','x') RETURNING id`;
      for (const path of ['a b.md', 'a%20b.md', 'ü#?%.md']) {
        await connection`INSERT INTO nodes(source_id,path,uri,role,content) VALUES (${source.id}, ${path}, ${`ctx://docs/encoded/${path}`}, 'doc', 'legacy text')`;
      }
      const result = await cliRun(['migrate'], undefined, cli, schemaUrl(schema));
      expect(result.code).toBe(0);
      const rows = await connection`SELECT uri FROM nodes ORDER BY uri` as unknown as { uri: string }[];
      expect(rows.map((r) => r.uri)).toContain('ctx://docs/encoded/a%20b.md');
      expect(rows.map((r) => r.uri)).toContain('ctx://docs/encoded/a%2520b.md');
      expect(rows.map((r) => r.uri)).toContain('ctx://docs/encoded/%C3%BC%23%3F%25.md');
    } finally { await connection.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await connection.close(); }
  });
});


test('LISTEN delivers direct edits beyond the first notification page', async () => {
  const { watchForChanges } = await import('../src/core/catalog/watch');
  const observed = new Set<string>();
  const stop = watchForChanges((uris) => { for (const uri of uris) observed.add(uri); }, 60000);
  try {
    await Bun.sleep(200);
    const [source] = await db()`INSERT INTO sources(kind,name,collection,content_hash) VALUES ('doc','watch-pages','watch-pages','x') RETURNING id`;
    await db()`INSERT INTO nodes(source_id,path,uri,role,content)
      SELECT ${source.id}, i::text || '.md', 'ctx://docs/watch-pages/' || i::text || '.md', 'doc', 'notification text'
      FROM generate_series(1, 520) i`;
    const deadline = Date.now() + 3000;
    while (observed.size < 520 && Date.now() < deadline) await Bun.sleep(20);
    expect([...observed].filter((uri) => uri.startsWith('ctx://docs/watch-pages/'))).toHaveLength(520);
    observed.clear();
    await db()`UPDATE nodes SET content = 'edited directly' WHERE uri='ctx://docs/watch-pages/520.md'`;
    const updateDeadline = Date.now() + 3000;
    while (!observed.has('ctx://docs/watch-pages/520.md') && Date.now() < updateDeadline) await Bun.sleep(20);
    expect(observed.has('ctx://docs/watch-pages/520.md')).toBe(true);
  } finally { stop(); }
});

});
