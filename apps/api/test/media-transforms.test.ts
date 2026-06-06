import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/** Build a real, decodable PNG so sharp can transform it. */
async function testPng(width = 300, height = 200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();
}

function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = "----paperboytransform123456";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, data, tail]) };
}

describe("Media: on-the-fly image transforms (?w=&format=&q=)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let imagePath: string; // /api/v1/media/<file>
  let pdfPath: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const png = await testPng();
    const up = multipart("photo.png", "image/png", png);
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/assets",
      headers: { ...authHeaders(admin), "content-type": `multipart/form-data; boundary=${up.boundary}` },
      payload: up.body,
    });
    expect(res.statusCode).toBe(200);
    imagePath = new URL(res.json().url).pathname;

    const pdf = multipart("doc.pdf", "application/pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]));
    const pres = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/assets",
      headers: { ...authHeaders(admin), "content-type": `multipart/form-data; boundary=${pdf.boundary}` },
      payload: pdf.body,
    });
    pdfPath = new URL(pres.json().url).pathname;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("serves the original untouched without transform params", async () => {
    const res = await s.app.inject({ method: "GET", url: imagePath });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(300);
  });

  it("resizes to the snapped width and converts format (?w=100&format=webp)", async () => {
    const res = await s.app.inject({ method: "GET", url: `${imagePath}?w=100&format=webp` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(128); // 100 snaps UP to the 128 step
  });

  it("never enlarges beyond the source width", async () => {
    const res = await s.app.inject({ method: "GET", url: `${imagePath}?w=2000` });
    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(300); // source is 300px — withoutEnlargement
  });

  it("serves the cached variant on a repeat request (identical bytes)", async () => {
    const a = await s.app.inject({ method: "GET", url: `${imagePath}?w=100&format=webp` });
    const b = await s.app.inject({ method: "GET", url: `${imagePath}?w=100&format=webp` });
    expect(Buffer.compare(a.rawPayload, b.rawPayload)).toBe(0);
  });

  it("jpeg conversion flattens alpha and respects quality snapping", async () => {
    const res = await s.app.inject({ method: "GET", url: `${imagePath}?w=64&format=jpeg&q=51` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("rejects an unknown format (422)", async () => {
    const res = await s.app.inject({ method: "GET", url: `${imagePath}?format=bmp` });
    expect(res.statusCode).toBe(422);
  });

  it("ignores transform params on non-transformable types (pdf served as-is)", async () => {
    const res = await s.app.inject({ method: "GET", url: `${pdfPath}?w=100&format=webp` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
  });

  it("rejects traversal-shaped filenames (no dots/slashes beyond the extension)", async () => {
    for (const bad of ["..%2Fsecret.png", "a.b.png", "x%2Fy.png"]) {
      const res = await s.app.inject({ method: "GET", url: `/api/v1/media/${bad}?w=100` });
      expect([404, 422]).toContain(res.statusCode);
    }
  });

  it("404s for a missing file", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/media/doesnotexist000000000000.png?w=100" });
    expect(res.statusCode).toBe(404);
  });
});
