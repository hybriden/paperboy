# syntax=docker/dockerfile:1

# ---------- build: install workspace + build web (Next) and admin (Vite) ----------
FROM node:22-bookworm-slim AS app
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
ARG VITE_PREVIEW_SECRET=dev-preview-secret-change-me
ENV VITE_API_URL=/ \
    VITE_WEB_URL=${VITE_WEB_URL} \
    VITE_PREVIEW_SECRET=${VITE_PREVIEW_SECRET}
RUN pnpm --filter @paperboy/web build \
  && pnpm --filter @paperboy/admin build
RUN mkdir -p /app/uploads
ENV NODE_ENV=production
# TODO(S2-M1): run as the non-root `node` user. Deferred — needs deploy-side
# verification (Next's .next/cache write path + chowning the existing uploads
# volume to uid 1000) that can't be exercised from the test suite.
EXPOSE 8091 8092

# ---------- admin: nginx serving the built SPA + proxying /api ----------
FROM nginx:1.27-alpine AS admin
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=app /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 8090
