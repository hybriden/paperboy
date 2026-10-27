-- When content went live. Before this, publishing promoted a draft row without
-- recording a time, so "newest first" could only mean when the document was
-- created (content_item.created_at) or when the live version's draft was
-- started (content_version.created_at), neither of which is "published".
--   published_at:       when THIS version went live (its variant's last
--                       published change, "modified" to a reader).
--   first_published_at: when the variant (document + locale) FIRST went live;
--                       carried forward on every later publish, never changed.
ALTER TABLE content_version ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE content_version ADD COLUMN IF NOT EXISTS first_published_at timestamptz;

-- Best guess for what is already published. The audit trail records manual
-- publishes (API and MCP, with locale); where it has none (seeded, imported or
-- scheduled content), the version's own date is the closest thing we have.
UPDATE content_version v
SET published_at = COALESCE(
  (SELECT max(a.ts) FROM audit_log a
   WHERE a.action = 'content.publish' AND a.document_id = v.document_id AND a.locale = v.locale AND a.ts >= v.created_at),
  v.created_at)
WHERE v.is_current_published AND v.published_at IS NULL;

UPDATE content_version v
SET first_published_at = f.first_at
FROM (
  SELECT pv.document_id, pv.locale,
         COALESCE(
           (SELECT min(a.ts) FROM audit_log a
            WHERE a.action = 'content.publish' AND a.document_id = pv.document_id AND a.locale = pv.locale),
           min(pv.created_at)) AS first_at
  FROM content_version pv
  WHERE pv.status = 'published'
  GROUP BY pv.document_id, pv.locale
) f
WHERE v.document_id = f.document_id AND v.locale = f.locale AND v.status = 'published' AND v.first_published_at IS NULL;
