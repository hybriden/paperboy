# @paperboycms/client

The typed Delivery API client. Thin, dependency-free (besides the shared
types), end-to-end typed from the same Zod schemas the server serializes with —
no codegen step.

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

// Hierarchical URLs, the start page, globals
await cms.getByPath("/blog/hello-world");
await cms.startPage({ populate: 2 });
await cms.global("SiteSettings");

// Responsive images via the server's variant pipeline
import { mediaUrl, mediaSrcset } from "@paperboycms/client";
const src = mediaUrl(post!.data.image as string, { w: 640, format: "webp" });
const srcset = mediaSrcset(post!.data.image as string); // 320/640/1024/1600w webp
```

## Behavior

- **404 → `null`** on the singular getters; everything else non-OK throws a
  typed `PaperboyError { status, message, body }` (401 messages name the key
  problem explicitly).
- **`etagCache: true`** opts into in-memory conditional GETs: the client
  replays each URL's ETag and serves 304s from its cache — free bandwidth wins
  for hot published content.
- **`fetchInit`** merges into every request — e.g. Next.js needs
  `{ cache: "no-store" }` for draft-mode freshness (see `apps/web/app/lib/delivery.ts`,
  which is this client in production shape).
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

const post = await cms.byPath("/blog/hello");
// Every delivery item carries `fieldTypes` (declared type per public field) so an
// empty richtext field still renders as richtext, never as "".
for (const block of contentAreas(post!.data.body)) {
  const data = blockData(block); // shared vs inline, normalized
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
