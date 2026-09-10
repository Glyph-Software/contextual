import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, NeedsOcrError } from '../src/core/ingest/document';
import { localPdfMarkdown } from '../src/core/ingest/local-ocr';
import { ocrLanguage, ocrMode } from '../src/core/config';

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const hasTools = ['tesseract', 'pdftoppm', 'pdfseparate', 'pdfunite'].every((name) => Bun.which(name));
if (!hasTools && process.env.CONTEXTUAL_REQUIRE_OCR_TESTS === '1') throw new Error('OCR tests require Tesseract and Poppler');
const nativeTest = hasTools ? test : test.skip;
const keys = ['PATH', 'CONTEXTUAL_OCR', 'CONTEXTUAL_OCR_LANGUAGE', 'CONTEXTUAL_OCR_TIMEOUT_MS', 'CONTEXTUAL_OCR_DOCUMENT_TIMEOUT_MS', 'CONTEXTUAL_OCR_MAX_PAGES'];
let saved: Record<string, string | undefined>;
let work: string;
const temporaryOcr = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('contextual-ocr-')).sort();

beforeEach(async () => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys.slice(1)) delete process.env[key];
  process.env.CONTEXTUAL_OCR = 'local';
  work = await mkdtemp(join(tmpdir(), 'contextual-test-ocr-'));
});
afterEach(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(work, { recursive: true, force: true });
});

async function fakeTool(name: string, code: string) {
  const path = join(work, name);
  await Bun.write(path, `#!${process.execPath}\n${code}\n`);
  await chmod(path, 0o755);
  process.env.PATH = work;
}

describe('local OCR routing and configuration', () => {
  test('reject remains the non-container default and settings are validated', () => {
    delete process.env.CONTEXTUAL_OCR;
    expect(ocrMode()).toBe('reject');
    process.env.CONTEXTUAL_OCR = 'typo';
    expect(ocrMode).toThrow('CONTEXTUAL_OCR');
    expect(ocrLanguage()).toBe('eng');
    process.env.CONTEXTUAL_OCR_LANGUAGE = 'eng+deu';
    expect(ocrLanguage()).toBe('eng+deu');
    process.env.CONTEXTUAL_OCR_LANGUAGE = '--help';
    expect(ocrLanguage).toThrow('CONTEXTUAL_OCR_LANGUAGE');
  });
  test('digital PDFs need no OCR executables and keep native headings', async () => {
    process.env.PATH = work;
    const result = await normalize(await Bun.file(fixture('sample.pdf')).bytes(), 'sample.pdf');
    expect(result.markdown).toContain('Migration Runbook');
    expect(result.blocks.some((block) => block.kind === 'heading')).toBe(true);
  });
  test('reject mode still records scanned pages without invoking a tool', async () => {
    process.env.PATH = work;
    process.env.CONTEXTUAL_OCR = 'reject';
    const error = await normalize(await Bun.file(fixture('scanned-text.pdf')).bytes(), 'scan.pdf').catch((error) => error);
    expect(error).toBeInstanceOf(NeedsOcrError);
    expect(error.pages).toEqual([1]);
    expect(error.message).toContain('CONTEXTUAL_OCR=local');
  });
  test('missing executables have an actionable error', async () => {
    process.env.PATH = work;
    await expect(normalize(await Bun.file(fixture('scanned-text.pdf')).bytes(), 'scan.pdf')).rejects.toThrow('Install tesseract-ocr');
  });
  test('limits oversized documents before starting any tools', async () => {
    process.env.CONTEXTUAL_OCR_MAX_PAGES = '1';
    await expect(localPdfMarkdown(new Uint8Array(), [2], 2)).rejects.toThrow('CONTEXTUAL_OCR_MAX_PAGES');
  });
});

describe('real Tesseract and Poppler', () => {
  nativeTest('recognizes an image-only PDF and cleans up temporary files', async () => {
    const before = await temporaryOcr();
    const result = await normalize(await Bun.file(fixture('scanned-text.pdf')).bytes(), 'scan.pdf');
    expect(result.markdown).toContain('Migration Runbook');
    expect(result.markdown).toContain('850 milliseconds');
    expect(result.markdown).toContain('amber key');
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(await temporaryOcr()).toEqual(before);
  }, 30000);
  nativeTest('mixed PDFs retain all pages, their order, and digital headings', async () => {
    const mixed = join(work, 'mixed.pdf');
    const child = Bun.spawn(['pdfunite', fixture('sample.pdf'), fixture('scanned-text.pdf'), fixture('sample.pdf'), mixed], { stdout: 'ignore', stderr: 'pipe' });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code) throw new Error(error);
    const result = await normalize(await Bun.file(mixed).bytes(), 'mixed.pdf');
    expect(result.markdown.match(/850 milliseconds/g)).toHaveLength(3);
    expect(result.blocks.filter((block) => block.kind === 'heading' && block.text.includes('Migration Runbook'))).toHaveLength(2);
    const headings = [...result.markdown.matchAll(/^#+ .*Migration Runbook/gm)].map((match) => match.index!);
    const plain = result.markdown.indexOf('\n\nMigration Runbook');
    expect(plain).toBeGreaterThan(headings[0]!);
    expect(plain).toBeLessThan(headings[1]!);
  }, 30000);
  nativeTest('unreadable image-only pages do not become empty searchable documents', async () => {
    const before = await temporaryOcr();
    await expect(normalize(await Bun.file(fixture('scanned.pdf')).bytes(), 'scan.pdf')).rejects.toThrow('no readable text');
    expect(await temporaryOcr()).toEqual(before);
  }, 30000);
});

describe('subprocess failures and resource limits', () => {
  test('kills a stalled renderer, cleans up, and releases the OCR queue', async () => {
    await fakeTool('pdftoppm', 'await Bun.sleep(60000);');
    await fakeTool('tesseract', 'console.log("unused");');
    process.env.CONTEXTUAL_OCR_TIMEOUT_MS = '30';
    const before = await temporaryOcr();
    await expect(localPdfMarkdown(new Uint8Array(), [1], 1)).rejects.toThrow('timed out');
    expect(await temporaryOcr()).toEqual(before);
    await fakeTool('pdftoppm', 'console.error("renderer failure"); process.exit(7);');
    process.env.CONTEXTUAL_OCR_TIMEOUT_MS = '5000';
    await expect(localPdfMarkdown(new Uint8Array(), [1], 1)).rejects.toThrow('renderer failure');
    expect(await temporaryOcr()).toEqual(before);
  });
  test('document deadline also bounds a stalled subprocess', async () => {
    await fakeTool('pdftoppm', 'await Bun.sleep(60000);');
    await fakeTool('tesseract', 'console.log("unused");');
    process.env.CONTEXTUAL_OCR_DOCUMENT_TIMEOUT_MS = '30';
    await expect(localPdfMarkdown(new Uint8Array(), [1], 1)).rejects.toThrow('timed out');
  });
  test('Tesseract failures and missing language data propagate without partial ingestion', async () => {
    await fakeTool('pdftoppm', 'await Bun.write(process.argv.at(-1) + ".pgm", "P5\\n1 1\\n255\\n ");');
    await fakeTool('tesseract', 'console.error("Failed loading language deu"); process.exit(1);');
    const before = await temporaryOcr();
    await expect(localPdfMarkdown(new Uint8Array(), [1], 1)).rejects.toThrow('Failed loading language');
    expect(await temporaryOcr()).toEqual(before);
  });
  test('serializes concurrent documents and bounds Tesseract threads', async () => {
    const lock = join(work, 'active');
    // Exclusive creation detects overlapping rendering/OCR across documents.
    await fakeTool('pdftoppm', `import { open } from 'node:fs/promises'; await open(${JSON.stringify(lock)}, 'wx'); await Bun.write(process.argv.at(-1) + '.pgm', 'image');`);
    await fakeTool('tesseract', `import { unlink } from 'node:fs/promises'; if (process.env.OMP_THREAD_LIMIT !== '1') process.exit(2); await Bun.sleep(30); await unlink(${JSON.stringify(lock)}); console.log('Recognized text');`);
    const result = await Promise.all([localPdfMarkdown(new Uint8Array(), [1], 1), localPdfMarkdown(new Uint8Array(), [1], 1)]);
    expect(result).toEqual(['Recognized text\n', 'Recognized text\n']);
  });
});
