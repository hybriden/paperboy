# Introspection image for the Glama MCP directory (glama.ai/mcp/servers), which
# only checks that the server starts and answers tools/list. NOT for real use:
# a throwaway Postgres lives inside the container, seeded with the PUBLIC demo
# login, so it reaches no real instance. Self-contained (clones the repo) because
# Glama takes the Dockerfile pasted into its form.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates postgresql \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.12.0
RUN git clone --depth 1 https://github.com/hybriden/paperboy.git /app
WORKDIR /app
RUN pnpm install --frozen-lockfile --filter "@paperboy/mcp..."

ENV DATABASE_URL=postgresql://paperboy:paperboy@localhost:5432/paperboy \
    ALLOW_DEMO_CREDENTIALS=true \
    MCP_EMAIL=admin@paperboy.test \
    MCP_PASSWORD=Admin!Passw0rd
# Seed at build time so the container is ready the moment it starts.
RUN service postgresql start \
  && su postgres -c "psql -c \"CREATE ROLE paperboy LOGIN PASSWORD 'paperboy'\"" \
  && su postgres -c "createdb -O paperboy paperboy" \
  && pnpm --filter @paperboy/db seed \
  && service postgresql stop

WORKDIR /app/apps/mcp
# stdio: stdout is JSON-RPC, so Postgres' startup chatter goes to stderr and tsx
# runs directly (pnpm would print its script banner to stdout).
CMD ["sh", "-c", "service postgresql start >&2 && exec ./node_modules/.bin/tsx src/server.ts"]
