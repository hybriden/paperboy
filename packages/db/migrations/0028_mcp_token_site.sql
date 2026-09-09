-- MCP tokens can be confined to ONE site, mirroring delivery_key.site_id (D1).
--
-- NULL means every site, and that is exactly what existing tokens get: nothing
-- in flight changes on deploy. The admin mints NEW tokens against the active
-- site, so the default for anything created from here on is the narrow one.
ALTER TABLE mcp_token ADD COLUMN IF NOT EXISTS site_id text;
