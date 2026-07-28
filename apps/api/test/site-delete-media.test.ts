import { readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * deleteSite removed the `asset` ROWS but never the files.
 *
 * The static media mount serves by filename with no DB lookup, so every image of a
 * deleted site stayed downloadable at its previously-published (CDN-cached,
 * sitemap-listed, externally-linked) URL — forever. "Delete Brand B" for an
 * offboarded client therefore could not satisfy a right-to-erasure request through
 * the product, and the cached transform variants under _variants/ stayed too.
 *
 * The SINGLE-asset delete route already does this correctly (unlink + variant
 * sweep, S3-M3), so the bulk path was strictly weaker than the per-item one.
 */
function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = "----paperboysitedelete123";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  return { boundary, body: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

describe("deleting a site removes its media from disk", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("unlinks the site's asset files and their cached variants", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(admin),
      payload: { slug: "brand-media", name: "Brand Media", defaultLocale: "en" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const siteId = created.json().id as string;
    const siteHeaders = { ...authHeaders(admin), "x-paperboy-site": siteId };

    // Upload an asset INTO that site (assets are per-site, decision D2).
    const png = await sharp({ create: { width: 240, height: 160, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .png()
      .toBuffer();
    const up = multipart("brand.png", "image/png", png);
    const asset = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/assets",
      headers: { ...siteHeaders, "content-type": `multipart/form-data; boundary=${up.boundary}` },
      payload: up.body,
    });
    expect(asset.statusCode, asset.body).toBe(200);
    const file = new URL(asset.json().url as string).pathname.replace("/api/v1/media/", "");

    // Materialise a cached transform variant too.
    expect((await s.app.inject({ method: "GET", url: `/api/v1/media/${file}?w=48&format=webp` })).statusCode).toBe(200);

    const listFiles = async () => await readdir(s.app.uploadsDir).catch(() => [] as string[]);
    const listVariants = async () =>
      (await readdir(join(s.app.uploadsDir, "_variants")).catch(() => [] as string[])).filter((v) =>
        v.startsWith(`${file}.`),
      );
    expect(await listFiles()).toContain(file);
    expect((await listVariants()).length).toBeGreaterThan(0);

    const deleted = await s.app.inject({
      method: "DELETE",
      url: `/api/v1/manage/sites/${siteId}?confirm=brand-media`,
      headers: authHeaders(admin),
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().assets).toBe(1);

    expect(await listFiles(), "the original file must be gone from disk").not.toContain(file);
    expect(await listVariants(), "cached variants must be gone too").toHaveLength(0);

    // And it must no longer be servable (the static mount has no DB lookup).
    expect((await s.app.inject({ method: "GET", url: `/api/v1/media/${file}` })).statusCode).toBe(404);
  });
});
