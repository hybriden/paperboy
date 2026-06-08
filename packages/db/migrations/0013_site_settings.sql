-- Per-site setup: the preview origin + start page move from the GLOBAL
-- site_setting table onto the site entity (each brand has its own). The Default
-- site is backfilled from the existing global values (lossless). AI key/model +
-- agentReview stay global in site_setting — they're instance settings, not
-- per-brand. Additive, idempotent, forward-only; runs on api boot. No reseed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='site' AND column_name='preview_base_url') THEN
    ALTER TABLE site ADD COLUMN preview_base_url TEXT;
    ALTER TABLE site ADD COLUMN start_page_id    TEXT;
    -- Carry today's global values onto the Default site so nothing changes for it.
    UPDATE site SET
      preview_base_url = (SELECT value->>'url'        FROM site_setting WHERE key = 'previewBaseUrl'),
      start_page_id    = (SELECT value->>'documentId' FROM site_setting WHERE key = 'startPage')
    WHERE id = 'site_default';
  END IF;
END $$;
