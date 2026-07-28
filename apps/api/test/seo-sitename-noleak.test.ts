import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A `delivery:"private"` field must not reach the SEO block.
 *
 * `DeliveryCtx.siteName` read `siteName` straight off the raw SiteSettings row,
 * bypassing the field-exposure gate. So marking `siteName` private correctly removed
 * it from `/delivery/globals/SiteSettings` — while every PAGE still carried it as
 * `seo.og.siteName`, and apps/web renders that directly into
 * `<meta property="og:site_name">`.
 *
 * That contradicts the documented contract ("computed post-sanitize, so a private
 * role-tagged field can never leak") and delivery.ts's own fail-closed header. It is
 * the one place in the SEO path that skipped `sanitize`.
 */
describe("seo.og.siteName respects field-level delivery exposure", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** Flip SiteSettings.siteName's delivery flag on the content type. */
  async function setSiteNameDelivery(delivery: "public" | "private"): Promise<void> {
    const got = await s.app.inject({
      method: "GET",
      url: "/api/v1/manage/content-types/SiteSettings",
      headers: authHeaders(admin),
    });
    expect(got.statusCode, got.body).toBe(200);
    const def = got.json() as { fields: { name: string; delivery: string }[] };
    for (const f of def.fields) if (f.name === "siteName") f.delivery = delivery;
    const put = await s.app.inject({
      method: "PUT",
      url: "/api/v1/manage/content-types/SiteSettings",
      headers: authHeaders(admin),
      payload: def,
    });
    expect(put.statusCode, put.body).toBe(200);
  }

  const homeSeo = async (): Promise<{ og: { siteName: string | null } }> => {
    const r = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`,
      headers: pub,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().seo as { og: { siteName: string | null } };
  };

  it("a PUBLIC siteName is delivered in seo.og.siteName (baseline)", async () => {
    await setSiteNameDelivery("public");
    expect(await homeSeo().then((seo) => seo.og.siteName)).toBe("Paperboy");
  });

  it("a PRIVATE siteName is absent from the globals payload", async () => {
    await setSiteNameDelivery("private");
    const g = await s.app.inject({ method: "GET", url: "/api/v1/delivery/globals/SiteSettings?locale=en", headers: pub });
    expect(g.statusCode, g.body).toBe(200);
    expect((g.json().data as Record<string, unknown>).siteName).toBeUndefined();
  });

  it("…and must ALSO be absent from every page's seo block", async () => {
    await setSiteNameDelivery("private");
    const seo = await homeSeo();
    expect(seo.og.siteName, "a private field leaked into the SEO block").toBeNull();
  });

  it("restoring it to public brings it back (the gate is the flag, not a cache)", async () => {
    await setSiteNameDelivery("private");
    expect((await homeSeo()).og.siteName).toBeNull();
    await setSiteNameDelivery("public");
    expect((await homeSeo()).og.siteName).toBe("Paperboy");
  });
});
