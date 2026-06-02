-- Paperboy initial schema. Hand-written so partial unique indexes and the
-- cache-version sequence are explicit (these encode core invariants).

CREATE TABLE IF NOT EXISTS content_type (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon          TEXT NOT NULL DEFAULT 'file',
  definition    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locale (
  code                 TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  is_default           BOOLEAN NOT NULL DEFAULT false,
  enabled              BOOLEAN NOT NULL DEFAULT true,
  fallback_locale_code TEXT,
  sort_index           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS content_item (
  id           SERIAL PRIMARY KEY,
  document_id  TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  parent_id    TEXT,
  sort_index   INTEGER NOT NULL DEFAULT 0,
  section_id   TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS content_item_parent_idx  ON content_item (parent_id);
CREATE INDEX IF NOT EXISTS content_item_type_idx    ON content_item (type);
CREATE INDEX IF NOT EXISTS content_item_section_idx ON content_item (section_id);

CREATE TABLE IF NOT EXISTS content_version (
  id                    SERIAL PRIMARY KEY,
  document_id           TEXT NOT NULL,
  locale                TEXT NOT NULL,
  status                TEXT NOT NULL,
  is_current_published  BOOLEAN NOT NULL DEFAULT false,
  version_number        INTEGER NOT NULL,
  name                  TEXT NOT NULL,
  slug                  TEXT,
  display_in_nav        BOOLEAN NOT NULL DEFAULT true,
  data                  JSONB NOT NULL,
  cv                    BIGINT NOT NULL DEFAULT 0,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  comment               TEXT
);
CREATE INDEX IF NOT EXISTS content_version_doc_locale_idx ON content_version (document_id, locale);
CREATE INDEX IF NOT EXISTS content_version_status_idx     ON content_version (status);
CREATE INDEX IF NOT EXISTS content_version_slug_idx       ON content_version (slug);

-- INVARIANT: at most one live published row per (document_id, locale).
CREATE UNIQUE INDEX IF NOT EXISTS content_version_one_published
  ON content_version (document_id, locale) WHERE is_current_published;
-- INVARIANT: at most one working draft per (document_id, locale).
CREATE UNIQUE INDEX IF NOT EXISTS content_version_one_draft
  ON content_version (document_id, locale) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS content_reference (
  id                SERIAL PRIMARY KEY,
  from_document_id  TEXT NOT NULL,
  from_locale       TEXT NOT NULL,
  to_document_id    TEXT NOT NULL,
  to_type           TEXT NOT NULL,
  field_name        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS content_reference_from_idx ON content_reference (from_document_id, from_locale);
CREATE INDEX IF NOT EXISTS content_reference_to_idx   ON content_reference (to_document_id);

CREATE TABLE IF NOT EXISTS asset (
  id          SERIAL PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  url         TEXT NOT NULL,
  alt         TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_role (
  id      SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  role    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_role_uq ON user_role (user_id, role);

CREATE TABLE IF NOT EXISTS user_scope (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  section_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_scope_uq ON user_scope (user_id, section_id);

CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  csrf_token      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_key (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  type       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  document_id   TEXT,
  locale        TEXT,
  ip            TEXT,
  detail        JSONB
);

-- Monotonic cache-version, bumped on each publish.
CREATE SEQUENCE IF NOT EXISTS cv_seq START 1000;
