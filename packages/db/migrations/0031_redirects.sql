-- Redirects and the 404 log (Settings → Redirects). Additive, idempotent.
--
-- A rule lives in the CMS, per site, and the frontend applies it: delivery
-- serves the site's rules as one manifest (GET /delivery/redirects) and the
-- frontend redirects a request ONLY when no published page answers it — so a
-- rule can never hijack a live page. See REDIRECTS_PLAN.md.

-- How the frontend spells a page's URL, so the CMS can turn (locale, urlPath)
-- into the path a visitor actually requests: 'always' = /{locale}{urlPath}
-- (the reference frontend), 'except-default' = no prefix for the site's
-- default locale (/{urlPath}), prefixed for the others.
ALTER TABLE site ADD COLUMN IF NOT EXISTS locale_prefix text NOT NULL DEFAULT 'always';

CREATE TABLE IF NOT EXISTS redirect (
  id serial PRIMARY KEY,
  site_id text NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  -- Normalized at write: leading slash, lowercase, no trailing slash, no query.
  source_path text NOT NULL,
  -- 'exact', or 'prefix' (the source and everything under it; the rest of the
  -- path is appended to the target).
  match_type text NOT NULL DEFAULT 'exact',
  -- The target is EITHER a page (document + locale; resolved to its live URL
  -- when the manifest is built, so moving the page never leaves a chain) OR a
  -- path/absolute URL. Neither = a 410 Gone rule.
  target_document_id text,
  target_locale text,
  target_path text,
  status_code integer NOT NULL DEFAULT 301,
  keep_query boolean NOT NULL DEFAULT true,
  -- 'manual' | 'auto' (created when a published page changed URL) | 'import'
  origin text NOT NULL DEFAULT 'manual',
  note text,
  hits integer NOT NULL DEFAULT 0,
  last_hit_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS redirect_site_source_idx ON redirect (site_id, source_path);
CREATE INDEX IF NOT EXISTS redirect_target_doc_idx ON redirect (target_document_id);

-- Paths that answered 404 on the frontend, aggregated per path. The path only:
-- no query string (tokens and emails ride in query strings), no IP, no user
-- agent. Capped per site and swept by age (runRedirectRetention).
CREATE TABLE IF NOT EXISTS not_found_path (
  site_id text NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  path text NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, path)
);
CREATE INDEX IF NOT EXISTS not_found_path_last_seen_idx ON not_found_path (last_seen);
