import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The reference index ("Used on") was rebuilt on save only. Removing a shared
 * block from a page's draft dropped the row; discarding that draft put the
 * live page back on the block, but the index kept saying nothing used it, and
 * the admin told the editor the block was "safe to change or delete".
 */
describe("discarding a draft puts its references back", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const usedOn = async () => {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${s.ids.cardId}/references`, headers: authHeaders(ed) });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as Array<{ documentId: string }>).map((r) => r.documentId);
  };

  it("lists the live page again after its block-removing draft is discarded", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "LandingPage", locale: "en", name: "Uses the card", data: { heading: "Uses the card", mainArea: [{ key: "c", blockType: "CardBlock", display: "automatic", ref: s.ids.cardId, inline: null }] } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const page = created.json().documentId as string;
    const pub = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${page}/publish?locale=en`, headers: authHeaders(ed) });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(await usedOn()).toContain(page);

    const removed = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${page}?locale=en`, headers: authHeaders(ed), payload: { merge: true, data: { mainArea: [] } } });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await usedOn()).not.toContain(page);

    const discarded = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${page}/discard-draft?locale=en`, headers: authHeaders(ed) });
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(await usedOn()).toContain(page);
  });
});
