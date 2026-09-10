/** CPU-only PDF OCR. No shell, network calls, or runtime model downloads. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toMarkdownBytes, formatFromPath } from '@firecrawl/anydoc';
import { envNumber, ocrLanguage } from '../config';

// One document at a time per service process, including concurrent HTTP uploads.
// Pages are rendered and deleted one at a time to bound raster memory/disk use.
let pending: Promise<void> = Promise.resolve();

export async function localPdfMarkdown(bytes: Uint8Array, pages: number[], pageCount: number): Promise<string> {
  const maxPages = envNumber('CONTEXTUAL_OCR_MAX_PAGES');
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > maxPages) {
    throw new Error(`Local OCR supports PDFs up to ${maxPages} pages (CONTEXTUAL_OCR_MAX_PAGES); got ${pageCount}.`);
  }
  const scanned = new Set(pages);
  if (!scanned.size || pages.some((p) => !Number.isInteger(p) || p < 1 || p > pageCount)) {
    throw new Error('Local OCR received an invalid scanned-page list.');
  }
  const language = ocrLanguage();
  const commandTimeout = envNumber('CONTEXTUAL_OCR_TIMEOUT_MS');
  const documentTimeout = envNumber('CONTEXTUAL_OCR_DOCUMENT_TIMEOUT_MS');
  const binaries = new Map<string, string>();
  for (const name of ['pdftoppm', 'tesseract', ...(scanned.size < pageCount ? ['pdfseparate'] : [])]) {
    const path = Bun.which(name, { PATH: process.env.PATH });
    if (!path) throw new Error(`Local OCR requires ${name} on PATH. Install tesseract-ocr, tesseract-ocr-eng and poppler-utils (macOS: brew install tesseract poppler).`);
    binaries.set(name, path);
  }

  const previous = pending;
  let release!: () => void;
  pending = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'contextual-ocr-'));
    const deadline = Date.now() + documentTimeout;
    const run = async (name: string, args: string[]): Promise<string> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Local OCR exceeded its ${documentTimeout} ms document timeout.`);
      const timeout = Math.min(commandTimeout, remaining);
      const child = Bun.spawn([binaries.get(name)!, ...args], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        if (timedOut) throw new Error(`Local OCR: ${name} timed out after ${timeout} ms.`);
        if (code !== 0) throw new Error(`Local OCR: ${name} exited ${code}: ${stderr.trim().slice(0, 2000)}`);
        return stdout;
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
      }
    };
    const input = join(directory, 'input.pdf');
    await Bun.write(input, bytes);
    const markdown: string[] = [];
    for (let page = 1; page <= pageCount; page++) {
      const number = String(page);
      if (scanned.has(page)) {
        const prefix = join(directory, 'page');
        // Roughly 300 DPI for A4; fixed longest side also bounds oversized sheets.
        await run('pdftoppm', ['-f', number, '-l', number, '-singlefile', '-scale-to', '3500', '-gray', input, prefix]);
        const raster = `${prefix}.pgm`;
        const text = (await run('tesseract', [raster, 'stdout', '-l', language, '--oem', '1', '--psm', '3'])).trim();
        await rm(raster, { force: true });
        if (!text) throw new Error(`Local OCR found no readable text on scanned page ${page}; the document was not ingested. Check the scan and CONTEXTUAL_OCR_LANGUAGE.`);
        markdown.push(text);
      } else {
        // Keep digital text and its native Markdown headings on mixed PDFs.
        const single = join(directory, 'digital.pdf');
        await run('pdfseparate', ['-f', number, '-l', number, input, single]);
        markdown.push(await toMarkdownBytes(await Bun.file(single).bytes(), formatFromPath(single), { ocr: 'reject' }));
        await rm(single, { force: true });
      }
      if (Date.now() > deadline) throw new Error(`Local OCR exceeded its ${documentTimeout} ms document timeout.`);
    }
    return markdown.map((text) => text.trim()).join('\n\n') + '\n';
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { release(); }
  }
}
