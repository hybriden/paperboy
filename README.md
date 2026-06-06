# 📰 Paperboy

[![CI](https://github.com/hybriden/paperboy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hybriden/paperboy/actions/workflows/ci.yml)

**An open-source, headless CMS — editor-first, type-safe, batteries included.**

> **Paperboy ONE** — *Open, No Extras.*  ·  **DPX** — *Don't Pay eXtra.*
> A proper headless CMS without the enterprise "experience platform" invoice. Self-host it, own your content, ship.

**Built for teams of humans *and* agents.** Every write path — admin UI, REST, MCP — goes through the same
validation, permissions and audit trail; agents are first-class editors, not an integration afterthought
(the MCP↔API parity is [test-enforced](apps/api/test/mcp-parity.test.ts)). See [docs/POSITIONING.md](docs/POSITIONING.md).

A TypeScript monorepo: a Fastify Management + Delivery API, a React admin with visual
on-page editing, a Next.js reference frontend, and a stdio MCP server — on PostgreSQL.

## Highlights
- **Data-driven content types** — pages, blocks, and globals defined as data, not code.
- **Content areas** with inline + shared blocks and per-field "allowed types".
- **No-leak Delivery API** — one read chokepoint with a `perspective`; public keys see only published content, private fields never serialize, preview keys see drafts. Lists support **pagination, sorting and field filters** (`?limit=&offset=&sort=-data.publishDate&data.author=Jane`), plus **full-text search** (`/delivery/search?q=`).
- **Image transforms** — `?w=800&format=webp&q=75` on any media URL; variants generated once with sharp and cached on disk (widths/qualities snap to fixed steps).
- **Visual on-page editing** — click an element in the live preview to focus its field in the editor, and focus a field to highlight it in the preview (both ways).
- **Multi-language** (document-level i18n + fallback chain), **hierarchical URLs** from the page tree, **version history** + restore, **trash**/restore, **duplicate**.
- **Secure by default** — Argon2id + opaque server-side sessions + CSRF, **passwordless TOTP 2FA**, deny-by-default **RBAC** with object-level scope checks, append-only **audit log**.
- **Integrations** — HMAC **publish webhooks**, media uploads, SEO/OpenGraph metadata, an optional **AI editorial assistant**, and a full **MCP server** (drive the CMS from an AI client, with revocable tokens).
- **Great admin** — React 19 + Vite, light/dark themes, ⌘K command palette, accessible (axe-clean), keyboard-operable drag-drop.

## Layout
```
apps/api      Fastify v5 — Management API (auth/RBAC) + Delivery API (read-only, key-scoped)
apps/admin    React 19 + Vite — the editor (tree, content areas, live preview, on-page editing)
apps/web      Next.js 15 — reference headless frontend with Draft Mode preview
apps/mcp      stdio MCP server — operate the whole CMS over the Model Context Protocol
packages/shared  Zod schemas + shared types (single source of truth)
packages/db      Drizzle schema, migrations, query layer (object-level authz), seed
```
Any frontend (Next, Astro, SvelteKit, …) can be a Paperboy client by reading the Delivery
API over HTTP — it doesn't import the CMS, only the contract.

## Quickstart (Docker)
```bash
docker compose up -d            # db → init(migrate+seed) → api → web → admin
# Admin   http://localhost:8090   (admin@paperboy.test / Admin!Passw0rd)
# API     http://localhost:8091   (OpenAPI UI at /docs)
# Web     http://localhost:8092
```
> ⚠️ Redeploy one service with `docker compose up -d --no-deps --force-recreate <svc>`.
> A plain `docker compose up <svc>` re-runs the seed and **wipes data**. See `CLAUDE.md`.

## 🪟 Super-simple setup (Windows, no experience needed)

Never used a terminal before? Follow these steps exactly — copy/paste each command.

**1. Install Docker Desktop**
- Download it: https://www.docker.com/products/docker-desktop/
- Run the installer, click through with the defaults, then **restart your PC** if it asks.
- Open **Docker Desktop** from the Start menu and wait until the whale icon (bottom-left) says **Engine running**. Leave it open in the background.

**2. Get Paperboy onto your PC**
- Easiest way (no extra tools): go to the project page on GitHub, click the green **Code** button → **Download ZIP**, then right-click the downloaded file → **Extract All…**.
- You now have a folder like `paperboycms`. Remember where it is (e.g. your Downloads folder).

**3. Open a terminal in that folder**
- Open the `paperboycms` folder in **File Explorer**.
- Click the address bar at the top, type `powershell`, and press **Enter**. A blue window opens — that's your terminal, already pointed at the right folder.

**4. Start everything (one command)**
- Copy this line, paste it into the blue window (right-click to paste), and press **Enter**:
  ```powershell
  docker compose up -d
  ```
- The first run downloads things and takes a few minutes. When it finishes you'll get your prompt back.

**5. Open the admin**
- In your browser go to **http://localhost:8090**
- Log in with:
  - **Email:** `admin@paperboy.test`
  - **Password:** `Admin!Passw0rd`

That's it — you're running Paperboy. 🎉

**Everyday commands** (run them in the same blue window, inside the `paperboycms` folder):
- **Stop it:** `docker compose stop`
- **Start it again later:** `docker compose start`
- **See it running:** check Docker Desktop, or run `docker compose ps`

> ⚠️ Don't run `docker compose down -v` or re-run the setup once you've added content — it **wipes everything** and resets the login. Use **stop**/**start** instead.
>
> 💡 If a page won't load, make sure Docker Desktop is open and says **Engine running**, then try again.

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
pnpm --filter @paperboy/api test            # integration tests (real Postgres)
pnpm --filter @paperboy/admin test:e2e      # Playwright e2e + axe accessibility
```

## MCP
```bash
# Mint a token in the admin (Settings → MCP), then:
MCP_TOKEN=mcp_… DATABASE_URL=postgresql://… pnpm --filter @paperboy/mcp start   # stdio (local clients)

# …or serve it over Streamable HTTP for remote clients (Bearer = MCP_TOKEN):
MCP_TOKEN=mcp_… docker compose --profile mcp up -d --no-deps mcp                 # → http://<host>:8093/mcp
```
The MCP authenticates as a Paperboy user (token or email+password) and inherits its RBAC. The default transport is stdio; set `MCP_HTTP_PORT` (or use the compose `mcp` profile) to expose it over HTTP for remote clients.

### Agent-ready by design
The MCP surface is hardened against the ways LLM agents actually fail — every one of these came out of running real agent workloads against it:

- **No silent damage** — input is either coerced *meaning-preservingly* (a TipTap doc sent to a markdown field becomes real Markdown, `{en: "…"}` locale wrappers unwrap, a resolved asset object collapses to its id) or **rejected with a self-teaching error** that names the field, the expected shape, and a copyable example. A write never destroys content and reports success.
- **Serialization-proof writes** — `set_field(documentId, field, value)` writes one field as a flat string parameter, because long strings nested inside record arguments don't survive some clients' tool-call JSON repair (they arrive as `{}`).
- **Safe defaults** — `update_content` merges over the draft by default (a full replace that drops required fields would brick the next publish), and pages **auto-slug from their name** so agent-created content is always reachable.
- **A diagnosable trail** — tool errors are logged with their arguments (`docker logs`), and every MCP write lands in the same append-only audit log as the admin/API (`ip=mcp`).
- **Discoverable contract** — `get_content_type` annotates every field with `valueFormat` + `valueExample`, so an agent learns the exact JSON shape from the schema instead of by trial and error.

The full rules (with the war stories behind them) live in [`CLAUDE.md`](./CLAUDE.md#agent-api-design-rules-mcp--write-endpoints--learned-from-real-failures).

## Seed accounts
`admin@` Admin · `editor@` Editor · `author@` Author (section-scoped) · `viewer@` Viewer — passwords follow `<Role>!Passw0rd`.

> Seeded credentials, keys, and secrets are **dev defaults** — rotate them before exposing the CMS (`SESSION_SECRET`, `CSRF_SECRET`, the delivery keys, `PREVIEW_SECRET`, and the admin password).

## Docs
- **`CLAUDE.md`** — how to develop & deploy safely (and how AI agents should work in the repo).
- **`STACK.md`** — the stack and the reasoning behind each choice.

## License
[MIT](./LICENSE) — do what you like. *Don't Pay eXtra.* 📰
