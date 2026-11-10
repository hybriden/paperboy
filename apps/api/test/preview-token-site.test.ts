import { verifyPreviewToken, verifySitePreviewToken } from "@paperboycms/client/preview-token";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Preview tokens are signed with ONE instance-wide secret and carried only an
 * expiry, so a token minted while working in site A opened site B's drafts on
 * site B's frontend: a Viewer of A alone could read B's unpublished pages.
 *
 * The token itself is unchanged (deployed frontends keep verifying it); the
 * mint route adds a site proof tied to the same expiry, and a frontend that
 * knows its site verifies both.
 */
describe("a preview token is bound to the site it was minted in", () => {
  const SECRET = "preview-site-binding-secret-0123";
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let siteB: string;
  type Minted = { token: string; expiresAt: number; site: string };
  const mint = async (siteId: string): Promise<Minted> => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/preview-token", headers: { ...authHeaders(admin), "x-paperboy-site": siteId } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Minted;
  };

  beforeAll(async () => {
    s = await setupApi({ PREVIEW_SECRET: SECRET });
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const made = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "preview-b", name: "Preview B", defaultLocale: "en" } });
    expect(made.statusCode, made.body).toBe(200);
    siteB = made.json().id as string;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("verifies on its own site's frontend and nowhere else", async () => {
    const a = await mint("site_default");
    expect(await verifySitePreviewToken(SECRET, a.token, a.site, "site_default")).toBe(true);
    expect(await verifySitePreviewToken(SECRET, a.token, a.site, siteB)).toBe(false);
    const b = await mint(siteB);
    expect(await verifySitePreviewToken(SECRET, b.token, b.site, siteB)).toBe(true);
    expect(await verifySitePreviewToken(SECRET, b.token, b.site, "site_default")).toBe(false);
  });

  it("a site proof can't be lifted onto another token, edited, or left out", async () => {
    const a = await mint("site_default");
    await new Promise((r) => setTimeout(r, 5)); // a later expiry
    const b = await mint(siteB);
    expect(b.expiresAt).not.toBe(a.expiresAt);
    expect(await verifySitePreviewToken(SECRET, a.token, b.site, siteB)).toBe(false);
    const forged = `${siteB}.${b.site.split(".").pop()}`;
    expect(await verifySitePreviewToken(SECRET, a.token, forged, siteB)).toBe(false);
    expect(await verifySitePreviewToken(SECRET, a.token, null, "site_default")).toBe(false);
    expect(await verifySitePreviewToken(SECRET, a.token, a.site, "")).toBe(false);
  });

  it("the token alone still verifies where no site is configured (deployed frontends)", async () => {
    const a = await mint("site_default");
    expect(await verifyPreviewToken(SECRET, a.token)).toBe(true);
  });
});
