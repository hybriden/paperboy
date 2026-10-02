-- Short-lived upload links for agents (MCP `create_upload_link`).
--
-- A remote MCP server can't read files on the agent's machine, and sending an
-- image as base64 through a tool call costs ~100k tokens. A link lets the agent
-- `curl` its local files straight to the API instead. The link acts AS the
-- user who minted it, in the site it was minted in, until it expires. The
-- token is stored sha-256 hashed, like mcp_token and session. Additive.

CREATE TABLE IF NOT EXISTS upload_link (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id text NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
