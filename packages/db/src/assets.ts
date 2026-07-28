import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AssetSourceMeta } from "@paperboy/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { asset } from "./schema.js";

/** Path served by @fastify/static; the relative path is stored in the DB. */
export const MEDIA_PREFIX = "/api/v1/media";

/** Browser-reachable base for media URLs. Empty = relative (/api/v1/media/…),
 *  which resolves same-origin via each app's proxy (host-agnostic). */
export function mediaBase(): string {
  return process.env.MEDIA_PUBLIC_BASE ?? "";
}

/** Turn a stored relative path into a browser-reachable absolute URL at read time. */
export function absoluteAssetUrl(path: string): string {
  if (!path) return path;
  return /^https?:\/\//.test(path) ? path : `${mediaBase()}${path}`;
}

export interface AssetRecord {
  documentId: string;
  filename: string;
  mime: string;
  size: number;
  url: string; // absolute
  alt: string;
  /** Stock-image imports carry provider attribution; null for normal uploads. */
  sourceMeta: AssetSourceMeta | null;
  createdAt: string;
  /** Asset-pane folder (null = root/unfiled). */
  folderId: string | null;
}

function toRecord(row: typeof asset.$inferSelect): AssetRecord {
  return {
    documentId: row.documentId,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    url: absoluteAssetUrl(row.url),
    alt: row.alt,
    sourceMeta: (row.sourceMeta as AssetSourceMeta | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    folderId: row.folderId ?? null,
  };
}

/** Persist a freshly-uploaded asset row (the route has already written the file). */
export async function insertAsset(
  db: Database,
  ctx: AccessContext,
  input: {
    documentId: string;
    filename: string;
    mime: string;
    size: number;
    relativePath: string;
    alt?: string;
    sourceMeta?: AssetSourceMeta;
  },
): Promise<AssetRecord> {
  requirePermission(ctx, "content.create");
  await db.insert(asset).values({
    documentId: input.documentId,
    filename: input.filename,
    mime: input.mime,
    size: input.size,
    url: input.relativePath,
    alt: input.alt ?? "",
    sourceMeta: input.sourceMeta ?? null,
    createdBy: ctx.userId,
    siteId: ctx.siteId, // per-site media (D2)
  });
  return getAssetRecord(db, input.documentId);
}

export async function listAssets(db: Database, ctx: AccessContext): Promise<AssetRecord[]> {
  requirePermission(ctx, "content.read");
  // Per-site media (D2): only the active site's library.
  const rows = await db
    .select()
    .from(asset)
    .where(eq(asset.siteId, ctx.siteId))
    .orderBy(desc(asset.createdAt), desc(asset.id));
  return rows.map(toRecord);
}

/**
 * Find an asset already imported from a given provider photo in the active site,
 * or null. Used to keep stock import idempotent — re-importing the same photo
 * returns the existing asset instead of a byte-identical duplicate. Site-scoped
 * (per-site media, D2); returns the earliest copy if more than one exists.
 */
export async function findAssetBySource(
  db: Database,
  ctx: AccessContext,
  provider: string,
  providerId: string,
): Promise<AssetRecord | null> {
  const rows = await db
    .select()
    .from(asset)
    .where(
      and(
        eq(asset.siteId, ctx.siteId),
        sql`${asset.sourceMeta}->>'provider' = ${provider}`,
        sql`${asset.sourceMeta}->>'providerId' = ${providerId}`,
      ),
    )
    .orderBy(asc(asset.id))
    .limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getAssetRecord(db: Database, documentId: string): Promise<AssetRecord> {
  const rows = await db.select().from(asset).where(eq(asset.documentId, documentId)).limit(1);
  if (!rows[0]) throw Errors.notFound("Asset");
  return toRecord(rows[0]);
}

/** Raw row (or null) for delivery resolution — no throw, used per-image. When a
 *  siteId is given (delivery), a cross-site asset resolves to null (D2). */
export async function getAssetRow(db: Database, documentId: string, siteId?: string) {
  const where = siteId ? and(eq(asset.documentId, documentId), eq(asset.siteId, siteId)) : eq(asset.documentId, documentId);
  const rows = await db.select().from(asset).where(where).limit(1);
  return rows[0] ?? null;
}

export async function updateAssetAlt(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  alt: string,
): Promise<AssetRecord> {
  requirePermission(ctx, "content.update");
  const res = await db.update(asset).set({ alt }).where(and(eq(asset.documentId, documentId), eq(asset.siteId, ctx.siteId))).returning();
  if (!res[0]) throw Errors.notFound("Asset");
  return toRecord(res[0]);
}

/**
 * Remove an asset's BYTES: the original file and every cached transform variant
 * (`<file>.w{n}q{n}.{fmt}`).
 *
 * Lives here, in the data layer, so EVERY surface inherits it. It used to live only
 * in the API route, which meant the MCP `delete_asset` tool deleted the row and left
 * the image permanently downloadable — the media mount resolves by filename with no
 * DB lookup, so a row-only delete is not a delete. That contradicted the MCP's whole
 * premise ("calls the same functions the API does").
 *
 * Best-effort: the row is the source of truth, so a leftover file is a leak, not a
 * correctness bug — but a leftover file after a delete IS the bug.
 */
export async function removeAssetFiles(uploadsDir: string, relativePath: string): Promise<void> {
  // FAIL LOUDLY if the uploads directory isn't there. It used to swallow ENOENT, so
  // the documented stdio MCP invocation (which sets no UPLOADS_DIR and mounts no
  // volume) reported a successful delete while every byte stayed downloadable at the
  // old, unauthenticated /api/v1/media URL — a right-to-erasure request that silently
  // did nothing. Self-teaching, per rule #2.
  try {
    await stat(uploadsDir);
  } catch {
    throw Errors.badRequest(
      `Cannot delete the asset's files: UPLOADS_DIR ('${uploadsDir}') does not exist, so the image would stay publicly downloadable. Point UPLOADS_DIR at the same directory the API serves /api/v1/media from (in Docker: the paperboy-uploads volume at /app/uploads).`,
    );
  }
  const fileName = relativePath.replace(`${MEDIA_PREFIX}/`, "");
  // Server-generated nanoid names only; reject anything path-shaped regardless.
  if (!fileName || fileName.includes("/") || fileName.includes("..")) return;
  await unlink(join(uploadsDir, fileName)).catch(() => undefined);
  const variantsDir = join(uploadsDir, "_variants");
  for (const v of await readdir(variantsDir).catch(() => [] as string[])) {
    if (v.startsWith(`${fileName}.`)) await unlink(join(variantsDir, v)).catch(() => undefined);
  }
}

/**
 * Delete an asset row AND its files. References to a now-missing asset resolve to
 * null in delivery (no dangling-reference error). 404 if the asset doesn't exist.
 *
 * `uploadsDir` is optional only so a caller that owns the unlink itself (the API
 * route, which batches it for site deletion) can opt out; pass it everywhere else.
 */
export async function deleteAsset(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  uploadsDir?: string,
): Promise<{ relativePath: string }> {
  requirePermission(ctx, "content.delete");
  const res = await db.delete(asset).where(and(eq(asset.documentId, documentId), eq(asset.siteId, ctx.siteId))).returning({ url: asset.url });
  if (!res[0]) throw Errors.notFound("Asset");
  const relativePath = res[0].url;
  if (uploadsDir) await removeAssetFiles(uploadsDir, relativePath);
  return { relativePath };
}
