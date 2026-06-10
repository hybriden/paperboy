# Paperboy admin — debugging e2e suite (`e2e-debug/`)

This is **not** the CI suite (that's `../e2e/admin.spec.ts` + `playwright.config.ts`).
This is the toolbox you reach for when chasing a bug: broad coverage, **traces
always on**, video retained on failure, **one area per file** so you can run
exactly the slice you need.

> One worker, no parallelism, no retries — runs against a **shared, live dev
> stack** (the `paperboy_test` DB). Tests create their own content with unique
> `dbg-<area>-…` names and clean up after themselves, so they don't depend on
> each other or on a pristine DB beyond the seed (Home, Blog + posts, Author
> Zone, the shared "Featured Card" block — see `packages/db/src/seed.ts`).

## Files

| File | Area |
| --- | --- |
| `content-lifecycle.debug.spec.ts` | create/edit every field type, autosave, publish/unpublish, schedule, discard, duplicate, trash+restore, version history + compare |
| `content-types.debug.spec.ts` | content-type editor: every field type + validation, use on a page, delete-while-in-use guard |
| `media.debug.spec.ts` | upload, alt text + the no-key Describe-image disabled state, image field choose/replace/clear, picker tabs, delete-while-referenced |
| `richtext-markdown.debug.spec.ts` | every TipTap toolbar control, link prompt, image insert + drag-resize, markdown toolbar + Write/Preview |
| `settings.debug.spec.ts` | languages, site preview URL, AI/stock panels, delivery keys, MCP tokens, webhooks, users, audit log |
| `rbac.debug.spec.ts` | Editor/Author/Viewer scoping and read-only enforcement |
| `navigation.debug.spec.ts` | ⌘K palette, tree expand/collapse, drag-reorder + drag-to-nest, locale switch, deep-link reload, start page |
| `ope-preview.debug.spec.ts` | side-by-side preview iframe, postMessage focus bridge, on-page overlay, live patch, click-to-caret |

## Running

All commands from the repo root (pnpm lives at `~/.npm-global/bin`; prefix with
`export PATH="$HOME/.npm-global/bin:$PATH"` if it isn't on yours).

```bash
# whole suite
pnpm --filter @paperboy/admin test:e2e:debug

# one file
pnpm --filter @paperboy/admin test:e2e:debug e2e-debug/media.debug.spec.ts

# one test by title (substring)
pnpm --filter @paperboy/admin test:e2e:debug -g "drag-resize"

# headed (watch it happen)
pnpm --filter @paperboy/admin test:e2e:debug --headed e2e-debug/navigation.debug.spec.ts

# step through with the Playwright inspector
PWDEBUG=1 pnpm --filter @paperboy/admin test:e2e:debug e2e-debug/rbac.debug.spec.ts

# open the last trace (every run records one — trace: "on")
pnpm --filter @paperboy/admin exec playwright show-trace test-results/<...>/trace.zip

# open the HTML report (reporter writes playwright-report/)
pnpm --filter @paperboy/admin exec playwright show-report
```

Target a different deploy with `ADMIN_URL` (note: `COOKIE_SECURE=true` breaks
http login, so point at an https host if the target enforces secure cookies):

```bash
ADMIN_URL=https://staging.example pnpm --filter @paperboy/admin test:e2e:debug
```

If Chromium isn't installed:

```bash
pnpm --filter @paperboy/admin exec playwright install chromium
```

## Starting the stack natively (no Docker)

The suite assumes the stack is already running. To bring it up by hand (the dev
ports are admin **8090**, api **8091**, web **8092**, Postgres **5433**):

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
export DATABASE_URL="postgresql://paperboy:paperboy@localhost:5433/paperboy"

# 1) seed (TRUNCATEs + reseeds — wipes data, regenerates IDs). Use the same
#    deterministic keys the web app expects.
SEED_ADMIN_EMAIL=admin@paperboy.test SEED_ADMIN_PASSWORD='Admin!Passw0rd' \
PAPERBOY_PUBLIC_KEY=pk_live_seed_public_key_value \
PAPERBOY_PREVIEW_KEY=prv_seed_preview_key_value \
  pnpm --filter @paperboy/db seed

# 2) API (migrations run on boot; http login needs COOKIE_SECURE=false)
DATABASE_URL="$DATABASE_URL" NODE_ENV=development COOKIE_SECURE=false \
UPLOADS_DIR=./.uploads \
  pnpm --filter @paperboy/api start          # → http://localhost:8091

# 3) admin SPA (Vite proxies /api → 8091)
pnpm --filter @paperboy/admin dev             # → http://localhost:8090

# 4) web preview frontend (consumes the Delivery API; needs the same keys)
PAPERBOY_API_URL=http://localhost:8091 \
PAPERBOY_PUBLIC_KEY=pk_live_seed_public_key_value \
PAPERBOY_PREVIEW_KEY=prv_seed_preview_key_value \
PAPERBOY_PREVIEW_SECRET=dev-preview-secret-change-me \
  pnpm --filter @paperboy/web dev             # → http://localhost:8092
```

## Conventions for adding tests here

- **One area per file.** Don't cross-cut; keep each file independently runnable.
- **Unique names** via `uniqueName()` / `createPage()` from `helpers.ts`.
- **Scope assertions to your own content** — never assert global counts that
  leftover data from a previous run would break.
- **Reuse the session cache** (`login()` from `helpers.ts`) — don't log in via
  the form in a loop or you'll trip the rate limit.
- If a real app bug blocks a flow, fix the smallest thing in app code and note
  it; if behavior merely looks odd, **pin it** with a comment rather than
  weakening the assertion.
