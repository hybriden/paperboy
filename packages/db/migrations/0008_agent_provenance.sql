-- Agent provenance + review flag (docs/POSITIONING.md):
--   created_via  — which surface wrote this version ("mcp" = agent, "web" = human; NULL = pre-feature)
--   needs_review — set on agent-written drafts; cleared by a human edit or an explicit approve
ALTER TABLE content_version ADD COLUMN IF NOT EXISTS created_via TEXT;
ALTER TABLE content_version ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
