// Builds two PDFs by hand: one with a real text layer, one image-only (scanned).
function build(objects: string[] | Uint8Array[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  objects.forEach((o) => { offsets.push(len); push(o as any); });
  const xref = len;
  let x = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) x += String(o).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(x);
  const out = new Uint8Array(len); let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}
const stream = (n: number, dict: string, body: string) =>
  `${n} 0 obj\n<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`;

// --- text-layer PDF ---
const text = `BT /F1 18 Tf 72 720 Td (Migration Runbook) Tj ET
BT /F1 11 Tf 72 690 Td (The failover threshold is 850 milliseconds.) Tj ET
BT /F1 11 Tf 72 670 Td (Rollback requires the amber key from the vault.) Tj ET`;
await Bun.write('/tmp/fx/sample.pdf', build([
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  stream(4, '', text),
  '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
]));

// --- scanned (image-only) PDF: no text operators at all ---
const px = String.fromCharCode(...Array.from({ length: 64 }, (_, i) => (i * 4) % 256));
await Bun.write('/tmp/fx/scanned.pdf', build([
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  stream(4, '', 'q 612 0 0 792 0 0 cm /Im0 Do Q'),
  stream(5, '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8', px),
]));
console.log('wrote sample.pdf, scanned.pdf');
