import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * CONTRACT FREEZE — Delivery cache semantics: ETag stability, conditional GET
 * (304), exact Cache-Control values per perspective, and immutable media caching.
 */

const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

// Minimal valid PNG (magic bytes + filler) — passes the upload magic-byte sniff.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function multipart(field: string, filename: string, contentType: string, data: Buffer) {
  const boundary = "----paperboycachetest1234567890";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, data, tail]) };
}

describe("Delivery API — cache headers, ETag, conditional GET", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("public GET sets exact Cache-Control + a weak cv-keyed ETag", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=300");
    expect(res.headers.etag).toMatch(/^W\/"cv-\d+"$/);
  });

  it("publicly-cacheable responses Vary on the credential (S3-M3: no cross-site cache bleed)", async () => {
    // The delivery key carries BOTH the perspective and the site; it rides only in
    // Authorization/x-api-key. A shared cache must partition on it, or one site's
    // payload is served to another site's key at the same URL (per-site slugs collide).
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    expect(res.statusCode).toBe(200);
    const vary = String(res.headers.vary ?? "").toLowerCase();
    expect(vary).toContain("authorization");
    expect(vary).toContain("x-api-key");
  });

  it("ETag is STABLE across two GETs of unchanged content", async () => {
    const a = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    const b = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    expect(a.headers.etag).toBeTruthy();
    expect(a.headers.etag).toBe(b.headers.etag);
  });

  it("If-None-Match with the current ETag → 304 with an EMPTY body", async () => {
    const first = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const conditional = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`,
      headers: { ...pub, "if-none-match": etag },
    });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.body).toBe("");
  });

  it("ETag CHANGES (cv bump) after publishing an edit to the content", async () => {
    const before = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    const etagBefore = before.headers.etag as string;

    // Edit + publish the home page (EN) — publish bumps the cache-version.
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${s.ids.homeId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { heading: "Welcome to Paperboy (edited)" } },
    });
    const pubRes = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${s.ids.homeId}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(pubRes.statusCode).toBe(200);

    const after = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    const etagAfter = after.headers.etag as string;
    expect(etagAfter).toBeTruthy();
    expect(etagAfter).not.toBe(etagBefore);

    // The OLD ETag no longer yields a 304 (cache correctly invalidated).
    const stale = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`,
      headers: { ...pub, "if-none-match": etagBefore },
    });
    expect(stale.statusCode).toBe(200);
  });

  it("preview GET sets Cache-Control 'private, no-store' and NO ETag", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`,
      headers: prev,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers.etag).toBeUndefined();
  });

  it("preview never 304s even when If-None-Match is sent (no-store working view)", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`,
      headers: { ...prev, "if-none-match": 'W/"cv-1"' },
    });
    expect(res.statusCode).toBe(200);
  });

  it("uploaded media is served with immutable cache + nosniff", async () => {
    const { boundary, body } = multipart("file", "cache.png", "image/png", PNG);
    const up = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/assets",
      headers: { ...authHeaders(admin), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(200);
    const path = new URL(up.json().url).pathname;

    const served = await s.app.inject({ method: "GET", url: path });
    expect(served.statusCode).toBe(200);
    expect(served.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["content-type"]).toContain("image/png");
  });
});
