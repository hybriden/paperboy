# Paperboy — stack & rationale

The guiding principle: a **schema-first, type-safe spine** from database to UI, with a
**structurally enforced** content-safety boundary (the delivery layer cannot leak drafts or
private fields). One Zod schema is the source of truth for runtime validation, response
serialization, OpenAPI, admin forms, and inferred TypeScript types — so nothing drifts.

| Layer | Choice | Why |
|------|--------|-----|
| Monorepo | pnpm workspaces | One source of truth for shared Zod schemas/types across API, admin and web; fast, content-addressed installs. |
| Language | TypeScript (Node 22 LTS) | End-to-end types; one language across API/SPA/SSR. |
| API | **Fastify v5** + `fastify-type-provider-zod` | One Zod schema per route drives **runtime validation + response serialization + OpenAPI 3.1** — no drift. Strong throughput for JSON-heavy delivery. |
| DB / ORM | **PostgreSQL 16** + **Drizzle** + drizzle-kit | SQL-close control over the explicitly relational content/version/locale model; partial unique indexes encode core invariants (one live published + one draft per variant). |
| Validation | **Zod** (shared package) | Single source of truth: API I/O, admin forms, and inferred TS types. |
| Auth | **Argon2id** + opaque server-side sessions (`__Host-` cookie) + synchronizer CSRF + TOTP 2FA | Instantly revocable, no XSS-exposed tokens; OWASP-baseline hashing; deny-by-default RBAC with object-level scope checks in the data layer. |
| Admin SPA | **React 19 + Vite + TanStack Query + react-router-dom + Radix UI + cmdk + TipTap + @dnd-kit** | Token-based design system (CSS variables), light/dark themes (system-pref + persisted), self-hosted fonts. Radix primitives for accessibility; ⌘K command palette; TipTap rich text; @dnd-kit keyboard-operable drag-drop + tree reorder; refresh-safe routing; 401 interceptor + error boundary; axe-clean in both themes. |
| Reference site | **Next.js 15 (App Router) Draft Mode** | A canonical headless consumer; the two-token preview model proves the no-leak boundary from a real frontend. Any framework can consume the Delivery API instead. |
| MCP | **`@modelcontextprotocol/sdk`** (stdio) | Drive the whole CMS from an AI client; the server calls the same data layer as the API, so it inherits RBAC + validation + the no-leak chokepoint + audit. |
| Tests | **Vitest** (Fastify `.inject()` + real Postgres) + **Playwright** + **@axe-core** | Integration-level proof against a real DB; browser e2e + automated accessibility. |
| Deploy | **Docker Compose** (multi-stage images, healthchecks, one-shot migrate/seed init) | Reproducible single-command deploy; migrations gate the API start. |

## What's included
- **Data-driven content types** (pages / blocks / globals) defined as data, not hardcoded.
- **Content areas** with inline + shared blocks and per-field "allowed types".
- A **no-leak Delivery API**: a single read chokepoint takes a `perspective` (published | preview); the public key is hard-filtered to published, and private fields never serialize.
- **Hierarchical URLs** from the page tree, document-level **i18n** with a fallback chain, and per-locale publish.
- **Visual on-page editing** — click an element in the live preview to focus its field in the editor, and focus a field to highlight it in the preview (two-way).
- **Passwordless TOTP 2FA**, RBAC roles, an append-only **audit log**, HMAC **publish webhooks**, media uploads, version history + restore, trash/restore, duplicate.
- **SEO/OpenGraph** metadata, an optional **AI editorial assistant** (meta, alt text, summarize/improve/translate), and a full **MCP server** with revocable tokens.

## Measured (Delivery API, `populate=2` reference graph)
```
throughput: 855 req/s · p50 19.4 ms · p95 45.9 ms · p99 95.1 ms   (20 concurrent, 500 reqs)
```

## Deliberately deferred
Stega live-edit, WebAuthn/SSO (OIDC), JWT, field-level i18n, multi-step editorial workflow,
scheduled publishing + queue, full-text/GraphQL search, CDN/WAF, multi-site, content export/import.
The architecture leaves room for each — the delivery chokepoint already takes a `perspective`,
the publish path already fires webhooks, and a job queue can layer on without new infra.
