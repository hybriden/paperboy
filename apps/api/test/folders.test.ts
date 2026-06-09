import {
  type AccessContext,
  createContent,
  createDb,
  createFolder,
  createSite,
  deleteFolder,
  getAccessContext,
  insertAsset,
  listAssets,
  listBlocks,
  listFolders,
  renameFolder,
  setAssetFolder,
  setBlockFolder,
} from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Asset-pane folders — nested, per-site organization for the Media and
 * Shared-blocks libraries (two separate trees, discriminated by `kind`). The
 * correctness risks: nesting + cycle safety, LOSSLESS delete (contents move up,
 * nothing is removed but the folder), and the multisite partition (a folder in
 * site B is invisible in A). Plus the new deletion gap closed by this work:
 * trashing a shared block straight from the pane (the existing content DELETE).
 */
describe("asset-pane folders", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let ctxA: AccessContext; // admin, active site = Default
  let ctxB: AccessContext; // admin, active site = B

  beforeAll(async () => {
    s = await setupApi();
    const adminRows = (await raw.sql`SELECT id FROM users WHERE email = 'admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    const adminId = adminRows[0]!.id;
    ctxA = await getAccessContext(s.app.db, adminId);
    const siteB = await createSite(s.app.db, ctxA, { slug: "brand-folders-b", name: "Brand B", defaultLocale: "en" });
    ctxB = await getAccessContext(s.app.db, adminId, siteB.id);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("creates nested media folders and lists them for the site + kind", async () => {
    const parent = await createFolder(s.app.db, ctxA, { kind: "media", name: "Marketing" });
    const child = await createFolder(s.app.db, ctxA, { kind: "media", parentId: parent.documentId, name: "2026" });
    expect(child.parentId).toBe(parent.documentId);

    const media = await listFolders(s.app.db, ctxA, "media");
    expect(media.map((f) => f.documentId)).toEqual(expect.arrayContaining([parent.documentId, child.documentId]));
    // The block tree is separate — a media folder never shows up under "block".
    expect((await listFolders(s.app.db, ctxA, "block")).map((f) => f.documentId)).not.toContain(parent.documentId);
  });

  it("rejects a parent folder from a different library (kind)", async () => {
    const mediaParent = await createFolder(s.app.db, ctxA, { kind: "media", name: "Media root" });
    await expect(createFolder(s.app.db, ctxA, { kind: "block", parentId: mediaParent.documentId, name: "bad" })).rejects.toThrow();
  });

  it("renames a folder", async () => {
    const f = await createFolder(s.app.db, ctxA, { kind: "media", name: "Old name" });
    const renamed = await renameFolder(s.app.db, ctxA, f.documentId, { name: "New name" });
    expect(renamed.name).toBe("New name");
  });

  it("moves a folder but rejects a cycle (into its own descendant)", async () => {
    const a = await createFolder(s.app.db, ctxA, { kind: "media", name: "A" });
    const b = await createFolder(s.app.db, ctxA, { kind: "media", parentId: a.documentId, name: "B" });
    // Move B to root — fine.
    expect((await renameFolder(s.app.db, ctxA, b.documentId, { parentId: null })).parentId).toBeNull();
    // Put B back under A, then try to move A under B → cycle, rejected.
    await renameFolder(s.app.db, ctxA, b.documentId, { parentId: a.documentId });
    await expect(renameFolder(s.app.db, ctxA, a.documentId, { parentId: b.documentId })).rejects.toThrow();
    // A folder can't be its own parent either.
    await expect(renameFolder(s.app.db, ctxA, a.documentId, { parentId: a.documentId })).rejects.toThrow();
  });

  it("files an asset into a media folder and surfaces folderId in the listing", async () => {
    const folder = await createFolder(s.app.db, ctxA, { kind: "media", name: "Logos" });
    await insertAsset(s.app.db, ctxA, { documentId: "asset-in-folder", filename: "logo.png", mime: "image/png", size: 10, relativePath: "/uploads/logo.png" });
    await setAssetFolder(s.app.db, ctxA, "asset-in-folder", folder.documentId);
    const found = (await listAssets(s.app.db, ctxA)).find((a) => a.documentId === "asset-in-folder");
    expect(found?.folderId).toBe(folder.documentId);
    // Move back to root.
    await setAssetFolder(s.app.db, ctxA, "asset-in-folder", null);
    expect((await listAssets(s.app.db, ctxA)).find((a) => a.documentId === "asset-in-folder")?.folderId).toBeNull();
  });

  it("files a shared block into a block folder and surfaces folderId in the listing", async () => {
    const folder = await createFolder(s.app.db, ctxA, { kind: "block", name: "Heroes" });
    const block = await createContent(s.app.db, ctxA, { type: "HeroBlock", locale: "en", name: "Filed hero", parentId: null });
    await setBlockFolder(s.app.db, ctxA, block.documentId, folder.documentId);
    const found = (await listBlocks(s.app.db, ctxA)).find((b) => b.documentId === block.documentId);
    expect(found?.folderId).toBe(folder.documentId);
    // A media folder is not a valid target for a block.
    const mediaFolder = await createFolder(s.app.db, ctxA, { kind: "media", name: "not for blocks" });
    await expect(setBlockFolder(s.app.db, ctxA, block.documentId, mediaFolder.documentId)).rejects.toThrow();
  });

  it("delete is LOSSLESS: subfolders + contained items move up one level, nothing else is removed", async () => {
    const parent = await createFolder(s.app.db, ctxA, { kind: "media", name: "Doomed" });
    const sub = await createFolder(s.app.db, ctxA, { kind: "media", parentId: parent.documentId, name: "Survivor" });
    await insertAsset(s.app.db, ctxA, { documentId: "asset-reparent", filename: "x.png", mime: "image/png", size: 10, relativePath: "/uploads/x.png" });
    await setAssetFolder(s.app.db, ctxA, "asset-reparent", parent.documentId);

    await deleteFolder(s.app.db, ctxA, parent.documentId);

    const media = await listFolders(s.app.db, ctxA, "media");
    expect(media.map((f) => f.documentId)).not.toContain(parent.documentId); // the folder itself is gone
    expect(media.find((f) => f.documentId === sub.documentId)?.parentId).toBeNull(); // subfolder moved to root
    // The asset survives, reparented to the deleted folder's parent (root here).
    const asset = (await listAssets(s.app.db, ctxA)).find((a) => a.documentId === "asset-reparent");
    expect(asset?.folderId).toBeNull();
  });

  it("is partitioned per site (D2): a folder in B is invisible from A, and a cross-site target is rejected", async () => {
    const bFolder = await createFolder(s.app.db, ctxB, { kind: "media", name: "B-only folder" });
    expect((await listFolders(s.app.db, ctxA, "media")).map((f) => f.documentId)).not.toContain(bFolder.documentId);
    expect((await listFolders(s.app.db, ctxB, "media")).map((f) => f.documentId)).toContain(bFolder.documentId);

    // An asset in A cannot be filed into B's folder (B's folder is not-found from A's ctx).
    await insertAsset(s.app.db, ctxA, { documentId: "asset-a-xsite", filename: "a.png", mime: "image/png", size: 10, relativePath: "/uploads/a.png" });
    await expect(setAssetFolder(s.app.db, ctxA, "asset-a-xsite", bFolder.documentId)).rejects.toThrow();
  });

  it("HTTP: folder routes are wired and CSRF-protected", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // No CSRF token → 403.
    const noCsrf = await s.app.inject({ method: "POST", url: "/api/v1/manage/folders", headers: { cookie: admin.cookie }, payload: { kind: "media", name: "x" } });
    expect(noCsrf.statusCode).toBe(403);
    // With CSRF → created, then listable.
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/folders", headers: authHeaders(admin), payload: { kind: "media", name: "Via HTTP" } });
    expect(created.statusCode).toBe(200);
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/folders?kind=media", headers: { cookie: admin.cookie } });
    expect((list.json() as Array<{ documentId: string }>).map((f) => f.documentId)).toContain(created.json().documentId);
  });

  it("HTTP: a shared block can be trashed straight from the pane (the content DELETE)", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const block = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "HeroBlock", locale: "en", name: "Trash me" } });
    const id = block.json().documentId;
    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${id}`, headers: authHeaders(admin) });
    expect(del.statusCode).toBe(200);
    expect(del.json().trashed).toBeGreaterThanOrEqual(1);

    // Gone from the pane's block list…
    const blocksList = await s.app.inject({ method: "GET", url: "/api/v1/manage/blocks", headers: { cookie: admin.cookie } });
    expect((blocksList.json() as Array<{ documentId: string }>).map((b) => b.documentId)).not.toContain(id);
    // …and recoverable from trash.
    const trash = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/trash", headers: { cookie: admin.cookie } });
    expect((trash.json() as Array<{ documentId: string }>).map((t) => t.documentId)).toContain(id);
  });
});
