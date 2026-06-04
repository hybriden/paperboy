import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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

async function variantRow(
  ctx: DeliveryCtx,
  perspective: Perspective,
  documentId: string,
  loc: string,
): Promise<{ row: typeof contentVersion.$inferSelect; usedLocale: string } | null> {
  const all = await ctx.docVersions(documentId);
  for (const code of await ctx.localeChain(loc)) {
    let candidates = all.filter((r) => r.locale === code);
    // Public perspective also enforces the scheduled-publish window; preview
    // (privileged editors) ignores it so editors can preview anytime.
    if (perspective === "published") candidates = candidates.filter((r) => publishWindowOpen(r, ctx.now));
    const row = selectRow(candidates, perspective);
    if (row) return { row, usedLocale: code };
  }
  return null;
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
  const sanitized = await sanitize(
    ctx,
    perspective,
    item.type,
    found.row.data as Record<string, unknown>,
    found.usedLocale,
    depth,
  );
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

export async function deliveryList(
  db: Database,
  perspective: Perspective,
  typeName: string | undefined,
  loc: string,
  populate?: number,
  parentId?: string,
): Promise<DeliveryContent[]> {
  if (!typeName && !parentId) return []; // unbounded "everything" listing is not a thing
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
  const out: DeliveryContent[] = [];
  for (const it of items) {
    const resolved = await resolveContent(
      ctx,
      perspective,
      it.documentId,
      loc,
      clampDepth(populate),
    );
    if (resolved) out.push(resolved);
  }
  return out;
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
