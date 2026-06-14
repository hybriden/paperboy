# CLAUDE.md — working in this repo

Guidance for Claude / contributors. Read this before changing or deploying anything.

## What this is
**Paperboy**, a headless CMS. pnpm monorepo:

- `apps/api` — Fastify v5 + `fastify-type-provider-zod` (one Zod schema per route → validation + serialization + **OpenAPI 3.1**). Management API (session + CSRF + RBAC) and Delivery API (GET-only, key-scoped).
- `apps/admin` — React 19 + Vite SPA. The editor (page tree, content areas, all-properties, live preview, visual on-page editing). react-router-dom, TanStack Query, Radix, @dnd-kit, TipTap.
- `apps/web` — Next.js 15 reference frontend (Draft Mode preview), consuming the Delivery API via `@paperboycms/client`.
- `apps/mcp` — stdio MCP server. Imports `@paperboy/db` and calls the **same functions** the API does, so it inherits RBAC + Zod + the no-leak chokepoint + audit.
- `packages/shared` — Zod schemas + types (single source of truth) + the AI provider.
- `packages/db` — Drizzle schema, forward-only SQL migrations, the query layer (all object-level authz lives here, deny-by-default), seed.
- `packages/client` — `@paperboycms/client` (published to npm): the typed Delivery API client SDK (`createClient`, lists/search/media variants, schema-driven render helpers, optional ETag cache). End-to-end tested in `apps/api/test/client-sdk.test.ts` against a live server.
- `packages/preview` — `@paperboycms/preview` (published to npm): the framework-agnostic on-page-editing bridge for the preview iframe, zero runtime dependencies. Single source of truth for the admin↔frontend postMessage protocol (`paperboy:edit/drop/rect/patch/focus`) and the `data-pb-*` DOM contract; the admin and `apps/web` both import it — never re-declare message shapes elsewhere.
- `evals/` — model-driven MCP usability eval. Every push/PR runs it with the deterministic `--mock` driver (real MCP tool calls, no paid API — failures are real agent-surface regressions, not model flake); the weekly schedule/manual dispatch runs a real model (needs `ANTHROPIC_API_KEY` secret). `ops/` — reference copies of the production backup/monitor scripts.

## ⚠️ Deploy safety (most important rule)
The compose `init` service runs migrate **+ seed**. `seed` TRUNCATEs and reseeds — **wiping all data and regenerating IDs** — but the CLI is GUARDED: on a database that already holds content it skips the wipe (and still applies migrations) unless `FORCE_SEED=1`. The guard exists because a plain `docker compose up <svc>` pulling in `init` caused real data loss; treat it as a seatbelt, not an invitation.

- **Redeploy one service:** `docker compose up -d --no-deps --force-recreate <svc>` (still the correct habit).
- **`docker compose start <svc>` ALSO starts its `depends_on` services — including `init`, as the CONTAINER it was last created from.** A stale pre-guard init container re-ran an old unguarded seed this way and wiped production (2026-06-06; restored from backup). After pulling a new image, recreate init once: `docker compose rm -f init && docker compose up -d init`.
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
- Content areas hold ordered block instances — inline (page-local) or shared (reference). Fields: text, markdown, richtext (TipTap JSON), boolean, number, datetime, select, link, image, reference, contentArea (+ legacy media). Image/media values are asset documentIds — URLs and paths are rejected at write.
- Delivery is a **single read chokepoint** with a `perspective` (published | preview). Public key → published only; preview key → drafts. Private fields never reach delivery output. Don't add read paths that bypass it.
- Delivery items and inline blocks expose **`fieldTypes`** (the declared type per *public* field) so frontends switch on schema instead of value-sniffing — an empty richtext field stays richtext. Part of the frozen delivery contract.
- **SEO contract**: fields can declare a `seoRole` (title/description/image/datePublished/…) and/or a `schemaProp` (dot-path schema.org property, e.g. `offers.price`); the content type carries a `schemaType`. Delivery computes a normalized `seo` block (meta/canonical/robots/OG/Twitter + per-`@type`-correct JSON-LD + breadcrumbs) on every PAGE item — **post-sanitize**, so a private role-tagged field can never leak; preview is always `noindex`. The per-`@type` catalog and `SEO_CONVENTION` live in packages/shared so the type-editor checklist and delivery can't drift. Pinned by `delivery-seo-contract.test.ts`.

## AI (the copy desk)
- One provider in `packages/shared`; key/model + the agentReview gate are instance-global (Settings → AI). Surfaces: the admin copy desk (improve/rewrite/draft-about-a-topic/variants), translate (incl. richtext), vision alt text (`POST /ai/alt-text` sends the actual image bytes, site-partitioned), schema.org field suggestions, MCP `ai_assist`.
- **No key → model-requiring tasks REFUSE** with a self-teaching `AiUnavailableError` — never echo the input dressed up as a result (rule #1 below; the old improve fallback did exactly that). Only meta_title/meta_description/summarize keep truncation fallbacks, labeled `basic`. The admin disables model-requiring entry points with an honest hint when no key is set.

## Published npm packages
`@paperboycms/client` and `@paperboycms/preview` ship to npm (independently versioned).
- **Publish with `pnpm publish` from the package dir** — `publishConfig` rewrites the dev `src/` entry points to `dist/` at publish time; a raw `npm publish` would ship TypeScript sources (this bit once: preview 0.1.1 exists because of it).
- Bump the package version in the same change that alters its public surface, and keep its README in sync — external consumers read npm, not this repo.
- Protocol/contract changes must stay consumable by already-deployed frontends: the client's surface is pinned by `client-sdk.test.ts`; the preview protocol is consumed by the admin AND arbitrary external frontends, so additions yes, breaking renames no (or version deliberately on both sides).

## Multisite
Multiple sites/brands live in one instance, partitioned by `content_item.site_id` (migration `0012_sites.sql`; all pre-multisite data was backfilled losslessly into the fixed `'site_default'` site, which is also the column DEFAULT so single-site write paths keep working). Decisions: **D1** per-site delivery keys (`delivery_key.site_id`; `verifyDeliveryKey` → `{type, siteId}`); **D2** media is per-site (`asset.site_id`) while **content types, locales and users are SHARED**; **D3** one lossless Default site.

- **The partition is enforced in the two chokepoints, deny-by-default — don't add a path that skips it.** Management: `AccessContext.siteId` (the active site) gates `loadAuthorized`/`loadAnyState` (a cross-site doc reads as not-found, even for a site-wide admin) and every broad scan (`getTree`, `listBlocks`, `listPages`, `searchContent`, `listTrash`, `emptyTrash`, `listAssets`). Delivery: `DeliveryCtx.siteId` confines `ctx.item()` (so the whole reference/contentArea graph stays in-site) plus the direct `content_item` scans (list/by-path/global/search/siteName) and asset resolution.
- **Active site** (management) comes from the `x-paperboy-site` request header (the admin site switcher); unknown/absent → Default. Slug uniqueness is per-site, so two sites can each own a root `/about`. `createContent` children inherit the parent's site; roots take the active site.
- **Per-site setup** (migration `0013`): the **preview URL** and **start page** live on the `site` entity (not the global `site_setting` table), and **delivery keys are minted/listed/renamed/revoked per active site**. Settings → Site edits the active site + lists/creates sites. AI key/model + agentReview stay instance-global. `deliveryStartPage` serves the requesting site's own start page.
- **Known gaps (NOT yet closed — flag before relying on them):** (1) **roles are still global** — an Admin/Editor is one in every site; per-site role membership + a cross-site super-admin is deferred (Phase 5). Section *scopes* are already per-site. (2) **cross-site references aren't blocked at write** — an editor can set a reference/contentArea ref to another site's documentId; it's harmless at delivery (resolves to null, never leaks) but is a write-time integrity gap.
- **Deploy:** `0012`/`0013` are additive/idempotent and run on api boot like any migration — no reseed. Status: **merged to main** (PR #2, plus per-site setup/UX in PRs #3–#8); the known gaps above are still open.

## Agent-API design rules (MCP & write endpoints — learned from real failures)
Every rule below traces to a real agent run that broke. Do not regress them.

1. **Never garbage-in-success-out.** Coerce input only when the transform is meaning-preserving; otherwise REJECT. A destructive write that returns success gaslights the agent into a retry loop (real incident: a TipTap doc sent to a markdown field was flattened by gluing text nodes together with no separators — persisted, "success", agent looped 9× and aborted).
2. **Errors must be self-teaching.** Name the field, the expected JSON shape, and a copyable example (`fieldFormatHint` / `formatDataValidation`). The error text is the only context an agent reliably reads mid-loop — it must be enough to self-correct in one step.
3. **All tolerant coercion lives in ONE chokepoint** — `coerceFieldValue` (packages/shared), shared by API + MCP + admin, test-pinned in `update-ergonomics.test.ts`. Mistakes it absorbs (each from a real run): self-keyed wrap `{field: v}`, locale-map wrap `{en: v}`, TipTap doc → real Markdown (structure kept) / separated plain text, string → TipTap doc, single block → array, resolved asset object → documentId, richtext outside the editor schema → normalized. Add new agent mistakes HERE, with a test.
4. **Offer flat single-string params for long content** (`set_field`). Long strings nested inside record params (`data`) get mangled to `{}` by some clients' tool-call JSON repair — a flat top-level string survives. Steer to it in tool descriptions and in the relevant error messages.
5. **Safe defaults over correct-but-sharp semantics.** MCP `update_content` merges by default (a full replace silently drops required fields and bricks the next publish). Pages auto-slug from their name (an agent that forgets the slug otherwise creates unreachable content).
6. **Every failed agent run must leave a trail.** MCP tool errors log to stdout WITH truncated args (`docker logs`); every MCP write audit-logs like the API routes (`ip='mcp'`). Two incidents were undiagnosable because errors only travelled in-band and the client swallowed them.
7. **Annotate the schema for agents.** `get_content_type` returns `valueFormat` + `valueExample` per field — the contract is discoverable, not tribal knowledge.

## ⚖️ Bugfix law: failing test first
Every bugfix STARTS with a test that reproduces the exact reported failure — same flow, same surface (API/MCP), same inputs; not a lookalike. Run it and confirm it FAILS on the unfixed code: that red run is the proof you understood the issue and are patching the right place. Only then implement, and the same test must go green in the same change. No repro, no fix — no guesswork.

## Testing
- API: `pnpm --filter @paperboy/api test` (Vitest + a real Postgres test DB; isolated).
- **Contract-freeze layers** (all in `apps/api/test/`): `shared-*.test.ts` are pure unit/property tests of packages/shared (no DB — richtext sanitizer fixpoint, coercion matrix); `delivery-contract` + `openapi-snapshot` pin delivered JSON shapes and the API surface as snapshots — a failing snapshot means you changed a PUBLIC CONTRACT: review the diff and update the snapshot deliberately in the same commit, never blind `--update`; `mcp-parity` spawns the real stdio MCP server and locks the tool surface, write parity, and self-teaching error shapes.
- e2e: `pnpm --filter @paperboy/admin test:e2e` (Playwright + axe). Run against the live deploy with `ADMIN_URL=https://<host>` (needed because `COOKIE_SECURE` breaks http login). Don't run the full data-mutating suite against a live instance you care about.
- Always typecheck before deploying: `pnpm -r typecheck`.
- Lint: `pnpm lint` runs **oxlint `--type-aware`** (the type-aware pass needs the `oxlint-tsgolint` dev dep — it's in the lockfile, so `pnpm install --frozen-lockfile` covers CI). Every rule is **error** — no `warn`/`off` downgrades and no per-section exemptions (deliberately, so findings get fixed, not muted). This covers the whole repo: type-aware async-correctness (`no-floating-promises`, `await-thenable`) AND a11y (`control-has-associated-label`, `no-autofocus`, etc.). Conventions when fixing: floating promises get a `void` prefix (don't make handlers async); `unknown` content values stringified via a local `scalarToString`/`asText`/`rtScalar` helper (objects → `""`, never `"[object Object]"`); `autoFocus` is replaced by a `useRef` + mount `useEffect` focus (a11y-clean, behaviour-preserved). The ONE disabled rule is **`jsx-a11y/prefer-tag-over-role`** — it's stylistic ("prefer the native tag"), not an a11y defect, and it fights legitimate custom ARIA widgets (e.g. the icon-picker is a `listbox` of `option` buttons that can't be a native `<select>`); disabling it keeps the correct ARIA roles instead of stripping them. Note oxlint has `exhaustive-deps` but NOT `rules-of-hooks`, so the admin adds a tiny scoped ESLint pass for that ONE rule (`apps/admin/eslint.config.js` + its `lint` script, which root `pnpm lint` chains after oxlint). It runs `react-hooks/rules-of-hooks` only — parser-only, no overlap with oxlint — and reports nothing else (existing `eslint-disable` directives target rules oxlint owns, so the unused-directive report is off).

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
