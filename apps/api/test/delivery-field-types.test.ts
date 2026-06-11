import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Delivery ships each item's PUBLIC field types (name → declared type) so a
 * frontend can render every field by its SCHEMA type instead of sniffing the
 * value's shape (which silently mishandled a richtext field that "looked like"
 * a string — the false "empty intro"). Private fields are never listed (their
 * names/types must not leak), and inline blocks carry their own fieldTypes.
 */
describe("delivery — fieldTypes (render by declared schema type, not value shape)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("top-level item carries fieldTypes for public fields; private fields are excluded", async () => {
    // ArticlePage: heading (text), intro (richtext), mainArea (contentArea),
    // seoNotes (text, PRIVATE), plus the reserved SEO text group.
    const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en`, headers: pub });
    expect(r.statusCode, r.body).toBe(200);
    const ft = r.json().fieldTypes as Record<string, string>;
    expect(ft).toBeTruthy();
    // Home is a LandingPage: heading=text, intro=richtext, mainArea=contentArea.
    expect(ft.heading).toBe("text");
    expect(ft.intro).toBe("richtext");
    expect(ft.mainArea).toBe("contentArea");
    // SEO group fields are public text.
    expect(ft.metaTitle).toBe("text");
  });

  it("a private field's name/type never appears in fieldTypes (no-leak)", async () => {
    // Create an ArticlePage (has the private seoNotes field) and read it.
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "ArticlePage", locale: "en", name: "FT Article" } });
    const id = created.json().documentId as string;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { data: { heading: "H", seoNotes: "secret internal note" } } });

    const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: prev });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.fieldTypes.intro).toBe("richtext"); // public field present
    expect("seoNotes" in body.fieldTypes).toBe(false); // private field type withheld
    expect(JSON.stringify(body.fieldTypes)).not.toContain("seoNotes");
  });

  it("inline blocks in a content area carry their own fieldTypes", async () => {
    // Home's mainArea has an inline HeroBlock (seeded). populate so it resolves.
    const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`, headers: pub });
    expect(r.statusCode, r.body).toBe(200);
    const area = (r.json().data.mainArea ?? []) as Array<{ blockType: string; shared: boolean; fieldTypes?: Record<string, string> }>;
    const inline = area.find((b) => !b.shared);
    expect(inline).toBeTruthy();
    expect(inline!.fieldTypes).toBeTruthy(); // each inline block describes its own field types
  });
});
