# @paperboycms/client

The typed Delivery API client. Thin, zero dependencies, end-to-end typed from
the same Zod schemas the server serializes with — no codegen step.

**Changes in 0.7.0** — `formToolAttrs(spec)` makes a rendered form a
[WebMCP](https://developer.chrome.com/docs/ai/webmcp) tool, and the honeypot from
`honeypotAttrs` is now `readOnly`, which keeps it out of that tool (see
[WebMCP](#webmcp-forms-as-agent-tools)). A/B experiments: `applyExperiments`,
`assignArm`, and exposures/conversions in `reportTraffic` and `submitForm`
(see [A/B experiments](#ab-experiments)).

```ts
import { createClient } from "@paperboycms/client";

const cms = createClient({
  baseUrl: "https://cms.example.com",
  key: process.env.PAPERBOY_PUBLIC_KEY!, // pk_live_… = published only; prv_… = drafts (server-side!)
});

// One item (typed data via the generic)
type BlogPost = { title: string; body: string; publishDate?: string };
const post = await cms.getBySlug<BlogPost>("hello-world", { locale: "en", populate: 2 });

// Lists: pagination, sorting, field filters — `total` ignores pagination
const { items, total } = await cms.list<BlogPost>("BlogPost", {
  sort: "-data.publishDate",
  limit: 10,
  filter: { author: "Jane" },
});

// Full-text search (same no-leak chokepoint as everything else)
const hits = await cms.search("local ai", { type: "BlogPost", limit: 5 });

// Hierarchical URLs, the start page, globals, one document by id
await cms.getByPath("/blog/hello-world");
await cms.startPage({ populate: 2 });
await cms.global("SiteSettings");
await cms.getById("doc_…", { locale: "en", populate: 1 }); // e.g. a shared block's documentId

// A page's children of ANY type (`null` type) — a ListPage's subtree, teaser blocks
const { items: children } = await cms.list(null, { parentId: listPage.documentId, sort: "-data.publishDate" });

// Responsive images via the server's variant pipeline. An image field is
// delivered as an OBJECT ({ url, alt, … }), not a bare string — pass its `url`.
import { mediaUrl, mediaSrcset } from "@paperboycms/client";
const image = post!.data.image as { url: string; alt: string } | null;
const src = image && mediaUrl(image.url, { w: 640, format: "webp" });
const srcset = image && mediaSrcset(image.url); // 320/640/1024/1600w webp
```

## Behavior

- **404 → `null`** on the singular getters; everything else non-OK throws a
  typed `PaperboyError { status, message, body }` (401 messages name the key
  problem explicitly).
- **`list()` resolves at most 500 items per request.** Omitting `limit` returns
  everything up to that cap; a larger list answers 400 with the recipe — pass
  `limit` (≤ 500) and `offset`, and read `total` (reported on every page).
- **`etagCache: true`** opts into in-memory conditional GETs: the client
  replays each URL's ETag and serves 304s from its cache — free bandwidth wins
  for hot published content.
- **`fetchInit`** merges into every request — e.g. Next.js needs
  `{ cache: "no-store" }` for draft-mode freshness (see `apps/web/app/lib/delivery.ts`,
  which is this client in production shape).
- **`fetch`** overrides the fetch implementation (tests, polyfills); defaults to
  `globalThis.fetch`.
- Preview keys see drafts. Never ship one to a browser.

## Rendering & SEO helpers

The client also ships schema-driven render helpers so a frontend switches on the
declared field type instead of sniffing values:

```ts
import {
  renderRichText, isRichTextDoc,   // TipTap JSON → sanitized HTML (XSS-safe)
  contentAreas, blockData,         // iterate a content area's blocks
  renderKind,                      // map a field to a render kind via fieldTypes
  pbAreaAttrs,                     // data-pb-* attrs for the on-page-editing bridge
} from "@paperboycms/client";

const post = await cms.getByPath("/blog/hello");
// Every delivery item carries `fieldTypes` (declared type per public field) so an
// empty richtext field still renders as richtext, never as "". PASS IT to
// contentAreas: areas are then identified by SCHEMA, so an area named anything —
// and an area that is currently empty — is still found.
for (const area of contentAreas(post!.data, post!.fieldTypes)) {
  for (const block of area.blocks) {
    const data = blockData(block); // shared vs inline, normalized
  }
}
const html = renderRichText(post!.data.intro); // safe to set via innerHTML
```

### SEO

Every PAGE item carries a server-computed `seo` block (`DeliverySeo`): normalized
meta/canonical/robots, Open Graph + Twitter, per-`@type` JSON-LD, and breadcrumbs —
computed **post-sanitize** (private fields can't leak), with preview always `noindex`.

```ts
import type { DeliverySeo } from "@paperboycms/client";
const seo = post!.seo; // null on non-page kinds
// URLs in `seo` are relative — absolutize against your site origin before emitting.
```

Structured data is set up in the CMS, and three things come with it:

- **`seo.jsonLd`**: the page's own node. Add `@id`/`url` on the frontend.
- **`seo.jsonLdParts`** (optional): one node per block on the page whose type
  declares a schema.org type — an FAQ block's `FAQPage`, say. Render each beside
  `jsonLd`.
- **`jsonLd` on a global** (optional): a global whose type declares a schema.org
  type carries its own node. A SiteSettings typed `Organization` (or a subtype)
  is the site's identity: render it once per page and point the page at it.

A content area mapped to a property becomes a list of the nodes its blocks make
(offices as `department`, questions as `mainEntity`).

```ts
const settings = await client.global("SiteSettings");
const graph = [settings?.jsonLd, seo?.jsonLd, ...(seo?.jsonLdParts ?? [])].filter(Boolean);
```

## Forms

A form is content. A delivered Form carries `content.form` — a `FormSpec`
**schema, never markup** — so you render it with your own components and the
server recompiles the validation rules from the published definition on submit.
Client-side validation is a courtesy; the endpoint is the gate.

```ts
import { formOf, fieldAttrs, honeypotAttrs, formTimer } from "@paperboycms/client";

const spec = formOf(block.content); // FormSpec | null — null when the item isn't a form
if (!spec) return null;
const timer = formTimer();          // start when the form renders
const honeypot = honeypotAttrs(spec);

for (const field of spec.fields) {
  // `static` collects no answer (empty `name`); every other kind is a control.
  const a = fieldAttrs(field, { error: errors[field.name] });
  // <label for={a.id}>{field.label}</label>
  // <input {...a.input} />                       id/name/type/required/aria-* from the spec
  // <p id={a.helpId}>{field.helpText}</p>  <p id={a.errorId}>{errors[field.name]}</p>
}
// The honeypot: an input a human never sees, in a wrapper hidden from sight AND
// assistive technology — spread `honeypot.input`, apply `honeypot.wrapperStyle`
// and put aria-hidden="true" on the wrapper.
```

Submit through the same client (its writes are this and `reportTraffic`). Do it server-side
(a server action or route handler) so the key never reaches the browser:

```ts
// Mint the idempotency key ONCE per form instance (e.g. in component state when
// the form mounts) and send the same key on every retry of that attempt — only
// then can a retry after a timeout not create a second submission. Rotate it
// after a success so the next submission is a new one.
const res = await cms.submitForm(formId, {
  values,                              // { [field.name]: answer } — unknown keys are REJECTED (422)
  elapsedMs: timer.elapsed(),          // the real fill time; implausibly fast is discarded as a bot
  honeypot: String(formData.get(honeypot.name) ?? ""), // FormDataEntryValue | null
  turnstileToken,                      // only when spec.turnstile is true
  idempotencyKey,                      // the per-attempt key minted above
});
if (!res.ok) {
  // 422: one message per field name — the editor's own `errorMessage` when they
  // wrote one — so each renders beside its input. `_form` is a form-level message.
  showErrors(res.fields);
} else {
  // 202: res.confirmation.type is "message" (show res.confirmation.text)
  // or "redirect" (go to res.confirmation.redirectTo.href).
}
```

- **A spam drop looks like a success.** The honeypot / fill-time checks answer
  202 `ok: true` exactly like a real submission, so a bot learns nothing; the
  reason goes to the CMS audit log. Don't try to tell the two apart in the UI.
- `formId` is the Form's `documentId` — a Form must be placed as a **shared**
  block; an inline block has no id to post against.
- `submitForm` throws `PaperboyError` only for transport/auth failures (401,
  404, 413, 429…); invalid input is the `ok: false` branch, never a throw.
- Field kinds: `text` `email` `textarea` `number` `date` `select` `radio`
  `checkbox` `consent` `static`. Render by `kind`, never by guessing.

### WebMCP: forms as agent tools

Chrome's [WebMCP](https://developer.chrome.com/docs/ai/webmcp) lets an in-browser
AI agent fill a form through a declared tool instead of guessing at the DOM.
Spread `formToolAttrs(spec)` on the `<form>`:

```tsx
<form {...formToolAttrs(spec)} onSubmit={onSubmit}>   // toolname="contact_us" tooldescription="Contact us: …"
```

- The name and description come from the Form's title and intro, so editors
  control the wording. Each field's description is its `<label>`.
- **No `toolautosubmit`:** the agent pre-fills, and the visitor still clicks Send.
- **Spread `honeypot.input` as is.** Chrome offers every named control to the
  agent, including ones hidden with `aria-hidden` or `display:none`; it leaves
  out only `readonly` and `disabled` ones. An agent that filled the honeypot
  would have a real enquiry dropped as spam behind a 202, so the input is
  `readOnly` (still submitted, still set by bots that fill by script).

`apps/web/app/components/Form.tsx` + `app/actions/submit-form.ts` in the Paperboy
repo are the worked example — accessible by construction (`label for`,
`aria-describedby`, `aria-invalid`, focus moved to the error summary on failure).

## Redirects

Redirect rules live in the CMS (Settings → Redirects, per site) and your
frontend applies them. **Apply a rule only where no published page answers** —
fetch the page first, and consult the rules on a 404 — so a rule can never
hide a live page. Page targets arrive already resolved to the page's current
URL, so a page that moved again never costs an extra hop.

```ts
import { createClient, matchRedirect } from "@paperboycms/client";

const cms = createClient({ baseUrl, key: process.env.PAPERBOY_PUBLIC_KEY!, etagCache: true });

// On a 404 for `url.pathname + url.search`:
const manifest = await cms.redirects(); // cache it ~60 s
const hit = matchRedirect(manifest, url.pathname + url.search);
if (hit?.location) return Response.redirect(new URL(hit.location, url), hit.status);
if (hit) return new Response("Gone", { status: 410 });

// Fire-and-forget, server-side: hit counts + the 404 log in the admin.
waitUntil(cms.reportTraffic(hit ? { redirectHits: [hit.rule.id] } : { notFound: [url.pathname] }));
```

- `matchRedirect` normalizes like the CMS does: case-insensitive, trailing
  slash ignored, exact rules before the longest `/prefix/*` rule, the rest of
  the path carried over, the query string kept unless the rule says not to.
- `reportTraffic` needs the **public** key and sends paths only; never call it
  from the browser.

## A/B experiments

Editors test a content area of a page against up to three alternatives in the
CMS. A page under test carries `experiments`; its areas in `data` stay version
A. Pick the visitor's version on the SERVER (never swap content in the browser:
it flickers), render as usual, and report what was shown:

```ts
import { applyExperiments } from "@paperboycms/client";

const page = await cms.getByPath(path, { locale, populate: 2 });
const { item, exposures } = applyExperiments(page!, {
  visitorKey,                                   // see below; omitted → everyone sees A
  force: preview ? url.searchParams.get("pbab") : null, // the admin's version picker
});
render(item);                                    // contentAreas()/blockData() work unchanged
waitUntil(cms.reportTraffic({ exposures }));     // server-side, public key, never awaited by the render
```

- **`visitorKey`.** Without consent, use a fresh random value per page view
  (cookieless: nothing stored on the device; only goals on the same page can be
  attributed). With consent, a first-party random id you keep at most 13
  months. In Norway a cookie that remembers the version needs consent
  (ekomloven §3-15); don't label it "strictly necessary".
- **Robots** get no key, so they see A: never branch on the user agent.
- **Conversions.** A form on the page: pass the exposures to
  `submitForm(id, { …, experiments: exposures })`. Anything else: report
  `conversions: [{ experimentId, arm, goal: "event:signup" }]` with the
  experiment's own goal.
- **Caching.** A page under test is `Cache-Control: private`, or puts the
  version into the cache key (e.g. rewrite to `/__ab/<id>-<arm>/…`).
- `assignArm(experimentId, visitorKey, arms)` is the assignment itself, the
  same function the CMS uses (pinned by a test).

## Types

| Type | What it is |
| --- | --- |
| `PaperboyClient` | `ReturnType<typeof createClient>` |
| `PaperboyClientOptions` | `baseUrl`, `key`, `fetch?`, `fetchInit?`, `etagCache?` |
| `GetOptions` · `ListOptions` · `SearchOptions` · `MediaOptions` | Per-method options; `ListOptions` adds `parentId`, `limit`, `offset`, `sort`, `filter` |
| `DeliveryContent` | A delivered item: `documentId`, `type`, `kind`, `locale`, `name`, `slug`, `urlPath`, `cv`, `data`, `fieldTypes`, `form?`, `seo`, `jsonLd?` (globals with a schema.org type) |
| `Delivered<TData>` | `DeliveryContent` with `data` narrowed to your field shape — what every getter returns |
| `DeliverySeo` | The server-computed SEO block on page items |
| `AreaBlock` | One entry of a content area: inline `data` (+ `fieldTypes`) or a resolved shared `content` |
| `FieldRenderKind` | `"richtext" \| "markdown" \| "text" \| "other"` — what `renderKind()` returns |
| `FormSpec` · `FormField` | A delivered form and one of its fields |
| `FormConfirmation` · `FormSubmitResult` | What `submitForm` resolves to |
| `RedirectManifest` · `RedirectManifestRule` · `RedirectMatch` | What `redirects()` returns and `matchRedirect()` answers |
| `PaperboyError` | Thrown on non-OK responses: `{ status, message, body }` |

## Preview tokens (server-side)

Rendering drafts means deciding, per request, whether the caller is allowed to see
them. The admin never puts `PREVIEW_SECRET` in a browser: it asks its own API for a
signed, minutes-long token and passes it to your frontend as `?pbt=`. Verify it
with the subpath export:

```ts
import { verifyPreviewToken, constantTimeEqual } from "@paperboycms/client/preview-token";

const preview =
  // ?pbt= — the short-lived token the in-editor preview iframe sends.
  (await verifyPreviewToken(process.env.PREVIEW_SECRET!, url.searchParams.get("pbt"))) ||
  // ?pb= — the long-lived secret, for server-side callers that legitimately hold it.
  constantTimeEqual(url.searchParams.get("pb") ?? "", process.env.PREVIEW_SECRET!);

const cms = createClient({
  baseUrl: process.env.PAPERBOY_API_URL!,
  key: preview ? process.env.PAPERBOY_PREVIEW_KEY! : process.env.PAPERBOY_PUBLIC_KEY!,
});
```

`PREVIEW_SECRET` must be byte-identical to the API's. Notes:

- **It's a separate subpath on purpose.** Its first argument is your secret, so it
  must never be reachable from a browser bundle — importing it from
  `@paperboycms/client` is deliberately impossible.
- **WebCrypto, so it runs anywhere** — Node, Cloudflare Workers, Deno, Bun. That's
  why it's async: Workers has no synchronous HMAC.
- **It fails closed**: malformed tokens, a tampered or absent MAC, an expired
  expiry, and an unset secret all return `false`. The MAC is checked *before* the
  expiry, so a forged token can't be used to probe expiry behaviour.
- If your `PREVIEW_SECRET` still falls back to a committed dev default, guard that
  in production yourself — see `apps/web/app/lib/preview.ts` in the Paperboy repo.
