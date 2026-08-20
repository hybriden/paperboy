-- Public-files support (robots.txt / sitemap.xml / llms.txt / security.txt):
-- per-site canonical public origin + the editor-controlled file config.
-- Additive, idempotent, forward-only; runs on api boot. No reseed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='site' AND column_name='canonical_base_url') THEN
    -- The PUBLIC origin absolute URLs are built against (sitemap <loc>, robots
    -- Sitemap:, llms.txt links). Distinct from preview_base_url, which may
    -- point at a staging frontend.
    ALTER TABLE site ADD COLUMN canonical_base_url TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='site' AND column_name='seo_files') THEN
    -- {robotsExtra?, llmsSummary?, llmsOverride?, securityContact?,
    --  securityPolicyUrl?, securityLanguages?} — see SeoFilesConfig in @paperboy/shared.
    ALTER TABLE site ADD COLUMN seo_files JSONB NOT NULL DEFAULT '{}';
  END IF;
END $$;
