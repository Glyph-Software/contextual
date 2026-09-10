-- A transactionally updated version row plus statement triggers catches writes
-- from every process, including direct SQL. Rollbacks emit no notifications.
INSERT INTO settings(key, value) VALUES ('corpus_version', '0') ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION contextual_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('UPDATE %I.settings SET value = (value::bigint + 1)::text, updated_at = clock_timestamp() WHERE key = %L', TG_TABLE_SCHEMA, 'corpus_version');
  PERFORM pg_notify('contextual_changed', TG_TABLE_SCHEMA);
  RETURN NULL;
END $$;
CREATE TRIGGER sources_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON sources
  FOR EACH STATEMENT EXECUTE FUNCTION contextual_changed();
CREATE TRIGGER nodes_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON nodes
  FOR EACH STATEMENT EXECUTE FUNCTION contextual_changed();

ALTER TABLE nodes ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX nodes_updated_idx ON nodes(updated_at);
CREATE INDEX sources_updated_idx ON sources(updated_at);
-- Acquire the version-row lock before changing timestamps. This makes the
-- version clock follow commit order even for concurrent direct SQL writers.
CREATE FUNCTION contextual_change_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT value FROM %I.settings WHERE key = %L FOR UPDATE', TG_TABLE_SCHEMA, 'corpus_version');
  RETURN NULL;
END $$;
CREATE TRIGGER sources_change_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON sources
  FOR EACH STATEMENT EXECUTE FUNCTION contextual_change_lock();
CREATE TRIGGER nodes_change_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON nodes
  FOR EACH STATEMENT EXECUTE FUNCTION contextual_change_lock();
CREATE FUNCTION contextual_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER nodes_touch BEFORE INSERT OR UPDATE ON nodes FOR EACH ROW EXECUTE FUNCTION contextual_touch();
CREATE TRIGGER sources_touch BEFORE INSERT OR UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION contextual_touch();
