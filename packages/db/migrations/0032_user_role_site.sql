-- Roles can be held in ONE site (#130): an Admin of brand-a only.
--
-- NULL means every site, and that is exactly what existing rows get: every
-- current user keeps the access they had, so nothing changes on deploy. The
-- uniqueness widens from (user, role) to (user, role, site); existing rows
-- already satisfy it, so the swap cannot fail on real data.
ALTER TABLE user_role ADD COLUMN IF NOT EXISTS site_id text;
DROP INDEX IF EXISTS user_role_uq;
CREATE UNIQUE INDEX IF NOT EXISTS user_role_uq ON user_role (user_id, role, COALESCE(site_id, ''));
CREATE INDEX IF NOT EXISTS user_role_site_idx ON user_role (site_id);

-- The site an audited action happened in, so a site Admin can read their own
-- site's log. NULL = instance-wide (and every row written before this), which
-- only an every-site Admin reads.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS site_id text;
CREATE INDEX IF NOT EXISTS audit_log_site_idx ON audit_log (site_id);
