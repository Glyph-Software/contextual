/** Synchronous multipart ingestion; originals are staged privately and removed afterward. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../core/db';
import { ingest, type IngestResult } from '../core/ingest/pipeline';
import { assertSafeName } from '../core/vfs/uri';
import { HttpInputError, jsonError, readBody } from './http-body';
import { log } from './format';

interface UploadLimits { maxBytes: number; maxFiles: number }
type UploadResult = IngestResult & { input: string };
type ParsedForm = Awaited<ReturnType<Response['formData']>>;

function validateName(value: string, field: string): void {
  try {
    assertSafeName(value, field);
    if (/[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 255) throw new Error('invalid name');
  } catch { throw new HttpInputError(400, 'invalid_field', `${field} must be a single name without path separators or control characters, at most 255 UTF-8 bytes`); }
}

function parseForm(form: ParsedForm, maxFiles: number) {
  const files: File[] = [];
  const fields = new Map<string, string>();
  const names = new Set<string>();
  for (const [key, value] of form) {
    if (key === 'file' || key === 'files') {
      if (typeof value === 'string') throw new HttpInputError(400, 'invalid_field', `${key} must contain a file`);
      validateName(value.name, 'filename');
      if (names.has(value.name)) throw new HttpInputError(400, 'duplicate_filename', 'Filenames must be unique within one upload request');
      names.add(value.name);
      files.push(value);
      if (files.length > maxFiles) throw new HttpInputError(413, 'too_many_files', `At most ${maxFiles} files are allowed per request`);
    } else {
      if (!['collection', 'force', 'lenient'].includes(key) || typeof value !== 'string' || fields.has(key)) {
        throw new HttpInputError(400, 'invalid_field', 'Use file/files and optional single collection, force, and lenient fields');
      }
      fields.set(key, value);
    }
  }
  if (!files.length) throw new HttpInputError(400, 'missing_files', 'Include at least one file in file or files');
  const collection = fields.get('collection') ?? 'default';
  validateName(collection, 'collection');
  const boolean = (key: string) => {
    const value = fields.get(key);
    if (value !== undefined && value !== 'true' && value !== 'false') {
      throw new HttpInputError(400, 'invalid_field', `${key} must be true or false`);
    }
    return value === 'true';
  };
  return { files, collection, force: boolean('force'), lenient: boolean('lenient') };
}

async function ingestUpload(request: Request, limits: UploadLimits, shutdown: AbortSignal): Promise<Response> {
  let directory: string | undefined;
  try {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'multipart/form-data') {
      throw new HttpInputError(415, 'unsupported_media_type', 'Use multipart/form-data with file or files parts');
    }
    const signal = AbortSignal.any([request.signal, shutdown, AbortSignal.timeout(120000)]);
    const body = await readBody(request, limits.maxBytes, signal);
    let form: ParsedForm;
    try { form = await new Response(body, { headers: { 'content-type': request.headers.get('content-type')! } }).formData(); }
    catch { throw new HttpInputError(400, 'invalid_multipart', 'Malformed multipart body or missing boundary'); }
    const { files, ...options } = parseForm(form, limits.maxFiles);
    signal.throwIfAborted();
    // Match CLI add: migrations finish before any source is ingested.
    try { await migrate(); }
    catch (err) {
      log('upload database unavailable:', (err as Error).message);
      return jsonError(503, 'ingest_unavailable', 'Ingestion unavailable; check server logs and database configuration');
    }
    directory = await mkdtemp(join(tmpdir(), 'contextual-upload-'));
    const results: UploadResult[] = [];
    const messages: string[] = [];
    const clean = (message: string) => message.replaceAll(directory!, '[upload]').slice(0, 1000);
    for (const file of files) {
      // After ingestion begins, finish the batch even if its client disconnects.
      // Source writes are transactional, but the batch is not one transaction.
      const path = join(directory, file.name);
      try {
        await Bun.write(path, file);
        const ingested = await ingest(path, { ...options, uploaded: true, onProgress: (message) => {
          if (messages.length < 50) messages.push(clean(message));
        } });
        if (!ingested.length) throw new Error('No sources found in the uploaded file');
        results.push(...ingested.map((result) => ({
          ...result, input: file.name, ...(result.detail ? { detail: clean(result.detail) } : {}),
        })));
      } catch (err) {
        log(`upload ${file.name} failed:`, (err as Error).message);
        // Expected validation errors can explain what to fix. Infrastructure
        // errors stay in server logs instead of exposing paths or credentials.
        const name = (err as Error).constructor.name;
        const detail = ['SkillValidationError', 'UnsafeZipError', 'BundleTooLargeError', 'UriError'].includes(name)
          ? clean((err as Error).message) : 'Could not ingest this file; check server logs';
        results.push({ input: file.name, name: file.name, kind: /\.(zip|skill)$/i.test(file.name) ? 'skill' : 'doc',
          collection: options.collection, status: 'failed', nodes: 0, chunks: 0, embedded: 0, uris: [], detail });
      }
    }
    const summary = { files: files.length, ingested: 0, unchanged: 0, needs_ocr: 0, failed: 0 };
    for (const result of results) summary[result.status]++;
    const successful = summary.ingested + summary.unchanged;
    const failed = summary.failed + summary.needs_ocr;
    return Response.json({ status: failed ? (successful ? 'partial' : 'failed') : 'completed', summary, results, messages },
      { status: failed ? (successful ? 207 : 422) : 200 });
  } catch (err) {
    if (err instanceof HttpInputError) return jsonError(err.status, err.code, err.message);
    if (request.signal.aborted || shutdown.aborted) return jsonError(400, 'upload_aborted', 'Upload interrupted before ingestion started');
    if ((err as Error).name === 'TimeoutError') return jsonError(408, 'upload_timeout', 'Upload body must arrive within 120 seconds');
    log('upload failed:', (err as Error).message);
    return jsonError(500, 'upload_failed', 'Upload failed; check server logs');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** One active upload per listener bounds memory and serializes replacements. */
export function createUploadApi(limits: UploadLimits) {
  const shutdown = new AbortController();
  let active: Promise<Response> | undefined;
  return {
    async handle(request: Request): Promise<Response> {
      if (shutdown.signal.aborted) return jsonError(503, 'server_shutting_down', 'Server shutting down');
      if (request.method !== 'POST') return jsonError(405, 'method_not_allowed', 'Use POST to upload files', { Allow: 'POST' });
      if (active) return jsonError(429, 'ingest_busy', 'Another upload is in progress; retry after it finishes', { 'Retry-After': '1' });
      active = ingestUpload(request, limits, shutdown.signal);
      try { return await active; }
      finally { active = undefined; }
    },
    async close() {
      shutdown.abort();
      await active?.catch(() => {});
    },
  };
}
