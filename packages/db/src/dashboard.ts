import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { contentTypeUsage } from "./content.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { asset, contentItem, contentType, contentVersion, locale, webhook } from "./schema.js";

/**
 * The admin dashboard aggregate — "what needs my attention": work-in-progress
 * drafts, the scheduled publish queue, translation coverage and housekeeping
 * counts, in ONE round-trip. Site-partitioned via ctx.siteId and section-scoped
 * exactly like the tree/list scans (deny-by-default); webhook health is only
 * disclosed to users holding webhook.manage.
 */

export interface DashboardWipEntry {
  documentId: string;
  name: string;
  type: string;
  kind: string;
  locale: string;
  /** "new" = never published; "updated" = published with a newer draft. */
  change: "new" | "updated";
  at: string;
}

export interface DashboardScheduledEntry {
  documentId: string;
  name: string;
  locale: string;
  action: "publish" | "unpublish";
  at: string;
}

export interface DashboardData {
  wip: DashboardWipEntry[];
  wipTotal: number;
  scheduled: DashboardScheduledEntry[];
  translation: {
    locale: string;
    displayName: string;
    missing: number;
    /** Up to 10 of the missing pages, so the gap is actionable (click → editor). */
    pages: { documentId: string; name: string }[];
  }[];
  housekeeping: {
    trash: number;
    unusedBlocks: number;
    emptyTypes: number;
    /** Raster images in this site's library without alt text. */
    missingAlt: number;
    /** null = caller lacks webhook.manage (withheld, not zero). */
    failingWebhooks: number | null;
  };
  /** Up to 12 of the alt-less images, so the gap is fixable from the dashboard. */
  imagesMissingAlt: { documentId: string; url: string; filename: string }[];
  /** Up to 10 of the unused blocks, so the count is actionable (click → editor). */
  unusedBlocksList: { documentId: string; name: string; type: string }[];
  /** Up to 10 of the content types nothing uses (click → model editor, where an unused type is deletable). */
  emptyTypesList: { name: string; displayName: string; kind: string }[];
}

const LIST_LIMIT = 10;

export async function getDashboard(db: Database, ctx: AccessContext): Promise<DashboardData> {
  requirePermission(ctx, "content.read");

  // Everything below derives from the docs this user may see in this site.
  const items = await db
    .select({ documentId: contentItem.documentId, type: contentItem.type, kind: contentItem.kind, sectionId: contentItem.sectionId })
    .from(contentItem)
    .where(and(isNull(contentItem.deletedAt), eq(contentItem.siteId, ctx.siteId)));
  const visible = items.filter((i) => ctx.readSiteWide || ctx.sections.includes(i.sectionId ?? i.documentId));
  const byId = new Map(visible.map((i) => [i.documentId, i]));
  const visibleIds = [...byId.keys()];

  /* ------------------------- work in progress ------------------------- */
  let wip: DashboardWipEntry[] = [];
  let wipTotal = 0;
  if (visibleIds.length > 0) {
    const drafts = await db
      .select({ documentId: contentVersion.documentId, locale: contentVersion.locale, name: contentVersion.name, createdAt: contentVersion.createdAt })
      .from(contentVersion)
      .where(and(eq(contentVersion.status, "draft"), inArray(contentVersion.documentId, visibleIds)))
      .orderBy(desc(contentVersion.createdAt));
    const published = await db
      .select({ documentId: contentVersion.documentId, locale: contentVersion.locale })
      .from(contentVersion)
      .where(and(eq(contentVersion.isCurrentPublished, true), inArray(contentVersion.documentId, visibleIds)));
    const pubSet = new Set(published.map((p) => `${p.documentId}\u0000${p.locale}`));
    wipTotal = drafts.length;
    wip = drafts.slice(0, LIST_LIMIT).map((d) => {
      const item = byId.get(d.documentId)!;
      return {
        documentId: d.documentId,
        name: d.name,
        type: item.type,
        kind: item.kind,
        locale: d.locale,
        change: pubSet.has(`${d.documentId}\u0000${d.locale}`) ? ("updated" as const) : ("new" as const),
        at: d.createdAt.toISOString(),
      };
    });
  }

  /* ----------------------- scheduled publish queue --------------------- */
  let scheduled: DashboardScheduledEntry[] = [];
  if (visibleIds.length > 0) {
    const goLives = await db
      .select({ documentId: contentVersion.documentId, locale: contentVersion.locale, name: contentVersion.name, at: contentVersion.publishAt })
      .from(contentVersion)
      .where(and(eq(contentVersion.status, "draft"), isNotNull(contentVersion.publishAt), inArray(contentVersion.documentId, visibleIds)))
      .orderBy(asc(contentVersion.publishAt));
    const expiries = await db
      .select({ documentId: contentVersion.documentId, locale: contentVersion.locale, name: contentVersion.name, at: contentVersion.expireAt })
      .from(contentVersion)
      .where(and(eq(contentVersion.isCurrentPublished, true), isNotNull(contentVersion.expireAt), inArray(contentVersion.documentId, visibleIds)))
      .orderBy(asc(contentVersion.expireAt));
    scheduled = [
      ...goLives.map((g) => ({ documentId: g.documentId, name: g.name, locale: g.locale, action: "publish" as const, at: g.at!.toISOString() })),
      ...expiries.map((x) => ({ documentId: x.documentId, name: x.name, locale: x.locale, action: "unpublish" as const, at: x.at!.toISOString() })),
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, LIST_LIMIT);
  }

  /* ------------------------ translation coverage ----------------------- */
  // Pages only — blocks/globals follow their pages and would double-count work.
  const pageIds = visible.filter((i) => i.kind === "page").map((i) => i.documentId);
  const locales = await db.select().from(locale).where(eq(locale.enabled, true)).orderBy(asc(locale.sortIndex));
  const translation: DashboardData["translation"] = [];
  if (pageIds.length > 0) {
    const variants = await db
      .selectDistinct({ documentId: contentVersion.documentId, locale: contentVersion.locale })
      .from(contentVersion)
      .where(inArray(contentVersion.documentId, pageIds));
    const have = new Map<string, Set<string>>(); // locale -> docs with a variant
    for (const v of variants) (have.get(v.locale) ?? have.set(v.locale, new Set()).get(v.locale)!).add(v.documentId);
    // A display name per doc (newest version row in any locale wins) so the
    // missing-pages list is human-readable.
    const names = new Map<string, string>();
    const nameRows = await db
      .select({ documentId: contentVersion.documentId, name: contentVersion.name })
      .from(contentVersion)
      .where(inArray(contentVersion.documentId, pageIds))
      .orderBy(asc(contentVersion.id));
    for (const r of nameRows) names.set(r.documentId, r.name); // later rows overwrite → newest wins
    for (const l of locales) {
      const missingIds = pageIds.filter((id) => !have.get(l.code)?.has(id));
      translation.push({
        locale: l.code,
        displayName: l.displayName,
        missing: missingIds.length,
        pages: missingIds.slice(0, 10).map((id) => ({ documentId: id, name: names.get(id) ?? id })),
      });
    }
  } else {
    for (const l of locales) translation.push({ locale: l.code, displayName: l.displayName, missing: 0, pages: [] });
  }

  /* --------------------------- housekeeping ---------------------------- */
  const trashRows = await db
    .select({ documentId: contentItem.documentId, sectionId: contentItem.sectionId })
    .from(contentItem)
    .where(and(isNotNull(contentItem.deletedAt), eq(contentItem.siteId, ctx.siteId)));
  const trash = trashRows.filter((i) => ctx.readSiteWide || ctx.sections.includes(i.sectionId ?? i.documentId)).length;

  // A block is "used" when any CURRENT version (working draft or live published)
  // of an in-site doc mentions its documentId — contentArea refs, reference
  // fields, links. Detected from the version data itself, NOT content_reference:
  // seeded/imported documents have no extracted reference rows.
  const blockIds = visible.filter((i) => i.kind === "block").map((i) => i.documentId);
  let unusedBlocks = 0;
  let unusedBlocksList: DashboardData["unusedBlocksList"] = [];
  if (blockIds.length > 0) {
    const blockIdSet = new Set(blockIds);
    const used = new Set<string>();
    const collectIds = (node: unknown): void => {
      if (typeof node === "string") {
        if (blockIdSet.has(node)) used.add(node);
      } else if (Array.isArray(node)) {
        for (const n of node) collectIds(n);
      } else if (node && typeof node === "object") {
        for (const v of Object.values(node)) collectIds(v);
      }
    };
    const versions = await db
      .select({ documentId: contentVersion.documentId, status: contentVersion.status, isPub: contentVersion.isCurrentPublished, name: contentVersion.name, data: contentVersion.data })
      .from(contentVersion)
      .where(inArray(contentVersion.documentId, visibleIds));
    // A display name per block (draft wins over published) for the unused list.
    const blockNames = new Map<string, string>();
    for (const v of versions) {
      if (v.status !== "draft" && !v.isPub) continue; // skip history
      if (blockIdSet.has(v.documentId)) {
        if (v.status === "draft" || !blockNames.has(v.documentId)) blockNames.set(v.documentId, v.name);
        continue; // a block embedding itself doesn't count
      }
      collectIds(v.data);
    }
    const unused = blockIds.filter((id) => !used.has(id));
    unusedBlocks = unused.length;
    unusedBlocksList = unused
      .slice(0, LIST_LIMIT)
      .map((id) => ({ documentId: id, name: blockNames.get(id) ?? id, type: byId.get(id)!.type }));
  }

  // Types with no standalone items AND no inline embeds anywhere — instance-
  // global on purpose: content types are shared across sites (D2). Note that
  // contentTypeUsage omits fully-unused types, so walk the full type list.
  const usage = await contentTypeUsage(db);
  const typeRows = await db
    .select({
      name: contentType.name,
      displayName: contentType.displayName,
      kind: contentType.kind,
      // Nested-only types are PARTS (a form's field blocks): they are installed
      // as a set and only some get used, so an unused one is a part of the
      // library sitting available — not a modelling mistake to clean up. Left
      // in, ten field types made eight permanent entries on this list.
      nestedOnly: sql<boolean>`coalesce((${contentType.definition} ->> 'nestedOnly')::boolean, false)`,
    })
    .from(contentType)
    .orderBy(asc(contentType.name));
  const emptyTypeRows = typeRows.filter((t) => {
    if (t.nestedOnly) return false;
    const u = usage[t.name];
    return !u || (u.items === 0 && u.inlineIn === 0);
  });
  const emptyTypes = emptyTypeRows.length;
  // Drop the internal nestedOnly flag — the delivered shape is name/displayName/kind.
  const emptyTypesList = emptyTypeRows
    .slice(0, LIST_LIMIT)
    .map(({ name, displayName, kind }) => ({ name, displayName, kind }));

  // Raster images without alt text — an accessibility gap the vision alt-text
  // helper can now actually fix, so surface the images themselves (a bare
  // count that links nowhere helps nobody).
  const altWhere = and(eq(asset.siteId, ctx.siteId), sql`${asset.alt} = ''`, sql`${asset.mime} LIKE 'image/%'`, sql`${asset.mime} <> 'image/svg+xml'`);
  const altRows = await db.select({ n: sql<number>`count(*)::int` }).from(asset).where(altWhere);
  const missingAlt = altRows[0]?.n ?? 0;
  const imagesMissingAlt =
    missingAlt > 0
      ? (await db
          .select({ documentId: asset.documentId, url: asset.url, filename: asset.filename })
          .from(asset)
          .where(altWhere)
          .orderBy(desc(asset.createdAt))
          .limit(12))
      : [];

  let failingWebhooks: number | null = null;
  if (ctx.permissions.includes("webhook.manage")) {
    const hooks = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhook)
      .where(and(eq(webhook.active, true), isNotNull(webhook.lastAt), sql`(${webhook.lastStatus} IS NULL OR ${webhook.lastStatus} < 200 OR ${webhook.lastStatus} >= 300)`));
    failingWebhooks = hooks[0]?.n ?? 0;
  }

  return {
    wip,
    wipTotal,
    scheduled,
    translation,
    housekeeping: { trash, unusedBlocks, emptyTypes, missingAlt, failingWebhooks },
    imagesMissingAlt,
    unusedBlocksList,
    emptyTypesList,
  };
}
