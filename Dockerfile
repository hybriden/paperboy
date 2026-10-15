# syntax=docker/dockerfile:1

# ---------- the one image: api (which also serves the admin) · init · web · mcp ----------
FROM node:24-bookworm-slim AS app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.12.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# Admin is a static SPA; VITE_* are inlined at build time. VITE_WEB_URL is left
# EMPTY so the preview pane derives the web origin from the host the admin is
# loaded on (localhost / LAN IP / domain) at runtime instead of hard-coding it.
ARG VITE_WEB_URL=
# NO VITE_PREVIEW_SECRET. Vite inlines VITE_* as string literals at build time and
# /assets/ is served unauthenticated, so passing the preview secret here
# PUBLISHED it: anyone who fetched the admin's JS could read every draft forever.
# The admin now asks the API for a short-lived token instead
# (GET /manage/preview-token → ?pbt=…), and the secret stays server-side.
ENV VITE_API_URL=/ \
    VITE_WEB_URL=${VITE_WEB_URL}
RUN pnpm --filter @paperboy/web build \
  && pnpm --filter @paperboy/admin build
# The API serves the admin (ADMIN_DIST_DIR) and sends these .gz twins to every
# browser that accepts gzip — the SPA is ~2.7 MB of JS, which ships raw otherwise.
RUN find apps/admin/dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.json' -o -name '*.webmanifest' \) \
    -exec gzip -k -9 {} +
ENV ADMIN_DIST_DIR=/app/apps/admin/dist
RUN mkdir -p /app/uploads
ENV NODE_ENV=production
# TODO(S2-M1): run as the non-root `node` user. Deferred — needs deploy-side
# verification (Next's .next/cache write path + chowning the existing uploads
# volume to uid 1000) that can't be exercised from the test suite.
EXPOSE 8091 8092
# Default = the CMS (api + the admin it serves), so the image runs as-is on a
# platform that just starts a container (App Service, Container Apps, Cloud Run…).
# Compose overrides it per service (init/web/mcp).
CMD ["pnpm", "--filter", "@paperboy/api", "start"]
