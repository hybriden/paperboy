import { createHash } from "node:crypto";
import {
  type AccessContext,
  createContent,
  createDb,
  createSite,
  deliveryGetById,
  getAccessContext,
  publishContent,
  updateContent,
  verifyDeliveryKey,
} from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, setupApi } from "./helpers.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const B_KEY = "pk_live_site_b_public";

/**
 * Multisite — Phase 4 (delivery site-scoping, D1 per-site keys). The PUBLIC
 * no-leak boundary across sites: a delivery key pins its site, and EVERY delivery
 * read (by-id, by-path, list, search, global, start, and the whole reference
 * graph) is confined to it. Site A's key must never return site B's content.
 */
describe("multisite phase 4 — delivery isolation by per-site key", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let ctxB: AccessContext;
  let bSiteId: string;
  let bPageId: string;

  beforeAll(async () => {
    s = await setupApi();
    const adminRows = (await raw.sql`SELECT id FROM users WHERE email = 'admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    const adminId = adminRows[0]!.id;
    const ctxA = await getAccessContext(s.app.db, adminId);
    const siteB = await createSite(s.app.db, ctxA, { slug: "brand-b", name: "Brand B", defaultLocale: "en" });
    bSiteId = siteB.id;
    ctxB = await getAccessContext(s.app.db, adminId, siteB.id);

    // A PUBLISHED page in site B.
    const bPage = await createContent(s.app.db, ctxB, { type: "LandingPage", locale: "en", name: "Brand B Home", parentId: null });
    bPageId = bPage.documentId;
    await updateContent(s.app.db, ctxB, bPageId, "en", { data: { heading: "Brand B Home" } });
    await publishContent(s.app.db, ctxB, bPageId, "en");

    // A public delivery key bound to site B (no per-site key route yet — Phase 5).
    await raw.sql`
      INSERT INTO delivery_key (name, key_hash, key_prefix, type, site_id)
      VALUES ('Brand B public', ${sha256(B_KEY)}, 'pk_live_', 'public', ${bSiteId})
    `;
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("verifyDeliveryKey resolves each key to its own site", async () => {
    const a = await verifyDeliveryKey(s.app.db, PUBLIC_KEY);
    const b = await verifyDeliveryKey(s.app.db, B_KEY);
    expect(a).toEqual({ type: "public", siteId: "site_default" });
    expect(b).toEqual({ type: "public", siteId: bSiteId });
  });

  it("deliveryGetById is confined to the requested site (function level)", async () => {
    // B's page: visible to B's site, invisible to the Default site.
    expect(await deliveryGetById(s.app.db, "published", bSiteId, bPageId, "en")).not.toBeNull();
    expect(await deliveryGetById(s.app.db, "published", "site_default", bPageId, "en")).toBeNull();
    // Default's Home: visible to Default, invisible to B.
    expect(await deliveryGetById(s.app.db, "published", "site_default", s.ids.homeId, "en")).not.toBeNull();
    expect(await deliveryGetById(s.app.db, "published", bSiteId, s.ids.homeId, "en")).toBeNull();
  });

  const get = (documentId: string, key: string) =>
    s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${documentId}?locale=en`, headers: { authorization: `Bearer ${key}` } });

  it("the HTTP delivery route never crosses sites (per-site key)", async () => {
    // B's key: sees B's page (200), never the Default Home (404).
    expect((await get(bPageId, B_KEY)).statusCode).toBe(200);
    expect((await get(s.ids.homeId, B_KEY)).statusCode).toBe(404);
    // Default key: sees Default Home (200), never B's page (404).
    expect((await get(s.ids.homeId, PUBLIC_KEY)).statusCode).toBe(200);
    expect((await get(bPageId, PUBLIC_KEY)).statusCode).toBe(404);
  });

  it("delivery list/search via the route stays within the key's site", async () => {
    const listB = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=LandingPage&locale=en", headers: { authorization: `Bearer ${B_KEY}` } });
    expect(listB.statusCode).toBe(200);
    const idsB = (listB.json().items as Array<{ documentId: string }>).map((i) => i.documentId);
    expect(idsB).toContain(bPageId);
    expect(idsB).not.toContain(s.ids.homeId); // a Default LandingPage never appears under B's key

    const listA = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=LandingPage&locale=en", headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    const idsA = (listA.json().items as Array<{ documentId: string }>).map((i) => i.documentId);
    expect(idsA).toContain(s.ids.homeId);
    expect(idsA).not.toContain(bPageId);
  });
});
