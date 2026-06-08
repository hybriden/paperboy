-- Multisite, Phase 1 — first-class `site` entity + lossless backfill.
--
-- Decisions (MULTISITE_PLAN.md, 2026-06-08):
--   D1 per-site delivery keys  -> delivery_key.site_id
--   D2 media per-site only     -> asset.site_id  (content_type/locale/users stay shared)
--   D3 one lossless Default    -> all existing rows -> the 'site_default' site
--
-- Additive + forward-only + idempotent. Each scoped column is added NULLABLE,
-- backfilled to the default site, then given a DEFAULT + NOT NULL + FK + index.
-- The column DEFAULT keeps every existing INSERT path (asset upload, key minting,
-- seed) working untouched in the single-site world; multisite-aware write paths
-- set site_id explicitly. NEVER run seed/init for this (truncates).

CREATE TABLE IF NOT EXISTS site (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  default_locale TEXT NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Default site. Fixed id so the column DEFAULT below can reference it and so
-- backfills are deterministic across environments. default_locale = the current
-- default locale (falls back to any locale, else 'en' on a fresh pre-seed DB).
INSERT INTO site (id, slug, name, default_locale, active)
VALUES (
  'site_default',
  'default',
  'Default site',
  COALESCE(
    (SELECT code FROM locale WHERE is_default = true ORDER BY sort_index LIMIT 1),
    (SELECT code FROM locale ORDER BY sort_index LIMIT 1),
    'en'
  ),
  true
)
ON CONFLICT (id) DO NOTHING;

-- Helper pattern per scoped table: add nullable -> backfill -> default+notnull+fk+index.
DO $$
BEGIN
  -- content_item: the canonical partition.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_item' AND column_name='site_id') THEN
    ALTER TABLE content_item ADD COLUMN site_id TEXT;
    UPDATE content_item SET site_id = 'site_default' WHERE site_id IS NULL;
    ALTER TABLE content_item ALTER COLUMN site_id SET DEFAULT 'site_default';
    ALTER TABLE content_item ALTER COLUMN site_id SET NOT NULL;
    ALTER TABLE content_item ADD CONSTRAINT content_item_site_fk FOREIGN KEY (site_id) REFERENCES site(id);
    CREATE INDEX content_item_site_idx ON content_item (site_id);
  END IF;

  -- delivery_key: D1, per-site keys.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='delivery_key' AND column_name='site_id') THEN
    ALTER TABLE delivery_key ADD COLUMN site_id TEXT;
    UPDATE delivery_key SET site_id = 'site_default' WHERE site_id IS NULL;
    ALTER TABLE delivery_key ALTER COLUMN site_id SET DEFAULT 'site_default';
    ALTER TABLE delivery_key ALTER COLUMN site_id SET NOT NULL;
    ALTER TABLE delivery_key ADD CONSTRAINT delivery_key_site_fk FOREIGN KEY (site_id) REFERENCES site(id);
    CREATE INDEX delivery_key_site_idx ON delivery_key (site_id);
  END IF;

  -- asset: D2, per-site media.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='asset' AND column_name='site_id') THEN
    ALTER TABLE asset ADD COLUMN site_id TEXT;
    UPDATE asset SET site_id = 'site_default' WHERE site_id IS NULL;
    ALTER TABLE asset ALTER COLUMN site_id SET DEFAULT 'site_default';
    ALTER TABLE asset ALTER COLUMN site_id SET NOT NULL;
    ALTER TABLE asset ADD CONSTRAINT asset_site_fk FOREIGN KEY (site_id) REFERENCES site(id);
    CREATE INDEX asset_site_idx ON asset (site_id);
  END IF;

  -- user_scope: per-site section scoping -> (user_id, site_id, section_id).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_scope' AND column_name='site_id') THEN
    ALTER TABLE user_scope ADD COLUMN site_id TEXT;
    UPDATE user_scope SET site_id = 'site_default' WHERE site_id IS NULL;
    ALTER TABLE user_scope ALTER COLUMN site_id SET DEFAULT 'site_default';
    ALTER TABLE user_scope ALTER COLUMN site_id SET NOT NULL;
    ALTER TABLE user_scope ADD CONSTRAINT user_scope_site_fk FOREIGN KEY (site_id) REFERENCES site(id);
    -- Replace the (user_id, section_id) uniqueness with (user_id, site_id, section_id).
    DROP INDEX IF EXISTS user_scope_uq;
    CREATE UNIQUE INDEX user_scope_uq ON user_scope (user_id, site_id, section_id);
  END IF;
END $$;
