-- Asset-pane folders — organize the Media and Shared-blocks libraries into
-- nested folders. One generic `folder` table discriminated by `kind`
-- ('media' | 'block') holds two SEPARATE trees (a folder belongs to one kind).
-- Folders are per-site (D2), like the assets/blocks they hold; nesting uses a
-- self-referencing parent_id (null = root), mirroring the page tree.
--
-- Items reference their folder via a nullable folder_id (null = unfiled/root):
--   asset.folder_id        -> media folders
--   content_item.folder_id -> block folders (harmless null on pages/globals)
--
-- Additive + forward-only + idempotent; runs on api boot. No reseed.

CREATE TABLE IF NOT EXISTS folder (
  id          SERIAL PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,                       -- 'media' | 'block'
  parent_id   TEXT REFERENCES folder(document_id), -- null = root
  name        TEXT NOT NULL,
  site_id     TEXT NOT NULL DEFAULT 'site_default' REFERENCES site(id),
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS folder_site_kind_parent_idx ON folder (site_id, kind, parent_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='asset' AND column_name='folder_id') THEN
    ALTER TABLE asset ADD COLUMN folder_id TEXT REFERENCES folder(document_id);
    CREATE INDEX asset_folder_idx ON asset (folder_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_item' AND column_name='folder_id') THEN
    ALTER TABLE content_item ADD COLUMN folder_id TEXT REFERENCES folder(document_id);
    CREATE INDEX content_item_folder_idx ON content_item (folder_id);
  END IF;
END $$;
