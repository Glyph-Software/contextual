-- Discover skills from metadata without chunking or loading their instructions.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS ts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('{{FTS_CONFIG}}', name), 'A') ||
  setweight(to_tsvector('{{FTS_CONFIG}}', description), 'B')
) STORED;
CREATE INDEX IF NOT EXISTS skills_ts_idx ON skills USING GIN (ts);
