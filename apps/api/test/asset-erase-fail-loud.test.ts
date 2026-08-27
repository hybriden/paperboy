import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAssetFiles } from "@paperboy/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
