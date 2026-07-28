import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Withdrawal and the delivered cache version.
 *
 * `unpublishContent` and `softDelete` now allocate a fresh `cv` from `cv_seq` on the
 * way out, instead of only flipping `isCurrentPublished`. That makes the withdrawn
 * ROW carry a new version, which is a prerequisite for any correct invalidation.
 *
 * ⚠️ IT IS NOT SUFFICIENT FOR LIST RESPONSES, and this file proves it rather than
 * pretending otherwise. `apps/api/src/routes/delivery.ts` derives a list ETag from
 * `max(cv)` over the items it RETURNED — and a withdrawn item is by definition not
 * returned, so its new `cv` is invisible. Measured here: with another page holding
 * the highest `cv`, unpublishing a page leaves the list ETag byte-identical, the next
 * conditional GET 304s, and because the response carries `stale-while-revalidate`
 * the CDN keeps refreshing its own freshness — withdrawn content stays served.
 *
 * A real fix needs a monotonic per-site (or per-type) change counter folded into the
 * ETag, so that a REMOVAL can move it. That is a schema change and is tracked as
 * open work; the same task covers the other half of the finding (an embedded shared
 * block, an ancestor rename, or a SiteSettings republish also leave `cv` untouched).
 *
 * What this file DOES pin: withdrawal really removes the item from the published
 * perspective (the no-leak guarantee), which is independent of caching.
 */
describe("withdrawal removes content from the published perspective", () => {
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

  async function publishedPage(name: string): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "ArticlePage", parentId: null, locale: "en", name },
    });
    expect(created.statusCode, created.body).toBe(200);
    const documentId = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { heading: name } },
    });
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(published.statusCode, published.body).toBe(200);
    return documentId;
  }

  const publishedIds = async (): Promise<string[]> => {
    const r = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/content?type=ArticlePage&locale=en",
      headers: pub,
    });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json().items as { documentId: string }[]).map((i) => i.documentId);
  };

  it("an unpublished page leaves the published list", async () => {
    const documentId = await publishedPage("Withdrawal Unpublish");
    expect(await publishedIds()).toContain(documentId);

    const un = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/unpublish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(un.statusCode, un.body).toBe(200);
    expect(await publishedIds()).not.toContain(documentId);
  });

  it("a trashed page leaves the published list", async () => {
    const documentId = await publishedPage("Withdrawal Trash");
    expect(await publishedIds()).toContain(documentId);

    const trashed = await s.app.inject({
      method: "DELETE",
      url: `/api/v1/manage/content/${documentId}`,
      headers: authHeaders(admin),
    });
    expect(trashed.statusCode, trashed.body).toBe(200);
    expect(await publishedIds()).not.toContain(documentId);
  });

  it("withdrawal allocates a new cv on the row (prerequisite for invalidation)", async () => {
    const documentId = await publishedPage("Withdrawal Cv");
    const before = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${documentId}?locale=en`,
      headers: pub,
    });
    expect(before.statusCode).toBe(200);
    const cvBefore = before.json().cv as number;

    await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/unpublish?locale=en`,
      headers: authHeaders(admin),
    });

    // Publish it again: the row's cv must have moved past its pre-withdrawal value,
    // i.e. the withdrawal itself consumed a sequence value.
    await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    const after = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${documentId}?locale=en`,
      headers: pub,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().cv as number).toBeGreaterThan(cvBefore + 1);
  });
});
