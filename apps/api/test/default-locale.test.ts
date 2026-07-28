import { createDb, resolveDefaultLocale } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The request locale must come from CONFIGURATION, not a hardcoded "en".
 *
 * Every route used to spell the fallback as `req.query.locale ?? "en"` (27 places
 * across manage.ts, delivery.ts and the MCP delivery tools), which made "en" an
 * unconfigurable pivot: `getDefaultLocale()` was dead code with zero callers, and
 * `site.defaultLocale` was collected by the create-site wizard, validated, stored…
 * and read by nothing.
 *
 * For a Norwegian customer (this product's own reference deploy is Norwegian) that
 * meant every locale-less request resolved to `en`, `getContent` returned a blank
 * non-persisted scaffold for every page, the editor offered to translate FROM the
 * real content, and the first save materialised an orphan `en` version. A frontend
 * calling /delivery/start-page with no ?locale= got nothing.
 */
describe("resolveDefaultLocale", () => {
  const raw = createDb(TEST_DB);
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("uses the SITE's own defaultLocale in preference to the global default", async () => {
    // Seeded state: global default locale is `en`, Default site's defaultLocale `en`.
    expect(await resolveDefaultLocale(raw.db, "site_default")).toBe("en");

    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(admin),
      payload: { slug: "brand-nb", name: "Brand NB", defaultLocale: "nb" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const nbSiteId = created.json().id as string;

    // THIS is the whole point: a site configured for nb resolves to nb, not "en".
    expect(await resolveDefaultLocale(raw.db, nbSiteId)).toBe("nb");
  });

  it("falls back to the globally default locale when no site is given", async () => {
    expect(await resolveDefaultLocale(raw.db)).toBe("en");
  });

  it("falls back to the global default for an unknown site id (never throws)", async () => {
    expect(await resolveDefaultLocale(raw.db, "site_does_not_exist")).toBe("en");
  });

  it("a management read with NO ?locale= uses the active site's default locale", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(admin),
      payload: { slug: "brand-nb2", name: "Brand NB2", defaultLocale: "nb" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const siteId = created.json().id as string;
    const siteHeaders = { ...authHeaders(admin), "x-paperboy-site": siteId };

    // Create a page IN nb (explicit), then read it back with no ?locale= at all.
    const page = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: siteHeaders,
      payload: { type: "ArticlePage", parentId: null, locale: "nb", name: "Norsk side" },
    });
    expect(page.statusCode, page.body).toBe(200);
    const documentId = page.json().documentId as string;

    const read = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${documentId}`, // no ?locale=
      headers: siteHeaders,
    });
    expect(read.statusCode, read.body).toBe(200);
    // Before the fix this returned a blank `en` scaffold instead of the nb content.
    expect(read.json().locale).toBe("nb");
    expect(read.json().name).toBe("Norsk side");
  });

  it("a delivery read with NO ?locale= still resolves (Default site → en)", async () => {
    const r = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}`, // no ?locale=
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().locale).toBe("en");
  });
});
