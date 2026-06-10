import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * On-page editing needs a TARGET for every editable field — but the delivery
 * serializer drops unset fields, so an empty richtext/text field rendered no
 * DOM and was invisible/unclickable in the preview. Fix: in the PREVIEW
 * perspective only, unset public text/markdown/richtext fields are emitted as
 * empty sentinels (mirrors the long-standing contentArea-always-present rule).
 * The PUBLISHED perspective stays lean — empty fields remain absent there.
 */
describe("delivery preview — empty editable fields are present (on-page edit targets)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("preview emits unset text/richtext fields as empty; published omits them", async () => {
    // ArticlePage: heading (text), intro (richtext), mainArea (contentArea),
    // plus the reserved SEO text group. Create one with ONLY the heading set.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Sparse Article" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const docId = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${docId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Just a heading" } },
    });

    // PREVIEW: the empty richtext field (intro) and empty SEO text fields are
    // present so the frontend can place a clickable on-page-edit marker.
    const preview = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${docId}?locale=en`, headers: prev });
    expect(preview.statusCode, preview.body).toBe(200);
    const pdata = preview.json().data as Record<string, unknown>;
    expect("intro" in pdata).toBe(true); // richtext → null sentinel
    expect(pdata.intro).toBeNull();
    expect("metaTitle" in pdata).toBe(true); // text → "" sentinel
    expect(pdata.metaTitle).toBe("");
    expect(pdata.heading).toBe("Just a heading");
    expect(pdata.mainArea).toEqual([]); // contentArea rule, unchanged

    // PUBLISHED: publish it, then the public read must NOT carry the empty keys.
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${docId}/publish?locale=en`, headers: authHeaders(ed) });
    const published = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${docId}?locale=en`, headers: pub });
    expect(published.statusCode, published.body).toBe(200);
    const data = published.json().data as Record<string, unknown>;
    expect("intro" in data).toBe(false);
    expect("metaTitle" in data).toBe(false);
    expect(data.heading).toBe("Just a heading");
    expect(data.mainArea).toEqual([]); // contentArea still always present
  });
});
