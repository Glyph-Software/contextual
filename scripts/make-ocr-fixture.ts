/** Regenerate the image-only OCR fixture from sample.pdf; requires Poppler. */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

const directory = await mkdtemp(join(tmpdir(), 'contextual-fixture-'));
try {
  const prefix = join(directory, 'scan');
  const source = new URL('../fixtures/sample.pdf', import.meta.url).pathname;
  const child = Bun.spawn(['pdftoppm', '-singlefile', '-r', '150', '-gray', source, prefix], { stdout: 'ignore', stderr: 'pipe' });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) throw new Error(error);
  const pgm = Buffer.from(await Bun.file(`${prefix}.pgm`).bytes());
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 100).toString('ascii'));
  if (!header) throw new Error('Unexpected PGM header');
  const pixels = deflateSync(pgm.subarray(header[0].length));
  const draw = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.from(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${header[1]} /Height ${header[2]} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`),
      pixels, Buffer.from('\nendstream'),
    ]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(object);
    size += object.length;
  });
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  await Bun.write(new URL('../fixtures/scanned-text.pdf', import.meta.url), Buffer.concat(parts));
} finally { await rm(directory, { recursive: true, force: true }); }
