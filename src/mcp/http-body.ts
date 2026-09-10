/** Bounded body reads for multipart uploads and MCP requests, including chunked bodies. */
export class HttpInputError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const jsonError = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  Response.json({ error: { code, message } }, { status, headers });

export async function readBody(request: Request, maxBytes: number, signal = request.signal): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new HttpInputError(413, 'payload_too_large', `Request body exceeds the ${maxBytes}-byte limit`);
  }
  signal.throwIfAborted();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new HttpInputError(413, 'payload_too_large', `Request body exceeds the ${maxBytes}-byte limit`);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (err) {
    cancel();
    throw err;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
