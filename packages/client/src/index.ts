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
  /** Public field name → declared field type ("text" | "markdown" | "richtext"
   *  | "contentArea" | "image" | "reference" | "boolean" | "number" |
   *  "datetime" | "select" | "link"). Render each field by its SCHEMA type
   *  rather than sniffing the value's shape. Private fields are never listed. */
  fieldTypes: Record<string, string>;
  /** Ready-to-render form contract — present only on a Form. */
  form?: FormSpec;
  /** Normalized SEO/schema.org contract — present on pages, null otherwise. */
  seo: DeliverySeo | null;
}

/* ------------------------------- forms ----------------------------------- */

/** One field of a delivered form. Render by `kind`, never by guessing. */
export interface FormField {
  kind: "text" | "email" | "textarea" | "number" | "date" | "select" | "radio" | "checkbox" | "consent" | "static";
  /** The submission key. Empty for `static`, which collects no answer. */
  name: string;
  label: string;
  required: boolean;
  helpText?: string;
  placeholder?: string;
  /** The editor's own error copy — show this instead of a generic message. */
  errorMessage?: string;
  rows?: number;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  choices?: { value: string; label: string }[];
  heading?: string;
  text?: unknown;
}

/**
 * A form as delivered: everything needed to render it, and nothing that only
 * the server should know. The rules here are the same ones the submit endpoint
 * enforces, so client-side validation is a courtesy, never the gate.
 */
export interface FormSpec {
  title: string;
  intro?: unknown;
  fields: FormField[];
  submitLabel: string;
  confirmation: "message" | "redirect";
  confirmationText?: unknown;
  redirectTo?: { href: string; text?: string } | null;
  /** Render a Turnstile widget and pass its token to `submitForm`. */
  turnstile: boolean;
  /** Name for the hidden input a bot fills and a human never sees. */
  honeypotField: string;
  minFillMs: number;
}

export interface FormConfirmation {
  type: "message" | "redirect";
  text?: unknown;
  redirectTo?: { href: string; text?: string } | null;
}

export type FormSubmitResult =
  | { ok: true; submissionId: string; confirmation: FormConfirmation }
  | { ok: false; fields: Record<string, string> };

/** The form spec of a delivered item, or null when it isn't a form. */
export function formOf(content: { form?: FormSpec } | null | undefined): FormSpec | null {
  return content?.form ?? null;
}

/**
 * Start the fill timer. Call when the form renders and pass `elapsed()` to
 * `submitForm`: a submission completed faster than a human could type is
 * discarded, and a form that reports nothing loses that protection.
 */
export function formTimer(): { elapsed: () => number } {
  const started = Date.now();
  return { elapsed: () => Date.now() - started };
}

/**
 * Field attributes for accessible markup, derived from the spec.
 *
 * WCAG-correct by construction: the label is associated by id, help text and
 * error text are announced through `aria-describedby`, a failing field is
 * marked `aria-invalid`, and `required` is set programmatically rather than
 * being implied by an asterisk. Frameworks spread this onto their own inputs —
 * we deliberately never hand back HTML strings.
 */
export function fieldAttrs(
  field: FormField,
  opts: { idPrefix?: string; error?: string; value?: unknown } = {},
): {
  id: string;
  name: string;
  required: boolean;
  describedBy?: string;
  helpId: string;
  errorId: string;
  input: Record<string, string | number | boolean | undefined>;
} {
  const prefix = opts.idPrefix ?? "pb";
  const id = `${prefix}-${field.name || field.kind}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const described = [field.helpText ? helpId : null, opts.error ? errorId : null].filter(Boolean).join(" ");
  const input: Record<string, string | number | boolean | undefined> = {
    id,
    name: field.name,
    required: field.required || undefined,
    "aria-required": field.required || undefined,
    "aria-invalid": opts.error ? true : undefined,
    "aria-describedby": described || undefined,
    placeholder: field.placeholder,
  };
  if (field.kind === "email") input.type = "email";
  else if (field.kind === "number") input.type = "number";
  else if (field.kind === "date") input.type = "date";
  else if (field.kind === "checkbox" || field.kind === "consent") input.type = "checkbox";
  else if (field.kind === "text") input.type = "text";
  if (field.minLength != null) input.minLength = field.minLength;
  if (field.maxLength != null) input.maxLength = field.maxLength;
  if (field.min != null) input.min = field.min;
  if (field.max != null) input.max = field.max;
  if (field.pattern) input.pattern = field.pattern;
  if (field.kind === "textarea" && field.rows) input.rows = field.rows;
  return { id, name: field.name, required: field.required, describedBy: described || undefined, helpId, errorId, input };
}

/** Attributes for the honeypot input: hidden from sight AND from assistive
 *  technology, and never focusable, so no real visitor can fill it by accident. */
export function honeypotAttrs(spec: FormSpec): {
  name: string;
  wrapperStyle: string;
  input: Record<string, string | number | boolean>;
} {
  return {
    name: spec.honeypotField,
    wrapperStyle: "position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden",
    input: { name: spec.honeypotField, type: "text", tabIndex: -1, autoComplete: "off", "aria-hidden": "true" },
  };
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

/** Upper bound on the opt-in ETag cache so a long-lived consumer can't leak memory. */
const ETAG_CACHE_MAX = 500;

/** The consumer's `fetchInit.headers` (any HeadersInit — a Headers instance or
 *  an entries array spread to `{}`) with the client's own headers on top. */
function mergeHeaders(extra: RequestInit["headers"], own: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(new Headers(extra)), ...own };
}

export function createClient(options: PaperboyClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error("@paperboycms/client: no fetch available — pass options.fetch");
  const etags = options.etagCache ? new Map<string, { etag: string; body: unknown }>() : null;

  async function request<T>(path: string, params: Record<string, string | number | undefined>): Promise<{ status: number; body: T | null }> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      // Drop empty SCALAR options (absent locale/sort/etc.), but keep an explicit
      // empty `data.<field>` filter — "" is a meaningful equality the server honors
      // (match items whose field is empty/absent); dropping it would silently widen
      // the result set (garbage-in / wrong-out).
      if (v === "" && !k.startsWith("data.")) continue;
      search.set(k, String(v));
    }
    const qs = search.toString();
    const url = `${base}/api/v1/delivery${path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = { authorization: `Bearer ${options.key}` };
    const cached = etags?.get(url);
    if (cached) headers["if-none-match"] = cached.etag;

    const res = await doFetch(url, { ...options.fetchInit, headers: mergeHeaders(options.fetchInit?.headers, headers) });

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
    if (etags && etag) {
      // Bounded LRU: cap the cache so a long-lived consumer browsing an unbounded
      // URL/filter key space can't leak memory. Map keeps insertion order — drop
      // the oldest when over the cap, and refresh recency by re-inserting on write.
      etags.delete(url);
      etags.set(url, { etag, body });
      if (etags.size > ETAG_CACHE_MAX) etags.delete(etags.keys().next().value as string);
    }
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

    /**
     * Submit a form. The only WRITE this client makes.
     *
     * `elapsedMs` is how long the visitor had the form open — send the real
     * number (see `formTimer`), because an implausibly fast submission is
     * silently discarded as a bot. Pass `idempotencyKey` (any uuid) so a retry
     * after a timeout can't create a second submission.
     *
     * Resolves to a discriminated result rather than throwing on invalid input:
     * a 422 carries one message per field, which the caller renders beside the
     * input it belongs to.
     */
    async submitForm(
      formId: string,
      input: {
        values: Record<string, unknown>;
        elapsedMs?: number;
        honeypot?: string;
        turnstileToken?: string;
        locale?: string;
        idempotencyKey?: string;
      },
    ): Promise<FormSubmitResult> {
      const url = `${base}/api/v1/delivery/forms/${encodeURIComponent(formId)}/submissions`;
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.key}`,
        "content-type": "application/json",
      };
      if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
      const res = await doFetch(url, {
        ...options.fetchInit,
        method: "POST",
        headers: mergeHeaders(options.fetchInit?.headers, headers),
        body: JSON.stringify({
          values: input.values,
          elapsedMs: input.elapsedMs,
          honeypot: input.honeypot ?? "",
          turnstileToken: input.turnstileToken,
          locale: input.locale,
        }),
      });
      if (!res.ok) {
        // One parse for both branches: a 422 is the per-field result ONLY when
        // it carries JSON — a proxy's HTML 422 is an error like any other.
        const body = (await res.json().catch(() => null)) as { fields?: Record<string, string>; message?: string } | null;
        if (res.status === 422 && body) return { ok: false, fields: body.fields ?? { _form: "The form could not be submitted." } };
        throw new PaperboyError(res.status, body?.message || `Form submission failed (${res.status})`, body);
      }
      const body = (await res.json()) as { submissionId: string; confirmation: FormConfirmation };
      return { ok: true, submissionId: body.submissionId, confirmation: body.confirmation };
    },

    mediaUrl,
    mediaSrcset,
  };
}

export type PaperboyClient = ReturnType<typeof createClient>;

/* =========================================================================
 * Delivery-consumption render helpers — pure, DOM-free transforms for content
 * the Delivery API returns. Inlined here (not a separate module) so the package
 * stays single-file: no internal import to resolve, which keeps it consumable
 * from source (bundlers) AND as published ESM (Node) without extension hazards.
 * ========================================================================= */

interface RtNode {
  type?: string;
  text?: string;
  content?: RtNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function rtEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Stringify a scalar attr; objects/arrays/null collapse to "" (never "[object Object]"). */
function rtScalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

/** Safe schemes, same-document anchors and site-relative paths. A SINGLE leading
 *  slash: `//host/…` is protocol-relative, i.e. an off-site URL in disguise. */
function rtSafeHref(href: string): string {
  const h = (href || "").trim();
  return /^(https?:|mailto:|tel:|\/(?!\/)|#)/i.test(h) ? h : "#";
}

function rtApplyMarks(text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): string {
  let out = rtEsc(text);
  for (const m of marks ?? []) {
    switch (m.type) {
      case "bold":
        out = `<strong>${out}</strong>`;
        break;
      case "italic":
        out = `<em>${out}</em>`;
        break;
      case "strike":
        out = `<s>${out}</s>`;
        break;
      case "code":
        out = `<code>${out}</code>`;
        break;
      case "link": {
        const href = rtEsc(rtSafeHref(rtScalar(m.attrs?.href) || "#"));
        const blank = m.attrs?.target === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : "";
        out = `<a href="${href}"${blank}>${out}</a>`;
        break;
      }
    }
  }
  return out;
}

function rtRenderNode(node: RtNode): string {
  if (node.type === "text") return rtApplyMarks(node.text ?? "", node.marks);
  const inner = (node.content ?? []).map(rtRenderNode).join("");
  switch (node.type) {
    case "doc":
      return inner;
    case "paragraph":
      return `<p>${inner}</p>`;
    case "heading": {
      const n = Math.round(Number(node.attrs?.level));
      const lvl = Number.isFinite(n) ? Math.min(Math.max(n, 1), 6) : 2; // non-numeric level → h2, never <hNaN>
      return `<h${lvl}>${inner}</h${lvl}>`;
    }
    case "bulletList":
      return `<ul>${inner}</ul>`;
    case "orderedList":
      return `<ol>${inner}</ol>`;
    case "listItem":
      return `<li>${inner}</li>`;
    case "blockquote":
      return `<blockquote>${inner}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${inner}</code></pre>`;
    case "image": {
      const src = rtScalar(node.attrs?.src).trim();
      if (!/^(https?:|\/(?!\/))/i.test(src)) return "";
      const alt = rtEsc(rtScalar(node.attrs?.alt));
      const width = Number(node.attrs?.width);
      const style = Number.isFinite(width) && width >= 10 && width <= 100 ? ` style="width:${Math.round(width)}%"` : "";
      return `<img src="${rtEsc(src)}" alt="${alt}" loading="lazy"${style}/>`;
    }
    case "horizontalRule":
      return "<hr/>";
    case "hardBreak":
      return "<br/>";
    default:
      return inner;
  }
}

/**
 * Render a Paperboy richtext value (TipTap JSON doc) to a SANITISED HTML string:
 * text is escaped, link/image URLs are restricted to safe schemes — safe to
 * inject with `innerHTML` / `set:html`. (Frameworks that render to nodes rather
 * than an HTML string should walk the doc themselves.)
 */
export function renderRichText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  return rtRenderNode(doc as RtNode);
}

/** True if a value looks like a richtext document (vs a plain string/markdown). */
export function isRichTextDoc(v: unknown): boolean {
  return !!v && typeof v === "object" && ((v as RtNode).type === "doc" || Array.isArray((v as RtNode).content));
}

/** A block as the Delivery API serializes it inside a content area. */
export interface AreaBlock {
  blockType: string;
  display?: string;
  shared?: boolean;
  /** Inline block field values. */
  data?: Record<string, unknown>;
  /** Public field name → declared type for an INLINE block (mirrors the
   *  top-level item's `fieldTypes`); absent on shared-block entries (read the
   *  resolved page/block's own `fieldTypes` via `content`). */
  fieldTypes?: Record<string, string>;
  /** Shared block / referenced page (resolved at populate >= 1). */
  content?: {
    documentId?: string;
    /** Content type name — how a renderer tells a Form from a teaser. */
    type?: string;
    kind?: string;
    name?: string;
    urlPath?: string | null;
    data?: Record<string, unknown>;
    fieldTypes?: Record<string, string>;
    /** Present when the referenced document is a Form. */
    form?: FormSpec;
  };
}

/** A block's field values: inline blocks carry `data`, shared blocks `content.data`. */
export function blockData(b: AreaBlock): Record<string, unknown> {
  return (b.shared ? b.content?.data : b.data) ?? {};
}

/** How a field's value should be rendered, decided from its DECLARED schema
 *  type (`fieldTypes[name]`) — not by sniffing the value's shape, which can't
 *  tell an empty richtext from an empty string. "richtext" → render the TipTap
 *  doc as HTML; "markdown" → run a markdown renderer; "text" → plain text;
 *  "other" → not free-text (image/reference/boolean/contentArea/…). */
export type FieldRenderKind = "richtext" | "markdown" | "text" | "other";
export function renderKind(fieldType: string | undefined): FieldRenderKind {
  switch (fieldType) {
    case "richtext":
      return "richtext";
    case "markdown":
      return "markdown";
    case "text":
      return "text";
    default:
      return "other";
  }
}

const looksLikeBlocks = (v: unknown): v is AreaBlock[] =>
  Array.isArray(v) && v.length > 0 && v.every((b) => b != null && typeof b === "object" && "blockType" in (b as object));

/**
 * Every content-area field on a delivered item's `data`, keyed by field name.
 *
 * PASS `fieldTypes` (delivered alongside `data` on every item). It is the declared
 * type per public field, and switching on the schema instead of sniffing values is
 * exactly what it exists for: detection is then exact for areas named anything, and
 * an area that is currently EMPTY is still an area.
 *
 * Omitting it falls back to a value-shape heuristic, kept only so already-deployed
 * frontends don't break. The heuristic cannot see an empty area unless the field is
 * conventionally named (`…Area`) — an empty `sections: []` is shape-identical to an
 * empty `tags: []` — so a page whose areas are all empty renders no drop zones and
 * cannot be composed by on-page drag-and-drop.
 */
export function contentAreas(
  data: Record<string, unknown>,
  fieldTypes?: Record<string, string>,
): { field: string; blocks: AreaBlock[] }[] {
  if (fieldTypes) {
    return Object.entries(data)
      .filter(([field, v]) => fieldTypes[field] === "contentArea" && Array.isArray(v))
      .map(([field, v]) => ({ field, blocks: v as AreaBlock[] }));
  }
  return Object.entries(data)
    .filter(([field, v]) => looksLikeBlocks(v) || (Array.isArray(v) && v.length === 0 && /area$/i.test(field)))
    .map(([field, v]) => ({ field, blocks: v as AreaBlock[] }));
}

/**
 * The drop-zone attribute a content-area element must carry so the Paperboy
 * preview bridge can target it when a shared block / page is dragged onto the
 * page. The attribute VALUE is the field name — the bridge posts it back to
 * the editor as `paperboy:drop {field}`, which maps the drop to the form
 * field. Spread it instead of hand-writing the attribute: a wrong value (e.g.
 * a literal "true") makes every drop fail silently because the editor looks
 * up a field by that name. Outside preview it returns {} so public pages stay
 * marker-free:
 *
 *   <div {...pbAreaAttrs(area.field, preview)}>{area.blocks.map(...)}</div>
 */
export function pbAreaAttrs(field: string, preview: boolean): { "data-pb-area"?: string } {
  return preview ? { "data-pb-area": field } : {};
}
