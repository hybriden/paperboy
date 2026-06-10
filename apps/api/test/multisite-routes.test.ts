import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Multisite — Phase 3 (management API + active-site switching). The /manage/sites
 * endpoints and the x-paperboy-site header that selects the active site, which
 * then partitions every management read/write for that request.
 */
describe("multisite phase 3 — site routes + active-site header", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let ed: Awaited<ReturnType<typeof login>>;
  const raw = createDb(TEST_DB);

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("GET /manage/sites lists the Default site and reports it active by default", async () => {
    const r = await s.app.inject({ method: "GET", url: "/api/v1/manage/sites", headers: authHeaders(ed) });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.activeSiteId).toBe("site_default");
    expect(body.sites.map((x: { slug: string }) => x.slug)).toContain("default");
  });

  it("POST /manage/sites creates a site (admin only); a non-admin is forbidden", async () => {
    // Editor lacks user.manage.
    const forbidden = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(ed),
      payload: { slug: "brand-x", name: "Brand X", defaultLocale: "en" },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(admin),
      payload: { slug: "brand-c", name: "Brand C", defaultLocale: "en" },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ slug: "brand-c", name: "Brand C", defaultLocale: "en", active: true });
  });

  it("the x-paperboy-site header selects the active site, partitioning new content", async () => {
    const brandC = (await s.app.inject({ method: "GET", url: "/api/v1/manage/sites", headers: authHeaders(admin) }))
      .json()
      .sites.find((x: { slug: string }) => x.slug === "brand-c");
    expect(brandC).toBeTruthy();

    // With the header, /manage/sites reports brand-c active.
    const withHeader = await s.app.inject({
      method: "GET",
      url: "/api/v1/manage/sites",
      headers: { ...authHeaders(admin), "x-paperboy-site": brandC.id },
    });
    expect(withHeader.json().activeSiteId).toBe(brandC.id);

    // Content created with the header lands in brand-c.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: { ...authHeaders(admin), "x-paperboy-site": brandC.id },
      payload: { type: "LandingPage", locale: "en", name: "C Root" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const docId = created.json().documentId as string;
    const rows = (await raw.sql`SELECT site_id FROM content_item WHERE document_id = ${docId} LIMIT 1`) as Array<{ site_id: string }>;
    expect(rows[0]?.site_id).toBe(brandC.id);

    // …and the Default-site tree never shows it (the admin's default request).
    const treeDefault = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: authHeaders(admin) });
    if (treeDefault.statusCode === 200) {
      const ids = JSON.stringify(treeDefault.json());
      expect(ids).not.toContain(docId);
    }
  });

  it("PATCH /manage/sites/:id renames a site (admin only); slug stays unique", async () => {
    const created = (await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-r", name: "Brand R", defaultLocale: "en" } })).json();

    // Editor (no user.manage) is forbidden.
    const forbidden = await s.app.inject({ method: "PATCH", url: `/api/v1/manage/sites/${created.id}`, headers: authHeaders(ed), payload: { name: "Hacked" } });
    expect(forbidden.statusCode).toBe(403);

    // Rename name + slug.
    const renamed = await s.app.inject({ method: "PATCH", url: `/api/v1/manage/sites/${created.id}`, headers: authHeaders(admin), payload: { name: "Brand Renamed", slug: "brand-renamed" } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ id: created.id, name: "Brand Renamed", slug: "brand-renamed" });

    // Slug collision with an existing site is rejected.
    const clash = await s.app.inject({ method: "PATCH", url: `/api/v1/manage/sites/${created.id}`, headers: authHeaders(admin), payload: { slug: "default" } });
    expect(clash.statusCode).toBe(409);
  });

  it("DELETE /manage/sites/:id deletes a site and everything bound to it (admin only, confirm required)", async () => {
    const created = (
      await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-del", name: "Brand Del", defaultLocale: "en" } })
    ).json();
    const siteHeaders = { ...authHeaders(admin), "x-paperboy-site": created.id };

    // Populate the site so the cascade is actually exercised: content + a delivery key.
    const page = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: siteHeaders, payload: { type: "LandingPage", locale: "en", name: "Del Root" } });
    expect(page.statusCode, page.body).toBe(200);
    const docId = page.json().documentId as string;
    const key = await s.app.inject({ method: "POST", url: "/api/v1/manage/delivery-keys", headers: siteHeaders, payload: { name: "del-key", type: "public" } });
    expect(key.statusCode, key.body).toBe(200);

    // Editor (no user.manage) is forbidden.
    const forbidden = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/sites/${created.id}?confirm=brand-del`, headers: authHeaders(ed) });
    expect(forbidden.statusCode).toBe(403);

    // Missing or wrong confirm is rejected with a self-teaching error naming the expected slug.
    const noConfirm = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/sites/${created.id}`, headers: authHeaders(admin) });
    expect(noConfirm.statusCode).toBe(400);
    const wrongConfirm = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/sites/${created.id}?confirm=nope`, headers: authHeaders(admin) });
    expect(wrongConfirm.statusCode).toBe(400);
    expect(wrongConfirm.body).toContain("brand-del");

    // Correct confirm deletes the site and cascades.
    const deleted = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/sites/${created.id}?confirm=brand-del`, headers: authHeaders(admin) });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().ok).toBe(true);

    const sites = (await s.app.inject({ method: "GET", url: "/api/v1/manage/sites", headers: authHeaders(admin) })).json();
    expect(sites.sites.map((x: { id: string }) => x.id)).not.toContain(created.id);
    const items = (await raw.sql`SELECT 1 FROM content_item WHERE site_id = ${created.id}`) as unknown[];
    expect(items.length).toBe(0);
    const versions = (await raw.sql`SELECT 1 FROM content_version WHERE document_id = ${docId}`) as unknown[];
    expect(versions.length).toBe(0);
    const keys = (await raw.sql`SELECT 1 FROM delivery_key WHERE site_id = ${created.id}`) as unknown[];
    expect(keys.length).toBe(0);
    const auditRows = (await raw.sql`SELECT detail FROM audit_log WHERE action = 'site.delete'`) as Array<{ detail: { id: string } }>;
    expect(auditRows.some((a) => a.detail.id === created.id)).toBe(true);
  });

  it("DELETE /manage/sites/:id refuses to delete the Default site", async () => {
    const r = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/sites/site_default?confirm=default", headers: authHeaders(admin) });
    expect(r.statusCode).toBe(400);
  });

  it("an unknown x-paperboy-site header falls back to the Default site (never 500)", async () => {
    const r = await s.app.inject({
      method: "GET",
      url: "/api/v1/manage/sites",
      headers: { ...authHeaders(admin), "x-paperboy-site": "site_does_not_exist" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().activeSiteId).toBe("site_default");
  });
});
