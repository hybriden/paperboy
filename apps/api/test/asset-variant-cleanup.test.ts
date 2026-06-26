import { readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * S3-M3: the asset DELETE route unlinked only the original file, never the cached
 * transform variants under _variants/. Since @fastify/static serves that dir, the
 * derived bytes of a "deleted" asset stayed publicly downloadable (and leaked disk).
 * Deleting an asset must remove its variants too.
 */
function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = "----paperboyvariant123456";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  return { boundary, body: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

describe("asset delete removes cached transform variants", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("a deleted asset's variants are unlinked (not left publicly servable)", async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    const up = multipart("vic.png", "image/png", png);
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/assets", headers: { ...authHeaders(admin), "content-type": `multipart/form-data; boundary=${up.boundary}` }, payload: up.body });
    expect(created.statusCode).toBe(200);
    const documentId = created.json().documentId as string;
    const file = new URL(created.json().url).pathname.replace("/api/v1/media/", "");

    // Materialize a transform variant on disk.
    const t = await s.app.inject({ method: "GET", url: `/api/v1/media/${file}?w=64&format=webp` });
    expect(t.statusCode).toBe(200);
    const vdir = join(s.app.uploadsDir, "_variants");
    const before = (await readdir(vdir).catch(() => [] as string[])).filter((v) => v.startsWith(`${file}.`));
    expect(before.length).toBeGreaterThan(0); // a variant exists

    // Delete the asset.
    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/assets/${documentId}`, headers: authHeaders(admin) });
    expect(del.statusCode).toBe(200);

    const after = (await readdir(vdir).catch(() => [] as string[])).filter((v) => v.startsWith(`${file}.`));
    expect(after).toEqual([]); // variants removed
  });
});
