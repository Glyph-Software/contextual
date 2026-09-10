-- Canonicalize existing raw URIs from source/path columns, never by decoding
-- the old URI (literal #, ? and % are valid filename bytes).
CREATE OR REPLACE FUNCTION pg_temp.ctx_component(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE bytes bytea := convert_to(value, 'UTF8'); result text := ''; b int;
BEGIN
  FOR i IN 0..length(bytes)-1 LOOP
    b := get_byte(bytes, i);
    IF (b BETWEEN 65 AND 90) OR (b BETWEEN 97 AND 122) OR (b BETWEEN 48 AND 57)
       OR b IN (45, 95, 46, 33, 126, 42, 39, 40, 41) THEN result := result || chr(b);
    ELSE result := result || '%' || upper(lpad(to_hex(b), 2, '0')); END IF;
  END LOOP;
  RETURN result;
END $$;
-- Move all old values aside first: an encoded target can equal another
-- node's old raw URI while that node is itself being renamed.
UPDATE nodes SET uri = 'ctx-migration-temp://' || id;
UPDATE nodes n SET uri = 'ctx://' || CASE WHEN s.kind = 'skill' THEN 'skills/' || pg_temp.ctx_component(s.name)
  ELSE 'docs/' || pg_temp.ctx_component(coalesce(s.collection, 'default')) END || '/' ||
  (SELECT string_agg(pg_temp.ctx_component(part), '/' ORDER BY ord) FROM unnest(string_to_array(n.path, '/')) WITH ORDINALITY AS p(part, ord))
FROM sources s WHERE s.id = n.source_id;
