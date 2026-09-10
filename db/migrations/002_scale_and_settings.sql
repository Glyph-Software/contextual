-- Scale and safety follow-ups from the September 2026 architecture review.
-- Every statement is idempotent; a fresh database applies 001 then this.

-- Facts the schema depends on but cannot carry as constants: the text-search
-- configuration the generated ts columns use, and the embedding model behind
-- chunks.embedding. See core/db.ts (getSetting / setSetting).
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES ('fts_config', '{{FTS_CONFIG}}')
  ON CONFLICT (key) DO NOTHING;

-- cx_grep matches with ~ / ~* in Postgres. A trigram GIN index makes that an
-- index scan instead of a sequential read of every stored file.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE INDEX IF NOT EXISTS nodes_content_trgm_idx
  ON nodes USING gin (content gin_trgm_ops);

-- HNSW becomes partial so NULL rows never touch the graph. On an already
-- populated database this is a one-off rebuild.
DROP INDEX IF EXISTS chunks_embedding_idx;
CREATE INDEX chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- Agent Skills spec field that was parsed but never stored.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS compatibility text;
