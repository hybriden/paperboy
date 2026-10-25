-- Bumped whenever delivered output may have changed (every publish webhook and
-- delivery.changed announcement), so the api's delivery response cache sees a
-- write made by ANOTHER process (the MCP server) on its next request. A
-- sequence because nextval is visible to every session at once, outside any
-- transaction.
CREATE SEQUENCE IF NOT EXISTS delivery_epoch;
