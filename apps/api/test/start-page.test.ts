import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("Start page (served at /)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let viewer: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("seeds Home as the default start page; delivery /start serves it publicly", async () => {
    const cfg = await s.app.inject({ method: "GET", url: "/api/v1/manage/site", headers: authHeaders(ed) });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json().startPageId).toBe(s.ids.homeId);

    const start = await s.app.inject({ method: "GET", url: "/api/v1/delivery/start?locale=en", headers: pub });
    expect(start.statusCode).toBe(200);
    expect(start.json().documentId).toBe(s.ids.homeId);
    expect(start.json().name).toBe("Home");
  });

  it("an editor can change the start page; /start then serves the new page", async () => {
    // New published page.
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", name: "Landing" } });
    const id = created.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { name: "Landing", slug: "landing", data: { heading: "Landing" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });

    const set = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/start-page", headers: authHeaders(ed), payload: { documentId: id } });
    expect(set.statusCode).toBe(200);

    const start = await s.app.inject({ method: "GET", url: "/api/v1/delivery/start?locale=en", headers: pub });
    expect(start.json().documentId).toBe(id);
  });

  it("an unpublished start page is NOT served publicly but IS under preview (no-leak)", async () => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", name: "DraftStart" } });
    const id = created.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { name: "DraftStart", slug: "draftstart", data: { heading: "Draft start" } } });
    await s.app.inject({ method: "POST", url: "/api/v1/manage/site/start-page", headers: authHeaders(ed), payload: { documentId: id } });

    expect((await s.app.inject({ method: "GET", url: "/api/v1/delivery/start?locale=en", headers: pub })).statusCode).toBe(404);
    const preview = await s.app.inject({ method: "GET", url: "/api/v1/delivery/start?locale=en", headers: prev });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().documentId).toBe(id);
  });

  it("requires publish rights and a real page", async () => {
    // Viewer lacks content.publish.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/site/start-page", headers: authHeaders(viewer), payload: { documentId: s.ids.homeId } })).statusCode).toBe(403);
    // Missing CSRF.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/site/start-page", headers: { cookie: ed.cookie, origin: "http://localhost:8090" }, payload: { documentId: s.ids.homeId } })).statusCode).toBe(403);
    // Non-existent page.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/site/start-page", headers: authHeaders(ed), payload: { documentId: "doesnotexist000000000000" } })).statusCode).toBe(404);
    // A block cannot be the start page.
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/site/start-page", headers: authHeaders(ed), payload: { documentId: s.ids.cardId } })).statusCode).toBe(400);
  });
});
