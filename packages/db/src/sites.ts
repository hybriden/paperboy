import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { DEFAULT_SITE_ID, locale, site } from "./schema.js";

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
