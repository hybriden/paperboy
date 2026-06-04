import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

interface Hit {
  documentId: string;
  name: string;
  kind: string;
}

describe("Content search (⌘K backend)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function makePage(name: string): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name },
    });
    return created.json().documentId as string;
  }

  it("finds content by title across the whole tree (not just roots)", async () => {
    const id = await makePage("Findable Zebra Page");
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/search?q=zebra", headers: authHeaders(ed) });
    expect(res.statusCode).toBe(200);
    const hits = res.json() as Hit[];
    expect(hits.some((h) => h.documentId === id)).toBe(true);
  });

  it("returns nothing for a non-matching query", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/search?q=zzqqnomatchxyz", headers: authHeaders(ed) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Hit[]).length).toBe(0);
  });

  it("scopes hits to the caller's sections (Author can't see another section's pages)", async () => {
    // Editor creates a top-level page → its own section, outside the Author's scope.
    const id = await makePage("Zorptastic Editorland");
    const author = await login(s.app, "author@paperboy.test", "Author!Passw0rd");
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/search?q=Zorptastic", headers: authHeaders(author) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Hit[]).some((h) => h.documentId === id)).toBe(false);
    // The editor (site-wide) does see it.
    const edRes = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/search?q=Zorptastic", headers: authHeaders(ed) });
    expect((edRes.json() as Hit[]).some((h) => h.documentId === id)).toBe(true);
  });
});
