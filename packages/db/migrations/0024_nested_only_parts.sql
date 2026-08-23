-- Mark the built-in form field blocks as PARTS (nestedOnly).
--
-- `nestedOnly` is availability metadata on a content type: "this type is only
-- ever part of another one, so never offer it where any block goes". The ten
-- form field blocks are the case it exists for — a "Date field" has no meaning
-- outside the Form that compiles it into a spec, yet a content area with no
-- allow-list offered all ten beside real page blocks.
--
-- The flag ships on the built-in TEMPLATES, but instantiating a template's
-- referenced blocks is deliberately create-only ("existing types are never
-- overwritten"), so an instance that already installed these types would keep
-- the old definition and stay polluted. Hence a migration rather than an
-- instantiate: it fixes every existing instance on the next api boot.
--
-- Only the flag is touched, so any other customisation an instance made to
-- these types survives. Names are reserved built-ins, so matching by name is
-- safe. Idempotent: jsonb_set to the same value is a no-op, and the WHERE
-- clause skips rows that already carry it.
UPDATE content_type
SET definition = jsonb_set(definition, '{nestedOnly}', 'true'::jsonb, true)
WHERE name IN (
  'FormTextField',
  'FormEmailField',
  'FormTextareaField',
  'FormNumberField',
  'FormDateField',
  'FormSelectField',
  'FormCheckboxField',
  'FormRadioField',
  'FormConsentField',
  'FormStaticText'
)
AND coalesce((definition ->> 'nestedOnly')::boolean, false) IS NOT TRUE;
