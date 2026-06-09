/**
 * @paperboycms/client — the typed Delivery API client.
 *
 * A thin, ZERO-dependency wrapper over the Delivery API's HTTP contract. The
 * types mirror @paperboy/shared (the same Zod schemas the server serializes
 * with — parity is asserted at compile time in the monorepo's SDK test), so a
 * consumer is end-to-end typed without codegen.
 *
 *   const cms = createClient({ baseUrl: "https://cms.example.com", key: "pk_live_…" });
 *   const post = await cms.getBySlug<BlogPostData>("hello-world", { locale: "en", populate: 2 });
 *   const { items, total } = await cms.list("BlogPost", { sort: "-data.publishDate", limit: 10 });
 *
 * Two-token model: a `pk_live_…` key sees PUBLISHED content only; a `prv_…`
 * key sees drafts (use it server-side only — e.g. Next.js Draft Mode).
 */

/**
 * A delivered content item — the Delivery API's resolved output shape.
 * Mirrors @paperboy/shared's DeliveryContent (compile-time parity-checked in
 * the monorepo) so this package ships with zero dependencies.
 */
/**
 * Normalized SEO + schema.org block, computed server-side and present on every
 * PAGE item (null for blocks/globals). Render the meta tags + `jsonLd` directly.
 * Origin-dependent URLs are RELATIVE (`canonicalPath`, breadcrumb `urlPath`) —
 * absolutize them against your site origin and add the site-identity JSON-LD
 * (WebSite/Organization/publisher) + the @id/url on `jsonLd`.
 */
export interface DeliverySeo {
  title: string;
  description: string | null;
  /** Relative path (or an absolute URL if the editor entered one in canonicalUrl). */
  canonicalPath: string | null;
  /** "index, follow" / "noindex, follow"; always "noindex, nofollow" in preview. */
  robots: string;
  og: {
    title: string;
    description: string | null;
    type: string;
    image: { url: string; alt: string } | null;
    siteName: string | null;
  };
  twitter: { card: string };
  /** schema.org page-entity node; add @id/url/publisher on the frontend. */
  jsonLd: Record<string, unknown>;
  /** Ancestor trail incl. self (root→leaf); urlPath null when not addressable. */
  breadcrumb: Array<{ name: string; urlPath: string | null }>;
}

export interface DeliveryContent {
  documentId: string;
  type: string;
  /** page | block | global — render pages in content areas as teasers (urlPath), blocks by type. */
  kind: "page" | "block" | "global";
  locale: string;
  name: string;
  slug: string | null;
  /** Hierarchical URL path (pages only) — null for blocks or no-leak-hidden ancestors. */
  urlPath: string | null;
  /** Cache-version: bumped on publish; used for ETag / cache busting. */
  cv: number;
  data: Record<string, unknown>;
  /** Normalized SEO/schema.org contract — present on pages, null otherwise. */
  seo: DeliverySeo | null;
}

export interface PaperboyClientOptions {
  /** API origin, e.g. "https://cms.example.com" or "http://localhost:8091". */
  baseUrl: string;
  /** Delivery key: pk_live_… (published) or prv_… (preview/drafts). */
  key: string;
  /** Override fetch (tests, polyfills). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Extra RequestInit merged into every request (e.g. Next.js { cache: "no-store" }). */
  fetchInit?: RequestInit;
  /**
   * Opt-in in-memory conditional GETs: replays each URL's ETag via
   * If-None-Match and serves the cached body on 304. Saves bandwidth +
   * server work for hot published content; preview responses are never cached.
   */
  etagCache?: boolean;
}

/** A delivered item with its `data` narrowed to the consumer's field shape. */
export type Delivered<TData = Record<string, unknown>> = Omit<DeliveryContent, "data"> & { data: TData };

export interface GetOptions {
  locale?: string;
  /** Reference/content-area resolution depth (0–4; server clamps). */
  populate?: number;
}

export interface ListOptions extends GetOptions {
  /** Only direct children of this document (e.g. a ListPage's subtree). */
  parentId?: string;
  /** Page size (omit = all items). */
  limit?: number;
  offset?: number;
  /** "name" | "createdAt" | "data.<field>" — prefix "-" for descending. */
  sort?: string;
  /** Equality filters on data fields, e.g. { author: "Jane" }. */
  filter?: Record<string, string>;
}

export interface SearchOptions {
  type?: string;
  locale?: string;
  limit?: number;
}

export interface MediaOptions {
  /** Target width in px (the server snaps to fixed steps and never enlarges). */
  w?: number;
  format?: "webp" | "avif" | "jpeg" | "png";
  /** Quality 1–100 (snapped server-side). */
  q?: number;
}

/** A non-OK Delivery API response, carrying the status and the server's message. */
export class PaperboyError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown = null,
  ) {
    super(message);
    this.name = "PaperboyError";
  }
}

/**
 * Build a media variant URL (`?w=&format=&q=` — generated once server-side,
 * then served from the variant cache). Non-CMS URLs pass through untouched.
 */
export function mediaUrl(url: string, opts: MediaOptions = {}): string {
  if (!url || !url.includes("/api/v1/media/")) return url;
  const params = new URLSearchParams();
  if (opts.w != null) params.set("w", String(opts.w));
  if (opts.format) params.set("format", opts.format);
  if (opts.q != null) params.set("q", String(opts.q));
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/** A responsive srcset over the standard width steps (empty for non-CMS URLs). */
export function mediaSrcset(url: string, widths: number[] = [320, 640, 1024, 1600], format: MediaOptions["format"] = "webp"): string {
  if (!url || !url.includes("/api/v1/media/")) return "";
  return widths.map((w) => `${mediaUrl(url, { w, format })} ${w}w`).join(", ");
}

export function createClient(options: PaperboyClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error("@paperboycms/client: no fetch available — pass options.fetch");
  const etags = options.etagCache ? new Map<string, { etag: string; body: unknown }>() : null;

  async function request<T>(path: string, params: Record<string, string | number | undefined>): Promise<{ status: number; body: T | null }> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") search.set(k, String(v));
    }
    const qs = search.toString();
    const url = `${base}/api/v1/delivery${path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = { authorization: `Bearer ${options.key}` };
    const cached = etags?.get(url);
    if (cached) headers["if-none-match"] = cached.etag;

    const res = await doFetch(url, { ...options.fetchInit, headers: { ...(options.fetchInit?.headers as Record<string, string>), ...headers } });

    if (res.status === 304 && cached) return { status: 200, body: cached.body as T };
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) {
      let message = `Delivery API ${res.status}`;
      let body: unknown = null;
      try {
        body = await res.json();
        const m = (body as { message?: string; error?: string }) ?? {};
        message = m.message ?? m.error ?? message;
      } catch {
        /* non-JSON error body */
      }
      if (res.status === 401) message = `${message} — check the delivery key (pk_live_… for published, prv_… for preview)`;
      throw new PaperboyError(res.status, message, body);
    }

    const body = (await res.json()) as T;
    const etag = res.headers.get("etag");
    if (etags && etag) etags.set(url, { etag, body });
    return { status: res.status, body };
  }

  return {
    /** One item by documentId — null when missing or not visible to this key. */
    async getById<TData = Record<string, unknown>>(documentId: string, opts: GetOptions = {}): Promise<Delivered<TData> | null> {
      const r = await request<Delivered<TData>>(`/content/${encodeURIComponent(documentId)}`, { locale: opts.locale, populate: opts.populate });
      return r.body;
    },

    /** One item by its slug (flat lookup — see getByPath for hierarchical URLs). */
    async getBySlug<TData = Record<string, unknown>>(slug: string, opts: GetOptions = {}): Promise<Delivered<TData> | null> {
      const r = await request<Delivered<TData>>("/content/by-slug", { slug, locale: opts.locale, populate: opts.populate });
      return r.body;
    },

    /** Resolve a hierarchical URL path built from the page tree, e.g. "/about/team". */
    async getByPath<TData = Record<string, unknown>>(path: string, opts: GetOptions = {}): Promise<Delivered<TData> | null> {
      const r = await request<Delivered<TData>>("/content/by-path", { path, locale: opts.locale, populate: opts.populate });
      return r.body;
    },

    /** The configured start page (served at "/"). */
    async startPage<TData = Record<string, unknown>>(opts: GetOptions = {}): Promise<Delivered<TData> | null> {
      const r = await request<Delivered<TData>>("/start", { locale: opts.locale, populate: opts.populate });
      return r.body;
    },

    /** A global singleton by type (site settings, navigation, …). */
    async global<TData = Record<string, unknown>>(type: string, opts: Pick<GetOptions, "locale"> = {}): Promise<Delivered<TData> | null> {
      const r = await request<Delivered<TData>>(`/globals/${encodeURIComponent(type)}`, { locale: opts.locale });
      return r.body;
    },

    /**
     * List content of a type and/or a page's children, with pagination,
     * sorting and field filters. `total` ignores pagination.
     */
    async list<TData = Record<string, unknown>>(type: string | null, opts: ListOptions = {}): Promise<{ items: Delivered<TData>[]; total: number; cv: number }> {
      const params: Record<string, string | number | undefined> = {
        type: type ?? undefined,
        parentId: opts.parentId,
        locale: opts.locale,
        populate: opts.populate,
        limit: opts.limit,
        offset: opts.offset,
        sort: opts.sort,
      };
      for (const [field, value] of Object.entries(opts.filter ?? {})) params[`data.${field}`] = value;
      const r = await request<{ items: Delivered<TData>[]; total: number; cv: number }>("/content", params);
      return r.body ?? { items: [], total: 0, cv: 0 };
    },

    /** Full-text search over delivered content (name + field text). */
    async search<TData = Record<string, unknown>>(query: string, opts: SearchOptions = {}): Promise<{ items: Delivered<TData>[]; total: number }> {
      const r = await request<{ items: Delivered<TData>[]; total: number }>("/search", { q: query, type: opts.type, locale: opts.locale, limit: opts.limit });
      return r.body ?? { items: [], total: 0 };
    },

    mediaUrl,
    mediaSrcset,
  };
}

export type PaperboyClient = ReturnType<typeof createClient>;

// Delivery-consumption render helpers (richtext→HTML, content-area utilities).
export { renderRichText, isRichTextDoc, blockData, contentAreas, type AreaBlock } from "./render";
