import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAsset, getAccessContext, removeAssetFiles, schemaTables } from "@paperboy/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Suite, setupApi } from "./helpers.js";

/**
 * removeAssetFiles must FAIL LOUDLY on a real delete error, matching the comment
 * right above it — a swallowed unlink turned a right-to-erasure request into a
 * silent no-op with the bytes still downloadable. The directory guard already
 * throws when UPLOADS_DIR is missing; the file unlink was still
 * `.catch(() => undefined)`, so EACCES/EPERM/EISDIR on the actual file produced
 * a successful-looking erasure. Only ENOENT (already gone) is tolerable.
 */
describe("removeAssetFiles fails loudly on a real delete error (P4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-erase-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes the file when it exists", async () => {
    writeFileSync(join(dir, "abc123"), "bytes");
    await removeAssetFiles(dir, "/api/v1/media/abc123");
    expect(existsSync(join(dir, "abc123"))).toBe(false);
  });

  it("tolerates ENOENT — the file is already gone", async () => {
    await expect(removeAssetFiles(dir, "/api/v1/media/not-here")).resolves.toBeUndefined();
  });

  it("THROWS when the target cannot be deleted (a directory in the file's place → EPERM/EISDIR)", async () => {
    // A directory named like the asset file: unlink() on it fails with a real
    // errno that is not ENOENT. The old swallow reported success and left it.
    mkdirSync(join(dir, "stuck"));
    await expect(removeAssetFiles(dir, "/api/v1/media/stuck")).rejects.toThrow();
    expect(existsSync(join(dir, "stuck"))).toBe(true);
  });
});

/**
 * Audit 2026-09-30: deleteAsset committed the row delete FIRST and only then
 * removed the files. When that failed (UPLOADS_DIR missing on a stdio MCP, an
 * EACCES), the caller got an error, retried, and got 404 — while the file stayed
 * publicly downloadable with no row left to find it by. The row must survive a
 * failed file removal so the erasure can be retried.
 */
describe("deleteAsset keeps the row when the files can't be removed", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("a failed file removal leaves the asset in place (retryable), not orphaned bytes", async () => {
    const [admin] = await s.app.db.select().from(schemaTables.users).where(eq(schemaTables.users.email, "admin@paperboy.test"));
    const ctx = await getAccessContext(s.app.db, admin!.id);
    const documentId = `asset_erase_${Date.now()}`;
    await s.app.db.insert(schemaTables.asset).values({ documentId, filename: "x.png", mime: "image/png", size: 1, url: "/api/v1/media/erase-me.png", siteId: ctx.siteId });

    await expect(deleteAsset(s.app.db, ctx, documentId, "/definitely/not/an/uploads/dir")).rejects.toThrow(/UPLOADS_DIR/);
    const left = await s.app.db.select().from(schemaTables.asset).where(eq(schemaTables.asset.documentId, documentId));
    expect(left).toHaveLength(1);
  });
});
