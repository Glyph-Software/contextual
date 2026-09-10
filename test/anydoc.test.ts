/**
 * Guards the one unresolved external dependency: `@firecrawl/anydoc` is a
 * native N-API addon and Bun runs JavaScriptCore, which napi-rs treats as
 * best-effort rather than a guaranteed target.
 *
 * This began as the Milestone 0 spike. It is kept as a test because the
 * failure mode it checks for is a dependency upgrade silently breaking the
 * whole document path — and because it pins two API facts the pipeline is
 * built around.
 */
import { describe, expect, test } from 'bun:test';
import { toDocument, toMarkdownBytes, formatFromBytes, formatFromPath } from '@firecrawl/anydoc';
import { normalize, NeedsOcrError, blocksFromDocument } from '../src/core/ingest/document';

const fixture = (f: string) => Bun.file(new URL(`../fixtures/${f}`, import.meta.url).pathname).bytes();

describe('the native addon works under Bun', () => {
  test('loads and exposes its API', () => {
    expect(typeof toDocument).toBe('function');
    expect(typeof toMarkdownBytes).toBe('function');
  });

  test('parses a real .docx into the document model', async () => {
    const doc = await toDocument(await fixture('sample.docx'));
    expect(doc.blocks.length).toBeGreaterThan(0);
    const kinds = doc.blocks.map((b) => String(b.kind));
    expect(kinds).toContain('heading');
    expect(kinds).toContain('table');
  });

  test('survives concurrent conversions', async () => {
    const bytes = await fixture('sample.docx');
    const docs = await Promise.all(Array.from({ length: 20 }, () => toDocument(bytes)));
    expect(docs.every((d) => d.blocks.length > 0)).toBe(true);
  });
});

describe('format detection reads bytes, not extensions', () => {
  test('identifies a docx and a pdf from their signatures', async () => {
    expect(String(formatFromBytes(await fixture('sample.docx')))).toBe('docx');
    expect(String(formatFromBytes(await fixture('sample.pdf')))).toBe('pdf');
  });

  test('a mislabeled file still converts correctly', async () => {
    // Uploads are exactly where extensions lie.
    const n = await normalize(await fixture('sample.docx'), 'actually-a-spreadsheet.xlsx');
    expect(String(n.format)).toBe('docx');
    expect(n.via).toBe('document-model');
    expect(n.markdown).toContain('Quarterly Report');
  });

  test('the extension is the fallback for signature-less formats', () => {
    expect(String(formatFromPath('data.csv'))).toBe('csv');
  });
});

describe('PDF has no document-model form', () => {
  // This is the finding that shaped document.ts: the plan assumed toDocument()
  // worked for every format. It does not, and a silent regression here would
  // route PDFs down a path that throws.
  test('toDocument rejects a PDF with code "unsupported"', async () => {
    expect(toDocument(await fixture('sample.pdf'))).rejects.toMatchObject({ code: 'unsupported' });
  });

  test('so normalize() routes PDFs through markdown instead', async () => {
    const n = await normalize(await fixture('sample.pdf'), 'sample.pdf');
    expect(n.via).toBe('markdown');
    expect(n.markdown).toContain('Migration Runbook');
    expect(n.blocks.some((b) => b.kind === 'heading')).toBe(true);
  });
});

describe('scanned PDFs fail loudly', () => {
  test('normalize() raises NeedsOcrError naming the pages', async () => {
    const err = await normalize(await fixture('scanned.pdf'), 'scanned.pdf').catch((e) => e);
    expect(err).toBeInstanceOf(NeedsOcrError);
    expect((err as NeedsOcrError).pages).toEqual([1]);
    expect((err as NeedsOcrError).pageCount).toBe(1);
    // The message has to tell a human what their options are, including the
    // privacy cost of the opt-in one.
    expect(err.message).toContain('CONTEXTUAL_OCR=hosted');
    expect(err.message).toContain('leaves this machine');
  });

  test('OCR is off unless explicitly enabled', () => {
    expect(process.env.CONTEXTUAL_OCR).toBeUndefined();
  });
});

describe('the document model becomes a block stream', () => {
  test('headings keep their level and tables stay whole', async () => {
    const blocks = blocksFromDocument(await toDocument(await fixture('sample.docx')));
    const headings = blocks.filter((b) => b.kind === 'heading');
    expect(headings.map((h) => h.level)).toEqual([1, 2]);

    const table = blocks.find((b) => b.kind === 'table');
    expect(table!.text).toContain('| Region | Growth |');
    expect(table!.text).toContain('| --- | --- |');
    expect(table!.text).toContain('| APAC | 31% |');
  });
});
