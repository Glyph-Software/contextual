import { envNumber } from '../config';
/**
 * The ingest pipeline.
 *
 * detect → (skill | document) → chunk → embed → write → notify.
 *
 * Idempotence comes from a content hash on `sources`: re-ingesting unchanged
 * bytes is a no-op, and re-ingesting changed bytes replaces the source's nodes
 * and chunks in one transaction rather than accumulating duplicates. Binary
 * assets live on disk under `blobDir` and are removed with their rows, so the
 * blob directory never diverges from the database.
 */
import { basename, dirname, extname, join } from 'node:path';
import { mkdir, mkdtemp, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { db, toVector, pgArray, getSetting, setSetting } from '../db';
import { detect, type Detection } from './detect';
import { parseSkillMd, walkBundle, SkillValidationError } from './skill';
import { normalize, normalizeHtml, NeedsOcrError } from './document';
import { blocksFromMarkdown, chunkBlocks, type Chunk } from './chunk';
import { getEmbedder, planBatches, EmbeddingError, type Embedder } from './embed';
import { decodeText } from './text';
import { buildUri, assertSafeName } from '../vfs/uri';

export interface IngestOptions {
  /** Document collection. Ignored for skills, which are named by frontmatter. */
  collection?: string;
  /** Re-ingest even when the content hash is unchanged. */
  force?: boolean;
  /** Where binary assets are written; they are not stored in Postgres. */
  blobDir?: string;
  /** Permit the spec's reserved words in a skill name. See skill.ts. */
  allowReserved?: boolean;
  lenient?: boolean;
  onProgress?: (msg: string) => void;
}

export interface IngestResult {
  status: 'ingested' | 'unchanged' | 'needs_ocr' | 'failed';
  kind: 'skill' | 'doc';
  name: string;
  collection?: string;
  sourceId?: number;
  nodes: number;
  chunks: number;
  embedded: number;
  uris: string[];
  detail?: string;
}

/**
 * Caps on walking a directory of sources. `contextual add ~` is a real
 * footgun: without these it would crawl a home directory to the bottom.
 */
export const MAX_DIR_DEPTH = 8;
export const MAX_DIR_MEMBERS = 1000;

export async function ingest(path: string, opts: IngestOptions = {}): Promise<IngestResult[]> {
  return ingestMany([path], opts);
}

/** One embedding/index-maintenance decision for the entire add invocation. */
export async function ingestMany(paths: string[], opts: IngestOptions = {}): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const path of paths) results.push(...await ingestTree(path, opts));
  const ids = results.filter((r) => r.status === 'ingested' && r.sourceId).map((r) => String(r.sourceId));
  const embedder = getEmbedder();
  if (!embedder || !ids.length) return results;
  const log = opts.onProgress ?? (() => {});
  const rows = await db()`SELECT c.id, c.context || E'\\n\\n' || c.content AS content
    FROM chunks c JOIN nodes n ON n.id = c.node_id
    WHERE n.source_id = ANY(${pgArray(ids)}::bigint[]) AND c.embedding IS NULL ORDER BY c.id` as unknown as { id: number; content: string }[];
  try {
    await assertEmbedModel(embedder);
    await withBulkIndex(rows.length, () => embedRows(embedder, rows, log));
  } catch (err) {
    log(`embedding failed (${(err as Error).message}); full-text search still works. Re-run contextual reindex.`);
  }
  const counts = await db()`SELECT n.source_id AS id, count(*)::int AS count FROM chunks c JOIN nodes n ON n.id = c.node_id
    WHERE n.source_id = ANY(${pgArray(ids)}::bigint[]) AND c.embedding IS NOT NULL GROUP BY n.source_id` as unknown as { id: number; count: number }[];
  for (const result of results) result.embedded = counts.find((c) => c.id === result.sourceId)?.count ?? 0;
  return results;
}

async function ingestTree(path: string, opts: IngestOptions = {}, depth = 0): Promise<IngestResult[]> {
  const detection = await detect(path);

  if (detection.kind === 'directory-of-sources') {
    if (depth >= MAX_DIR_DEPTH) {
      throw new Error(`${path}: directory nesting deeper than ${MAX_DIR_DEPTH} levels; add a more specific path`);
    }
    const members = detection.members ?? [];
    if (members.length > MAX_DIR_MEMBERS) {
      throw new Error(`${path}: ${members.length} entries is more than the ${MAX_DIR_MEMBERS} this will walk; add a more specific path`);
    }
    const out: IngestResult[] = [];
    for (const member of members) {
      try {
        out.push(...(await ingestTree(member, opts, depth + 1)));
      } catch (err) {
        // One bad member must not abort the rest of the directory, but it has
        // to be reported as what it actually was, not as an anonymous doc.
        const kind = err instanceof SkillValidationError ? 'skill' : 'doc';
        out.push({
          status: 'failed', kind, name: basename(member),
          ...(kind === 'doc' && { collection: opts.collection ?? 'default' }),
          nodes: 0, chunks: 0, embedded: 0, uris: [], detail: (err as Error).message,
        });
      }
    }
    return out;
  }

  if (detection.kind === 'skill' && /\.(zip|skill)$/i.test(path)) {
    await inspectZip(path);
    const dir = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'contextual-zip-'));
    try {
      await Bun.$`unzip -q -o ${path} -d ${dir}`.quiet();
      const roots = await findBundleRoots(dir);
      if (!roots.length) throw new SkillValidationError('archive does not contain a SKILL.md');
      const results: IngestResult[] = [];
      for (const root of roots) {
        const origin = roots.length === 1 ? path : `${path}#${root.slice(dir.length + 1)}`;
        try { results.push(await ingestSkill(root, origin, opts, opts.onProgress ?? (() => {}))); }
        catch (err) { results.push({ status: 'failed', kind: 'skill', name: basename(root), nodes: 0, chunks: 0, embedded: 0, uris: [], detail: (err as Error).message }); }
      }
      return results;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return [await ingestOne(detection, opts)];
}

async function ingestOne(detection: Detection, opts: IngestOptions): Promise<IngestResult> {
  const log = opts.onProgress ?? (() => {});

  if (detection.kind === 'skill') {
    return await ingestSkill(detection.root, detection.root, opts, log);
  }

  return await ingestDocument(detection, opts, log);
}

/* -------------------------------------------------------------------------- */
/* Zip guards                                                                  */
/* -------------------------------------------------------------------------- */

export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;

export class UnsafeZipError extends SkillValidationError {}

/**
 * Reads the archive's own listing before anything is written to disk and
 * rejects it if any entry could escape the extraction directory (`..`,
 * absolute paths, backslashes, symlinks) or if the uncompressed size or entry
 * count is past the cap. Info-ZIP strips `../` on its own, but a warning in a
 * log is not a guard, and a symlink followed by a file written through it is
 * a slip that name-stripping does not catch.
 */
export async function inspectZip(path: string): Promise<{ entries: number; bytes: number }> {
  const size = (await stat(path)).size;
  if (size > MAX_ZIP_BYTES) throw new UnsafeZipError(`${basename(path)}: ${size} bytes is over the ${MAX_ZIP_BYTES}-byte limit`);

  const listing = await Bun.$`unzip -Z ${path}`.quiet().nothrow();
  if (listing.exitCode !== 0) throw new UnsafeZipError(`${basename(path)}: not a readable zip archive`);

  // zipinfo long form: perms version os size flags method date time name.
  const ENTRY = /^(\S+)\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/;
  let entries = 0;
  let bytes = 0;
  for (const line of listing.stdout.toString().split('\n')) {
    if (!line || line.startsWith('Archive:') || line.startsWith('Zip file size:') || /^\d+ files?, /.test(line)) continue;
    const m = ENTRY.exec(line);
    if (!m) throw new UnsafeZipError(`${basename(path)}: could not parse archive listing line: ${line}`);
    const [, mode, sizeText, name] = m;
    if (mode!.startsWith('l')) throw new UnsafeZipError(`${basename(path)}: contains a symlink (${name}); symlinks are not allowed in bundles`);
    if (!isSafeEntryName(name!)) throw new UnsafeZipError(`${basename(path)}: unsafe entry name "${name}"`);
    entries++;
    bytes += Number(sizeText);
    if (entries > MAX_ZIP_ENTRIES) throw new UnsafeZipError(`${basename(path)}: more than ${MAX_ZIP_ENTRIES} entries`);
    if (bytes > MAX_ZIP_BYTES) throw new UnsafeZipError(`${basename(path)}: uncompressed size is over the ${MAX_ZIP_BYTES}-byte limit`);
  }
  return { entries, bytes };
}

function isSafeEntryName(name: string): boolean {
  if (name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').some((seg) => seg === '..');
}

/** A zip may wrap the bundle in a single top directory. */
async function findBundleRoots(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX').sort((a,b) => a.name.localeCompare(b.name));
  if (entries.some((e) => e.name === 'SKILL.md' && e.isFile())) return [dir];
  const roots: string[] = [];
  for (const entry of entries) if (entry.isDirectory()) roots.push(...await findBundleRoots(join(dir, entry.name)));
  return roots;
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                      */
/* -------------------------------------------------------------------------- */

async function ingestSkill(root: string, origin: string, opts: IngestOptions, log: (m: string) => void): Promise<IngestResult> {
  const files = await walkBundle(root);
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (!skillMd) throw new SkillValidationError(`no SKILL.md at ${root}`);

  const raw = await Bun.file(skillMd.absPath).text();
  const parsed = parseSkillMd(raw, { allowReservedNames: opts.allowReserved, lenient: opts.lenient, onWarning: log });
  const { name } = parsed.frontmatter;
  assertSafeName(name, 'skill name');

  // The hash covers every file in the bundle, so touching a reference file
  // re-ingests the skill even though SKILL.md is unchanged.
  const hasher = new Bun.CryptoHasher('sha256');
  for (const f of files) {
    hasher.update(f.path);
    hasher.update(await Bun.file(f.absPath).bytes());
  }
  const contentHash = hasher.digest('hex');

  const sql = db();
  const existing = (await sql`SELECT id, content_hash FROM sources WHERE kind='skill' AND name=${name}`) as unknown as { id: number; content_hash: string }[];
  if (existing[0] && existing[0].content_hash === contentHash && !opts.force) {
    return { status: 'unchanged', kind: 'skill', name, sourceId: existing[0].id, nodes: 0, chunks: 0, embedded: 0, uris: [] };
  }

  // The same bundle re-ingested under a new frontmatter name is a rename, not
  // a second skill: identity is (kind, name), so without this the old name
  // would stay in the catalog forever.
  const renamed = (await sql`
    SELECT id, name FROM sources WHERE kind='skill' AND origin_uri=${origin} AND name<>${name}`) as unknown as { id: number; name: string }[];

  const blobDir = join(opts.blobDir ?? defaultBlobDir(), crypto.randomUUID());
  const uris: string[] = [];
  let chunkCount = 0;
  const oldBlobs = existing[0] ? await blobRefsOf(existing[0].id) : [];
  const newBlobs = new Set<string>();
  for (const old of renamed) oldBlobs.push(...await blobRefsOf(old.id));

  const sourceId = await sql.begin(async (tx: any) => {
    for (const old of renamed) await tx`DELETE FROM sources WHERE id = ${old.id}`;
    const rows = (await tx`
      INSERT INTO sources (kind, name, collection, origin_uri, content_hash, status, detail)
      VALUES ('skill', ${name}, NULL, ${origin}, ${contentHash}, 'ready', NULL)
      ON CONFLICT (kind, coalesce(collection, ''), name)
      DO UPDATE SET content_hash = EXCLUDED.content_hash, origin_uri = EXCLUDED.origin_uri,
                    status = 'ready', detail = NULL, updated_at = now()
      RETURNING id`) as unknown as { id: number }[];
    const id = rows[0]!.id;

    // Replacing wholesale keeps a re-ingest from leaving behind files that
    // were deleted from the bundle. ON DELETE CASCADE removes their chunks.
    await tx`DELETE FROM nodes WHERE source_id = ${id}`;

    await tx`
      INSERT INTO skills (source_id, name, description, allowed_tools, compatibility, license, metadata)
      VALUES (${id}, ${name}, ${parsed.frontmatter.description}, ${pgArray(parsed.frontmatter.allowedTools)}::text[],
              ${parsed.frontmatter.compatibility ?? null},
              ${parsed.frontmatter.license ?? null}, ${JSON.stringify(parsed.frontmatter.metadata ?? {})}::jsonb)
      ON CONFLICT (source_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        allowed_tools = EXCLUDED.allowed_tools, compatibility = EXCLUDED.compatibility,
        license = EXCLUDED.license, metadata = EXCLUDED.metadata`;

    for (const f of files) {
      const uri = buildUri('skills', name, f.path);
      uris.push(uri);

      let content: string | null = null;
      let blobRef: string | null = null;
      if (f.isText) content = decodeText(await Bun.file(f.absPath).bytes());
      else {
        // Binary assets stay on disk. Uploaded scripts are stored as text and
        // served read-only; this server never executes them.
        blobRef = join(blobDir, `${name}`, f.path);
        await Bun.write(blobRef, Bun.file(f.absPath));
        newBlobs.add(blobRef);
      }

      const nodeRows = (await tx`
        INSERT INTO nodes (source_id, path, uri, mime_type, size_bytes, role, content, blob_ref)
        VALUES (${id}, ${f.path}, ${uri}, ${f.mimeType}, ${f.size}, ${f.role}, ${content}, ${blobRef})
        RETURNING id`) as unknown as { id: number }[];
      const nodeId = nodeRows[0]!.id;

      // SKILL.md is authored to be read whole; chunking it would fragment the
      // instructions that make the skill work. References are fair game.
      if (f.role === 'skill_md' || !content) continue;
      if (f.role === 'asset') continue;

      const chunks = chunkBlocks(blocksFromMarkdown(content));
      if (!chunks.length) continue;
      for (const c of chunks) {
        await tx`
          INSERT INTO chunks (node_id, ord, heading_path, content, token_count, context)
          VALUES (${nodeId}, ${c.ord}, ${pgArray(c.headingPath)}::text[], ${c.content}, ${c.tokenCount}, ${[name, f.path, ...c.headingPath].join(' / ')})`;
      }
      chunkCount += chunks.length;
    }
    return id;
  }).catch(async (err: unknown) => { await rm(blobDir, { recursive: true, force: true }); throw err; });

  // Assets the bundle no longer ships would otherwise stay on disk forever.
  await deleteBlobs(oldBlobs.filter((b) => !newBlobs.has(b)));

  log(`skill "${name}": ${files.length} files, ${chunkCount} chunks`);
  const embedded = 0;
  return { status: 'ingested', kind: 'skill', name, sourceId, nodes: files.length, chunks: chunkCount, embedded, uris };
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

async function ingestDocument(detection: Detection, opts: IngestOptions, log: (m: string) => void): Promise<IngestResult> {
  const filename = basename(detection.path);
  const collection = opts.collection ?? 'default';
  assertSafeName(collection, 'collection');

  const bytes = await Bun.file(detection.path).bytes();
  const contentHash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

  const sql = db();
  const existing = (await sql`
    SELECT id, content_hash, status FROM sources
    WHERE kind='doc' AND name=${filename} AND coalesce(collection,'') = ${collection}`) as unknown as { id: number; content_hash: string; status: string }[];
  if (existing[0] && existing[0].content_hash === contentHash && existing[0].status === 'ready' && !opts.force) {
    return { status: 'unchanged', kind: 'doc', name: filename, collection, sourceId: existing[0].id, nodes: 0, chunks: 0, embedded: 0, uris: [] };
  }

  // A renamed file: identical bytes already ingested in this collection under
  // a name whose original path no longer exists. Reclaim it rather than
  // storing the same document twice.
  const renamed: { id: number; name: string }[] = [];
  if (!existing[0]) {
    const twins = (await sql`
      SELECT id, name, origin_uri AS "originUri" FROM sources
      WHERE kind='doc' AND coalesce(collection,'') = ${collection} AND content_hash = ${contentHash} AND name <> ${filename}`) as unknown as
      { id: number; name: string; originUri: string | null }[];
    for (const twin of twins) {
      if (twin.originUri && (await exists(twin.originUri))) continue;
      renamed.push(twin);
    }
  }

  let normalized;
  try {
    normalized = detection.kind === 'html'
      ? await normalizeHtml(decodeText(bytes), detection.path)
      : await normalize(bytes, filename);
    if (!normalized.markdown.trim()) throw new Error('document contains no readable text');
  } catch (err) {
    // A scanned PDF is recorded, not swallowed: it shows up in the catalog as
    // known-but-not-ingested, which is strictly better than a source that
    // silently contains no text.
    const status = err instanceof NeedsOcrError ? 'needs_ocr' : 'failed';
    const detail = (err as Error).message;
    if (existing[0]?.status === 'ready') {
      return { status, kind: 'doc', name: filename, collection, sourceId: existing[0].id, nodes: 0, chunks: 0, embedded: 0, uris: [], detail: `${detail}; previous ready source preserved` };
    }
    const oldBlobs = existing[0] ? await blobRefsOf(existing[0].id) : [];
    const rows = (await sql`
      INSERT INTO sources (kind, name, collection, origin_uri, content_hash, status, detail)
      VALUES ('doc', ${filename}, ${collection}, ${detection.path}, ${contentHash}, ${status}, ${detail})
      ON CONFLICT (kind, coalesce(collection, ''), name)
      DO UPDATE SET content_hash = EXCLUDED.content_hash, status = EXCLUDED.status,
                    detail = EXCLUDED.detail, updated_at = now()
      RETURNING id`) as unknown as { id: number }[];
    await sql`DELETE FROM nodes WHERE source_id = ${rows[0]!.id}`;
    await deleteBlobs(oldBlobs);
    log(`${filename}: ${status} — ${detail.split('\n')[0]}`);
    return { status, kind: 'doc', name: filename, collection, sourceId: rows[0]!.id, nodes: 0, chunks: 0, embedded: 0, uris: [], detail };
  }

  // The stored path keeps the original filename and appends `.md`, rather than
  // replacing the extension: `report.docx` and `report.pdf` are different
  // documents and must not collide on `report.md`. It also tells an agent what
  // the source format was, which the normalized markdown no longer shows.
  const docPath = await uniqueDocPath(collection, filename);
  const uri = buildUri('docs', collection, docPath);
  const chunks = chunkBlocks(normalized.blocks);
  const blobDir = join(opts.blobDir ?? defaultBlobDir(), crypto.randomUUID());
  const assetRoot = stripExt(docPath);
  const uris = [uri];
  const oldBlobs = existing[0] ? await blobRefsOf(existing[0].id) : [];
  const newBlobs = new Set<string>();
  for (const old of renamed) oldBlobs.push(...await blobRefsOf(old.id));

  const sourceId = await sql.begin(async (tx: any) => {
    for (const old of renamed) await tx`DELETE FROM sources WHERE id = ${old.id}`;
    const rows = (await tx`
      INSERT INTO sources (kind, name, collection, origin_uri, content_hash, status, detail)
      VALUES ('doc', ${filename}, ${collection}, ${detection.path}, ${contentHash}, 'ready', NULL)
      ON CONFLICT (kind, coalesce(collection, ''), name)
      DO UPDATE SET content_hash = EXCLUDED.content_hash, origin_uri = EXCLUDED.origin_uri,
                    status = 'ready', detail = NULL, updated_at = now()
      RETURNING id`) as unknown as { id: number }[];
    const id = rows[0]!.id;
    await tx`DELETE FROM nodes WHERE source_id = ${id}`;

    const nodeRows = (await tx`
      INSERT INTO nodes (source_id, path, uri, mime_type, size_bytes, role, content, blob_ref)
      VALUES (${id}, ${docPath}, ${uri}, 'text/markdown', ${normalized.markdown.length}, 'doc', ${normalized.markdown}, NULL)
      RETURNING id`) as unknown as { id: number }[];
    const nodeId = nodeRows[0]!.id;

    for (const c of chunks) {
      await tx`
        INSERT INTO chunks (node_id, ord, heading_path, content, token_count, context)
        VALUES (${nodeId}, ${c.ord}, ${pgArray(c.headingPath)}::text[], ${c.content}, ${c.tokenCount}, ${[collection, filename, ...c.headingPath].join(' / ')})`;
    }

    // Embedded images land as asset nodes, exactly as a skill bundle's assets
    // do — one tree, one treatment.
    for (const asset of normalized.assets) {
      const assetPath = `assets/${asset.id}${extFor(asset.mediaType)}`;
      const assetUri = buildUri('docs', collection, `${assetRoot}/${assetPath}`);
      const ref = join(blobDir, collection, assetRoot, assetPath);
      await Bun.write(ref, asset.data);
      newBlobs.add(ref);
      await tx`
        INSERT INTO nodes (source_id, path, uri, mime_type, size_bytes, role, content, blob_ref)
        VALUES (${id}, ${`${assetRoot}/${assetPath}`}, ${assetUri}, ${asset.mediaType},
                ${asset.data.byteLength}, 'asset', NULL, ${ref})`;
      uris.push(assetUri);
    }
    return id;
  }).catch(async (err: unknown) => { await rm(blobDir, { recursive: true, force: true }); throw err; });

  await deleteBlobs(oldBlobs.filter((b) => !newBlobs.has(b)));

  log(`${filename}: ${normalized.via}, ${chunks.length} chunks, ${normalized.assets.length} assets`);
  const embedded = 0;
  return {
    status: 'ingested', kind: 'doc', name: filename, collection, sourceId,
    nodes: 1 + normalized.assets.length, chunks: chunks.length, embedded, uris,
  };
}

/* -------------------------------------------------------------------------- */
/* Embedding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The corpus is embedded by exactly one model. The first embedding run pins
 * it; a different `CONTEXTUAL_EMBED_MODEL` afterwards is refused until
 * `reindex --all` re-embeds everything under the new id. Dimensions are fixed
 * by the schema, so a model swap that changes them needs a migration too.
 */
export async function assertEmbedModel(embedder: Embedder, repin = false): Promise<void> {
  const pinned = await getSetting('embed_model');
  if (pinned === null || repin) {
    await setSetting('embed_model', embedder.id);
    return;
  }
  if (pinned !== embedder.id) {
    throw new Error(
      `corpus is embedded with "${pinned}" but the configured model is "${embedder.id}"; ` +
        `run \`contextual reindex --all\` to re-embed everything with "${embedder.id}"`,
    );
  }
}

/**
 * Above this many pending vectors, the HNSW index is dropped for the load and
 * rebuilt afterwards. pgvector builds the graph far faster from a loaded table
 * than by inserting one row at a time, but dropping a shared index is not free
 * — searches run without it until the rebuild finishes — so a small `add` pays
 * the incremental cost instead. Rebuilding is in a `finally`, so a failed load
 * cannot leave the corpus permanently unindexed.
 */
export const BULK_INDEX_THRESHOLD = envNumber('CONTEXTUAL_BULK_INDEX_THRESHOLD');

const DROP_HNSW = 'DROP INDEX IF EXISTS chunks_embedding_idx';
const CREATE_HNSW =
  'CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL';

/**
 * Runs a load with the vector index dropped when the load is big enough to be
 * worth it. `pending` is the number of vectors about to be written.
 */
async function withBulkIndex<T>(pending: number, fn: () => Promise<T>): Promise<T> {
  if (pending < envNumber('CONTEXTUAL_BULK_INDEX_THRESHOLD')) return await fn();
  const sql = db();
  await sql.unsafe(DROP_HNSW);
  try {
    return await fn();
  } finally {
    await sql.unsafe(CREATE_HNSW);
  }
}

/**
 * Embeds rows in request-sized batches, isolating bad inputs: a batch the API
 * rejects is retried one chunk at a time so a single oversize table leaves
 * only itself un-embedded, not the whole source. Transient and auth failures
 * stop the run and are reported once.
 */
async function embedRows(
  embedder: Embedder,
  rows: { id: number; content: string }[],
  log: (m: string) => void,
  onBatch?: (done: number) => void,
): Promise<number> {
  const sql = db();
  let done = 0;
  const store = async (ids: number[], vectors: number[][]) => {
    await sql.begin(async (tx: any) => {
      for (let i = 0; i < ids.length; i++) {
        await tx`UPDATE chunks SET embedding = ${toVector(vectors[i]!)}::vector WHERE id = ${ids[i]}`;
      }
    });
    done += ids.length;
    onBatch?.(done);
  };

  for (const batch of planBatches(rows.map((r) => r.content))) {
    const slice = batch.map((i) => rows[i]!);
    try {
      await store(slice.map((r) => r.id), await embedder.embed(slice.map((r) => r.content), 'document'));
    } catch (err) {
      if (!(err instanceof EmbeddingError) || err.failure !== 'input') throw err;
      log(`embedding batch rejected (${err.message.split('\n')[0]}); retrying chunk by chunk`);
      for (const r of slice) {
        try {
          await store([r.id], await embedder.embed([r.content], 'document'));
        } catch (inner) {
          if (!(inner instanceof EmbeddingError) || inner.failure !== 'input') throw inner;
          log(`chunk ${r.id} skipped: ${inner.message.split('\n')[0]}`);
        }
      }
    }
  }
  return done;
}

/**
 * Embeds every chunk of a source that has no vector yet. Runs outside the
 * write transaction on purpose: embedding is a network call, and holding a
 * transaction open across it would be a long lock for no benefit. A failure
 * here leaves the corpus searchable by full-text and re-runnable by `reindex`.
 */
export interface EmbedMissingOptions {
  /** Re-embed every chunk, not only the ones without a vector. */
  all?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * `contextual reindex`. A full re-embed always drops and rebuilds the HNSW
 * index; a partial one does so only when there is enough pending work to earn
 * it (see `withBulkIndex`).
 */
export async function embedMissing(embedder: Embedder, opts: EmbedMissingOptions = {}): Promise<{ total: number; embedded: number }> {
  const sql = db();
  await assertEmbedModel(embedder, opts.all === true);
  if (opts.all) await sql`UPDATE chunks SET embedding = NULL`;

  const rows = (await sql`SELECT id, context || E'\\n\\n' || content AS content FROM chunks WHERE embedding IS NULL ORDER BY id`) as unknown as { id: number; content: string }[];
  if (!rows.length) return { total: 0, embedded: 0 };

  const pending = opts.all ? Number.POSITIVE_INFINITY : rows.length;
  const embedded = await withBulkIndex(pending, () =>
    embedRows(embedder, rows, () => {}, (done) => opts.onProgress?.(done, rows.length)),
  );
  return { total: rows.length, embedded };
}

/* -------------------------------------------------------------------------- */

const stripExt = (f: string) => f.replace(/\.[^.]+$/, '') || f;

const MARKDOWN_EXT = /\.(md|markdown)$/i;

/**
 * The VFS path for a normalized document. Markdown passes through unchanged;
 * everything else gains a `.md` suffix. A residual collision can only come
 * from a genuinely different source (this source's own nodes are deleted
 * first), so it is disambiguated rather than allowed to fail the ingest.
 */
async function uniqueDocPath(collection: string, filename: string): Promise<string> {
  const base = MARKDOWN_EXT.test(filename) ? filename : `${filename}.md`;
  const sql = db();
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${stripExt(base)}-${n}.md`;
    const uri = buildUri('docs', collection, candidate);
    const clash = (await sql`
      SELECT n.id FROM nodes n JOIN sources s ON s.id = n.source_id
      WHERE n.uri = ${uri} AND NOT (s.kind='doc' AND s.name=${filename} AND coalesce(s.collection,'')=${collection})
      LIMIT 1`) as unknown as { id: number }[];
    if (!clash.length) return candidate;
  }
  throw new Error(`cannot find a free path for ${filename} in ${collection}`);
}
const defaultBlobDir = () => process.env.CONTEXTUAL_BLOB_DIR ?? join(process.cwd(), 'blobs');

function extFor(mediaType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/tiff': '.tiff', 'image/bmp': '.bmp',
  };
  return map[mediaType] ?? '.bin';
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/* -------------------------------------------------------------------------- */
/* Removal                                                                     */
/* -------------------------------------------------------------------------- */

async function blobRefsOf(sourceId: number): Promise<string[]> {
  const rows = (await db()`SELECT blob_ref FROM nodes WHERE source_id = ${sourceId} AND blob_ref IS NOT NULL`) as unknown as { blob_ref: string }[];
  return rows.map((r) => r.blob_ref);
}

/**
 * Deletes blob files by reference and prunes the directories they leave
 * empty. Best effort: a blob that is already gone is not an error.
 */
async function deleteBlobs(refs: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const ref of refs) {
    await rm(ref, { force: true });
    dirs.add(dirname(ref));
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await pruneEmpty(dir);
}

async function pruneEmpty(dir: string): Promise<void> {
  for (let d = dir; d && d !== dirname(d); d = dirname(d)) {
    try {
      if ((await readdir(d)).length) return;
      await rmdir(d);
    } catch {
      return;
    }
  }
}

async function removeSourceById(id: number): Promise<void> {
  const blobs = await blobRefsOf(id);
  await db()`DELETE FROM sources WHERE id = ${id}`;
  await deleteBlobs(blobs);
}

/** Removes a source and everything under it, on disk as well as in Postgres. */
export async function removeSource(kind: 'skill' | 'doc', name: string, collection?: string): Promise<boolean> {
  const rows = (await db()`
    SELECT id FROM sources WHERE kind = ${kind} AND name = ${name}
      AND (${collection === undefined} OR coalesce(collection,'default') = ${collection ?? 'default'})`) as unknown as { id: number }[];
  for (const r of rows) await removeSourceById(r.id);
  return rows.length > 0;
}
