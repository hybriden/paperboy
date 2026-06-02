-- Outbound webhooks: subscribers notified (HMAC-signed) on publish/unpublish.
-- Outbound webhooks: publish-triggered integration events (ISR revalidate, CDN purge, sync).
CREATE TABLE IF NOT EXISTS webhook (
  id          SERIAL PRIMARY KEY,
  document_id TEXT,                       -- unused placeholder; events carry their own doc id
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,              -- HMAC-SHA256 signing secret
  events      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- subscribed event names; [] = all
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status INTEGER,                    -- last delivery HTTP status (or null)
  last_at     TIMESTAMPTZ
);

-- Delivery attempts log (audit + debugging of webhook fan-out).
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id          SERIAL PRIMARY KEY,
  webhook_id  INTEGER NOT NULL,
  event       TEXT NOT NULL,
  status      INTEGER,                    -- HTTP status, or null on transport error
  error       TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_delivery_hook_idx ON webhook_delivery (webhook_id);
