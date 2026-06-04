import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("Version compare / diff (per-version payload endpoint)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("exposes the full data payload of a single version, and 404s an unknown one", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "StandardPage", locale: "en", name: "Compare Me" },
    });
    const id = created.json().documentId as string;

    // v1 → publish, then v2 draft with a different heading.
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { slug: "compare-me", data: { heading: "Alpha" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { slug: "compare-me", data: { heading: "Beta" } } });

    const list = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}/versions?locale=en`, headers: authHeaders(ed) });
    expect(list.statusCode).toBe(200);
    const versions = list.json() as Array<{ id: number; publishAt: string | null; expireAt: string | null }>;
    expect(versions.length).toBeGreaterThanOrEqual(2);
    // The versions list carries the new schedule columns (null here).
    expect(versions[0]).toHaveProperty("publishAt");
    expect(versions[0]).toHaveProperty("expireAt");

    // Fetch each version's full payload and confirm the heading differs.
    const headings = new Set<string>();
    for (const v of versions) {
      const got = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}/versions/${v.id}?locale=en`, headers: authHeaders(ed) });
      expect(got.statusCode).toBe(200);
      expect(got.json().data).toBeDefined();
      headings.add(String((got.json().data as { heading?: string }).heading ?? ""));
    }
    expect(headings.has("Alpha")).toBe(true);
    expect(headings.has("Beta")).toBe(true);

    const missing = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}/versions/999999?locale=en`, headers: authHeaders(ed) });
    expect(missing.statusCode).toBe(404);
  });

  it("denies fetching a version outside the caller's scope", async () => {
    const author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    // homeId is a top-level page outside the Author's (authorZone) section.
    const res = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${s.ids.homeId}/versions/1?locale=en`, headers: authHeaders(author) });
    expect(res.statusCode).toBe(403);
  });
});
