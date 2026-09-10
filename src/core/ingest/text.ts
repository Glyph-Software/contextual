import { TextDecoder } from 'node:util';
/** Decode textual inputs without replacing binary bytes with garbage. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    bytes = bytes.slice();
    for (let i = 0; i + 1 < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1]!, bytes[i]!];
  }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('unsupported binary or invalid text encoding'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('unsupported binary content (control bytes)');
  return text;
}
