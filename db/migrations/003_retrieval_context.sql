-- File-level FTS is unused and exceeds the tsvector size limit on manuals.
ALTER TABLE nodes DROP COLUMN IF EXISTS ts;
-- Context is indexed separately from the verbatim readable content.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT '';
UPDATE chunks c SET context = concat_ws(' / ', s.collection, s.name, n.path, array_to_string(c.heading_path, ' / '))
FROM nodes n JOIN sources s ON s.id = n.source_id WHERE n.id = c.node_id;
ALTER TABLE chunks DROP COLUMN ts;
ALTER TABLE chunks ADD COLUMN ts tsvector GENERATED ALWAYS AS
  (to_tsvector('{{FTS_CONFIG}}', context || E'\n\n' || content)) STORED;
CREATE INDEX chunks_ts_idx ON chunks USING gin(ts);
-- Existing vectors lack context: reindex will safely fill these again.
UPDATE chunks SET embedding = NULL;
