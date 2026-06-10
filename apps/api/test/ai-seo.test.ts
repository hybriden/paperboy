import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("SEO fields + AI editorial assistant", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let viewer: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /* --------------------------------- SEO ---------------------------------- */
  it("delivers public SEO/OpenGraph fields and still strips the private seoNotes", async () => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", name: "SEO Page" } });
    const id = created.json().documentId;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: {
        name: "SEO Page",
        slug: "seo-page",
        data: {
          heading: "SEO Page",
          metaTitle: "Best Headless CMS",
          metaDescription: "A delivery-first CMS with first-class SEO.",
          ogType: "article",
          twitterCard: "summary_large_image",
          noIndex: false,
          seoNotes: "INTERNAL: do not expose",
        },
      },
    });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });

    const out = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(out.statusCode).toBe(200);
    const d = out.json().data;
    expect(d.metaTitle).toBe("Best Headless CMS");
    expect(d.metaDescription).toBe("A delivery-first CMS with first-class SEO.");
    expect(d.ogType).toBe("article");
    expect(d.twitterCard).toBe("summary_large_image");
    expect(d.seoNotes).toBeUndefined(); // private — never exposed
  });

  /* ---------------------------------- AI ---------------------------------- */
  it("reports AI status (disabled without a key) + the supported tasks", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/ai/status", headers: authHeaders(ed) });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false); // no ANTHROPIC_API_KEY in tests
    expect(res.json().tasks).toContain("meta_description");
  });

  it("assists with a meta description via the offline fallback (truncated, provider=fallback)", async () => {
    const long = "Paperboy is a headless CMS. ".repeat(40); // > 155 chars
    const res = await s.app.inject({ method: "POST", url: "/api/v1/ai/assist", headers: authHeaders(ed), payload: { task: "meta_description", input: long } });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("fallback");
    expect(res.json().result.length).toBeLessThanOrEqual(156);
    expect(res.json().result.length).toBeGreaterThan(0);
  });

  it("requires the content.update verb (Viewer forbidden) and CSRF", async () => {
    // Viewer lacks content.update.
    const forbidden = await s.app.inject({ method: "POST", url: "/api/v1/ai/assist", headers: authHeaders(viewer), payload: { task: "improve", input: "hello" } });
    expect(forbidden.statusCode).toBe(403);
    // Missing CSRF token.
    const noCsrf = await s.app.inject({ method: "POST", url: "/api/v1/ai/assist", headers: { cookie: ed.cookie, origin: "http://localhost:8090" }, payload: { task: "improve", input: "hello" } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("alt_text refuses without a key — a filename heuristic is not alt text", async () => {
    // The old fallback derived "alt text" from the filename. Alt text describes
    // what is IN the image; without vision (a key) the honest answer is a
    // self-teaching 409, not a dressed-up filename (rule #1). The vision path
    // lives at POST /ai/alt-text and sends the actual image.
    const res = await s.app.inject({ method: "POST", url: "/api/v1/ai/assist", headers: authHeaders(ed), payload: { task: "alt_text", input: "red-mountain-sunrise.jpg" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("Settings → AI");
  });
});
