# Building a frontend on Paperboy

Paperboy is headless: your site is a separate app that reads content over the
Delivery API. The [Astro starter](https://github.com/hybriden/paperboy-astro-starter)
does all of this already, and [`apps/web`](../apps/web) is a Next.js reference.
This page is for everything else: SvelteKit, Nuxt, Remix, a Cloudflare Worker,
plain `fetch`. It lists the six contracts a frontend honours, each with a sample.

The samples use [`@paperboycms/client`](../packages/client) (typed, zero
dependencies) and are written as plain `(request: Request) => Response` handlers,
the shape SvelteKit endpoints, Remix loaders, Astro and Workers all share.

```sh
npm install @paperboycms/client            # + @paperboycms/preview for on-page editing
```

Against a local `docker compose up` stack, the API is `http://localhost:8091`
and the keys are in your `.env` (`PAPERBOY_PUBLIC_KEY`, `PAPERBOY_PREVIEW_KEY`).

## 1. Fetching

```ts
import { createClient } from "@paperboycms/client";

const cms = createClient({
  baseUrl: process.env.PAPERBOY_API_URL!,    // http://localhost:8091
  key: process.env.PAPERBOY_PUBLIC_KEY!,     // published content only
  etagCache: true,                           // conditional GETs for hot content
});

const home = await cms.startPage({ locale: "en", populate: 2 });
const page = await cms.getByPath("/about", { locale: "en", populate: 2 }); // null on 404
const settings = await cms.global("SiteSettings", { locale: "en" });
```

- **`populate`** resolves references and shared blocks that many levels deep.
  Content areas need at least `1` to carry shared blocks' content.
- **A missing page is `null`**, never a throw. Anything else non-OK throws a
  `PaperboyError` with `status` and `message`.
- **The preview key (`prv_…`) sees drafts.** Keep both keys server-side.

## 2. Rendering

Every delivered item carries `fieldTypes`: the declared type of each public
field. Switch on it, not on the value. An empty richtext field is still
richtext, and an empty content area is still an area.

```ts
import { blockData, contentAreas, renderKind, renderRichText } from "@paperboycms/client";

function renderField(name: string, value: unknown, fieldTypes: Record<string, string>): string {
  switch (renderKind(fieldTypes[name])) {
    case "richtext": return renderRichText(value);          // TipTap JSON → sanitized HTML
    case "markdown": return yourMarkdown(String(value ?? "")); // bring your own renderer
    case "text":     return escapeHtml(String(value ?? ""));
    default:         return "";                              // image, reference, area, …
  }
}

for (const area of contentAreas(page!.data, page!.fieldTypes)) {
  for (const block of area.blocks) {
    const data = blockData(block); // inline → block.data, shared → block.content.data
    // pick a component by block.blockType (shared: block.content.type)
  }
}
```

- **Inline blocks** carry `data` and their own `fieldTypes`. **Shared blocks**
  (`shared: true`) carry the resolved document in `content`, with its
  `documentId`, `type`, `data` and `fieldTypes`.
- **Images** arrive as objects (`{ url, alt, … }`). Use `mediaUrl(image.url, { w: 640 })`
  and `mediaSrcset(image.url)` for resized variants.
- **SEO** is computed by the CMS: every page has `seo` (meta, canonical,
  Open Graph, JSON-LD). Emit it; don't rebuild it. See the
  [client README](../packages/client/README.md#seo).

## 3. Preview

The admin shows drafts by framing your site at
`{previewBaseUrl}/{locale}{urlPath}?pbt=<token>`, where `previewBaseUrl` is the
site's preview URL (Settings → General). Your frontend must therefore:

- **accept a locale prefix** on every page URL (`/en/about`, `/nb/om-oss`), and
- **verify `?pbt=`** server-side, then fetch with the preview key.

```ts
import { createClient } from "@paperboycms/client";
import { verifyPreviewToken } from "@paperboycms/client/preview-token";

async function clientFor(url: URL) {
  // PREVIEW_SECRET must equal the API's. This subpath never goes in a browser bundle.
  const preview = await verifyPreviewToken(process.env.PREVIEW_SECRET!, url.searchParams.get("pbt"));
  const key = preview ? process.env.PAPERBOY_PREVIEW_KEY! : process.env.PAPERBOY_PUBLIC_KEY!;
  return { preview, cms: createClient({ baseUrl: process.env.PAPERBOY_API_URL!, key }) };
}

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const [, locale = "en", ...rest] = url.pathname.split("/");
  const { preview, cms } = await clientFor(url);
  const page = rest.length ? await cms.getByPath(`/${rest.join("/")}`, { locale, populate: 2 }) : await cms.startPage({ locale, populate: 2 });
  if (!page) return notFound(url); // section 5
  return html(renderPage(page, { preview }), preview ? { "cache-control": "no-store" } : {});
}
```

**Shared blocks are previewed on their own** at
`{previewBaseUrl}/{locale}/preview/block/{documentId}?pbt=<token>`. Add that
route: return 404 unless the token verifies, then fetch the block with
`cms.getById(documentId, { locale, populate: 2 })` and render it with the same
component you use inline. Without it, a block's Side-by-side view shows a hint
until the editor picks a host page. The reference is
`apps/web/app/[locale]/preview/block/[documentId]`.

## 4. On-page editing

In preview, editors click text on your page to edit it. That needs the
browser-side bridge and a few `data-pb-*` attributes. Load it **only in
preview**: on a public page it would be an `innerHTML` sink.

```ts
// in the browser, when the page was rendered in preview
import { initPreviewBridge } from "@paperboycms/preview";
initPreviewBridge({ parentOrigin: "https://cms.example.com" }); // the admin's origin
```

```ts
import { pbAreaAttrs } from "@paperboycms/client";

// a field:            <h1 data-pb-field="heading">…</h1>
// a content area:     <div {...pbAreaAttrs(area.field, preview)}>   → data-pb-area="<field name>"
// each block in it:   <section data-pb-block-index="0" data-pb-block-type="CardBlock">
// a field in a block: <h3 data-pb-field="title">…</h3>             (inside the block element)
```

`data-pb-area` must be the content area's **field name**; the editor maps a
dropped block to that field. `pbAreaAttrs` writes it and returns `{}` outside
preview. Details: the [preview README](../packages/preview/README.md).

## 5. Redirects

Redirect rules live in the CMS. A rule applies **only where no published page
answers**, so fetch the page first and look at the rules on a 404:

```ts
import { matchRedirect } from "@paperboycms/client";

async function notFound(url: URL): Promise<Response> {
  const hit = matchRedirect(await cms.redirects(), url.pathname + url.search); // cache the manifest ~60 s
  void cms.reportTraffic(hit ? { redirectHits: [hit.rule.id] } : { notFound: [url.pathname] }); // public key, server-side
  if (hit?.location) return Response.redirect(new URL(hit.location, url).href, hit.status);
  if (hit) return new Response("Gone", { status: 410 });
  return new Response("Not found", { status: 404 });
}
```

Don't write your own matcher: `matchRedirect` normalizes case, trailing
slashes and `/prefix/*` rules exactly like the CMS does. `reportTraffic` feeds
the hit counts and the 404 log in Settings → Redirects.

## 6. Public files

`robots.txt`, `sitemap.xml`, `llms.txt` and `security.txt` are generated by the
CMS from what is published (Settings → General → Public files). Your site only
serves them from its own origin:

```ts
const FILES = new Set(["/robots.txt", "/sitemap.xml", "/llms.txt", "/security.txt"]);

export async function publicFile(url: URL): Promise<Response | null> {
  if (!FILES.has(url.pathname)) return null;
  const res = await fetch(`${process.env.PAPERBOY_API_URL}/api/v1/delivery${url.pathname}`, {
    headers: { authorization: `Bearer ${process.env.PAPERBOY_PUBLIC_KEY}` },
  });
  if (!res.ok) return new Response("Not found\n", { status: 404 }); // e.g. no security contact set
  return new Response(await res.text(), {
    headers: { "content-type": res.headers.get("content-type") ?? "text/plain", "cache-control": "public, max-age=300" },
  });
}
```

The generated URLs use `{canonicalBaseUrl}/{locale}{urlPath}`, or no prefix for
the default locale when Settings → General → Language in URLs says so. A site
with another URL scheme builds its own sitemap from `GET /api/v1/delivery/pages`.

## 7. A/B experiments

A page under test carries `experiments`; its areas in `data` stay version A.
Pick the version on the SERVER before rendering (swapping in the browser
flickers), and count it after the response:

```ts
import { applyExperiments } from "@paperboycms/client";

const { item, exposures } = applyExperiments(page, {
  visitorKey,                                        // below; none → version A
  force: preview ? url.searchParams.get("pbab") : null, // the admin's version picker, preview only
});
render(item, exposures);                             // forms send exposures on submit
if (!preview) waitUntil(cms.reportTraffic({ exposures }).catch(() => {})); // public key, never awaited
```

- **Visitor key.** By default a fresh random value per page view: nothing is
  stored on the device, so only a goal on the same page (a form) is attributed.
  To keep a visitor on one version, use a first-party random id cookie (at most
  13 months), set **only after consent**: in Norway a cookie that remembers the
  version needs consent (ekomloven §3-15), so never list it as strictly
  necessary. Without consent, fall back to the per-view key.
- **Robots get A.** Never branch on the user agent; that is cloaking.
- **Forms carry the exposures**: `submitForm(id, { …, experiments: exposures })`
  counts a conversion for experiments whose goal is `form`. Other goals report
  `conversions` through `reportTraffic`.
- **Cache privately.** A page under test is `Cache-Control: private` (or puts
  the version in the cache key); a shared cache would pin one version for all.

apps/web is the reference: `app/lib/ab.ts` (`PAPERBOY_AB_MODE` =
`cookieless` | `consent`, consent cookie `PAPERBOY_AB_CONSENT_COOKIE`, default
`pb_consent`), the page route and `proxy.ts`.

## Checklist

- [ ] Pages answer at `/{locale}{urlPath}`, and the start page at `/{locale}`.
- [ ] Rendering switches on `fieldTypes`.
- [ ] `?pbt=` is verified server-side and switches to the preview key; preview responses aren't cached.
- [ ] `/{locale}/preview/block/{documentId}` renders a shared block (404 without a valid token).
- [ ] The preview bridge and `data-pb-*` attributes appear in preview only.
- [ ] A 404 consults `matchRedirect` before answering 404.
- [ ] The four public files are proxied.
- [ ] A/B versions are picked server-side, reported, sent with forms, and cached privately; a remembering cookie only with consent.
- [ ] Neither delivery key nor `PREVIEW_SECRET` reaches the browser.
