-- Form notification email (issue #186, part A).
--
-- 1. mail_delivery: the queue. A row is written in the SAME transaction as the
--    submission, so a crash between storing and sending cannot lose the
--    notification; senders claim rows (FOR UPDATE SKIP LOCKED + a lease) so two
--    API processes never send the same one. No body is stored: it is rendered
--    from the submission on every attempt, and the row cascades away with it,
--    so an erased or expired submission is never sent.
CREATE TABLE IF NOT EXISTS mail_delivery (
  id               text PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('submission', 'digest')),
  submission_id    text REFERENCES form_submission (submission_id) ON DELETE CASCADE,
  site_id          text NOT NULL,
  form_id          text NOT NULL,
  form_name        text NOT NULL,
  recipients       text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_until      timestamptz,
  digest_hour      timestamptz,
  last_error       text,
  provider_id      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  CHECK ((kind = 'submission') = (submission_id IS NOT NULL)),
  CHECK ((kind = 'digest') = (digest_hour IS NOT NULL))
);
-- What a sender claims: due pending rows and sends whose lease ran out.
CREATE INDEX IF NOT EXISTS mail_delivery_due_idx ON mail_delivery (next_attempt_at) WHERE status IN ('pending', 'sending');
-- The hourly cap counts a form's emails this hour.
CREATE INDEX IF NOT EXISTS mail_delivery_form_idx ON mail_delivery (form_id, created_at);
CREATE INDEX IF NOT EXISTS mail_delivery_submission_idx ON mail_delivery (submission_id);
-- One summary per form per hour.
CREATE UNIQUE INDEX IF NOT EXISTS mail_delivery_digest_idx ON mail_delivery (form_id, digest_hour) WHERE kind = 'digest';

-- 2. The Form type gets "Send email from Paperboy" and new help text for
--    notifyEmail. Built-in templates are create-only, so existing instances get
--    them here (like 0024/0025). The new field is appended with defaultValue
--    true, which seeds only forms created from now on (createContent): existing
--    forms hold no value, so they stay OFF and a setup that already emails from
--    the form.submitted webhook does not start getting two emails.
--    Idempotent: skips a definition that already has the field.
UPDATE content_type
SET definition = jsonb_set(
  definition,
  '{fields}',
  (
    SELECT coalesce(jsonb_agg(
      CASE WHEN f ->> 'name' = 'notifyEmail'
        THEN f || jsonb_build_object('helpText', 'Comma-separated addresses. With "Send email from Paperboy" on, Paperboy emails them on every new submission; the form.submitted webhook also carries them.')
        ELSE f END
      ORDER BY i), '[]'::jsonb)
    FROM jsonb_array_elements(definition -> 'fields') WITH ORDINALITY AS t (f, i)
  ) || jsonb_build_array(jsonb_build_object(
    'name', 'notifyByEmail',
    'displayName', 'Send email from Paperboy',
    'type', 'boolean',
    'localized', false,
    'required', false,
    'delivery', 'private',
    'group', 'Protection & privacy',
    'defaultValue', true,
    'helpText', 'Email the notification recipients on every new submission. Turn off if an integration already emails them from the webhook.'
  ))
)
WHERE name = 'Form'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition -> 'fields') f WHERE f ->> 'name' = 'notifyByEmail');
