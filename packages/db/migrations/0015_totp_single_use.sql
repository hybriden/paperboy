-- Single-use TOTP (M12): record the last accepted time-step per user so a code
-- cannot be replayed within its validity window. NULL = no code consumed yet.
-- Additive, idempotent, forward-only; runs on api boot. No reseed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_totp_step') THEN
    ALTER TABLE users ADD COLUMN last_totp_step BIGINT;
  END IF;
END $$;
