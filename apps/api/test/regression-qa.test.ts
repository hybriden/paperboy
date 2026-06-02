import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Regression tests for bugs surfaced by the adversarial QA pass (2026-05-31):
 *  - HIGH: unpublish → data-only edit → republish wiped name/slug; unpublished
 *    content was not preview-visible.
 *  - MED: conditional 304 only worked on by-id (not by-slug / by-path).
 *  - LOW: revoking a non-existent delivery key returned 200 (false success).
 *  - LOW: populate>4 returned 422 instead of clamping.
 *  - GAP: SiteSettings global not seeded; no asset-delete route.
 */
describe("QA regressions", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("unpublish → data-only edit → republish PRESERVES name & slug (no data loss)", async () => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "StandardPage", locale: "en", name: "Keepme" } });
    const id = created.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { name: "Keepme", slug: "keepme", data: { heading: "First" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/unpublish?locale=en`, headers: authHeaders(ed) });

    // Data-only edit (no name/slug in the payload) must NOT reset them to Untitled/null.
    const edited = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { data: { heading: "Second" } } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().name).toBe("Keepme");
    expect(edited.json().slug).toBe("keepme");

    const republished = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    expect(republished.json().name).toBe("Keepme");
    expect(republished.json().slug).toBe("keepme");
  });

  it("unpublished content stays preview-visible (but not public)", async () => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "StandardPage", locale: "en", name: "TakenDown" } });
    const id = created.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { name: "TakenDown", slug: "takendown", data: { heading: "Down" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/unpublish?locale=en`, headers: authHeaders(ed) });

    expect((await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub })).statusCode).toBe(404);
    const preview = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: prev });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.heading).toBe("Down");
  });

  it("conditional 304 works on by-id, by-slug AND by-path", async () => {
    // Seeded Home is published with slug 'home' at path /home.
    const byId = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    const etag = byId.headers.etag as string;
    expect(etag).toMatch(/^W\/"cv-/);

    for (const url of [
      `/api/v1/delivery/content/${s.ids.homeId}?locale=en`,
      `/api/v1/delivery/content/by-slug?slug=home&locale=en`,
      `/api/v1/delivery/content/by-path?path=home&locale=en`,
    ]) {
      const res = await s.app.inject({ method: "GET", url, headers: { ...pub, "if-none-match": etag } });
      expect(res.statusCode, url).toBe(304);
    }
  });

  it("populate above the max clamps instead of erroring (200)", async () => {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=99`, headers: pub });
    expect(res.statusCode).toBe(200);
  });

  it("revoking a non-existent delivery key → 404 (not a false success)", async () => {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/delivery-keys/999999/revoke", headers: authHeaders(admin) });
    expect(res.statusCode).toBe(404);
  });

  it("SiteSettings global is delivered with private fields stripped", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/globals/SiteSettings?locale=en", headers: pub });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.siteName).toBe("Paperboy");
    expect(res.json().data.internalNote).toBeUndefined(); // private — never exposed
  });

  it("an asset can be deleted (and deleting a missing one is 404)", async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const boundary = "----pbqa";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.png"\r\nContent-Type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await s.app.inject({ method: "POST", url: "/api/v1/manage/assets", headers: { ...authHeaders(admin), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode).toBe(200);
    const id = up.json().documentId;
    expect((await s.app.inject({ method: "DELETE", url: `/api/v1/manage/assets/${id}`, headers: authHeaders(admin) })).statusCode).toBe(200);
    // Gone from the list, and a second delete is a 404.
    const list = await s.app.inject({ method: "GET", url: "/api/v1/manage/assets", headers: authHeaders(admin) });
    expect((list.json() as Array<{ documentId: string }>).some((a) => a.documentId === id)).toBe(false);
    expect((await s.app.inject({ method: "DELETE", url: `/api/v1/manage/assets/${id}`, headers: authHeaders(admin) })).statusCode).toBe(404);
  });
});
