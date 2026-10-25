-- A content type can belong to ONE site (#159): a Movie review on one site
-- need not show up in every other site's pickers.
--
-- NULL means shared by every site, and that is what every existing type gets,
-- so nothing changes on deploy. Names stay unique instance-wide: content rows
-- name their type (content_item.type), so two sites can't each have their own
-- "Article".
ALTER TABLE content_type ADD COLUMN IF NOT EXISTS site_id text;
CREATE INDEX IF NOT EXISTS content_type_site_idx ON content_type (site_id);
