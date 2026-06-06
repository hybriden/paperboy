-- Delivery full-text search: expression GIN index matching deliverySearch's
-- to_tsvector('simple', name || ' ' || data::text) @@ websearch_to_tsquery query.
CREATE INDEX IF NOT EXISTS content_version_fts_idx ON content_version
  USING GIN (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(data::text,'')));
