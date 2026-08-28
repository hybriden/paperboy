-- Group the built-in Form block's settings into editor tabs.
--
-- The Form type shipped all eleven fields ungrouped, so the editor rendered
-- one flat tab where the questions area drowned between confirmation copy and
-- GDPR dials. `group` on a FieldDef is what the editor's native group→tab
-- machinery keys on; the built-in TEMPLATE now sets "After submitting" and
-- "Protection & privacy" on the eight settings fields, and (like 0024) an
-- instance that already installed the type keeps its old definition unless a
-- migration updates it.
--
-- Only a missing/default group is touched — a group an instance customised
-- survives (post-Zod storage writes the default 'Content' explicitly, so both
-- spellings of "untouched" are matched). Names are reserved built-ins.
-- Idempotent: once a field carries its target group, the CASE falls through.
UPDATE content_type
SET definition = jsonb_set(
  definition,
  '{fields}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN f->>'name' IN ('confirmation', 'confirmationText', 'redirectTo')
             AND coalesce(f->>'group', 'Content') = 'Content'
          THEN f || jsonb_build_object('group', 'After submitting')
        WHEN f->>'name' IN ('spamProtection', 'notifyWebhooks', 'retentionDays', 'captureMetadata', 'notifyEmail')
             AND coalesce(f->>'group', 'Content') = 'Content'
          THEN f || jsonb_build_object('group', 'Protection & privacy')
        ELSE f
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(definition->'fields') WITH ORDINALITY AS t(f, ord)
  )
)
WHERE name = 'Form'
  AND jsonb_typeof(definition->'fields') = 'array';
