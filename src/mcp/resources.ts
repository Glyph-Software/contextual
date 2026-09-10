import { envNumber } from '../core/config';
/**
 * The Resources surface: application-driven addressability.
 *
 * A host application (or a human typing `@contextual:...`) drives these; an
 * agent cannot list or read them on its own. That asymmetry is why the Tools
 * surface exists alongside it — but both address the same `ctx://` URIs, so a
 * `resource_link` returned by a tool is a citation a human can follow.
 *
 * `resources/list` deliberately returns only meaningful entries: the catalog,
 * one SKILL.md per skill, one entry per document. Not every asset, and never a
 * chunk — the spec permits tools to link to URIs that are not listed, which is
 * what keeps this list small while chunk-level citation still works. It is
 * paginated with an opaque cursor, as the spec allows, so a corpus of
 * thousands of documents does not become one giant reply.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { ReadResourceResult, Resource } from '@modelcontextprotocol/server';
import type { Transport } from '@modelcontextprotocol/server';
import { db } from '../core/db';
import { loadCatalog, renderCatalog } from '../core/catalog/index';
import { resolveNode, resolveChunk } from '../core/vfs/resolve';
import { INDEX_URI, buildUri, parseUri } from '../core/vfs/uri';
import { watchForChanges } from '../core/catalog/watch';
import { log, MAX_INLINE_BLOB_BYTES } from './format';

/** URIs the client has asked to be notified about. */
const subscriptions = new Set<string>();
let active: McpServer | undefined;

let modernClient = false;

/**
 * Ceiling on a blob returned by `resources/read`. Higher than the tool-surface
 * limit because a human asked for this specific file by URI, but still a
 * bound: without one, a single `@`-mention can exhaust the stdio process.
 */
export const MAX_RESOURCE_BLOB_BYTES = envNumber('CONTEXTUAL_MAX_RESOURCE_BLOB_BYTES');

/** Page size for `resources/list`. Overridable so a test can exercise paging. */
const PAGE = envNumber('CONTEXTUAL_RESOURCE_PAGE');

export function registerResources(server: McpServer, era: 'legacy' | 'modern' = 'legacy', watch = true): void {
  // HTTP constructs a server per request and publishes changes through its
  // shared handler. Only a long-lived stdio connection owns this registry.
  if (watch) {
    stopResourceWatch();
    subscriptions.clear();
    modernClient = era === 'modern';
    active = server;
  }

  server.registerResource(
    'catalog',
    INDEX_URI,
    {
      title: 'contextual catalog',
      description: 'Level-0 index: every skill and document collection available. Always cheap to read.',
      mimeType: 'text/markdown',
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderCatalog(await loadCatalog()) }],
    }),
  );

  server.registerResource(
    'skill-file',
    new ResourceTemplate('ctx://skills/{skill}/{+path}', {
      // Listing is handled by the paginated resources/list handler below.
      list: undefined,
      complete: {
        // Autocompletes skill names from the database, so a human typing an
        // `@`-mention discovers what exists without reading the catalog first.
        skill: async (value) => {
          const rows = (await db()`
            SELECT name FROM skills WHERE name ILIKE ${`${value}%`} ORDER BY name LIMIT 100
          `) as unknown as { name: string }[];
          return rows.map((r) => r.name);
        },
      },
    }),
    { title: 'Skill bundle file', description: 'A file inside an ingested Agent Skill bundle.' },
    readResource,
  );

  server.registerResource(
    'document',
    new ResourceTemplate('ctx://docs/{collection}/{+path}', {
      list: undefined,
      complete: {
        collection: async (value) => {
          const rows = (await db()`
            SELECT DISTINCT coalesce(collection,'default') AS collection FROM sources
            WHERE kind='doc' AND coalesce(collection,'default') ILIKE ${`${value}%`} ORDER BY 1 LIMIT 100
          `) as unknown as { collection: string }[];
          return rows.map((r) => r.collection);
        },
      },
    }),
    { title: 'Document', description: 'Normalized markdown of an ingested document.' },
    readResource,
  );

  // The SDK's own list handler concatenates every template's callback with no
  // cursor. This one replaces it with a single ordered query and a page.
  server.server.setRequestHandler('resources/list', async (req) => {
    const offset = decodeCursor(req.params?.cursor);
    const rows = await listPage(offset, PAGE + 1);
    const page = rows.slice(0, PAGE);
    const nextCursor = rows.length > PAGE ? encodeCursor(offset + PAGE) : undefined;
    return { resources: page, ...(nextCursor && { nextCursor }) };
  });

  if (!watch) return;

  // The SDK does not implement resources/subscribe, so the subscription
  // registry lives here. Without it, declaring `subscribe: true` would
  // advertise a capability that errors when used.
  server.server.setRequestHandler('resources/subscribe', async (req) => {
    subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });

  // Re-ingest happens in the CLI process, so the server watches the database
  // rather than waiting for a callback that can never arrive.
  stopWatching = watchForChanges(async (uris) => {
    log(`corpus changed (${uris.length} uri${uris.length === 1 ? '' : 's'}); notifying`);
    await notifyChanged(uris);
  });
}

async function listPage(offset: number, limit: number): Promise<Resource[]> {
  const rows = (await db()`
    SELECT uri, name, title, description, "mimeType" FROM (
      SELECT 0 AS grp, ''::text AS sort, ${INDEX_URI}::text AS uri, 'catalog'::text AS name,
             'contextual catalog'::text AS title,
             'Level-0 index: every skill and document collection available. Always cheap to read.'::text AS description,
             'text/markdown'::text AS "mimeType"
      UNION ALL
      SELECT 1, sk.name, n.uri, sk.name || '/SKILL.md', sk.name, sk.description, 'text/markdown'
      FROM skills sk
      JOIN sources s ON s.id = sk.source_id
      JOIN nodes n ON n.source_id = s.id AND n.role = 'skill_md'
      UNION ALL
      SELECT 2, coalesce(s.collection,'default') || '/' || n.path, n.uri,
             coalesce(s.collection,'default') || '/' || n.path, s.name,
             'Normalized markdown of ' || s.name || CASE WHEN s.status <> 'ready' THEN ' (' || s.status || ')' ELSE '' END,
             'text/markdown'
      FROM nodes n JOIN sources s ON s.id = n.source_id
      WHERE s.kind = 'doc' AND n.role = 'doc'
    ) x
    ORDER BY grp, sort
    LIMIT ${limit} OFFSET ${offset}
  `) as unknown as Resource[];
  return rows;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o: unknown };
    if (Number.isInteger(o) && (o as number) >= 0) return o as number;
  } catch {
    /* fall through */
  }
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'invalid cursor');
}

let stopWatching: (() => void) | undefined;

export function stopResourceWatch(): void {
  stopWatching?.();
  stopWatching = undefined;
}

async function readResource(uri: URL): Promise<ReadResourceResult> {
  const href = uri.href;
  const parsed = parseUri(href);

  if (parsed.chunk !== undefined) {
    const chunk = await resolveChunk(href);
    if (!chunk) throw new ResourceNotFoundError(href);
    return { contents: [{ uri: href, mimeType: 'text/markdown', text: chunk.content }] };
  }

  const node = await resolveNode(href);
  if (!node) throw new ResourceNotFoundError(href);

  // Binary assets are stored by reference, not inlined into a text field.
  if (node.content === null && node.blobRef) {
    const file = Bun.file(node.blobRef);
    // Base64 of a large file is ~1.33x its size in memory, on top of the
    // bytes themselves. This handler is reachable by a human `@`-mentioning
    // an asset, so it needs the same ceiling cx_read enforces rather than
    // trusting whatever happens to be on disk.
    if (file.size > MAX_RESOURCE_BLOB_BYTES) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `${href} is ${file.size} bytes, over the ${MAX_RESOURCE_BLOB_BYTES}-byte limit for an inline resource read`,
      );
    }
    const bytes = await file.bytes();
    return {
      contents: [{ uri: href, mimeType: node.mimeType ?? 'application/octet-stream', blob: Buffer.from(bytes).toString('base64') }],
    };
  }
  return { contents: [{ uri: href, mimeType: node.mimeType ?? 'text/plain', text: node.content ?? '' }] };
}

/**
 * Called after the corpus changes. `list_changed` always goes out, so the
 * host re-reads the catalog. `updated` goes to every changed URI when the
 * client is on a listen-style protocol, and otherwise only to URIs it
 * subscribed to.
 */
export async function notifyChanged(changedUris: string[] = []): Promise<void> {
  if (!active) return;
  try {
    active.server.sendResourceListChanged();
    const touched = new Set([INDEX_URI, ...changedUris]);
    for (const uri of touched) {
      if (modernClient || subscriptions.has(uri)) await active.server.sendResourceUpdated({ uri });
    }
  } catch (err) {
    log('notify failed:', err);
  }
}

/** Test seam: the server process and the CLI ingest path are separate processes. */
export const _subscriptions = subscriptions;
export const skillMdUri = (name: string) => buildUri('skills', name, 'SKILL.md');
