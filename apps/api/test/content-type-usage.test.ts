import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/** Content-type usage counts: standalone items + inline block embedding. */
describe("content-type usage", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("reports standalone instances and inline block usage", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types-usage", headers: authHeaders(ed) });
    expect(res.statusCode).toBe(200);
    const u = res.json() as Record<string, { items: number; inlineIn: number }>;

    // The seed has a LandingPage (Home) and BlogPosts — standalone items.
    expect(u.LandingPage?.items ?? 0).toBeGreaterThanOrEqual(1);
    expect(u.BlogPost?.items ?? 0).toBeGreaterThanOrEqual(2);
    // Home embeds HeroBlock + CardBlock + ListBlock inline in its mainArea.
    expect(u.HeroBlock?.inlineIn ?? 0).toBeGreaterThanOrEqual(1);
    expect(u.ListBlock?.inlineIn ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("requires authentication", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types-usage" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses to delete a type that is in use, but deletes an unused one", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // BlogPost has items → delete must be refused (409).
    const inUse = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/content-types/BlogPost", headers: authHeaders(admin) });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().message).toMatch(/in use/i);

    // A fresh, unused type → deletes cleanly.
    await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content-types",
      headers: authHeaders(admin),
      payload: { name: "ScratchType", displayName: "Scratch", kind: "block", description: "", icon: "box", fields: [] },
    });
    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/content-types/ScratchType", headers: authHeaders(admin) });
    expect(del.statusCode).toBe(200);
    const after = await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types/ScratchType", headers: authHeaders(admin) });
    expect(after.statusCode).toBe(404);
  });

  it("an editor (no contenttype.manage) cannot delete", async () => {
    const res = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/content-types/CardBlock", headers: authHeaders(ed) });
    expect(res.statusCode).toBe(403);
  });
});
