/**
 * A deterministic, offline embedder.
 *
 * Retrieval quality is not what these tests check — the SQL is. A hashing
 * embedder gives stable vectors with no API key and no network, so the vector
 * half of the hybrid query is exercised on every run rather than only on
 * machines that happen to have credentials.
 */
import { EMBED_DIMS, type Embedder } from '../src/core/ingest/embed';

export class HashEmbedder implements Embedder {
  readonly id = 'hash-test';
  readonly dims = EMBED_DIMS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => vectorFor(t));
  }
}

function vectorFor(text: string): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  // Bag-of-words hashing: documents sharing vocabulary land near each other,
  // which is enough for cosine ordering to be meaningful in a test.
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const h = Number(BigInt(Bun.hash(word) as number | bigint) % BigInt(EMBED_DIMS));
    v[h]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

import { SQL } from 'bun';
export const BASE_TEST_URL = process.env.CONTEXTUAL_DATABASE_URL ?? 'postgres://contextual:contextual@localhost:55432/contextual';
export function schemaUrl(schema: string): string {
  const url = new URL(BASE_TEST_URL);
  const options = (url.searchParams.get('options') ?? '').replace(/(?:^|\s)-c\s*search_path=\S+/g, '').trim();
  url.searchParams.set('options', `${options} -c search_path=${schema},public`.trim());
  return url.href;
}
export async function databaseAvailable(): Promise<boolean> {
  const sql = new SQL({ url: BASE_TEST_URL, connectionTimeout: 1 });
  try { await sql`SELECT 1`; return true; }
  catch {
    if (process.env.CONTEXTUAL_REQUIRE_DB_TESTS === '1') throw new Error('Postgres required for CI; start docker compose up -d');
    process.stderr.write('Skipping Postgres suites: start docker compose up -d to enable them.\n');
    return false;
  } finally { await sql.close(); }
}
