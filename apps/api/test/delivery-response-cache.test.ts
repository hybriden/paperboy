import { announceDeliveryChange, createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthCtx, PREVIEW_KEY, PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Published delivery responses are kept in memory (apps/api/src/delivery-cache.ts):
 * a page view asks for the same globals again and again. Correct only because
 * every announced change clears it, in this process at once and in another
 * process (the MCP server) through the delivery_epoch sequence. Raw SQL here
 * changes data WITHOUT announcing, which is how the tests tell a cached answer
 * from a fresh one.
 */
describe("delivery response cache", () => {
  let s: Suite;
  let admin: AuthCtx;
  const other = createDb(TEST_DB, { max: 1 }).sql;
  const url = "/api/v1/delivery/globals/SiteSettings?locale=en";
  const get = (key: string, headers: Record<string, string> = {}) => s.app.inject({ url, headers: { authorization: `Bearer ${key}`, ...headers } });
  const siteName = async (key = PUBLIC_KEY) => ((await get(key)).json() as { data: { siteName?: string } }).data.siteName;
  const rename = (name: string) =>
    other`update content_version set data = jsonb_set(data, '{siteName}', ${JSON.stringify(name)}::jsonb)
          where locale = 'en' and document_id = (select document_id from content_item where type = 'SiteSettings' and site_id = 'site_default')`;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await other.end();
    await s.app.close();
  });

  it("answers a repeat read from memory until another process announces a change", async () => {
    await rename("First");
    await other`select nextval('delivery_epoch')`;
    expect(await siteName()).toBe("First");
    await rename("Unannounced");
    expect(await siteName()).toBe("First");
    await other`select nextval('delivery_epoch')`; // what the MCP server's write path does
    expect(await siteName()).toBe("Unannounced");
  });

  it("an announcement in this process clears it at once", async () => {
    expect(await siteName()).toBe("Unannounced");
    await rename("Second");
    announceDeliveryChange(s.app.db, "site_default", "site-settings");
    expect(await siteName()).toBe("Second");
  });

  it("a page's conditional request gets its 304 from the cache, a conditional miss is kept", async () => {
    const page = (headers: Record<string, string> = {}) =>
      s.app.inject({ url: "/api/v1/delivery/content/by-path?path=home&locale=en", headers: { authorization: `Bearer ${PUBLIC_KEY}`, ...headers } });
    const etag = (await s.app.inject({ url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } })).headers.etag as string;
    const miss = await page({ "if-none-match": etag });
    expect(miss.statusCode).toBe(304);
    const full = await page();
    expect(full.statusCode).toBe(200); // kept by the conditional miss above
    expect(full.headers.etag).toBe(etag);
    expect(full.headers.vary).toMatch(/Authorization/);
    expect((await page({ "if-none-match": etag })).statusCode).toBe(304);
    // A global never answered 304 itself, so its cached copy doesn't either.
    const global = await get(PUBLIC_KEY);
    expect((await get(PUBLIC_KEY, { "if-none-match": global.headers.etag as string })).statusCode).toBe(200);
  });

  it("never caches preview", async () => {
    expect(await siteName(PREVIEW_KEY)).toBe("Second");
    await rename("Draftless edit");
    expect(await siteName(PREVIEW_KEY)).toBe("Draftless edit");
  });

  it("never answers one site's key with another site's response at the same URL", async () => {
    expect((await get(PUBLIC_KEY)).statusCode).toBe(200); // cached for the Default site
    const hdr = { ...authHeaders(admin) };
    const site = (await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: hdr, payload: { slug: "cached", name: "Cached", defaultLocale: "en" } })).json() as { id: string };
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/delivery-keys", headers: { ...hdr, "x-paperboy-site": site.id }, payload: { name: "B public", type: "public" } });
    const keyB = minted.json().key as string;
    expect((await get(keyB)).statusCode).toBe(404); // the new site has no SiteSettings
    expect((await get(PUBLIC_KEY)).statusCode).toBe(200);
  });
});
