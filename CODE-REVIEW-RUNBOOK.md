# Code Review Runbook — Paperboy

**Generated:** 2026-06-25 · **Branch:** `main` (HEAD `99111c0`) · **Scope:** full monorepo (~36k LOC)

## Method

Multi-agent review. 11 parallel finder lenses (security / correctness / contract / quality) swept the
monorepo against the binding standards in `CLAUDE.md`. Every raw finding was then handed to an
**independent, skeptical verifier** that re-opened the actual code and rendered confirmed / rejected /
needs-info (default-reject if unprovable). A completeness critic then proposed 4 follow-up lenses
(webhook SSRF, scheduled-publish ticker, trust-proxy IP spoofing, upload/image pipeline), which ran through
the same find→verify pipeline. **44 agents total.**

Severities below are the **verifier-adjusted** values (several finders over- or under-rated; the verifier
re-calibrated against real impact). Where a finder's original severity differed it's shown as `orig→adj`.

> ⚖️ **Before fixing anything, honour the bugfix law (`CLAUDE.md`):** every fix STARTS with a failing test
> that reproduces the exact reported failure on the same surface (API/MCP/admin), confirmed red on the
> unfixed code, then made green in the same change. Each item below names the repro to write.

## Summary

Three sweeps run, then the completeness critic reported **convergence** (diminishing returns). **Sweep 1** =
11 lenses + 4 follow-ups (44 agents). **Sweep 2** = 8 fresh lenses + 3 follow-ups (38 agents). **Sweep 3** =
8 remaining-corner lenses + 1 follow-up (28 agents). Each deduped against all prior. **63 confirmed findings
total** (110 agents, ~5.2M tokens). The loop stopped here because sweep 3 returned only 2 new highs against
a much larger exclusion list and the critic judged the material surface covered.

| | Sweep 1 | Sweep 2 | Sweep 3 | Total |
|---|---------|---------|---------|-------|
| 🔴 High | 4 | 4 | 2 | 10 |
| 🟠 Medium | 12 | 12 | 8 | 32 |
| 🟡 Low | 9 | 5 | 7 | 21 |
| **Total** | **25** | **21** | **17** | **63** |

Sweep 1 = H1–H4 / M1–M12 / L1–L9. Sweep 2 = S2-H1…S2-L5. Sweep 3 = S3-H1…S3-L7. Each in its own section.

> 🔑 **Headline from sweep 2:** a stock `docker compose up` with no host env vars boots the **production**
> stack on (a) the source-committed `prod-*-please-override` `SESSION_SECRET`/`CSRF_SECRET` — forgeable
> session cookies (**S2-H2**) — and (b) a `sha256("")` TOTP-secret encryption key, because `MFA_SECRET:
> ${MFA_SECRET:-}` is `""` and `??` doesn't fall through on empty string (**S2-H3**). The `env.ts`
> fail-fast guard only knows the *dev* defaults, so it waves both through. Fix these two first.

| Sev | Count | Items |
|-----|-------|-------|
| 🔴 High | 4 | H1 delivery filter leak · H2 MCP audit gap · H3 webhook SSRF · H4 2FA no lockout |
| 🟠 Medium | 12 | M1–M12 |
| 🟡 Low | 9 | L1–L9 |

**Clean lenses (no confirmed findings):** multisite partition enforcement, RBAC / object-level authz.
Both were probed hard (the RBAC agent ran 44 tool calls) and came back empty — the deny-by-default
chokepoints in `packages/db` held up. The documented multisite gaps (global roles, cross-site refs not
blocked at write) were **not** found broader than `CLAUDE.md` already states.

**Cross-cutting theme:** the most common defect class is **inconsistency** — a hardened path exists
(MCP content audit, the password-login lockout, the promote-loop try/catch, the stock SSRF allowlist,
sibling search bounds) but a sibling path skips it. These are low-risk, high-confidence fixes.

---

## 🔴 High

### H1 — Delivery list filter is a private-field inference oracle on the public key
- **Category:** security · **Lens:** delivery-no-leak · **Severity:** high
- **Files:** `packages/db/src/delivery.ts:761-771`, `apps/api/src/routes/delivery.ts:102-124`
- **CLAUDE.md:** *"Private fields never reach delivery output. Don't add read paths that bypass it."*

`GET /delivery/content` turns any `data.<field>=value` query param into an equality filter. The route regex
only constrains `sort`, never the filter keys, and `deliveryList` runs the filter against the **raw,
unsanitized version row** (`row.data`) — sanitize only strips fields at *output* time. So a public-key
consumer can issue `?type=ArticlePage&data.seoNotes=<guess>` (a `delivery:"private"` seeded field) and learn
from hit/no-hit (items / total / `X-Total-Count`) whether a private field equals the guess. The response body
stays clean, so the existing contract test (which only walks output strings) misses it.

- **Fix:** Gate filter keys to public fields — resolve the content-type def and drop/400 any filter field
  whose `FieldDef.delivery !== "public"` (keep name/slug). For the parentId-only case where type is omitted,
  restrict to name/slug or skip unknown fields per-item.
- **Repro:** contract test — `data.seoNotes=<seeded value>` returns no inference signal under the public key.

### H2 — MCP platform/admin writes leave no audit trail (rule #6); equivalent API routes all audit
- **Category:** contract · **Lens:** agent-api-coercion · **Severity:** high
- **Files:** `apps/mcp/src/server.ts:375-468`, `apps/api/src/routes/manage.ts` (audits at :158/167/176/479/610/633/642/745/941/950/982/991/1000), `apps/api/test/mcp-parity.test.ts:167-171`
- **CLAUDE.md:** Agent-API rule #6 — *"every MCP write audit-logs like the API routes (ip='mcp')."*

`mcpAudit` (server.ts:138) is called by the content tools but **13 platform/admin write tools return with no
audit call**: `create_content_type`, `update_content_type`, `update_asset_alt`, `delete_asset`,
`set_start_page`, `create_user`, `update_user`, `delete_user`, `create_delivery_key`, `rename_delivery_key`,
`revoke_delivery_key`, `create_webhook`, `delete_webhook`. The db-layer functions don't self-audit (auditing
is the caller's job; the API routes do it for every one of these). So an agent deleting an asset, minting/
revoking a delivery key (secret returned once), or creating/deleting users/webhooks via MCP writes **no audit
row** — the exact undiagnosable case rule #6 exists to prevent. The parity test only asserts a `content.create`
row, so the gap is unguarded.

- **Fix:** Add `mcpAudit(...)` to each tool, mirroring the API route's action string + detail.
- **Repro:** strengthen `mcp-parity.test.ts` to assert an `ip='mcp'` audit row for a non-content write
  (e.g. `asset.delete` or `user.create`).

### H3 — SSRF: webhook URL validated for scheme only — loopback / cloud-metadata / RFC1918 accepted
- **Category:** security · **Lens:** webhook-ssrf-egress · **Severity:** high
- **Files:** `packages/db/src/webhooks.ts:55-60` (create), `:99-108` (dispatch), `apps/api/src/routes/manage.ts:938`
- **CLAUDE.md:** deny-by-default egress posture; an existing SSRF allowlist already lives in `packages/shared/src/stock.ts:54`

`createWebhook` accepts any `http(s)` URL with no host/IP check and stores it verbatim; on every publish/
unpublish `dispatchWebhooks` does `fetch(h.url, {method:'POST', ...})` with an **HMAC signature header** and
no egress restriction. A `webhook.manage` holder (default Admin — and roles are global per the documented
multisite gap, so Admin-in-any-site is instance-wide) can drive signed server-side POSTs to
`http://127.0.0.1:<port>`, `http://169.254.169.254/latest/meta-data/` (cloud IMDS), or any RFC1918 host.
Persisted delivery status/error gives a blind port/host-scan oracle. The codebase already solves exactly this
for stock images — the webhook path just never adopted it.

- **Fix:** deny-by-default egress guard. Resolve host (`dns.lookup {all:true}`) and reject loopback,
  link-local (incl. 169.254.169.254), RFC1918, unique-local, 0.0.0.0. Enforce at **both** create time and
  **dispatch time** (connect-time is the real boundary — guards DNS rebinding). Optional
  `PAPERBOY_WEBHOOK_ALLOW_HOSTS` env for deployments that need internal targets, default deny.
- **Repro:** create-webhook test asserting `http://169.254.169.254/` and `http://127.0.0.1/` are rejected.

### H4 — 2FA login has no per-account lockout — sole-factor TOTP / backup-code brute force
- **Category:** security · **Lenses:** auth-session-csrf **and** trustproxy-ip-spoofing (independently surfaced twice) · **Severity:** high
- **Files:** `apps/api/src/routes/auth.ts:91-103`, `packages/db/src/auth-store.ts:337-350` (vs `:99-108`)
- **CLAUDE.md:** Auth model — *"2FA: passwordless email + TOTP … + rate-limit/lockout."*

For a 2FA account the login is **passwordless**: `/login` returns an `mfaToken` to anyone who knows the email,
so the TOTP code is the **sole** authentication factor. The account lockout (`MAX_FAILED=5`/`LOCK_MINUTES=15`)
lives **only** in `verifyLogin` (password path); `verifySecondFactor` never reads/increments
`failedAttempts`/`lockedUntil`. The only guard on the factor is the **per-IP** rate limit on `/login/mfa`,
and the `mfaToken` is freely re-mintable and reusable for 5 min — so a distributed/multi-IP attacker faces
no per-account ceiling. (See H-note: the per-IP limit is also IP-spoofable via M9.) Backup codes (~40 bits)
ride the same unguarded path.

> Two lenses reported this independently (corroboration). The auth lens rated medium, the trust-proxy lens
> high; kept at **high** because it's a brute-force vector on the only factor guarding passwordless accounts.

- **Fix:** add a per-account failed-2FA counter + lockout in `verifySecondFactor` mirroring `verifyLogin`,
  keyed on `userId` (IP-independent so IP rotation can't bypass). Optionally key the limiter on `mfaToken`/`userId`.
- **Repro:** mint an `mfaToken`, submit N wrong codes from rotating spoofed IPs, assert the account locks.

---

## 🟠 Medium

### M1 — Delivery list `sort` by a private field reorders public output (weaker inference oracle)
- security · delivery-no-leak · `packages/db/src/delivery.ts:773-788`, `apps/api/src/routes/delivery.ts:102-105`
- `keyOf` sorts on raw `row.data[field]` with no public-field gate. Same root cause as **H1** (the verifier
  notes there is **no** "filter fix" to mirror — H1 is ungated too). Fix both paths together: validate
  `data.<field>` sort/filter keys against `FieldDef.delivery==="public"`. Weaker than H1 (needs to know the
  private field name; signal is ordinal), hence medium.

### M2 — Delivery full-text search indexes private field text — match oracle under public key
- security · delivery-no-leak · `packages/db/src/delivery.ts:831-845`, `packages/db/migrations/0007_delivery_search.sql:3-4`
- `deliverySearch` builds its tsvector from `coalesce(v.data::text,'')` — the whole blob, including
  `delivery:"private"` fields. A public search for a term that exists only in a private field (e.g. seeded
  `internalNote` "INTERNAL: ops contact…") still matches, confirming presence; `ts_rank` ordering amplifies.
  Output is sanitized, but the hit/no-hit signal leaks.
- **Fix:** build/index a `search_text` derived column populated at write time from public fields + name only.
  **Repro:** public search for a private-only term returns zero hits.

### M3 — Seed guard checks only `content_item`, but TRUNCATE wipes 16 tables (users, keys, sites, assets…)
- deploy · db-migrations-deploy · `packages/db/src/seed.ts:155-157` (TRUNCATE), `:321-337` (guard)
- The destructive-reseed guard decides "DB already holds content" from `content_item` count alone, but
  `seed()` truncates users (hashed passwords), `delivery_key`, `site`, `site_setting`, `webhook`, `asset`,
  `locale`, … A configured-but-content-empty instance (pages emptied / fresh-but-set-up) reads as `items=0`
  and is silently wiped — the same data-loss class the guard was added for (2026-06-06 incident).
- **Fix:** count high-value tables too — treat as populated if `content_item` **OR** `users` **OR**
  `delivery_key` is non-empty (one extra count). Preserves the `FORCE_SEED=1` and fresh-DB paths.

### M4 — `autoFocus` in `Tree.tsx` CreateDialog breaks the no-autofocus lint gate (orig high→med)
- deploy · admin-react · `apps/admin/src/components/Tree.tsx:706`
- `.oxlintrc.json:20` sets `jsx-a11y/no-autofocus: error`, every rule is error, and `pnpm lint` is a documented
  pre-deploy gate — so this single line **fails CI**. It's the only `autoFocus` left in `apps/admin/src`;
  every sibling uses the `useRef`+mount-`useEffect` pattern (e.g. `AssetPane.tsx:150-151`). Trivial fix:
  adopt the ref+effect pattern. ⚠️ *Quick win — likely already red on `pnpm lint`.*

### M5 — `@paperboycms/preview` ships extensionless relative ESM imports (orig critical→med)
- deploy · published-packages · `packages/preview/src/index.ts`, `bridge.ts`; `tsconfig.base.json` (module ESNext / moduleResolution Bundler)
- Built dist emits verbatim `export * from "./protocol"` / `import … from "./protocol"` (no `.js`). The package
  is `type:module` with `import:"./dist/index.js"`; Node native ESM **requires** extensions → `import` of the
  main entry throws `ERR_MODULE_NOT_FOUND` (verifier reproduced it). The `./protocol` subpath is self-contained
  so the admin never tripped it, and bundler/Next consumers are unaffected — hence med, not critical. But the
  `.d.ts` also re-exports extensionless → `TS2307` for any `node16`/`nodenext` consumer.
- **Fix:** add explicit `.js` in source (`from "./protocol.js"`); add a `nodenext` typecheck guard for published
  packages; bump `@paperboycms/preview` (this is already-published broken output).

### M6 — In-product "Build from brief" agent omits `merge:true` → `update_content` replaces the whole field map
- correctness · code-quality · `apps/api/src/agent.ts:125-131`, `packages/db/src/content.ts:1058`, `packages/shared/src/api.ts:147` (vs MCP `apps/mcp/src/server.ts:272`)
- `updateContent` treats `merge` as a sharp default (undefined ⇒ replace). MCP deliberately passes
  `merge: merge ?? true` per rule #5, but the in-product agent's `update_content` tool omits `merge` entirely,
  so iterative edits / per-field validation-recovery wipe prior fields — the exact failure rule #5 was written
  to prevent. The tool description never mentions merge semantics, so the model can't compensate.
- **Fix:** default `merge` to true centrally (`api.ts` `.default(true)`) and have the admin full-save pass
  `merge:false` explicitly (re-baseline the contract snapshot deliberately). **Repro:** two sequential agent
  `update_content` calls; assert the first call's fields survive.

### M7 — Expire loop has no per-row try/catch — one failing row strands the rest + loses the unpublish webhook
- correctness · scheduled-publish-ticker · `packages/db/src/content.ts:1706-1723`
- The promote loop wraps each row in try/catch; the expire loop doesn't. It demotes (`isCurrentPublished=false`)
  at :1707 **before** the unguarded `computePath`/`dispatchWebhooks`. A throw (transient DB error) after the
  demote aborts the loop; the demoted row no longer matches the `isCurrentPublished=true` re-scan filter, so its
  `content.unpublished` event is **lost permanently**. (Verifier trimmed one claim: `dispatchWebhooks` catches
  per-subscriber fetch errors itself, so the throw source is DB ops, not a slow subscriber.)
- **Fix:** mirror the promote loop's per-row try/catch (increment `failed` + audit on error); compute `urlPath`
  before the demoting UPDATE.

### M8 — Image transform runs `sharp` with no pixel/concurrency cap — decompression-bomb DoS (orig high→med)
- security · upload-image-pipeline-dos · `apps/api/src/routes/media.ts:98-104`, `:60`; upload at `manage.ts:441-457`
- Public transform route decodes attacker-influenced originals via `sharp(originalPath,{failOn:'none'})` with
  no `limitInputPixels` and no `sharp.concurrency` (grep: absent repo-wide → library defaults). Upload only
  checks magic bytes + 5 MB. Varying `?w/format/q` defeats the variant cache, forcing fresh full decodes.
  Med not high: requires a privileged uploader to land the bomb, and sharp's default ~268 Mpix cap already
  rejects the largest bombs (caught at `:104`, degrades to original).
- **Fix:** `sharp(path,{failOn:'none', limitInputPixels: 24_000_000})`; `sharp.concurrency(2)` at boot; probe
  `metadata()` at upload and reject oversized originals.

### M9 — Unconditional `trustProxy:true` lets clients spoof `req.ip` → IP rate-limit bypass + forged audit IPs (orig high→med)
- security · trustproxy-ip-spoofing · `apps/api/src/app.ts:37`, rate-limit at `:77-82`/`auth.ts:68,93`/`manage.ts:433,885,894`; `docker-compose.yml:74-75`; `apps/admin/nginx.conf:32`
- `trustProxy:true` is trust-all-hops with no `keyGenerator` override anywhere, so `req.ip` comes from
  client-supplied `X-Forwarded-For`. nginx **appends** XFF, and the api binds `8091:8091` directly to the host
  (strongest vector: spoof with one header, no proxy). ⚠️ **Verifier correction:** this does **NOT** defeat
  login lockout — that's keyed on the user row, not IP (so H4's *per-account* fix is the real lockout).
  Genuine impact: IP rate-limit bypass + forgeable audit IPs.
- **Fix:** set `trustProxy` to a fixed hop count / trusted CIDR (make it env-configurable); derive IP from
  `CF-Connecting-IP`; drop the public `8091:8091` binding; ensure the edge overwrites (not appends) XFF.

### M10 — PDFs served inline (`application/pdf`, no `Content-Disposition`) — stored-XSS via same-origin media
- security · upload-image-pipeline-dos · `apps/api/src/routes/media.ts:33,45-51,84-85`, `apps/api/src/app.ts:66-76`
- `sniffUpload` admits `%PDF-`; `serveFile` and the static fallback set only `nosniff` — no
  `Content-Disposition: attachment` anywhere (grep: only tests). `nosniff` stops MIME-confusion but not inline
  rendering of a genuine PDF (an active-content format). Since the admin's nginx proxies `/api/`, media is
  reachable same-origin → an editor opening a malicious PDF executes it in the trusted origin. Med: needs an
  authed uploader + victim, and modern browser PDF viewers disable embedded JS by default.
- **Fix:** send `Content-Disposition: attachment` for `application/pdf` in `serveFile` and the static
  `setHeaders`.

### M11 — `Welcome` calls `setCrumb` during render — render-phase update to ancestor `Shell` (orig med→low… kept med here)
> Verifier adjusted to **low** (benign console warning, crumb still clears, Object.is bail-out prevents loop).
> Listed for completeness; treat as L-tier in practice.
- correctness · admin-react · `apps/admin/src/components/views/EditView.tsx:160,181-182`
- `Welcome` calls `onClearCrumb()` (`() => setCrumb(null)`, Shell's setter) directly in render — React 19
  "Cannot update a component while rendering a different component". Every other view clears via `useEffect`.
- **Fix:** move into `useEffect(() => onClearCrumb(), [onClearCrumb])`.

### M12 — TOTP codes are replayable — no single-use enforcement of the consumed time-step
- security · auth · `packages/db/src/totp.ts:31-36`, `auth-store.ts:337-350`, `schema.ts:184-190`
- `verifyTotp` validates with `window:1` (~90s across 3 steps) but discards the matched delta; no
  `lastTotpStep`/`lastUsedAt` column. A valid code can be submitted repeatedly within its window. Backup codes
  are single-use; TOTP isn't. With passwordless email+TOTP, one intercepted live code grants a session.
- **Fix:** persist the last-accepted absolute step on the user row; reject steps `<=` last consumed.
  **Repro:** submit the same code twice, assert the second fails.

---

## 🟡 Low

> Verifier-confirmed but bounded. Most are consistency/hardening/documentation gaps. (M11 above also verified
> to low.)

- **L1 — `alt_text` via `/ai/assist` & MCP `ai_assist` generates alt text from the FILENAME**, labeled
  `provider:"anthropic"`. `packages/shared/src/ai.ts:69-70,197-208`, `apps/api/src/routes/ai.ts:43-58`,
  `apps/mcp/src/server.ts:475-477`. The dedicated vision route is correct; this legacy text path is still
  reachable with a key set and untested. **Fix:** reject `task==="alt_text"` in `aiAssist` with a self-teaching
  pointer to `POST /ai/alt-text` (or drop it from the assist enum).

- **L2 — Agent SSE route streams raw error messages**, bypassing the global 500 sanitizer.
  `apps/api/src/routes/ai.ts:173-176`. Verifier note: the scary "DB error leaks" claim is **not** reachable
  (DB/tool errors are caught one level down at `agent.ts:304-308`); only `callAnthropic`-level messages
  (`Anthropic ${status}`, `fetch failed`) reach it. Minor consistency gap. **Fix:** forward `err.message`
  only for `AppError` in the outer catch; log the rest.

- **L3 — Management content search `q`/`limit` unbounded** unlike sibling delivery/stock search.
  `apps/api/src/routes/manage.ts:540`. Not exploitable (db clamps), pure edge-validation inconsistency.
  **Fix:** `q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).optional()`.

- **L4 — `@paperboycms/client` README omits the render + SEO public surface** (`renderRichText`,
  `contentAreas`, `renderKind`, `pbAreaAttrs`, `fieldTypes`, `seo`/`DeliverySeo`). `packages/client/README.md`
  vs `src/index.ts:29-70,364-443`. Doc drift on a published surface (`CLAUDE.md`: keep README in sync).

- **L5 — Reference frontend emits `data-pb-shared`**, an attribute outside the preview `ATTR` contract and
  read by nobody. `apps/web/app/components/Renderer.tsx:124` vs `packages/preview/src/protocol.ts:20-29`.
  The "don't re-declare the `data-pb-*` surface" pattern. **Fix:** drop it, or add to `ATTR` + bump + have the
  bridge read it.

- **L6 — Scheduled-publish ticker has no single-instance guard** (orig high→low). `apps/api/src/app.ts:161-171`,
  `packages/db/src/content.ts`. Latent only: the project ships single-container and documents the assumption
  (the comment), and publish is partly backstopped by the `content_version_one_published` unique index; expire
  has no backstop. Would double-fire webhooks under >1 replica. **Fix (if ever scaling):**
  `pg_try_advisory_xact_lock(<const>)` around the tick (CLAUDE.md ladder rung 3), or `FOR UPDATE SKIP LOCKED`.

- **L7 — Promote/webhook failures in the ticker are swallowed with no audit row** (orig med→low), unlike the
  validation-failure branch which audits. `packages/db/src/content.ts:1690-1692` vs `:1668-1675`. Rule #6 is
  literally MCP-scoped, so applies by spirit; content stays a valid draft and self-heals next tick. **Fix:**
  capture the error and write a `content.schedule_failed`/`_error` audit row before `failed++`.

- **L8 — Uploaded filename stored & echoed verbatim**, no length/charset/control-char limit.
  `apps/api/src/routes/manage.ts:453`, `packages/shared/src/api.ts:81`, `packages/db/src/schema.ts:141`. Not
  path/RCE (served name is a server nanoid) and the shipped admin UI escapes via JSX, so no live XSS. **Fix:**
  cap `.max(255)` + strip control/separator chars at the write chokepoint.

- **L9 — (M11 re-tier)** `Welcome` render-phase `setCrumb` — see M11.

---

## Suggested order of work

1. **M4 (autoFocus)** — likely red on `pnpm lint` right now; one-line unblock.
2. **H1 + M1 + M2 together** — single root cause (delivery reads using raw `row.data` without a public-field
   gate across filter / sort / search). Fix the gate once, add the three oracle repro tests.
3. **H4 + M12** — the 2FA factor hardening (per-account lockout + TOTP single-use). Same file, same test setup.
4. **H3 (webhook SSRF)** — adopt the existing `stock.ts` allowlist pattern at create + dispatch.
5. **H2 (MCP audit gap)** — mechanical: add `mcpAudit` to 13 tools + strengthen `mcp-parity.test.ts`.
6. **M3 (seed guard)** — one extra count; cheap protection against the documented data-loss class.
7. **M6 (agent merge default), M8 (sharp limits), M10 (PDF disposition), M5 (preview ESM), M9 (trustProxy)** —
   independent, schedule as capacity allows.
8. **Lows** — batch as consistency/hardening cleanup.

# Sweep 2 — Additional Findings

Fresh lenses: session/CSRF lifecycle, Drizzle query correctness, richtext/coercion edge cases, secrets &
config hardening, delivery reference-graph DoS & cache bleed, unhandled async, client SDK correctness, a11y;
plus completeness follow-ups on trash/version lifecycle, write-invariant atomicity, and the web reference app.
All deduped against sweep 1. The **richtext-coercion-matrix** lens came back clean (XSS/prototype-pollution/
ReDoS not found in the sanitizer + coercion chokepoint). Dominant new theme: **secrets/config hardening** and
**write-invariant atomicity (TOCTOU)** — both areas sweep 1 didn't touch.

## 🔴 High (sweep 2)

### S2-H1 — User section scopes written with no `siteId` → Author scoping silently broken for any non-default site
- correctness · `packages/db/src/auth-store.ts:71-73,195-198` (write, no siteId) vs `:255-258` (read filters by active siteId); `schema.ts:206-217`
- **CLAUDE.md:** Multisite — *"Section scopes are already per-site"* (listed as working, not a known gap).
- `createUser` / `adminUpdateUser` insert `userScope` rows with only `{userId, sectionId}`, so the NOT NULL
  `DEFAULT 'site_default'` always applies. `getAccessContext` reads scopes filtered by the **active** site
  (`x-paperboy-site` header). For a section on a non-default site the two never match → `ctx.sections` is empty
  and deny-by-default hides all of that Author's content. Fails closed (over-denies, no leak). Passes seeded
  tests only because the lone scoped user is on the Default site. Migration 0012 widened `user_scope_uq` to
  `(user_id, site_id, section_id)`, proving the column is meant to be set per-assignment.
- **Fix:** resolve each section's `content_item.siteId` and write it into the scope insert (the active site is
  already on `req.accessCtx.siteId`). **Repro:** assign an Author to a non-default-site section, switch active
  site, assert `getAccessContext.sections` includes it.

### S2-H2 — Production secret guard misses the docker-compose `prod-*-please-override` defaults
- security · `apps/api/src/env.ts:43-54` vs `docker-compose.yml:53-54,143` (orig critical→high)
- **CLAUDE.md:** *"Refuse to boot a production server with dev defaults (fail fast)"* — the guard must fail closed.
- `INSECURE_DEFAULTS` lists only the two `dev-*` strings. Compose supplies *different* fallbacks
  (`SESSION_SECRET: ${SESSION_SECRET:-prod-session-secret-please-override-32+chars}`, same for CSRF), 40+ chars,
  not in the list → a `docker compose up` (compose hardcodes `NODE_ENV: production`) boots on source-committed
  signing secrets. Session secret signs cookies (`app.ts:59`); mcp shares it (`:143`). Anyone reading the repo
  can forge session cookies + CSRF tokens. High not critical only because it needs verbatim deploy with zero
  overrides (CLAUDE.md does warn to rotate).
- **Fix:** one shared forbidden-placeholder list across compose + `env.ts`, or match `/please-override|change-me/`;
  better, drop the env defaults and require the secrets in production.

### S2-H3 — TOTP-secret encryption key silently becomes `sha256("")` under the compose `MFA_SECRET` default
- security · `packages/db/src/totp.ts:13-16`, `docker-compose.yml:57,144` (orig critical→high)
- `encKey()` = `process.env.MFA_SECRET ?? SESSION_SECRET ?? "dev-mfa-…"`. Compose sets `MFA_SECRET: ${MFA_SECRET:-}`
  → the env var is the **empty string**, and `??` only falls through on null/undefined — so the AES-256-GCM key
  for TOTP secrets at rest is `sha256("")`, a public constant identical across every install. The compose
  comment claims it "falls back to SESSION_SECRET" — it never does. `MFA_SECRET` isn't in the `env.ts` schema,
  so no boot guard catches it. Anyone with read access to the `totp_secret` ciphertext decrypts every enrolled
  user's seed. High not critical: needs DB/column read access (TOTP gates browser login only).
- **Fix:** read `MFA_SECRET` through validated env; fall back with `||` (treat `""` as unset); refuse boot in
  prod when the resolved key is empty/placeholder. **Repro:** unit test that `MFA_SECRET=""` resolves to
  `SESSION_SECRET`, not `sha256("")`.

### S2-H4 — MCP HTTP handler: auth DB error is an unhandled rejection (no response, can crash the process)
- correctness · `apps/mcp/src/server.ts:509-525` (await `bearerOk` at :521 is **before** the try at :526), `:110-120`
- **CLAUDE.md:** oxlint `no-floating-promises` (error); rule #6 (every failed run leaves a trail — here it hangs).
- In Streamable-HTTP mode the `async` request listener `await bearerOk(...)` (→ `verifyMcpToken` DB query)
  sits outside the try/catch. A DB fault (down/pool-exhausted/timeout) on a non-boot-token request rejects the
  listener's promise; node:http doesn't consume it → `unhandledRejection`, and there's no
  `process.on('unhandledRejection')`. The long-lived remote process (harmonix etc.) can be torn down, or the
  socket hangs with no status and no log.
- **Fix:** move `await bearerOk` inside the try (degrade to a sanitized 500); add a top-level
  `unhandledRejection` handler.

## 🟠 Medium (sweep 2)

- **S2-M1 — Dockerfile bakes `.env` into the image & runs as root** (orig high→med). `Dockerfile:9-11,24`,
  `.dockerignore`. `COPY . .` with no `.env`/`.env.*` in `.dockerignore` (and `.env.example` tells devs to
  create `.env`) → a real `.env` lands in layer history. No `USER` directive → app + `/app/uploads` run as
  root. **Fix:** add `.env`/`.env.*` (keep `!.env.example`) to `.dockerignore`; add a non-root `USER` + chown.

- **S2-M2 — `PREVIEW_SECRET` inlined into the public admin JS bundle, no prod guard** (orig high→med).
  `apps/admin/src/components/PreviewPane.tsx:7,143`, `apps/web/.../page.tsx:9-14`, `Dockerfile:17`. Vite inlines
  `VITE_PREVIEW_SECRET` into the downloadable admin bundle, and neither web nor admin has an `env.ts`-style
  fail-fast, so a default deploy serves drafts to anyone using `?pb=dev-preview-secret-change-me`. Bounded to
  draft content (no private-field leak). **Fix:** fail-fast in prod on the dev default; prefer the cookie-based
  `/api/draft` flow over a client-embedded bearer. *(See also S2-M11 — same secret, query-param vector.)*

- **S2-M3 — Delivery public `Cache-Control` with no `Vary` → shared/CDN cache serves one site's payload to
  another site's key.** security · `apps/api/src/routes/delivery.ts:37-44,132,157,256`. The site+perspective
  credential rides only in the `Authorization`/`x-api-key` header (never the URL), but published responses are
  `Cache-Control: public` with no `Vary`. Per-site slugs collide (`/about` in two sites), so a shared cache
  keyed on URL serves site A's body to site B's key. ⚠️ Verifier correction: the shipped admin nginx is
  pass-through (no `proxy_cache`), so it's **latent** until a CDN is placed in front — but the `public`/SWR
  headers explicitly invite one. **Fix:** `Vary: Authorization, X-Api-Key` on cacheable responses; fold
  siteId+perspective into the ETag.

- **S2-M4 — Reference/contentArea resolve graph has no per-request node budget → fan-out resource DoS** (orig
  high→med). performance · `packages/db/src/delivery.ts:25,322-361,611-657`, `content-types.ts:223`
  (`ContentArea = z.array(BlockInstance)`, no `.max()`). Only a depth cap (4) bounds recursion; distinct
  documentIds aren't deduped, so a planted wide tree forces O(B^depth) DB queries + per-PAGE SEO walks per
  public GET (600/min). Not a cycle/stack-overflow (depth terminates). Med: needs authoring privilege to plant.
  **Fix:** a `nodesResolved` budget on `DeliveryCtx`; emit shallow refs past the cap.

- **S2-M5 — `@paperboycms/client` `etagCache` Map grows unbounded** (orig high→med). performance ·
  `packages/client/src/index.ts:160,194`. Opt-in ETag cache has only get/set — no cap/TTL/LRU; key = full URL
  incl. every filter/offset → unbounded key space leaks in a long-lived consumer. Verifier note: the reference
  `apps/web` doesn't enable it, so the "leaks in the documented consumer" framing is wrong — it bites external
  opt-in consumers. **Fix:** 2-line insertion-order LRU (cap ~500, evict oldest).

- **S2-M6 — Multi-select field group `aria-labelledby` points at a non-existent id** (orig high→med). a11y ·
  `apps/admin/src/components/Editor.tsx:1870,1931-1944`. The `<label htmlFor={id}>` emits `for`, not `id`; the
  multiple-select branch's `role="group" aria-labelledby={id}` references an id no element carries → dangling
  ARIA, axe `aria-valid-attr-value` failure. Latent (no seed/e2e exercises a `multiple` select). **Fix:** give
  the label an `id` and reference it, or `aria-label` the group.

- **S2-M7 — Toggle-chip selection state is color-only** (no `aria-pressed`). a11y · `AdminPanels.tsx:897-898`
  (role chips), `Editor.tsx:1937-1941`, `ContentTypeEditor.tsx:683-690`. State invisible to AT + lost in
  forced-colors mode; axe doesn't flag it (valid markup) so only human review catches it. The codebase already
  does it right elsewhere (icon-picker listbox, `aria-pressed` on other toggles). **Fix:** add `aria-pressed`,
  or model as a listbox.

- **S2-M8 — `restoreContent` resurrects children trashed in a *different, earlier* sweep** (orig high→med).
  correctness · `packages/db/src/content.ts:2342-2356` (restore BFS, no `deletedAt` filter) vs `:2302-2314`
  (softDelete BFS guards `isNull(deletedAt)`). Restoring a parent clears `deletedAt` on all descendants,
  including a child the editor had independently trashed earlier — it silently re-enters `getTree`. No delivery
  leak (not re-promoted). **Fix:** scope the restore to descendants sharing the parent's `deletedAt` timestamp.
  **Repro:** trash-child, trash-parent, restore-parent, assert child stays trashed.

- **S2-M9 — Sibling-slug uniqueness is app-level check-then-act with no backing unique index (TOCTOU)** (orig
  high→med). correctness · `packages/db/src/content.ts:589-635,742-770,1867-1878`, `0000_init.sql:58` (plain,
  non-unique index). Two concurrent same-parent/locale creates both scan, both see the slug free, both commit →
  two live siblings share a URL segment; delivery `.limit(1)` resolves nondeterministically (one page
  unreachable). Unlike published/draft invariants, this one has no DB enforcement. Med: needs true concurrency
  (serial autoSlug self-heals). **Fix:** partial unique index over a denormalized `(parent,site,locale,slug)`
  scope; keep `assertSlugUnique` as a friendly pre-check that catches 23505 → `Errors.conflict`.

- **S2-M10 — `moveContent` cycle-prevention walk runs outside the mutating transaction** (TOCTOU). correctness ·
  `packages/db/src/content.ts:1848-1859` (walk, no lock) vs `:1878-1920` (tx). Concurrent "move X under Y" +
  "move Y under X" both pass acyclicity (neither committed) and commit a 2-node parent cycle. Verifier
  correction: consumer walks have visited-sets so they **corrupt/orphan a subtree**, they don't hang. **Fix:**
  move the walk inside the tx with `FOR UPDATE` on ancestors, or a per-site advisory lock on structural moves.

- **S2-M11 — `?pb=<secret>` exposes drafts on any public URL (default committed secret, non-constant-time
  compare, secret-in-URL)** (orig critical→med). security · `apps/web/.../page.tsx:9-15,75`,
  `apps/web/app/lib/delivery.ts:13-15`. The query param selects the preview Delivery key on the public route.
  Verifier downscoped: `apps/web` is the *reference* frontend (not the enforced chokepoint — the API still
  enforces by key), and `?pb` + dev-default rotation are documented/intentional. Real residual: secret leaks
  into logs/Referer/cache, and `===` is a timing oracle. **Fix:** constant-time compare; prefer the draft-mode
  cookie; fail-fast on the dev default.

- **S2-M12 — Draft-mode redirect builds `Location` from attacker-controlled `Host`/`X-Forwarded-Proto` (open
  redirect)** (orig high→med). security · `apps/web/app/api/draft/route.ts:35,38-40`. After enabling the draft
  cookie, the redirect origin is taken verbatim from request headers with no allowlist → `Host: evil.example`
  yields `Location: //evil.example/...`, contradicting the route's own "avoids open redirect" comment. Gated
  behind a valid `PREVIEW_SECRET` (why med). **Fix:** relative redirect against `req.nextUrl.origin`, or a host
  allowlist.

## 🟡 Low (sweep 2)

- **S2-L1 — Enabling/disabling 2FA doesn't invalidate other sessions** (orig med→low). security ·
  `packages/db/src/auth-store.ts:316-334` vs `:232-234` (changePassword evicts all). "Turn on 2FA because
  someone got in" doesn't evict a held session. Low: 2FA is a login-time factor, not a session input. **Fix:**
  evict other sessions on 2FA toggle (preserve current), like changePassword.

- **S2-L2 — `/logout` is a state-changing route with no `requireCsrf`.** security · `apps/api/src/routes/auth.ts:105-114`
  vs every other mutation (`:122-131` etc.). `sameSite:"lax"` blocks the cross-site cookie so it's
  defense-in-depth/uniformity. **Fix:** swap `requireAuth` → `requireCsrf` (it wraps requireAuth).

- **S2-L3 — Client SDK silently drops empty-string filter values** (orig med→low). correctness ·
  `packages/client/src/index.ts:164-165,243`. `if (v !== undefined && v !== "")` swallows an intentional
  `filter: { status: "" }` (which the server *does* honor as "field empty/absent") → returns the unfiltered
  set, a garbage-in/wrong-out per rule #1. **Fix:** set `data.<field>` params unconditionally; keep the `""`
  guard only for optional top-level scalars.

- **S2-L4 — `renderRichText` emits `<hNaN>` for a non-numeric heading `level`.** correctness ·
  `packages/client/src/index.ts:327-330`. `Number(node.attrs.level ?? 2)` → `NaN` for a present-but-non-numeric
  level (agent/MCP content is untrusted) → invalid HTML. **Fix:** `Number.isFinite` guard, mirroring the image-
  width case one block below.

- **S2-L5 — Concurrent draft-seed / publish race surfaces 23505 as an opaque 500, not a self-teaching 409**
  (orig med→low). contract · `packages/db/src/content.ts:1104-1186,1482-1525`, `app.ts:128-149`. The partial
  unique indexes *do* hold the invariant (no corruption), but no handler catches Postgres 23505, so the losing
  concurrent agent gets `Internal server error` — the worst text mid-loop (rule #2). A server log trail does
  exist (rule #6 satisfied). **Fix:** wrap seed/promote in a tx, catch 23505 → `Errors.conflict` with a retry
  hint; or `INSERT … ON CONFLICT DO NOTHING` + re-select.

## Updated order of work

The sweep-1 order still holds; insert these ahead of it given real-world exposure:

0. **S2-H2 + S2-H3 (secrets) — do first.** A default prod deploy on forgeable cookies + a public-constant TOTP
   key is the highest real risk in either sweep. One shared forbidden-placeholder list + `MFA_SECRET` through
   validated env with `||`. Pair with S2-M1/M2 (Docker `.env` bake, `PREVIEW_SECRET` guard) as one secrets pass.
1. **S2-H1 (Author scoping)** — silently breaks a documented authz feature for every non-default site.
2. **S2-H4 (MCP unhandled rejection)** — a transient DB blip can kill the remote MCP process.
3. **Write-invariant cluster S2-M9 + S2-M10 + S2-L5** — share a fix shape (tx + lock/unique-index + 23505→409).
4. Then the sweep-1 order (M4 lint quick-win, H1+M1+M2 delivery-leak cluster, H4+M12 2FA, H3 SSRF, H2 MCP audit…).

# Sweep 3 — Additional Findings (review converged after this sweep)

Remaining-corner lenses: CORS/security headers, response-schema over-exposure, enumeration/rate-limit abuse,
logging/PII, media path & SVG handling, TanStack Query consistency, supply-chain/CI, and the `ops/` backup
scripts; plus a follow-up on outbound-fetch SSRF. **response-schema-overexposure came back clean** — the
verifier confirmed no `passwordHash`/`totpSecret`/`backupCodes`/session-token/secret leaks in any management/
auth response schema (the serialization boundary is tight). New themes: **secrets-in-logs/backups** and
**operational (ops/) safety** — neither touched by earlier sweeps.

## 🔴 High (sweep 3)

### S3-H1 — MCP error log dumps the cleartext user password to stdout/docker logs on `create_user` failure
- security · `apps/mcp/src/server.ts:165,451-452`, `packages/db/src/auth-store.ts:146-157`
- **CLAUDE.md:** rule #6 (MCP errors log args to stdout) + auth model (argon2id, never echo plaintext creds).
- The rule-#6 trail logs full tool args with **no redaction** (`…args: ${JSON.stringify(args)?.slice(0,4000)}`).
  `create_user` takes a cleartext `password`; `adminCreateUser` validates length *then* throws `conflict` on a
  duplicate email (a common, externally-triggerable case) — by which point the valid password is in `args` and
  gets serialized verbatim to docker logs (CWE-532), which are typically shipped to aggregators. API side is
  safe (Fastify doesn't log bodies). **Fix:** redact known secret keys (`password`, `code`, `token`, `secret`,
  `apiKey`…) in a shallow copy before logging — keeps rule-#6 diagnosability without leaking the credential.

### S3-H2 — Nightly backups contain every credential yet are written world-readable and as root
- security · `ops/backup.sh:8,19-20,23-24`
- `pg_dump` redirected by the host shell inherits the cron umask (→ 0644); the uploads tar runs as root in an
  alpine container. The dump is a full copy of the DB — argon2id hashes, encrypted TOTP secrets, session
  tokens, all delivery keys, MCP tokens, encrypted AI keys. Any local non-root user can read a complete
  credential dump from `~/paperboy-backups`. **Fix:** `umask 077` at the top, `mkdir -m 700`, `chmod 600` the
  dump + tarball (and chown the root-created tar back to the cron user).

## 🟠 Medium (sweep 3)

- **S3-M1 — Admin SPA has no clickjacking protection** (no `X-Frame-Options`/CSP `frame-ancestors`) (orig
  high→med). security · `apps/admin/nginx.conf:40-49`, `apps/admin/index.html:3-7`. The authenticated editor
  (publish/delete/trash/settings/MCP-token minting) can be framed by any site → UI-redress. `apps/web` sets
  `frame-ancestors`; the far more sensitive admin sets nothing. **Fix:** `add_header X-Frame-Options "DENY"
  always;` + `Content-Security-Policy "frame-ancestors 'none'" always;` on both nginx location blocks.

- **S3-M2 — API sets no global security headers** (no HSTS, no `nosniff` on JSON, no Referrer-Policy, no CSP).
  security · `apps/api/src/app.ts:59-82`. `nosniff` is set only on `/api/v1/media/`; the cookie-issuing auth/
  manage/delivery JSON + Swagger HTML surfaces have nothing, and `@fastify/helmet` isn't installed. **Fix:**
  register `@fastify/helmet` once (HSTS when `COOKIE_SECURE`, `noSniff`, `referrerPolicy`, `frameguard`, CSP).

- **S3-M3 — Deleting an asset never removes its cached transform variants** → deleted bytes stay publicly
  downloadable. security · `apps/api/src/routes/manage.ts:469-481`, `media.ts:91-115`, `assets.ts:122-131`.
  DELETE unlinks only the original; `_variants/<file>.w…q….<fmt>` are left on disk AND remain servable by the
  recursive `@fastify/static` mount (the `:file` param route only matches single segments, so slash paths fall
  through). Deletion (the documented revocation path) is incomplete + unbounded retention leak. **Fix:**
  `readdir` `_variants` and unlink entries prefixed `${fileName}.` on delete. **Repro:** upload → materialize a
  variant → delete → assert the variant URL 404s.

- **S3-M4 — Logout/login/session-expiry never clears the TanStack Query cache** → previous user's RBAC/site-
  scoped data bleeds into the next session on a shared browser (orig high→med). security · `apps/admin/src/
  App.tsx:18-21,33-40,49`, `main.tsx:16-18`, `SiteSwitcher.tsx:16`. No `queryClient.clear()` on any auth
  boundary; `["sites"]` (staleTime 60s) shows user A's site list to user B for up to a minute. Server authz
  still backstops (transient client display leak). **Fix:** `queryClient.clear()` in logout, the 401 handler,
  and after login.

- **S3-M5 — CI/eval workflows declare no `permissions:` block** → fork PR code runs with the default
  `GITHUB_TOKEN` (orig high→med; GitHub forces read-only token for *fork* `pull_request`, so residual risk is
  same-repo/push runs + org default-token setting). supplychain · `.github/workflows/ci.yml`, `eval.yml`.
  **Fix:** `permissions: contents: read` at the top of both; grant narrower scopes per-job only where needed.

- **S3-M6 — Backup monitor never watches the uploads tarball** → a silently-failing uploads backup stays green
  forever. deploy · `ops/monitor.sh:36-39`, `ops/backup.sh:22-24`. The 48h freshness check globs only
  `paperboy-*.dump`, not `uploads-*.tar.gz` — half the restore set is unmonitored. **Fix:** add a parallel
  `uploads-*.tar.gz -mtime -2` check with its own alert key.

- **S3-M7 — Restore runbook untars uploads into the LIVE volume read-write, no stop/clear** → half-old/half-new
  merge while api+web serve. deploy · `ops/README.md:21-24`. The DB half restores into an isolated
  `restore_target` then promotes; the uploads half writes straight to prod and `tar` overlays (doesn't delete
  files absent from the backup). **Fix:** stop api/web, extract into a fresh volume (or clear `/data` first),
  mirroring the DB half's isolate-then-promote discipline.

- **S3-M8 — Stock image download follows redirects, bypassing the pre-fetch host allowlist** (SSRF) (orig
  high→med). security · `packages/db/src/stock.ts:156-161,185-199`, `packages/shared/src/stock.ts:152-154`.
  The Unsplash host allowlist is checked once before `fetch`, which defaults to `redirect:'follow'` (20 hops),
  so a 30x from an allowlisted host follows anywhere with no re-validation — the control the file's own comment
  calls "SSRF defense-in-depth" doesn't control. Med (not high) because the URL is provider-supplied, not
  user-controlled — needs a MITM/open-redirect on Unsplash. **Fix:** `redirect:'manual'`, re-validate each
  `Location` host; reject RFC1918/loopback/link-local/169.254 on the resolved final address.

## 🟡 Low (sweep 3)

- **S3-L1 — `apps/web` CSP only sets `frame-ancestors`** — no `script-src`/`default-src`/`object-src`/
  `base-uri` to contain stored-XSS. security · `apps/web/middleware.ts:11-25`. Defense-in-depth only.
  Verifier note: a real `script-src` under Next 15 needs nonce plumbing; `object-src 'none'` + `base-uri
  'self'` are safe drop-ins.

- **S3-L2 — `POST /ai/translate` allows ~2M chars of model input per request** (10/min) → unbounded model
  spend. security · `apps/api/src/routes/ai.ts`, `packages/shared/src/ai.ts`. **Fix:** cap input length at the
  route schema.

- **S3-L3 — No per-account lockout on password-reauth paths** (`/change-password`, `/2fa/disable`). security ·
  `apps/api/src/routes/auth.ts`. A session-hijacker can brute-force the account password (only per-IP limited).
  Related to H4/M12. **Fix:** apply the per-account lockout to reauth too.

- **S3-L4 — `publish`/`unpublish`/`schedule`/`approve` mutations don't invalidate `["dashboard"]`** though they
  change WIP/scheduled/review counts (discard/trash/deleteVariant correctly do). correctness · admin mutations.
  **Fix:** add `["dashboard"]` to those mutations' invalidation sets.

- **S3-L5 — Asset alt-text save/delete/move invalidate `["assets"]` but not `["dashboard"]`**, whose
  `missingAlt`/`imagesMissingAlt` derive from alt text. correctness · admin. **Fix:** also invalidate
  `["dashboard"]`.

- **S3-L6 — `pnpm/action-setup` pinned to mutable `@v6`, not a commit SHA.** supplychain · `.github/workflows/`.
  Supply-chain drift risk. **Fix:** pin to a full SHA.

- **S3-L7 — Stock image download buffers the entire body before the size cap** (memory exhaustion on a large/
  decompressed response). performance · `packages/db/src/stock.ts`. **Fix:** enforce the cap while streaming
  (check `Content-Length` + abort past the limit mid-stream).

## Convergence note

After three sweeps the completeness critic set `converged: true`. Sweep 3 surfaced 17 new issues but they
cluster in the operational/hardening tail (headers, logs, backups, CI, cache invalidation) rather than new
core-logic flaws, and two lenses (richtext-coercion in sweep 2, response-schema-overexposure in sweep 3) came
back clean. The **delivery no-leak chokepoint, multisite partition, and RBAC object-authz held across all
three sweeps** — the confirmed leaks are all *adjacent* (query filters, caching, search index), never the
core chokepoint itself. Further sweeps would likely yield mostly low-severity polish; this is a sound place to
stop reviewing and start fixing.

# Caveats

- Static review only — no code was executed except the verifier's one-off build of `packages/preview` (M5).
- Severities are the verifier's calibration; re-judge against your own threat model before acting.
- The clean lenses (multisite partition, RBAC) are *evidence of absence within the swept paths*, not a proof —
  worth a targeted re-sweep if either area changes.
