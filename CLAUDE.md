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
- `packages/client` — `@paperboycms/client` (published to npm): the typed Delivery API client SDK (`createClient`, lists/search/media variants, schema-driven render helpers, optional ETag cache). End-to-end tested in `apps/api/test/client-sdk.test.ts` against a live server. Preview-token verification ships as the SEPARATE subpath `@paperboycms/client/preview-token` (WebCrypto, runs on Node/Workers/Deno/Bun) — separate because its first argument is `PREVIEW_SECRET`, so the main entry must not be able to reach it.
- `packages/preview` — `@paperboycms/preview` (published to npm): the framework-agnostic on-page-editing bridge for the preview iframe, zero runtime dependencies. Single source of truth for the admin↔frontend postMessage protocol (`paperboy:edit/drop/rect/patch/focus`) and the `data-pb-*` DOM contract; the admin and `apps/web` both import it — never re-declare message shapes elsewhere.
- `evals/` — model-driven MCP usability eval. Every push/PR runs it with the deterministic `--mock` driver (real MCP tool calls, no paid API — failures are real agent-surface regressions, not model flake); the weekly schedule/manual dispatch runs a real model (needs `ANTHROPIC_API_KEY` secret). `ops/` — reference copies of the production backup/monitor scripts.

## First run
`./scripts/setup.sh` (or `.\scripts\setup.ps1`) generates `.env` with unique secrets and
your own admin password, then `docker compose up -d`. **The setup step is required, not
optional**: the API refuses to boot on the `prod-…-please-override` secrets compose ships,
and the seed refuses the published demo login — both are committed in this public repo. It
is safe to re-run (an existing `.env` is never overwritten). A CI job runs exactly this
path in a clean checkout, because nothing else would catch the quickstart breaking.

## ⚠️ Deploy safety (most important rule)
The compose `init` service runs migrate **+ seed**. `seed` TRUNCATEs and reseeds — **wiping all data and regenerating IDs** — but the CLI is GUARDED: on a database that already holds content it skips the wipe (and still applies migrations) unless `FORCE_SEED=1`. The guard exists because a plain `docker compose up <svc>` pulling in `init` caused real data loss; treat it as a seatbelt, not an invitation.

- **Redeploy one service:** `docker compose up -d --no-deps --force-recreate <svc>` (still the correct habit).
- **`docker compose start <svc>` ALSO starts its `depends_on` services — including `init`, as the CONTAINER it was last created from.** A stale pre-guard init container re-ran an old unguarded seed this way and wiped production (2026-06-06; restored from backup). After pulling a new image, recreate init once: `docker compose rm -f init && docker compose up -d init`.
- **Apply migrations without reseeding:** migrations run on api boot, on any guarded-skip init run, or `docker compose exec api pnpm --filter @paperboy/db migrate` (forward-only, idempotent, tracked in `_migrations` — separate from `seed`).
- **Reseed deliberately (wipes everything):** `FORCE_SEED=1 docker compose run --rm init`.
- Tests are unaffected: they import `seed()` directly, which stays unguarded.

## Ports & env
- admin **8090**, api **8091**, Postgres **5433** (host) → 5432 (container).
- **`web` (8092) is OPT-IN** (`docker compose --profile web up -d web`), like `mcp`. `apps/web` is the reference consumer that pins the delivery contract in a second framework — it is NOT the website a user builds on, and starting it by default meant a newcomer got two frontends on two ports with the designed one (the Astro starter, :4321) not among them. The quickstart CI job exercises the profile, so the opt-in path cannot rot. **Upgrade gotcha:** `docker compose down` SKIPS profiled services, so an existing `paperboy-web-1` container keeps running after this change until you remove it explicitly (`docker compose --profile web down`, or `docker rm -f paperboy-web-1`).
- The seed sets the default site's **preview URL to `http://localhost:4321`** (the Astro starter; override with `SITE_PREVIEW_URL`). Empty, the admin's side-by-side pane has nothing to frame and reads as broken.
- MCP **8093** (optional, opt-in): `MCP_TOKEN=mcp_… docker compose --profile mcp up -d --no-deps mcp` serves the MCP over Streamable HTTP at `/mcp` (Bearer = `MCP_TOKEN`). Default is stdio; HTTP mode is only for remote clients.
- pnpm is at `~/.npm-global/bin` — prefix commands with `export PATH="$HOME/.npm-global/bin:$PATH"`.
- DB URL (host): `postgresql://paperboy:paperboy@localhost:5433/paperboy`.
- Secrets in `docker-compose.yml`/`.env.example` are **dev defaults** — rotate before exposing (`SESSION_SECRET`, `CSRF_SECRET`, `PAPERBOY_*_KEY`, `PREVIEW_SECRET`, admin password).

## Auth model
- Browser: argon2id + opaque server-side session cookie (`__Host-paperboy_sid` when `COOKIE_SECURE=true`) + CSRF double-submit + rate-limit/lockout.
- **`COOKIE_SECURE=true` requires HTTPS** — http://localhost logins will fail (cookie dropped). Test the admin over an https host.
- 2FA: **passwordless email + TOTP** (a 2FA-enabled account logs in with email → code, no password). TOTP gates the browser login only; service paths (`verifyLogin`) check the password.
- **Enabling 2FA requires the account password**, not just a session — same `verifyReauth` gate as disabling it. Because login is passwordless once 2FA is on, a stolen session could otherwise enrol its own authenticator and lock the real owner out permanently.
- **`MFA_SECRET` goes through the same placeholder guard as `SESSION_SECRET`/`CSRF_SECRET`.** It is the AES-256-GCM KEK for `users.totp_secret` and the stored AI/stock keys, so a shipped-constant value turns one leaked `users` row into a full takeover. (Found live 2026-07-28: it was byte-for-byte the compose `prod-…-please-override` placeholder, which is committed in this public repo. Unset is fine — it falls back to `SESSION_SECRET`.)
- **The seed refuses to create the published demo credentials in production.** `admin@paperboy.test / Admin!Passw0rd`, the editor/author/viewer logins and the two seeded delivery keys are all public constants; under `NODE_ENV=production` the seed demands real values and creates ONLY the admin. `ALLOW_DEMO_CREDENTIALS=true` opts a throwaway demo/CI stack back in. A database that already holds data is skipped before this runs, so it can't block an existing deploy.
- **The preview secret never reaches the browser.** The admin asks the API for a short-lived signed token (`GET /manage/preview-token`, session-authenticated) and passes it as `?pbt=`; the frontend verifies it with the same `PREVIEW_SECRET`, which must be set on BOTH api and web. `?pb=<secret>` still works for server-side callers. **Frontends must not hand-copy the verification** — it ships as `@paperboycms/client/preview-token`, and `client-preview-token.test.ts` pins the two implementations together (shared/node:crypto SIGNS, client/WebCrypto VERIFIES) because drift there either kills preview everywhere or leaks drafts, silently. Do **not** reintroduce `VITE_PREVIEW_SECRET` — Vite inlines `VITE_*` at build time and nginx serves `/assets/` unauthenticated, so that published the secret (verified live).
- MCP: a **token** (Settings → MCP, `MCP_TOKEN` env) or email+password; authenticates AS a user and inherits its RBAC.
- **MCP token revocation takes effect immediately.** The presented bearer is resolved through the DB *before* any constant-time compare against the in-memory boot `MCP_TOKEN`, so a token revoked in Settings → MCP stops working without a restart; `AccessContext` is also re-resolved per HTTP request, so role/scope changes apply live. An env-only `MCP_TOKEN` with no DB row still works (rotate it by restarting).
- **The `delivery_*` MCP tools are RBAC-gated** (`content.read`), and the **preview perspective additionally requires site-wide read** — the delivery chokepoint is key-scoped, not section-scoped, so a section-scoped user calling it with `preview:true` would otherwise read every draft in the site. Published-perspective reads stay open to any `content.read` holder (a public delivery key would serve the same bytes).

## Content model
- Content types are **data** (`content_type` table), not hardcoded. Kinds: `page` / `block` / `global`.
- **PARTS (`nestedOnly`)**: a block type that is only ever nested inside another type — a Form's ten field blocks. `allowedBlocks` states the rule from the container's side and defaults to "any block", so this flag is the missing other half: a part is left out of the block palette's no-allow-list fallback, the reuse picker, and the empty-types housekeeping count, and gets its own "Parts" tab instead of padding "Blocks". It IS still listed in a content area's `allowedBlocks` picker (that's how a container opts in) and is otherwise a normal block — shareable, versioned, localized, RBAC'd, MCP-editable. Ask `generalBlockTypes()` (packages/shared) for "any block"; don't re-derive `kind === "block"` anywhere. Availability metadata, deliberately **not** a fourth `kind` — kind carries storage semantics a part doesn't change. Migration 0024 flags the built-ins, because instantiating a template's referenced blocks is create-only and existing instances would otherwise stay unflagged.
- **Child ordering is declared on the container** (`content_item.child_sort`): `manual` (drag-and-drop tree order; new children APPEND at max+1) or a computed rule — `name` | `createdAt` | `data.<field>`, `-` prefix = descending. The admin tree AND delivery's default list order both follow it (one comparator, `sortByRule` in packages/shared); an explicit delivery `?sort=` wins; non-public `data` fields never order a public list (per-item gate). Set via tree right-click → Sort children… / `POST /content/:id/child-sort`.
- Content areas hold ordered block instances — inline (page-local) or shared (reference). Fields: text, markdown, richtext (TipTap JSON), boolean, number, datetime, select, link, image, reference, contentArea (+ legacy media). Image/media values are asset documentIds — URLs and paths are rejected at write.
- Delivery is a **single read chokepoint** with a `perspective` (published | preview). Public key → published only; preview key → drafts. Private fields never reach delivery output. Don't add read paths that bypass it.
- **Delivery READS are GET-only; form submissions are the one anonymous WRITE**, and they have their own chokepoint (`submitForm` in `packages/db/src/forms.ts`, route `apps/api/src/routes/submit.ts`) — deliberately NOT in delivery.ts, so the read path stays read-only. That route must never read a session cookie: "no CSRF token needed" is only true while it has no ambient authority to ride, and `forms-submit.test.ts` asserts a cookie-bearing request is treated as anonymous. Don't add other public write paths without the same treatment.
- Delivery items and inline blocks expose **`fieldTypes`** (the declared type per *public* field) so frontends switch on schema instead of value-sniffing — an empty richtext field stays richtext. Part of the frozen delivery contract.
- **SEO contract**: fields can declare a `seoRole` (title/description/image/datePublished/…) and/or a `schemaProp` (dot-path schema.org property, e.g. `offers.price`); the content type carries a `schemaType`. Delivery computes a normalized `seo` block (meta/canonical/robots/OG/Twitter + per-`@type`-correct JSON-LD + breadcrumbs) on every PAGE item — **post-sanitize**, so a private role-tagged field can never leak; preview is always `noindex`. The per-`@type` catalog and `SEO_CONVENTION` live in packages/shared so the type-editor checklist and delivery can't drift. Pinned by `delivery-seo-contract.test.ts`.
- **Public files**: robots.txt / sitemap.xml / llms.txt / security.txt are GENERATED by delivery (`GET /delivery/{robots.txt,sitemap.xml,llms.txt,security.txt}` + the `GET /delivery/pages` inventory they build on) and PROXIED by the frontend from its own origin (apps/web route handlers are the reference) — content-driven, never stale on publish. Config is per site (`site.canonical_base_url` + `site.seo_files`, migration 0021; Settings → Site → Public files; `POST /manage/site/public-files`). Pure builders live in packages/shared/src/public-files.ts. Rules: noIndex pages are excluded from sitemap/llms (never advertise opted-out paths); llms descriptions honour per-type field visibility; security.txt Expires is a rolling 180 days (file is generated per request); absolute URLs use `{canonicalBaseUrl}/{locale}{urlPath}` (the reference frontend's scheme — other frontends build from /delivery/pages). The admin origin serves a static `Disallow: /` robots.txt from nginx.
- **Type templates**: reusable ContentTypeDef recipes (`type_template` table + REST + MCP + Settings → Type templates). A BUILT-IN library ships in code (`BUILTIN_TYPE_TEMPLATES`, packages/shared/src/type-templates.ts — essential pages/blocks/globals, read-only, names reserved; duplicate to customise); invariants pinned by `shared-builtin-templates.test.ts`. Instantiate refuses to overwrite an existing type without `updateExisting: true`; `withBlocks: true` also creates the block types a template's content areas reference (recursive). Export/import moves templates between instances (`GET /type-templates/export`, `POST /type-templates/import` — versioned envelope, per-template skip reasons, built-ins always skipped). Admin: "New content type" opens a template gallery (blank / customize / use-as-is).

## Forms and submissions
Editors build forms as **content**, and submissions stay in this instance's Postgres — the position no headless CMS surveyed takes (they all push submissions to Netlify Forms/Formspree/HubSpot). Research + decisions: `FORMS_PLAN.md`.

- **A form IS content**: the built-in `Form` block type (kind `block`, so it's a shared block with its own documentId) holds settings and a `fields` content area of one block per question (`FormTextField`, `FormEmailField`, `FormTextareaField`, `FormNumberField`, `FormDateField`, `FormSelectField`, `FormRadioField`, `FormCheckboxField`, `FormConsentField`, `FormStaticText`) — all in `BUILTIN_TYPE_TEMPLATES`. Versioning, draft/publish, localized labels, RBAC, preview and MCP come free. A Form must be placed as a **shared** block: submissions are posted against its documentId, which an inline block doesn't have.
- **One authority for the contract**: `packages/shared/src/forms.ts`. `formSpecFrom()` normalizes a Form's data into the spec delivery attaches as `content.form` (schema, never markup — Optimizely's first headless forms API shipped pre-rendered HTML and frontends couldn't restyle it), and `submissionSchemaFor()` compiles the validator the submit endpoint enforces from the **current published** definition. Never validate a submission anywhere else: Payload's form builder trusts the frontend instead and closed that gap "not planned"; Storyblok's tutorials make CMS-declared rules a suggestion the client re-implements.
- **Unknown answer keys are REJECTED** (422), not stored or dropped — rule #1 applies to visitor input too. Field-level messages come back keyed by field so a frontend renders each beside its input (WCAG 3.3.1), using the editor's own error copy when they wrote one.
- **Spam**: a honeypot hidden from sight AND assistive tech, plus a minimum fill time — invisible, accessible, on by default (neither Optimizely nor Umbraco Forms ships a honeypot). A drop returns **202 like a success**; the reason goes to the audit log, never to the bot. Turnstile is opt-in per form (`TURNSTILE_SECRET_KEY`); a form that asks for a challenge with no secret configured REFUSES rather than accepting unverifiable submissions.
- **Storage**: `form_submission` (migration 0022). `field_snapshot` freezes each field's label+kind as answered, so renaming a label can't rewrite history — and for a consent checkbox that snapshot IS the evidence. IP/user-agent are stored **only** when the form opts in (an IP is personal data).
- **Retention is real**: `expires_at` at insert (form setting → instance setting → `SUBMISSION_RETENTION_DAYS`, default 365), swept hourly in-process by `runSubmissionRetention` from app.ts. Umbraco ships the same policy but it silently does nothing until a separate scheduled task is enabled — never make a compliance setting that lies. ⚠️ Nightly `pg_dump` now contains visitor PII: erased data survives in backups for the rotation window, which a data-subject response must say.
- **Permissions**: `submission.read` / `submission.manage` (Admin + Editor). Author and Viewer get neither — a section-scoped writer has no reason to read every visitor's message. Exports and erasures are audit-logged.
- **Notification** is an integration concern: `form.submitted` on the existing HMAC-signed, SSRF-guarded webhook pipe. Paperboy has **no mail transport** (2FA is TOTP; email is only an identifier), so don't add one casually — if you ever do, `From:` must be our own authenticated domain with the submitter in `Reply-To`, and every header-bound value stripped of CR/LF at one chokepoint.
- **Deliberately not built** (see FORMS_PLAN.md §9): file uploads, conditional logic, multi-step, payments, autoresponders, a bespoke drag-drop designer.

## AI (the copy desk)
- One provider seam in `packages/shared` (`chat()` + `postAnthropicMessages`/`postOpenAiChat`), two dialects: **Anthropic** (Messages API) or any **OpenAI-compatible** Chat Completions endpoint (OpenAI, OpenRouter, Groq, Ollama…; `max_tokens` auto-retries as `max_completion_tokens`). Config (provider/key/model/baseUrl) + the agentReview gate are instance-global (Settings → AI); `resolveAiRuntimeConfig` (packages/db) is the ONE resolver the API and MCP share. **Key/provider/baseUrl resolve as a UNIT from one source (DB unit wins, else env), and a key is bound to the provider it was saved under** — switching provider clears the old key; env keys are vendor-bound (`ANTHROPIC_API_KEY`→anthropic, `OPENAI_API_KEY`+`OPENAI_BASE_URL`→openai, `AI_PROVIDER` picks when both are set). This is a security rule, not a convenience: an admin-set baseUrl must never receive a key entered for another vendor. `POST /manage/site/ai/test` does a REAL model roundtrip (key presence can't catch a wrong baseUrl/model). Surfaces: the admin copy desk (improve/rewrite/draft-about-a-topic/variants), translate (incl. richtext), vision alt text (`POST /ai/alt-text` sends the actual image bytes, site-partitioned), schema.org field suggestions, the "Build from brief" agent (provider-neutral tool loop in `apps/api/src/agent.ts`), MCP `ai_assist` (resolves the CMS-stored config, not just env).
- **No key → model-requiring tasks REFUSE** with a self-teaching `AiUnavailableError` — never echo the input dressed up as a result (rule #1 below; the old improve fallback did exactly that). Only meta_title/meta_description/summarize keep truncation fallbacks, labeled `basic`. The admin disables model-requiring entry points with an honest hint when no key is set.

## The frontend starter (separate repo)
`hybriden/paperboy-astro-starter` is the Astro frontend users are meant to build
on: it renders every built-in content type, and its `docker-compose.demo.yml`
pulls the images below to bring up **CMS + admin + site + demo content** from one
clone. Its `scripts/demo-content.mjs` builds a whole demo site through the
Management API — a useful worked example, and the thing to update when a built-in
type's shape changes. Two contracts it depends on: the admin frames previews as
`{previewBaseUrl}/{locale}{urlPath}` (so a frontend must accept a locale prefix),
and the CMS's generated `sitemap.xml`/`llms.txt` use that same
`/{locale}{urlPath}` scheme — a frontend that serves unprefixed paths must build
those two itself from `GET /delivery/pages` rather than proxying them.

## Published container images
`ghcr.io/hybriden/paperboy-app` (api · init · web · mcp) and
`ghcr.io/hybriden/paperboy-admin` (the SPA behind nginx) are built and pushed by
`.github/workflows/release-images.yml` on every push to main (`latest` + `sha-…`)
and on `v*` tags (semver). Both come from the one `Dockerfile` (targets `app`,
`admin`). They exist so running Paperboy does not require building it: the Astro
starter's `docker-compose.demo.yml` pulls them to bring up CMS + admin + site from
a single clone. Compose in THIS repo still BUILDS locally — that is correct for
development; don't switch it to pulling. The admin image is built with an EMPTY
`VITE_WEB_URL` on purpose: a published image must not carry one deployment's
frontend origin, and at runtime the admin reads the site's preview URL from the
API instead. **GHCR packages start private** — a new package needs its visibility
set to public once, or anonymous `docker pull` 401s.

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
   **The chokepoint reaches the WHOLE document, not just its top level.** `coerceData` takes a `BlockTypeResolver` and recurses into content-area `inline` block data (depth-capped), because it previously stopped at the first level: a block's `richtext` field kept raw Markdown — persisted, 200 OK, rendered blank — while the identical top-level field was correctly parsed. Pinned by `shared-coerce-blocks.test.ts` + `inline-block-coercion.test.ts`. **Still open:** strict *validation* of `inline` against the block's own schema (and rejecting an unknown `blockType`) is not implemented — `dataSchemaFor` still stops at the wrapper.
4. **Offer flat single-string params for long content** (`set_field`). Long strings nested inside record params (`data`) get mangled to `{}` by some clients' tool-call JSON repair — a flat top-level string survives. Steer to it in tool descriptions and in the relevant error messages.
5. **Safe defaults over correct-but-sharp semantics.** MCP `update_content` merges by default (a full replace silently drops required fields and bricks the next publish). Pages auto-slug from their name (an agent that forgets the slug otherwise creates unreachable content).
6. **Every failed agent run must leave a trail.** MCP tool errors log to stdout WITH truncated args (`docker logs`); every MCP write audit-logs like the API routes (`ip='mcp'`). Two incidents were undiagnosable because errors only travelled in-band and the client swallowed them.
7. **Annotate the schema for agents.** `get_content_type` returns `valueFormat` + `valueExample` per field — the contract is discoverable, not tribal knowledge.

## ⚖️ Bugfix law: failing test first
Every bugfix STARTS with a test that reproduces the exact reported failure — same flow, same surface (API/MCP), same inputs; not a lookalike. Run it and confirm it FAILS on the unfixed code: that red run is the proof you understood the issue and are patching the right place. Only then implement, and the same test must go green in the same change. No repro, no fix — no guesswork.

## Testing
- API: `pnpm --filter @paperboy/api test` (Vitest + a real Postgres test DB; isolated).
- **Coverage is measured AND enforced.** `pnpm test:coverage` runs the API suite with v8
  coverage over `apps/api/src` + `packages/db/src` + `packages/shared/src` (the suite drives
  real HTTP against a real Postgres, so it exercises all three — `allowExternal: true` is what
  lets the two out-of-root packages be counted). CI runs this variant, so the thresholds in
  `apps/api/vitest.config.ts` gate the build. Baseline 2026-07-28: **93.3% lines/statements,
  92.9% functions, 82.9% branches**; thresholds sit just under it. **Ratchet only** — raise them
  as coverage rises, never lower them to make a red run go green.
- CI also runs the suites that used to be manual-only: `packages/client` and
  `packages/preview` (both PUBLISHED to npm) and `apps/web`. `prepublishOnly` runs the
  package's own tests before either one can ship.
- **Contract-freeze layers** (all in `apps/api/test/`): `shared-*.test.ts` are pure unit/property tests of packages/shared (no DB — richtext sanitizer fixpoint, coercion matrix); `delivery-contract` + `openapi-snapshot` pin delivered JSON shapes and the API surface as snapshots — a failing snapshot means you changed a PUBLIC CONTRACT: review the diff and update the snapshot deliberately in the same commit, never blind `--update`; `mcp-parity` spawns the real stdio MCP server and locks the tool surface, write parity, and self-teaching error shapes.
- e2e: `pnpm --filter @paperboy/admin test:e2e` (Playwright + axe). Run against the live deploy with `ADMIN_URL=https://<host>` (needed because `COOKIE_SECURE` breaks http login). Don't run the full data-mutating suite against a live instance you care about.
- Always typecheck before deploying: `pnpm -r typecheck`.
- Lint: `pnpm lint` runs **oxlint `--type-aware`** (the type-aware pass needs the `oxlint-tsgolint` dev dep — it's in the lockfile, so `pnpm install --frozen-lockfile` covers CI). Every rule is **error** — no `warn`/`off` downgrades and no per-section exemptions (deliberately, so findings get fixed, not muted). This covers the whole repo: type-aware async-correctness (`no-floating-promises`, `await-thenable`) AND a11y (`control-has-associated-label`, `no-autofocus`, etc.). Conventions when fixing: floating promises get a `void` prefix (don't make handlers async); `unknown` content values stringified via a local `scalarToString`/`asText`/`rtScalar` helper (objects → `""`, never `"[object Object]"`); `autoFocus` is replaced by a `useRef` + mount `useEffect` focus (a11y-clean, behaviour-preserved). The ONE disabled rule is **`jsx-a11y/prefer-tag-over-role`** — it's stylistic ("prefer the native tag"), not an a11y defect, and it fights legitimate custom ARIA widgets (e.g. the icon-picker is a `listbox` of `option` buttons that can't be a native `<select>`); disabling it keeps the correct ARIA roles instead of stripping them. Note oxlint has `exhaustive-deps` but NOT `rules-of-hooks`, so the admin adds a tiny scoped ESLint pass for that ONE rule (`apps/admin/eslint.config.js` + its `lint` script, which root `pnpm lint` chains after oxlint). It runs `react-hooks/rules-of-hooks` only — parser-only, no overlap with oxlint — and reports nothing else (existing `eslint-disable` directives target rules oxlint owns, so the unused-directive report is off).

## Code Quality Rules

Before writing anything, walk this ladder top-down and STOP at the first rung that applies. This IS the law:

1. **Does this need to exist?** → no: skip it (YAGNI)
2. **Stdlib does it?** → use it
3. **Native platform feature?** → use it
4. **Installed dependency?** → use it
5. **One line?** → one line
6. **Only then:** the minimum that works

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
