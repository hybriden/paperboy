import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ContentTypeDef, DeliveryContent } from "@paperboy/shared";
import { absoluteAssetUrl, getAssetRow } from "./assets.js";
import type { Database } from "./client.js";
import { asset, contentItem, contentType, contentVersion, locale, siteSetting } from "./schema.js";

/**
 * The Delivery read chokepoint. EVERY public/preview read — including every
 * reference expansion and every nested block — flows through `resolveContent`
 * with a single `perspective`. This is the structural no-leak guarantee:
 *
 *   - perspective "published": only `is_current_published` rows are ever
 *     selected, at the top level AND through the whole reference graph. A draft
 *     is physically unreachable.
 *   - perspective "preview": the working draft (else published) is selected,
 *     consistently across the graph (so draft-references-draft renders).
 *
 * Field-level exposure is FAIL-CLOSED: only fields whose content-type def marks
 * `delivery: "public"` are emitted; everything else is stripped regardless of
 * populate depth.
 */
export type Perspective = "published" | "preview";

const MAX_POPULATE_DEPTH = 4;

class DeliveryCtx {
  types = new Map<string, ContentTypeDef>();
  itemTypes = new Map<string, string>(); // documentId -> type name
  assets = new Map<string, typeof asset.$inferSelect | null>(); // documentId -> asset row
  // documentId -> ALL its content_version rows (every locale). Avoids the N+1 of
  // re-querying per document per locale-chain step.
  versionsByDoc = new Map<string, (typeof contentVersion.$inferSelect)[]>();
  locales: (typeof locale.$inferSelect)[] | null = null;
  // Clock for the scheduled-publish window check (published perspective only).
  constructor(
    public db: Database,
    public now: Date = new Date(),
  ) {}

  async asset(documentId: string): Promise<typeof asset.$inferSelect | null> {
    if (this.assets.has(documentId)) return this.assets.get(documentId)!;
    const row = await getAssetRow(this.db, documentId);
    this.assets.set(documentId, row);
    return row;
  }

  /** All version rows for a document (cached). */
  async docVersions(documentId: string): Promise<(typeof contentVersion.$inferSelect)[]> {
    const hit = this.versionsByDoc.get(documentId);
    if (hit) return hit;
    const rows = await this.db
      .select()
      .from(contentVersion)
      .where(eq(contentVersion.documentId, documentId));
    this.versionsByDoc.set(documentId, rows);
    return rows;
  }

  /** Bulk-prime version rows for many documents in ONE query (batches the N+1). */
  async primeVersions(documentIds: string[]): Promise<void> {
    const missing = documentIds.filter((id) => !this.versionsByDoc.has(id));
    if (!missing.length) return;
    const rows = await this.db
      .select()
      .from(contentVersion)
      .where(inArray(contentVersion.documentId, missing));
    const grouped = new Map<string, (typeof contentVersion.$inferSelect)[]>();
    for (const id of missing) grouped.set(id, []);
    for (const r of rows) grouped.get(r.documentId)?.push(r);
    for (const [id, rs] of grouped) this.versionsByDoc.set(id, rs);
  }

  async type(name: string): Promise<ContentTypeDef | null> {
    if (this.types.has(name)) return this.types.get(name)!;
    const rows = await this.db
      .select()
      .from(contentType)
      .where(eq(contentType.name, name))
      .limit(1);
    if (!rows[0]) return null;
    const def = rows[0].definition as ContentTypeDef;
    this.types.set(name, def);
    return def;
  }

  async itemType(documentId: string): Promise<string | null> {
    return (await this.item(documentId))?.type ?? null;
  }

  // documentId -> item row essentials (type/kind/parentId), cached.
  items = new Map<string, { type: string; kind: string; parentId: string | null } | null>();
  async item(documentId: string): Promise<{ type: string; kind: string; parentId: string | null } | null> {
    if (this.items.has(documentId)) return this.items.get(documentId)!;
    const rows = await this.db
      .select({ type: contentItem.type, kind: contentItem.kind, parentId: contentItem.parentId })
      .from(contentItem)
      .where(and(eq(contentItem.documentId, documentId), isNull(contentItem.deletedAt)))
      .limit(1);
    const row = rows[0] ?? null;
    this.items.set(documentId, row);
    if (row) this.itemTypes.set(documentId, row.type);
    return row;
  }

  async localeChain(code: string): Promise<string[]> {
    if (!this.locales) this.locales = await this.db.select().from(locale);
    const byCode = new Map(this.locales.map((l) => [l.code, l]));
    const chain: string[] = [];
    let cur: string | null = code;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      chain.push(cur);
      cur = byCode.get(cur)?.fallbackLocaleCode ?? null;
    }
    return chain;
  }

  /** Every enabled locale code in stable (sortIndex) order. */
  async enabledLocaleCodes(): Promise<string[]> {
    if (!this.locales) this.locales = await this.db.select().from(locale);
    return [...this.locales]
      .filter((l) => l.enabled)
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map((l) => l.code);
  }
}

function selectRow(
  rows: (typeof contentVersion.$inferSelect)[],
  perspective: Perspective,
): (typeof contentVersion.$inferSelect) | null {
  if (perspective === "published") {
    // STRICT: only the live published row is ever reachable publicly.
    return rows.find((r) => r.isCurrentPublished) ?? null;
  }
  // preview (privileged editors): working perspective — draft, else live
  // published, else the latest version of any status. The final fallback keeps
  // UNPUBLISHED content previewable (it has no draft and no current-published
  // row) so editors can still preview a page they've taken down.
  const draft = rows.find((r) => r.status === "draft");
  if (draft) return draft;
  const published = rows.find((r) => r.isCurrentPublished);
  if (published) return published;
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (b.versionNumber > a.versionNumber ? b : a));
}

/**
 * Scheduled-publish window: a published row is only PUBLICLY visible while
 * `publish_at <= now < expire_at` (either bound NULL = unbounded). Defence in
 * depth — an expired/early item is unreachable under the public key the instant
 * it should be, independent of the publisher ticker's cadence.
 */
function publishWindowOpen(r: typeof contentVersion.$inferSelect, now: Date): boolean {
  if (r.publishAt && r.publishAt > now) return false;
  if (r.expireAt && r.expireAt <= now) return false;
  return true;
}

/** The visible row for ONE specific locale code (perspective + window rules). */
function rowForLocale(
  all: (typeof contentVersion.$inferSelect)[],
  perspective: Perspective,
  code: string,
  now: Date,
): (typeof contentVersion.$inferSelect) | null {
  let candidates = all.filter((r) => r.locale === code);
  // Public perspective also enforces the scheduled-publish window; preview
  // (privileged editors) ignores it so editors can preview anytime.
  if (perspective === "published") candidates = candidates.filter((r) => publishWindowOpen(r, now));
  return selectRow(candidates, perspective);
}

async function variantRow(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  loc: string,
): Promise<{ row: typeof contentVersion.$inferSelect; usedLocale: string } | null> {
  const all = await ctx.docVersions(documentId);
  for (const code of await ctx.localeChain(loc)) {
    const row = rowForLocale(all, perspective, code, ctx.now);
    if (row) return { row, usedLocale: code };
  }
  return null;
}

/**
 * Enforce the `localized:false` contract at the read chokepoint: a
 * non-localized field holds ONE value across every language branch, but values
 * are stored per locale-version. When the resolved variant lacks such a field,
 * fill it from the next visible variant along the fallback chain — under the
 * SAME perspective/window rules, so a draft-only value never leaks publicly.
 * (2026-06-07: tags/publishDate written in en never reached the published nb
 * article — defined as shared, served as locale-private.)
 */
async function fillNonLocalizedFields(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  typeName: string,
  data: Record<string, unknown>,
  usedLocale: string,
  loc: string,
): Promise<Record<string, unknown>> {
  const def = await ctx.type(typeName);
  if (!def) return data;
  const missing = def.fields.filter((f) => !f.localized && data[f.name] === undefined);
  if (!missing.length) return data;
  // Priority: the rest of the fallback chain first, then every other enabled
  // locale (stable order) — sharing is bidirectional (an en request must also
  // see a value published only in nb), the chain just decides precedence.
  const chain = await ctx.localeChain(loc);
  const others = (await ctx.enabledLocaleCodes()).filter((c) => !chain.includes(c));
  const rest = [...chain.slice(chain.indexOf(usedLocale) + 1), ...others];
  if (!rest.length) return data;
  const all = await ctx.docVersions(documentId);
  const out = { ...data };
  let open = missing.map((f) => f.name);
  for (const code of rest) {
    if (!open.length) break;
    const row = rowForLocale(all, perspective, code, ctx.now);
    if (!row) continue;
    const rowData = row.data as Record<string, unknown>;
    open = open.filter((name) => {
      if (rowData[name] === undefined) return true;
      out[name] = rowData[name];
      return false;
    });
  }
  return out;
}

/** Absolutize the src of every image node in a TipTap doc (non-mutating). */
function absolutizeRichTextImages(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(absolutizeRichTextImages);
  if (!node || typeof node !== "object") return node;
  const o = node as Record<string, unknown>;
  let next = o;
  if (o.type === "image" && o.attrs && typeof o.attrs === "object") {
    const attrs = o.attrs as Record<string, unknown>;
    if (typeof attrs.src === "string" && attrs.src) {
      next = { ...o, attrs: { ...attrs, src: absoluteAssetUrl(attrs.src) } };
    }
  }
  if (Array.isArray(next.content)) {
    const content = next.content.map(absolutizeRichTextImages);
    next = next === o ? { ...o, content } : { ...next, content };
  }
  return next;
}

/** Strip private fields and resolve/shallow references + content areas. */
async function sanitize(
  ctx: DeliveryCtx,
  perspective: Perspective,
  typeName: string,
  data: Record<string, unknown>,
  loc: string,
  depth: number,
): Promise<Record<string, unknown>> {
  const def = await ctx.type(typeName);
  if (!def) return {};
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    // FAIL-CLOSED: private fields never reach delivery output.
    if (f.delivery !== "public") continue;
    const v = data[f.name];
    if (v === undefined) continue;

    if (f.type === "image") {
      // Resolve the asset documentId → {url, alt, mime}; missing asset → null.
      const id = typeof v === "string" ? v : "";
      const a = id ? await ctx.asset(id) : null;
      out[f.name] = a ? { documentId: a.documentId, url: absoluteAssetUrl(a.url), alt: a.alt, mime: a.mime } : null;
    } else if (f.type === "reference" && v && typeof v === "object") {
      const rv = v as { documentId?: string; type?: string };
      if (!rv.documentId) {
        out[f.name] = null;
      } else if (depth > 0) {
        out[f.name] = await resolveContent(ctx, perspective, rv.documentId, loc, depth - 1);
      } else {
        out[f.name] = { documentId: rv.documentId, type: rv.type ?? null };
      }
    } else if (f.type === "richtext" && v && typeof v === "object") {
      // Image srcs are stored as uploaded (usually relative /uploads/… paths);
      // absolutize at read time like image FIELDS, so any frontend origin works.
      out[f.name] = absolutizeRichTextImages(v);
    } else if (f.type === "contentArea" && Array.isArray(v)) {
      const blocks: unknown[] = [];
      for (const b of v as Array<Record<string, unknown>>) {
        const blockType = String(b.blockType ?? "");
        const display = b.display ?? "automatic";
        if (b.ref) {
          // Shared block: resolve through the SAME chokepoint/perspective.
          const resolved =
            depth > 0
              ? await resolveContent(ctx, perspective, String(b.ref), loc, depth - 1)
              : { documentId: b.ref, type: blockType };
          if (resolved) blocks.push({ blockType, display, shared: true, content: resolved });
        } else if (b.inline && typeof b.inline === "object") {
          const inlineData = await sanitize(
            ctx,
            perspective,
            blockType,
            b.inline as Record<string, unknown>,
            loc,
            depth,
          );
          blocks.push({ blockType, display, shared: false, data: inlineData });
        }
      }
      out[f.name] = blocks;
    } else {
      out[f.name] = v;
    }
  }
  return out;
}

/**
 * Hierarchical URL path of a PAGE ("/blog/hello"), built by resolving every
 * ancestor through the SAME perspective. If any ancestor (or the page itself)
 * isn't visible in this perspective, or lacks a slug, the path is null — a
 * draft ancestor's slug is never exposed through a published child (no-leak,
 * mirroring deliveryGetByPath which couldn't reach such a page anyway).
 */
async function urlPathOf(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  loc: string,
): Promise<string | null> {
  const item = await ctx.item(documentId);
  if (!item || item.kind !== "page") return null;
  const segments: string[] = [];
  let cur: string | null = documentId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const row = await ctx.item(cur);
    if (!row) return null;
    const variant = await variantRow(ctx, perspective, cur, loc);
    if (!variant?.row.slug) return null;
    segments.unshift(variant.row.slug);
    cur = row.parentId;
  }
  return `/${segments.join("/")}`;
}

export async function resolveContent(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  loc: string,
  depth: number,
): Promise<DeliveryContent | null> {
  const found = await variantRow(ctx, perspective, documentId, loc);
  if (!found) return null;
  const item = await ctx.item(documentId);
  if (!item) return null;
  // localized:false fields are SHARED across language branches — fill gaps
  // from other visible variants before sanitizing (same chokepoint rules).
  const data = await fillNonLocalizedFields(
    ctx,
    perspective,
    documentId,
    item.type,
    found.row.data as Record<string, unknown>,
    found.usedLocale,
    loc,
  );
  const sanitized = await sanitize(ctx, perspective, item.type, data, found.usedLocale, depth);
  return {
    documentId,
    type: item.type,
    // kind lets a frontend tell a PAGE in a content area (render as a teaser
    // linking to urlPath) from a shared block (render by blockType).
    kind: item.kind as DeliveryContent["kind"],
    locale: found.usedLocale,
    name: found.row.name,
    slug: found.row.slug,
    urlPath: await urlPathOf(ctx, perspective, documentId, loc),
    cv: found.row.cv,
    data: sanitized,
  };
}

/* ------------------------------ public API -------------------------------- */

function clampDepth(populate: number | undefined): number {
  if (!populate || populate < 0) return 0;
  return Math.min(populate, MAX_POPULATE_DEPTH);
}

export async function deliveryGetById(
  db: Database,
  perspective: Perspective,
  documentId: string,
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db);
  return resolveContent(ctx, perspective, documentId, loc, clampDepth(populate));
}

export async function deliveryGetBySlug(
  db: Database,
  perspective: Perspective,
  slug: string,
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db);
  // Find candidate variants by slug, then re-resolve via the chokepoint so the
  // perspective filter (not the slug lookup) decides visibility.
  const rows = await db
    .select({ documentId: contentVersion.documentId, locale: contentVersion.locale })
    .from(contentVersion)
    .where(and(eq(contentVersion.slug, slug), eq(contentVersion.locale, loc)));
  for (const r of rows) {
    const resolved = await resolveContent(ctx, perspective, r.documentId, loc, clampDepth(populate));
    if (resolved) return resolved;
  }
  return null;
}

/** List query options: pagination, sorting and simple field filters. */
export interface DeliveryListOptions {
  /** Page size. Omitted = all items (back-compat). */
  limit?: number;
  offset?: number;
  /**
   * Sort key: `name`, `createdAt`, or `data.<field>`; prefix `-` for
   * descending. Omitted = tree order (sortIndex). Sorting reads the SAME
   * perspective-selected version row the chokepoint would deliver.
   */
  sort?: string;
  /** Equality filters on data fields, e.g. { author: "Jane" }. Arrays match by inclusion. */
  filter?: Record<string, string>;
}

/** Sort-key comparator: numbers numerically, everything else as strings (ISO dates compare correctly). */
function compareKeys(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // missing values sort last
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export async function deliveryList(
  db: Database,
  perspective: Perspective,
  typeName: string | undefined,
  loc: string,
  populate?: number,
  parentId?: string,
  opts: DeliveryListOptions = {},
): Promise<{ items: DeliveryContent[]; total: number }> {
  if (!typeName && !parentId) return { items: [], total: 0 }; // unbounded "everything" listing is not a thing
  const ctx = new DeliveryCtx(db);
  // Optional hierarchy filter (a ListPage / teaser ListBlock listing a page's
  // children — with parentId the type may be omitted to list children of any
  // type). Visibility still comes from resolveContent — same chokepoint rules.
  const conds = [isNull(contentItem.deletedAt)];
  if (typeName) conds.push(eq(contentItem.type, typeName));
  if (parentId) conds.push(eq(contentItem.parentId, parentId));
  const items = await db
    .select({ documentId: contentItem.documentId })
    .from(contentItem)
    .where(and(...conds))
    .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));
  await ctx.primeVersions(items.map((i) => i.documentId)); // one query, not N

  // Visibility, filtering and sorting all read the CHOKEPOINT's own version
  // selection (variantRow: perspective + publish window + locale fallback) —
  // never a parallel query path — so a draft can't influence public ordering.
  const candidates: { documentId: string; row: typeof contentVersion.$inferSelect }[] = [];
  for (const it of items) {
    const variant = await variantRow(ctx, perspective, it.documentId, loc);
    if (variant) candidates.push({ documentId: it.documentId, row: variant.row });
  }

  let filtered = candidates;
  if (opts.filter && Object.keys(opts.filter).length) {
    filtered = filtered.filter(({ row }) => {
      const data = row.data as Record<string, unknown>;
      for (const [field, want] of Object.entries(opts.filter!)) {
        const have = field === "name" ? row.name : field === "slug" ? row.slug : data[field];
        const ok = Array.isArray(have) ? have.map(String).includes(want) : String(have ?? "") === want;
        if (!ok) return false;
      }
      return true;
    });
  }

  if (opts.sort) {
    const descending = opts.sort.startsWith("-");
    const key = descending ? opts.sort.slice(1) : opts.sort;
    const keyOf = (row: typeof contentVersion.$inferSelect): unknown => {
      if (key === "name") return row.name;
      if (key === "createdAt") return row.createdAt.toISOString();
      if (key.startsWith("data.")) return (row.data as Record<string, unknown>)[key.slice(5)];
      return null;
    };
    filtered = [...filtered].sort((a, b) => {
      const cmp = compareKeys(keyOf(a.row), keyOf(b.row));
      // Missing keys stay last regardless of direction; equal keys keep tree order.
      if (cmp === 0 || keyOf(a.row) == null || keyOf(b.row) == null) return cmp;
      return descending ? -cmp : cmp;
    });
  }

  const total = filtered.length;
  const offset = Math.max(0, opts.offset ?? 0);
  const page = opts.limit != null ? filtered.slice(offset, offset + opts.limit) : filtered.slice(offset);

  // Only the requested page pays the full resolve cost (populate graph etc.).
  const out: DeliveryContent[] = [];
  for (const it of page) {
    const resolved = await resolveContent(
      ctx,
      perspective,
      it.documentId,
      loc,
      clampDepth(populate),
    );
    if (resolved) out.push(resolved);
  }
  return { items: out, total };
}

/**
 * Public full-text search over delivered content. The tsquery prefilter ONLY
 * narrows candidates — and only ever scans the version rows this perspective
 * may see (published: current-published rows; preview: drafts too), so draft
 * text can't leak into public results even as a match signal. Every hit is
 * then re-resolved through the chokepoint.
 */
export async function deliverySearch(
  db: Database,
  perspective: Perspective,
  query: string,
  loc: string,
  typeName?: string,
  limit = 20,
): Promise<{ items: DeliveryContent[]; total: number }> {
  const q = query.trim();
  if (!q) return { items: [], total: 0 };
  const ctx = new DeliveryCtx(db);
  const chain = await ctx.localeChain(loc);
  const max = Math.min(Math.max(limit, 1), 100);
  // Matches the expression GIN index in 0007_delivery_search.sql exactly.
  const rows = (await db.execute(sql`
    SELECT DISTINCT v.document_id AS id,
           MAX(ts_rank(to_tsvector('simple', coalesce(v.name,'') || ' ' || coalesce(v.data::text,'')),
                       websearch_to_tsquery('simple', ${q}))) AS rank
    FROM content_version v
    JOIN content_item i ON i.document_id = v.document_id AND i.deleted_at IS NULL
    WHERE to_tsvector('simple', coalesce(v.name,'') || ' ' || coalesce(v.data::text,''))
          @@ websearch_to_tsquery('simple', ${q})
      AND v.locale IN (${sql.join(chain.map((c) => sql`${c}`), sql`, `)})
      AND ${perspective === "published" ? sql`v.is_current_published` : sql`(v.status = 'draft' OR v.is_current_published)`}
      ${typeName ? sql`AND i.type = ${typeName}` : sql``}
    GROUP BY v.document_id
    ORDER BY rank DESC
    LIMIT ${max * 3}
  `)) as unknown as { id: string; rank: number }[];
  await ctx.primeVersions(rows.map((r) => r.id));
  const out: DeliveryContent[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    // Chokepoint re-validates (publish window, perspective, locale fallback).
    const resolved = await resolveContent(ctx, perspective, r.id, loc, 0);
    if (resolved) out.push(resolved);
  }
  return { items: out, total: out.length };
}

/**
 * Resolve a hierarchical URL path (e.g. ["about","team"]) to a page by walking
 * the page tree. CRITICAL: every ancestor is resolved through the same
 * `perspective` + locale, so a draft-only ancestor is unreachable under the
 * public key (no-leak survives path-walking) and locales never cross mid-path.
 * Pages only. Cycle/depth-safe (bounded by segment count + child fan-out).
 */
export async function deliveryGetByPath(
  db: Database,
  perspective: Perspective,
  segments: string[],
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db);
  const cleaned = segments.filter((s) => s.length > 0);
  if (cleaned.length === 0) return null;

  // Candidate set starts at top-level pages; descends into children per segment.
  let parentId: string | null = null;
  let currentDoc: string | null = null;
  for (let depth = 0; depth < cleaned.length; depth++) {
    const segment = cleaned[depth]!;
    const children: { documentId: string }[] = await db
      .select({ documentId: contentItem.documentId })
      .from(contentItem)
      .where(
        and(
          parentId === null ? isNull(contentItem.parentId) : eq(contentItem.parentId, parentId),
          eq(contentItem.kind, "page"),
          isNull(contentItem.deletedAt),
        ),
      )
      .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));

    await ctx.primeVersions(children.map((c) => c.documentId)); // batch this level's sibling versions
    let matched: string | null = null;
    for (const child of children) {
      // Resolve through the perspective chokepoint — draft-only children are
      // invisible under the public key, and the slug is read in this locale.
      const found = await variantRow(ctx, perspective, child.documentId, loc);
      if (found && found.row.slug === segment) {
        matched = child.documentId;
        break;
      }
    }
    if (!matched) return null;
    currentDoc = matched;
    parentId = matched;
  }

  return currentDoc ? resolveContent(ctx, perspective, currentDoc, loc, clampDepth(populate)) : null;
}

/**
 * Resolve the configured START PAGE (the page served at "/"). Reads the
 * `startPage` site setting and resolves it through the same perspective
 * chokepoint, so an unpublished start page is invisible under the public key.
 * Returns null if unset or not visible in this perspective.
 */
export async function deliveryStartPage(
  db: Database,
  perspective: Perspective,
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  const rows = await db.select().from(siteSetting).where(eq(siteSetting.key, "startPage")).limit(1);
  const id = (rows[0]?.value as { documentId?: string } | undefined)?.documentId;
  if (!id) return null;
  const ctx = new DeliveryCtx(db);
  return resolveContent(ctx, perspective, id, loc, clampDepth(populate));
}

/** Fetch a singleton global by type (deterministic, kind-constrained). */
export async function deliveryGlobal(
  db: Database,
  perspective: Perspective,
  typeName: string,
  loc: string,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db);
  const items = await db
    .select({ documentId: contentItem.documentId })
    .from(contentItem)
    .where(
      and(
        eq(contentItem.type, typeName),
        eq(contentItem.kind, "global"),
        isNull(contentItem.deletedAt),
      ),
    )
    .orderBy(asc(contentItem.id))
    .limit(1);
  if (!items[0]) return null;
  return resolveContent(ctx, perspective, items[0].documentId, loc, 1);
}
