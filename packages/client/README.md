# @paperboy/client

The typed Delivery API client. Thin, dependency-free (besides the shared
types), end-to-end typed from the same Zod schemas the server serializes with —
no codegen step.

```ts
import { createClient } from "@paperboy/client";

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
import { mediaUrl, mediaSrcset } from "@paperboy/client";
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
