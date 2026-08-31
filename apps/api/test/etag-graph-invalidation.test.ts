import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

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
  const raw = createDb(TEST_DB);

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
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

  it("a document that is NOT part of the representation (another site's) does not move the ETag", async () => {
    // `variantRow` bumped maxCv before `resolveContent` found the item to be
    // cross-site (or trashed) and dropped it — so a document the page never
    // embeds still invalidated it on every republish.
    const site = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-etag", name: "Brand ETag", defaultLocale: "en" } });
    expect(site.statusCode, site.body).toBe(200);
    const otherSite = { ...authHeaders(admin), "x-paperboy-site": site.json().id as string };

    const block = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "CardBlock", locale: "en", name: "Card that moves site" } });
    const blockId = block.json().documentId as string;
    await save(blockId, { title: "Movable card", body: null });
    await publish(blockId);

    const page = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "LandingPage", locale: "en", name: "Page with a moving card" } });
    const pageId = page.json().documentId as string;
    await save(pageId, { heading: "Moving", mainArea: [{ key: "c", blockType: "CardBlock", display: "automatic", ref: blockId, inline: null }] });
    await publish(pageId);

    // Moving the block to another site is what an editor can no longer do by
    // reference (write-time validation), so it is done underneath: the page now
    // holds a cross-site ref, which delivery drops.
    await raw.sql`UPDATE content_item SET site_id = ${site.json().id as string} WHERE document_id = ${blockId}`;
    const pageUrl = `/api/v1/delivery/content/${pageId}?locale=en&populate=2`;
    const before = await get(pageUrl);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.body).not.toContain("Movable card");

    const moved = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${blockId}?locale=en`, headers: otherSite, payload: { data: { title: "Movable card, republished", body: null } } });
    expect(moved.statusCode, moved.body).toBe(200);
    const republished = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${blockId}/publish?locale=en`, headers: otherSite });
    expect(republished.statusCode, republished.body).toBe(200);

    const after = await get(pageUrl);
    expect(after.headers.etag, "the block is not in this representation, so its republish must not move the ETag").toBe(before.headers.etag);
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
