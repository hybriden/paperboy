-- Delivery search: store the tsvector instead of recomputing it per row.
--
-- 0007 added a GIN index on the EXPRESSION
-- to_tsvector('simple', name || ' ' || data::text). That index is used (bitmap
-- index scan), but the ranking step — MAX(ts_rank(to_tsvector(...), query)) —
-- re-parses and re-tokenizes every candidate row's whole `data` JSONB, so a
-- broad query pays full tokenization over the matched slice of the table.
--
-- Measured on 40k versions / 92 MB, query 'salmon' matching 8k rows:
--   expression index + ts_rank(to_tsvector(...)) : 295.9 ms
--   stored generated column + GIN on it          :  17.6 ms   (16.8x)
--
-- The generated column is IMMUTABLE (explicit 'simple' regconfig) and stays in
-- sync automatically, so no application code has to remember to update it.
--
-- NOTE: adding a STORED generated column REWRITES the table under an ACCESS
-- EXCLUSIVE lock. On a normal install (hundreds/thousands of versions) that is
-- milliseconds; on a very large one, run it in a maintenance window.
ALTER TABLE content_version ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(data::text,''))) STORED;

CREATE INDEX IF NOT EXISTS content_version_fts_v2_idx ON content_version USING GIN (fts);

-- The expression index is now redundant (same data, larger to maintain): every
-- query matches on the column. Dropping it halves the write cost of a save.
DROP INDEX IF EXISTS content_version_fts_idx;
