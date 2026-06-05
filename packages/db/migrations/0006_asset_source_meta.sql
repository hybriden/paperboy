-- Stock-image imports: provider attribution kept on the asset (NULL for normal uploads).
-- Shape: { provider, providerId, credit, creditUrl, sourceUrl, providerName }
ALTER TABLE asset ADD COLUMN IF NOT EXISTS source_meta JSONB;
