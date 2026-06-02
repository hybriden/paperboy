import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

// Minimal valid-ish payloads for magic-byte sniffing.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** Build a multipart/form-data body with a single file field. */
function multipart(field: string, filename: string, contentType: string, data: Buffer) {
  const boundary = "----paperboytest1234567890";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, data, tail]) };
}

async function upload(app: Suite["app"], ctx: Awaited<ReturnType<typeof login>>, filename: string, ct: string, data: Buffer) {
  const { boundary, body } = multipart("file", filename, ct, data);
  return app.inject({
    method: "POST",
    url: "/api/v1/manage/assets",
    headers: { ...authHeaders(ctx), "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

describe("Media: upload, serve, list, and the image field type", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("uploads a PNG and serves it with nosniff + correct content-type", async () => {
    const res = await upload(s.app, admin, "logo.png", "image/png", PNG);
    expect(res.statusCode).toBe(200);
    const asset = res.json();
    expect(asset.mime).toBe("image/png");
    expect(asset.url).toContain("/api/v1/media/");

    const path = new URL(asset.url).pathname;
    const served = await s.app.inject({ method: "GET", url: path });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects an SVG/HTML payload by MAGIC BYTES even if named .png (415)", async () => {
    const res = await upload(s.app, admin, "evil.png", "image/png", SVG);
    expect(res.statusCode).toBe(415);
  });

  it("rejects oversized uploads (413)", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 2)]);
    const res = await upload(s.app, admin, "big.png", "image/png", big);
    expect(res.statusCode).toBe(413);
  });

  it("accepts a PDF document by magic bytes (application/pdf)", async () => {
    const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
    const res = await upload(s.app, admin, "brochure.pdf", "application/pdf", PDF);
    expect(res.statusCode).toBe(200);
    expect(res.json().mime).toBe("application/pdf");
    expect(res.json().url).toMatch(/\.pdf$/);
  });

  it("still rejects a disguised executable (415)", async () => {
    const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0)]); // "MZ"
    const res = await upload(s.app, admin, "x.pdf", "application/pdf", EXE);
    expect(res.statusCode).toBe(415);
  });

  it("requires CSRF on upload (403 without token)", async () => {
    const { boundary, body } = multipart("file", "x.png", "image/png", PNG);
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/assets",
      headers: { cookie: admin.cookie, origin: "http://localhost:8090", "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists uploaded assets", async () => {
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/assets", headers: { cookie: admin.cookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it("an `image` field resolves to {url,alt} in delivery (public) and is null when the asset is missing", async () => {
    // Upload an asset and set alt.
    const asset = (await upload(s.app, admin, "hero.png", "image/png", PNG)).json();
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/assets/${asset.documentId}`, headers: authHeaders(admin), payload: { alt: "Hero alt" } });

    // A shared HeroBlock with heroImage set, published.
    const block = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "HeroBlock", locale: "en", name: "Img Hero" } });
    const blockId = block.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${blockId}?locale=en`, headers: authHeaders(admin), payload: { data: { title: "Has image", heroImage: asset.documentId } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${blockId}/publish?locale=en`, headers: authHeaders(admin) });

    const out = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${blockId}?locale=en`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    expect(out.statusCode).toBe(200);
    const img = out.json().data.heroImage;
    expect(img.url).toContain("/api/v1/media/");
    expect(img.alt).toBe("Hero alt");

    // Missing asset → null (not a throw).
    const block2 = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "HeroBlock", locale: "en", name: "No Image" } });
    const b2 = block2.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${b2}?locale=en`, headers: authHeaders(admin), payload: { data: { title: "ghost", heroImage: "doesnotexist000000000000" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${b2}/publish?locale=en`, headers: authHeaders(admin) });
    const out2 = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${b2}?locale=en`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    expect(out2.json().data.heroImage).toBeNull();
  });
});
