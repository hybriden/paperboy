import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * H1 + M1: the delivery list filter and sort read the RAW version row, so a
 * public consumer could filter/sort by a `delivery:"private"` field and use the
 * (sanitized) result set as an inference oracle over the hidden value. The fix
 * gates filter/sort keys to PUBLIC fields (plus the intrinsic name/slug/createdAt);
 * a private key is ignored, so it neither narrows nor reorders the public result.
 * ArticlePage.seoNotes is delivery:"private" (seed.ts:52).
 */
describe("Delivery: private fields cannot be used as a filter/sort oracle", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let docA: string;
  let docB: string;

  async function createArticle(name: string, heading: string, seoNotes: string): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "ArticlePage", parentId: null, locale: "en", name },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { heading, intro: null, mainArea: [], seoNotes } },
    });
    const pub = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    expect(pub.statusCode).toBe(200);
    return id;
  }

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // A before B in tree order (sortIndex). seoNotes chosen so a private sort
    // would reorder them (B's "aaa" precedes A's "zzz" ascending).
    docA = await createArticle("Oracle A", "Heading A", "zzz-secret-A");
    docB = await createArticle("Oracle B", "Heading B", "aaa-secret-B");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const ids = (res: { json: () => { items: Array<{ documentId: string }> } }) => res.json().items.map((i) => i.documentId);

  it("filtering by a PRIVATE field is ignored, not a value-confirmation oracle", async () => {
    const baseline = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=ArticlePage", headers: pub });
    const guess = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=ArticlePage&data.seoNotes=zzz-secret-A", headers: pub });
    // The private filter must NOT narrow the set to the matching doc.
    expect(guess.json().total).toBe(baseline.json().total);
    expect(ids(guess)).toContain(docB); // the non-matching doc is still present
  });

  it("sorting by a PRIVATE field is ignored, not an ordinal oracle", async () => {
    const sorted = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=ArticlePage&sort=data.seoNotes", headers: pub });
    const order = ids(sorted);
    // Tree order keeps A before B; a private sort would put B (aaa) first.
    expect(order.indexOf(docA)).toBeLessThan(order.indexOf(docB));
  });

  it("filtering/sorting by a PUBLIC field still works (regression)", async () => {
    const byHeading = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=ArticlePage&data.heading=Heading%20B", headers: pub });
    expect(ids(byHeading)).toEqual([docB]);
    expect(byHeading.json().total).toBe(1);
  });

  it("full-text search does NOT match on private field text (M2)", async () => {
    // "zzz" exists only in docA.seoNotes (delivery:"private") — a public search
    // for it must return nothing, or the hit/no-hit signal is a content oracle.
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/search?q=zzz", headers: pub });
    expect(res.statusCode).toBe(200);
    expect((res.json().items as unknown[]).length).toBe(0);
  });

  it("full-text search still matches PUBLIC field text (regression)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/search?q=Heading", headers: pub });
    expect(ids(res)).toContain(docA);
  });
});
