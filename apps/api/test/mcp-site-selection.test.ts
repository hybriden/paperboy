import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * The MCP must be able to act in a site OTHER than the Default one.
 *
 * Reported live 2026-09-09 on an instance holding two sites: EVERY MCP tool
 * returned the Default site's content — `tree`/`list_pages` listed only its
 * documents and `delivery_search` for the second site's only page came back
 * `{"items":[],"total":0}`. Not a permission problem (user_scope was empty, so
 * the token was unscoped): `getAccessContext` was called without an active
 * site and `getDefaultSite()` hard-codes DEFAULT_SITE_ID, so the server had no
 * way to address another site at all.
 *
 * Both other surfaces have always had one — the REST API threads
 * `x-paperboy-site` → `getSiteById` → `getAccessContext(…, activeSiteId)`, and
 * a delivery key carries its own `site_id`. The MCP was the surface with no
 * door. Two ways through it, both tested here: `PAPERBOY_SITE` sets the
 * server's DEFAULT site, and every tool takes an optional `site` (slug or id)
 * that overrides it per call — so ONE server reaches every site in the
 * instance, which is what the deployed setup actually needs.
 */
describe("MCP site selection", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let token: string;
  let siteId: string;
  const spawned: McpClient[] = [];

  const spawn = (env: Record<string, string> = {}): McpClient => {
    const c = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: token, MCP_HTTP_PORT: "", ...env });
    spawned.push(c);
    return c;
  };
  const pageNames = async (mcp: McpClient): Promise<string[]> => {
    const res = await mcp.call("list_pages");
    expect(res.isError, res.text).toBe(false);
    return (res.json as Array<{ name: string }>).map((p) => p.name);
  };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");

    const minted = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      // allSites: these cases exercise PAPERBOY_SITE and the per-call `site`, both
      // of which a site-scoped token is (deliberately) not allowed to use.
      payload: { name: "site-selection", allSites: true },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    token = minted.json().token as string;

    const site = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(admin),
      payload: { slug: "second", name: "Second site", defaultLocale: "en" },
    });
    expect(site.statusCode, site.body).toBe(200);
    siteId = site.json().id as string;

    // One page that exists ONLY in the second site — the thing the live report
    // could see in the database and not through any MCP tool.
    const page = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: { ...authHeaders(admin), "x-paperboy-site": siteId },
      payload: { type: "ArticlePage", locale: "en", name: "Second Site Only" },
    });
    expect(page.statusCode, page.body).toBe(200);
  }, 120_000);

  afterAll(async () => {
    for (const c of spawned) c.kill();
    await s.app.close();
  });

  it("PAPERBOY_SITE=<slug> makes the server work in THAT site, not the Default", async () => {
    const pinned = spawn({ PAPERBOY_SITE: "second" });
    await pinned.initialize();
    const dflt = spawn();
    await dflt.initialize();

    const inSecond = await pageNames(pinned);
    const inDefault = await pageNames(dflt);

    expect(inSecond).toContain("Second Site Only");
    // Partitioned BOTH ways, and seed-agnostic: the two sites share no page.
    expect(inDefault).not.toContain("Second Site Only");
    expect(inSecond.filter((n) => inDefault.includes(n))).toEqual([]);
  }, 120_000);

  it("delivery_* follows the pinned site too (the reported empty search)", async () => {
    // delivery has its OWN chokepoint (DeliveryCtx.siteId), so list_pages passing
    // does not prove this path. `{"items":[],"total":0}` for a page that exists
    // is the exact symptom that was reported.
    const pinned = spawn({ PAPERBOY_SITE: "second" });
    await pinned.initialize();
    const dflt = spawn();
    await dflt.initialize();

    const hit = await pinned.call("delivery_search", { query: "Second Site Only", preview: true });
    expect(hit.isError, hit.text).toBe(false);
    expect((hit.json as { total: number }).total).toBeGreaterThan(0);

    const miss = await dflt.call("delivery_search", { query: "Second Site Only", preview: true });
    expect((miss.json as { total: number }).total).toBe(0);
  }, 120_000);

  it("ONE server reaches BOTH sites via the per-call `site` argument", async () => {
    // No PAPERBOY_SITE: a plain server, exactly the one already deployed.
    const mcp = spawn();
    await mcp.initialize();

    const here = await mcp.call("list_pages");
    const there = await mcp.call("list_pages", { site: "second" });
    expect(there.isError, there.text).toBe(false);

    const names = (r: typeof here) => (r.json as Array<{ name: string }>).map((x) => x.name);
    expect(names(there)).toContain("Second Site Only");
    expect(names(here)).not.toContain("Second Site Only");

    // Writes follow it too — not just reads.
    const made = await mcp.call("create_content", { type: "ArticlePage", name: "Written Into Second", site: "second" });
    expect(made.isError, made.text).toBe(false);
    expect(names(await mcp.call("list_pages", { site: "second" }))).toContain("Written Into Second");
    expect(names(await mcp.call("list_pages"))).not.toContain("Written Into Second");
  }, 120_000);

  it("overlapping calls naming DIFFERENT sites do not bleed into each other", async () => {
    // The reason the per-call context is AsyncLocalStorage-backed: a plain
    // mutable module-level ctx would let these two interleave and one of them
    // would answer for the wrong site.
    const mcp = spawn();
    await mcp.initialize();
    const [second, dflt] = await Promise.all([
      mcp.call("list_pages", { site: "second" }),
      mcp.call("list_pages"),
    ]);
    const names = (r: typeof second) => (r.json as Array<{ name: string }>).map((x) => x.name);
    expect(names(second)).toContain("Second Site Only");
    expect(names(dflt)).not.toContain("Second Site Only");
  }, 120_000);

  it("an unknown `site` argument errors self-teachingly instead of returning nothing", async () => {
    const mcp = spawn();
    await mcp.initialize();
    const res = await mcp.call("list_pages", { site: "nope" });
    // Rule #1: never garbage-in-success-out. An empty list would read as
    // "this site has no pages" — the failure being fixed in the first place.
    expect(res.isError).toBe(true);
    expect(res.text).toContain("nope");
    expect(res.text).toContain("second");
    expect(res.text).toContain("list_sites");
  }, 120_000);

  it("a SITE-SCOPED token cannot reach another site, however it asks", async () => {
    // The credential caps the per-call `site` argument. Without this the arg
    // would make scoping cosmetic: a frode-only token could type "neoteric".
    const scoped = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: { ...authHeaders(admin), "x-paperboy-site": siteId },
      payload: { name: "second-only" },
    });
    expect(scoped.statusCode, scoped.body).toBe(200);
    const mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: scoped.json().token as string, MCP_HTTP_PORT: "" });
    spawned.push(mcp);
    await mcp.initialize();

    // Its default site is the one it was minted in — no PAPERBOY_SITE needed.
    expect(await pageNames(mcp)).toContain("Second Site Only");

    // And the Default site is refused, not silently served or silently empty.
    const denied = await mcp.call("list_pages", { site: "default" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("scoped");

    // list_sites advertises only what it can reach.
    const seen = await mcp.call("list_sites");
    const out = seen.json as { tokenScopedTo: string | null; sites: Array<{ slug: string }> };
    expect(out.tokenScopedTo).toBe(siteId);
    expect(out.sites.map((x) => x.slug)).toEqual(["second"]);
  }, 120_000);

  it("an UNSCOPED token still reaches every site (existing tokens keep working)", async () => {
    const every = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: authHeaders(admin),
      payload: { name: "every-site", allSites: true },
    });
    expect(every.statusCode, every.body).toBe(200);
    const mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: every.json().token as string, MCP_HTTP_PORT: "" });
    spawned.push(mcp);
    await mcp.initialize();
    expect(await pageNames(mcp)).not.toContain("Second Site Only");
    const there = await mcp.call("list_pages", { site: "second" });
    expect((there.json as Array<{ name: string }>).map((x) => x.name)).toContain("Second Site Only");
  }, 120_000);

  it("a scoped token refuses to boot when PAPERBOY_SITE names a different site", async () => {
    const scoped = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: { ...authHeaders(admin), "x-paperboy-site": siteId },
      payload: { name: "conflicting" },
    });
    const mcp = new McpClient({
      DATABASE_URL: TEST_DB,
      MCP_TOKEN: scoped.json().token as string,
      MCP_HTTP_PORT: "",
      PAPERBOY_SITE: "default",
    });
    spawned.push(mcp);
    expect(await mcp.exited()).toBe(1);
    expect(mcp.stderr).toContain("conflicts");
  }, 120_000);

  it("PAPERBOY_SITE also accepts a site id", async () => {
    const pinned = spawn({ PAPERBOY_SITE: siteId });
    await pinned.initialize();
    expect(await pageNames(pinned)).toContain("Second Site Only");
  }, 120_000);

  it("an unknown PAPERBOY_SITE refuses to boot, naming the sites that exist", async () => {
    const bad = spawn({ PAPERBOY_SITE: "no-such-site" });
    expect(await bad.exited()).toBe(1);
    // Self-teaching (agent-API rule #2): the operator must be able to fix this
    // from the error alone, without going to the database for slugs.
    expect(bad.stderr).toContain("no-such-site");
    expect(bad.stderr).toContain("second");
    expect(bad.stderr).toContain("default"); // the Default site's slug
  }, 120_000);

  it("list_sites reports every site and which one this server is pinned to", async () => {
    const pinned = spawn({ PAPERBOY_SITE: "second" });
    await pinned.initialize();
    const res = await pinned.call("list_sites");
    expect(res.isError, res.text).toBe(false);
    const out = res.json as { activeSiteId: string; sites: Array<{ id: string; slug: string; name: string }> };
    expect(out.activeSiteId).toBe(siteId);
    expect(out.sites.map((x) => x.slug)).toContain("second");
    expect(out.sites.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
