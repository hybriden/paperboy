import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe('"Used on" — reverse references', () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("lists the documents that embed a shared block, and how", async () => {
    // A page whose contentArea pulls in the seeded shared Card block.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Uses The Card" },
    });
    const pageId = created.json().documentId;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${pageId}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        data: {
          heading: "Uses the card",
          mainArea: [{ key: "c", blockType: "CardBlock", display: "narrow", ref: s.ids.cardId, inline: null }],
        },
      },
    });

    const refs = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${s.ids.cardId}/references`,
      headers: authHeaders(ed),
    });
    expect(refs.statusCode).toBe(200);
    const list = refs.json() as Array<{ documentId: string; name: string; kind: string; fields: string[] }>;
    const hit = list.find((r) => r.documentId === pageId);
    expect(hit).toBeTruthy();
    expect(hit!.name).toBe("Uses The Card");
    expect(hit!.fields).toContain("mainArea");
  });

  it("returns an empty list for a document nothing references", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Lonely Page" },
    });
    const lonelyId = created.json().documentId;
    const refs = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${lonelyId}/references`,
      headers: authHeaders(ed),
    });
    expect(refs.statusCode).toBe(200);
    expect(refs.json()).toEqual([]);
  });
});
