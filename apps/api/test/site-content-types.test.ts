import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthCtx, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * Content types bound to one site (#159): `content_type.site_id` NULL = shared
 * by every site (every type written before migration 0034), otherwise that
 * site only. A site sees the shared types plus its own; another site's type is
 * not listed there and a write naming it is refused like an unknown type.
 */
describe("site-bound content types", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let admin: AuthCtx;
  let bId: string;

  const as = (site?: string) => (site ? { ...authHeaders(admin), "x-paperboy-site": site } : authHeaders(admin));
  const text = (name: string) => ({ name, displayName: name, type: "text" });
  const area = (name: string, allowedBlocks: string[] = []) => ({ name, displayName: name, type: "contentArea", allowedBlocks });
  const createType = (def: Record<string, unknown>, site?: string) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: as(site), payload: { displayName: def.name, fields: [], ...def } });
  const typeNames = async (site?: string) =>
    ((await s.app.inject({ url: "/api/v1/manage/content-types", headers: as(site) })).json() as Array<{ name: string }>).map((t) => t.name);
  const createPage = (type: string, site?: string) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: as(site), payload: { type, parentId: null, locale: "en", name: `${type} ${Math.random().toString(36).slice(2, 7)}` } });

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    bId = (await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: as(), payload: { slug: "movies", name: "Movies", defaultLocale: "en" } })).json().id as string;
    // One site's page type and block, plus a shared page whose area takes any block.
    expect((await createType({ name: "MovieReview", kind: "page", fields: [text("title")], siteId: bId })).statusCode).toBe(200);
    expect((await createType({ name: "ReviewScore", kind: "block", fields: [text("score")], siteId: bId })).statusCode).toBe(200);
    expect((await createType({ name: "AreaPage", kind: "page", fields: [area("main")] })).statusCode).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("existing types are shared: every site lists them, as before", async () => {
    const shared = (await raw.sql`SELECT count(*)::int AS n FROM content_type WHERE site_id IS NULL AND name NOT IN ('AreaPage')`) as Array<{ n: number }>;
    expect(shared[0]!.n).toBeGreaterThan(5);
    const def = await typeNames("site_default");
    const movies = await typeNames(bId);
    expect(def).toContain("AreaPage");
    expect(movies).toEqual(expect.arrayContaining(def));
  });

  it("a site-bound type is listed and readable only in its own site", async () => {
    expect(await typeNames(bId)).toEqual(expect.arrayContaining(["MovieReview", "ReviewScore"]));
    expect(await typeNames("site_default")).not.toContain("MovieReview");
    const own = await s.app.inject({ url: "/api/v1/manage/content-types/MovieReview", headers: as(bId) });
    expect(own.statusCode).toBe(200);
    expect(own.json().siteId).toBe(bId);
    const other = await s.app.inject({ url: "/api/v1/manage/content-types/MovieReview", headers: as("site_default") });
    expect(other.statusCode).toBe(404);
    // The scope lives in its column, not in the stored definition.
    const stored = (await raw.sql`SELECT definition ? 'siteId' AS has FROM content_type WHERE name = 'MovieReview'`) as Array<{ has: boolean }>;
    expect(stored[0]!.has).toBe(false);
  });

  it("content of another site's type is refused; in its own site it is created", async () => {
    const refused = await createPage("MovieReview", "site_default");
    expect(refused.statusCode).toBe(404);
    expect(refused.json().message).toMatch(/Content type 'MovieReview'/);
    expect(refused.json().message).not.toMatch(/ReviewScore/); // the hint lists only what this site has
    expect((await createPage("MovieReview", bId)).statusCode).toBe(200);
  });

  it("another site's block can't be placed, at the top level or nested in a shared page", async () => {
    const block = { key: "k1", blockType: "ReviewScore", display: "automatic", ref: null, inline: { score: "5" } };
    const put = async (site: string) => {
      const page = (await createPage("AreaPage", site)).json() as { documentId: string };
      return s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${page.documentId}?locale=en`, headers: as(site), payload: { data: { main: [block] } } });
    };
    const refused = await put("site_default");
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.body).toMatch(/ReviewScore/);
    expect((await put(bId)).statusCode).toBe(200);
  });

  it("a site-bound type may only allow shared blocks or its own site's", async () => {
    const refused = await createType({ name: "DefaultOnly", kind: "page", fields: [area("main", ["ReviewScore"])], siteId: "site_default" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/can't allow ReviewScore.*movies/);
    // A shared type may name it: the palette offers it only where it exists.
    expect((await createType({ name: "SharedAllowing", kind: "page", fields: [area("main", ["ReviewScore"])] })).statusCode).toBe(200);
    expect((await createType({ name: "MoviesAllowing", kind: "page", fields: [area("main", ["ReviewScore"])], siteId: bId })).statusCode).toBe(200);
  });

  it("binding a shared type is refused while another site holds content of it, and allowed where it is used", async () => {
    expect((await createType({ name: "Teaser", kind: "page", fields: [text("title")] })).statusCode).toBe(200);
    expect((await createPage("Teaser", "site_default")).statusCode).toBe(200);
    const def = (await s.app.inject({ url: "/api/v1/manage/content-types/Teaser", headers: as() })).json() as Record<string, unknown>;
    const bind = (siteId: string | null) => s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/Teaser", headers: as(), payload: { ...def, siteId } });

    const refused = await bind(bId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/site default still holds content/);
    expect((await bind("site_default")).json().siteId).toBe("site_default");
    // Omitted = unchanged; null shares it again.
    const { siteId: _omit, ...unscoped } = def;
    const kept = await s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/Teaser", headers: as(), payload: unscoped });
    expect(kept.json().siteId).toBe("site_default");
    expect((await bind(null)).json().siteId).toBeNull();
  });

  it("binding a block is refused while it is embedded in another site's page", async () => {
    expect((await createType({ name: "Quote", kind: "block", fields: [text("text")] })).statusCode).toBe(200);
    const page = (await createPage("AreaPage", "site_default")).json() as { documentId: string };
    const block = { key: "q1", blockType: "Quote", display: "automatic", ref: null, inline: { text: "Hi" } };
    expect((await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${page.documentId}?locale=en`, headers: as(), payload: { data: { main: [block] } } })).statusCode).toBe(200);
    const def = (await s.app.inject({ url: "/api/v1/manage/content-types/Quote", headers: as() })).json() as Record<string, unknown>;
    const refused = await s.app.inject({ method: "PUT", url: "/api/v1/manage/content-types/Quote", headers: as(), payload: { ...def, siteId: bId } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/site default still holds content/);
  });

  it("names stay unique across sites, and the clash says where", async () => {
    const clash = await createType({ name: "MovieReview", kind: "page", fields: [text("title")], siteId: "site_default" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toMatch(/on site movies/);
  });

  it("an unknown siteId is refused with the real ones", async () => {
    const res = await createType({ name: "Nowhere", kind: "page", fields: [], siteId: "nope" });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/"site_default" \(default\)/);
  });

  it("MCP lists a site's own types only in that site", async () => {
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: as(), payload: { name: "types", allSites: true } });
    const mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: minted.json().token as string, MCP_HTTP_PORT: "" });
    try {
      const names = async (site: string) => {
        const res = await mcp.call("list_content_types", { site });
        expect(res.isError, res.text).toBe(false);
        return (res.json as Array<{ name: string }>).map((t) => t.name);
      };
      expect(await names("movies")).toContain("MovieReview");
      expect(await names("default")).not.toContain("MovieReview");
      const one = await mcp.call("list_content_types", { name: "MovieReview", site: "default" });
      expect(one.isError).toBe(true);
    } finally {
      mcp.kill();
    }
  });

  it("deleting a site deletes its own types", async () => {
    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/sites/${bId}?confirm=movies`, headers: as() });
    expect(del.statusCode, del.body).toBe(200);
    const left = (await raw.sql`SELECT name FROM content_type WHERE site_id = ${bId}`) as unknown[];
    expect(left).toEqual([]);
  });
});
