-- MCP access tokens: revocable, named tokens the MCP server presents instead of
-- a password. Each token authenticates AS a Paperboy user (inherits its RBAC).
CREATE TABLE IF NOT EXISTS mcp_token (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,         -- sha-256 of the secret
  token_prefix TEXT NOT NULL DEFAULT 'mcp_',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mcp_token_user_idx ON mcp_token (user_id);
