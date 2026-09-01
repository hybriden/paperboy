import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A page placed in a content area renders as a teaser. When that TARGET page is
 * still a draft, delivery's published perspective drops the block entirely — it
 * must, because keeping the shallow `{documentId, type}` entry would hand a
 * public key the id of an unpublished document.
 *
 * The drop is correct. What was missing is the SIGNAL: the editor saw the block
 * in the content area and in preview, and nothing anywhere said it would not
 * appear on the live site. `/manage/pages` named the target but not its publish
 * state, so the row had nothing to badge with.
 *
 * Reported 2026-09-01 on the demo instance: a Person teaser on /about showed in
 * the editor and in preview but never on demo.neoteric.no/en/about — its target
 * was draft revision 17, published never.
 */
describe("A content-area teaser pointing at a draft page", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  const create = async (name: string): Promise<string> => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "LandingPage", locale: "en", name },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().documentId as string;
  };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("is dropped from published delivery, and /manage/pages reports the target as unpublished", async () => {
    const target = await create("Draft teaser target");
    const host = await create("Teaser host");

    // A page ref is placeable in any content area regardless of allowedBlocks —
    // pages render as teasers, so their type name is never in that list.
    const put = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${host}?locale=en`,
      headers: authHeaders(admin),
      payload: {
        data: {
          heading: "Host heading",
          mainArea: [{ key: "k1", blockType: "LandingPage", ref: target, display: "automatic" }],
        },
      },
    });
    expect(put.statusCode, put.body).toBe(200);

    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${host}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(published.statusCode, published.body).toBe(200);

    // PREVIEW shows the teaser — this is what the editor sees in the pane.
    const previewRes = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${host}?locale=en&populate=0`,
      headers: prev,
    });
    expect(previewRes.statusCode).toBe(200);
    const previewArea = previewRes.json().data.mainArea as unknown[];
    expect(previewArea).toHaveLength(1);
    expect(previewArea[0]).toMatchObject({ shared: true, content: { documentId: target } });

    // PUBLISHED drops it — no block, and no trace of the draft target's id.
    const publicRes = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${host}?locale=en&populate=0`,
      headers: pub,
    });
    expect(publicRes.statusCode).toBe(200);
    expect(publicRes.json().data.mainArea).toEqual([]);
    expect(publicRes.body).not.toContain(target);

    // The signal the editor needs: per-locale publish state on the page list,
    // the same shape /manage/blocks already reports for shared blocks.
    const pages = await s.app.inject({ method: "GET", url: "/api/v1/manage/pages", headers: authHeaders(admin) });
    expect(pages.statusCode).toBe(200);
    const byId = new Map((pages.json() as { documentId: string; locales: Record<string, { status: string }> }[]).map((p) => [p.documentId, p]));
    expect(byId.get(target)?.locales).toEqual({ en: { status: "draft", hasUnpublishedChanges: true } });
    expect(byId.get(host)?.locales.en.status).toBe("published");
  });
});
