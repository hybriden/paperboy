import { type SQLWrapper, and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type ContentTypeDef, type DeliveryContent, type ExperimentArmKey, type ExperimentStatus, type FieldDef, type PublicPageEntry, SCHEMA_LIST_PROPS, SCHEMA_WRAPPER_TYPES, SEO_CONVENTION, type SharedBlockResolver, formSpecFrom, isCreativeWorkType, isFormType, isSafeUrl, scalarToString, sortByRule, tiptapToPlainText } from "@paperboy/shared";
import { absoluteAssetUrl, getAssetRow } from "./assets.js";
import { localeChainFrom } from "./content.js";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type LiveExperiment, liveExperiments } from "./experiments.js";
import { asset, contentItem, contentVersion, locale, site } from "./schema.js";
import { currentContentTypes } from "./type-cache.js";

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
// Per-request resolve budget (S2-M4): caps the TOTAL nodes one delivery read
// expands so a wide reference/contentArea graph can't fan out into a resource-DoS
// (O(B^depth) distinct resolves + SEO compute). Past the cap, nested refs come back
// shallow ({documentId, type}) instead of recursing. Generous for real content.
const MAX_RESOLVE_NODES = 500;

class DeliveryCtx {
  types = new Map<string, ContentTypeDef>();
  assets = new Map<string, typeof asset.$inferSelect | null>(); // documentId -> asset row
  // `${perspective}:${documentId}` -> the content_version rows that perspective may
  // select (every locale). Avoids the N+1 of re-querying per document per
  // locale-chain step.
  versionsByDoc = new Map<string, (typeof contentVersion.$inferSelect)[]>();
  locales: (typeof locale.$inferSelect)[] | null = null;
  // Total nodes resolved this request — the fan-out budget (S2-M4).
  nodesResolved = 0;
  /**
   * Highest `cv` of ANY row resolved this request — the cache version of the whole
   * representation (embedded blocks, ancestor slugs, breadcrumbs, siteName), not
   * just its root row: an ETag from the root alone 304s a page whose embedded block
   * or ancestor changed, and `stale-while-revalidate` then keeps a CDN on the stale
   * copy indefinitely. Folded in `variantRow`, the one funnel every row passes.
   */
  maxCv = 0;
  /** Still within the per-request resolve budget? Past it, callers emit shallow refs. */
  withinResolveBudget(): boolean {
    return this.nodesResolved < MAX_RESOLVE_NODES;
  }
  // Clock for the scheduled-publish window check (published perspective only).
  constructor(
    public db: Database,
    // The site this delivery request is scoped to (multisite). Every content_item
    // lookup is confined to it — including the reference/contentArea graph (which
    // flows through `item()`), so a cross-site reference resolves to null.
    public siteId: string,
    public now: Date = new Date(),
  ) {}

  async asset(documentId: string): Promise<typeof asset.$inferSelect | null> {
    if (this.assets.has(documentId)) return this.assets.get(documentId)!;
    // Per-site media (D2): an image referencing a cross-site asset resolves to null.
    const row = await getAssetRow(this.db, documentId, this.siteId);
    this.assets.set(documentId, row);
    return row;
  }

  /**
   * The version rows `perspective` can select for these documents. Under
   * PUBLISHED, `selectRow` can only ever return an `isCurrentPublished` row, so
   * history rows (full `data` JSONB each) are not loaded — on 2,000 articles that
   * is ~42 MB of heap per `?limit=10` request on a 600 req/min PUBLIC key.
   * PREVIEW still needs everything: its last-resort fallback is "the latest
   * version of any status".
   */
  // `documentIds` may be a subquery, so the versions of a set can be read in
  // the same round trip as the set itself (see cacheVersions).
  selectableVersions(documentIds: string[] | SQLWrapper, perspective: Perspective) {
    return this.db
      .select()
      .from(contentVersion)
      .where(
        perspective === "published"
          ? and(inArray(contentVersion.documentId, documentIds as string[]), eq(contentVersion.isCurrentPublished, true))
          : // Preview selects (per locale) the draft, else the live row, else the
            // latest version (selectRow): only those rows, never the history
            // (a page with 60 old versions shipped all their data every request).
            and(
              inArray(contentVersion.documentId, documentIds as string[]),
              or(
                eq(contentVersion.status, "draft"),
                eq(contentVersion.isCurrentPublished, true),
                sql`${contentVersion.versionNumber} = (select max(v2.version_number) from content_version v2 where v2.document_id = ${contentVersion.documentId} and v2.locale = ${contentVersion.locale})`,
              ),
            ),
      );
  }

  /** The version rows `perspective` may select for one document (cached). */
  async docVersions(documentId: string, perspective: Perspective): Promise<(typeof contentVersion.$inferSelect)[]> {
    const key = `${perspective}:${documentId}`;
    const hit = this.versionsByDoc.get(key);
    if (hit) return hit;
    const rows = await this.selectableVersions([documentId], perspective);
    this.versionsByDoc.set(key, rows);
    return rows;
  }

  /** Cache already-read selectable rows for these documents (as primeVersions would). */
  cacheVersions(documentIds: string[], rows: (typeof contentVersion.$inferSelect)[], perspective: Perspective): void {
    const grouped = new Map<string, (typeof contentVersion.$inferSelect)[]>(documentIds.map((id) => [id, []]));
    for (const r of rows) grouped.get(r.documentId)?.push(r);
    for (const [id, rs] of grouped) if (!this.versionsByDoc.has(`${perspective}:${id}`)) this.versionsByDoc.set(`${perspective}:${id}`, rs);
  }

  /** Bulk-prime version rows for many documents in ONE query (batches the N+1). */
  async primeVersions(documentIds: string[], perspective: Perspective): Promise<void> {
    const missing = documentIds.filter((id) => !this.versionsByDoc.has(`${perspective}:${id}`));
    if (!missing.length) return;
    const rows = await this.selectableVersions(missing, perspective);
    const grouped = new Map<string, (typeof contentVersion.$inferSelect)[]>();
    for (const id of missing) grouped.set(id, []);
    for (const r of rows) grouped.get(r.documentId)?.push(r);
    for (const [id, rs] of grouped) this.versionsByDoc.set(`${perspective}:${id}`, rs);
  }

  // The site's SiteSettings global, looked up once per request (siteName and
  // siteIdentity both need it).
  private _siteSettings: Promise<Array<{ documentId: string }>> | undefined;
  private siteSettingsRows(): Promise<Array<{ documentId: string }>> {
    this._siteSettings ??= this.db
      .select({ documentId: contentItem.documentId })
      .from(contentItem)
      .where(and(eq(contentItem.type, "SiteSettings"), eq(contentItem.kind, "global"), isNull(contentItem.deletedAt), eq(contentItem.siteId, this.siteId)))
      .orderBy(asc(contentItem.id))
      .limit(1)
      // A real Promise: a drizzle query is a lazy thenable that runs again on every await.
      .then((rows) => rows);
    return this._siteSettings;
  }

  // Site name from the SiteSettings global (public field), for og:siteName /
  // jsonLd publisher. Cached per request; resolved through the same perspective
  // so a draft sitename never leaks into a published seo block.
  private _siteName: string | null | undefined;
  async siteName(perspective: Perspective, loc: string): Promise<string | null> {
    if (this._siteName !== undefined) return this._siteName;
    const rows = await this.siteSettingsRows();
    let name: string | null = null;
    if (rows[0]) {
      const found = await variantRow(this, perspective, rows[0].documentId, loc);
      // Read siteName from the SANITIZED map, not the raw row. Reading it raw
      // bypassed the field-exposure gate entirely, so a SiteSettings.siteName marked
      // delivery:"private" was correctly absent from /delivery/globals/SiteSettings
      // yet still surfaced as seo.og.siteName on EVERY page — and apps/web renders
      // that straight into <meta property="og:site_name">. That contradicts the
      // stated contract ("computed post-sanitize, so a private role-tagged field can
      // never leak") and this module's own fail-closed header.
      if (found) {
        const publicData = await sanitize(
          this,
          perspective,
          "SiteSettings",
          found.row.data as Record<string, unknown>,
          found.usedLocale,
          // depth 0: siteName is a scalar; no reference/contentArea graph to walk.
          0,
        );
        const sn = publicData.siteName;
        name = typeof sn === "string" && sn.trim() ? sn : null;
      }
    }
    this._siteName = name;
    return name;
  }

  // The site's identity: the SiteSettings global's schema.org node, when its
  // type declares a schemaType (see resolveContent). Cached per request, and
  // resolved through the same chokepoint and perspective as everything else.
  private _siteIdentity: Record<string, unknown> | null | undefined;
  async siteIdentity(perspective: Perspective, loc: string): Promise<Record<string, unknown> | null> {
    if (this._siteIdentity !== undefined) return this._siteIdentity;
    this._siteIdentity = null;
    const rows = await this.siteSettingsRows();
    if (rows[0]) this._siteIdentity = (await resolveContent(this, perspective, rows[0].documentId, loc, 0))?.jsonLd ?? null;
    return this._siteIdentity;
  }

  // The site's live A/B experiments, loaded once per request (usually none).
  private _experiments = new Map<Perspective, Promise<LiveExperiment[]>>();
  async experimentsOn(perspective: Perspective, documentId: string, loc: string): Promise<LiveExperiment[]> {
    if (!this._experiments.has(perspective)) this._experiments.set(perspective, liveExperiments(this.db, this.siteId, perspective === "preview"));
    return (await this._experiments.get(perspective)!).filter((e) => e.documentId === documentId && e.locale === loc);
  }

  // Every content type, read in ONE query on the first lookup (a page with
  // twenty block types used to cost twenty round trips; the table is small).
  private typesLoaded: Promise<void> | null = null;
  private loadTypes(): Promise<void> {
    this.typesLoaded ??= currentContentTypes(this.db).then((types) => {
      for (const t of types) this.types.set(t.name, t.def);
    });
    return this.typesLoaded;
  }
  async type(name: string): Promise<ContentTypeDef | null> {
    if (this.types.has(name)) return this.types.get(name)!;
    await this.loadTypes();
    return this.types.get(name) ?? null;
  }

  private localesLoaded: Promise<(typeof locale.$inferSelect)[]> | null = null;
  private loadLocales(): Promise<(typeof locale.$inferSelect)[]> {
    this.localesLoaded ??= this.db
      .select()
      .from(locale)
      .then((rows) => (this.locales = rows));
    return this.localesLoaded;
  }

  /**
   * Start the lookups almost every single-item response needs (all content
   * types, the locales, the site's SiteSettings) at once, so they cost one
   * round trip instead of three in a row. Consumers await the same promises, so
   * an error still surfaces where it is used; here it is only kept from being
   * an unhandled rejection.
   */
  warm(perspective: Perspective, opts: { page?: boolean } = {}): this {
    const started: Promise<unknown>[] = [this.loadTypes(), this.loadLocales()];
    // A page's SEO block needs the site's name and identity (the SiteSettings
    // document and its versions, primed as soon as its id is known), and a page
    // may carry experiments; a global needs neither.
    if (opts.page !== false) {
      started.push(
        this.siteSettingsRows().then(async (rows) => {
          if (rows[0]) await Promise.all([this.primeItems([rows[0].documentId]), this.primeVersions([rows[0].documentId], perspective)]);
        }),
        this.experimentsOn(perspective, "", ""),
      );
    }
    for (const p of started) p.catch(() => undefined);
    return this;
  }

  /** Bulk-prime item rows for many documents in ONE query (same filter as item()). */
  async primeItems(documentIds: string[]): Promise<void> {
    const missing = [...new Set(documentIds)].filter((id) => !this.items.has(id));
    if (!missing.length) return;
    const rows = await this.db
      .select({ documentId: contentItem.documentId, type: contentItem.type, kind: contentItem.kind, parentId: contentItem.parentId })
      .from(contentItem)
      .where(and(inArray(contentItem.documentId, missing), isNull(contentItem.deletedAt), eq(contentItem.siteId, this.siteId)));
    for (const id of missing) this.items.set(id, null);
    for (const r of rows) this.items.set(r.documentId, { type: r.type, kind: r.kind, parentId: r.parentId });
  }

  /**
   * Bulk-prime the parent chains of these documents (items, then their
   * selectable versions): one recursive query plus one version query, instead of
   * two round trips per ancestor in urlPathOf and breadcrumbOf. Same filter as
   * item(): this site, not deleted; a chain stops where item() would return null.
   */
  async primeAncestors(documentIds: string[], perspective: Perspective): Promise<void> {
    const needed = documentIds.filter((id) => {
      for (let cur: string | null = id, n = 0; cur && n < 64; n++) {
        if (!this.items.has(cur)) return true;
        cur = this.items.get(cur)?.parentId ?? null;
      }
      return false;
    });
    if (!needed.length) return;
    const ids = sql.join([...new Set(needed)].map((id) => sql`${id}`), sql`, `);
    const rows = (await this.db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT document_id, type, kind, parent_id FROM content_item
          WHERE document_id IN (${ids}) AND deleted_at IS NULL AND site_id = ${this.siteId}
        UNION
        SELECT c.document_id, c.type, c.kind, c.parent_id FROM content_item c
          JOIN chain ON c.document_id = chain.parent_id
          WHERE c.deleted_at IS NULL AND c.site_id = ${this.siteId}
      ) SELECT document_id, type, kind, parent_id FROM chain`)) as unknown as Array<{ document_id: string; type: string; kind: string; parent_id: string | null }>;
    for (const r of rows) this.items.set(r.document_id, { type: r.type, kind: r.kind, parentId: r.parent_id });
    await this.primeVersions(rows.map((r) => r.document_id), perspective);
  }

  /** Bulk-prime asset rows in ONE query (same filter as asset(): this site only). */
  async primeAssets(documentIds: string[]): Promise<void> {
    const missing = [...new Set(documentIds)].filter((id) => !this.assets.has(id));
    if (!missing.length) return;
    const rows = await this.db.select().from(asset).where(and(inArray(asset.documentId, missing), eq(asset.siteId, this.siteId)));
    for (const id of missing) this.assets.set(id, null);
    for (const r of rows) this.assets.set(r.documentId, r);
  }

  // documentId -> item row essentials (type/kind/parentId), cached.
  items = new Map<string, { type: string; kind: string; parentId: string | null } | null>();
  async item(documentId: string): Promise<{ type: string; kind: string; parentId: string | null } | null> {
    if (this.items.has(documentId)) return this.items.get(documentId)!;
    const rows = await this.db
      .select({ type: contentItem.type, kind: contentItem.kind, parentId: contentItem.parentId })
      .from(contentItem)
      .where(and(eq(contentItem.documentId, documentId), isNull(contentItem.deletedAt), eq(contentItem.siteId, this.siteId)))
      .limit(1);
    const row = rows[0] ?? null;
    this.items.set(documentId, row);
    return row;
  }

  /**
   * The fallback chain for `code`. Published reads skip DISABLED locales (an
   * editor disables one to withdraw it; the request then falls back as for an
   * untranslated locale). Preview keeps them, so a locale can be prepared
   * before it is switched on.
   */
  async localeChain(code: string, perspective: Perspective): Promise<string[]> {
    const locales = this.locales ?? (await this.loadLocales());
    const chain = localeChainFrom(locales, code);
    if (perspective === "preview") return chain;
    const disabled = new Set(locales.filter((l) => !l.enabled).map((l) => l.code));
    return chain.filter((c) => !disabled.has(c));
  }

  /** Every enabled locale code in stable (sortIndex) order. */
  async enabledLocaleCodes(): Promise<string[]> {
    const locales = this.locales ?? (await this.loadLocales());
    return [...locales]
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
export function publishWindowOpen(r: typeof contentVersion.$inferSelect, now: Date): boolean {
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
  const all = await ctx.docVersions(documentId, perspective);
  for (const code of await ctx.localeChain(loc, perspective)) {
    const row = rowForLocale(all, perspective, code, ctx.now);
    if (row) {
      // Every resolved row bumps the request's cache version — see ctx.maxCv.
      if (row.cv > ctx.maxCv) ctx.maxCv = row.cv;
      return { row, usedLocale: code };
    }
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
  const chain = await ctx.localeChain(loc, perspective);
  const others = (await ctx.enabledLocaleCodes()).filter((c) => !chain.includes(c));
  const rest = [...chain.slice(chain.indexOf(usedLocale) + 1), ...others];
  if (!rest.length) return data;
  const all = await ctx.docVersions(documentId, perspective);
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

/** Public field name → declared type, from the content-type definition. Lets a
 *  frontend render each field by its schema type instead of sniffing the value
 *  (a richtext doc and a "" both look stringy). Private fields are excluded so
 *  their names/types never leak — same fail-closed rule as `sanitize`. */
function publicFieldTypes(def: ContentTypeDef): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of def.fields) if (f.delivery === "public") out[f.name] = f.type;
  return out;
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
    if (v === undefined) {
      // A DEFINED content area is ALWAYS present in output (as []), even when
      // the instance never set it — so a frontend can tell "this type has a
      // content area (empty)" from "this type has none".
      if (f.type === "contentArea") {
        out[f.name] = [];
      } else if (perspective === "preview" && (f.type === "text" || f.type === "markdown" || f.type === "richtext")) {
        // PREVIEW ONLY: surface unset editable text fields so on-page editing
        // has a clickable target (an absent field renders no DOM → nothing to
        // click). Published output stays lean — these keys never appear there.
        out[f.name] = f.type === "richtext" ? null : "";
      }
      // Other unset fields stay absent.
      continue;
    }

    if (f.type === "image") {
      // Resolve the asset documentId → {url, alt, mime}; missing asset → null.
      const id = typeof v === "string" ? v : "";
      const a = id ? await ctx.asset(id) : null;
      out[f.name] = a ? { documentId: a.documentId, url: absoluteAssetUrl(a.url), alt: a.alt, mime: a.mime } : null;
    } else if (f.type === "reference" && v && typeof v === "object") {
      const rv = v as { documentId?: string; type?: string };
      if (!rv.documentId) {
        out[f.name] = null;
      } else if (depth > 0 && ctx.withinResolveBudget()) {
        out[f.name] = await resolveContent(ctx, perspective, rv.documentId, loc, depth - 1);
      } else {
        // Shallow, but under the same perspective: an unpublished target is null
        // here just as it is when populated.
        out[f.name] = (await isVisible(ctx, perspective, rv.documentId, loc)) ? { documentId: rv.documentId, type: rv.type ?? null } : null;
      }
    } else if (f.type === "link" && v != null) {
      out[f.name] = await resolveLink(ctx, perspective, v, loc);
    } else if (f.type === "richtext" && isRichTextDoc(v)) {
      // Image srcs are stored as uploaded (usually relative /uploads/… paths);
      // absolutize at read time like image FIELDS, so any frontend origin works.
      out[f.name] = absolutizeRichTextImages(v);
    } else if (f.type === "contentArea" && Array.isArray(v)) {
      const blocks: unknown[] = [];
      for (const b of v as Array<Record<string, unknown>>) {
        const blockType = scalarToString(b.blockType);
        const display = b.display ?? "automatic";
        if (b.ref) {
          // Shared block: resolve through the SAME chokepoint/perspective. The
          // shallow entry at populate 0 is gated by that perspective too, or an
          // unpublished block's documentId/type leaked where its body would not.
          const ref = scalarToString(b.ref);
          const resolved =
            depth > 0 && ctx.withinResolveBudget()
              ? await resolveContent(ctx, perspective, ref, loc, depth - 1)
              : (await isVisible(ctx, perspective, ref, loc)) ? { documentId: ref, type: blockType } : null;
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
          const blockDef = await ctx.type(blockType);
          // Each inline block describes its own public field types too.
          blocks.push({ blockType, display, shared: false, data: inlineData, fieldTypes: blockDef ? publicFieldTypes(blockDef) : {} });
        }
      }
      out[f.name] = blocks;
    } else if (isScalarOrScalarArray(v)) {
      // Scalar field types (text/markdown/boolean/number/datetime/select, and
      // legacy media documentIds) store their value verbatim.
      out[f.name] = v;
    } else {
      // A non-scalar here does NOT match this field's CURRENT declared type —
      // most often a contentArea array left behind when the field was retyped to
      // text. Emitting it would ship whatever it holds (e.g. a block's private
      // inline fields) with NO visibility rules applied. Fail-closed, like the
      // `delivery !== "public"` skip at the top of this loop.
      out[f.name] = null;
    }
  }
  return out;
}

/** The top-level TipTap doc shape every richtext write is normalized to (see
 *  RichTextDoc in packages/shared). An ARRAY is not one: after a contentArea →
 *  richtext retype the stored block array reached the richtext branch, and
 *  absolutizeRichTextImages mapped it element-wise straight into the output. */
function isRichTextDoc(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && (v as { type?: unknown }).type === "doc";
}

/** Would `resolveContent` return this document here? The item row (site, not
 *  trashed) plus a visible row in this perspective — without sanitizing it. */
async function isVisible(ctx: DeliveryCtx, perspective: Perspective, documentId: string, loc: string): Promise<boolean> {
  return (await ctx.item(documentId)) !== null && (await variantRow(ctx, perspective, documentId, loc)) !== null;
}

/** True for a value a scalar field legitimately stores: a primitive, null, or an
 *  array of primitives (a multi-select). Objects and arrays-of-objects are not —
 *  those only reach sanitize's final branch when a field was retyped, and must
 *  never be emitted raw. */
function isScalarOrScalarArray(v: unknown): boolean {
  const scalar = (x: unknown) => x === null || ["string", "number", "boolean"].includes(typeof x);
  return scalar(v) || (Array.isArray(v) && v.every(scalar));
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
  await ctx.primeAncestors([documentId], perspective);
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

/**
 * A delivered link.
 *
 * An INTERNAL link stores the target's documentId, so the href is computed here
 * from the page's live urlPath — rename a slug or move the page and every link
 * to it follows. `urlPathOf` is perspective- and site-aware, which gives two
 * things for free: a link to a page that is not published resolves to "" in the
 * published perspective rather than sending a visitor to a 404, and a link
 * across sites cannot resolve at all.
 *
 * The output keeps BOTH halves — the resolved `href` every frontend already
 * reads, and the `documentId` for anything that wants the identity (mirroring
 * Optimizely's headless ContentReference {key, url}). A string value is
 * tolerated so a TEXT field retyped to `link` delivers correctly before its
 * stored values have been rewritten.
 */
async function resolveLink(
  ctx: DeliveryCtx,
  perspective: Perspective,
  raw: unknown,
  loc: string,
): Promise<Record<string, unknown> | null> {
  if (typeof raw === "string") return raw.trim() ? { href: raw.trim() } : null;
  if (!raw || typeof raw !== "object") return null;
  const v = raw as { href?: unknown; documentId?: unknown; anchor?: unknown; text?: unknown; target?: unknown; title?: unknown };
  const anchor = typeof v.anchor === "string" && v.anchor ? `#${v.anchor.replace(/^#/, "")}` : "";
  const documentId = typeof v.documentId === "string" && v.documentId ? v.documentId : "";

  let href = typeof v.href === "string" ? v.href : "";
  if (documentId) {
    const path = await urlPathOf(ctx, perspective, documentId, loc);
    href = path ? `${path}${anchor}` : "";
  } else if (anchor && !href) {
    // Anchor-only link ("jump to a section of this page").
    href = anchor;
  }

  const out: Record<string, unknown> = { href };
  if (documentId) out.documentId = documentId;
  for (const k of ["text", "target", "title"] as const) {
    if (typeof v[k] === "string" && v[k]) out[k] = v[k];
  }
  return out;
}

/**
 * Ancestor trail (root→leaf, incl. self) for the breadcrumb. Same perspective
 * walk as urlPathOf: once an ancestor lacks a visible slug the cumulative path
 * is null from there on (a draft ancestor's path is never exposed).
 */
async function breadcrumbOf(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  loc: string,
): Promise<Array<{ name: string; urlPath: string | null }>> {
  await ctx.primeAncestors([documentId], perspective);
  const chain: Array<{ name: string; slug: string | null }> = [];
  let cur: string | null = documentId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const row = await ctx.item(cur);
    if (!row || row.kind !== "page") break;
    const variant = await variantRow(ctx, perspective, cur, loc);
    chain.unshift({ name: variant?.row.name ?? "", slug: variant?.row.slug ?? null });
    cur = row.parentId;
  }
  const out: Array<{ name: string; urlPath: string | null }> = [];
  const segs: string[] = [];
  let broken = false;
  for (const c of chain) {
    if (c.slug == null) broken = true;
    if (!broken) segs.push(c.slug as string);
    out.push({ name: c.name, urlPath: broken ? null : `/${segs.join("/")}` });
  }
  return out;
}

/** The sanitized value of the field carrying a given seoRole (or undefined). */
function roleValue(def: ContentTypeDef, role: string, data: Record<string, unknown>): unknown {
  const f = def.fields.find((x) => x.seoRole === role);
  return f ? data[f.name] : undefined;
}

// SEO_CONVENTION (the conventional-name safety net when a type hasn't tagged a
// field with an explicit seoRole) lives in @paperboy/shared, shared with the
// type editor's coverage check so the two can't drift. Explicit seoRole /
// metaTitle / ogImage always win over it.
/** First conventionally-named field whose sanitized value passes `usable`. */
function conventionValue(
  def: ContentTypeDef,
  role: string,
  data: Record<string, unknown>,
  usable: (v: unknown) => boolean,
): unknown {
  const names = SEO_CONVENTION[role] ?? [];
  for (const f of def.fields) {
    if (names.includes(f.name.toLowerCase()) && usable(data[f.name])) return data[f.name];
  }
  return undefined;
}
/** role value, else conventional-name value, validated by `usable`. */
function roleOrConvention(
  def: ContentTypeDef,
  role: string,
  data: Record<string, unknown>,
  usable: (v: unknown) => boolean,
): unknown {
  const r = roleValue(def, role, data);
  if (usable(r)) return r;
  return conventionValue(def, role, data, usable);
}
function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
/**
 * A schemaProp field's value as JSON-LD: strings/numbers/booleans pass; a
 * sanitized image ({url,…}) or link ({href,…}) collapses to its URL; a
 * richtext doc becomes its plain text (an Answer's text, say). A list-valued
 * property (SCHEMA_LIST_PROPS) splits text into one entry per line or comma.
 * Other structural values have no sane JSON-LD form and are skipped.
 */
function schemaPropValue(v: unknown, prop: string): string | number | boolean | string[] | undefined {
  if (typeof v === "string" && SCHEMA_LIST_PROPS.has(prop)) {
    const items = v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  if (typeof v === "string") return v.trim() ? v : undefined;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (isRichTextDoc(v)) return tiptapToPlainText(v) || undefined;
  if (v && typeof v === "object") {
    const o = v as { url?: unknown; href?: unknown };
    if (typeof o.url === "string" && o.url) return o.url;
    if (typeof o.href === "string" && o.href) return o.href;
  }
  return undefined;
}

type SchemaNode = Record<string, unknown>;
/** How deep blocks nest into schema.org nodes (FAQ → topic → question is 3). */
const MAX_SCHEMA_DEPTH = 4;

/**
 * Fold `schemaProp`-tagged fields into a node. "a.b" builds a nested object
 * (siblings accumulate, e.g. offers.price + offers.priceCurrency), and known
 * wrapper props get their @type injected — a flat string on a wrapper prop is
 * lifted to {"@type": X, name: value}. A tagged CONTENT AREA becomes the list
 * of nodes its blocks make (areaNodes): an FAQ's questions as `mainEntity`,
 * an organisation's offices as `department`. Only ever called with the
 * sanitized public data, so private fields are simply absent here.
 */
async function applySchemaProps(
  ctx: DeliveryCtx,
  perspective: Perspective,
  def: ContentTypeDef,
  data: Record<string, unknown>,
  node: SchemaNode,
  loc: string,
  depth: number,
): Promise<void> {
  for (const f of def.fields as FieldDef[]) {
    if (!f.schemaProp) continue;
    const [head, leaf] = f.schemaProp.split(".") as [string, string?];
    const value =
      f.type === "contentArea" ? await areaNodes(ctx, perspective, data[f.name], loc, depth) : schemaPropValue(data[f.name], leaf ?? head);
    if (value === undefined) continue;
    const wrapperType = SCHEMA_WRAPPER_TYPES[head];
    if (leaf) {
      const existing = node[head];
      const obj: SchemaNode = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as SchemaNode) : {};
      if (wrapperType && !obj["@type"]) obj["@type"] = wrapperType;
      obj[leaf] = value;
      node[head] = obj;
    } else {
      node[head] = wrapperType && typeof value === "string" ? { "@type": wrapperType, name: value } : value;
    }
  }
}

/**
 * The schema.org nodes in a content area. A block whose type declares a
 * schemaType becomes one node; a block without one is transparent, and the
 * nodes in its own (untagged) content areas count instead — so an FAQ's
 * topic blocks hand their questions up to the FAQ. Pages placed in an area are
 * teasers, not parts, and are skipped. Undefined when there are none.
 */
async function areaNodes(ctx: DeliveryCtx, perspective: Perspective, area: unknown, loc: string, depth: number): Promise<SchemaNode[] | undefined> {
  if (!Array.isArray(area) || depth >= MAX_SCHEMA_DEPTH) return undefined;
  const nodes: SchemaNode[] = [];
  for (const entry of area) {
    const block = await areaBlock(ctx, perspective, entry, loc);
    const def = block ? await ctx.type(block.type) : null;
    if (!block || !def) continue;
    if (def.schemaType) {
      nodes.push(await schemaNode(ctx, perspective, def, block.data, loc, depth + 1));
      continue;
    }
    for (const f of def.fields) {
      if (f.type === "contentArea" && !f.schemaProp) nodes.push(...((await areaNodes(ctx, perspective, block.data[f.name], loc, depth + 1)) ?? []));
    }
  }
  return nodes.length ? nodes : undefined;
}

/** A sanitized content-area entry as {type, data}: an inline block as it is, a
 *  shared block through the chokepoint when it wasn't populated (same
 *  perspective, same budget). A page in the area is not a block → null. */
async function areaBlock(ctx: DeliveryCtx, perspective: Perspective, entry: unknown, loc: string): Promise<{ type: string; data: Record<string, unknown> } | null> {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { blockType?: unknown; data?: unknown; content?: { documentId?: unknown; kind?: unknown; type?: unknown; data?: unknown } };
  if (e.data && typeof e.data === "object") return { type: scalarToString(e.blockType), data: e.data as Record<string, unknown> };
  const c = e.content;
  if (!c) return null;
  if (c.data && typeof c.data === "object") return c.kind === "block" ? { type: scalarToString(c.type), data: c.data as Record<string, unknown> } : null;
  if (typeof c.documentId !== "string" || !ctx.withinResolveBudget()) return null;
  // A page stub is a teaser, not a part: skip it unresolved. Resolving it to find
  // out ran ITS structured data too, so pages teasing each other recursed A → B → A
  // until the resolve budget was spent and every later sibling came back a stub.
  const stubType = typeof c.type === "string" ? await ctx.type(c.type) : null;
  if (stubType && stubType.kind !== "block") return null;
  const resolved = await resolveContent(ctx, perspective, c.documentId, loc, 0);
  return resolved && resolved.kind === "block" ? { type: resolved.type, data: resolved.data } : null;
}

const isStr = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const isImg = (v: unknown) => asImage(v) != null;

/**
 * The node for a block or global whose type declares a schemaType: the Thing
 * subset every @type accepts (name, description, image — from the SEO roles
 * and naming conventions), then the type's explicit schemaProp mappings.
 */
async function schemaNode(
  ctx: DeliveryCtx,
  perspective: Perspective,
  def: ContentTypeDef,
  data: Record<string, unknown>,
  loc: string,
  depth: number,
): Promise<SchemaNode> {
  const node: SchemaNode = { "@type": def.schemaType };
  const name = asText(roleOrConvention(def, "title", data, isStr));
  const description = asText(roleOrConvention(def, "description", data, isStr));
  const image = asImage(roleOrConvention(def, "image", data, isImg));
  if (name) node.name = name;
  if (description) node.description = description;
  if (image) node.image = image.url;
  await applySchemaProps(ctx, perspective, def, data, node, loc, depth);
  return node;
}

/**
 * An article's author. When it names the site's own organisation — the name,
 * legal name or alternate name of the SiteSettings identity, or the site name
 * — it is that organisation, not a person who happens to share its name.
 */
async function authorNode(ctx: DeliveryCtx, perspective: Perspective, loc: string, author: string, siteName: string | null): Promise<SchemaNode> {
  const identity = await ctx.siteIdentity(perspective, loc);
  const names = [identity?.name, identity?.legalName, identity?.alternateName, siteName].filter((n): n is string => typeof n === "string");
  const wanted = author.trim().toLowerCase();
  if (!names.some((n) => n.trim().toLowerCase() === wanted)) return { "@type": "Person", name: author };
  return { "@type": typeof identity?.["@type"] === "string" ? identity["@type"] : "Organization", name: typeof identity?.name === "string" ? identity.name : author };
}

/** Nodes for blocks on a page (its untagged content areas), for seo.jsonLdParts. */
async function pageParts(ctx: DeliveryCtx, perspective: Perspective, def: ContentTypeDef, data: Record<string, unknown>, loc: string): Promise<SchemaNode[]> {
  const parts: SchemaNode[] = [];
  for (const f of def.fields) {
    if (f.type === "contentArea" && !f.schemaProp) parts.push(...((await areaNodes(ctx, perspective, data[f.name], loc, 0)) ?? []));
  }
  return parts;
}

/** An image field is sanitized to {url, alt, …}; normalize to {url, alt}. */
function asImage(v: unknown): { url: string; alt: string } | null {
  if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") {
    const o = v as { url: string; alt?: unknown };
    return { url: o.url, alt: typeof o.alt === "string" ? o.alt : "" };
  }
  return null;
}

/**
 * Compute the normalized SEO + schema.org block for a PAGE. Reads ONLY the
 * already-sanitized (public) data, so a private field — even one tagged with a
 * seoRole — can never feed it (no-leak preserved). URLs that depend on the
 * public origin stay relative; the frontend absolutizes them.
 */
async function computeSeo(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  def: ContentTypeDef,
  name: string,
  urlPath: string | null,
  data: Record<string, unknown>,
  loc: string,
  /** When the delivered version was made — what sitemap.xml gives as lastmod. */
  versionDate: Date,
): Promise<DeliveryContent["seo"]> {
  const title = asText(data.metaTitle) ?? asText(roleOrConvention(def, "title", data, isStr)) ?? name;
  const description = asText(data.metaDescription) ?? asText(roleOrConvention(def, "description", data, isStr));
  const image = asImage(data.ogImage) ?? asImage(roleOrConvention(def, "image", data, isImg));
  // The frontend renders this into <link rel="canonical">, so only an absolute
  // http(s) URL or a root-relative path may replace the page's own path.
  const canonicalField = asText(data.canonicalUrl);
  const canonicalPath = canonicalField && isSafeUrl(canonicalField) && /^(https?:\/\/|\/)/i.test(canonicalField) ? canonicalField : urlPath;

  // schema.org @type: explicit schemaType, else derived from the type's shape.
  const hasDate = def.fields.some((f) => f.seoRole === "datePublished");
  const isList = def.fields.some((f) => f.name === "listedType");
  const schemaType =
    def.schemaType ?? (isList ? "CollectionPage" : hasDate ? "Article" : "WebPage");

  const ogTypeField = asText(data.ogType);
  const ogType =
    ogTypeField ?? (schemaType === "Article" || schemaType === "BlogPosting" ? "article" : "website");

  // Preview is NEVER indexable; otherwise honor the noIndex field.
  const robots =
    perspective === "preview" ? "noindex, nofollow" : data.noIndex ? "noindex, follow" : "index, follow";

  const siteName = await ctx.siteName(perspective, loc);
  const datePublished = asText(roleOrConvention(def, "datePublished", data, isStr));
  // A field tagged dateModified wins (rarely a distinct field); otherwise the
  // delivered version's date, the same lastmod sitemap.xml gives. Freshness is
  // something search engines and AI assistants weigh, and it was always absent.
  const dateModified = asText(roleValue(def, "dateModified", data)) ?? versionDate.toISOString();
  const author = asText(roleOrConvention(def, "author", data, isStr));
  const keywords = asText(roleOrConvention(def, "keywords", data, isStr));

  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": schemaType,
  };
  if (isCreativeWorkType(schemaType)) {
    jsonLd.headline = title;
    jsonLd.inLanguage = loc;
    if (description) jsonLd.description = description;
    if (image) jsonLd.image = image.url;
    if (datePublished) jsonLd.datePublished = datePublished;
    if (dateModified) jsonLd.dateModified = dateModified;
    if (author) jsonLd.author = await authorNode(ctx, perspective, loc, author, siteName);
    if (keywords) jsonLd.keywords = keywords;
  } else {
    // Product/Event/custom @types are not CreativeWorks: headline, author,
    // keywords and datePublished are invalid there. Emit the Thing subset —
    // the only properties valid on EVERY schema.org type — and let explicit
    // schemaProp mappings carry the @type-specific rest.
    jsonLd.name = title;
    if (description) jsonLd.description = description;
    if (image) jsonLd.image = image.url;
  }
  // Explicit field → schema.org property mappings, applied LAST so an explicit
  // mapping wins over a derived prop. Reads the sanitized PUBLIC data only —
  // a private field's schemaProp can never leak.
  await applySchemaProps(ctx, perspective, def, data, jsonLd, loc, 0);
  const parts = await pageParts(ctx, perspective, def, data, loc);

  return {
    title,
    description,
    canonicalPath,
    robots,
    og: {
      title: asText(data.ogTitle) ?? title,
      description: asText(data.ogDescription) ?? description,
      type: ogType,
      image,
      siteName,
    },
    twitter: { card: asText(data.twitterCard) ?? (image ? "summary_large_image" : "summary") },
    jsonLd,
    ...(parts.length ? { jsonLdParts: parts } : {}),
    breadcrumb: await breadcrumbOf(ctx, perspective, documentId, loc),
  };
}

/**
 * A Form's SHARED field blocks, resolved through the chokepoint at this
 * perspective whatever the request's populate depth — the spec must be complete
 * at populate 0 too, and an unpublished, trashed or cross-site field block is
 * invisible exactly like an inline field that was never published. Sanitized
 * like any resolved item, so a private field never reaches the spec.
 */
async function sharedFormFields(ctx: DeliveryCtx, perspective: Perspective, data: Record<string, unknown>, loc: string): Promise<SharedBlockResolver> {
  const blocks = new Map<string, { blockType: string; data: Record<string, unknown> }>();
  for (const raw of Array.isArray(data.fields) ? data.fields : []) {
    const ref = raw && typeof raw === "object" ? (raw as { ref?: unknown }).ref : undefined;
    if (typeof ref !== "string" || !ref || blocks.has(ref)) continue;
    const resolved = await resolveContent(ctx, perspective, ref, loc, 0);
    if (resolved) blocks.set(ref, { blockType: resolved.type, data: resolved.data });
  }
  return (documentId) => blocks.get(documentId);
}

export async function resolveContent(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  loc: string,
  depth: number,
): Promise<DeliveryContent | null> {
  // The document, its ancestors (for urlPath) and their versions in two round
  // trips; priming never touches maxCv, only variantRow does.
  await ctx.primeAncestors([documentId], perspective);
  // Item first: a cross-site or trashed document is not part of this
  // representation, so its rows must not reach variantRow's maxCv bump.
  const item = await ctx.item(documentId);
  if (!item) return null;
  const found = await variantRow(ctx, perspective, documentId, loc);
  if (!found) return null;
  ctx.nodesResolved++; // count this node against the per-request fan-out budget (S2-M4)
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
  await primeReferences(ctx, perspective, [[item.type, data]], depth);
  const sanitized = await sanitize(ctx, perspective, item.type, data, found.usedLocale, depth);
  const urlPath = await urlPathOf(ctx, perspective, documentId, loc);
  const def = await ctx.type(item.type);
  // SEO/schema.org contract — pages only, computed from SANITIZED (public) data.
  let seo: DeliveryContent["seo"] = null;
  if (item.kind === "page" && def) {
    seo = await computeSeo(ctx, perspective, documentId, def, found.row.name, urlPath, sanitized, found.usedLocale, found.row.createdAt);
  }
  // A global whose type declares a schemaType carries its own node — the
  // SiteSettings identity (Organization, LocalBusiness…) set in the CMS.
  const jsonLd =
    item.kind === "global" && def?.schemaType
      ? { "@context": "https://schema.org", ...(await schemaNode(ctx, perspective, def, sanitized, found.usedLocale, 0)) }
      : undefined;
  // A Form ships a normalized, ready-to-render spec beside its raw fields, so a
  // frontend never has to interpret block payloads to draw a form — and so the
  // labels/rules it renders are exactly the ones the submit endpoint enforces.
  // Computed from SANITIZED data, so a private field can never reach it.
  const form = isFormType(item.type)
    ? formSpecFrom(sanitized, { sharedBlock: await sharedFormFields(ctx, perspective, data, found.usedLocale) })
    : undefined;
  const experiments = item.kind === "page" ? await deliveredExperiments(ctx, perspective, item.type, documentId, found.usedLocale, depth) : [];
  return {
    documentId,
    type: item.type,
    // kind lets a frontend tell a PAGE in a content area (render as a teaser
    // linking to urlPath) from a shared block (render by blockType).
    kind: item.kind as DeliveryContent["kind"],
    locale: found.usedLocale,
    name: found.row.name,
    slug: found.row.slug,
    urlPath,
    // The graph's cache version, not just this row's — everything embedded above
    // has already passed through variantRow by now. See DeliveryCtx.maxCv.
    cv: Math.max(found.row.cv, ctx.maxCv),
    data: sanitized,
    // Public field types so a frontend renders by schema type, not value shape.
    fieldTypes: def ? publicFieldTypes(def) : {},
    seo,
    ...(jsonLd ? { jsonLd } : {}),
    ...(form ? { form } : {}),
    ...(experiments.length ? { experiments } : {}),
  };
}

/**
 * A page's A/B experiments (#125) as delivery ships them: each alternative
 * version goes through `sanitize` exactly as the area would, so a private field
 * in a version can't leak, and its shared blocks resolve under the same
 * perspective and budget. A version of a non-public area is never shipped.
 * The experiment's cv folds into the page's, so starting or ending one changes
 * the ETag. SEO is computed from the control before this runs.
 */
async function deliveredExperiments(
  ctx: DeliveryCtx,
  perspective: Perspective,
  typeName: string,
  documentId: string,
  loc: string,
  depth: number,
): Promise<NonNullable<DeliveryContent["experiments"]>> {
  const out: NonNullable<DeliveryContent["experiments"]> = [];
  for (const e of await ctx.experimentsOn(perspective, documentId, loc)) {
    const arms: NonNullable<DeliveryContent["experiments"]>[number]["arms"] = [];
    let isPublicArea = true;
    for (const a of e.arms) {
      if (a.key === "a" || !a.blocks) {
        arms.push({ key: a.key as ExperimentArmKey, weight: a.weight });
        continue;
      }
      const delivered = (await sanitize(ctx, perspective, typeName, { [e.area]: a.blocks }, loc, depth))[e.area];
      if (!Array.isArray(delivered)) {
        isPublicArea = false;
        break;
      }
      arms.push({ key: a.key as ExperimentArmKey, weight: a.weight, blocks: delivered });
    }
    if (!isPublicArea) continue;
    ctx.maxCv = Math.max(ctx.maxCv, e.cv);
    out.push({ id: e.id, area: e.area, goal: e.goal, arms, ...(perspective === "preview" ? { status: e.status as ExperimentStatus } : {}) });
  }
  return out;
}

/**
 * Before a document is sanitized, load everything it points at in ONE round
 * trip: the documents its content areas, references and page links name (their
 * items and selectable versions) and the assets its image fields hold, at every
 * level of its inline blocks. sanitize() then finds them in the request caches
 * instead of asking for each one (a page with 24 images and 10 shared blocks
 * made ~60 sequential queries; on a managed database every one is a network
 * round trip). Same filters as the one-at-a-time lookups, so the output is
 * identical; only the number of round trips changes.
 */
async function primeReferences(ctx: DeliveryCtx, perspective: Perspective, roots: Array<[typeName: string, data: Record<string, unknown>]>, depth: number): Promise<void> {
  let docs: string[] = [];
  let assets: string[] = [];
  const walk = async (name: string, values: Record<string, unknown>, level: number): Promise<void> => {
    const def = await ctx.type(name);
    if (!def || level > MAX_POPULATE_DEPTH + 2) return;
    for (const f of def.fields) {
      if (f.delivery !== "public") continue;
      const v = values[f.name];
      if (v == null) continue;
      if ((f.type === "image" || f.type === "media") && typeof v === "string" && v) assets.push(v);
      else if ((f.type === "reference" || f.type === "link") && typeof v === "object") {
        const id = (v as { documentId?: unknown }).documentId;
        if (typeof id === "string" && id) docs.push(id);
      } else if (f.type === "contentArea" && Array.isArray(v)) {
        for (const b of v as Array<Record<string, unknown>>) {
          if (typeof b?.ref === "string" && b.ref) docs.push(b.ref);
          else if (b?.inline && typeof b.inline === "object") await walk(scalarToString(b.blockType), b.inline as Record<string, unknown>, level + 1);
        }
      }
    }
  };
  for (const [typeName, data] of roots) await walk(typeName, data, 0);
  // Level by level through the graph the response will resolve (populate
  // depth): what the referenced documents point at is primed in the NEXT single
  // round trip, not one per document. Their selectable rows are walked (a
  // superset of the one variantRow picks), which can only add cache entries.
  for (let level = 0; level <= depth && (docs.length || assets.length); level++) {
    const batch = [...new Set(docs)].filter((id) => !ctx.items.has(id));
    await Promise.all([ctx.primeItems(docs), ctx.primeVersions(docs, perspective), ctx.primeAssets(assets)]);
    docs = [];
    assets = [];
    if (level === depth) break;
    for (const id of batch) {
      const it = ctx.items.get(id);
      if (!it) continue;
      for (const row of await ctx.docVersions(id, perspective)) {
        // Only rows variantRow can select (a draft or the live row), not history.
        if ((row.status === "draft" || row.isCurrentPublished) && row.data && typeof row.data === "object") await walk(it.type, row.data as Record<string, unknown>, 0);
      }
    }
  }
}

/* ------------------------------ public API -------------------------------- */

function clampDepth(populate: number | undefined): number {
  if (!populate || populate < 0) return 0;
  return Math.min(populate, MAX_POPULATE_DEPTH);
}

export async function deliveryGetById(
  db: Database,
  perspective: Perspective,
  siteId: string,
  documentId: string,
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db, siteId).warm(perspective);
  return resolveContent(ctx, perspective, documentId, loc, clampDepth(populate));
}

export async function deliveryGetBySlug(
  db: Database,
  perspective: Perspective,
  siteId: string,
  slug: string,
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db, siteId).warm(perspective);
  // Find candidate variants by slug, then re-resolve via the chokepoint so the
  // perspective filter (not the slug lookup) decides visibility.
  //
  // Joined to content_item so the candidate scan is site-partitioned and skips
  // trashed documents, like every other broad delivery scan.
  const rows = await db
    .select({ documentId: contentVersion.documentId })
    .from(contentVersion)
    .innerJoin(contentItem, eq(contentItem.documentId, contentVersion.documentId))
    .where(
      and(
        eq(contentVersion.slug, slug),
        eq(contentVersion.locale, loc),
        isNull(contentItem.deletedAt),
        eq(contentItem.siteId, siteId),
      ),
    );
  for (const r of rows) {
    const resolved = await resolveContent(ctx, perspective, r.documentId, loc, clampDepth(populate));
    if (!resolved) continue;
    // The candidate scan matches ANY version row carrying this slug — drafts and
    // superseded history included — but the chokepoint resolves the DOCUMENT, so
    // what comes back is whatever version this perspective selects. Its slug can
    // therefore be a DIFFERENT one, and answering 200 for a slug the delivered
    // version doesn't have is two bugs at once:
    //
    //   * an existence oracle over unreleased URLs — renaming a draft to
    //     `secret-campaign-2027` made that slug answer 200 (with the published
    //     content) while an invented slug answered 404, under the PUBLIC key;
    //   * every slug a page ever had kept answering forever, so a rename left
    //     permanent duplicate content at the old URL.
    //
    // Requiring the match means the perspective decides the URL space too.
    if (resolved.slug === slug) return resolved;
  }
  return null;
}

/** Hard ceiling on what ONE list request may resolve (each item costs its populate
 *  graph plus an SEO block). Not a default page size — a silent default would
 *  truncate deployed frontends; past the cap the request is refused with the recipe. */
export const MAX_LIST_ITEMS = 500;

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

/** Word tokens under Postgres' 'simple' text-search config: lowercase, split on
 *  non-alphanumeric. No stemming or stop-words (that's what 'simple' does), so a
 *  whole-token membership check faithfully reproduces an AND-of-terms match. */
function tokenizeSimple(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Flatten every string/number/boolean leaf of a (public) value into acc. */
function collectStrings(v: unknown, acc: string[]): void {
  if (v == null) return;
  if (typeof v === "string") acc.push(v);
  else if (typeof v === "number" || typeof v === "boolean") acc.push(String(v));
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, acc);
  else if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, acc);
}

export async function deliveryList(
  db: Database,
  perspective: Perspective,
  siteId: string,
  typeName: string | undefined,
  loc: string,
  populate?: number,
  parentId?: string,
  opts: DeliveryListOptions = {},
): Promise<{ items: DeliveryContent[]; total: number }> {
  if (!typeName && !parentId) return { items: [], total: 0 }; // unbounded "everything" listing is not a thing
  const ctx = new DeliveryCtx(db, siteId);
  // Optional hierarchy filter (a ListPage / teaser ListBlock listing a page's
  // children — with parentId the type may be omitted to list children of any
  // type). Visibility still comes from resolveContent — same chokepoint rules.
  const conds = [isNull(contentItem.deletedAt), eq(contentItem.siteId, siteId)];
  if (typeName) conds.push(eq(contentItem.type, typeName));
  if (parentId) conds.push(eq(contentItem.parentId, parentId));
  const items = await db
    .select({ documentId: contentItem.documentId, type: contentItem.type })
    .from(contentItem)
    .where(and(...conds))
    .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));
  await ctx.primeVersions(items.map((i) => i.documentId), perspective); // one query, not N

  // Visibility, filtering and sorting all read the CHOKEPOINT's own version
  // selection (variantRow: perspective + publish window + locale fallback) —
  // never a parallel query path — so a draft can't influence public ordering.
  const candidates: { documentId: string; type: string; row: typeof contentVersion.$inferSelect }[] = [];
  for (const it of items) {
    const variant = await variantRow(ctx, perspective, it.documentId, loc);
    if (variant) candidates.push({ documentId: it.documentId, type: it.type, row: variant.row });
  }

  // Field-visibility gate: filter/sort may only reference PUBLIC fields (plus the
  // intrinsic name/slug/createdAt). Otherwise a public consumer could filter or
  // sort by a delivery:"private" field and read the (sanitized) result set as an
  // inference oracle over the hidden value. A non-public key is IGNORED (not
  // rejected) so it gives no signal — same outcome as an unknown field. Resolved
  // per ITEM type (a parentId-only listing can hold mixed types): a field private
  // on one type contributes no key/constraint for that item even if it is public
  // on a sibling's type. (H1 + M1.)
  const publicFieldsByType = new Map<string, Set<string>>();
  for (const t of new Set(candidates.map((c) => c.type))) {
    const def = await ctx.type(t);
    publicFieldsByType.set(t, new Set(def ? def.fields.filter((f) => f.delivery === "public").map((f) => f.name) : []));
  }
  const fieldAllowed = (field: string, type: string) =>
    field === "name" || field === "slug" || (publicFieldsByType.get(type)?.has(field) ?? false);

  let filtered = candidates;
  if (opts.filter && Object.keys(opts.filter).length) {
    filtered = filtered.filter(({ row, type }) => {
      const data = row.data as Record<string, unknown>;
      for (const [field, want] of Object.entries(opts.filter!)) {
        if (!fieldAllowed(field, type)) continue; // private/unknown key: no constraint, no oracle
        const have = field === "name" ? row.name : field === "slug" ? row.slug : data[field];
        const ok = Array.isArray(have) ? have.map(scalarToString).includes(want) : scalarToString(have) === want;
        if (!ok) return false;
      }
      return true;
    });
  }

  // Default order: the container's declared childSort, when listing a page's
  // children without an explicit sort (an explicit ?sort= always wins). The
  // same rule orders the admin tree, so editors and readers see one sequence.
  let effectiveSort = opts.sort;
  if (!effectiveSort && parentId) {
    const parentRule = (
      await db
        .select({ cs: contentItem.childSort })
        .from(contentItem)
        .where(and(eq(contentItem.documentId, parentId), eq(contentItem.siteId, siteId)))
        .limit(1)
    )[0]?.cs;
    if (parentRule && parentRule !== "manual") effectiveSort = parentRule;
  }

  if (effectiveSort) {
    // Missing/gated keys stay last regardless of direction; equal keys keep tree
    // order — so an all-private or unknown sort key degrades to the tree order,
    // exactly as if the key had been ignored.
    filtered = sortByRule(filtered, effectiveSort, ({ row, type }, key) => {
      if (key === "name") return row.name;
      if (key === "createdAt") return row.createdAt.toISOString();
      if (key.startsWith("data.")) {
        const field = key.slice(5);
        return publicFieldsByType.get(type)?.has(field) ? (row.data as Record<string, unknown>)[field] : null;
      }
      return null;
    });
  }

  const total = filtered.length;
  const offset = Math.max(0, opts.offset ?? 0);
  const page = opts.limit != null ? filtered.slice(offset, offset + opts.limit) : filtered.slice(offset);
  if (page.length > MAX_LIST_ITEMS) {
    throw Errors.badRequest(
      `This list has ${total} items, more than the ${MAX_LIST_ITEMS} one request may resolve. ` +
        `Paginate: pass limit (at most ${MAX_LIST_ITEMS}) and offset — every page reports the full total (and X-Total-Count).`,
    );
  }

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

/** llms.txt description candidates, most editorial first. Gated per type by
 *  delivery visibility below — a type that marks e.g. `summary` private never
 *  leaks it into the page inventory. (metaDescription is in the reserved SEO
 *  group, always public on pages.) */
const PAGE_DESCRIPTION_FIELDS = ["teaserText", "metaDescription", "summary", "intro"] as const;

/**
 * The public page inventory: every PAGE visible in this perspective, one row
 * per genuine (page, locale) variant, with its urlPath — the primitive
 * sitemap.xml / llms.txt / robots.txt generation builds on (and useful to any
 * frontend building its own). Chokepoint rules apply unchanged: visibility and
 * paths come from the same variantRow/urlPathOf walk as every delivery read
 * (a draft ancestor hides the whole subtree in the published perspective),
 * locale-FALLBACK variants are not listed (only real ones — no duplicate URLs),
 * and the description honours per-type field visibility.
 */
/**
 * The PUBLISHED urlPath of every genuine (page, locale) variant — of the given
 * pages, or of every page in the site. The lean half of deliveryPages (no
 * descriptions, no noIndex), for redirects: resolving a page target to its live
 * URL, and noticing when publishing or moving a page changed its URL. Same
 * chokepoint walk, so it agrees with what delivery actually serves.
 */
/**
 * Record the rows a page listing already read (same filter as ctx.item(): this
 * site, not deleted). A page's ancestors are pages of the same site, so the
 * listing holds every chain urlPathOf walks: it used to run one recursive
 * query per page and locale (~100 in a row for a sitemap of 50 pages).
 */
function rememberItems(ctx: DeliveryCtx, items: Array<{ documentId: string; type: string; kind: string; parentId: string | null }>): void {
  for (const { documentId, ...item } of items) if (!ctx.items.has(documentId)) ctx.items.set(documentId, item);
}

export async function publishedPagePaths(
  db: Database,
  siteId: string,
  documentIds?: string[],
): Promise<{ documentId: string; locale: string; urlPath: string }[]> {
  if (documentIds && documentIds.length === 0) return [];
  const ctx = new DeliveryCtx(db, siteId);
  const locales = await db.select({ code: locale.code }).from(locale).where(eq(locale.enabled, true)).orderBy(asc(locale.sortIndex));
  const conditions = [isNull(contentItem.deletedAt), eq(contentItem.siteId, siteId), eq(contentItem.kind, "page")];
  if (documentIds) conditions.push(inArray(contentItem.documentId, documentIds));
  const items = await db
    .select({ documentId: contentItem.documentId, type: contentItem.type, kind: contentItem.kind, parentId: contentItem.parentId })
    .from(contentItem)
    .where(and(...conditions));
  rememberItems(ctx, items);
  await ctx.primeVersions(items.map((i) => i.documentId), "published");
  const out: { documentId: string; locale: string; urlPath: string }[] = [];
  for (const { code } of locales) {
    for (const it of items) {
      const variant = await variantRow(ctx, "published", it.documentId, code);
      if (!variant || variant.usedLocale !== code) continue;
      const urlPath = await urlPathOf(ctx, "published", it.documentId, code);
      if (urlPath) out.push({ documentId: it.documentId, locale: code, urlPath });
    }
  }
  return out;
}

export async function deliveryPages(
  db: Database,
  perspective: Perspective,
  siteId: string,
): Promise<{ pages: PublicPageEntry[]; cv: number }> {
  const ctx = new DeliveryCtx(db, siteId);
  const locales = await db.select({ code: locale.code }).from(locale).where(eq(locale.enabled, true)).orderBy(asc(locale.sortIndex));
  const items = await db
    .select({ documentId: contentItem.documentId, type: contentItem.type, kind: contentItem.kind, parentId: contentItem.parentId })
    .from(contentItem)
    .where(and(isNull(contentItem.deletedAt), eq(contentItem.siteId, siteId), eq(contentItem.kind, "page")))
    .orderBy(asc(contentItem.sortIndex), asc(contentItem.id));
  rememberItems(ctx, items);
  await ctx.primeVersions(items.map((i) => i.documentId), perspective);

  const publicFieldsByType = new Map<string, Set<string>>();
  const pages: PublicPageEntry[] = [];
  let cv = 0;
  for (const { code } of locales) {
    for (const it of items) {
      const variant = await variantRow(ctx, perspective, it.documentId, code);
      // Genuine variants only: a locale served via FALLBACK would list the same
      // page again under another locale prefix — a duplicate, not a translation.
      if (!variant || variant.usedLocale !== code) continue;
      const urlPath = await urlPathOf(ctx, perspective, it.documentId, code);
      if (!urlPath) continue;
      let pub = publicFieldsByType.get(it.type);
      if (!pub) {
        const def = await ctx.type(it.type);
        pub = new Set(def ? def.fields.filter((f) => f.delivery === "public").map((f) => f.name) : []);
        publicFieldsByType.set(it.type, pub);
      }
      // noIndex is localized:false but stored per locale-version; fill it (and any
      // other shared field) from a sibling variant, exactly as resolveContent
      // does, so a flag set on one locale is not lost on another — which would
      // advertise, in sitemap.xml/llms.txt, a path the CMS marks noindex.
      const data = await fillNonLocalizedFields(ctx, perspective, it.documentId, it.type, variant.row.data as Record<string, unknown>, variant.usedLocale, code);
      let description: string | undefined;
      for (const key of PAGE_DESCRIPTION_FIELDS) {
        const v = data[key];
        if (pub.has(key) && typeof v === "string" && v.trim()) {
          description = v.replace(/\s+/g, " ").trim().slice(0, 200);
          break;
        }
      }
      cv = Math.max(cv, variant.row.cv);
      pages.push({
        documentId: it.documentId,
        type: it.type,
        name: variant.row.name,
        locale: code,
        urlPath,
        lastmod: variant.row.createdAt.toISOString(),
        noIndex: data.noIndex === true,
        ...(description ? { description } : {}),
      });
    }
  }
  return { pages, cv };
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
  siteId: string,
  query: string,
  loc: string,
  typeName?: string,
  limit = 20,
): Promise<{ items: DeliveryContent[]; total: number }> {
  const q = query.trim();
  if (!q) return { items: [], total: 0 };

  // NEGATION IS A PUBLIC-TEXT OPERATION and must never reach the SQL tsquery:
  // `v.fts` indexes the whole `data` JSONB, private fields included, and a
  // `-term` the SQL honours turns the public key into a word-membership oracle
  // over private text (`?q=Kiwifruit -bluewhale → []` ⇒ "bluewhale" is in the
  // private field). Negated words are applied to the SANITIZED PUBLIC text
  // (`negated` below), so a private match can neither include nor exclude a document.
  const words = q.split(/\s+/).filter(Boolean);
  const positiveQuery = words.filter((w) => !w.startsWith("-")).join(" ");
  // A query of only negations has nothing to match on; refusing it beats letting
  // the bare exclusion run against private text.
  if (!positiveQuery) return { items: [], total: 0 };
  const negated = tokenizeSimple(
    words
      .filter((w) => w.startsWith("-"))
      .map((w) => w.slice(1))
      .join(" "),
  );
  const ctx = new DeliveryCtx(db, siteId).warm(perspective);
  const chain = await ctx.localeChain(loc, perspective);
  const max = Math.min(Math.max(limit, 1), 100);
  // The SQL prefilter scans the WHOLE version row (incl. delivery:"private" field
  // text), so it only OVER-approximates the candidate set for ranking. We widen
  // the window and then re-check each candidate against its SANITIZED PUBLIC text
  // below, dropping any hit that matched ONLY on a private field — otherwise the
  // hit/no-hit signal is a content-presence oracle over private data (M2).
  // Matches against the STORED generated tsvector column + its GIN index
  // (0017_delivery_search_tsvector.sql). Ranking reads the same column, so a
  // candidate row's `data` JSONB is never re-tokenized at query time — that
  // recomputation, not a missing index, was the cost here (295.9ms → 17.6ms on
  // 40k versions). The column's expression is the migration's single source of
  // truth; don't inline to_tsvector(...) again or the index stops being used.
  const rows = (await db.execute(sql`
    SELECT DISTINCT v.document_id AS id,
           MAX(ts_rank(v.fts, websearch_to_tsquery('simple', ${positiveQuery}))) AS rank
    FROM content_version v
    JOIN content_item i ON i.document_id = v.document_id AND i.deleted_at IS NULL AND i.site_id = ${siteId}
    WHERE v.fts @@ websearch_to_tsquery('simple', ${positiveQuery})
      AND v.locale IN (${sql.join(chain.map((c) => sql`${c}`), sql`, `)})
      AND ${perspective === "published" ? sql`v.is_current_published` : sql`(v.status = 'draft' OR v.is_current_published)`}
      ${typeName ? sql`AND i.type = ${typeName}` : sql``}
    GROUP BY v.document_id
    ORDER BY rank DESC
    LIMIT ${max * 5}
  `)) as unknown as { id: string; rank: number }[];
  // Every candidate, its ancestors (for urlPath) and their versions in two
  // round trips, not two per candidate as each resolves below.
  await ctx.primeAncestors(rows.map((r) => r.id), perspective);
  // ...and what they all point at, in one more (their selectable rows walked
  // without variantRow, which would move ctx.maxCv and so each hit's cv).
  const roots: Array<[string, Record<string, unknown>]> = [];
  for (const r of rows) {
    const it = ctx.items.get(r.id);
    if (!it) continue;
    for (const row of await ctx.docVersions(r.id, perspective)) {
      if ((row.status === "draft" || row.isCurrentPublished) && row.data && typeof row.data === "object") roots.push([it.type, row.data as Record<string, unknown>]);
    }
  }
  await primeReferences(ctx, perspective, roots, 0);
  // Query terms under the 'simple' config (lowercase, word-token split, no
  // stemming/stop-words). A candidate is kept only if every positive term appears
  // in its public text and no negated term does — both directions decided on
  // public text alone, so private content can neither surface nor filter.
  const terms = tokenizeSimple(positiveQuery);
  const out: DeliveryContent[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    // Chokepoint re-validates (publish window, perspective, locale fallback) and
    // returns PUBLIC fields only.
    const resolved = await resolveContent(ctx, perspective, r.id, loc, 0);
    if (!resolved) continue;
    if (terms.length || negated.length) {
      const parts: string[] = [];
      collectStrings(resolved.name, parts);
      collectStrings(resolved.data, parts);
      if (resolved.seo) collectStrings(resolved.seo, parts);
      const hay = new Set(tokenizeSimple(parts.join(" ")));
      if (!terms.every((t) => hay.has(t))) continue; // matched only on private text
      if (negated.some((t) => hay.has(t))) continue; // excluded on PUBLIC text only
    }
    out.push(resolved);
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
  siteId: string,
  segments: string[],
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db, siteId).warm(perspective);
  const cleaned = segments.filter((s) => s.length > 0);
  if (cleaned.length === 0) return null;

  // Candidate set starts at top-level pages; descends into children per segment.
  let parentId: string | null = null;
  let currentDoc: string | null = null;
  for (let depth = 0; depth < cleaned.length; depth++) {
    const segment = cleaned[depth]!;
    const level = and(
      parentId === null ? isNull(contentItem.parentId) : eq(contentItem.parentId, parentId),
      eq(contentItem.kind, "page"),
      isNull(contentItem.deletedAt),
      eq(contentItem.siteId, siteId), // multisite: only this site's pages match the path
    );
    // The level and its versions in ONE round trip (the versions by subquery).
    const [children, levelVersions] = await Promise.all([
      db
        .select({ documentId: contentItem.documentId, type: contentItem.type, kind: contentItem.kind, parentId: contentItem.parentId })
        .from(contentItem)
        .where(level)
        .orderBy(asc(contentItem.sortIndex), asc(contentItem.id)),
      ctx.selectableVersions(db.select({ id: contentItem.documentId }).from(contentItem).where(level), perspective),
    ]);

    // Same filter as ctx.item(), so the matched chain is already known when the
    // page resolves (no second lookup of the document or its ancestors).
    for (const c of children) if (!ctx.items.has(c.documentId)) ctx.items.set(c.documentId, { type: c.type, kind: c.kind, parentId: c.parentId });
    ctx.cacheVersions(children.map((c) => c.documentId), levelVersions, perspective);
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
  siteId: string,
  loc: string,
  populate?: number,
): Promise<DeliveryContent | null> {
  // Per-site start page (migration 0013): the page served at "/" for THIS site.
  const rows = await db.select({ id: site.startPageId }).from(site).where(eq(site.id, siteId)).limit(1);
  const id = rows[0]?.id;
  if (!id) return null;
  const ctx = new DeliveryCtx(db, siteId).warm(perspective);
  return resolveContent(ctx, perspective, id, loc, clampDepth(populate));
}

/** Fetch a singleton global by type (deterministic, kind-constrained). */
export async function deliveryGlobal(
  db: Database,
  perspective: Perspective,
  siteId: string,
  typeName: string,
  loc: string,
): Promise<DeliveryContent | null> {
  const ctx = new DeliveryCtx(db, siteId).warm(perspective, { page: false });
  const ofType = and(eq(contentItem.type, typeName), eq(contentItem.kind, "global"), isNull(contentItem.deletedAt), eq(contentItem.siteId, siteId));
  // The global and its versions in ONE round trip (the versions by subquery).
  const [items, versions] = await Promise.all([
    db
      .select({ documentId: contentItem.documentId, type: contentItem.type, kind: contentItem.kind, parentId: contentItem.parentId })
      .from(contentItem)
      .where(ofType)
      .orderBy(asc(contentItem.id))
      .limit(1),
    ctx.selectableVersions(db.select({ id: contentItem.documentId }).from(contentItem).where(ofType), perspective),
  ]);
  if (!items[0]) return null;
  const { documentId, ...item } = items[0];
  ctx.items.set(documentId, item); // same filter as ctx.item()
  ctx.cacheVersions([documentId], versions, perspective);
  return resolveContent(ctx, perspective, documentId, loc, 1);
}
