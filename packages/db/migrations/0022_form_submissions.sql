-- Form submissions: visitor answers to a CMS-authored form.
--
-- These are NOT content. They are visitor personal data with a different
-- lifecycle (write-once, never edited, deleted on a schedule), a different
-- permission (`submission.read`, not `content.read`) and a different privacy
-- posture, so they get their own table rather than riding on content_version.
--
-- `field_snapshot` stores the label and kind of every field AS ANSWERED. A
-- submission has to stay readable after an editor renames a label — Payload's
-- form builder stores rows pointing at mutable field definitions and Strapi
-- keys its blob by label, so an edit silently rewrites or breaks old answers.
-- For a consent checkbox the snapshot IS the evidence: the exact wording agreed to.
--
-- `expires_at` is set at insert from the form's retention setting (or the
-- instance default) and swept by the API's ticker. Umbraco ships a per-form
-- retention policy that silently does nothing until a separate scheduled task
-- is enabled in config; here the sweeper runs in-process, on by default.

CREATE TABLE IF NOT EXISTS form_submission (
  id              bigserial PRIMARY KEY,
  submission_id   text NOT NULL UNIQUE,
  site_id         text NOT NULL REFERENCES site(id),
  form_id         text NOT NULL,
  form_cv         bigint NOT NULL DEFAULT 0,
  locale          text NOT NULL,
  values          jsonb NOT NULL,
  field_snapshot  jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz
);

-- List view: newest first, per form.
CREATE INDEX IF NOT EXISTS form_submission_form_idx
  ON form_submission (form_id, created_at DESC);
-- Site-wide listing and the per-site no-leak filter.
CREATE INDEX IF NOT EXISTS form_submission_site_idx
  ON form_submission (site_id, created_at DESC);
-- The retention sweep only ever looks at rows that can expire.
CREATE INDEX IF NOT EXISTS form_submission_expiry_idx
  ON form_submission (expires_at) WHERE expires_at IS NOT NULL;
-- A retried POST (double-tap, client timeout) must not create a second row.
CREATE UNIQUE INDEX IF NOT EXISTS form_submission_idem_idx
  ON form_submission (form_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
