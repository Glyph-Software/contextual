-- contextual: one namespace for skill bundles and document corpora.
-- Full-text and vectors co-located so hybrid retrieval is a single statement.
--
-- `{{FTS_CONFIG}}` is substituted by migrate() with the text-search
-- configuration chosen for this database (default: english).

-- Extensions are database-wide; keep their objects visible to every corpus
-- schema instead of installing them into the first caller's search_path.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS sources (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('skill', 'doc')),
  name         text NOT NULL,
  collection   text,
  origin_uri   text,
  -- Content hash makes re-ingest idempotent: same bytes, same row, no rewrite.
  content_hash text NOT NULL,
  status       text NOT NULL DEFAULT 'ready'
               CHECK (status IN ('ready', 'needs_ocr', 'failed')),
  -- Why a source is not 'ready' (OCR page list, parse error), surfaced in the catalog.
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A skill name, or a collection/doc pair, identifies exactly one source.
CREATE UNIQUE INDEX IF NOT EXISTS sources_identity
  ON sources (kind, coalesce(collection, ''), name);

CREATE TABLE IF NOT EXISTS nodes (
  id         bigserial PRIMARY KEY,
  source_id  bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path       text NOT NULL,
  uri        text NOT NULL UNIQUE,
  mime_type  text,
  size_bytes bigint,
  role       text NOT NULL
             CHECK (role IN ('skill_md', 'reference', 'script', 'asset', 'doc')),
  content    text,
  blob_ref   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ts         tsvector GENERATED ALWAYS AS
             (to_tsvector('{{FTS_CONFIG}}', coalesce(content, ''))) STORED
);

CREATE INDEX IF NOT EXISTS nodes_source_idx ON nodes (source_id);
CREATE INDEX IF NOT EXISTS nodes_ts_idx     ON nodes USING GIN (ts);
-- cx_glob and cx_ls both scan by path prefix.
CREATE INDEX IF NOT EXISTS nodes_path_idx   ON nodes (path text_pattern_ops);

CREATE TABLE IF NOT EXISTS chunks (
  id           bigserial PRIMARY KEY,
  node_id      bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ord          int NOT NULL,
  heading_path text[] NOT NULL DEFAULT '{}',
  content      text NOT NULL,
  token_count  int,
  ts           tsvector GENERATED ALWAYS AS
               (to_tsvector('{{FTS_CONFIG}}', content)) STORED,
  embedding    vector(1024)
);

CREATE UNIQUE INDEX IF NOT EXISTS chunks_node_ord ON chunks (node_id, ord);
CREATE INDEX IF NOT EXISTS chunks_ts_idx ON chunks USING GIN (ts);
-- Partial: rows are inserted with a NULL embedding and vectorised later, so
-- the graph only ever sees real vectors. Bulk re-embeds drop and rebuild it
-- (see embedMissing) because pgvector builds HNSW far faster after load than
-- one insert at a time.
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS skills (
  source_id     bigint PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  name          text NOT NULL UNIQUE,
  description   text NOT NULL,
  allowed_tools text[],
  -- Spec field: environment requirements, free text, <=500 chars.
  compatibility text,
  license       text,
  metadata      jsonb
);
