import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Regression for the "Untitled" publish incident (2026-06-06, prod doc
 * QvpNjy3ahsjxPu9cASbBy-gF): an MCP agent created a BlogPost in `en` (name +
 * auto-slug landed there), then wrote every field into `nb` via set_field and
 * published `nb`. The first nb write auto-forked the locale version with
 * name "Untitled" / slug "untitled" — and publish shipped it. The live site
 * served the post at /untitled, titled "Untitled".
 *
 * Two contracts pinned here (CLAUDE.md agent-API rules 1 + 5):
 *  1. A locale fork inherits name/slug from the source locale — never the
 *     "Untitled" placeholder.
 *  2. publish refuses a version still carrying a placeholder name, with a
 *     self-teaching error.
 */
describe("locale fork: name/slug inheritance + Untitled publish guard", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("first write in a new locale inherits name + slug from the source locale (the incident flow)", async () => {
    // Step 1 — exactly what create_content did: en gets the name and the slug.
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Japansk interiør: Fra tatamistuer til Japandi" },
    });
    expect(created.statusCode).toBe(200);
    const documentId = created.json().documentId as string;
    expect(created.json().slug).toBe("japansk-interior-fra-tatamistuer-til-japandi");

    // Step 2 — exactly what set_field did: write a FIELD into nb, never
    // addressing name or slug. This is the write that forked the nb version.
    const updated = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=nb`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Norsk overskrift" } },
    });
    expect(updated.statusCode).toBe(200);

    // The nb fork must inherit the en identity — not the "Untitled" placeholder.
    expect(updated.json().name).toBe("Japansk interiør: Fra tatamistuer til Japandi");
    expect(updated.json().slug).toBe("japansk-interior-fra-tatamistuer-til-japandi");

    // Step 3 — and publishing the nb variant must go through cleanly.
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=nb`,
      headers: authHeaders(ed),
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().name).toBe("Japansk interiør: Fra tatamistuer til Japandi");
  });

  it("an explicitly passed name still wins over inheritance on the fork", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Source Name" },
    });
    const documentId = created.json().documentId as string;
    const updated = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=nb`,
      headers: authHeaders(ed),
      payload: { name: "Norsk navn", data: { heading: "Hei" } },
    });
    expect(updated.json().name).toBe("Norsk navn");
    expect(updated.json().slug).toBe("norsk-navn");
  });

  it("publish refuses a version still named 'Untitled' with a self-teaching error", async () => {
    // Defence-in-depth for however the placeholder survives to publish time
    // (legacy forks created before inheritance, or a caller passing it through).
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "ArticlePage", locale: "en", name: "Untitled" },
    });
    const documentId = created.json().documentId as string;
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(ed),
      payload: { data: { heading: "Valid content, placeholder name" } },
    });
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=en`,
      headers: authHeaders(ed),
    });
    expect(published.statusCode).toBe(422);
    const msg = published.json().message as string;
    // Self-teaching: names the problem AND the one-step fix (rule 2).
    expect(msg).toContain("Untitled");
    expect(msg).toMatch(/name/i);
    expect(msg).toContain("update_content");
  });
});
