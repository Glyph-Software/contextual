/** Setup commands deliberately avoid importing the ingest/server graph: they
 * must diagnose bad settings and missing databases before those can start. */
import { SQL } from 'bun';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { validateConfig, embedProvider, voyageKey } from '../core/config';
import { DEFAULT_URL } from '../core/db';
import { migrations } from '../core/migrations';
import pkg from '../../package.json';

export const MIN_BUN_VERSION = pkg.engines.bun.replace(/^>=/, '');
export interface Check { name: string; status: 'ok' | 'warning' | 'error'; message: string; suggested_action?: string }
export interface DoctorReport { ok: boolean; checks: Check[] }

export function compatibleRuntime(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split('.').map(Number), required = MIN_BUN_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (actual[i] !== required[i]) return actual[i]! > required[i]!;
  return true;
}

export async function doctor(opts: { removeProbe?: typeof unlink } = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], message: string, suggested_action?: string) => checks.push({ name, status, message, ...(suggested_action && { suggested_action }) });
  add('runtime', compatibleRuntime(Bun.version) ? 'ok' : 'error', `Bun ${Bun.version}; requires >=${MIN_BUN_VERSION}.`,
    compatibleRuntime(Bun.version) ? undefined : 'Use a supported Bun runtime, or rebuild the standalone executable with one.');
  let valid = true;
  try { validateConfig(); add('configuration', 'ok', 'Environment settings are valid.'); }
  catch (err) { valid = false; add('configuration', 'error', (err as Error).message, 'Correct the named setting and rerun contextual doctor.'); }

  const blobDir = resolve(process.env.CONTEXTUAL_BLOB_DIR ?? 'blobs');
  let probe: string | undefined;
  try {
    if (!(await stat(blobDir)).isDirectory()) throw new Error();
    await access(blobDir, constants.R_OK | constants.W_OK | constants.X_OK);
    const candidate = resolve(blobDir, `.contextual-doctor-${randomUUID()}`);
    const file = await open(candidate, 'wx', 0o600);
    probe = candidate;
    try { await file.write('contextual storage check'); }
    finally { await file.close(); }
    add('blob_storage', 'ok', `Readable and writable: ${blobDir}`);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    add('blob_storage', missing ? 'warning' : 'error', missing ? `Not created yet: ${blobDir}` : `Cannot read and write blob storage: ${blobDir}`,
      missing ? 'Run contextual init to create the blob directory.' : 'Set CONTEXTUAL_BLOB_DIR to a readable, writable directory.');
  } finally {
    if (probe) try { await (opts.removeProbe ?? unlink)(probe); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        add('blob_cleanup', 'error', `Could not remove the storage probe: ${probe}`, 'Check directory permissions and remove the probe file.');
      }
    }
  }

  let sql: SQL | undefined;
  let pinned: string | null = null;
  let stage = 'database';
  try {
    const url = new URL(process.env.CONTEXTUAL_DATABASE_URL ?? DEFAULT_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    sql = new SQL({ url: url.href, connectionTimeout: 2, max: 1 });
    await sql`SELECT 1`;
    add('database', 'ok', `Connected to ${url.hostname}:${url.port || '5432'}${url.pathname}.`);
    stage = 'database_transaction';
    await sql.begin(async (tx: any) => {
      stage = 'extensions';
      await tx`SET LOCAL statement_timeout = '3s'`;
      const extensions = await tx`SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')` as { extname: string }[];
      const missing = ['vector', 'pg_trgm'].filter((name) => !extensions.some((e) => e.extname === name));
      add('extensions', missing.length ? 'error' : 'ok', missing.length ? `Missing extensions: ${missing.join(', ')}.` : 'pgvector and pg_trgm are installed.',
        missing.length ? 'Use the provided Postgres image and run contextual migrate.' : undefined);
      stage = 'migrations';
      const [table] = await tx`SELECT to_regclass('_migrations') AS name`;
      const applied = new Set(table.name ? (await tx`SELECT name FROM _migrations`).map((r: { name: string }) => r.name) : []);
      const pending = Object.keys(migrations).filter((name) => !applied.has(name));
      add('migrations', pending.length ? 'error' : 'ok', pending.length ? `Pending: ${pending.join(', ')}.` : 'Database migrations are up to date.',
        pending.length ? 'Run contextual migrate against this database.' : undefined);
      if (!pending.length) {
        stage = 'settings';
        const settings = await tx`SELECT key, value FROM settings WHERE key IN ('embed_model', 'fts_config')` as { key: string; value: string }[];
        add('settings', 'ok', 'Database retrieval settings are readable.');
        pinned = settings.find((row) => row.key === 'embed_model')?.value ?? null;
        const language = settings.find((row) => row.key === 'fts_config')?.value;
        if (process.env.CONTEXTUAL_FTS_LANGUAGE && language !== process.env.CONTEXTUAL_FTS_LANGUAGE.toLowerCase()) {
          add('fts_language', 'error', 'CONTEXTUAL_FTS_LANGUAGE differs from the database language.', 'Use the database language; changing it requires a new database.');
        }
      }
      stage = 'database_transaction';
    });
  } catch {
    // Driver errors can contain the full connection string. Never echo them.
    add(stage, 'error', `Could not complete the Postgres ${stage} check.`, 'Start docker compose up -d; check CONTEXTUAL_DATABASE_URL, permissions, and run contextual migrate.');
  } finally {
    try { await sql?.close(); }
    catch { add('database_cleanup', 'error', 'Could not close the diagnostic database connection.'); }
  }

  if (valid) {
    try {
      const provider = embedProvider();
      const key = voyageKey();
      if (provider === 'none' || (provider === 'voyage' && !key)) {
        add('embeddings', 'ok', 'Full-text search enabled; semantic retrieval is not configured.');
      } else {
        const { OllamaEmbedder, VoyageEmbedder } = await import('../core/ingest/embed');
        const model = process.env.CONTEXTUAL_EMBED_MODEL;
        const embedder = provider === 'ollama'
          ? new OllamaEmbedder(model, process.env.CONTEXTUAL_OLLAMA_URL, 5000)
          : new VoyageEmbedder(key!, model, { timeoutMs: 5000, maxAttempts: 1 });
        if (pinned && pinned !== embedder.id) {
          add('embedding_model', 'error', 'The configured embedding model differs from the corpus model.', 'Match the existing model, or deliberately switch using contextual reindex --all.');
        }
        await embedder.embed(['contextual connectivity check'], 'query');
        add('embeddings', 'ok', 'Embedding provider returned a valid 1024-dimensional test vector.');
      }
    } catch {
      add('embeddings', 'error', 'The embedding provider did not return a valid test vector.', 'Check credentials, provider URL, model availability and dimensions. Full-text retrieval remains available.');
    }
  } else add('embeddings', 'warning', 'Skipped because configuration is invalid.');
  return { ok: !checks.some((c) => c.status === 'error'), checks };
}

export function hostConfig(): { command: string; args: string[]; env: Record<string, string> } {
  const bundled = /\$bunfs|~BUN/.test(import.meta.url);
  const env: Record<string, string> = {};
  // This file is often committed. Credentials and endpoint URLs (which may
  // contain passwords) must come from the MCP host's environment, never JSON.
  const safeSettings = [
    'CONTEXTUAL_EMBED_PROVIDER', 'CONTEXTUAL_EMBED_MODEL', 'CONTEXTUAL_RERANK', 'CONTEXTUAL_RERANK_MODEL',
    'CONTEXTUAL_SEARCH_TIMEOUT_MS', 'CONTEXTUAL_GREP_TIMEOUT_MS', 'CONTEXTUAL_MAX_DISTANCE',
    'CONTEXTUAL_MAX_RESOURCE_BLOB_BYTES', 'CONTEXTUAL_RESOURCE_PAGE',
    'CONTEXTUAL_VOYAGE_TIMEOUT_MS', 'CONTEXTUAL_VOYAGE_MAX_ATTEMPTS', 'CONTEXTUAL_VOYAGE_RETRY_MAX_MS',
    'CONTEXTUAL_OLLAMA_TIMEOUT_MS',
  ];
  for (const key of safeSettings) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.CONTEXTUAL_BLOB_DIR = resolve(process.env.CONTEXTUAL_BLOB_DIR ?? 'blobs');
  return { command: process.execPath, args: bundled ? ['serve'] : ['run', fileURLToPath(new URL('./contextual.ts', import.meta.url)), 'serve'], env };
}

/** Merge only our entry; malformed files and unrelated server entries survive. */
export async function initConfig(output: string, force = false): Promise<{ path: string; written: boolean }> {
  const path = resolve(output);
  let previous: string | undefined;
  let config: Record<string, any> = {};
  try {
    if (!(await lstat(path)).isFile()) throw new Error('init: output must be a regular file, not a directory or symlink');
    previous = await readFile(path, 'utf8');
    config = JSON.parse(previous);
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.mcpServers !== undefined &&
      (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw new Error('init: invalid MCP configuration shape');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('init: cannot merge output. Ensure it is a regular file containing valid MCP JSON.');
  }
  const server = hostConfig();
  const existing = config.mcpServers?.contextual;
  const unchanged = isDeepStrictEqual(existing, server);
  if (existing && !unchanged && !force) {
    throw new Error('init: contextual is already configured differently. Use --force to replace only that entry, or --output for a separate file.');
  }
  await mkdir(server.env.CONTEXTUAL_BLOB_DIR!, { recursive: true });
  if (unchanged) return { path, written: false };
  config.mcpServers = { ...config.mcpServers, contextual: server };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(config, null, 2) + '\n');
    await file.close();
    const current = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return undefined; throw err; });
    if (current !== previous) throw new Error('init: output changed during setup. Retry to merge the latest version.');
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
  }
  return { path, written: true };
}

/** Exercise the generated argv/env exactly as a host would, then stop the child. */
export async function checkMcp(server = hostConfig()): Promise<Check> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([server.command, ...server.args], {
      env: { ...process.env, ...server.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child = proc;
    // Drain logs without exposing possible credentials or corpus content.
    const logs = new Response(proc.stderr).text();
    timer = setTimeout(() => proc.kill('SIGKILL'), 8000);
    const send = (message: unknown) => proc.stdin.write(JSON.stringify(message) + '\n');
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'contextual-init', version: '1' } } });
    await proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = '', discovered = false, catalog = false;
    try {
      while (!discovered || !catalog) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Server exited before responding');
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.error || message.result?.isError) throw new Error('MCP check failed');
          if (message.id === 0) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cx_ls', arguments: { path: '/' } } });
            await proc.stdin.flush();
          }
          if (message.id === 1) {
            const names = new Set(message.result?.tools?.map((tool: { name: string }) => tool.name));
            if (!['cx_ls', 'cx_glob', 'cx_grep', 'cx_read', 'cx_search', 'cx_skill'].every((name) => names.has(name))) throw new Error('Required tools are missing');
            discovered = true;
          }
          if (message.id === 2) {
            catalog = message.result?.content?.some((item: { type: string }) => item.type === 'text') === true;
            if (!catalog) throw new Error('Catalog response is missing');
          }
        }
      }
    } finally { reader.releaseLock(); proc.kill(); await proc.exited; await logs; }
    return { name: 'mcp', status: 'ok', message: 'Generated configuration starts the server, discovers the required tools, and reads the catalog.' };
  } catch {
    return { name: 'mcp', status: 'error', message: 'The generated MCP configuration did not complete a stdio round trip.', suggested_action: 'Check the executable and server paths, runtime dependencies, and server logs, then rerun contextual init.' };
  } finally {
    if (timer) clearTimeout(timer);
    child?.kill();
  }
}

export async function runSetup(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    json: { type: 'boolean' }, output: { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command] = positionals;
  if (values.help) {
    console.log('Usage: contextual doctor [--json]\n       contextual init [--output .mcp.json] [--force] [--json]\n\ninit merges the contextual server entry, creates blob storage, and runs doctor.\ndoctor checks the runtime, configuration, database, migrations, storage and embedding provider.');
    return;
  }
  if (positionals.length !== 1 || !['doctor', 'init'].includes(command!)) throw new Error('Use contextual doctor or contextual init --help.');
  if (command === 'doctor' && (values.output || values.force)) throw new Error('--output and --force are only valid with init');
  const output = command === 'init' ? await initConfig(values.output ?? '.mcp.json', values.force) : undefined;
  const report = await doctor();
  if (output) {
    report.checks.push({ name: 'host_environment', status: 'warning', message: 'Credentials and endpoint URLs are inherited, not saved in the configuration.',
      suggested_action: 'Configure CONTEXTUAL_DATABASE_URL, CONTEXTUAL_OLLAMA_URL and API keys as needed through your MCP host\'s environment or secret settings. The startup check uses this shell\'s environment.' });
    report.checks.push(report.ok ? await checkMcp() : { name: 'mcp', status: 'warning', message: 'Server startup check skipped until the diagnostic errors above are resolved.' });
    report.ok = !report.checks.some((check) => check.status === 'error');
  }
  if (values.json) console.log(JSON.stringify({ ...report, ...(output && { config: output }) }, null, 2));
  else {
    if (output) console.log(`${output.written ? 'Wrote' : 'Already configured'}: ${output.path}`);
    for (const check of report.checks) console.log(`${{ ok: '✓', warning: '⚠', error: '✗' }[check.status]} ${check.name}: ${check.message}${check.suggested_action ? `\n  ${check.suggested_action}` : ''}`);
  }
  if (!report.ok) process.exitCode = 1;
}
