import { createDb, deliveryStartPage, publishContent, updateContent, verifyDeliveryKey, getAccessContext } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Per-site setup (Settings → Site): preview URL, start page and delivery keys
 * must each be per-site. Built red-first: while these live in the global
 * site_setting table, setting site B's preview URL clobbers site A's, and keys
 * aren't site-scoped — these assertions fail until they move onto the site.
 */
describe("multisite — per-site settings (preview url, start page, keys)", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let admin: Awaited<ReturnType<typeof login>>;
  let bId: string;

  const hdr = (ctx: Awaited<ReturnType<typeof login>>, site?: string) =>
    site ? { ...authHeaders(ctx), "x-paperboy-site": site } : authHeaders(ctx);

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-b", name: "Brand B", defaultLocale: "en" } });
    bId = created.json().id as string;
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  const setPreview = (url: string, site?: string) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/site/preview-url", headers: hdr(admin, site), payload: { url } });
  const getSite = (site?: string) => s.app.inject({ method: "GET", url: "/api/v1/manage/site", headers: hdr(admin, site) });

  it("preview URL is per-site (setting B does not clobber A)", async () => {
    expect((await setPreview("https://a.example")).statusCode).toBe(200); // Default site
    expect((await setPreview("https://b.example", bId)).statusCode).toBe(200); // Brand B
    expect((await getSite()).json().previewBaseUrl).toBe("https://a.example");
    expect((await getSite(bId)).json().previewBaseUrl).toBe("https://b.example");
  });

  it("start page is per-site, and delivery's /start resolves the requesting site's page", async () => {
    // A page in B, published, set as B's start page.
    const adminRows = (await raw.sql`SELECT id FROM users WHERE email='admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    const ctxB = await getAccessContext(s.app.db, adminRows[0]!.id, bId);
    const bPage = (await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: hdr(admin, bId), payload: { type: "LandingPage", locale: "en", name: "B Home" } })).json().documentId as string;
    await updateContent(s.app.db, ctxB, bPage, "en", { data: { heading: "B Home" } });
    await publishContent(s.app.db, ctxB, bPage, "en");
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/site/start-page", headers: hdr(admin, bId), payload: { documentId: bPage } })).statusCode).toBe(200);

    // B's /start resolves B's page; the Default site's /start is unchanged (Home).
    const startB = await deliveryStartPage(s.app.db, "published", bId, "en");
    expect(startB?.documentId).toBe(bPage);
    const startDefault = await deliveryStartPage(s.app.db, "published", "site_default", "en");
    expect(startDefault?.documentId).toBe(s.ids.homeId);
  });

  it("delivery keys are minted for and listed by the active site", async () => {
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/delivery-keys", headers: hdr(admin, bId), payload: { name: "B public", type: "public" } });
    expect(minted.statusCode, minted.body).toBe(200);
    const key = minted.json().key as string;
    expect(await verifyDeliveryKey(s.app.db, key)).toEqual({ type: "public", siteId: bId });

    // The active site's key list shows B's key, not the Default site's seeded keys.
    const listB = (await s.app.inject({ method: "GET", url: "/api/v1/manage/delivery-keys", headers: hdr(admin, bId) })).json() as Array<{ name: string }>;
    expect(listB.map((k) => k.name)).toContain("B public");
    expect(listB.map((k) => k.name)).not.toContain("Default public key");
  });
});
