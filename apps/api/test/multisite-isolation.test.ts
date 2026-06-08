import {
  type AccessContext,
  createContent,
  createDb,
  createSite,
  getAccessContext,
  getTree,
  loadAuthorized,
  searchContent,
} from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * Multisite — Phase 2 (authz site-scoping). The #1 correctness risk: site_id must
 * be in EVERY management chokepoint, deny-by-default. A site-wide ADMIN acting in
 * site A must not see, load, search, or list site B's content via ANY path — and
 * two sites can each own a root "/about". Built red-first: without the site
 * predicates a siteWide admin sees all sites' content and these fail.
 */
describe("multisite phase 2 — authz isolation across sites", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let ctxA: AccessContext; // admin, active site = Default
  let ctxB: AccessContext; // admin, active site = B
  let bPageId: string;
  let aRootAboutId: string;

  beforeAll(async () => {
    s = await setupApi();
    const adminRows = (await raw.sql`SELECT id FROM users WHERE email = 'admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    const adminId = adminRows[0]!.id;

    ctxA = await getAccessContext(s.app.db, adminId); // Default site
    const siteB = await createSite(s.app.db, ctxA, { slug: "brand-b", name: "Brand B", defaultLocale: "en" });
    ctxB = await getAccessContext(s.app.db, adminId, siteB.id);

    // A page that lives only in site B. (parentId: null mirrors how the route/MCP
    // call createContent — an omitted parentId is normalized to null upstream.)
    const bPage = await createContent(s.app.db, ctxB, { type: "LandingPage", locale: "en", name: "B-only Secret Landing", parentId: null });
    bPageId = bPage.documentId;

    // A root "/about" in each site (same slug, different sites).
    const aAbout = await createContent(s.app.db, ctxA, { type: "LandingPage", locale: "en", name: "About", parentId: null });
    aRootAboutId = aAbout.documentId;
    await createContent(s.app.db, ctxB, { type: "LandingPage", locale: "en", name: "About", parentId: null });
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("getTree only returns the active site's roots", async () => {
    const treeA = await getTree(s.app.db, ctxA, null);
    const treeB = await getTree(s.app.db, ctxB, null);
    const idsA = treeA.map((n) => n.documentId);
    const idsB = treeB.map((n) => n.documentId);

    expect(idsA).toContain(s.ids.homeId); // A sees its own seeded roots
    expect(idsA).not.toContain(bPageId); // …never B's
    expect(idsB).toContain(bPageId); // B sees its own page
    expect(idsB).not.toContain(s.ids.homeId); // …never A's seeded Home
  });

  it("loadAuthorized denies a cross-site documentId (reported as not-found, even for a site-wide admin)", async () => {
    // ctxA is a site-wide admin, yet B's page is invisible to it.
    await expect(loadAuthorized(s.app.db, ctxA, bPageId)).rejects.toThrow();
    // From its own site it loads fine.
    const item = await loadAuthorized(s.app.db, ctxB, bPageId);
    expect(item.documentId).toBe(bPageId);
    expect(item.siteId).toBe(ctxB.siteId);
  });

  it("search is confined to the active site", async () => {
    expect(await searchContent(s.app.db, ctxA, "B-only Secret")).toHaveLength(0);
    const hitsB = await searchContent(s.app.db, ctxB, "B-only Secret");
    expect(hitsB.map((h) => h.documentId)).toContain(bPageId);
  });

  it("a root slug '/about' is independent per site (no cross-site collision)", async () => {
    // Both sites successfully created an "About" root; assert each kept the
    // clean "about" slug rather than one being uniquified into "about-2".
    const slugs = (await raw.sql`
      SELECT ci.site_id, cv.slug
      FROM content_item ci JOIN content_version cv ON cv.document_id = ci.document_id
      WHERE cv.name = 'About' AND cv.locale = 'en'
      ORDER BY ci.site_id
    `) as Array<{ site_id: string; slug: string }>;
    expect(slugs).toHaveLength(2);
    expect(slugs.every((r) => r.slug === "about")).toBe(true);
    expect(new Set(slugs.map((r) => r.site_id)).size).toBe(2);
    // sanity: the A "about" is the one we made in ctxA
    expect(slugs.some((r) => r.site_id === ctxA.siteId)).toBe(true);
    expect(aRootAboutId).toBeTruthy();
  });
});
