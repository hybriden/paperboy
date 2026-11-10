import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A merge save ("change this one field") patches the WORKING data. A page that
 * was published and then unpublished (or trashed and restored, or expired) has
 * neither a draft nor a live version, only older ones. The merge base came out
 * empty, so the new draft held the patch alone: set_field on the heading wiped
 * intro and the SEO notes, and answered 200.
 */
describe("a merge save on a page with no draft and no live version", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** A published article; returns its id and its data as stored. */
  async function publishedArticle(name: string): Promise<{ id: string; stored: Record<string, unknown> }> {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", name } });
    const id = created.json().documentId as string;
    const saved = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Old heading", intro: "Keep this intro", seoNotes: "Keep these notes" } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const pub = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    expect(pub.statusCode, pub.body).toBe(200);
    return { id, stored: saved.json().data };
  }

  async function mergeHeading(id: string) {
    const res = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(ed),
      payload: { merge: true, data: { heading: "New heading" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Record<string, unknown>;
  }

  it("keeps the other fields after an unpublish", async () => {
    const { id, stored } = await publishedArticle("Merge after unpublish");
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/unpublish?locale=en`, headers: authHeaders(ed) });
    expect(await mergeHeading(id)).toEqual({ ...stored, heading: "New heading" });
  });

  it("keeps the other fields after trash and restore", async () => {
    const { id, stored } = await publishedArticle("Merge after restore");
    const trashed = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${id}`, headers: authHeaders(ed) });
    expect(trashed.statusCode, trashed.body).toBe(200);
    const restored = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/restore`, headers: authHeaders(ed) });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await mergeHeading(id)).toEqual({ ...stored, heading: "New heading" });
  });
});
