-- Site search stems words per locale ("bil" finds "bilene", "run" finds "running").
--
-- The vector holds the locale's stemmed lexemes AND the plain words ('simple'):
-- the stems serve whole-word queries, the plain words serve the prefix on the
-- last word (search as you type), since a partly typed word ("runni") has no
-- stem that matches the stored one ("run").
--
-- pb_search_vector is the ONE definition of the vector: the trigger builds the
-- index from it and delivery re-checks each hit's PUBLIC text with it, so a
-- word can only count when both see it the same way. It keeps 0018's guard: if
-- Postgres refuses an oversized vector, index the name plus a safe prefix.

CREATE OR REPLACE FUNCTION pb_search_config(locale text) RETURNS regconfig AS $$
  SELECT (CASE lower(split_part(replace(coalesce(locale, ''), '_', '-'), '-', 1))
    WHEN 'nb' THEN 'norwegian' WHEN 'nn' THEN 'norwegian' WHEN 'no' THEN 'norwegian'
    WHEN 'en' THEN 'english' WHEN 'sv' THEN 'swedish' WHEN 'da' THEN 'danish'
    WHEN 'de' THEN 'german' WHEN 'nl' THEN 'dutch' WHEN 'fi' THEN 'finnish'
    WHEN 'fr' THEN 'french' WHEN 'es' THEN 'spanish' WHEN 'it' THEN 'italian'
    WHEN 'pt' THEN 'portuguese'
    ELSE 'simple' END)::regconfig
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION pb_search_vector(locale text, name text, body text) RETURNS tsvector AS $$
DECLARE
  src text := coalesce(name, '') || ' ' || coalesce(body, '');
BEGIN
  RETURN to_tsvector(pb_search_config(locale), src) || to_tsvector('simple', src);
EXCEPTION WHEN program_limit_exceeded THEN
  src := left(coalesce(name, ''), 2000) || ' ' || left(coalesce(body, ''), 70000);
  RETURN to_tsvector(pb_search_config(locale), src) || to_tsvector('simple', src);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION content_version_fts_update() RETURNS trigger AS $$
BEGIN
  NEW.fts := pb_search_vector(NEW.locale, NEW.name, NEW.data::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-index every version through the trigger (no-op assignment fires it).
UPDATE content_version SET data = data;

ANALYZE content_version;
