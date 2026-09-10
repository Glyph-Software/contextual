#!/usr/bin/env bun
/**
 * contextual — command line.
 *
 *   contextual add <path> [--collection name] [--force] [--allow-reserved]
 *   contextual list [--json]
 *   contextual reindex [--all]
 *   contextual remove <skill|doc> <name> [--collection name]
 *   contextual migrate
 *   contextual serve
 *
 * Everything here writes to stdout freely except `serve`, which delegates to
 * the transport. Stdio reserves stdout for JSON-RPC; HTTP logs go to stderr.
 */
import { configHelp, databaseHint } from '../core/config';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { db, closeDb, migrate } from '../core/db';
import { ingestMany, removeSource, embedMissing, type IngestResult } from '../core/ingest/pipeline';
import { getEmbedder } from '../core/ingest/embed';
import { loadCatalog, renderCatalog } from '../core/catalog/index';
import { estimateTokens } from '../core/tokens';

const HELP = `contextual — a context service for agents

Usage:
  contextual add <path...>        Ingest a skill bundle, a document, or a directory of either
  contextual list                 Show what is ingested
  contextual reindex              Embed any chunks that have no vector yet
  contextual remove <kind> <name> Remove a source (kind: skill | doc)
  contextual migrate              Apply database migrations
  contextual serve                Run the MCP server (stdio by default)

Options:
  --collection <name>   Collection for ingested documents (default: "default")
  --lenient             Warn and ignore unknown skill frontmatter keys
  --force               Re-ingest even when the content hash is unchanged
  --allow-reserved      Permit "claude"/"anthropic" in a skill name (see README)
  --all                 reindex: re-embed every chunk, not only unembedded ones
                        (also required after changing embedding provider/model)
  --json                Machine-readable output
  --transport <name>    serve: stdio (default) or http (Streamable HTTP at /mcp)
  --host <address>      HTTP bind address (default: 127.0.0.1)
  --port <number>       HTTP port (default: 3000)
  -h, --help

Environment:
  CONTEXTUAL_DATABASE_URL   Postgres URL (default: local docker-compose)
  CONTEXTUAL_EMBED_PROVIDER voyage (default), ollama (local), or none (full-text only)
  VOYAGE_API_KEY            Enables Voyage embeddings; not needed for Ollama
  CONTEXTUAL_EMBED_MODEL    Default: voyage-4 or qwen3-embedding:0.6b for Ollama
                           The corpus pins the first model; switching needs \`reindex --all\`
  CONTEXTUAL_OLLAMA_URL     Ollama base URL (default: http://127.0.0.1:11434)
  CONTEXTUAL_FTS_LANGUAGE   Text-search configuration for a *new* database
                            (default: english; cannot change after migrate)
  CONTEXTUAL_OCR            reject (default), local (Tesseract), or hosted (Firecrawl)
                           Hosted OCR sends the PDF off this machine
  CONTEXTUAL_OCR_LANGUAGE   Tesseract languages (default: eng; e.g. eng+deu)
  CONTEXTUAL_BLOB_DIR       Where binary assets are written (default: ./blobs)
  CONTEXTUAL_VOYAGE_API_KEY Alias for VOYAGE_API_KEY
  FIRECRAWL_API_KEY         Hosted OCR key
  CONTEXTUAL_RERANK         Enable Voyage reranking (true/false, default false)
  CONTEXTUAL_RERANK_MODEL   Default: rerank-2.5-lite
  CONTEXTUAL_HTTP_TOKEN     HTTP bearer token; required for non-loopback binds
  CONTEXTUAL_HTTP_ALLOWED_HOSTS  Comma-separated HTTP Host/Origin hostnames
${configHelp()}
`;

const { values: flags, positionals } = safeParseArgs();

function safeParseArgs() {
  try { return parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    collection: { type: 'string' },
    lenient: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'allow-reserved': { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    transport: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
}); } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
}

const [command, ...rest] = positionals;

if (flags.help || !command) {
  console.log(HELP);
  process.exit(0);
}

try {
  if (command !== 'serve' && (flags.transport !== undefined || flags.host !== undefined || flags.port !== undefined)) {
    throw new Error('--transport, --host, and --port are only valid with serve');
  }
  switch (command) {
    case 'add': await cmdAdd(rest); break;
    case 'list': await cmdList(); break;
    case 'reindex': await cmdReindex(); break;
    case 'remove': await cmdRemove(rest); break;
    case 'migrate': await cmdMigrate(); break;
    case 'serve': await cmdServe(); break;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(2);
  }
  await closeDb();
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  if (/connect|ECONNREFUSED/i.test((err as Error).message)) console.error(databaseHint());
  await closeDb();
  process.exit(1);
}

async function cmdAdd(paths: string[]): Promise<void> {
  if (!paths.length) throw new Error('add: give me at least one path');
  await migrate();

  const results = await ingestMany(paths.map((p) => resolve(p)), {
    collection: flags.collection, force: flags.force, allowReserved: flags['allow-reserved'], lenient: flags.lenient,
    onProgress: (m) => { if (!flags.json) console.log(`  ${m}`); },
  });

  if (!results.length || results.some((r) => r.status === 'failed' || r.status === 'needs_ocr')) process.exitCode = 1;
  if (flags.json) { console.log(JSON.stringify(results, null, 2)); return; }

  for (const r of results) {
    const where = r.kind === 'skill' ? `skill ${r.name}` : `${r.collection ?? 'default'}/${r.name}`;
    // needs_ocr is not a failure: the source is recorded and visible, just not
    // searchable. Marking it ✗ would read as "nothing happened".
    const mark = { ingested: '✓', unchanged: '·', needs_ocr: '⚠', failed: '✗' }[r.status];
    console.log(`${mark} ${where}: ${r.status}${r.status === 'ingested' ? ` (${r.nodes} files, ${r.chunks} chunks, ${r.embedded} embedded)` : ''}`);
    if (r.detail) console.log(`    ${r.detail.split('\n')[0]}`);
  }
  if (!getEmbedder() && results.some((r) => r.chunks > 0)) {
    console.log('\nNote: no embedding provider is enabled, so search is full-text only.\n' +
                'Set CONTEXTUAL_EMBED_PROVIDER=ollama or configure VOYAGE_API_KEY, then run `contextual reindex`.');
  }
}

async function cmdList(): Promise<void> {
  const cat = await loadCatalog();
  if (flags.json) { console.log(JSON.stringify(cat, null, 2)); return; }

  const sql = db();
  const rows = (await sql`
    SELECT s.kind, s.name, s.collection, s.status,
           (SELECT count(*)::int FROM nodes n WHERE n.source_id = s.id) AS files,
           (SELECT count(*)::int FROM chunks c JOIN nodes n2 ON n2.id = c.node_id WHERE n2.source_id = s.id) AS chunks,
           (SELECT count(*)::int FROM chunks c JOIN nodes n2 ON n2.id = c.node_id
             WHERE n2.source_id = s.id AND c.embedding IS NOT NULL) AS embedded
    FROM sources s ORDER BY s.kind, s.collection NULLS FIRST, s.name`) as unknown as
    { kind: string; name: string; collection: string | null; status: string; files: number; chunks: number; embedded: number }[];

  if (!rows.length) { console.log('Nothing ingested yet. Try: contextual add ./some-skill'); return; }

  const w = Math.max(...rows.map((r) => r.name.length), 4);
  console.log(`${'KIND'.padEnd(6)} ${'NAME'.padEnd(w)} ${'COLLECTION'.padEnd(12)} ${'FILES'.padStart(5)} ${'CHUNKS'.padStart(6)} ${'EMBED'.padStart(5)}  STATUS`);
  for (const r of rows) {
    console.log(
      `${r.kind.padEnd(6)} ${r.name.padEnd(w)} ${(r.collection ?? '—').padEnd(12)} ` +
      `${String(r.files).padStart(5)} ${String(r.chunks).padStart(6)} ${String(r.embedded).padStart(5)}  ${r.status}`,
    );
  }

  const budget = estimateTokens(renderCatalog(cat));
  console.log(`\nctx://index is ~${budget} tokens (budget 2000) across ${cat.skills.length} skills and ${cat.collections.length} collections.`);
  const blocked = cat.problems.filter((p) => p.status !== 'ready');
  if (blocked.length) console.log(`${blocked.length} source(s) are not searchable — see STATUS above.`);
}

async function cmdReindex(): Promise<void> {
  const embedder = getEmbedder();
  if (!embedder) throw new Error('reindex: set CONTEXTUAL_EMBED_PROVIDER=ollama or configure VOYAGE_API_KEY to produce vectors');

  await migrate();
  const { total, embedded } = await embedMissing(embedder, {
    all: flags.all,
    onProgress: (done, all) => {
      if (done === all || done % 96 === 0) process.stdout.write(`\r  ${done}/${all}`);
    },
  });
  if (!total) { console.log('Everything is already embedded.'); return; }
  console.log(`\n✓ embedded ${embedded}/${total} chunks with ${embedder.id}` +
    (embedded < total ? ` (${total - embedded} rejected by the API and left without a vector)` : ''));
}

async function cmdRemove(args: string[]): Promise<void> {
  const [kind, name] = args;
  if (kind !== 'skill' && kind !== 'doc') throw new Error('remove: first argument must be "skill" or "doc"');
  if (!name) throw new Error('remove: give me a name');
  const ok = await removeSource(kind, name, flags.collection);
  console.log(ok ? `✓ removed ${kind} ${name}` : `· no such ${kind}: ${name}`);
}

async function cmdMigrate(): Promise<void> {
  const applied = await migrate();
  console.log(applied.length ? `✓ applied: ${applied.join(', ')}` : '· database already up to date');
}

async function cmdServe(): Promise<void> {
  const transport = flags.transport ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') throw new Error('--transport must be stdio or http');
  if (transport === 'stdio' && (flags.host !== undefined || flags.port !== undefined)) {
    throw new Error('--host and --port require --transport http');
  }
  const port = flags.port === undefined ? undefined : Number(flags.port);
  if (port !== undefined && (!/^\d+$/.test(flags.port!) || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  await closeDb();
  const { serve } = await import('../mcp/server');
  await serve({ transport, host: flags.host, port });
}
