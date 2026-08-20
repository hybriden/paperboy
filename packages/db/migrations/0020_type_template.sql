-- Content-type template collection: named, reusable ContentTypeDef recipes
-- (full CRUD + "instantiate" into a real content type). Mirrors content_type
-- 1:1 — a template's own name is the type name it materialises by default.
-- Per-instance (single table; content types are shared across sites, so
-- templates are too). Additive, idempotent, forward-only; runs on api boot.
-- No reseed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='type_template') THEN
    CREATE TABLE type_template (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE, -- the content type name this template materialises
      display_name TEXT NOT NULL,
      kind         TEXT NOT NULL,        -- page | block | global
      description  TEXT NOT NULL DEFAULT '',
      icon         TEXT NOT NULL DEFAULT 'file',
      definition   JSONB NOT NULL,       -- full ContentTypeDef (reserved SEO group stripped, like content_type)
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  END IF;
END $$;
