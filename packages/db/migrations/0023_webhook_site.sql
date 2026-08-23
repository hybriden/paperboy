-- Scope webhooks to a site.
--
-- Every other resource that can carry content or visitor data is partitioned by
-- site_id and enforced deny-by-default (content_item, asset, delivery_key,
-- folder, user_scope). `webhook` was the exception, which stopped mattering the
-- moment form submissions started riding the same pipe: a hook subscribed to
-- form.submitted received every site's visitors' names, addresses and messages,
-- while the delivery and management chokepoints would have refused exactly that
-- read.
--
-- Backfill: existing hooks belong to the Default site — the same lossless
-- mapping migration 0012 used for all pre-multisite data. `site_default` is the
-- column default too, so any single-site write path keeps working untouched.

ALTER TABLE webhook
  ADD COLUMN IF NOT EXISTS site_id text NOT NULL DEFAULT 'site_default';

UPDATE webhook SET site_id = 'site_default' WHERE site_id IS NULL;

-- Named constraint so re-running is safe (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_site_fk') THEN
    ALTER TABLE webhook
      ADD CONSTRAINT webhook_site_fk FOREIGN KEY (site_id) REFERENCES site(id);
  END IF;
END $$;

-- Dispatch reads by site on every event.
CREATE INDEX IF NOT EXISTS webhook_site_idx ON webhook (site_id) WHERE active;
