-- OAuth 2.1 for the remote MCP server (the MCP authorization spec): the API is
-- the authorization server, the MCP server the protected resource.
--
-- A grant is one consented connection: a client, acting AS a user, confined to
-- one site or (site_id NULL) every site — the same cap an mcp_token carries, so
-- the MCP enforces both through one code path. Tokens are stored sha-256
-- hashed, like mcp_token and session. Additive: nothing existing changes.

CREATE TABLE IF NOT EXISTS oauth_client (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  -- NULL = a public client (PKCE only); otherwise sha-256 of the issued secret.
  client_secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_code (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id text REFERENCES site(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Set on first exchange; a replay revokes the grant it produced.
  used_at timestamptz,
  grant_id integer
);

CREATE TABLE IF NOT EXISTS oauth_grant (
  id serial PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id text REFERENCES site(id) ON DELETE CASCADE,
  resource text NOT NULL,
  access_token_hash text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_grant_user_idx ON oauth_grant(user_id);
