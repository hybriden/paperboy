import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Pages dropped into a content area render as TEASERS (Optimizely-style): the
 * area entry references the page, delivery resolves it through the chokepoint
 * to {name, urlPath, public data}, and the frontend renders a compact card.
 * Pins: (1) a page is placeable even when allowedBlocks names blocks only,
 * (2) delivery resolves the entry with a urlPath, (3) no-leak — unpublishing
 * the page drops the entry from the published perspective.
 */
describe("pages in content areas → teasers", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  const pub = { "x-api-key": PUBLIC_KEY };
  let hostId: string; // the page whose mainArea holds the teaser
  let targetId: string; // the page dropped into the area

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");

    async function makePage(name: string, slug: string): Promise<string> {
      const created = await s.app.inject({
        method: "POST",
        url: "/api/v1/manage/content",
        headers: authHeaders(ed),
        payload: { type: "LandingPage", locale: "en", name },
      });
      const id = created.json().documentId as string;
      await s.app.inject({
        method: "PUT",
        url: `/api/v1/manage/content/${id}?locale=en`,
        headers: authHeaders(ed),
        payload: { name, slug, data: { heading: name } },
      });
      const published = await s.app.inject({
        method: "POST",
        url: `/api/v1/manage/content/${id}/publish?locale=en`,
        headers: authHeaders(ed),
      });
      expect(published.statusCode).toBe(200);
      return id;
    }
    targetId = await makePage("Teaser Target", "teaser-target");
    hostId = await makePage("Teaser Host", "teaser-host");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("a page is placeable in an area whose allowedBlocks names blocks only", async () => {
    // Seed LandingPage.mainArea allows HeroBlock/CardBlock/ListBlock — the
    // page-kind exemption must let "LandingPage" through anyway.
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${hostId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: { mainArea: [{ key: "t1", blockType: "LandingPage", display: "automatic", inline: null, ref: targetId }] },
      },
    });
    expect(res.statusCode).toBe(200);
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${hostId}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(published.statusCode).toBe(200);
  });

  it("delivery resolves the page entry with name + urlPath (teaser data)", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${hostId}?locale=en&populate=2`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    const area = res.json().data.mainArea as Array<{ blockType: string; shared: boolean; content: { name: string; urlPath: string | null } }>;
    expect(area).toHaveLength(1);
    expect(area[0].shared).toBe(true);
    expect(area[0].blockType).toBe("LandingPage");
    expect(area[0].content.name).toBe("Teaser Target");
    expect(area[0].content.urlPath).toBe("/teaser-target");
  });

  it("no-leak: unpublishing the page drops its teaser from the published area", async () => {
    const unpub = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${targetId}/unpublish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(unpub.statusCode).toBe(200);
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${hostId}?locale=en&populate=2`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mainArea).toHaveLength(0);
  });

  it("blocks are still constrained by allowedBlocks (exemption is pages only)", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${hostId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: { mainArea: [{ key: "x1", blockType: "QuoteBlock", display: "automatic", inline: { quote: "hi" }, ref: null }] },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("does not allow block");
  });
});
