-- A site delete now removes the MCP tokens scoped to it (deleteSite). Tokens
-- left behind by sites deleted before that still authenticate and act with the
-- user's every-site roles in a site that no longer exists: remove them.
DELETE FROM mcp_token WHERE site_id IS NOT NULL AND site_id NOT IN (SELECT id FROM site);
