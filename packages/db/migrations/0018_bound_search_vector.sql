-- Keep a large document saveable: the search vector must never fail a write.
--
-- `to_tsvector` errors when the resulting vector's lexeme bytes exceed 1048575
-- (Postgres MAXSTRPOS, SQLSTATE 54000):
--
--   ERROR: string is too long for tsvector (1118006 bytes, max 1048575 bytes)
--
-- 0017 made that vector a GENERATED column, so once a document crossed the limit
-- EVERY subsequent write to it failed with an opaque 500 and the document could
-- never be edited again. Fastify's 1MiB body limit does not prevent it —
-- `merge:true` accumulates across requests.
--
-- Two things make this easy to get wrong, both measured here:
--   * The trigger is DISTINCT words, not raw size. 1.3MB of repeated "gamma "
--     collapses to ONE lexeme (a 919-byte vector); 648KB of distinct words
--     produced a 1118006-byte vector. A test using repeated text passes while
--     proving nothing.
--   * The vector can be LARGER than its input (each lexeme carries an entry +
--     position overhead, ~1.7x for normal words and up to ~4.5x for very short
--     ones), so simply capping the INPUT does not bound the output. A first
--     attempt at this migration capped input at 900000 chars and still failed.
--
-- So: a BEFORE trigger that tries the full text and, only if Postgres actually
-- refuses, indexes a provably-safe 150000-char prefix (worst case ~675KB < 1MB).
-- A generated column cannot do this — expressions can't catch exceptions.
--
-- The trade on that fallback path is search RECALL on the tail of an unusually
-- large document, never data: `data` is stored and delivered complete. Refusing
-- the write, or truncating the content, would both be worse.

ALTER TABLE content_version DROP COLUMN IF EXISTS fts;
ALTER TABLE content_version ADD COLUMN fts tsvector;

CREATE OR REPLACE FUNCTION content_version_fts_update() RETURNS trigger AS $$
DECLARE
  src text := coalesce(NEW.name, '') || ' ' || coalesce(NEW.data::text, '');
BEGIN
  BEGIN
    NEW.fts := to_tsvector('simple', src);
  EXCEPTION WHEN program_limit_exceeded THEN
    -- Keep the NAME in the vector unconditionally: on this path which text
    -- survives a flat prefix is decided by JSONB key order (an alphabetically
    -- early field can swallow the whole budget), so the document's title -- the
    -- single most valuable thing to find it by -- would otherwise drop out.
    NEW.fts := to_tsvector('simple', left(coalesce(NEW.name, ''), 2000) || ' ' ||
                                     left(coalesce(NEW.data::text, ''), 150000));
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- OF (name, data): the only inputs. Skipping other column updates (publish
-- flips, revision bumps, cv) avoids re-tokenizing on writes that can't change it.
DROP TRIGGER IF EXISTS content_version_fts_trg ON content_version;
CREATE TRIGGER content_version_fts_trg
  BEFORE INSERT OR UPDATE OF name, data ON content_version
  FOR EACH ROW EXECUTE FUNCTION content_version_fts_update();

-- Backfill existing rows through the trigger (no-op assignment fires it).
UPDATE content_version SET data = data;

CREATE INDEX IF NOT EXISTS content_version_fts_v2_idx ON content_version USING GIN (fts);

-- The column is brand new, so the planner has no statistics for it until this
-- runs; without it the first queries after deploy can pick a worse plan.
ANALYZE content_version;
