<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-dark.png">
    <img alt="Paperboy" src="docs/brand/wordmark-light.png" width="400">
  </picture>
</h1>

[![CI](https://github.com/hybriden/paperboy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hybriden/paperboy/actions/workflows/ci.yml)
[![Paperboy CMS MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/hybriden/paperboy/badges/score.svg)](https://glama.ai/mcp/servers/hybriden/paperboy)

**The MCP-first headless CMS.** Point Claude, Cursor or any MCP client at Paperboy and it can build
pages, translate them, fix SEO, migrate redirects and publish on a schedule — as a real user, with that
user's permissions, through the same validation and audit trail as your editors. Then open the admin:
a visual editor where you click any text on your live site and change it.

Agents do the volume. People decide what goes live. Self-hosted, MIT, one container and a Postgres.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.jpg">
  <img alt="The Paperboy admin editing a page in place, next to the live site on a phone" src="docs/screenshots/hero-light.jpg">
</picture>

> **Paperboy ONE** — *Open, No Extras.* · **DPX** — *Don't Pay eXtra.* A proper headless CMS without the "experience platform" invoice.

The website you build on is a separate repo, the
[**Astro starter**](https://github.com/hybriden/paperboy-astro-starter).

## Two front doors, one CMS

| | Your agent (MCP) | Your editors (admin) |
|---|---|---|
| **Gets in with** | OAuth sign-in (with 2FA) or a site-scoped token | Password + TOTP 2FA |
| **Sees** | Only the tools its role can use — an Author is never offered publish, users or webhooks | Only the sections and actions its role allows |
| **Writes through** | The same Zod validation, RBAC and audit log — [parity is test-enforced](apps/api/test/mcp-parity.test.ts) | ← same |
| **Is recorded as** | `via: mcp` on every version, badged **Agent edited** | `via: web` |

## Connect your agent

1. In Claude or Cursor, add `https://<your-domain>/mcp` as a connector.
2. Sign in with your Paperboy login and pick which site it may work in.
3. Ask for something real:

- *"Write a post about our summer opening hours in Norwegian, put it under Blog, and schedule it for Monday 09:00."*
- *"Here are 40 URLs from our old WordPress sitemap. Redirect each to the matching page and check every one lands in one hop."*
- *"Create an FAQ page type and fill it from this document."*
- *"Which pages are missing a meta description? Draft them, don't publish."*
- *"Who changed the home page last week, and what did they change?"*
- *"Export this month's contact-form submissions."*

Running locally? Mint a token in Settings → MCP and use stdio — see [MCP setup](#mcp-setup).

## Why "MCP-first" means more than an MCP server

Every rule below exists because a real agent run broke without it.

- **You decide how much to trust it.** Every version records whether a person or an agent wrote it,
  and agent drafts are badged *Agent edited*. Switch on agent review (Settings → MCP) and agent drafts
  become *Needs review*: the agent can still write, but nothing goes live until a person approves.
- **Nothing an agent does is permanent by accident.** Full version history, a trash with restore, drafts
  by default, scheduled publishing instead of fake dates in a field.
- **Errors teach instead of fail.** A bad write is refused with the field name, the expected JSON shape and
  a copyable example, so the agent fixes it in one step. Paperboy never "succeeds" with mangled data —
  that once sent an agent into a nine-attempt loop.
- **Guard rails for agent-typical mistakes.** Norwegian text can't silently land on the English branch.
  A blog post created at the root gets told where it belongs. Updates merge instead of wiping fields.
- **Long text survives the trip.** `set_field` takes one flat string, because some clients mangle long
  strings nested in JSON.
- **Files from the agent's own machine.** `create_upload_link` gives the agent a 15-minute upload URL;
  no base64 through the context window.
- **Tested the way agents use it.** CI drives the real MCP server through editorial tasks — a
  deterministic driver on every push, a real model every week — and tool descriptions are graded
  publicly (the Glama badge above). The full rules are in
  [`CLAUDE.md`](CLAUDE.md#agent-api-design-rules-mcp--write-endpoints).

**Where to start****Where to start**

| You want to… | Go to |
|---|---|
| Connect an AI agent | [Connect your agent](#connect-your-agent) · [MCP setup](#mcp-setup) |
| Try it in five minutes | [Quickstart](#quickstart) · [Windows, no experience needed](#-windows-no-experience-needed) |
| Build a website on it | [Astro starter](https://github.com/hybriden/paperboy-astro-starter), then [`@paperboycms/client`](packages/client) and [`@paperboycms/preview`](packages/preview) |
| Run it for real | [Production](#production) · [Backups](#backups) |
| Work on the CMS itself | [Developing](#developing) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CLAUDE.md`](CLAUDE.md) |

## See it

**Click any text on your page and edit it right there.** The preview is your real frontend, not a mock-up, and it updates as you type.

<img alt="Clicking the heading on the page opens an editor; typing changes the page live" src="docs/screenshots/on-page-editing.gif">

**Your site stays yours.** This is the [Astro starter](https://github.com/hybriden/paperboy-astro-starter)'s demo site, every page of it built through the Management API. One command runs it with the CMS: `docker compose -f docker-compose.demo.yml up -d --build`.

<img alt="The demo site: home page, an article, and the article on a phone" src="docs/screenshots/site.jpg">

## Highlights

**Built for agents**
- **MCP server** — OAuth 2.1 sign-in or site-scoped tokens; acts as a user and lists only the tools that user's role can use. See [why MCP-first](#why-mcp-first-means-more-than-an-mcp-server).
- **Secure by default** — Argon2id, server-side sessions, CSRF, TOTP 2FA, deny-by-default RBAC with object-level scopes, append-only audit log.
- **Typed client SDK** — [`@paperboycms/client`](packages/client), typed from the same Zod schemas the server serializes with. No codegen.

**Content**
- **Content types are data** — pages, blocks and globals are defined in the admin, not in code. Content areas hold inline or shared blocks; a built-in template library covers the essentials.
- **Multisite** — several sites in one instance, each with its own delivery keys, media, preview URL and start page. Types, languages and users are shared.
- **Multi-language** with a fallback chain, hierarchical URLs from the page tree, version history, trash. Translation gaps show in the tree and on the dashboard.
- **Forms with submissions in _your_ database** — a form is content. Delivery ships it as a schema, submissions are validated server-side against the published form, and errors come back per field. Spam checks on by default, retention runs, erase-by-email is one audited action.

**Delivery**
- **One read path, no leaks** — public keys see published content, preview keys see drafts, private fields never serialize. Lists filter, sort, paginate and search; every item carries `fieldTypes` so frontends switch on schema.
- **SEO and structured data computed by the CMS** — meta, canonical, OpenGraph, Twitter and JSON-LD (Organization, breadcrumbs, FAQ Question/Answer, `dateModified`) on every page. Preview is always `noindex`.
- **Public files generated from content** — robots.txt, sitemap.xml, llms.txt and security.txt.
- **Redirects that keep link equity** — a rename or move records a 301 on publish. The frontend matches one manifest with `matchRedirect`; a 404 log shows what visitors miss.
- **Image transforms** — `?w=800&format=webp&q=75` on any media URL, generated once and cached.
- **Webhooks** — HMAC-signed `content.published`, `form.submitted` and `delivery.changed` for every move, sort or settings change, so a cache can purge on webhooks alone.

**Editing**
- **Visual on-page editing** — click an element in the preview to edit its field, drag blocks onto the page, cross-origin included. The bridge is [`@paperboycms/preview`](packages/preview).
- **Admin** — React 19, light/dark, ⌘K palette, keyboard-operable drag-drop, axe-clean. The dashboard deep-links gaps, missing alt text and unused blocks.
- **AI writing assistant** (optional; Anthropic or any OpenAI-compatible endpoint) — improve, rewrite, translate, alt text from the image, schema.org suggestions. With no key it refuses instead of faking output.

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

## Quickstart

**1. Run the CMS** (Docker):

```bash
./scripts/setup.sh       # writes .env with unique secrets and your admin password — required
docker compose up -d     # db → init (migrate + seed) → api, which also serves the admin
# Admin  http://localhost:8090    API  http://localhost:8091  (OpenAPI UI at /api/docs)
```

`setup.sh` is safe to re-run and never overwrites `.env`. Paperboy refuses to boot on the
placeholder secrets in this repo and refuses to seed production with the published demo login.

**2. Run the website.** The [Astro starter](https://github.com/hybriden/paperboy-astro-starter)
renders every built-in content type and is where your site lives:

```bash
git clone https://github.com/hybriden/paperboy-astro-starter my-site
cd my-site && npm install && npm run setup && npm run dev   # http://localhost:4321
```

The admin's side-by-side preview points at `http://localhost:4321` by default. `apps/web` in this
repo is a Next.js contract reference, not a site to build on; it is opt-in
(`docker compose --profile web up -d web`, :8092).

### 🪟 Windows, no experience needed

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

> ⚠️ Never run `docker compose down -v` once you have content: `-v` deletes the database.
> If a page won't load, check that Docker Desktop says **Engine running**.

## Production

The generated `.env` targets localhost. Before exposing a real host set `COOKIE_SECURE=true`, drop
`ALLOW_INSECURE_COOKIES`, and point `CORS_ORIGIN` at the admin's HTTPS origin. Redeploy one service
with `docker compose up -d --no-deps --force-recreate <svc>`; the seed refuses to wipe a database that
holds content unless `FORCE_SEED=1`. The deploy-safety rules are in [`CLAUDE.md`](CLAUDE.md#%EF%B8%8F-deploy-safety-most-important-rule).

**Without a VM.** One container, no proxy: it fits any "run a container" platform (App Service,
Container Apps, Cloud Run, Fly, Render, Railway) plus a managed Postgres.

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

**Accounts.** Your admin login is what `setup.sh` printed. The demo logins (`editor@`, `author@`,
`viewer@`, passwords `<Role>!Passw0rd`) are development fixtures: a production seed creates only the
admin unless `ALLOW_DEMO_CREDENTIALS=true`.

## Backups

Nothing backs itself up. [`ops/backup.sh`](ops/backup.sh) is a working reference: nightly `pg_dump`
plus a tar of the uploads volume, 14-day rotation, alert on failure. It refuses to succeed with an
empty media archive and writes mode-600 files, because **a backup is a full credential dump** and,
once you have forms, visitor personal data. Cron lines and the restore procedure are in
[`ops/README.md`](ops/README.md). Known gap: backups land on the same disk as the data; add one
`rclone copy` line once you have a bucket.

## MCP setup

```bash
# Mint a token in Settings → MCP, then run locally over stdio:
MCP_TOKEN=mcp_… DATABASE_URL=postgresql://… pnpm --filter @paperboy/mcp start
# …or over Streamable HTTP for remote clients:
docker compose --profile mcp up -d --no-deps mcp      # → https://<your-domain>/mcp
```

The MCP acts as a Paperboy user and inherits its permissions. Tokens are minted per site (or for
every site); `PAPERBOY_SITE` pins a server to one site, and every tool also takes a per-call `site`.

**OAuth for remote clients.** Add `https://<your-domain>/mcp` as a connector in Claude or Cursor. The
client registers itself, sends you through Paperboy's own login (with 2FA), and a consent screen asks
which site the connection may work in. Revoke it in Settings → Connected apps. One domain is enough:
the API forwards `/mcp` and serves `/.well-known/oauth-*`. For other layouts set `PUBLIC_URL` (the
issuer, default `CORS_ORIGIN`) and `MCP_PUBLIC_URL` (default `{PUBLIC_URL}/mcp`) on both `api` and `mcp`.

**Files from the agent's machine.** `create_upload_link` mints a 15-minute link the agent `curl`s files
to (`POST /api/v1/uploads`, 20 files of 5 MB per request). `upload_asset` takes a public URL or base64.

## The npm packages

Frontends integrate against these two packages, not the CMS codebase. Both are versioned independently.

**[`@paperboycms/client`](packages/client)** — dependency-free, typed end to end:

```ts
import { createClient, mediaUrl } from "@paperboycms/client";

const cms = createClient({ baseUrl: "https://cms.example.com", key: process.env.PAPERBOY_PUBLIC_KEY! });
const post = await cms.getBySlug<BlogPost>("hello-world", { locale: "en" });
const { items } = await cms.list<BlogPost>("BlogPost", { sort: "-data.publishDate", limit: 10 });
const src = mediaUrl(post!.data.image, { w: 640, format: "webp" });
```

Also `getByPath`, `startPage`, `global`, `search`, render helpers that follow `fieldTypes`,
`matchRedirect`, preview-token verification and an optional ETag cache. 404s return `null`, other
errors throw `PaperboyError`. [Full README](packages/client/README.md).

**[`@paperboycms/preview`](packages/preview)** — zero-dependency bridge that makes any frontend
editable inside the admin's preview. Call `initPreviewBridge()` in preview mode and mark the DOM with
`data-pb-field`, `data-pb-area` and `data-pb-block-index` (or let the client's `pbAreaAttrs` emit
them). [Full README](packages/preview/README.md).

## Developing

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

```bash
pnpm install
docker compose up -d db
export DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy
pnpm db:seed
pnpm dev                                    # api :8091, admin :8090, web :8092

pnpm --filter @paperboy/api test            # integration tests against a real Postgres
pnpm --filter @paperboy/admin test:e2e      # Playwright e2e + axe
```

CI also runs the MCP usability eval (`evals/`) on every push with a deterministic mock driver and
weekly with a real model. Rules of the road: [`CONTRIBUTING.md`](CONTRIBUTING.md). Everything about
deploy safety, auth, the content model and the incidents behind each rule: [`CLAUDE.md`](CLAUDE.md).
Stack choices: [`STACK.md`](STACK.md). Research behind the bigger features: [`docs/plans/`](docs/plans).
Vulnerabilities: [`SECURITY.md`](SECURITY.md).

## License
[MIT](./LICENSE) — *Don't Pay eXtra.* 📰
