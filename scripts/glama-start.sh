#!/usr/bin/env sh
# Start command for the Glama check: the throwaway Postgres from glama-setup.sh,
# then the MCP server on stdio. stdout is JSON-RPC, so Postgres' chatter goes to
# stderr and tsx runs directly (pnpm would print its script banner to stdout).
set -eu
service postgresql start >&2
cd "$(dirname "$0")/../apps/mcp"
exec ./node_modules/.bin/tsx src/server.ts
