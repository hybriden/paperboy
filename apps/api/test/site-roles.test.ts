import { audit, createDb, getAccessContext, sitesForConsent } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthCtx, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Per-site roles (#130): a role held in ONE site (user_role.site_id) grants that
 * role's site verbs there and nothing anywhere else; a role with no site (every
 * role written before migration 0032) works exactly as before.
 */
describe("per-site roles", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let admin: AuthCtx;
  let siteAdmin: AuthCtx;
  let bId: string;
  let siteAdminId: string;
  const PW = "SiteAdmin!Passw0rd";

  const as = (ctx: AuthCtx, site?: string) => (site ? { ...authHeaders(ctx), "x-paperboy-site": site } : authHeaders(ctx));
  const userId = async (email: string) => ((await raw.sql`SELECT id FROM users WHERE email=${email}`) as Array<{ id: string }>)[0]!.id;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    bId = (await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: as(admin), payload: { slug: "brand-b", name: "Brand B", defaultLocale: "en" } })).json().id as string;
    const made = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/users",
      headers: as(admin),
      payload: { email: "b-admin@paperboy.test", name: "B Admin", password: PW, roles: [], siteRoles: [{ siteId: bId, role: "Admin" }] },
    });
    expect(made.statusCode, made.body).toBe(200);
    siteAdminId = made.json().id as string;
    siteAdmin = await login(s.app, "b-admin@paperboy.test", PW);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("existing roles are every-site roles: the upgrade changes nobody's access", async () => {
    const rows = (await raw.sql`SELECT site_id FROM user_role WHERE user_id <> ${siteAdminId}`) as Array<{ site_id: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.site_id === null)).toBe(true);
    const id = await userId("admin@paperboy.test");
    for (const site of ["site_default", bId]) {
      const ctx = await getAccessContext(s.app.db, id, site);
      expect(ctx.permissions).toEqual(expect.arrayContaining(["user.manage", "contenttype.manage", "site.manage", "siteuser.manage"]));
      expect(ctx.siteWide).toBe(true);
    }
  });

  it("a one-site Admin lands in their site and sees only it", async () => {
    const res = (await s.app.inject({ method: "GET", url: "/api/v1/manage/sites", headers: as(siteAdmin) })).json() as { sites: Array<{ id: string }>; activeSiteId: string };
    expect(res.sites.map((x) => x.id)).toEqual([bId]);
    expect(res.activeSiteId).toBe(bId);
    // Asking for another site falls back to their own, never opens it.
    const asked = (await s.app.inject({ method: "GET", url: "/api/v1/manage/sites", headers: as(siteAdmin, "site_default") })).json() as { activeSiteId: string };
    expect(asked.activeSiteId).toBe(bId);
    const me = (await s.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: as(siteAdmin) })).json() as { user: { roles: string[]; permissions: string[] } };
    expect(me.user.roles).toEqual(["Admin"]);
    expect(me.user.permissions).toContain("siteuser.manage");
    expect(me.user.permissions).not.toContain("user.manage");
  });

  it("holds nothing in another site (what MCP and every per-site call resolve)", async () => {
    const other = await getAccessContext(s.app.db, siteAdminId, "site_default");
    expect(other.permissions).toEqual([]);
    expect(other.readSiteWide).toBe(false);
    const own = await getAccessContext(s.app.db, siteAdminId, bId);
    expect(own.siteWide).toBe(true);
    expect(own.permissions).toEqual(expect.arrayContaining(["content.publish", "deliverykey.manage", "webhook.manage", "site.manage", "audit.read"]));
  });

  it("can't touch what every site shares", async () => {
    const h = as(siteAdmin);
    const tries = [
      s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: h, payload: { slug: "brand-c", name: "C", defaultLocale: "en" } }),
      s.app.inject({ method: "DELETE", url: `/api/v1/manage/sites/${bId}?confirm=brand-b`, headers: h }),
      s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai", headers: h }),
      s.app.inject({ method: "GET", url: "/api/v1/manage/mcp-tokens", headers: h }),
      s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: h, payload: { name: "x" } }),
      s.app.inject({ method: "POST", url: "/api/v1/manage/locales", headers: h, payload: { code: "xx", displayName: "Sneaky" } }),
      s.app.inject({ method: "DELETE", url: `/api/v1/manage/users/${await userId("editor@paperboy.test")}`, headers: h }),
    ];
    for (const r of await Promise.all(tries)) expect(r.statusCode, r.body).toBe(403);
  });

  it("adds users to their own site only, and never gives out an every-site role", async () => {
    const h = as(siteAdmin);
    const fresh = await s.app.inject({ method: "POST", url: "/api/v1/manage/users", headers: h, payload: { email: "b-editor@paperboy.test", name: "B Editor", password: "BEditor!Passw0rd", roles: ["Editor"] } });
    expect(fresh.statusCode, fresh.body).toBe(200);
    const rows = (await raw.sql`SELECT role, site_id FROM user_role WHERE user_id=${fresh.json().id as string}`) as Array<{ role: string; site_id: string | null }>;
    expect(rows).toEqual([{ role: "Editor", site_id: bId }]);

    // An existing account is ADDED to this site (no password), its account untouched.
    const viewerId = await userId("viewer@paperboy.test");
    const added = await s.app.inject({ method: "POST", url: "/api/v1/manage/users", headers: h, payload: { email: "viewer@paperboy.test", name: "ignored", roles: ["Author"] } });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().id).toBe(viewerId);
    const withPw = await s.app.inject({ method: "POST", url: "/api/v1/manage/users", headers: h, payload: { email: "viewer@paperboy.test", name: "x", password: "NewPassw0rd!!", roles: ["Author"] } });
    expect(withPw.statusCode).toBe(409);

    // Their list is this site's members, showing only what they hold here.
    const list = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: h })).json() as Array<{ email: string; siteRoles: Array<{ siteId: string }> }>;
    expect(list.map((u) => u.email).sort()).toEqual(["b-admin@paperboy.test", "b-editor@paperboy.test", "viewer@paperboy.test"]);
    expect(list.every((u) => u.siteRoles.every((g) => g.siteId === bId))).toBe(true);

    const escalate = await s.app.inject({ method: "POST", url: "/api/v1/manage/users", headers: h, payload: { email: "c@paperboy.test", name: "C", password: "CCCCCCCCCC!1", roles: [], siteRoles: [{ siteId: "site_default", role: "Admin" }] } });
    expect(escalate.statusCode).toBe(403);
  });

  it("changes only this site's roles, never another site's or the account", async () => {
    const h = as(siteAdmin);
    const viewerId = await userId("viewer@paperboy.test");
    const { name } = ((await raw.sql`SELECT name FROM users WHERE id=${viewerId}`) as Array<{ name: string }>)[0]!;
    // The edit form sends the unchanged name and email back: not an account change.
    const ok = await s.app.inject({ method: "PUT", url: `/api/v1/manage/users/${viewerId}`, headers: h, payload: { name, email: "viewer@paperboy.test", roles: ["Editor"] } });
    expect(ok.statusCode, ok.body).toBe(200);
    const rows = (await raw.sql`SELECT role, site_id FROM user_role WHERE user_id=${viewerId} ORDER BY site_id NULLS FIRST`) as Array<{ role: string; site_id: string | null }>;
    expect(rows).toEqual([{ role: "Viewer", site_id: null }, { role: "Editor", site_id: bId }]); // the every-site Viewer is untouched

    // Email is the login identity of an account that reaches other sites.
    const takeover = await s.app.inject({ method: "PUT", url: `/api/v1/manage/users/${viewerId}`, headers: h, payload: { email: "attacker@paperboy.test" } });
    expect(takeover.statusCode).toBe(403);
    // A user with no role in this site reads as not found.
    const outsider = await s.app.inject({ method: "PUT", url: `/api/v1/manage/users/${await userId("editor@paperboy.test")}`, headers: h, payload: { roles: ["Viewer"] } });
    expect(outsider.statusCode).toBe(404);
  });

  it("an Editor can no longer change Site → General (site.manage is Admin only)", async () => {
    const editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const r = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/preview-url", headers: as(editor), payload: { url: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
    const mine = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/preview-url", headers: as(siteAdmin), payload: { url: "https://b.example" } });
    expect(mine.statusCode, mine.body).toBe(200);
  });

  it("reads their own site's audit log; instance actions and other sites stay hidden", async () => {
    await audit(s.app.db, { siteId: "site_default", action: "deliverykey.create", detail: { marker: "default-site" } });
    await audit(s.app.db, { siteId: bId, action: "site.create", detail: { marker: "instance" } }); // an instance action is filed under no site
    const rows = (await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?limit=500", headers: as(siteAdmin) })).json() as Array<{ action: string; detail: { marker?: string } | null }>;
    expect(rows.length).toBeGreaterThan(0); // their own preview-url change, user changes
    expect(rows.some((r) => r.action === "site.preview_url")).toBe(true);
    expect(rows.some((r) => r.detail?.marker)).toBe(false);
    const all = (await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?limit=500", headers: as(admin) })).json() as Array<{ detail: { marker?: string } | null }>;
    expect(all.filter((r) => r.detail?.marker).length).toBe(2);
  });

  it("OAuth consent offers only their site, never every site", async () => {
    const offer = await sitesForConsent(s.app.db, siteAdminId);
    expect(offer.sites.map((x) => x.id)).toEqual([bId]);
    expect(offer.allSitesAllowed).toBe(false);
  });

  it("deleting the site removes its one-site roles, not anyone's every-site roles", async () => {
    const before = (await raw.sql`SELECT count(*)::int AS n FROM user_role WHERE site_id IS NULL`) as Array<{ n: number }>;
    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/sites/${bId}?confirm=brand-b`, headers: as(admin) });
    expect(del.statusCode, del.body).toBe(200);
    expect(((await raw.sql`SELECT count(*)::int AS n FROM user_role WHERE site_id = ${bId}`) as Array<{ n: number }>)[0]!.n).toBe(0);
    expect(((await raw.sql`SELECT count(*)::int AS n FROM user_role WHERE site_id IS NULL`) as Array<{ n: number }>)[0]!.n).toBe(before[0]!.n);
  });
});
