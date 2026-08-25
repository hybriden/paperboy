-- Mark the three remaining built-in composition parts as PARTS (nestedOnly).
--
-- 0024 did this for the ten form field blocks. These three are the same case
-- and were missed: an "Accordion item" has no meaning outside the Accordion
-- list that renders it, a "Question with answer" outside its FAQ topic, a
-- "Link item" outside a link list or a menu. Each is already named in its
-- container's `allowedBlocks`, which is the rule stated from the container's
-- side — `nestedOnly` is the other half, and without it a content area with no
-- allow-list offered all three beside real page blocks.
--
-- Found by looking at the block palette after it became a menu: "Accordion
-- item", "Link item" and "Question with answer" sat in the page-level list,
-- where choosing one produces a block that renders as nothing on its own.
--
-- Same reasoning as 0024 for why this is a migration and not an instantiate:
-- installing a template's referenced blocks is deliberately create-only
-- ("existing types are never overwritten"), so an instance that already has
-- these types would keep the old definition and stay polluted. This fixes every
-- existing instance on the next api boot.
--
-- Only the flag is touched, so any other customisation an instance made to
-- these types survives. Names are reserved built-ins, so matching by name is
-- safe. Idempotent: jsonb_set to the same value is a no-op, and the WHERE
-- clause skips rows that already carry it.
--
-- Note this changes AVAILABILITY, not storage: existing instances of these
-- blocks keep working exactly as before, wherever they already sit. A part is
-- still shareable, versioned, localized, RBAC'd and MCP-editable.
UPDATE content_type
SET definition = jsonb_set(definition, '{nestedOnly}', 'true'::jsonb, true)
WHERE name IN (
  'AccordionItemBlock',
  'QuestionBlock',
  'LinkItemBlock'
)
AND coalesce((definition ->> 'nestedOnly')::boolean, false) IS NOT TRUE;
