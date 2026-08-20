import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Public-files support: the /delivery/pages inventory and the generated
 * robots.txt / sitemap.xml / llms.txt / security.txt. Everything is per-site
 * (the delivery key selects the site), perspective-aware (drafts never leak
 * into the published inventory) and content-driven (a publish is instantly
 * reflected — no frontend build).
 */
describe("public files (robots/sitemap/llms/security) + /delivery/pages", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("/delivery/pages: published inventory with urlPath per genuine locale variant; drafts stay out", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/pages", headers: pub });
    expect(res.statusCode).toBe(200);
    const { pages } = res.json() as { pages: Array<{ name: string; locale: string; urlPath: string; noIndex: boolean; lastmod: string; description?: string }> };

    // Home exists in BOTH locales with its own slugs (no fallback duplicates).
    expect(pages).toContainEqual(expect.objectContaining({ name: "Home", locale: "en", urlPath: "/home", noIndex: false }));
    expect(pages).toContainEqual(expect.objectContaining({ name: "Hjem", locale: "nb", urlPath: "/hjem" }));
    // A blog post sits under its ListPage, and carries its summary as description.
    const post = pages.find((p) => p.urlPath === "/blog/hello-paperboy");
    expect(post).toBeDefined();
    expect(post!.description).toBeTruthy();
    expect(new Date(post!.lastmod).toString()).not.toBe("Invalid Date");
    // The seeded draft-only page must NOT appear in the published inventory…
    expect(pages.some((p) => p.name.includes("Secret"))).toBe(false);
    // …and blocks are never pages.
    expect(pages.some((p) => p.name === "Featured Card")).toBe(false);

    // Preview perspective sees the draft too (same chokepoint, other key).
    const preview = await s.app.inject({ method: "GET", url: "/api/v1/delivery/pages", headers: prev });
    const previewPages = (preview.json() as { pages: Array<{ name: string }> }).pages;
    expect(previewPages.some((p) => p.name.includes("Secret"))).toBe(true);

    // No key → 401, like every delivery read.
    expect((await s.app.inject({ method: "GET", url: "/api/v1/delivery/pages" })).statusCode).toBe(401);
  });

  it("robots.txt: allow-all default; editor extras + sitemap pointer after config", async () => {
    const before = await s.app.inject({ method: "GET", url: "/api/v1/delivery/robots.txt", headers: pub });
    expect(before.statusCode).toBe(200);
    expect(before.headers["content-type"]).toContain("text/plain");
    expect(before.body).toContain("User-agent: *");
    expect(before.body).toContain("Allow: /");
    expect(before.body).not.toContain("Sitemap:"); // no canonical base yet → no absolute pointer

    const cfg = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/public-files",
      headers: authHeaders(admin),
      payload: { canonicalBaseUrl: "https://www.example.com/", robotsExtra: "User-agent: GPTBot\nAllow: /" },
    });
    expect(cfg.statusCode).toBe(200);

    const after = await s.app.inject({ method: "GET", url: "/api/v1/delivery/robots.txt", headers: pub });
    expect(after.body).toContain("User-agent: GPTBot");
    expect(after.body).toContain("Sitemap: https://www.example.com/sitemap.xml"); // trailing slash normalized
  });

  it("sitemap.xml: self-teaching 409 without a canonical base; then absolute URLs + hreflang; noIndex pages excluded", async () => {
    // Clear the base to pin the self-teaching refusal, then restore it.
    await s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(admin), payload: { canonicalBaseUrl: null } });
    const unconfigured = await s.app.inject({ method: "GET", url: "/api/v1/delivery/sitemap.xml", headers: pub });
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json().message).toContain("Canonical base URL");
    await s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(admin), payload: { canonicalBaseUrl: "https://www.example.com" } });

    // Mark one published page noIndex — it must drop from the sitemap but stay
    // in /pages (flagged), since /pages is the raw inventory.
    const posts = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content?type=BlogPost", headers: pub });
    const target = (posts.json() as { items: Array<{ documentId: string; urlPath: string }> }).items[0]!;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${target.documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { merge: true, data: { noIndex: true } },
    });
    expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${target.documentId}/publish?locale=en`, headers: authHeaders(admin) })).statusCode).toBe(200);

    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/sitemap.xml", headers: pub });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");
    expect(res.body).toContain("<loc>https://www.example.com/en/home</loc>");
    // Home exists in en+nb → hreflang alternates on both entries (incl. self).
    expect(res.body).toContain('hreflang="nb" href="https://www.example.com/nb/hjem"');
    expect(res.body).toContain('hreflang="en" href="https://www.example.com/en/home"');
    // The noIndexed page advertises no path…
    expect(res.body).not.toContain(target.urlPath);
    // …but the inventory still lists it, flagged.
    const inv = await s.app.inject({ method: "GET", url: "/api/v1/delivery/pages", headers: pub });
    const row = (inv.json() as { pages: Array<{ documentId: string; locale: string; noIndex: boolean }> }).pages.find(
      (p) => p.documentId === target.documentId && p.locale === "en",
    );
    expect(row?.noIndex).toBe(true);
  });

  it("llms.txt: generated from site name + summary + published default-locale pages; override wins", async () => {
    await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/public-files",
      headers: authHeaders(admin),
      payload: { llmsSummary: "A demo newsroom running on Paperboy." },
    });
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/llms.txt", headers: pub });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("# Default site");
    expect(res.body).toContain("> A demo newsroom running on Paperboy.");
    expect(res.body).toContain("(https://www.example.com/en/home)");
    // Descriptions come from public teaser/meta/summary fields.
    expect(res.body).toMatch(/- \[.*\]\(https:\/\/www\.example\.com\/en\/blog\/.*\): .+/);
    // Only the default locale is listed (one document, one line).
    expect(res.body).not.toContain("/nb/hjem");

    const override = "# My own llms.txt\n\nHand-written.";
    await s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(admin), payload: { llmsOverride: override } });
    const overridden = await s.app.inject({ method: "GET", url: "/api/v1/delivery/llms.txt", headers: pub });
    expect(overridden.body).toBe(`${override}\n`);
    await s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(admin), payload: { llmsOverride: null } });
  });

  it("security.txt: 404 self-teaching until a contact is set; then valid RFC 9116 with rolling Expires", async () => {
    const before = await s.app.inject({ method: "GET", url: "/api/v1/delivery/security.txt", headers: pub });
    expect(before.statusCode).toBe(404);
    expect(before.json().message).toContain("Contact");

    // A garbage contact is refused with the accepted formats spelled out.
    const bad = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(admin), payload: { securityContact: "call me maybe" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("mailto");

    await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/public-files",
      headers: authHeaders(admin),
      payload: { securityContact: "security@example.com", securityPolicyUrl: "https://www.example.com/security", securityLanguages: "en, no" },
    });
    const res = await s.app.inject({ method: "GET", url: "/api/v1/delivery/security.txt", headers: pub });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Contact: mailto:security@example.com"); // bare email normalized to a URI
    expect(res.body).toContain("Policy: https://www.example.com/security");
    expect(res.body).toContain("Preferred-Languages: en, no");
    expect(res.body).toContain("Canonical: https://www.example.com/.well-known/security.txt");
    const expires = /Expires: (.+)/.exec(res.body)![1]!;
    const ms = new Date(expires).getTime() - Date.now();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(366 * 24 * 60 * 60 * 1000); // RFC 9116: < 1 year
  });

  it("config writes need content.publish and are audited; viewers are denied", async () => {
    const viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
    const denied = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/public-files", headers: authHeaders(viewer), payload: { robotsExtra: "x" } });
    expect(denied.statusCode).toBe(403);

    const audit = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?action=site.public_files&limit=10", headers: { cookie: admin.cookie } });
    expect((audit.json() as Array<{ action: string }>).length).toBeGreaterThan(0);
  });

  it("the config round-trips through /manage/sites for the admin panel", async () => {
    const sites = await s.app.inject({ method: "GET", url: "/api/v1/manage/sites", headers: { cookie: admin.cookie } });
    const def = (sites.json() as { sites: Array<{ id: string; canonicalBaseUrl: string | null; seoFiles: Record<string, string> }> }).sites.find(
      (x) => x.id === "site_default",
    )!;
    expect(def.canonicalBaseUrl).toBe("https://www.example.com");
    expect(def.seoFiles.securityContact).toBe("security@example.com");
    expect(def.seoFiles.llmsSummary).toBe("A demo newsroom running on Paperboy.");
  });
});
