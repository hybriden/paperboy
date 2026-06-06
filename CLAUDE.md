# CLAUDE.md — working in this repo

Guidance for Claude / contributors. Read this before changing or deploying anything.

## What this is
**Paperboy**, a headless CMS. pnpm monorepo:

- `apps/api` — Fastify v5 + `fastify-type-provider-zod` (one Zod schema per route → validation + serialization + **OpenAPI 3.1**). Management API (session + CSRF + RBAC) and Delivery API (GET-only, key-scoped).
- `apps/admin` — React 19 + Vite SPA. The editor (page tree, content areas, all-properties, live preview, visual on-page editing). react-router-dom, TanStack Query, Radix, @dnd-kit, TipTap.
- `apps/web` — Next.js 15 reference frontend (Draft Mode preview), consuming the Delivery API via `@paperboy/client`.
- `apps/mcp` — stdio MCP server. Imports `@paperboy/db` and calls the **same functions** the API does, so it inherits RBAC + Zod + the no-leak chokepoint + audit.
- `packages/shared` — Zod schemas + types (single source of truth) + the AI provider.
- `packages/db` — Drizzle schema, forward-only SQL migrations, the query layer (all object-level authz lives here, deny-by-default), seed.
- `packages/client` — the typed Delivery API client SDK (`createClient`, lists/search/media variants, optional ETag cache). End-to-end tested in `apps/api/test/client-sdk.test.ts` against a live server.
- `evals/` — model-driven MCP usability eval (weekly workflow; needs `ANTHROPIC_API_KEY` secret). `ops/` — reference copies of the production backup/monitor scripts.

## ⚠️ Deploy safety (most important rule)
The compose `init` service runs migrate **+ seed**. `seed` TRUNCATEs and reseeds — **wiping all data and regenerating IDs** — but the CLI is GUARDED: on a database that already holds content it skips the wipe (and still applies migrations) unless `FORCE_SEED=1`. The guard exists because a plain `docker compose up <svc>` pulling in `init` caused real data loss; treat it as a seatbelt, not an invitation.

- **Redeploy one service:** `docker compose up -d --no-deps --force-recreate <svc>` (still the correct habit).
- **Apply migrations without reseeding:** migrations run on api boot, on any guarded-skip init run, or `docker compose exec api pnpm --filter @paperboy/db migrate` (forward-only, idempotent, tracked in `_migrations` — separate from `seed`).
- **Reseed deliberately (wipes everything):** `FORCE_SEED=1 docker compose run --rm init`.
- Tests are unaffected: they import `seed()` directly, which stays unguarded.

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

## Agent-API design rules (MCP & write endpoints — learned from real failures)
Every rule below traces to a real agent run that broke. Do not regress them.

1. **Never garbage-in-success-out.** Coerce input only when the transform is meaning-preserving; otherwise REJECT. A destructive write that returns success gaslights the agent into a retry loop (real incident: a TipTap doc sent to a markdown field was flattened by gluing text nodes together with no separators — persisted, "success", agent looped 9× and aborted).
2. **Errors must be self-teaching.** Name the field, the expected JSON shape, and a copyable example (`fieldFormatHint` / `formatDataValidation`). The error text is the only context an agent reliably reads mid-loop — it must be enough to self-correct in one step.
3. **All tolerant coercion lives in ONE chokepoint** — `coerceFieldValue` (packages/shared), shared by API + MCP + admin, test-pinned in `update-ergonomics.test.ts`. Mistakes it absorbs (each from a real run): self-keyed wrap `{field: v}`, locale-map wrap `{en: v}`, TipTap doc → real Markdown (structure kept) / separated plain text, string → TipTap doc, single block → array, resolved asset object → documentId, richtext outside the editor schema → normalized. Add new agent mistakes HERE, with a test.
4. **Offer flat single-string params for long content** (`set_field`). Long strings nested inside record params (`data`) get mangled to `{}` by some clients' tool-call JSON repair — a flat top-level string survives. Steer to it in tool descriptions and in the relevant error messages.
5. **Safe defaults over correct-but-sharp semantics.** MCP `update_content` merges by default (a full replace silently drops required fields and bricks the next publish). Pages auto-slug from their name (an agent that forgets the slug otherwise creates unreachable content).
6. **Every failed agent run must leave a trail.** MCP tool errors log to stdout WITH truncated args (`docker logs`); every MCP write audit-logs like the API routes (`ip='mcp'`). Two incidents were undiagnosable because errors only travelled in-band and the client swallowed them.
7. **Annotate the schema for agents.** `get_content_type` returns `valueFormat` + `valueExample` per field — the contract is discoverable, not tribal knowledge.

## Testing
- API: `pnpm --filter @paperboy/api test` (Vitest + a real Postgres test DB; isolated).
- **Contract-freeze layers** (all in `apps/api/test/`): `shared-*.test.ts` are pure unit/property tests of packages/shared (no DB — richtext sanitizer fixpoint, coercion matrix); `delivery-contract` + `openapi-snapshot` pin delivered JSON shapes and the API surface as snapshots — a failing snapshot means you changed a PUBLIC CONTRACT: review the diff and update the snapshot deliberately in the same commit, never blind `--update`; `mcp-parity` spawns the real stdio MCP server and locks the tool surface, write parity, and self-teaching error shapes.
- e2e: `pnpm --filter @paperboy/admin test:e2e` (Playwright + axe). Run against the live deploy with `ADMIN_URL=https://<host>` (needed because `COOKIE_SECURE` breaks http login). Don't run the full data-mutating suite against a live instance you care about.
- Always typecheck before deploying: `pnpm -r typecheck`.

## Code Quality Rules

- Prefer simple, human-readable implementations over clever abstractions.
- Keep files and functions focused on a single responsibility.
- Avoid large monolithic modules; split by feature or domain.
- Write code so a new engineer can understand it quickly.
- Favor explicit naming over shortened or ambiguous names.
- Keep functions small and composable.
- Minimize hidden side effects and implicit behavior.
- Structure code for maintainability first, optimization second.

## Conventions
- TypeScript strict, end-to-end types from the shared Zod schemas. Match surrounding style.
- Migrations are forward-only; add a new numbered `.sql` in `packages/db/migrations/`.
- Commit/push only when asked; branch off if on the default branch.

See `STACK.md` for the stack rationale.
