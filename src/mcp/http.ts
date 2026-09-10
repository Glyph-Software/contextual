/** Streamable HTTP on Bun's web-standard server, sharing one corpus watcher. */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createMcpHandler, hostHeaderValidationResponse, originValidationResponse,
  localhostAllowedHostnames,
} from '@modelcontextprotocol/server';
import { watchForChanges } from '../core/catalog/watch';
import { INDEX_URI } from '../core/vfs/uri';
import { createServer } from './server';
import { log } from './format';
import { envNumber } from '../core/config';
import { createUploadApi } from './uploads';
import { HttpInputError, jsonError, readBody } from './http-body';

export interface HttpOptions {
  host?: string;
  port?: number;
  token?: string;
  allowedHosts?: string[];
}

export function startHttpServer(options: HttpOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const token = options.token ?? process.env.CONTEXTUAL_HTTP_TOKEN;
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
  if (!host.trim() || /[\s/?#@]/.test(host)) throw new Error('HTTP host must be a hostname or IP address');
  // Port 0 is useful for embedded callers and tests; the CLI accepts 1–65535.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HTTP port must be an integer between 0 and 65535');
  if (token !== undefined && (!token.trim() || token !== token.trim() || /\s/.test(token))) {
    throw new Error('CONTEXTUAL_HTTP_TOKEN must be a nonempty token without whitespace');
  }
  if (!loopback && !token) throw new Error('Set CONTEXTUAL_HTTP_TOKEN before binding HTTP outside loopback');

  const configuredHosts = options.allowedHosts ?? process.env.CONTEXTUAL_HTTP_ALLOWED_HOSTS?.split(',').map((h) => h.trim());
  if (!configuredHosts && ['0.0.0.0', '::', '[::]'].includes(host)) {
    throw new Error('Set CONTEXTUAL_HTTP_ALLOWED_HOSTS to the hostnames clients use when binding all interfaces');
  }
  const allowedHosts = configuredHosts ?? (loopback ? localhostAllowedHostnames() : [host]);
  if (!allowedHosts.length || allowedHosts.some((h) => {
    try { return !h || new URL(`http://${h}`).hostname !== h || /[/?#@*]/.test(h); }
    catch { return true; }
  })) throw new Error('CONTEXTUAL_HTTP_ALLOWED_HOSTS must contain comma-separated hostnames or IPs without ports (IPv6 in brackets)');

  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expectedAuth = token ? digest(`Bearer ${token}`) : undefined;
  const maxUploadBytes = envNumber('CONTEXTUAL_UPLOAD_MAX_BYTES');
  const uploads = createUploadApi({ maxBytes: maxUploadBytes, maxFiles: envNumber('CONTEXTUAL_UPLOAD_MAX_FILES') });
  const handler = createMcpHandler(({ era }) => createServer(era, false), {
    onerror: (err) => log('http transport:', err.message),
    legacy: 'stateless',
  });
  let closed = false;
  let listener: ReturnType<typeof Bun.serve>;
  try {
    listener = Bun.serve({
      hostname: host,
      port,
      // SSE subscriptions stay open between corpus updates.
      idleTimeout: 0,
      maxRequestBodySize: Math.max(maxUploadBytes, 1024 * 1024),
      async fetch(request) {
        if (closed) return new Response('Server shutting down', { status: 503 });
        const rejected = hostHeaderValidationResponse(request, allowedHosts)
          ?? originValidationResponse(request, allowedHosts);
        if (rejected) return rejected;
        const path = new URL(request.url).pathname;
        if (path !== '/mcp' && path !== '/api/ingest') return new Response('Not found', { status: 404 });
        if (expectedAuth && !timingSafeEqual(expectedAuth, digest(request.headers.get('authorization') ?? ''))) {
          return jsonError(401, 'unauthorized', 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="contextual"' });
        }
        if (path === '/api/ingest') return uploads.handle(request);
        try {
          // Raising the listener's ceiling for files must not raise MCP's cap.
          if (request.method === 'POST') {
            const body = await readBody(request, 1024 * 1024);
            request = new Request(request, { body });
          }
          return await handler.fetch(request);
        } catch (err) {
          if (err instanceof HttpInputError) return jsonError(err.status, err.code, err.message);
          throw err;
        }
      },
      error(err) {
        log('http request failed:', err.message);
        return new Response('Internal server error', { status: 500 });
      },
    });
  } catch (err) {
    void handler.close();
    throw err;
  }

  const stopWatching = watchForChanges((uris) => {
    if (closed) return;
    handler.notify.resourcesChanged();
    for (const uri of new Set([INDEX_URI, ...uris])) handler.notify.resourceUpdated(uri);
  });
  return {
    url: new URL('/mcp', listener.url).href,
    async close() {
      if (closed) return;
      closed = true;
      stopWatching();
      const drainUploads = uploads.close();
      // Close modern SSE exchanges, then terminate remaining legacy requests.
      try { await handler.close(); }
      finally { await listener.stop(true); await drainUploads; }
    },
  };
}
