-- Scheduled publish: per-version timed go-live (publish_at, set on a draft) and
-- expiry (expire_at). A scheduled item stays a draft until the publisher promotes
-- it; an expired item is hidden by the delivery chokepoint and demoted by the
-- publisher. Forward-only, additive, idempotent. NULL = unscheduled / never expires.
ALTER TABLE content_version ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE content_version ADD COLUMN IF NOT EXISTS expire_at  TIMESTAMPTZ;

-- Cheap partial indexes for the publisher's two scans.
CREATE INDEX IF NOT EXISTS content_version_publish_at_idx ON content_version (publish_at)
  WHERE status = 'draft' AND publish_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_version_expire_at_idx ON content_version (expire_at)
  WHERE is_current_published = true AND expire_at IS NOT NULL;
