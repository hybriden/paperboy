# 📰 Paperboy

[![CI](https://github.com/hybriden/paperboy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hybriden/paperboy/actions/workflows/ci.yml)

**A self-hosted, open-source headless CMS in TypeScript on PostgreSQL. React admin with visual on-page editing, a typed Delivery API, and an MCP server so AI agents edit under the same rules as humans.**

> **Paperboy ONE** — *Open, No Extras.* · **DPX** — *Don't Pay eXtra.*
> A proper headless CMS without the "experience platform" invoice. Self-host it, own your content, ship.

**Built for teams of humans _and_ agents.** Admin UI, REST and MCP all go through the same
validation, permissions and audit trail. The MCP↔API parity is
[test-enforced](apps/api/test/mcp-parity.test.ts).

A TypeScript monorepo on PostgreSQL: Fastify Management + Delivery API, React admin with
visual on-page editing, Next.js reference frontend, MCP server. Runs as **one container**.

## Highlights

**Content**
- **Content types are data** — pages, blocks and globals defined in the admin, not in code. Content areas hold inline or shared blocks with per-area allowed types. A built-in template library covers the essentials.
- **Multisite** — several sites in one instance, each with its own delivery keys, media, preview URL and start page. Types, languages and users are shared. Enforced deny-by-default in the same chokepoints as everything else.
- **Multi-language** with a fallback chain, hierarchical URLs from the page tree, version history, trash, duplicate. Translation gaps are flagged in the tree and on the dashboard.
- **Forms with submissions in _your_ database** — a form is content (a `Form` block with one block per question). Delivery ships it as a schema, never markup. Submissions are validated against the published definition, unknown fields are rejected, and errors come back per field. Honeypot and fill-time check on by default, Turnstile opt-in. Retention actually runs, IP storage is opt-in, erase-by-email is one audited action.

**Delivery**
- **One no-leak read path** with a `perspective`: public keys see published content, preview keys see drafts, private fields never serialize. Lists paginate, sort and filter (`?sort=-data.publishDate&data.author=Jane`), plus full-text search. Every item ships `fieldTypes` so frontends switch on schema, not value shapes.
- **SEO and structured data set up in the CMS** — every page gets a computed `seo` block (meta, canonical, robots, OpenGraph, Twitter) and per-`@type` JSON-LD with breadcrumbs and `dateModified`. A `SiteSettings` global typed `Organization` is the site's identity. Content areas with a schema.org property become nested nodes, so an FAQ delivers its Question/Answer pairs. The type editor shows a rich-result checklist. Preview is always `noindex`.
- **Public files generated from content** — robots.txt, sitemap.xml, llms.txt and security.txt, proxied by the frontend, never stale.
- **Redirects that keep link equity** — rules per site under Settings → Redirects, served as one manifest and matched in the frontend with `matchRedirect` from the client SDK. Publishing a rename or move records a 301 automatically. Targets are pages, so they never chain. A 404 log shows what visitors actually miss.
- **Image transforms** — `?w=800&format=webp&q=75` on any media URL, generated once with sharp and cached.
- **Webhooks** — HMAC-signed `content.published`/`unpublished`, `form.submitted`, and `delivery.changed` for every move, sort, trash or settings change, so a cache can purge on webhooks alone.

**Editing**
- **Visual on-page editing** — click an element in the preview to focus its field, drag shared blocks onto the page, even into a cross-origin iframe. The bridge is the [`@paperboycms/preview`](packages/preview) npm package.
- **Admin** — React 19, light/dark, ⌘K palette, keyboard-operable drag-drop, axe-clean. The dashboard is a worklist: gaps, missing alt text and unused blocks are deep-linked, not counted.
- **AI writing assistant** (optional, Anthropic or any OpenAI-compatible endpoint) — improve, rewrite, draft, translate richtext, vision alt text from the image bytes, schema.org suggestions. With no key it refuses honestly instead of faking output.

**Agents and security**
- **MCP server** — drive the whole CMS from an AI client. Tokens are site-scoped and revocable, or clients sign in with OAuth 2.1. Every version records whether a human or an agent wrote it, with an opt-in review gate before agent drafts publish.
- **Secure by default** — Argon2id, opaque server-side sessions, CSRF, passwordless TOTP 2FA, deny-by-default RBAC with object-level scopes, append-only audit log.
- **Typed client SDK** — [`@paperboycms/client`](packages/client) on npm, typed from the same Zod schemas the server serializes with. No codegen.

## How it compares

What ships in the box as of 2026-10-17. **core** = built in · **plugin** · **paid** · **no**. Every cell is sourced in [`docs/comparison-sources.md`](docs/comparison-sources.md); corrections welcome.

| | Paperboy | Strapi | Payload | Directus | Sanity |
|---|---|---|---|---|---|
| **License** | MIT | MIT + paid tiers | MIT | source-available | closed backend |
| **Self-host** | one image | Node app | your Next.js app | one image | no |
| **Forms, validated server-side** | core | plugin | plugin, partial | no | no |
| **SEO meta + JSON-LD from the CMS** | core | plugin, no JSON-LD | plugin, no JSON-LD | plugin, no JSON-LD | no |
| **Auto 301 on rename** | core | plugin | plugin, manual | no | DIY |
| **MCP server acting as a user** | core | core | plugin (beta) | core | core |
| **Multisite** | core | no | plugin | pattern | datasets |
| **Click-to-edit on the live page** | core | paid | soon | core | core |
| **GraphQL** | no | plugin | core | core | core |
| **Hosted option** | no | paid | paused | paid | yes |
| **Ecosystem** | none yet | large | growing | growing | large |

## Layout
```
apps/api         Fastify v5 — Management API (auth/RBAC) + Delivery API (read-only, key-scoped); serves the admin
apps/admin       React 19 + Vite — the editor
apps/web         Next.js 15 — reference frontend, pins the delivery contract (opt-in)
apps/mcp         MCP server (stdio or Streamable HTTP)
packages/shared  Zod schemas + types (single source of truth) + the AI provider
packages/db      Drizzle schema, migrations, query layer (object-level authz), seed
packages/client  @paperboycms/client — typed Delivery API SDK (npm)
packages/preview @paperboycms/preview — on-page-editing bridge (npm)
```

## The npm packages

Both are published so frontends integrate against a contract, not the CMS codebase, and are versioned independently.

**[`@paperboycms/client`](packages/client)** — dependency-free, end-to-end typed:

```ts
import { createClient, mediaUrl } from "@paperboycms/client";

const cms = createClient({ baseUrl: "https://cms.example.com", key: process.env.PAPERBOY_PUBLIC_KEY! });
const post = await cms.getBySlug<BlogPost>("hello-world", { locale: "en" });
const { items } = await cms.list<BlogPost>("BlogPost", { sort: "-data.publishDate", limit: 10 });
const src = mediaUrl(post!.data.image, { w: 640, format: "webp" });
```

Also `getByPath`, `startPage`, `global`, `search`, render helpers that follow `fieldTypes`, `matchRedirect`, and an optional ETag cache. 404s return `null`, other errors throw `PaperboyError`. Tested against a live server in `apps/api/test/client-sdk.test.ts`. [Full README](packages/client/README.md).

**[`@paperboycms/preview`](packages/preview)** — zero-dependency bridge that makes any frontend editable inside the admin's preview iframe. Call `initPreviewBridge()` in preview mode and mark the DOM with `data-pb-field`, `data-pb-area` and `data-pb-block-index` (or let the client's `pbAreaAttrs` emit them). It is the single source of truth for the admin↔frontend protocol. [Full README](packages/preview/README.md).

## Quickstart (Docker)
```bash
./scripts/setup.sh       # generates .env with unique secrets and your admin password — required
docker compose up -d     # db → init (migrate + seed) → api, which also serves the admin
# Admin  http://localhost:8090    API  http://localhost:8091  (OpenAPI UI at /api/docs)
```

That is the CMS. For the **website**, use the
[Astro starter](https://github.com/hybriden/paperboy-astro-starter), a separate repo that
renders every built-in content type:

```bash
git clone https://github.com/hybriden/paperboy-astro-starter my-site
cd my-site && npm install && npm run setup && npm run dev   # http://localhost:4321
```

`setup.sh` is safe to re-run and never overwrites an existing `.env`. Paperboy refuses to
boot on the placeholder secrets in this repo and refuses to seed production with the
published demo login. `apps/web` is opt-in (`docker compose --profile web up -d web`, :8092)
because it is a contract reference, not a site to build on.

> ⚠️ The generated `.env` targets localhost. Before exposing a real host set `COOKIE_SECURE=true`,
> drop `ALLOW_INSECURE_COOKIES`, and point `CORS_ORIGIN` at the admin's HTTPS origin.
>
> ⚠️ Redeploy one service with `docker compose up -d --no-deps --force-recreate <svc>`. The seed
> refuses to wipe a database that holds content unless `FORCE_SEED=1`. Details in `CLAUDE.md`.

### Hosting without a VM

One container, no proxy: it fits any "run a container" platform (App Service, Container Apps,
Cloud Run, Fly, Render, Railway) plus a managed Postgres.

| Setting | Value |
|---|---|
| Image | `ghcr.io/hybriden/paperboy-app:latest` |
| Port | the platform's `PORT` (or `API_PORT`) |
| `DATABASE_URL` | `postgresql://…@host:5432/paperboy?sslmode=require` |
| Secrets | `SESSION_SECRET`, `CSRF_SECRET`, `MFA_SECRET` via `openssl rand -hex 32` |
| `CORS_ORIGIN` | the admin's HTTPS origin, with `COOKIE_SECURE=true` |
| `TRUST_PROXY` | the load-balancer range, so rate limits see real IPs |
| Storage | a persistent volume at `/app/uploads` |
| Remote MCP | `MCP_EMBEDDED=true` serves the MCP inside the same container at `{PUBLIC_URL}/mcp` |

Run **one replica**: rate limits and the publish/retention timers are in-process. Migrations run on
boot. Create the first admin by running the image once with `pnpm --filter @paperboy/db seed` and real
`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `PAPERBOY_PUBLIC_KEY`, `PAPERBOY_PREVIEW_KEY`.
Back up the database **and** the uploads volume.

## 🪟 Windows, no experience needed

1. **Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)**, restart if asked, open it and wait for **Engine running**.
2. **Download Paperboy**: GitHub → green **Code** button → **Download ZIP** → right-click → **Extract All…**.
3. **Open a terminal there**: open the extracted folder in File Explorer, type `powershell` in the address bar, press Enter.
4. **Create your login** (required; it gives your copy its own private keys):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
   ```
   It prints an email and password. **Save them now**, they cannot be shown again.
5. **Start it**: `docker compose up -d` (the first run downloads for a few minutes).
6. **Open http://localhost:8090** and log in.

Everyday: `docker compose stop` / `docker compose start` / `docker compose ps`.

> ⚠️ Never run `docker compose down -v` once you have content: `-v` deletes the database. Use stop/start.
> If a page won't load, check that Docker Desktop says **Engine running**.

## Develop locally
```bash
pnpm install
docker compose up -d db
export DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy
pnpm db:seed
pnpm dev                        # api :8091, admin :8090, web :8092
```

## Test
```bash
pnpm --filter @paperboy/api test            # integration tests against a real Postgres
pnpm --filter @paperboy/admin test:e2e      # Playwright e2e + axe
```
CI also runs the **MCP usability eval** (`evals/`) on every push with a deterministic mock driver
(real tool calls, no paid API) and weekly with a real model.

## MCP
```bash
# Mint a token in Settings → MCP, then run locally over stdio:
MCP_TOKEN=mcp_… DATABASE_URL=postgresql://… pnpm --filter @paperboy/mcp start
# …or over Streamable HTTP for remote clients:
docker compose --profile mcp up -d --no-deps mcp      # → https://<your-domain>/mcp
```
The MCP acts as a Paperboy user and inherits its RBAC. Tokens are minted per site (or for every site).
Set `PAPERBOY_SITE` to pin a server to one site; every tool also takes a per-call `site`.

**OAuth for remote clients.** Add `https://<your-domain>/mcp` as a connector in Claude or Cursor. The
client registers itself, sends you through Paperboy's own login (with 2FA), and a consent screen asks
which site the connection may work in. Revoke it in Settings → Connected apps. Everything lives on one
domain: the API forwards `/mcp` and serves `/.well-known/oauth-*`. Set `PUBLIC_URL` (the issuer, default
`CORS_ORIGIN`) and `MCP_PUBLIC_URL` (default `{PUBLIC_URL}/mcp`) on both `api` and `mcp` for other layouts.

**Files from the agent's machine.** `create_upload_link` mints a 15-minute link the agent `curl`s files
to (`POST /api/v1/uploads`, 20 files of 5 MB per request). `upload_asset` takes a public URL or base64.

### Agent-ready by design
Every rule came out of a real agent run that broke:

- **No silent damage** — input is coerced only when meaning is preserved, otherwise rejected with an error that names the field, the shape and a copyable example.
- **Serialization-proof writes** — `set_field(documentId, field, value)` sends one flat string, because long strings inside record args get mangled to `{}` by some clients.
- **Safe defaults** — `update_content` merges by default, pages auto-slug from their name.
- **A diagnosable trail** — tool errors are logged with their arguments, every write lands in the audit log as `ip=mcp`.
- **Discoverable contract** — `get_content_type` annotates every field with `valueFormat` and `valueExample`.

The full rules live in [`CLAUDE.md`](./CLAUDE.md#agent-api-design-rules-mcp--write-endpoints--learned-from-real-failures).

## Seed accounts
Your admin login is what `setup.sh` printed. The demo logins (`editor@`, `author@`, `viewer@`,
passwords `<Role>!Passw0rd`) are development fixtures: a production seed creates only the admin
unless `ALLOW_DEMO_CREDENTIALS=true`.

## Backups
Nothing backs itself up. `ops/backup.sh` is a working reference: nightly `pg_dump -Fc` plus a tar of
the uploads volume, 14-day rotation, alert on failure.

```bash
mkdir -p ~/.config/paperboy ~/.local/state/paperboy
echo "<your-private-topic>" > ~/.config/paperboy/ntfy-topic && chmod 600 ~/.config/paperboy/ntfy-topic
crontab -e   # 30 3 * * *  $HOME/paperboy/ops/backup.sh  >> $HOME/.local/state/paperboy/backup.log 2>&1
             # */5 * * * * $HOME/paperboy/ops/monitor.sh >> $HOME/.local/state/paperboy/monitor.log 2>&1
```

Two things it refuses to do quietly: it will not succeed with an empty media archive (the uploads
volume name carries Compose's project prefix, so a renamed checkout would silently point at a new,
empty volume), and it writes mode-600 files because **a backup is a full credential dump**.

Restore is in [`ops/README.md`](ops/README.md). The app reads a fixed database name, so a restore
must swap into it (`ALTER DATABASE … RENAME`). Known gap: backups land on the same disk as the data.
Add one `rclone copy` line once you have a bucket.

## Docs
- **`CLAUDE.md`** — how to develop and deploy safely, and how agents should work in the repo.
- **`STACK.md`** — the stack and the reasoning behind each choice.
- **`docs/plans/`** — research and decisions behind the bigger features. **`docs/comparison-sources.md`** — every cell of the comparison table, sourced.
- **`CONTRIBUTING.md`** / **`SECURITY.md`** — how to send a PR, how to report a vulnerability.
- **[`packages/client/README.md`](packages/client/README.md)** / **[`packages/preview/README.md`](packages/preview/README.md)** — the npm packages in depth.

## License
[MIT](./LICENSE) — *Don't Pay eXtra.* 📰
