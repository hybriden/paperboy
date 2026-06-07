-- listedType must reference an INSTALLED content type, not a hardcoded option
-- (2026-06-07 incident: a Projects ListPage listed "ArticlePage" while no such
-- type existed — the list could show nothing and it trapped agents).
--
-- The validation keys off the `optionsFromContentTypes` flag on a field in the
-- stored content-type definition. Fresh installs get it from the seed; this
-- forward-only, idempotent migration sets it on existing definitions so the
-- gate engages on already-deployed databases too. Targets the established
-- `listedType` select field on any content type that has one.
UPDATE content_type
SET definition = jsonb_set(
  definition,
  ARRAY['fields', (idx - 1)::text, 'optionsFromContentTypes'],
  'true'::jsonb,
  true
)
FROM (
  SELECT ct.name AS ct_name, ord AS idx
  FROM content_type ct,
       LATERAL jsonb_array_elements(ct.definition->'fields') WITH ORDINALITY AS f(field, ord)
  WHERE field->>'name' = 'listedType'
    AND field->>'type' = 'select'
    AND COALESCE((field->>'optionsFromContentTypes')::boolean, false) = false
) AS hit
WHERE content_type.name = hit.ct_name;
