-- SEO + schema.org contract (2026-06-08): tag stored content-type definitions
-- with field `seoRole`s and a `schemaType` so the delivered `seo`/`jsonLd`
-- block engages on already-deployed databases (fresh installs get this from the
-- seed literals). Forward-only, idempotent — each set is guarded so re-runs are
-- no-ops. Mirrors 0009's JSONB-patch approach.

-- 1) schemaType per page type (by name).
UPDATE content_type SET definition = jsonb_set(definition, '{schemaType}', '"BlogPosting"'::jsonb, true)
  WHERE name = 'BlogPost' AND definition->>'schemaType' IS NULL;
UPDATE content_type SET definition = jsonb_set(definition, '{schemaType}', '"Article"'::jsonb, true)
  WHERE name = 'ArticlePage' AND definition->>'schemaType' IS NULL;
UPDATE content_type SET definition = jsonb_set(definition, '{schemaType}', '"CollectionPage"'::jsonb, true)
  WHERE name = 'ListPage' AND definition->>'schemaType' IS NULL;
UPDATE content_type SET definition = jsonb_set(definition, '{schemaType}', '"WebPage"'::jsonb, true)
  WHERE kind = 'page' AND definition->>'schemaType' IS NULL;

-- 2) seoRole on well-known content fields. For each (type-field, role) pair,
-- set seoRole on the matching field element when it isn't already set. The
-- field index is resolved per row via WITH ORDINALITY.
UPDATE content_type ct
SET definition = jsonb_set(ct.definition, ARRAY['fields', (hit.idx - 1)::text, 'seoRole'], to_jsonb(hit.role), true)
FROM (
  SELECT c.name AS ct_name, ord AS idx,
         CASE
           WHEN f.field->>'name' IN ('title','heading') THEN 'title'
           WHEN f.field->>'name' IN ('summary') THEN 'description'
           WHEN f.field->>'name' IN ('publishDate') THEN 'datePublished'
           WHEN f.field->>'name' IN ('author') THEN 'author'
           WHEN f.field->>'name' IN ('tags') THEN 'keywords'
         END AS role
  FROM content_type c,
       LATERAL jsonb_array_elements(c.definition->'fields') WITH ORDINALITY AS f(field, ord)
  WHERE c.kind = 'page'
    AND f.field->>'name' IN ('title','heading','summary','publishDate','author','tags')
    AND (f.field->>'seoRole') IS NULL
) AS hit
WHERE ct.name = hit.ct_name AND hit.role IS NOT NULL;
