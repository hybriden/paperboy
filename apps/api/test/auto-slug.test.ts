import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Pages get a URL segment automatically (CMS-12 style): derived from the name
 * at creation, uniquified among siblings, never overwriting an existing slug.
 */
describe("auto-slug from page name", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function createPage(name: string): Promise<{ documentId: string; slug: string | null; urlPath: string | null }> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "LandingPage", locale: "en", name },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("derives a kebab-case segment from the name (incl. æøå + accents)", async () => {
    const page = await createPage("Røde Åser & Café — Test!");
    expect(page.slug).toBe("rode-aser-cafe-test");
    expect(page.urlPath).toBe("/rode-aser-cafe-test");
  });

  it("uniquifies among siblings instead of erroring", async () => {
    const a = await createPage("Twin Page");
    const b = await createPage("Twin Page");
    expect(a.slug).toBe("twin-page");
    expect(b.slug).toBe("twin-page-2");
  });

  it("renaming does NOT change an existing slug (URL stability)", async () => {
    const page = await createPage("Stable URL");
    const renamed = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${page.documentId}?locale=en`,
      headers: authHeaders(ed),
      payload: { name: "Completely Different Name", data: {} },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().slug).toBe("stable-url");
  });

  it("an explicit slug is respected; a slugless legacy draft backfills on save", async () => {
    const page = await createPage("Explicit");
    const explicit = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${page.documentId}?locale=en`,
      headers: authHeaders(ed),
      payload: { slug: "my-own-segment", data: {} },
    });
    expect(explicit.json().slug).toBe("my-own-segment");
    // Clear it explicitly, then save WITHOUT addressing the slug → backfilled.
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${page.documentId}?locale=en`,
      headers: authHeaders(ed),
      payload: { slug: null, data: {} },
    });
    const backfilled = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${page.documentId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "touch" } },
    });
    expect(backfilled.json().slug).toBe("explicit");
  });
});
