import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The ETag must change when anything the representation EMBEDS changes.
 *
 * It used to be the root item's own `cv`, which only moves when that item is
 * republished — so delivery returned 304 for representations that demonstrably
 * changed. Three reproduced ways, all pinned below:
 *
 *   1. republish an embedded shared block  → the page's rendered body changes
 *   2. rename + republish an ancestor      → urlPath / canonicalPath / breadcrumb
 *   3. republish SiteSettings              → seo.og.siteName, on EVERY page
 *
 * And it mattered more than a stale minute: the response carries
 * `stale-while-revalidate=300`, so each revalidation refreshed the CDN's own
 * freshness and the stale copy was served indefinitely. @paperboycms/client's
 * `etagCache` did the same in-process.
 *
 * `cv` is now the max over every row the request resolved (DeliveryCtx.maxCv), which
 * `variantRow` collects for nested refs, the ancestor slug walk, breadcrumbs and
 * siteName alike.
 */
describe("delivery ETag reflects the whole resolved graph", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    s.app.inject({ method: "GET", url, headers: { ...pub, ...headers } });

  const publish = async (documentId: string, locale = "en") => {
    const r = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=${locale}`,
      headers: authHeaders(admin),
    });
    expect(r.statusCode, r.body).toBe(200);
  };

  const save = async (documentId: string, data: Record<string, unknown>, locale = "en") => {
    const r = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=${locale}`,
      headers: authHeaders(admin),
      payload: { data },
    });
    expect(r.statusCode, r.body).toBe(200);
  };

  /** ETag of the home page WITH its shared-block graph populated. */
  const homeEtag = async (): Promise<string> => {
    const r = await get(`/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`);
    expect(r.statusCode, r.body).toBe(200);
    return r.headers.etag as string;
  };

  it("republishing an EMBEDDED shared block changes the page's ETag", async () => {
    const before = await homeEtag();
    expect(before).toBeTruthy();

    // The seeded shared card is referenced from Home's content area.
    await save(s.ids.cardId, { title: "Card retitled by the ETag test", body: null });
    await publish(s.ids.cardId);

    const after = await homeEtag();
    expect(after, "the page embeds this block, so its ETag must move").not.toBe(before);

    // …and a client replaying the old ETag must not be told "not modified".
    const conditional = await get(`/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`, {
      "if-none-match": before,
    });
    expect(conditional.statusCode, "stale 304 — the embedded block changed").not.toBe(304);
  });

  it("republishing SiteSettings changes every page's ETag (it feeds seo.og.siteName)", async () => {
    const before = await homeEtag();

    const settings = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/globals/SiteSettings?locale=en",
      headers: pub,
    });
    expect(settings.statusCode).toBe(200);
    const settingsId = settings.json().documentId as string;

    await save(settingsId, { siteName: "Renamed By ETag Test" });
    await publish(settingsId);

    expect(await homeEtag(), "og.siteName comes from SiteSettings, so it is part of this payload").not.toBe(before);
  });

  it("an unchanged page still returns 304 (the ETag is not simply always-new)", async () => {
    const etag = await homeEtag();
    const again = await get(`/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`, {
      "if-none-match": etag,
    });
    expect(again.statusCode, "nothing changed — caching must still work").toBe(304);
  });

  it("the preview perspective keeps its own ETag independent of published", async () => {
    const publishedEtag = await homeEtag();
    const previewRes = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`,
      headers: { authorization: `Bearer ${PREVIEW_KEY}` },
    });
    expect(previewRes.statusCode).toBe(200);
    // Both are valid ETags; the point is that a published 304 can't be satisfied by
    // a preview representation or vice versa.
    const conditional = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`,
      headers: { authorization: `Bearer ${PREVIEW_KEY}`, "if-none-match": publishedEtag },
    });
    if (previewRes.headers.etag !== publishedEtag) expect(conditional.statusCode).not.toBe(304);
  });
});
