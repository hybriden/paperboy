import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Deleting ONE language variant of a document (the tree's "Delete <locale>
 * version" action). Removes every version of that doc in that locale so the
 * locale becomes untranslated again (versionNumber 0) — distinct from
 * discard-draft (keeps published) and trash (removes the whole document). Used
 * to re-translate a page whose variant was filled wrong: delete it, then the
 * "Translate from <source>" offer reappears.
 */
describe("delete one language variant", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("removes the variant entirely, leaving other locales and making it untranslated again", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Variant doc" },
    });
    const id = created.json().documentId as string;
    // Two published variants: en + nb.
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { slug: "variant-en", data: { heading: "English heading" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=nb`, headers: authHeaders(ed), payload: { slug: "variant-nb", data: { heading: "Norsk overskrift" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=nb`, headers: authHeaders(ed) });

    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${id}/variant?locale=en`, headers: authHeaders(ed) });
    expect(del.statusCode).toBe(200);

    // en is gone entirely → management read returns an untranslated scaffold.
    const en = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed) });
    expect(en.json().versionNumber).toBe(0);
    // nb is untouched.
    const nb = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=nb`, headers: authHeaders(ed) });
    expect(nb.json().versionNumber).toBeGreaterThan(0);
    expect(nb.json().data.heading).toBe("Norsk overskrift");
  });

  it("refuses to delete the document's ONLY remaining language (use trash instead)", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Single locale" },
    });
    const id = created.json().documentId as string;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { data: { heading: "Only EN" } } });

    const del = await s.app.inject({ method: "DELETE", url: `/api/v1/manage/content/${id}/variant?locale=en`, headers: authHeaders(ed) });
    expect(del.statusCode).toBe(400);
    expect((del.json().message as string).toLowerCase()).toContain("trash");
    // Still present — the refusal didn't delete anything.
    const en = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed) });
    expect(en.json().versionNumber).toBeGreaterThan(0);
  });
});
