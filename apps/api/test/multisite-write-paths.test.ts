import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Multisite partition on the write paths OTHER than create.
 *
 * The partition was verified for createContent and the broad scans, but duplicate
 * and move were never exercised with an `x-paperboy-site` header — so two
 * cross-tenant bugs hid there:
 *
 *  - cloneContent omitted `siteId` from its content_item insert, so the column
 *    DEFAULT ('site_default') applied: duplicating inside a non-default site wrote
 *    the copy into the DEFAULT site, and then 404'd because loadAuthorized found it
 *    outside the active site. The user saw a failure; a copy of their page was
 *    silently live in another site's tree.
 *
 *  - moveContent's destination sibling renumber matched roots with
 *    `isNull(parentId)` and NO site filter, so reordering a root page in one site
 *    rewrote every OTHER site's root sortIndex — changing their nav order and
 *    deliveryList ordering. (slugTakenBySibling already filters by site, so this
 *    was an omission, not a design choice.)
 */
describe("multisite — duplicate and move stay inside the active site", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let brandId: string;
  const raw = createDb(TEST_DB);

  const siteHeaders = (ctx: Awaited<ReturnType<typeof login>>, siteId: string) => ({
    ...authHeaders(ctx),
    "x-paperboy-site": siteId,
  });

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(admin),
      payload: { slug: "brand-write", name: "Brand Write", defaultLocale: "en" },
    });
    expect(created.statusCode, created.body).toBe(200);
    brandId = created.json().id as string;
    expect(brandId).toBeTruthy();
  });

  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  /** Create a root page in `siteId` and return its documentId. */
  async function createRoot(siteId: string, name: string): Promise<string> {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: siteHeaders(admin, siteId),
      payload: { type: "ArticlePage", parentId: null, locale: "en", name },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  }

  it("duplicating a page in a non-default site keeps the copy in THAT site", async () => {
    const original = await createRoot(brandId, "Brand Original");

    const dup = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${original}/duplicate?locale=en`,
      headers: siteHeaders(admin, brandId),
    });
    // The 404 here was the visible symptom: the copy was committed into
    // site_default, then read back through the active site and not found.
    expect(dup.statusCode, dup.body).toBe(200);
    const copyId = dup.json().documentId as string;

    const rows = (await raw.sql`
      SELECT site_id FROM content_item WHERE document_id = ${copyId}
    `) as unknown as { site_id: string }[];
    expect(rows[0]?.site_id).toBe(brandId);
  });

  it("the duplicate is reachable in its own site's tree and absent from the Default site's", async () => {
    const original = await createRoot(brandId, "Brand Reachable");
    const dup = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${original}/duplicate?locale=en`,
      headers: siteHeaders(admin, brandId),
    });
    expect(dup.statusCode, dup.body).toBe(200);
    const copyId = dup.json().documentId as string;

    const inBrand = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${copyId}?locale=en`,
      headers: siteHeaders(admin, brandId),
    });
    expect(inBrand.statusCode).toBe(200);

    const inDefault = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${copyId}?locale=en`,
      headers: siteHeaders(admin, "site_default"),
    });
    expect(inDefault.statusCode).toBe(404); // partition holds both ways
  });

  it("reordering a root in one site does NOT renumber another site's roots", async () => {
    // Two roots in the brand site, plus whatever the Default site already has.
    const a = await createRoot(brandId, "Brand Root A");
    const b = await createRoot(brandId, "Brand Root B");

    const defaultOrderBefore = (await raw.sql`
      SELECT document_id, sort_index FROM content_item
      WHERE site_id = 'site_default' AND parent_id IS NULL AND deleted_at IS NULL
      ORDER BY sort_index, id
    `) as unknown as { document_id: string; sort_index: number }[];

    // Move B above A, inside the brand site only.
    const moved = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${b}/move`,
      headers: siteHeaders(admin, brandId),
      payload: { parentId: null, beforeId: a },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const defaultOrderAfter = (await raw.sql`
      SELECT document_id, sort_index FROM content_item
      WHERE site_id = 'site_default' AND parent_id IS NULL AND deleted_at IS NULL
      ORDER BY sort_index, id
    `) as unknown as { document_id: string; sort_index: number }[];

    expect(defaultOrderAfter).toEqual(defaultOrderBefore);

    // …and the intended reorder really happened in the brand site.
    const brandOrder = (await raw.sql`
      SELECT document_id FROM content_item
      WHERE site_id = ${brandId} AND parent_id IS NULL AND deleted_at IS NULL
      ORDER BY sort_index, id
    `) as unknown as { document_id: string }[];
    const ids = brandOrder.map((r) => r.document_id);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
  });

  it("a move cannot use another site's page as the before/after anchor", async () => {
    const brandRoot = await createRoot(brandId, "Brand Anchor Target");
    const defaultRoot = await createRoot("site_default", "Default Anchor");

    const moved = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${brandRoot}/move`,
      headers: siteHeaders(admin, brandId),
      payload: { parentId: null, beforeId: defaultRoot },
    });
    // The cross-site anchor must simply not apply (it isn't a sibling); it must
    // never pull the other site's row into this site's sibling group.
    expect(moved.statusCode, moved.body).toBe(200);

    const stillDefault = (await raw.sql`
      SELECT site_id FROM content_item WHERE document_id = ${defaultRoot}
    `) as unknown as { site_id: string }[];
    expect(stillDefault[0]?.site_id).toBe("site_default");
  });
});
