/** An isolated, reproducible retrieval evaluation. --voyage sends only fixtures. */
import { SQL } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db, migrate, closeDb, DEFAULT_URL } from '../src/core/db';
import { ingest } from '../src/core/ingest/pipeline';
import { setEmbedder, VoyageEmbedder } from '../src/core/ingest/embed';
import { voyageRequest } from '../src/core/ingest/voyage';
import { search } from '../src/core/search/hybrid';
import { blocksFromMarkdown, chunkBlocks } from '../src/core/ingest/chunk';

interface Fixture { documents: { name: string; content: string }[]; questions: { queries: string[]; expected: string[] }[] }
const fixture: Fixture = await Bun.file(new URL('../fixtures/retrieval-eval.json', import.meta.url)).json();
const schema = `contextual_eval_${process.pid}_${Date.now()}`;
const base = process.env.CONTEXTUAL_DATABASE_URL ?? DEFAULT_URL;
const admin = new SQL(base);
const directory = await mkdtemp(join(tmpdir(), 'contextual-eval-'));
const records: Record<string, unknown>[] = [];
const metric = (rankings: string[][]) => {
  const recalls = fixture.questions.map((q, i) => q.expected.filter((name) => rankings[i]!.includes(name)).length / q.expected.length);
  const reciprocal = fixture.questions.map((q, i) => { const rank = rankings[i]!.findIndex((name) => q.expected.includes(name)); return rank < 0 ? 0 : 1 / (rank + 1); });
  return { recallAt5: recalls.reduce((a,b) => a+b,0) / recalls.length, mrr: reciprocal.reduce((a,b) => a+b,0) / reciprocal.length, questions: recalls.length };
};
try {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  process.env.CONTEXTUAL_DATABASE_URL = url.href;
  await migrate();
  setEmbedder(null);
  for (const doc of fixture.documents) {
    const path = join(directory, doc.name);
    await Bun.write(path, doc.content);
    await ingest(path, { collection: 'eval' });
  }
  const start = performance.now();
  const rankings: string[][] = [];
  for (const question of fixture.questions) rankings.push((await search(question.queries, { limit: 5 })).map((h) => h.sourceName));
  records.push({ mode: 'fts-context-prefix', ...metric(rankings), elapsedMs: Math.round(performance.now() - start) });
  if (process.argv.includes('--voyage')) {
    const key = process.env.VOYAGE_API_KEY ?? process.env.CONTEXTUAL_VOYAGE_API_KEY;
    if (!key) throw new Error('--voyage requires VOYAGE_API_KEY');
    const groups = fixture.documents.map((d) => chunkBlocks(blocksFromMarkdown(d.content)));
    const passages = groups.flatMap((chunks, i) => chunks.map((chunk) => ({ name: fixture.documents[i]!.name, text: chunk.content, prefix: [fixture.documents[i]!.name, ...chunk.headingPath].join(' / ') })));
    const queries = fixture.questions.map((q) => q.queries.join('\n'));
    const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
    const evaluate = (mode: string, vectors: number[][], queryVectors: number[][], elapsedMs: number, bytesPerVector: number) => {
      const result = queryVectors.map((query) => passages.map((p,i) => ({ name: p.name, score: cosine(query, vectors[i]!) })).sort((a,b) => b.score-a.score).slice(0,5).map((p) => p.name));
      records.push({ mode, ...metric(result), elapsedMs: Math.round(elapsedMs), bytesPerVector });
    };
    const model = new VoyageEmbedder(key, 'voyage-4');
    const queryVectors = await model.embed(queries, 'query');
    for (const prefixed of [false, true]) {
      const started = performance.now();
      const vectors = await model.embed(passages.map((p) => prefixed ? `${p.prefix}\n\n${p.text}` : p.text), 'document');
      evaluate(prefixed ? 'voyage-4-prefix' : 'voyage-4-plain', vectors, queryVectors, performance.now() - started, 4096);
      if (prefixed) {
        // Compare pgvector half precision with the same vectors, not a new model.
        const half: number[][] = [];
        for (const vector of vectors) { const [row] = await db()`SELECT ${JSON.stringify(vector)}::halfvec(1024)::text AS value`; half.push(JSON.parse(row.value)); }
        evaluate('voyage-4-prefix-halfvec', half, queryVectors, 0, 2048);
        for (const dtype of ['int8', 'binary']) {
          const began = performance.now();
          const response = await voyageRequest('embeddings', { model: 'voyage-4', input: passages.map((p) => `${p.prefix}\n\n${p.text}`), input_type: 'document', output_dimension: 1024, output_dtype: dtype }, key);
          const ordered = response.data.sort((a: any,b: any) => a.index-b.index).map((r: any) => r.embedding) as number[][];
          // Offset binary packs 8 dimensions per byte; dequantize only for this
          // small comparison. Production binary ANN needs a separate schema.
          const unpacked = dtype === 'binary' ? ordered.map((vector) => vector.flatMap((byte) => Array.from({length:8},(_,bit) => ((byte + 128) >> (7-bit)) & 1 ? 1 : -1))) : ordered;
          evaluate(`voyage-4-prefix-${dtype}`, unpacked, queryVectors, performance.now()-began, dtype === 'int8' ? 1024 : 128);
        }
      }
    }
    const began = performance.now();
    const contextual = async (inputs: string[][], kind: 'document' | 'query') => {
      const response = await voyageRequest('contextualizedembeddings', { model: 'voyage-context-4', inputs, input_type: kind, output_dimension: 1024 }, key);
      return response.data.sort((a:any,b:any) => a.index-b.index).flatMap((group:any) => group.data.sort((a:any,b:any) => a.index-b.index).map((chunk:any) => chunk.embedding)) as number[][];
    };
    const documentVectors = await contextual(groups.map((g) => g.map((c) => c.content)), 'document');
    const contextualQueries = await contextual(queries.map((q) => [q]), 'query');
    evaluate('voyage-context-4', documentVectors, contextualQueries, performance.now()-began,4096);
  }
  console.log(JSON.stringify({ fixture: 'retrieval-eval.json', caveat: 'Small synthetic fixture: smoke evaluation, not a production quality or index-size benchmark.', results: records }, null, 2));
  if ((records[0]!.recallAt5 as number) < 0.8) process.exitCode = 1;
} finally {
  await closeDb();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.close();
  process.env.CONTEXTUAL_DATABASE_URL = base;
  await rm(directory, { recursive: true, force: true });
}
