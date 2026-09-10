/**
 * Resolving a ctx:// URI to stored content. Every read in the system goes
 * through here, so this is the single place the source-root boundary is
 * enforced.
 */
import { db } from '../db';
import { parseUri, buildUri, type CtxUri } from './uri';

export interface ResolvedNode {
  id: number;
  sourceId: number;
  uri: string;
  path: string;
  role: 'skill_md' | 'reference' | 'script' | 'asset' | 'doc';
  mimeType: string | null;
  sizeBytes: number | null;
  content: string | null;
  blobRef: string | null;
  sourceKind: 'skill' | 'doc';
  sourceName: string;
  collection: string | null;
  status: string;
}

export interface ResolvedChunk {
  id: number;
  ord: number;
  headingPath: string[];
  content: string;
  tokenCount: number | null;
  node: ResolvedNode;
  uri: string;
}

export async function resolveNode(uri: string): Promise<ResolvedNode | null> {
  const parsed = parseUri(uri);
  // Rebuild rather than trusting the input string: this normalizes any
  // legal-but-unusual spelling to the one canonical form stored in nodes.uri.
  const canonical = buildUri(parsed.realm, parsed.root, parsed.path);
  const sql = db();
  const rows = (await sql`
    SELECT n.id, n.source_id AS "sourceId", n.uri, n.path, n.role, n.mime_type AS "mimeType",
           n.size_bytes AS "sizeBytes", n.content, n.blob_ref AS "blobRef",
           s.kind AS "sourceKind", s.name AS "sourceName", s.collection, s.status
    FROM nodes n JOIN sources s ON s.id = n.source_id
    WHERE n.uri = ${canonical}
  `) as unknown as ResolvedNode[];
  return rows[0] ?? null;
}

/**
 * Chunk URIs (`…#chunk=N`) are returned by search but never listed, so this
 * resolves the fragment against the chunk's ordinal within its node.
 */
export async function resolveChunk(uri: string): Promise<ResolvedChunk | null> {
  const parsed: CtxUri = parseUri(uri);
  if (parsed.chunk === undefined) return null;
  const node = await resolveNode(buildUri(parsed.realm, parsed.root, parsed.path));
  if (!node) return null;

  const sql = db();
  const rows = (await sql`
    SELECT id, ord, heading_path AS "headingPath", content, token_count AS "tokenCount"
    FROM chunks WHERE node_id = ${node.id} AND ord = ${parsed.chunk}
  `) as unknown as Omit<ResolvedChunk, 'node' | 'uri'>[];
  const row = rows[0];
  return row ? { ...row, node, uri } : null;
}

/** Chunks immediately before and after, for the "one chunk plus neighbors" read. */
export async function chunkNeighbors(nodeId: number, ord: number, radius = 1) {
  const sql = db();
  return (await sql`
    SELECT ord, heading_path AS "headingPath", content
    FROM chunks
    WHERE node_id = ${nodeId} AND ord BETWEEN ${ord - radius} AND ${ord + radius} AND ord <> ${ord}
    ORDER BY ord
  `) as unknown as { ord: number; headingPath: string[]; content: string }[];
}

export async function skillByName(name: string) {
  const sql = db();
  const rows = (await sql`
    SELECT sk.name, sk.description, sk.allowed_tools AS "allowedTools", sk.compatibility, sk.license, sk.metadata,
           s.id AS "sourceId", s.status, s.origin_uri AS "originUri", s.updated_at AS "updatedAt"
    FROM skills sk JOIN sources s ON s.id = sk.source_id
    WHERE sk.name = ${name}
  `) as unknown as {
    name: string; description: string; allowedTools: string[] | null; compatibility: string | null; license: string | null;
    metadata: Record<string, unknown> | null; sourceId: number; status: string;
    originUri: string | null; updatedAt: Date;
  }[];
  return rows[0] ?? null;
}

export async function nodesOfSource(sourceId: number) {
  const sql = db();
  return (await sql`
    SELECT path, uri, role, size_bytes AS "sizeBytes", mime_type AS "mimeType"
    FROM nodes WHERE source_id = ${sourceId} ORDER BY path
  `) as unknown as { path: string; uri: string; role: string; sizeBytes: number | null; mimeType: string | null }[];
}
