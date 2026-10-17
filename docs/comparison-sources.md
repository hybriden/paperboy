# Sources for the README comparison table

Every non-Paperboy cell in "How it compares" was checked against the vendor's own docs, repo, pricing or changelog on **2026-10-17**. Paperboy cells point at this repo. If a cell has gone stale, open a PR against both the table and this file.

Row order follows the table.

## Strapi

1. **License.** Repo `LICENSE` grants MIT only outside `ee/` directories; `ee/` is under the Strapi Enterprise Software License. Self-hosted pricing lists Live Preview, Releases, Content History, SSO (Growth) and Review Workflows, Audit Logs (Enterprise) as paid. https://github.com/strapi/strapi/blob/develop/LICENSE · https://strapi.io/pricing-self-hosted
2. **Deploy.** "Strapi does not build any official container images"; one Node process plus PostgreSQL/MySQL/MariaDB/SQLite. https://docs.strapi.io/cms/installation/docker · https://docs.strapi.io/cms/configurations/database
3. **Forms.** No core form builder. Third-party `strapi-plugin-form-builder-cms` (v1.1.0-rc.1, 2026-07-10) keeps a submission inbox in the admin and validates per field server-side. https://registry.npmjs.org/strapi-plugin-form-builder-cms
4. **SEO.** `@strapi/plugin-seo` adds meta title/description/social fields and a SERP preview; no JSON-LD. Repo archived 2026-04-07 and moved to strapi-community. https://github.com/strapi-community/strapi-plugin-seo
5. **Redirects.** No core feature. Third-party `strapi-plugin-smart-redirect` (v0.1.2, 2026-03-15) creates a redirect on slug change. https://registry.npmjs.org/strapi-plugin-smart-redirect
6. **MCP.** Built-in MCP server at `/mcp`, opt-in, GA announced 2026-09-03. Authenticates with Admin tokens; "each MCP session is scoped to the permissions of the token used to connect", and a token is a subset of its owner's permissions. https://docs.strapi.io/cms/features/strapi-mcp-server · https://docs.strapi.io/cms/features/admin-tokens · https://strapi.io/blog/the-strapi-mcp-server-is-now-ga
7. **Multisite.** "There is no built-in way to silo content by site. The recommended approach is one Strapi deployment per site." https://support.strapi.io/articles/6674305924-how-multi-project-deployments-work-in-strapi
8. **Visual editing.** Basic Preview free since v5.6.0; side-by-side Live Preview with double-click in-place editing (Strapi 5.12, 2025-05-13) is "available only with the CMS Growth and Enterprise plans". https://docs.strapi.io/cms/features/preview · https://strapi.io/blog/introducing-live-preview-client-library
9. **GraphQL.** `@strapi/plugin-graphql`, in the monorepo but installed separately. https://docs.strapi.io/cms/plugins/graphql
10. **Hosted.** Strapi Cloud: Starter $35, Pro $90, Business $450 per project per month. Free plan removed effective 2026-07-01. https://strapi.io/pricing-cloud · https://strapi.io/blog/we-re-removing-the-free-plan-from-strapi-cloud

## Payload

1. **License.** `LICENSE.md` is MIT, "Copyright (c) 2018-2026 Payload CMS, LLC". Enterprise page lists SSO, Enterprise AI, Publishing Workflows, A/B testing and a "Visual Editor (Coming Soon)" behind "Schedule a Demo". https://github.com/payloadcms/payload/blob/main/LICENSE.md · https://payloadcms.com/enterprise
2. **Deploy.** Runs inside Next.js; MongoDB, Postgres or SQLite adapters. Docs ship a Dockerfile; the org publishes no Payload app image. https://payloadcms.com/docs/production/deployment · https://github.com/orgs/payloadcms/packages
3. **Forms.** Form Builder plugin stores submissions in a `form-submissions` collection. The collection source validates only `typeof value !== 'undefined'` with a comment marking the gap; issue #50 "Need to wire up submission validations" closed not-planned 2023-12-12. https://payloadcms.com/docs/plugins/form-builder · https://github.com/payloadcms/payload/blob/main/packages/plugin-form-builder/src/collections/FormSubmissions/index.ts · https://github.com/payloadcms/plugin-form-builder/issues/50
4. **SEO.** Plugin adds a `meta` group with `title`, `description`, `image`; OG and JSON-LD only as custom fields you add. https://payloadcms.com/docs/plugins/seo
5. **Redirects.** Plugin adds a `redirects` collection; its entry point registers no hooks on other collections, so nothing watches slug changes. https://payloadcms.com/docs/plugins/redirects · https://github.com/payloadcms/payload/blob/main/packages/plugin-redirects/src/index.ts
6. **MCP.** `@payloadcms/plugin-mcp` (beta since v3.61.0, 2025-10-23). "All MCP requests must include a valid API key as a Bearer token"; "requests authenticated with a key act as its owner". https://payloadcms.com/docs/plugins/mcp
7. **Multisite.** `@payloadcms/plugin-multi-tenant` merges a tenant constraint into access control and rejects writes to tenants the user is not a member of. Local API skips access control by default. https://payloadcms.com/docs/plugins/multi-tenant
8. **Visual editing.** Live Preview (iframe + postMessage) is core with no element-to-field mapping; "Visual Editor: Point, click, edit" is listed under Enterprise as "Coming Soon". https://payloadcms.com/docs/live-preview/overview · https://payloadcms.com/enterprise/visual-editor
9. **GraphQL.** Core; `@payloadcms/graphql` is a hard dependency of `@payloadcms/next`, disableable. https://payloadcms.com/docs/graphql/overview
10. **Hosted.** "Deployment of new projects is currently paused, existing Cloud projects will continue running as normal." https://payloadcms.com/payload-has-joined-figma

## Directus

1. **License.** Repo `license` is the Monospace Sustainable Core License 1.0 (relicensed from BUSL-1.1 in v12.0.0, 2026-06-10); each release converts to GPL-3.0 after four years. Unlicensed self-hosted instances run the Core tier: 3 seats, 25 collections, 5 flows. https://github.com/directus/directus/blob/main/license · https://github.com/directus/directus/releases/tag/v12.0.0 · https://directus.com/pricing
2. **Deploy.** Official `directus/directus` image; needs a database and a `SECRET`; PostgreSQL, MySQL, MariaDB, SQLite, MS SQL, CockroachDB, Oracle. https://directus.com/docs/self-hosting/deploying · https://directus.com/docs/self-hosting/requirements
3. **Forms.** No form module; the framework guides model `forms` and `form_submissions` as collections and create items through the public API. https://directus.com/docs/frameworks/nextjs/forms
4. **SEO.** `@directus-labs/seo-plugin` stores title, description, OG image and noindex; its listing says the frontend must output the tags. https://directus.com/extensions/@directus-labs/seo-plugin
5. **Redirects.** No core feature and nothing in the 57 Labs packages. https://github.com/directus-labs/extensions/tree/main/packages
6. **MCP.** Native since v11.12.0 (2025-09-16), out of beta in 11.13.0; authenticates with a user's token or, since v12.0.0, OAuth 2.1, and "uses the same permissions as the user account". https://github.com/directus/directus/releases/tag/v11.12.0 · https://directus.com/docs/guides/ai/mcp/installation
7. **Multisite.** Directus's own "Mission: Multisite CMS" builds it as a `sites` collection with M2O relations and per-user permission filters; "a big exercise in data modeling". https://directus.com/tv/100-apps-100-hours/multisite-cms
8. **Visual editing.** Visual Editor beta in v11.6.0 (2025-03-25); hovering highlights `data-directus` elements and an edit control opens a drawer. https://github.com/directus/directus/releases/tag/v11.6.0 · https://directus.com/docs/guides/content/visual-editor/studio-module
9. **GraphQL.** Core, served at `/graphql`. https://directus.com/docs/api
10. **Hosted.** Directus Cloud managed hosting as a $99/month add-on (pricing page dated 2026-10-14). https://directus.com/pricing

## Sanity

1. **License.** "Sanity Studio is available under the MIT License"; content lives in the hosted Content Lake. https://github.com/sanity-io/sanity
2. **Deploy.** Studio can be self-hosted; it connects to Sanity's hosted APIs. Every plan lists "Fully hosted infrastructure". https://www.sanity.io/docs/setup-and-deployment · https://www.sanity.io/pricing
3. **Forms.** Official guide: author forms in an external service, or in Sanity with the external service as the "bucket" for submissions (Netlify Forms, Formspree). https://www.sanity.io/docs/developer-guides/forms-with-sanity
4. **SEO.** Sanity's SEO course has the Next.js component build JSON-LD from GROQ results. https://www.sanity.io/learn/course/seo-optimization/generating-json-ld-dynamically
5. **Redirects.** Guide: create a redirect document type and return it from `next.config.js`; automatic redirects on slug change are an official recipe you deploy as a Sanity Function. https://www.sanity.io/docs/developer-guides/managing-redirects-with-sanity · https://www.sanity.io/recipes/auto-generating-redirects-on-slugs-change-e7c88bfc
6. **MCP.** Local `@sanity/mcp-server` archived 2026-07-01 in favour of the remote server at mcp.sanity.io, which "uses OAuth by default to perform operations on your behalf"; an API token is the alternative. https://www.sanity.io/docs/ai/mcp-server · https://github.com/sanity-io/sanity-mcp-server
7. **Multisite.** Workspaces per project+dataset; Free and Growth include 2 datasets, extra datasets $999/dataset/month on Growth. https://www.sanity.io/docs/workspaces · https://www.sanity.io/pricing
8. **Visual editing.** "Click any element to jump to the right field"; Visual Editing and the Presentation tool are included on Free, Growth and Enterprise. https://www.sanity.io/docs/introduction-to-visual-editing · https://www.sanity.io/pricing
9. **GraphQL.** Deployed with `sanity graphql deploy`; Sanity recommends GROQ. https://www.sanity.io/docs/content-lake/graphql
10. **Hosted.** Free plan "$0 forever", Growth $15/seat/month, Enterprise custom; no self-hosted backend. https://www.sanity.io/pricing

## Paperboy

Each claim maps to a test or a module in this repo:

- Forms validated server-side against the published form: `submitForm` in `packages/db/src/forms.ts`, `forms-submit.test.ts`.
- SEO + JSON-LD on every page: `delivery-seo-contract.test.ts`, `delivery-structured-data.test.ts`.
- Automatic 301 on rename or move: `trackUrlChanges` in `packages/db/src/redirects.ts`, `redirects.test.ts`.
- MCP acts as the calling user, REST parity test-enforced: `apps/mcp/src/server.ts`, `mcp-parity.test.ts`, `mcp-http-transport.test.ts`, `mcp-oauth.test.ts`.
- Multisite enforced in the query layer: `mcp-site-selection.test.ts` and the chokepoints described in `CLAUDE.md` → Multisite.
- Visual click-to-edit: `@paperboycms/preview`, `apps/admin`.
- No GraphQL: the source contains no GraphQL layer. No hosted option is offered.
