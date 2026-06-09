import type { Folder as FolderDTO, FolderKind } from "@paperboy/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "./client.js";
import { Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { asset, contentItem, folder } from "./schema.js";

/**
 * Asset-pane folders — nested, per-site organization for the Media and
 * Shared-blocks libraries. Two SEPARATE trees, discriminated by `kind`. Authz
 * mirrors assets.ts: verb-level RBAC + site partition (D2); no section scope.
 */

function toDTO(row: typeof folder.$inferSelect): FolderDTO {
  return {
    documentId: row.documentId,
    kind: row.kind as FolderKind,
    parentId: row.parentId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Load a folder in the active site, or 404. */
async function loadFolder(db: Database, ctx: AccessContext, documentId: string) {
  const rows = await db
    .select()
    .from(folder)
    .where(and(eq(folder.documentId, documentId), eq(folder.siteId, ctx.siteId)))
    .limit(1);
  if (!rows[0]) throw Errors.notFound("Folder");
  return rows[0];
}

/** All folders for the active site + kind (the UI builds the tree). */
export async function listFolders(db: Database, ctx: AccessContext, kind: FolderKind): Promise<FolderDTO[]> {
  requirePermission(ctx, "content.read");
  const rows = await db
    .select()
    .from(folder)
    .where(and(eq(folder.siteId, ctx.siteId), eq(folder.kind, kind)))
    .orderBy(asc(folder.name), asc(folder.id));
  return rows.map(toDTO);
}

export async function createFolder(
  db: Database,
  ctx: AccessContext,
  input: { kind: FolderKind; parentId?: string | null; name: string },
): Promise<FolderDTO> {
  requirePermission(ctx, "content.create");
  const name = input.name.trim();
  if (!name) throw Errors.badRequest("Folder name is required");
  // A parent must exist in the same site and the SAME tree (kind).
  if (input.parentId) {
    const parent = await loadFolder(db, ctx, input.parentId);
    if (parent.kind !== input.kind) throw Errors.badRequest("Parent folder belongs to a different library");
  }
  const documentId = nanoid(24);
  await db.insert(folder).values({
    documentId,
    kind: input.kind,
    parentId: input.parentId ?? null,
    name,
    siteId: ctx.siteId,
    createdBy: ctx.userId,
  });
  return toDTO(await loadFolder(db, ctx, documentId));
}

/** True if `candidateParentId` is `documentId` itself or one of its descendants. */
async function wouldCycle(db: Database, ctx: AccessContext, documentId: string, candidateParentId: string): Promise<boolean> {
  let cur: string | null = candidateParentId;
  const guard = new Set<string>();
  while (cur) {
    if (cur === documentId) return true;
    if (guard.has(cur)) break; // defensive: pre-existing cycle
    guard.add(cur);
    const rows = await db
      .select({ parentId: folder.parentId })
      .from(folder)
      .where(and(eq(folder.documentId, cur), eq(folder.siteId, ctx.siteId)))
      .limit(1);
    cur = rows[0]?.parentId ?? null;
  }
  return false;
}

/** Rename and/or move a folder. `parentId: null` moves it to the root. */
export async function renameFolder(
  db: Database,
  ctx: AccessContext,
  documentId: string,
  patch: { name?: string; parentId?: string | null },
): Promise<FolderDTO> {
  requirePermission(ctx, "content.update");
  const current = await loadFolder(db, ctx, documentId);

  const set: { name?: string; parentId?: string | null } = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw Errors.badRequest("Folder name is required");
    set.name = name;
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId) {
      if (patch.parentId === documentId) throw Errors.badRequest("A folder cannot be its own parent");
      const parent = await loadFolder(db, ctx, patch.parentId);
      if (parent.kind !== current.kind) throw Errors.badRequest("Cannot move a folder into a different library");
      if (await wouldCycle(db, ctx, documentId, patch.parentId)) {
        throw Errors.badRequest("Cannot move a folder into one of its own subfolders");
      }
    }
    set.parentId = patch.parentId;
  }
  if (Object.keys(set).length === 0) return toDTO(current);

  await db.update(folder).set(set).where(and(eq(folder.documentId, documentId), eq(folder.siteId, ctx.siteId)));
  return toDTO(await loadFolder(db, ctx, documentId));
}

/**
 * Delete a folder LOSSLESSLY: its direct subfolders and contained items
 * (assets for a media folder, shared blocks for a block folder) are reparented
 * to this folder's parent (null = root); only the folder itself is removed.
 */
export async function deleteFolder(db: Database, ctx: AccessContext, documentId: string): Promise<{ deleted: true }> {
  requirePermission(ctx, "content.delete");
  const current = await loadFolder(db, ctx, documentId);
  const newParent = current.parentId; // may be null (root)

  await db.transaction(async (tx) => {
    // Subfolders move up one level.
    await tx.update(folder).set({ parentId: newParent }).where(and(eq(folder.parentId, documentId), eq(folder.siteId, ctx.siteId)));
    // Contained items move up one level, per tree.
    if (current.kind === "media") {
      await tx.update(asset).set({ folderId: newParent }).where(and(eq(asset.folderId, documentId), eq(asset.siteId, ctx.siteId)));
    } else {
      await tx.update(contentItem).set({ folderId: newParent }).where(and(eq(contentItem.folderId, documentId), eq(contentItem.siteId, ctx.siteId)));
    }
    await tx.delete(folder).where(and(eq(folder.documentId, documentId), eq(folder.siteId, ctx.siteId)));
  });
  return { deleted: true };
}

/** Move an asset into a media folder (null = root/unfiled). */
export async function setAssetFolder(db: Database, ctx: AccessContext, assetDocumentId: string, folderId: string | null): Promise<void> {
  requirePermission(ctx, "content.update");
  if (folderId) {
    const target = await loadFolder(db, ctx, folderId);
    if (target.kind !== "media") throw Errors.badRequest("Target is not a media folder");
  }
  const res = await db
    .update(asset)
    .set({ folderId })
    .where(and(eq(asset.documentId, assetDocumentId), eq(asset.siteId, ctx.siteId)))
    .returning({ id: asset.id });
  if (!res[0]) throw Errors.notFound("Asset");
}

/** Move a shared block into a block folder (null = root/unfiled). */
export async function setBlockFolder(db: Database, ctx: AccessContext, blockDocumentId: string, folderId: string | null): Promise<void> {
  requirePermission(ctx, "content.update");
  if (folderId) {
    const target = await loadFolder(db, ctx, folderId);
    if (target.kind !== "block") throw Errors.badRequest("Target is not a block folder");
  }
  // Only shared blocks in the active site, respecting object-level scope.
  const rows = await db
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.documentId, blockDocumentId), eq(contentItem.siteId, ctx.siteId), eq(contentItem.kind, "block")))
    .limit(1);
  const item = rows[0];
  if (!item) throw Errors.notFound("Block");
  if (!ctx.siteWide && !ctx.sections.includes(item.sectionId ?? item.documentId)) {
    throw Errors.forbidden("Out of scope for this block");
  }
  await db.update(contentItem).set({ folderId }).where(eq(contentItem.documentId, blockDocumentId));
}
