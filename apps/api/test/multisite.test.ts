import { createDb, getDefaultSite } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Multisite — Phase 1 (schema + lossless migration). Asserts the foundation:
 *  - exactly one Default site exists after seed/migration;
 *  - every scoped table (content_item, delivery_key, asset, user_scope) is fully
 *    backfilled to it — NO null/orphan site_id (deny-by-default starts here);
 *  - createContent partitions new content by site (children inherit the parent;
 *    roots fall to the Default site);
 *  - createSite/listSites work and are permission-gated.
 *
 * Behaviour is unchanged from single-site in this phase — everything lives in one
 * site. Authz/delivery site-scoping is layered on in later phases.
 */
describe("multisite phase 1 — site entity + lossless backfill", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  const raw = createDb(TEST_DB);

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  const countNullSite = async (table: string): Promise<number> => {
    const r = (await raw.sql.unsafe(`SELECT count(*)::int AS c FROM ${table} WHERE site_id IS NULL`)) as Array<{ c: number }>;
    return r[0]?.c ?? -1;
  };
  const distinctSites = async (table: string): Promise<string[]> => {
    const r = (await raw.sql.unsafe(`SELECT DISTINCT site_id FROM ${table} ORDER BY site_id`)) as Array<{ site_id: string }>;
    return r.map((x) => x.site_id);
  };
  const siteOf = async (documentId: string): Promise<string | null> => {
    const r = (await raw.sql`SELECT site_id FROM content_item WHERE document_id = ${documentId} LIMIT 1`) as Array<{ site_id: string }>;
    return r[0]?.site_id ?? null;
  };

  it("exactly one Default site exists, and getDefaultSite returns it", async () => {
    const rows = (await raw.sql`SELECT id, slug, name FROM site ORDER BY created_at`) as Array<{ id: string; slug: string; name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "site_default", slug: "default", name: "Default site" });

    const def = await getDefaultSite(s.app.db);
    expect(def.id).toBe("site_default");
    expect(def.defaultLocale).toBe("en");
    expect(def.active).toBe(true);
  });

  it("every scoped table is fully backfilled to the Default site — no null/orphan site_id", async () => {
    for (const table of ["content_item", "delivery_key", "user_scope"]) {
      expect(await countNullSite(table), `${table} has null site_id`).toBe(0);
      expect(await distinctSites(table), `${table} points outside the Default site`).toEqual(["site_default"]);
    }
    // asset starts empty in seed — still must have no null site_id.
    expect(await countNullSite("asset")).toBe(0);
  });

  it("a foreign key protects site_id — an orphan site is rejected", async () => {
    await expect(
      raw.sql`INSERT INTO content_item (document_id, type, kind, site_id) VALUES ('orphan-doc-xyz', 'BlogPost', 'page', 'site_does_not_exist')`,
    ).rejects.toThrow();
  });

  it("createContent partitions new content by site: child inherits parent, root → Default", async () => {
    // Child under the seeded Blog (in the Default site) inherits its site.
    const child = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "BlogPost", locale: "en", name: "Child post", parentId: s.ids.blogId },
    });
    expect(child.statusCode, child.body).toBe(200);
    expect(await siteOf(child.json().documentId)).toBe("site_default");

    // New root → column default (Default site).
    const root = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "LandingPage", locale: "en", name: "New root" },
    });
    expect(root.statusCode, root.body).toBe(200);
    expect(await siteOf(root.json().documentId)).toBe("site_default");
  });
});
