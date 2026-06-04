import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("Pages, blocks, content areas + draft/publish lifecycle", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  it("creates a page (draft) that is NOT yet in the published Delivery API", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Lifecycle Page" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().status).toBe("draft");
    const id = created.json().documentId;

    const delivery = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(delivery.statusCode).toBe(404);
  });

  it("builds a content area with an inline Hero block + a shared Card block, then publishes", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Composed Page" },
    });
    const id = created.json().documentId;

    const save = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        slug: "composed",
        data: {
          heading: "Composed with blocks",
          mainArea: [
            { key: "a", blockType: "HeroBlock", display: "full", ref: null, inline: { title: "Inline hero", subtitle: "page-local", ctaUrl: "/x" } },
            { key: "b", blockType: "CardBlock", display: "narrow", ref: s.ids.cardId, inline: null },
          ],
        },
      },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().hasUnpublishedChanges).toBe(true);

    const publish = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(publish.statusCode).toBe(200);

    // Now visible publicly, with both blocks resolved.
    const delivery = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${id}?locale=en&populate=2`,
      headers: pub,
    });
    expect(delivery.statusCode).toBe(200);
    const area = delivery.json().data.mainArea as Array<Record<string, unknown>>;
    expect(area).toHaveLength(2);
    const inline = area.find((b) => b.shared === false);
    const shared = area.find((b) => b.shared === true);
    expect((inline!.data as { title: string }).title).toBe("Inline hero");
    expect((shared!.content as { data: { title: string } }).data.title).toBe("Built for developers");
  });

  it("publish requires a draft; required-field validation is enforced at publish only", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Invalid Page" },
    });
    const id = created.json().documentId;
    // Save a draft WITHOUT the required `heading` (allowed for drafts).
    const draftSave = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { intro: { type: "doc", content: [] } } },
    });
    expect(draftSave.statusCode).toBe(200);
    // Publishing must fail validation because `heading` is required.
    const publish = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(publish.statusCode).toBe(422);
  });

  it("unpublish removes content from the public Delivery API", async () => {
    const delivery = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    expect(delivery.statusCode).toBe(200);
    const unpublish = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${s.ids.homeId}/unpublish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(unpublish.statusCode).toBe(200);
    const after = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    expect(after.statusCode).toBe(404);
  });

  it("unpublish → publish round-trips (no draft needed to republish)", async () => {
    // Regression: unpublish only demotes the live row and leaves no draft, so
    // publish used to 409 with "Nothing to publish" — the page was stuck
    // unpublished until an edit created a draft.
    const republish = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${s.ids.homeId}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(republish.statusCode).toBe(200);
    expect(republish.json().status).toBe("published");
    const delivery = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    expect(delivery.statusCode).toBe(200);
  });
});
