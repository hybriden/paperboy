# CLAUDE.md — working in this repo

Guidance for Claude / contributors. Read this before changing or deploying anything.

## What this is
**Paperboy**, a headless CMS. pnpm monorepo:

- `apps/api` — Fastify v5 + `fastify-type-provider-zod` (one Zod schema per route → validation + serialization + **OpenAPI 3.1**). Management API (session + CSRF + RBAC) and Delivery API (GET-only, key-scoped).
- `apps/admin` — React 19 + Vite SPA. The editor (page tree, content areas, all-properties, live preview, visual on-page editing). react-router-dom, TanStack Query, Radix, @dnd-kit, TipTap.
- `apps/web` — Next.js 15 reference frontend (Draft Mode preview). Any frontend can instead consume the Delivery API over HTTP.
- `apps/mcp` — stdio MCP server. Imports `@paperboy/db` and calls the **same functions** the API does, so it inherits RBAC + Zod + the no-leak chokepoint + audit.
- `packages/shared` — Zod schemas + types (single source of truth) + the AI provider.
- `packages/db` — Drizzle schema, forward-only SQL migrations, the query layer (all object-level authz lives here, deny-by-default), seed.

## ⚠️ Deploy safety (most important rule)
The compose `init` service runs migrate **+ seed**, and `seed` TRUNCATEs and reseeds — **wiping all data and regenerating IDs**.

- **Redeploy one service:** `docker compose up -d --no-deps --force-recreate <svc>`
- **NEVER** run a plain `docker compose up <svc>` — it pulls in the `init` dependency and reseeds. This has caused real data loss.
- **Apply migrations without reseeding:** migrations run on api boot, or `docker compose exec api pnpm --filter @paperboy/db migrate` (forward-only, idempotent, tracked in `_migrations` — separate from `seed`).
- Only reseed deliberately: `docker compose run --rm init`.

## Ports & env
- admin **8090**, api **8091**, web **8092**, Postgres **5433** (host) → 5432 (container).
- MCP **8093** (optional, opt-in): `MCP_TOKEN=mcp_… docker compose --profile mcp up -d --no-deps mcp` serves the MCP over Streamable HTTP at `/mcp` (Bearer = `MCP_TOKEN`). Default is stdio; HTTP mode is only for remote clients.
- pnpm is at `~/.npm-global/bin` — prefix commands with `export PATH="$HOME/.npm-global/bin:$PATH"`.
- DB URL (host): `postgresql://paperboy:paperboy@localhost:5433/paperboy`.
- Secrets in `docker-compose.yml`/`.env.example` are **dev defaults** — rotate before exposing (`SESSION_SECRET`, `CSRF_SECRET`, `PAPERBOY_*_KEY`, `PREVIEW_SECRET`, admin password).

## Auth model
- Browser: argon2id + opaque server-side session cookie (`__Host-paperboy_sid` when `COOKIE_SECURE=true`) + CSRF double-submit + rate-limit/lockout.
- **`COOKIE_SECURE=true` requires HTTPS** — http://localhost logins will fail (cookie dropped). Test the admin over an https host.
- 2FA: **passwordless email + TOTP** (a 2FA-enabled account logs in with email → code, no password). TOTP gates the browser login only; service paths (`verifyLogin`) check the password.
- MCP: a **token** (Settings → MCP, `MCP_TOKEN` env) or email+password; authenticates AS a user and inherits its RBAC.

## Content model
- Content types are **data** (`content_type` table), not hardcoded. Kinds: `page` / `block` / `global`.
- Content areas hold ordered block instances — inline (page-local) or shared (reference). Fields: text, markdown, richtext (TipTap JSON), boolean, number, datetime, select, link, image, reference, contentArea.
- Delivery is a **single read chokepoint** with a `perspective` (published | preview). Public key → published only; preview key → drafts. Private fields never reach delivery output. Don't add read paths that bypass it.

## Testing
- API: `pnpm --filter @paperboy/api test` (Vitest + a real Postgres test DB; isolated).
- e2e: `pnpm --filter @paperboy/admin test:e2e` (Playwright + axe). Run against the live deploy with `ADMIN_URL=https://<host>` (needed because `COOKIE_SECURE` breaks http login). Don't run the full data-mutating suite against a live instance you care about.
- Always typecheck before deploying: `pnpm -r typecheck`.

## Conventions
- TypeScript strict, end-to-end types from the shared Zod schemas. Match surrounding style.
- Migrations are forward-only; add a new numbered `.sql` in `packages/db/migrations/`.
- Commit/push only when asked; branch off if on the default branch.

See `STACK.md` for the stack rationale.
