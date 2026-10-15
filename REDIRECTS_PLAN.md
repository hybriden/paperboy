# Redirects: research and decisions

Settings → Redirects keeps a site's link equity when URLs change: a page is
renamed or moved, or a whole site moves onto Paperboy from another platform. This
document records what other platforms do, what goes wrong with them, and what we
chose. The code is `packages/db/src/redirects.ts` (rules), `packages/shared/src/redirects.ts`
(the pure matcher), `apps/api/src/routes/{redirects,traffic}.ts` and
`apps/admin/src/components/views/RedirectsPanel.tsx`.

## What search engines want

From Google Search Central ([redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects),
[site moves](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes)):

- **Permanent server-side redirects (301/308)** tell Google the target is the new
  canonical URL. Temporary ones (302/307) keep the old URL in results.
- **One hop.** Google follows up to 10, but recommends redirecting straight to the
  final URL; chains slow crawling and lose signals in practice.
- **Keep redirects for at least a year**, for users ideally forever.
- **Don't send everything to the home page** — Google treats that as a soft 404.
  Removed content should answer 404 or 410.
- `/a` and `/a/` are different URLs; pick one and redirect the other.

## What others do

| | Where rules live | Target | Auto on rename/move | 404 log | Notes |
|---|---|---|---|---|---|
| Umbraco (core) | CMS | the node (follows it) | yes, with descendants | no | list + delete only |
| Drupal Redirect | CMS | path or entity | yes, on alias change | `redirect_404` + "fix 404" | warns on loops |
| Craft Retour | CMS (+ API for headless) | path or entry | yes | yes, "+" creates a rule | hit count + last hit, CSV, regex |
| Payload plugin | CMS collection | document or URL | no | no | the frontend applies them |
| Sitecore XM Cloud | CMS, fetched per request by middleware | path | no | no | regex costs latency per request |
| Contentful, Storyblok, Sanity, Optimizely Graph | nothing built in | — | — | — | every customer hand-rolls middleware |
| WordPress Redirection / Yoast | CMS | URL | Yoast prompts on slug change and delete | yes | full IP logged by default |
| Shopify | platform | path | checkbox on handle change | no | applies only when the old URL 404s |
| Webflow, Wix, Squarespace, HubSpot | platform | path | Wix: yes | no | CSV import; Webflow import replaces everything |

## Common complaints we designed against

1. **Chains from repeated renames** (A→B, then B→C leaves A→B→C) and **loops**
   (renaming back gives A→B and B→A; Drupal shipped both as bugs).
2. **A stale rule hijacking a live page** published again at the old URL.
3. **Regex**: slow at the edge, easy to over-match, confusing escaping.
4. **404 logs**: flooded by scanners, full IPs stored, query strings carrying
   emails and reset tokens, unbounded growth.
5. **Headless gap**: the frontend has to reinvent matching, usually without
   trailing-slash or query handling.
6. **Imports that replace everything** (Webflow) or fail silently.

## Decisions

- **Rules live in the CMS, per site** (`redirect` table, migration 0031), and the
  frontend applies them from one manifest: `GET /delivery/redirects`. Matching is
  `matchRedirect` in `@paperboycms/client`, the same code the CMS uses (pinned by
  `client-redirects.test.ts`), so nobody re-implements it.
- **A rule fires only where no published page answers** (complaint 2). The
  frontend asks for the page first and consults the manifest on a 404. A rule
  whose source is a live page is shown as *shadowed* instead of silently idle.
- **A target can be a page** (complaint 1). It is resolved to the page's live URL
  when the manifest is built, so moving the page again never adds a hop. A typed
  path that a published page answers is stored as that page.
- **One hop, enforced at write.** A path target that is itself redirected is
  collapsed to the final destination; rules pointing at a new rule's source are
  re-pointed; anything that would loop is refused with a self-teaching 422.
- **Automatic 301s** when publishing or moving changes a page's public URL, for
  the whole subtree and every locale (`trackUrlChanges`, wrapped around publish,
  scheduled publish and move). Renaming back removes the now-pointless rule. An
  editor's own rule for the same path is never overwritten.
- **No regex** (complaint 3): exact paths and a trailing `/*` prefix, which
  carries the rest of the path over. Case and trailing slash are ignored;
  the query string is passed along unless the rule says otherwise.
- **The 404 log stores the path only** (complaint 4): no query string, no IP, no
  user agent; scanner paths (`.php`, `/wp-admin`…) are dropped; one row per path
  with a counter; 90-day retention and a 2,000-path cap per site, swept hourly.
  Old-site media (`/wp-content/uploads/…`) is deliberately *not* treated as noise.
- **Traffic reporting** (`POST /delivery/traffic`) is the second public write,
  built like form submissions: its own module, the public delivery key as the only
  credential, never a cookie. Frontends call it server-side, fire-and-forget.
- **Verification in the admin**: "Test a URL" follows any address hop by hop and
  says whether it ends on a page in one hop; every rule shows its problems
  (target missing or unpublished, shadowed, chain, loop); hit count and last hit
  show what is used, and an "Unused 12 months" filter shows what may be pruned.
- **CSV import with a dry-run preview** and per-row errors; existing sources are
  updated, never duplicated, and nothing is replaced wholesale (complaint 6).
- **Locale prefix per site** (`site.locale_prefix`): `always` (`/en/about`) or
  `except-default` (`/about` for the default locale). The CMS needs it to turn a
  page into the URL a visitor requests; the sitemap and llms.txt use it too.
- **Permissions**: reading needs `content.read`; writing needs `content.publish`,
  the same as the rest of the site's public setup. Every write is audited, and the
  MCP has the same tools (`list_redirects`, `create_redirect`, `update_redirect`,
  `delete_redirects`, `test_redirect`, `list_not_found`).

## Not built (yet)

- Regex or named-segment patterns (`/blog/:year/:slug`).
- A prompt on trash ("redirect to… or 410?") like Yoast's; for now the 404 log
  surfaces the gap.
- Per-rule conditions (referrer, device), domain-level rules (the edge or DNS
  handles `example.com` → `www.example.com` better).
- A "Redirects to this page" panel in the page editor (the list API already
  filters by `targetDocumentId`).
