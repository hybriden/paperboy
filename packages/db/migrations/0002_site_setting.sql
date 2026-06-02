-- Site-wide settings (key/value). First use: the start page served at "/".
CREATE TABLE IF NOT EXISTS site_setting (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
