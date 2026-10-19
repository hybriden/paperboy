#!/usr/bin/env sh
# Build step for the Glama MCP directory (glama.ai/mcp/servers/hybriden/paperboy).
# Glama only checks that the server starts and answers tools/list, so this seeds a
# THROWAWAY Postgres inside its image with the public demo data. Nothing here
# reaches a real instance. Run from the repo root, as root, after
# `apt-get install postgresql` and `pnpm install --filter "@paperboy/mcp..."`.
set -eu
service postgresql start
runuser -u postgres -- psql -c "CREATE ROLE paperboy LOGIN PASSWORD 'paperboy'"
runuser -u postgres -- createdb -O paperboy paperboy
DATABASE_URL=postgresql://paperboy:paperboy@localhost:5432/paperboy \
  ALLOW_DEMO_CREDENTIALS=true pnpm --filter @paperboy/db seed
service postgresql stop
