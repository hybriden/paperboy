import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

describe("Re-parenting pages (move across the hierarchy)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let aId: string;
  let bId: string;
  let a1Id: string;

  async function makePage(parentId: string | null, name: string, slug: string) {
    const c = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "StandardPage", parentId, locale: "en", name } });
    const id = c.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { slug, data: { heading: name } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    return id;
  }
  const move = (id: string, body: object, who = admin) =>
    s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/move`, headers: authHeaders(who), payload: body });
  const byPath = (path: string) =>
    s.app.inject({ method: "GET", url: `/api/v1/delivery/content/by-path?path=${encodeURIComponent(path)}&locale=en`, headers: pub });

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    aId = await makePage(s.ids.homeId, "A", "a"); // /home/a
    bId = await makePage(s.ids.homeId, "B", "b"); // /home/b
    a1Id = await makePage(aId, "A1", "a1"); // /home/a/a1
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("moves a page under a different parent and the URL changes", async () => {
    expect((await byPath("/home/a/a1")).statusCode).toBe(200);
    const r = await move(a1Id, { parentId: bId });
    expect(r.statusCode).toBe(200);
    expect((await byPath("/home/b/a1")).statusCode).toBe(200);
    expect((await byPath("/home/a/a1")).statusCode).toBe(404);
    // Editor's computed path reflects it too.
    const detail = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${a1Id}?locale=en`, headers: { cookie: admin.cookie } });
    expect(detail.json().urlPath).toBe("/home/b/a1");
  });

  it("moves a page to top level (URL = /segment)", async () => {
    const r = await move(a1Id, { parentId: null });
    expect(r.statusCode).toBe(200);
    expect((await byPath("/a1")).statusCode).toBe(200);
    expect((await byPath("/home/b/a1")).statusCode).toBe(404);
  });

  it("rejects a cycle (moving a page under its own descendant) — 409", async () => {
    // Put A1 back under A, then try to move A under A1.
    await move(a1Id, { parentId: aId });
    const r = await move(aId, { parentId: a1Id });
    expect(r.statusCode).toBe(409);
  });

  it("rejects a non-page destination (block) — 400", async () => {
    const r = await move(bId, { parentId: s.ids.cardId });
    expect(r.statusCode).toBe(400);
  });

  it("rejects a URL-segment collision at the destination — 409", async () => {
    // A top-level page with slug "a"; moving it under Home collides with existing child A.
    const x = await makePage(null, "X", "a"); // top-level /a (ok)
    const r = await move(x, { parentId: s.ids.homeId });
    expect(r.statusCode).toBe(409);
  });

  it("enforces scope: an Author cannot move into another section or orphan to top level (403)", async () => {
    const author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    // A page inside the Author's own section (Author Zone).
    const owned = await makePage(s.ids.authorZoneId, "Author Child", "ac");
    // Into Home (a section the Author doesn't own) → 403.
    expect((await move(owned, { parentId: s.ids.homeId }, author)).statusCode).toBe(403);
    // To top level (would create a root section they don't own) → 403.
    expect((await move(owned, { parentId: null }, author)).statusCode).toBe(403);
  });
});
