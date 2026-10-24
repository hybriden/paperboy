-- A/B experiments (#125, docs/plans/2026-10-22-ab-testing.md). Additive, idempotent.
--
-- An experiment tests one content area of one page in one locale. Version A
-- is the page's own published area; B–D are alternative block lists kept HERE,
-- not as a dimension on content_version (whose (document_id, locale) unique
-- indexes every read relies on). Delivery ships the running versions beside
-- the page and the frontend picks one.

-- Per-site privacy mode (cookieless by default: nothing stored on the device)
-- and how many days an experiment may run before the dashboard warns.
ALTER TABLE site ADD COLUMN IF NOT EXISTS experiment_mode text NOT NULL DEFAULT 'cookieless';
ALTER TABLE site ADD COLUMN IF NOT EXISTS experiment_warn_days integer NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS experiment (
  id serial PRIMARY KEY,
  site_id text NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  locale text NOT NULL,
  area text NOT NULL,
  name text NOT NULL,
  hypothesis text,
  -- 'draft' | 'running' | 'paused' | 'ended'
  status text NOT NULL DEFAULT 'draft',
  -- 'form' (a form on the page) or 'event:<name>' (reported by the frontend)
  goal text NOT NULL DEFAULT 'form',
  -- The plan: today's conversion rate and the smallest relative lift worth
  -- detecting. Together they give the sample size no winner is named before.
  baseline_rate double precision,
  mde double precision,
  ends_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  -- Why it ended: 'manual' | 'ends-at' | 'page-unpublished' | 'page-trashed' | 'page-moved' | 'area-removed'
  end_reason text,
  winner text,
  -- Cache version (cv_seq), bumped when delivery output changes (start, pause,
  -- end), and folded into the page's ETag.
  cv bigint NOT NULL DEFAULT 0,
  needs_review boolean NOT NULL DEFAULT false,
  created_by text,
  created_via text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS experiment_site_status_idx ON experiment (site_id, status);
CREATE INDEX IF NOT EXISTS experiment_document_idx ON experiment (document_id);
-- At most one live (running or paused) experiment per area.
CREATE UNIQUE INDEX IF NOT EXISTS experiment_live_area_idx ON experiment (document_id, locale, area) WHERE status IN ('running', 'paused');

CREATE TABLE IF NOT EXISTS experiment_arm (
  experiment_id integer NOT NULL REFERENCES experiment(id) ON DELETE CASCADE,
  -- 'a' (the control: the page's own area, no blocks stored) | 'b' | 'c' | 'd'
  key text NOT NULL,
  label text,
  weight integer NOT NULL DEFAULT 50,
  blocks jsonb,
  PRIMARY KEY (experiment_id, key)
);

-- Counts per version per day: no visitor id, IP or user agent is stored.
CREATE TABLE IF NOT EXISTS experiment_stat (
  experiment_id integer NOT NULL REFERENCES experiment(id) ON DELETE CASCADE,
  arm text NOT NULL,
  day date NOT NULL,
  exposures integer NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (experiment_id, arm, day)
);
CREATE INDEX IF NOT EXISTS experiment_stat_day_idx ON experiment_stat (day);
