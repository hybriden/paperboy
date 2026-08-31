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

  it("usage counts current versions only, but delete also guards version history (a restore must not resurrect a deleted type)", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    for (const def of [
      { name: "HistBlock", displayName: "Hist block", kind: "block", fields: [{ name: "t", displayName: "T", type: "text" }] },
      { name: "HistPage", displayName: "Hist page", kind: "page", fields: [{ name: "body", displayName: "Body", type: "contentArea" }] },
    ]) {
      const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def });
      expect(created.statusCode, created.body).toBe(200);
    }
    const page = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "HistPage", locale: "en", name: "Hist", data: { body: [{ key: "b1", blockType: "HistBlock", inline: { t: "old" } }] } },
    });
    expect(page.statusCode, page.body).toBe(200);
    const id = page.json().documentId as string;
    const publish = () => s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    expect((await publish()).statusCode).toBe(200);
    // v2 drops the block; v1 (which embeds it) becomes history.
    const emptied = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { body: [] } } });
    expect(emptied.statusCode, emptied.body).toBe(200);
    expect((await publish()).statusCode).toBe(200);

    const usage = (await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types-usage", headers: authHeaders(admin) })).json() as Record<string, { inlineIn: number }>;
    expect(usage.HistBlock?.inlineIn ?? 0).toBe(0);
    const del = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/content-types/HistBlock", headers: authHeaders(admin) });
    expect(del.statusCode, del.body).toBe(409);
    expect(del.json().message).toMatch(/in use/i);
  });

  it("an editor (no contenttype.manage) cannot delete", async () => {
    const res = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/content-types/CardBlock", headers: authHeaders(ed) });
    expect(res.statusCode).toBe(403);
  });
});
