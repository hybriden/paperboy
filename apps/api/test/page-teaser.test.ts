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
    const area = res.json().data.mainArea as Array<{ blockType: string; shared: boolean; content: { name: string; urlPath: string | null; kind: string } }>;
    expect(area).toHaveLength(1);
    expect(area[0].shared).toBe(true);
    expect(area[0].blockType).toBe("LandingPage");
    expect(area[0].content.name).toBe("Teaser Target");
    expect(area[0].content.urlPath).toBe("/teaser-target");
    expect(area[0].content.kind).toBe("page"); // frontends key teaser rendering on this
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

  it("nested: a page in an INLINE block's own content area delivers as a teaser (TeaserListBlock)", async () => {
    // Dogfoods the built-in library: SectionPage hosts an inline TeaserListBlock
    // whose `teasers` area references a page — the platform's teaser mechanism
    // one level down. Coercion/delivery recurse into inline data, so the nested
    // entry must resolve exactly like a top-level one.
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    for (const name of ["SectionPage", "TeaserListBlock"]) {
      const inst = await s.app.inject({ method: "POST", url: `/api/v1/manage/type-templates/${name}/instantiate`, headers: authHeaders(admin), payload: {} });
      expect(inst.statusCode, inst.body).toBe(200);
    }

    // A fresh published page to tease (the earlier target got unpublished).
    const t = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "LandingPage", locale: "en", name: "Nested Target" } });
    const nestedTargetId = t.json().documentId as string;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${nestedTargetId}?locale=en`, headers: authHeaders(ed), payload: { name: "Nested Target", slug: "nested-target", data: { heading: "Nested Target" } } });
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${nestedTargetId}/publish?locale=en`, headers: authHeaders(ed) })).statusCode).toBe(200);

    const h = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "SectionPage", locale: "en", name: "Nested Host" } });
    const nestedHostId = h.json().documentId as string;
    const upd = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${nestedHostId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: {
          heading: "Nested Host",
          mainArea: [{
            key: "tl1", blockType: "TeaserListBlock", display: "automatic", ref: null,
            inline: { heading: "Read more", teasers: [{ key: "t1", blockType: "LandingPage", display: "automatic", inline: null, ref: nestedTargetId }] },
          }],
        },
      },
    });
    expect(upd.statusCode, upd.body).toBe(200);
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${nestedHostId}/publish?locale=en`, headers: authHeaders(ed) })).statusCode).toBe(200);

    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${nestedHostId}?locale=en&populate=2`, headers: pub });
    expect(res.statusCode).toBe(200);
    const area = res.json().data.mainArea as Array<{ blockType: string; data: { teasers: Array<{ shared: boolean; content: { name: string; urlPath: string | null; kind: string } }> } }>;
    expect(area).toHaveLength(1);
    expect(area[0].blockType).toBe("TeaserListBlock");
    const teasers = area[0].data.teasers;
    expect(teasers).toHaveLength(1);
    expect(teasers[0].shared).toBe(true);
    expect(teasers[0].content.kind).toBe("page");
    expect(teasers[0].content.name).toBe("Nested Target");
    expect(teasers[0].content.urlPath).toBe("/nested-target");
  });

  it("blocks are still constrained by allowedBlocks (exemption is pages only)", async () => {
    // QuoteBlock must actually EXIST for this to test allowedBlocks rather than the
    // unknown-type guard — it isn't seeded, so install it first. (Before this, the
    // test used an uninstalled name and so never exercised the allowlist at all.)
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: {
        name: "QuoteBlock",
        displayName: "Quote Block",
        kind: "block",
        fields: [
          {
            name: "quote",
            displayName: "Quote",
            type: "text",
            localized: true,
            required: false,
            delivery: "public",
            allowedBlocks: [],
            allowedTypes: [],
            group: "Content",
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);

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
    // Installed, but not in LandingPage.mainArea's allowedBlocks → the allowlist path.
    expect(res.json().message).toContain("does not allow block");
  });

  it("an UNINSTALLED blockType is refused with the not-installed reason", async () => {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${hostId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        merge: true,
        data: { mainArea: [{ key: "x2", blockType: "NoSuchBlock", display: "automatic", inline: { a: 1 }, ref: null }] },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/not an installed content type/i);
  });
});
