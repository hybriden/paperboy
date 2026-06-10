import { asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { DEFAULT_SITE_ID, asset, contentItem, contentReference, contentVersion, deliveryKey, folder, locale, site, userScope } from "./schema.js";

/**
 * The `site` entity (multisite). Content, delivery keys, media and user scopes
 * are partitioned by site; content types, locales and users are shared (D2).
 * Authorization threading (AccessContext.siteId, delivery key → site) is layered
 * on top of these query primitives in later phases.
 */

export type Site = typeof site.$inferSelect;

/** The fixed Default site that all pre-multisite data was backfilled into. */
export async function getDefaultSite(db: Database): Promise<Site> {
  const rows = await db.select().from(site).where(eq(site.id, DEFAULT_SITE_ID)).limit(1);
  if (!rows[0]) throw Errors.notFound("Default site"); // 0012 guarantees it exists
  return rows[0];
}

export async function getSiteById(db: Database, id: string): Promise<Site | null> {
  const rows = await db.select().from(site).where(eq(site.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getSiteBySlug(db: Database, slug: string): Promise<Site | null> {
  const rows = await db.select().from(site).where(eq(site.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/** All sites, oldest first (the Default site sorts first by created_at). */
export async function listSites(db: Database, ctx: AccessContext): Promise<Site[]> {
  requirePermission(ctx, "content.read");
  return db.select().from(site).orderBy(asc(site.createdAt), asc(site.slug));
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Create a new site. Cross-site administration, so it requires `user.manage`
 * (the closest existing super-admin permission; per-site RBAC lands in Phase 5).
 * `defaultLocale` must be an existing, enabled locale (locales are shared).
 */
export async function createSite(
  db: Database,
  ctx: AccessContext,
  input: { slug: string; name: string; defaultLocale: string },
): Promise<Site> {
  requirePermission(ctx, "user.manage");
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  if (!SLUG_RE.test(slug)) {
    throw Errors.badRequest("Site slug must be lowercase letters, numbers and single hyphens (e.g. 'brand-a')");
  }
  if (!name) throw Errors.badRequest("Site name is required");
  if (await getSiteBySlug(db, slug)) throw Errors.conflict(`A site with slug '${slug}' already exists`);

  const loc = await db.select().from(locale).where(eq(locale.code, input.defaultLocale)).limit(1);
  if (!loc[0]) throw Errors.badRequest(`Unknown default locale '${input.defaultLocale}'`);

  const id = `site_${nanoid(16)}`;
  await db.insert(site).values({ id, slug, name, defaultLocale: input.defaultLocale, active: true });
  return (await getSiteById(db, id))!;
}

/**
 * Rename a site (display name and/or slug). Cross-site admin (user.manage).
 * Targets an explicit siteId so any site can be renamed from the Sites panel
 * without switching the active site. Slug stays unique + URL-safe.
 */
export async function renameSite(
  db: Database,
  ctx: AccessContext,
  siteId: string,
  input: { name?: string; slug?: string },
): Promise<Site> {
  requirePermission(ctx, "user.manage");
  const existing = await getSiteById(db, siteId);
  if (!existing) throw Errors.notFound("Site");

  const patch: Partial<typeof site.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw Errors.badRequest("Site name is required");
    patch.name = name;
  }
  if (input.slug !== undefined) {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw Errors.badRequest("Site slug must be lowercase letters, numbers and single hyphens (e.g. 'brand-a')");
    }
    const clash = await getSiteBySlug(db, slug);
    if (clash && clash.id !== siteId) throw Errors.conflict(`A site with slug '${slug}' already exists`);
    patch.slug = slug;
  }
  if (Object.keys(patch).length === 0) return existing; // nothing to change
  await db.update(site).set(patch).where(eq(site.id, siteId));
  return (await getSiteById(db, siteId))!;
}

/**
 * Delete a site AND everything partitioned to it: content (incl. trash and all
 * versions/references), media assets, folders, delivery keys and user scopes.
 * Cross-site admin (user.manage). Irreversible, so the caller must echo the
 * site's slug in `confirmSlug` — a mismatch is rejected with the expected value
 * so a mistaken caller can self-correct. The Default site can never be deleted.
 */
export async function deleteSite(
  db: Database,
  ctx: AccessContext,
  siteId: string,
  confirmSlug: string | undefined,
): Promise<{ site: Site; contentItems: number; assets: number; deliveryKeys: number }> {
  requirePermission(ctx, "user.manage");
  const existing = await getSiteById(db, siteId);
  if (!existing) throw Errors.notFound("Site");
  if (siteId === DEFAULT_SITE_ID) {
    throw Errors.badRequest("The Default site cannot be deleted — it anchors single-site write paths");
  }
  if (confirmSlug !== existing.slug) {
    throw Errors.badRequest(
      `Deleting a site is irreversible and removes all of its content, media and delivery keys. ` +
        `Pass confirm='${existing.slug}' (the site's slug) to proceed.`,
    );
  }

  const docs = await db.select({ documentId: contentItem.documentId }).from(contentItem).where(eq(contentItem.siteId, siteId));
  const docIds = docs.map((d) => d.documentId);
  let assets = 0;
  let keys = 0;
  await db.transaction(async (tx) => {
    if (docIds.length > 0) {
      await tx.delete(contentReference).where(inArray(contentReference.fromDocumentId, docIds));
      await tx.delete(contentVersion).where(inArray(contentVersion.documentId, docIds));
      await tx.delete(contentItem).where(eq(contentItem.siteId, siteId));
    }
    assets = (await tx.delete(asset).where(eq(asset.siteId, siteId)).returning({ id: asset.documentId })).length;
    await tx.delete(folder).where(eq(folder.siteId, siteId));
    keys = (await tx.delete(deliveryKey).where(eq(deliveryKey.siteId, siteId)).returning({ id: deliveryKey.id })).length;
    await tx.delete(userScope).where(eq(userScope.siteId, siteId));
    await tx.delete(site).where(eq(site.id, siteId));
  });
  return { site: existing, contentItems: docIds.length, assets, deliveryKeys: keys };
}
