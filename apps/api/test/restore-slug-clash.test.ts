import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Restore refuses when another page took the URL in the meantime. The check
 * read draft rows and the live row, but trashing a page demotes its live row
 * first, so a page that was published (with no pending draft) when trashed
 * was not checked at all: both pages ended up on one URL segment, and each
 * then refused to publish until someone renamed one.
 */
describe("restoring a trashed page whose URL was taken", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const page = async (name: string, publish: boolean): Promise<string> => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", name, slug: "taken-url", data: { heading: name } } });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().documentId as string;
    if (publish) expect((await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) })).statusCode).toBe(200);
    return id;
  };

  it("refuses for a page that was live when it was trashed", async () => {
    const old = await page("Old taken", true);
    expect((await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${old}`, headers: authHeaders(ed) })).statusCode).toBe(200);
    await page("New taken", true);

    const restored = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${old}/restore`, headers: authHeaders(ed) });
    expect(restored.statusCode, restored.body).toBe(409);
    expect(restored.json().message).toContain('"taken-url"');
  });
});
