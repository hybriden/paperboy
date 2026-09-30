import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Audit 2026-09-30 — three ways the page tree lost an invariant:
 *
 *  1. Sibling-slug uniqueness compared only WORKING versions. A published page
 *     whose draft slug had moved on still served its published URL, yet a
 *     sibling could take that URL and publish it — two live pages at one path.
 *  2. Restoring from trash never re-checked the slug, so a page created at the
 *     trashed page's URL and the restored page ended up sharing it.
 *  3. A move cascaded the new section only over LIVE descendants; a trashed
 *     child kept the old section and, once restored, was editable by the old
 *     section's Authors and invisible to the new one's.
 */
describe("page tree integrity", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  const raw = createDb(TEST_DB, { max: 1 });
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await raw.sql.end();
    await s.app.close();
  });

  const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    s.app.inject({ method, url: `/api/v1/manage${url}`, headers: authHeaders(ed), payload: payload as never });
  async function page(name: string, parentId: string | null, slug: string): Promise<string> {
    const res = await api("POST", "/content", { type: "ArticlePage", locale: "en", name, parentId, data: { heading: name } });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().documentId as string;
    const put = await api("PUT", `/content/${id}?locale=en`, { slug, merge: true, data: {} });
    expect(put.statusCode, put.body).toBe(200);
    return id;
  }
  const publish = (id: string) => api("POST", `/content/${id}/publish?locale=en`);

  it("a sibling cannot take a URL segment another page still PUBLISHES under", async () => {
    const parent = await page("Slug Parent", null, "slug-parent-audit");
    const a = await page("About A", parent, "about-audit");
    expect((await publish(a)).statusCode).toBe(200);
    // A's draft moves to a new segment, unpublished: /about-audit is still A's live URL.
    expect((await api("PUT", `/content/${a}?locale=en`, { slug: "about-audit-new", merge: true, data: {} })).statusCode).toBe(200);

    const b = await api("POST", "/content", { type: "ArticlePage", locale: "en", name: "About B", parentId: parent, data: { heading: "B" } });
    const bId = b.json().documentId as string;
    const take = await api("PUT", `/content/${bId}?locale=en`, { slug: "about-audit", merge: true, data: {} });
    expect(take.statusCode).toBe(409);
  });

  it("restoring a trashed page refuses when a live sibling took its URL meanwhile", async () => {
    const parent = await page("Restore Parent", null, "restore-parent-audit");
    const old = await page("Old About", parent, "restore-about");
    expect((await api("DELETE", `/content/${old}`)).statusCode).toBeLessThan(300);
    await page("New About", parent, "restore-about");

    const restore = await api("POST", `/content/${old}/restore`);
    expect(restore.statusCode).toBe(409);
    expect(restore.json().message).toContain("restore-about");
    // Still exactly one live page at that path.
    const byPath = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/content/by-path?path=/restore-parent-audit/restore-about&locale=en&preview=true",
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(byPath.statusCode).not.toBe(500);
  });

  it("a move carries the new section to trashed descendants too", async () => {
    const s1 = await page("Section One", null, "section-one-audit");
    const s2 = await page("Section Two", null, "section-two-audit");
    const p = await page("Moving Parent", s1, "moving-parent-audit");
    const child = await page("Trashed Child", p, "trashed-child-audit");
    expect((await api("DELETE", `/content/${child}`)).statusCode).toBeLessThan(300);

    expect((await api("POST", `/content/${p}/move`, { parentId: s2 })).statusCode).toBeLessThan(300);
    expect((await api("POST", `/content/${child}/restore`)).statusCode).toBeLessThan(300);

    const section = async (id: string) =>
      ((await raw.sql`SELECT section_id FROM content_item WHERE document_id = ${id}`) as Array<{ section_id: string }>)[0]!.section_id;
    expect(await section(p)).toBe(s2);
    expect(await section(child)).toBe(s2);
  });
});
