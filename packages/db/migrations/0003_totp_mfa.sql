-- Two-factor auth (TOTP). Secret is set at enrollment; only "enabled" once a
-- code is verified. backup_codes holds sha-256 hashes of one-time recovery codes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_codes JSONB;
