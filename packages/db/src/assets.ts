import type { AssetSourceMeta } from "@paperboy/shared";
import { desc, eq } from "drizzle-orm";
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
  });
  return getAssetRecord(db, input.documentId);
}

export async function listAssets(db: Database, ctx: AccessContext): Promise<AssetRecord[]> {
  requirePermission(ctx, "content.read");
  const rows = await db.select().from(asset).orderBy(desc(asset.createdAt), desc(asset.id));
  return rows.map(toRecord);
}

export async function getAssetRecord(db: Database, documentId: string): Promise<AssetRecord> {
  const rows = await db.select().from(asset).where(eq(asset.documentId, documentId)).limit(1);
  if (!rows[0]) throw Errors.notFound("Asset");
  return toRecord(rows[0]);
}

/** Raw row (or null) for delivery resolution — no throw, used per-image. */
export async function getAssetRow(db: Database, documentId: string) {
  const rows = await db.select().from(asset).where(eq(asset.documentId, documentId)).limit(1);
  return rows[0] ?? null;
}

export async function updateAssetAlt(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  alt: string,
): Promise<AssetRecord> {
  requirePermission(ctx, "content.update");
  const res = await db.update(asset).set({ alt }).where(eq(asset.documentId, documentId)).returning();
  if (!res[0]) throw Errors.notFound("Asset");
  return toRecord(res[0]);
}

/**
 * Delete an asset row and return its stored relative path so the route can
 * unlink the file. References to a now-missing asset resolve to null in
 * delivery (no dangling-reference error). 404 if the asset doesn't exist.
 */
export async function deleteAsset(
  db: Database,
  ctx: AccessContext,
  documentId: string,
): Promise<{ relativePath: string }> {
  requirePermission(ctx, "content.delete");
  const res = await db.delete(asset).where(eq(asset.documentId, documentId)).returning({ url: asset.url });
  if (!res[0]) throw Errors.notFound("Asset");
  return { relativePath: res[0].url };
}
