import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("Delivery API — headless data + structural no-leak", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  it("serves published content as JSON over the public Delivery API (headless)", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=1`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("LandingPage");
    expect(body.data.heading).toBe("Welcome to Paperboy");
    // Cache-version + cache headers present.
    expect(typeof body.cv).toBe("number");
    expect(res.headers["cache-control"]).toContain("public");
    expect(res.headers.etag).toContain("cv-");
  });

  it("rejects requests with no/invalid API key (401)", async () => {
    const none = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}` });
    expect(none.statusCode).toBe(401);
    const bad = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}`,
      headers: { authorization: "Bearer pk_live_not_a_real_key" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("NEVER returns a draft through the public key, but DOES through preview", async () => {
    const asPublic = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.secretId}?locale=en`,
      headers: pub,
    });
    expect(asPublic.statusCode).toBe(404); // draft is physically unreachable

    const asPreview = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.secretId}?locale=en`,
      headers: prev,
    });
    expect(asPreview.statusCode).toBe(200);
    expect(asPreview.json().data.heading).toContain("Unpublished");
  });

  it("strips private fields (fail-closed) regardless of perspective", async () => {
    // Author Zone is an ArticlePage, whose seoNotes field is delivery:"private".
    for (const headers of [pub, prev]) {
      const res = await s.app.inject({
        method: "GET",
        url: `/api/v1/delivery/content/${s.ids.authorZoneId}?locale=en&populate=2`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      // seoNotes is delivery:"private" — must never appear.
      expect(res.json().data).not.toHaveProperty("seoNotes");
    }
  });

  it("resolves shared blocks inside content areas when populated", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`,
      headers: pub,
    });
    const area = res.json().data.mainArea as Array<Record<string, unknown>>;
    const shared = area.find((b) => b.shared === true);
    expect(shared).toBeTruthy();
    // The referenced CardBlock content is expanded and sanitized.
    expect((shared!.content as { data: { title: string } }).data.title).toBe("Built for developers");
  });

  it("draft-references-draft: only resolvable under the preview perspective", async () => {
    // Author the graph via the Management API as editor.
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    // 1) a draft shared CardBlock
    const block = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "CardBlock", locale: "en", name: "Draft Card" },
    });
    const blockId = block.json().documentId;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${blockId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { title: "Draft-only card" } },
    });
    // 2) a draft page whose content area references the draft block
    const page = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Draft Page" },
    });
    const pageId = page.json().documentId;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        data: {
          heading: "Draft page",
          mainArea: [{ key: "k1", blockType: "CardBlock", display: "automatic", ref: blockId, inline: null }],
        },
      },
    });

    // Public: page is a draft -> 404.
    const pub404 = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${pageId}?locale=en&populate=2`,
      headers: pub,
    });
    expect(pub404.statusCode).toBe(404);

    // Preview: page resolves AND its draft reference resolves through the same perspective.
    const prev200 = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${pageId}?locale=en&populate=2`,
      headers: prev,
    });
    expect(prev200.statusCode).toBe(200);
    const area = prev200.json().data.mainArea as Array<Record<string, unknown>>;
    expect((area[0].content as { data: { title: string } }).data.title).toBe("Draft-only card");
  });
});
