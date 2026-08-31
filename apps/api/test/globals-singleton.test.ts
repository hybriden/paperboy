import { schemaTables } from "@paperboy/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A `kind: "global"` document is a per-site singleton: /delivery/globals/:type
 * serves the lowest id. createContent happily made a second SiteSettings, so
 * every edit to it succeeded — and delivered nothing. Refuse at create (409).
 */
describe("globals are per-site singletons", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("refuses a SECOND SiteSettings in the same site with a self-teaching 409", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "SiteSettings", locale: "en", name: "Second settings" },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain("SiteSettings");

    // The seeded one is still what delivery serves, untouched.
    const g = await s.app.inject({ method: "GET", url: "/api/v1/delivery/globals/SiteSettings?locale=en", headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    expect(g.statusCode).toBe(200);
  });

  it("still allows the first global of a type in a site (blocks and pages are unaffected)", async () => {
    // Another site has no SiteSettings yet → allowed there.
    const site = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { name: "Second brand", slug: "second-brand", defaultLocale: "en" } });
    expect(site.statusCode, site.body).toBe(200);
    const siteId = (site.json() as { id: string }).id;
    const first = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: { ...authHeaders(admin), "x-paperboy-site": siteId },
      payload: { type: "SiteSettings", locale: "en", name: "Second brand settings" },
    });
    expect(first.statusCode, first.body).toBe(200);

    const page = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "ArticlePage", locale: "en", name: "Another page" } });
    expect(page.statusCode).toBe(200);
  });

  // The singleton rule has three doors, not one: create, duplicate and restore
  // all bring a live global into a site, and all three must ask the same guard.
  const liveSiteSettingsId = async (): Promise<string> => {
    const { contentItem } = schemaTables;
    const rows = await s.app.db
      .select({ documentId: contentItem.documentId })
      .from(contentItem)
      .where(and(eq(contentItem.type, "SiteSettings"), eq(contentItem.siteId, "site_default"), isNull(contentItem.deletedAt)))
      .limit(1);
    return rows[0]!.documentId;
  };

  it("refuses to DUPLICATE a global — the copy would be a second singleton (409)", async () => {
    const id = await liveSiteSettingsId();
    const res = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/duplicate?locale=en`, headers: authHeaders(admin) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain("SiteSettings");
  });

  it("refuses to RESTORE a trashed global once a live one exists again (409 naming the live one)", async () => {
    const old = await liveSiteSettingsId();
    const trash = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${old}`, headers: authHeaders(admin) });
    expect(trash.statusCode, trash.body).toBe(200);
    const fresh = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "SiteSettings", locale: "en", name: "Fresh settings" } });
    expect(fresh.statusCode, fresh.body).toBe(200);
    const restore = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${old}/restore`, headers: authHeaders(admin) });
    expect(restore.statusCode, restore.body).toBe(409);
    expect(restore.json().message).toContain(fresh.json().documentId);
  });
});
