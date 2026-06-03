# Multisite migration plan (DRAFT — paused, pending decisions)

> Status: **planning, not started.** Goal: evolve Paperboy from single-site to
> multisite (multiple distinct sites/brands in one instance) **without losing any
> existing data**. Everything that exists today moves into a "Default site" via a
> forward-only, additive migration. No truncate, no reseed.
>
> Branch context when written: `feat/mobile-edit-mode`. Author: planning session with Claude.

---

## 1. Feasibility verdict

**Yes, doable and losslessly.** Paperboy already partitions content by *section*
(`content_item.sectionId`, gated by `user_scope` + `AccessContext`). Multisite is
essentially promoting a **`site`** to a first-class entity *above* sections,
scoping the right resources to it, and backfilling all current data into one site.

The hard part is correctness, not novelty: `site_id` must thread through the
**single authz chokepoint** (`loadAuthorized`) and the **single delivery read
chokepoint** so nothing leaks across sites. Both chokepoints already exist, which
is what makes this tractable.

---

## 2. Current architecture (factual map — so we don't re-investigate)

### Partitioning today
- **Section** is *not* an entity. It's `content_item.sectionId`, and where null the
  item is its own section: `section = item.sectionId ?? item.documentId`
  (`packages/db/src/scope.ts:46`).
- On create: child inherits `parent.sectionId ?? parent.documentId`; a top-level
  (parentId=null) item becomes its own section (`packages/db/src/content.ts:370-416`).
- **Authz chokepoint:** `loadAuthorized(db, ctx, documentId)` denies if
  `!ctx.siteWide && !ctx.sections.includes(section)` (`packages/db/src/scope.ts:33-53`).
  Every read/write in the query layer goes through it. Tree/list queries filter with
  the same predicate (`content.ts:227-250`).
- **AccessContext** = `{ userId, permissions, siteWide, sections[] }`
  (`scope.ts:12-17`); built in `getAccessContext` (`auth-store.ts:224-237`).
  Admin/Editor/Viewer are `siteWide`; Author is section-scoped.

### Content tree / roots / slugs
- Multiple roots allowed (no single-root constraint). Seed creates 3 roots
  (`seed.ts:138-173`).
- "Start page" is a global setting (`siteSetting` key `startPage`,
  `packages/db/src/site.ts`).
- **Slug uniqueness is per-parent + locale**, not global (`assertSlugUnique`,
  `content.ts:342-366`). Path resolution walks the tree level by level
  (`delivery.ts:311-356`).

### Delivery entry point
- `resolvePerspective` reads a Bearer/`x-api-key`, `verifyDeliveryKey` →
  `public|preview|null` → perspective `published|preview`
  (`apps/api/src/routes/delivery.ts:18-33`; `auth-store.ts`).
- **No host/site selection today.** All keys see all content (filtered only by
  perspective). Globals fetched by type name via `deliveryGlobal`
  (`delivery.ts:378`); `/globals/:type`, `/content/by-path`, `/content/by-slug`,
  `/start`.

### What's global vs scoped today
| Resource | Table | Scope today |
|---|---|---|
| Content types | `content_type` | global (instance) |
| Locales | `locale` | global |
| Delivery keys | `delivery_key` | global (public/preview, no site) |
| Assets/media | `asset` | global library (no scoping) |
| Users / roles | `users`, `user_role` | global |
| User scopes | `user_scope` | rows: (user_id, section_id) |
| Site settings | `siteSetting` | global key/value (holds `startPage`) |
| Webhooks | `webhook` | global |

### Migrations
- Forward-only numbered SQL in `packages/db/migrations/`. Latest:
  `0004_mcp_token.sql`. **Next: `0005_sites.sql`.** Tracked in `_migrations`,
  idempotent, run on api boot. Separate from `seed` (which truncates — never run
  seed for this).

---

## 3. OPEN DECISIONS (must answer before building)

These fork the architecture. Recommended defaults in **bold**.

### D1 — Site routing at delivery time
- **(rec) Per-site delivery keys** — each public/preview key belongs to one site;
  the key already identifies the site. Smallest change; each frontend uses its
  site's key. → `verifyDeliveryKey` returns `{ type, siteId }`.
- Hostname → site mapping (domains table + Host header).
- Both keys + hostname.
- Explicit site id/slug in the delivery URL.

**DECISION: _____ (undecided)**

### D2 — Shared vs per-site resources (multi-select; unchecked = per-site copy)
- **(rec) Content types shared** — one content model across sites.
- **(rec) Locales shared** — shared locale set + fallback; per-site *default* locale.
- Media library: **shared pool** vs per-site (isolation / no cross-brand leakage).
- **(rec) Users shared** — one login, roles/scope granted per site.

**DECISION: shared = _____ ; per-site = _____ (undecided)**

### D3 — Migration mapping of existing content
- **(rec) One "Default site"** — all current content/keys/settings/sections →
  one site; fully lossless; split later in UI.
- One site per existing top-level section (promote Home, Author Zone, … to sites).

**DECISION: _____ (undecided)**

---

## 4. Proposed architecture (assuming the recommended defaults)

### New `site` entity
```
site(
  id            text primary key,      -- nanoid
  slug          text unique not null,  -- "default", "brand-a"
  name          text not null,
  default_locale text not null,        -- FK-ish to locale.code
  active        boolean not null default true,
  created_at    timestamptz not null default now()
)
-- optional, if D1 includes hostname routing:
site_domain(id, site_id, host unique)
```

### Scoping changes
- `content_item.site_id` (NOT NULL after backfill) — the canonical partition.
  Sections stay *within* a site. Child inherits parent's `site_id` (and section).
- `delivery_key.site_id` (if D1 = per-site keys).
- `site_setting` gains `site_id` (per-site `startPage`, preview base URL) — or a
  composite key (site_id, key).
- `user_scope` → `(user_id, site_id, section_id)`; add a per-site role concept
  (see RBAC below). `AccessContext` gains `siteId` + per-site `siteWide`.
- `asset.site_id` only if D2 = per-site media.
- `content_type` / `locale` gain `site_id` only if D2 = per-site (NOT recommended).

### AccessContext (management)
Add the **active site** to context: `{ userId, permissions, siteId, siteWide,
sections[] }`. `siteWide` becomes per-site (site-admin) plus a new cross-site
**super-admin**. `loadAuthorized` adds `item.site_id === ctx.siteId` to the
deny-by-default check. Active site is chosen via the admin's site switcher
(stored per-session or a header like `x-paperboy-site`).

### Delivery
- Resolve `siteId` per D1 (key → site, and/or host → site).
- Every delivery lookup (`deliveryGetByPath`, `deliveryGetBySlug`,
  `deliveryGlobal`, `/start`, list) filters `content_item.site_id = siteId`.
- The no-leak chokepoint also enforces `site_id` (don't add bypassing read paths).

### Slugs / roots
- Roots become **per-site** (root = parentId null AND site_id = S).
- `assertSlugUnique` and `deliveryGetByPath` scoped by `site_id` so two sites can
  each own `/about`. (Slug uniqueness predicate adds `site_id = S`.)

---

## 5. Lossless migration (`0005_sites.sql`)

Forward-only, additive, idempotent. **Never** run `seed`/`init`.

1. `CREATE TABLE site (...)`.
2. `INSERT INTO site (id, slug, name, default_locale, active) VALUES
   ('<nanoid>', 'default', 'Default site', '<current default locale>', true)`.
   (Default locale = current `locale.is_default` code.)
3. For each scoped table: `ALTER TABLE … ADD COLUMN site_id text` (nullable),
   `UPDATE … SET site_id = '<default site id>'`, then `ALTER … SET NOT NULL` +
   FK + index. Tables: `content_item`, `delivery_key`, `site_setting`,
   `user_scope` (+ `asset` if D2 per-site).
4. Migrate `siteSetting.startPage` → per-site setting on the default site.
5. (If hostname routing) seed a `site_domain` row for the current host.

All existing `documentId`s, versions, slugs, keys, users preserved.
Drizzle schema (`packages/db/src/schema.ts`) updated to match; types flow from there.

---

## 6. Phased implementation

- **Phase 0 — Decisions.** Answer D1–D3 above.
- **Phase 1 — Schema + migration.** `0005_sites.sql`, `site` table, backfill,
  Drizzle schema, `getDefaultSite`/`listSites`/`createSite` query fns. Verify on a
  DB copy first.
- **Phase 2 — Query layer.** Add `siteId` to `AccessContext`; thread through
  `loadAuthorized`, `getTree`, `listBlocks`, `create`, `assertSlugUnique`, etc.
  Per-site `user_scope`. Unit-level checks.
- **Phase 3 — Management API + admin UI.** Site CRUD endpoints
  (`/manage/sites`, super-admin gated); **site switcher** in the admin shell
  (`Shell.tsx`) that sets the active site; scope all management panels to it;
  apply D2 for content-types/locales/assets.
- **Phase 4 — Delivery.** Site resolution per D1 (`verifyDeliveryKey` →
  `{type, siteId}` and/or host map); scope every delivery read by `site_id`;
  per-site start page.
- **Phase 5 — RBAC.** Per-site roles/scopes + cross-site super-admin; seed default
  site memberships for existing users.
- **Phase 6 — Tests + docs.** New `apps/api/test/multisite.test.ts` (isolation:
  site A can't read/write site B; delivery key of A never returns B's content;
  slug `/about` independent per site). Update `CLAUDE.md` + `STACK.md`.

Each phase is independently deployable (`docker compose build api admin` then
`docker compose up -d --no-deps --force-recreate api admin` — **never** plain
`up`, which reseeds). Migrations run on api boot.

---

## 7. Risks / watch-list
- **Authz leak:** `site_id` must be in *every* chokepoint predicate
  (`loadAuthorized` + delivery). Deny-by-default. This is the #1 correctness risk.
- **Cross-site references:** `reference`/`contentArea` fields could point across
  sites — block at validation (a doc may only reference content in its own site).
- **Slug uniqueness** moves from per-parent to per-parent-within-site.
- **Assets shared vs scoped** (D2) changes whether asset URLs/listing leak across
  brands.
- **Delivery no-leak chokepoint** must also filter site — don't add read paths
  that bypass it.
- **Existing sessions/keys** keep working (they map to the default site).
- **Deploy safety:** additive migration only; never `seed`/`init`;
  `docker compose run --rm init` would WIPE data.

---

## 8. Verification plan
- Run `0005` against a **copy** of prod DB; confirm row counts unchanged and every
  scoped row got the default `site_id`.
- `pnpm -r typecheck` + `pnpm --filter @paperboy/api test` (incl. new multisite
  isolation tests) before each deploy.
- Headless smoke (as used for the rail fix): create a 2nd site, confirm content,
  keys, and `/about` are isolated.

---

## 9. Quick-resume checklist
1. Fill in D1, D2, D3 above.
2. Start Phase 1 (`0005_sites.sql` + Drizzle schema + default-site backfill).
3. Test migration on a DB copy before touching the live stack.
