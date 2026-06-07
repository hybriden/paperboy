-- SEO becomes an INTRINSIC reserved group (2026-06-08): the SEO output-control
-- fields (meta/og/twitter/canonical/noindex) are no longer stored per type —
-- they're defined once in @paperboy/shared and INJECTED on read (withSeoGroup),
-- so every page has them, they can't be removed, and they can't drift. This
-- strips the now-redundant stored copies from existing page definitions so the
-- stored definition is the single source minus SEO. Forward-only, idempotent
-- (the WHERE guard makes a re-run a no-op once stripped).
UPDATE content_type
SET definition = jsonb_set(
  definition,
  '{fields}',
  (
    SELECT COALESCE(jsonb_agg(f), '[]'::jsonb)
    FROM jsonb_array_elements(definition->'fields') AS f
    WHERE f->>'name' NOT IN
      ('metaTitle','metaDescription','canonicalUrl','noIndex','ogTitle','ogDescription','ogImage','ogType','twitterCard')
  )
)
WHERE kind = 'page'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(definition->'fields') AS f
    WHERE f->>'name' IN
      ('metaTitle','metaDescription','canonicalUrl','noIndex','ogTitle','ogDescription','ogImage','ogType','twitterCard')
  );
