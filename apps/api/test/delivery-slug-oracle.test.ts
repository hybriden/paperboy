import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * `by-slug` must answer for the slug the SELECTED version actually has.
 *
 * The candidate scan matched ANY `content_version` row with that slug — drafts and
 * superseded history included — and then re-resolved the DOCUMENT through the
 * chokepoint. The chokepoint correctly returns only the published version, so no
 * draft CONTENT leaked; but nothing checked that the version it returned actually
 * carries the requested slug. Two consequences:
 *
 *  1. An unreleased slug is confirmable with the PUBLIC key: rename a draft to
 *     `secret-campaign-2027` and `by-slug?slug=secret-campaign-2027` answers 200
 *     (with the published content), while a made-up slug answers 404. That is an
 *     existence oracle over unreleased URLs — embargoed campaigns, unannounced
 *     products — readable by anyone holding the key that ships in every frontend.
 *  2. Every slug a page has EVER had keeps answering 200 forever, so renaming a
 *     page silently creates permanent duplicate content at the old URL.
 */
describe("delivery by-slug answers only for the selected version's slug", () => {
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

  async function page(name: string, slug: string): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "ArticlePage", parentId: null, locale: "en", name },
    });
    expect(created.statusCode, created.body).toBe(200);
    const documentId = created.json().documentId as string;
    const saved = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { slug, data: { heading: name } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(published.statusCode, published.body).toBe(200);
    return documentId;
  }

  const bySlug = (slug: string) =>
    s.app.inject({ method: "GET", url: `/api/v1/delivery/content/by-slug?slug=${encodeURIComponent(slug)}`, headers: pub });

  const setDraftSlug = (documentId: string, slug: string) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { slug, data: { heading: "unchanged" } },
    });

  it("resolves a genuinely published slug (baseline)", async () => {
    await page("Oracle Baseline", "oracle-live-slug");
    const res = await bySlug("oracle-live-slug");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().slug).toBe("oracle-live-slug");
  });

  it("404s a slug that exists only on an UNPUBLISHED draft", async () => {
    const id = await page("Oracle Embargo", "oracle-live-b");
    const renamed = await setDraftSlug(id, "secret-campaign-2027");
    expect(renamed.statusCode, renamed.body).toBe(200);

    const res = await bySlug("secret-campaign-2027");
    expect(res.statusCode, `leaked an unreleased slug: ${res.body.slice(0, 200)}`).toBe(404);
  });

  it("is indistinguishable from a slug that never existed", async () => {
    const invented = await bySlug("no-such-slug-anywhere-12345");
    const embargoed = await bySlug("secret-campaign-2027");
    expect(embargoed.statusCode).toBe(invented.statusCode);
  });

  it("404s a slug the page has been renamed AWAY from (no permanent duplicate)", async () => {
    const id = await page("Oracle Renamed", "oracle-old-url");
    expect((await setDraftSlug(id, "oracle-new-url")).statusCode).toBe(200);
    const republished = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(republished.statusCode, republished.body).toBe(200);

    expect((await bySlug("oracle-new-url")).statusCode, "the new URL must work").toBe(200);
    expect((await bySlug("oracle-old-url")).statusCode, "the old URL must not linger").toBe(404);
  });

  it("the preview perspective still resolves the draft slug", async () => {
    // The draft slug is legitimately addressable under a PREVIEW key — that is
    // what preview is for. Only the published perspective must refuse it.
    const id = await page("Oracle Preview", "oracle-preview-live");
    expect((await setDraftSlug(id, "oracle-preview-draft")).statusCode).toBe(200);
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/content/by-slug?slug=oracle-preview-draft",
      headers: { authorization: `Bearer ${PREVIEW_KEY}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().slug).toBe("oracle-preview-draft");
  });
});
