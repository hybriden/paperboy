-- Indexes for the hot read paths that had none.
--   session(user_id)            — evicting a user's sessions (2FA enable, password change) scanned the table.
--   audit_log(document_id / actor_user_id / ts) — every Settings → Audit filter and the retention sweep scanned it.
--   content_item(site_id, parent_id) / (site_id, kind), live rows only — the tree and every broad
--                                management/delivery scan filter on exactly these.
CREATE INDEX IF NOT EXISTS session_user_idx ON session (user_id);
CREATE INDEX IF NOT EXISTS audit_log_document_idx ON audit_log (document_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts);
CREATE INDEX IF NOT EXISTS content_item_site_parent_live_idx ON content_item (site_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS content_item_site_kind_live_idx ON content_item (site_id, kind) WHERE deleted_at IS NULL;
