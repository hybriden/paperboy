import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Regressions from the 2026-06-07 article run (doc hZVOM01fJ9XZ6C_4O4mwsl8u):
 *
 * A) "No URL yet" lie: delivery's urlPathOf resolves ANCESTOR slugs along the
 *    locale fallback chain (nb → en), but management's computePath demanded
 *    the SAME locale all the way up. A nb post under an en-only parent was
 *    live on the site while the editor claimed it had no URL and told the
 *    user to "give this page a URL segment" it already had. The two path
 *    implementations must agree.
 *
 * B) localized:false is a lie at read time: non-localized fields (tags,
 *    publishDate, author…) are defined as SHARED across locales, but a value
 *    written+published in one locale never reached the others — the nb
 *    article was published with no tags/date because those landed in en.
 *    Delivery must serve a non-localized field from the fallback chain when
 *    the resolved variant lacks it (same perspective rules — no draft leaks).
 */
describe("locale parity: management URL vs delivery + non-localized field sharing", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function create(type: string, name: string, parentId?: string) {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type, locale: "en", name, ...(parentId ? { parentId } : {}) },
    });
    expect(r.statusCode).toBe(200);
    return r.json() as { documentId: string; slug: string };
  }
  async function put(documentId: string, locale: string, payload: Record<string, unknown>) {
    const r = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=${locale}`,
      headers: authHeaders(ed),
      payload,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Record<string, unknown>;
  }
  async function publish(documentId: string, locale: string) {
    const r = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=${locale}`,
      headers: authHeaders(ed),
    });
    expect(r.statusCode, r.body).toBe(200);
  }

  it("A: management urlPath falls back along the locale chain for ancestors, like delivery does", async () => {
    // en-only parent (the production Blog page has no nb variant).
    const parent = await create("ListPage", "Docs section");
    await put(parent.documentId, "en", { data: { heading: "Docs", listedType: "ArticlePage" } });
    await publish(parent.documentId, "en");

    // Child gets a nb variant (forked; inherits the slug) and publishes it.
    const child = await create("ArticlePage", "Veiledning", parent.documentId);
    await put(child.documentId, "nb", { data: { heading: "Norsk veiledning" } });
    await publish(child.documentId, "nb");

    // Delivery resolves the nb URL through the en parent segment…
    const delivered = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${child.documentId}?locale=nb`,
      headers: { "x-api-key": PUBLIC_KEY },
    });
    expect(delivered.statusCode).toBe(200);
    expect((delivered.json() as { urlPath: string }).urlPath).toBe("/docs-section/veiledning");

    // …and the EDITOR's read must agree — not claim "No URL yet".
    const managed = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${child.documentId}?locale=nb`,
      headers: authHeaders(ed),
    });
    expect(managed.statusCode).toBe(200);
    expect((managed.json() as { urlPath: string | null }).urlPath).toBe("/docs-section/veiledning");
  });

  it("A2: the AI-translate seed payload (translated name + SOURCE slug + data) yields a working URL", async () => {
    // The admin's translate flow saves exactly {name: <translated>, slug:
    // <source locale's slug>, data} into the new locale. Reported 2026-06-07:
    // "URL (from page hierarchy) is empty after auto translate" — the slug WAS
    // saved; computePath returned null because the parent had no nb variant.
    const parent = await create("ListPage", "Articles");
    await put(parent.documentId, "en", { data: { heading: "Articles", listedType: "BlogPost" } });
    await publish(parent.documentId, "en");
    const post = await create("BlogPost", "Translate me", parent.documentId);
    await put(post.documentId, "en", { data: { title: "Translate me", body: "Hello" } });
    await publish(post.documentId, "en");

    const seeded = await put(post.documentId, "nb", {
      name: "Oversett meg",
      slug: "translate-me", // the source slug, copied verbatim by the editor
      data: { title: "Oversett meg", body: "Hei" },
    });
    expect(seeded.slug).toBe("translate-me");
    expect(seeded.urlPath).toBe("/articles/translate-me"); // not "No URL yet"
  });

  it("B: a published non-localized field is served to every locale via the fallback chain", async () => {
    const post = await create("BlogPost", "Delte felter");
    // author + publishDate are localized:false on BlogPost; title is localized.
    await put(post.documentId, "en", {
      data: { title: "Shared fields", author: "Hans Christian", publishDate: "2026-06-07T09:00:00.000Z" },
    });
    await publish(post.documentId, "en");
    // The nb variant only carries the localized title.
    await put(post.documentId, "nb", { data: { title: "Delte felter" } });
    await publish(post.documentId, "nb");

    const nb = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${post.documentId}?locale=nb`,
      headers: { "x-api-key": PUBLIC_KEY },
    });
    expect(nb.statusCode).toBe(200);
    const data = (nb.json() as { data: Record<string, unknown> }).data;
    expect(data.title).toBe("Delte felter"); // localized → nb's own
    expect(data.author).toBe("Hans Christian"); // non-localized → shared from en
    expect(data.publishDate).toBe("2026-06-07T09:00:00.000Z");
  });

  it("C: a HUMAN publishing Norwegian text in the en branch is never blocked by the language guard", async () => {
    // The agent-publish gate (J9 in mcp-agent-journeys) must not second-guess
    // an editor: a human pressing Publish in the admin has seen the content.
    const post = await create("BlogPost", "Norsk i en-gren med vilje");
    await put(post.documentId, "en", {
      data: {
        title: "Norsk i en-gren med vilje",
        body: "Dette er en norsk tekst som en redaktør helt bevisst publiserer i den engelske grenen. Det er ikke systemets jobb å overprøve et menneske som har sett innholdet og vet hva det gjør med språk og grener på nettstedet sitt.",
      },
    });
    const r = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${post.documentId}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(r.statusCode, r.body).toBe(200);
  });

  it("D: a HUMAN may create a deliberate off-type sub-page under a list page (never blocked)", async () => {
    // The type-mismatch guard is agent-only — an editor who genuinely wants an
    // ArticlePage under the BlogPost list (e.g. an "About this blog" sub-page)
    // is not second-guessed.
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "About this blog", parentId: s.ids.blogId },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().type).toBe("ArticlePage");
  });

  it("B (no-leak): a non-localized value that exists only in an UNPUBLISHED draft never reaches public delivery", async () => {
    const post = await create("BlogPost", "Draft leak check");
    // nb published WITHOUT author; en has author only in a DRAFT (never published).
    await put(post.documentId, "nb", { data: { title: "Norsk" } });
    await publish(post.documentId, "nb");
    await put(post.documentId, "en", { data: { title: "Draft only", author: "Hemmelig Forfatter" } });

    const nb = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${post.documentId}?locale=nb`,
      headers: { "x-api-key": PUBLIC_KEY },
    });
    expect(nb.statusCode).toBe(200);
    const data = (nb.json() as { data: Record<string, unknown> }).data;
    expect(data.author).toBeUndefined(); // the draft value must NOT leak
  });
});
