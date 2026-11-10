import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * "Publish now, with an expiry" (MCP publish_content {expireAt}, or /schedule
 * with a publishAt that is now) promoted the draft without URL tracking: a
 * page whose draft changed its slug went live at the new URL and left no
 * automatic 301, so the old URL just died.
 */
describe("publishing now with an expiry records the URL change", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("leaves a 301 from the old URL", async () => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "ArticlePage", locale: "en", name: "Expiring offer", slug: "offer-old", data: { heading: "Offer" } } });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().documentId as string;
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) })).statusCode).toBe(200);
    const renamed = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { merge: true, slug: "offer-new", data: {} } });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const scheduled = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/schedule?locale=en`,
      headers: authHeaders(admin),
      payload: { publishAt: new Date().toISOString(), expireAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json().urlPath).toBe("/offer-new");

    const rules = (await s.app.inject({ method: "GET", url: "/api/v1/manage/redirects", headers: { cookie: admin.cookie } })).json() as Array<{ sourcePath: string; origin: string; target: { documentId?: string } }>;
    expect(rules).toContainEqual(expect.objectContaining({ sourcePath: "/en/offer-old", origin: "auto", target: expect.objectContaining({ documentId: id }) }));
  });
});
